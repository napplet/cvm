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

const stages: Stage[] = [];
let selectedImageDigest = "0".repeat(64);
try {
  selectedImageDigest = imageDigest();
  const fixture = JSON.parse(await readFile(fixturePath(), "utf8")) as { name: string; requires: unknown[] };
  if (fixture.name !== "minimal" || !Array.isArray(fixture.requires) || fixture.requires.length !== 0) throw new Error("minimal fixture must require no capabilities");
  const project = "/work/minimal";
  const fixtureRoot = "/input/fixtures/minimal";
  const stage = async (id: StageId, command: string, args: string[], cwd: string) => {
    const evidence = await run(id, command, args, cwd);
    stages.push(evidence);
    if (evidence.exitCode !== 0) throw new Error(`${id} exited ${evidence.exitCode}`);
  };
  await stage("create", "/toolchain/bin/napplet", ["create", project, "--template", "/toolchain/boilerplate-template"], "/work");
  await stage("init", "/toolchain/bin/napplet", ["init", "--force", "--root", "--source-dir", "src", "--title", "Focused napplet"], project);
  await stage("skills", "/toolchain/bin/napplet", ["skills", "install", "--to", "codex"], project);
  await cp(join(fixtureRoot, "src", "App.tsx"), join(project, "src", "App.tsx"), { force: true });
  await writeFile(join(project, ".cvm-fixture-overlay.json"), JSON.stringify({ fixture: "minimal", applicationSurface: ["src/App.tsx"] }) + "\n");
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
  console.log(JSON.stringify({ fixture: "minimal", status: "passed", candidateId: CANDIDATE_ID, imageDigest: selectedImageDigest, stages, installedSkillsSha256: await sha256(JSON.stringify(skillFiles)), distSha256: await sha256(JSON.stringify(distFiles)), aggregateHash: manifest.aggregateHash }));
} catch (error) {
  console.log(JSON.stringify({ fixture: "minimal", status: "blocked", candidateId: CANDIDATE_ID, imageDigest: selectedImageDigest, stages, installedSkillsSha256: "0".repeat(64), distSha256: "0".repeat(64), aggregateHash: "0".repeat(64), reason: error instanceof Error ? error.message : "fixture runner failed" }));
}
