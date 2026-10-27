#!/usr/bin/env bun
import { lookup } from "node:dns/promises";
import { access, constants, lstat, mkdir, readFile, rm, statfs, writeFile } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";

const WORKSPACE = "/workspace";
const POLICY = "production-worker-policy-2026-10-27";
const DIGEST = /^[a-f0-9]{64}$/iu;
const MAX_BYTES = 128 * 1024;
const MAX_OUTPUT = 64 * 1024;
const MAX_MS = 60_000;

function arg(name: string): string | undefined { const i = process.argv.indexOf(name); return i < 0 ? undefined : process.argv[i + 1]; }
function digest(value: string | undefined, code: string) { if (!value || !DIGEST.test(value)) throw new Error(code); return value.toLowerCase(); }
async function bounded(argv: string[], cwd?: string) {
  const child = Bun.spawn(argv, { cwd, stdout: "pipe", stderr: "pipe", env: { HOME: "/home/napplet", CI: "1", PLAYWRIGHT_BROWSERS_PATH: "/toolchain/ms-playwright", PATH: "/toolchain/bin:/toolchain/pnpm:/toolchain/node_modules/.bin:/usr/local/bin:/usr/bin:/bin" } });
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    const timeout = new Promise<never>((_, reject) => { timer = setTimeout(() => { child.kill(); reject(new Error("WORKER_CHILD_TIMEOUT")); }, MAX_MS); });
    const [status, stdout, stderr] = await Promise.race([Promise.all([child.exited, new Response(child.stdout).text(), new Response(child.stderr).text()]), timeout]);
    if (new TextEncoder().encode(stdout).byteLength + new TextEncoder().encode(stderr).byteLength > MAX_OUTPUT) throw new Error("WORKER_CHILD_OUTPUT_LIMIT");
    if (status !== 0) throw new Error("WORKER_CHILD_FAILED");
  } finally { clearTimeout(timer); }
}
async function regularContained(path: string) {
  const resolved = resolve(path); if (!resolved.startsWith(`${WORKSPACE}/.napplet-cvm/`)) throw new Error("WORKER_PATH_INVALID");
  const details = await lstat(resolved); if (!details.isFile() || details.isSymbolicLink() || details.nlink !== 1) throw new Error("WORKER_PATH_UNTRUSTED");
  return resolved;
}
async function workspaceBounded() {
  const fs = await statfs(WORKSPACE); // tmpfs is required: a writable overlay alone is never a quota.
  const tmpfsMagic = 0x01021994; if (Number(fs.type) !== tmpfsMagic || Number(fs.bsize) * Number(fs.blocks) > 512 * 1024 * 1024) return false;
  const probe = join(WORKSPACE, `.write-${crypto.randomUUID()}`);
  try { await writeFile(probe, "x", { flag: "wx" }); await rm(probe, { force: true }); return true; } catch { return false; }
}
async function shellDenied(script: string) { try { await bounded(["/bin/sh", "-ec", script]); return false; } catch { return true; } }
async function networkDenied() {
  const checks = await Promise.all([
    lookup("example.com").then(() => false).catch(() => true),
    shellDenied("/toolchain/bin/denial-probe --probe=http"), shellDenied("/toolchain/bin/denial-probe --probe=https"),
    shellDenied("/toolchain/bin/denial-probe --probe=tcp"),
    shellDenied("/toolchain/bin/denial-probe --probe=metadata"), shellDenied("/toolchain/bin/denial-probe --probe=websocket"),
  ]);
  return checks.every(Boolean);
}
async function kernelIsolation() {
  const status = await readFile("/proc/self/status", "utf8");
  return ["CapInh", "CapPrm", "CapEff", "CapBnd", "CapAmb"].every((field) => new RegExp(`^${field}:\\s*0+$`, "m").test(status)) && /^NoNewPrivs:\s*1$/m.test(status);
}
async function ready() {
  const sessionLeaseSha256 = digest(arg("--session-lease-sha256"), "WORKER_LEASE_REQUIRED");
  const imageDigest = digest(arg("--provider-image-sha256"), "WORKER_PROVIDER_IMAGE_REQUIRED");
  const toolchainDigest = digest(arg("--toolchain-sha256"), "WORKER_TOOLCHAIN_REQUIRED");
  const deadlineEpochMs = Number(arg("--provider-deadline-epoch-ms"));
  if (!Number.isSafeInteger(deadlineEpochMs) || deadlineEpochMs <= Date.now() || deadlineEpochMs > Date.now() + 600_000 || process.env.NAPPLET_CVM_POLICY_VERSION !== POLICY) throw new Error("WORKER_PROVIDER_FACTS_INVALID");
  const environmentClean = Object.keys(process.env).every((key) => ["HOME", "CI", "PATH", "PLAYWRIGHT_BROWSERS_PATH", "NAPPLET_CVM_POLICY_VERSION"].includes(key));
  const [boundedWorkspace, network, kernel, toolchain] = await Promise.all([workspaceBounded(), networkDenied(), kernelIsolation(), access("/toolchain", constants.W_OK).then(() => false).catch(() => true)]);
  const ports = await readFile("/proc/net/tcp", "utf8").then((text) => !text.split("\n").slice(1).some((line) => line.trim().split(/\s+/u)[3] === "0A")).catch(() => false);
  if (!boundedWorkspace || !network || !kernel || !toolchain || !ports || !environmentClean || process.getuid?.() !== 65532) throw new Error("WORKER_ISOLATION_REFUSED");
  console.log(JSON.stringify({ version: 1, policyVersion: POLICY, imageDigest, toolchainDigest, sessionLeaseSha256, deadlineEpochMs, checks: { workspace_bounded: true, network_denied: true, kernel_isolated: true, toolchain_readonly: true, no_inbound_ports: true, environment_clean: true } }));
}
async function build() {
  const sourcePath = await regularContained(arg("--source") ?? ""); const sourceText = await Bun.file(sourcePath).text();
  if (new TextEncoder().encode(sourceText).byteLength > MAX_BYTES) throw new Error("WORKER_SOURCE_TOO_LARGE");
  const source = JSON.parse(sourceText) as { files?: Array<{ path?: unknown; content?: unknown }> };
  if (!Array.isArray(source.files) || source.files.length < 1 || source.files.length > 3) throw new Error("WORKER_SOURCE_INVALID");
  const allowed = new Set(["src/main.ts", "src/styles.css", "src/capabilities.json"]); const project = `${WORKSPACE}/project`;
  await bounded(["/toolchain/bin/napplet", "create", project, "--template", "/toolchain/boilerplate-template"], WORKSPACE);
  await bounded(["/toolchain/bin/napplet", "init", "--force", "--root", "--source-dir", "src", "--title", "Generated napplet"], project);
  await bounded(["/toolchain/bin/napplet", "skills", "install", "--to", "codex"], project);
  for (const file of source.files) {
    if (!file || typeof file.path !== "string" || !allowed.has(file.path) || typeof file.content !== "string" || file.content.length > 30_000) throw new Error("WORKER_SOURCE_INVALID");
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
