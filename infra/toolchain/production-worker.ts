#!/usr/bin/env bun
import { lookup } from "node:dns/promises";
import { access, constants, lstat, mkdir, readFile, realpath, rm, statfs, writeFile } from "node:fs/promises";
import { dirname, join, resolve, relative } from "node:path";

const WORKSPACE = "/workspace";
const POLICY = "production-worker-policy-2026-10-27";
const DIGEST = /^[a-f0-9]{64}$/iu;
const MAX_BYTES = 128 * 1024;
const MAX_OUTPUT = 64 * 1024;
const MAX_MS = 60_000;
let activeDeadlineEpochMs = 0;

function arg(name: string): string | undefined { const i = process.argv.indexOf(name); return i < 0 ? undefined : process.argv[i + 1]; }
function digest(value: string | undefined, code: string) { if (!value || !DIGEST.test(value)) throw new Error(code); return value.toLowerCase(); }
async function bounded(argv: string[], cwd?: string) {
  const child = Bun.spawn(argv, { cwd, stdout: "pipe", stderr: "pipe", env: { HOME: "/home/napplet", CI: "1", PLAYWRIGHT_BROWSERS_PATH: "/toolchain/ms-playwright", PATH: "/toolchain/bin:/toolchain/pnpm:/toolchain/node_modules/.bin:/usr/local/bin:/usr/bin:/bin" } });
  let timer: ReturnType<typeof setTimeout> | undefined;
  const read = async (stream: ReadableStream<Uint8Array>) => {
    const reader = stream.getReader(); const chunks: Uint8Array[] = []; let length = 0;
    try {
      for (;;) { const next = await reader.read(); if (next.done) break; length += next.value.byteLength; if (length > MAX_OUTPUT) { child.kill(); throw new Error("WORKER_CHILD_OUTPUT_LIMIT"); } chunks.push(next.value); }
    } finally { reader.releaseLock(); }
    return new TextDecoder().decode(Buffer.concat(chunks));
  };
  try {
    const remaining = activeDeadlineEpochMs ? activeDeadlineEpochMs - Date.now() : MAX_MS;
    if (remaining <= 0) throw new Error("WORKER_ACTIVE_DEADLINE_EXPIRED");
    const timeout = new Promise<never>((_, reject) => { timer = setTimeout(() => { child.kill(); reject(new Error("WORKER_CHILD_TIMEOUT")); }, Math.min(MAX_MS, remaining)); });
    const [status, stdout, stderr] = await Promise.race([Promise.all([child.exited, read(child.stdout), read(child.stderr)]), timeout]);
    if (status !== 0) throw new Error(`WORKER_CHILD_FAILED:${`${stdout}\n${stderr}`.slice(0, 2_000).replace(/[\r\n]+/gu, " ")}`);
  } finally { clearTimeout(timer); child.kill(); }
}
async function regularContained(path: string) {
  const root = await realpath(`${WORKSPACE}/.napplet-cvm`); const resolved = resolve(path);
  if (relative(root, resolved).startsWith("..") || resolve(root, relative(root, resolved)) !== resolved) throw new Error("WORKER_PATH_INVALID");
  let cursor = root;
  for (const component of relative(root, resolved).split("/")) { cursor = join(cursor, component); const details = await lstat(cursor); if (details.isSymbolicLink()) throw new Error("WORKER_PATH_UNTRUSTED"); }
  const details = await lstat(resolved); if (!details.isFile() || details.nlink !== 1 || details.size > MAX_BYTES) throw new Error("WORKER_PATH_UNTRUSTED");
  return resolved;
}
async function workspaceBounded() {
  const fs = await statfs(WORKSPACE); // tmpfs is required: a writable overlay alone is never a quota.
  const tmpfsMagic = 0x01021994; if (Number(fs.type) !== tmpfsMagic || Number(fs.bsize) * Number(fs.blocks) > 512 * 1024 * 1024) return false;
  const probe = join(WORKSPACE, `.write-${crypto.randomUUID()}`);
  try { await writeFile(probe, "x", { flag: "wx" }); await rm(probe, { force: true }); return true; } catch { return false; }
}
async function deniedProbe(probe: string) {
  const child = Bun.spawn(["/toolchain/bin/bun", "/toolchain/bin/denial-probe", `--probe=${probe}`], { stdout: "pipe", stderr: "pipe", env: { PATH: "/toolchain/bin:/usr/bin:/bin" } });
  const timer = setTimeout(() => child.kill(), 5_000);
  try { const [exit, stderr] = await Promise.all([child.exited, new Response(child.stderr).text()]); return exit === 1 && stderr.includes(`CVM_DENIAL_PROBE:${probe}:denied`); }
  finally { clearTimeout(timer); child.kill(); }
}
async function dnsDenied() {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    // A DNS timeout is not evidence of denial; it is an unknown and must fail
    // readiness.  The race merely prevents a resolver outage from outliving
    // the worker's active deadline.
    return await Promise.race([lookup("example.com").then(() => false).catch(() => true), new Promise<boolean>((resolve) => { timer = setTimeout(() => resolve(false), 5_000); })]);
  } finally { clearTimeout(timer); }
}
async function networkDenied() {
  const checks = await Promise.all([
    dnsDenied(),
    deniedProbe("http"), deniedProbe("https"), deniedProbe("ipv4"), deniedProbe("ipv6"), deniedProbe("private"), deniedProbe("metadata"),
  ]);
  return checks.every(Boolean);
}
async function kernelIsolation() {
  const status = await readFile("/proc/self/status", "utf8");
  return ["CapInh", "CapPrm", "CapEff", "CapBnd", "CapAmb"].every((field) => new RegExp(`^${field}:\\s*0+$`, "m").test(status)) && /^NoNewPrivs:\s*1$/m.test(status);
}
async function ready() {
  const sessionLeaseSha256 = digest(arg("--session-lease-sha256"), "WORKER_LEASE_REQUIRED");
  const image = arg("--provider-image"); if (!image || !/^.+@sha256:[a-f0-9]{64}$/iu.test(image)) throw new Error("WORKER_PROVIDER_IMAGE_REQUIRED");
  const toolchainDigest = digest(arg("--toolchain-sha256"), "WORKER_TOOLCHAIN_REQUIRED");
  const deadlineEpochMs = Number(arg("--provider-deadline-epoch-ms"));
  const remainingLifetimeMs = deadlineEpochMs - Date.now();
  if (!Number.isSafeInteger(deadlineEpochMs) || remainingLifetimeMs <= 0 || remainingLifetimeMs > 1_200_000 || process.env.NAPPLET_CVM_POLICY_VERSION !== POLICY) throw new Error("WORKER_PROVIDER_FACTS_INVALID");
  const environmentClean = Object.keys(process.env).every((key) => ["HOME", "CI", "PATH", "PLAYWRIGHT_BROWSERS_PATH", "NAPPLET_CVM_POLICY_VERSION"].includes(key));
  const [boundedWorkspace, network, kernel, toolchain] = await Promise.all([workspaceBounded(), networkDenied(), kernelIsolation(), access("/toolchain", constants.W_OK).then(() => false).catch(() => true)]);
  const ports = await readFile("/proc/net/tcp", "utf8").then((text) => !text.split("\n").slice(1).some((line) => line.trim().split(/\s+/u)[3] === "0A")).catch(() => false);
  if (!boundedWorkspace || !network || !kernel || !toolchain || !ports || !environmentClean || process.getuid?.() !== 65532) throw new Error("WORKER_ISOLATION_REFUSED");
  console.log(JSON.stringify({ version: 1, policyVersion: POLICY, image, sessionLeaseSha256, toolchainSha256: toolchainDigest, remainingLifetimeMs, checks: { toolchain_readonly: true, workspace_bounded: true, non_root: true, no_ambient_credentials: true, network_denied: true, no_inbound_ports: true, minimal_capabilities: true } }));
}
async function build() {
  activeDeadlineEpochMs = Number(arg("--active-deadline-epoch-ms"));
  if (!Number.isSafeInteger(activeDeadlineEpochMs) || activeDeadlineEpochMs <= Date.now() || activeDeadlineEpochMs > Date.now() + 600_000) throw new Error("WORKER_ACTIVE_DEADLINE_INVALID");
  const sourcePath = await regularContained(arg("--source") ?? ""); const sourceBytes = await Bun.file(sourcePath).bytes();
  if (sourceBytes.byteLength > MAX_BYTES) throw new Error("WORKER_SOURCE_TOO_LARGE"); const sourceText = new TextDecoder().decode(sourceBytes);
  const source = JSON.parse(sourceText) as { files?: Array<{ path?: unknown; content?: unknown }> };
  if (!Array.isArray(source.files) || source.files.length < 1 || source.files.length > 3) throw new Error("WORKER_SOURCE_INVALID");
  // The official scaffold owns the entrypoint. Generated input changes only
  // the same application surfaces used by the verified fixture runner.
  const allowed = new Set(["src/App.tsx", "src/styles.css", "src/capabilities.json"]);
  const files = source.files.map((file) => {
    if (!file || typeof file.path !== "string" || !allowed.has(file.path) || typeof file.content !== "string" || new TextEncoder().encode(file.content).byteLength > 30_000) throw new Error("WORKER_SOURCE_INVALID");
    return { path: file.path, content: file.content };
  });
  if (new Set(files.map((file) => file.path)).size !== files.length) throw new Error("WORKER_SOURCE_DUPLICATE");
  const project = `${WORKSPACE}/project`;
  // Validate every untrusted source fact before invoking the CLI or changing
  // the project filesystem.  The commands below match the proven fixture flow.
  await bounded(["/toolchain/bin/napplet", "create", project, "--template", "/toolchain/boilerplate-template"], WORKSPACE);
  await bounded(["/toolchain/bin/napplet", "init", "--force", "--root", "--source-dir", "src", "--title", "Generated napplet"], project);
  await bounded(["/toolchain/bin/bun", "/toolchain/node_modules/@napplet/skills/dist/cli.js", "install", "--to", "codex", "--dir", ".codex/skills"], project);
  for (const file of files) {
    const target = resolve(project, file.path); if (!target.startsWith(`${project}/src/`)) throw new Error("WORKER_SOURCE_INVALID");
    await mkdir(dirname(target), { recursive: true }); await writeFile(target, file.content, { mode: 0o600 });
  }
  for (const command of [["/toolchain/pnpm/bin/pnpm.cjs", "install", "--offline", "--frozen-lockfile", "--ignore-scripts"], ["/toolchain/pnpm/bin/pnpm.cjs", "build"], ["/toolchain/pnpm/bin/pnpm.cjs", "verify"], ["/toolchain/pnpm/bin/pnpm.cjs", "test:conformance"], ["/toolchain/bin/napplet", "deploy", "--dry-run", "--json", "--root"]]) await bounded(command, project);
  console.log(JSON.stringify({ status: "built", root: `${project}/dist` }));
}
try {
  if (process.argv[2] === "ready") await ready();
  else if (process.argv[2] === "build-source") await build();
  else if (process.argv[2] === "run-proposal") console.log(JSON.stringify({ status: "unavailable", code: "WORKER_UNAVAILABLE" }));
  else throw new Error("WORKER_COMMAND_INVALID");
} catch (error) { console.error(error instanceof Error ? error.message : "WORKER_FAILED"); process.exitCode = 1; }
