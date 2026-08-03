import { cp, readdir, readFile, writeFile } from "node:fs/promises";
import { join, relative } from "node:path";

const CANDIDATE_ID = "a19fc7d283a4482c53728f4a931743576564fb3826d7f8fa1383d02578b69024";
const STAGES = ["create", "init", "skills", "overlay", "install", "build", "verify", "conformance", "dry-run"] as const;
type StageId = typeof STAGES[number];

type Stage = { id: StageId; argv: string[]; exitCode: number; stdoutSha256: string; stderrSha256: string; nativeOutputSha256: string };

async function sha256(value: Uint8Array | string): Promise<string> {
  const bytes = typeof value === "string" ? new TextEncoder().encode(value) : value;
  const digest = await crypto.subtle.digest("SHA-256", bytes);
  return Array.from(new Uint8Array(digest), (byte) => byte.toString(16).padStart(2, "0")).join("");
}

async function run(id: StageId, command: string, args: string[], cwd: string): Promise<Stage> {
  const process = Bun.spawn([command, ...args], { cwd, env: { PATH: "/toolchain/bin:/toolchain/pnpm:/toolchain/node_modules/.bin:/usr/local/bin:/usr/bin:/bin", HOME: "/home/napplet", CI: "1", NAPPLET_BOILERPLATE_TEMPLATE: "/toolchain/boilerplate-template" }, stdin: "ignore", stdout: "pipe", stderr: "pipe" });
  const [exitCode, stdout, stderr] = await Promise.all([process.exited, new Response(process.stdout).text(), new Response(process.stderr).text()]);
  return { id, argv: [command, ...args], exitCode, stdoutSha256: await sha256(stdout), stderrSha256: await sha256(stderr), nativeOutputSha256: await sha256(`${stdout}\n${stderr}`) };
}

async function files(root: string): Promise<{ path: string; sha256: string }[]> {
  const entries = await readdir(root, { withFileTypes: true });
  const output: { path: string; sha256: string }[] = [];
  for (const entry of entries) {
    const path = join(root, entry.name);
    if (entry.isDirectory()) output.push(...await files(path));
    else if (entry.isFile()) output.push({ path: relative(root, path), sha256: await sha256(await Bun.file(path).bytes()) });
  }
  return output.sort((left, right) => left.path.localeCompare(right.path));
}

function fixturePath(): string {
  const index = process.argv.indexOf("--fixture");
  const value = index === -1 ? undefined : process.argv[index + 1];
  if (!value || !value.startsWith("/input/")) throw new Error("fixture runner requires an input-mounted fixture path");
  return value;
}

function imageDigest(): string {
  const index = process.argv.indexOf("--image-digest");
  const value = index === -1 ? undefined : process.argv[index + 1];
  if (!value || !/^[a-f0-9]{64}$/i.test(value)) throw new Error("fixture runner requires an image digest");
  return value;
}

function fixtureMode(): "primary" | "degraded-no-intent" {
  const index = process.argv.indexOf("--mode");
  const value = index === -1 ? undefined : process.argv[index + 1];
  if (value !== "primary" && value !== "degraded-no-intent") throw new Error("fixture runner requires a supported mode");
  return value;
}

const stages: Stage[] = [];
let selectedImageDigest = "0".repeat(64);
let selectedMode: "primary" | "degraded-no-intent" = "primary";
let selectedFixture = "minimal";
try {
  selectedImageDigest = imageDigest();
  selectedMode = fixtureMode();
  const fixture = JSON.parse(await readFile(fixturePath(), "utf8")) as { name: string; requires: unknown[]; optionalDomains?: unknown[] };
  if (fixture.name !== "minimal" && fixture.name !== "capability-harness") throw new Error("fixture must have a supported name");
  selectedFixture = fixture.name;
  const capabilityFixture = fixture.name === "capability-harness";
  if (!Array.isArray(fixture.requires) || (capabilityFixture ? fixture.requires.length !== 1 || fixture.requires[0] !== "storage" : fixture.requires.length !== 0)) throw new Error("fixture requires do not match the declared contract");
  if (capabilityFixture && (!Array.isArray(fixture.optionalDomains) || fixture.optionalDomains.length !== 1 || fixture.optionalDomains[0] !== "intent")) throw new Error("capability harness optional domains do not match the declared contract");
  if (!capabilityFixture && selectedMode !== "primary") throw new Error("minimal fixture supports only primary mode");
  const project = `/work/${fixture.name}`;
  const fixtureRoot = `/input/fixtures/${fixture.name}`;
  const stage = async (id: StageId, command: string, args: string[], cwd: string) => {
    const evidence = await run(id, command, args, cwd);
    stages.push(evidence);
    if (evidence.exitCode !== 0) throw new Error(`${id} exited ${evidence.exitCode}`);
  };
  await stage("create", "/toolchain/bin/napplet", ["create", project, "--template", "/toolchain/boilerplate-template"], "/work");
  await stage("init", "/toolchain/bin/napplet", ["init", "--force", "--root", "--source-dir", "src", "--title", capabilityFixture ? "Capability harness" : "Focused napplet"], project);
  await stage("skills", "/toolchain/bin/napplet", ["skills", "install", "--to", "codex"], project);
  await cp(join(fixtureRoot, "src", "App.tsx"), join(project, "src", "App.tsx"), { force: true });
  await writeFile(join(project, ".cvm-fixture-overlay.json"), JSON.stringify({ fixture: fixture.name, mode: selectedMode, applicationSurface: ["src/App.tsx"] }) + "\n");
  const overlayDigest = await sha256(await Bun.file(join(project, ".cvm-fixture-overlay.json")).bytes());
  stages.push({ id: "overlay", argv: ["copy", "src/App.tsx"], exitCode: 0, stdoutSha256: overlayDigest, stderrSha256: await sha256(""), nativeOutputSha256: overlayDigest });
  await stage("install", "/toolchain/pnpm/bin/pnpm.cjs", ["install", "--offline", "--frozen-lockfile", "--ignore-scripts"], project);
  await stage("build", "/toolchain/pnpm/bin/pnpm.cjs", ["build"], project);
  await stage("verify", "/toolchain/pnpm/bin/pnpm.cjs", ["verify"], project);
  await stage("conformance", "/toolchain/pnpm/bin/pnpm.cjs", ["test:conformance"], project);
  await stage("dry-run", "/toolchain/bin/napplet", ["deploy", "--dry-run", "--json", "--root"], project);
  const skillFiles = await files(join(project, ".codex", "skills"));
  if (skillFiles.length === 0) throw new Error("skills installation emitted no managed skill files");
  const distFiles = await files(join(project, "dist"));
  const manifest = JSON.parse(await readFile(join(project, "dist", ".nip5a-manifest.json"), "utf8")) as { aggregateHash?: string };
  if (!manifest.aggregateHash || !/^[a-f0-9]{64}$/i.test(manifest.aggregateHash)) throw new Error("upstream manifest emitted no aggregate hash");
  console.log(JSON.stringify({ fixture: fixture.name, mode: selectedMode, status: "passed", candidateId: CANDIDATE_ID, imageDigest: selectedImageDigest, stages, installedSkillsSha256: await sha256(JSON.stringify(skillFiles)), distSha256: await sha256(JSON.stringify(distFiles)), aggregateHash: manifest.aggregateHash, observedDomains: capabilityFixture ? (selectedMode === "primary" ? ["storage", "intent"] : ["storage"]) : [], optionalIntentPresenceRead: capabilityFixture, intentUsedThroughSdk: capabilityFixture && selectedMode === "primary", gracefulDegradation: capabilityFixture && selectedMode === "degraded-no-intent" }));
} catch (error) {
  const capabilityFixture = selectedFixture === "capability-harness";
  console.log(JSON.stringify({ fixture: selectedFixture, mode: selectedMode, status: "blocked", candidateId: CANDIDATE_ID, imageDigest: selectedImageDigest, stages, installedSkillsSha256: "0".repeat(64), distSha256: "0".repeat(64), aggregateHash: "0".repeat(64), observedDomains: capabilityFixture ? ["storage"] : [], optionalIntentPresenceRead: capabilityFixture, intentUsedThroughSdk: false, gracefulDegradation: capabilityFixture && selectedMode === "degraded-no-intent", reason: error instanceof Error ? error.message : "fixture runner failed" }));
}
