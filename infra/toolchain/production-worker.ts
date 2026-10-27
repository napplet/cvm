#!/usr/bin/env bun
/**
 * Trusted entrypoint for the promoted worker image.  It is intentionally a
 * small command surface: untrusted source never receives controller/provider
 * credentials and build steps remain the pinned napplet CLI/pnpm/conformance
 * flow already installed in this image.
 */
import { lookup } from "node:dns/promises";
import { access, constants, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";

const POLICY_VERSION = "production-worker-policy-2026-10-27";
const WORKSPACE = "/workspace";
const MAX_REQUEST_BYTES = 32 * 1024;
const DIGEST = /^[a-f0-9]{64}$/iu;
const forbiddenEnvironment = /(?:credential|password|private.?key|database|modal|fly|google|token|secret)/iu;

function argument(name: string): string | undefined {
  const index = process.argv.indexOf(name);
  return index === -1 ? undefined : process.argv[index + 1];
}
function exactDigest(value: string | undefined, code: string): string {
  if (!value || !DIGEST.test(value)) throw new Error(code);
  return value.toLowerCase();
}
async function writable(path: string): Promise<boolean> {
  const candidate = join(path, `.napplet-cvm-write-test-${crypto.randomUUID()}`);
  try { await writeFile(candidate, "x", { flag: "wx" }); await rm(candidate, { force: true }); return true; }
  catch { return false; }
}
async function deniedNetwork(): Promise<boolean> {
  try { await Promise.race([lookup("example.com"), Bun.sleep(2_000).then(() => Promise.reject(new Error("timeout")))]); return false; }
  catch { return true; }
}
async function noAmbientCredentials(): Promise<boolean> {
  return Object.entries(process.env).every(([key, value]) => !forbiddenEnvironment.test(key) || key === "NAPPLET_CVM_POLICY_VERSION" || value === undefined);
}
async function capabilitiesDropped(): Promise<boolean> {
  try {
    const status = await readFile("/proc/self/status", "utf8");
    return /^CapEff:\s*0+$/mu.test(status);
  } catch { return false; }
}
async function noInboundPorts(): Promise<boolean> {
  try {
    const [tcp, tcp6] = await Promise.all([readFile("/proc/net/tcp", "utf8"), readFile("/proc/net/tcp6", "utf8")]);
    return ![...tcp.split("\n"), ...tcp6.split("\n")].slice(1).some((line) => line.trim().split(/\s+/u)[3] === "0A");
  } catch { return false; }
}
async function readiness() {
  const sessionBindingSha256 = exactDigest(argument("--session-binding-sha256"), "WORKER_SESSION_BINDING_REQUIRED");
  const leaseSha256 = exactDigest(argument("--lease-sha256"), "WORKER_LEASE_REQUIRED");
  const image = argument("--image"); if (!image || !/@sha256:[a-f0-9]{64}$/iu.test(image)) throw new Error("WORKER_IMAGE_REQUIRED");
  if (process.env.NAPPLET_CVM_POLICY_VERSION !== POLICY_VERSION) throw new Error("WORKER_POLICY_REQUIRED");
  const checks = {
    toolchain_readonly: !(await writable("/toolchain")),
    workspace_bounded: await writable(WORKSPACE),
    non_root: process.getuid?.() === 65_532,
    no_ambient_credentials: await noAmbientCredentials(),
    network_denied: await deniedNetwork(),
    no_inbound_ports: await noInboundPorts(),
    minimal_capabilities: await capabilitiesDropped(),
  };
  if (Object.values(checks).some((value) => !value)) throw new Error("WORKER_ISOLATION_CHECK_FAILED");
  return { version: 1, policyVersion: POLICY_VERSION, checks, exactReady: { sessionBindingSha256, leaseSha256, image, remainingLifetimeMs: 600_000 } };
}
async function runProposal() {
  const requestPath = argument("--request");
  if (!requestPath?.startsWith(`${WORKSPACE}/.napplet-cvm/`)) throw new Error("WORKER_REQUEST_PATH_INVALID");
  const text = await Bun.file(requestPath).text();
  if (new TextEncoder().encode(text).byteLength > MAX_REQUEST_BYTES) throw new Error("WORKER_REQUEST_TOO_LARGE");
  const request = JSON.parse(text) as Record<string, unknown>;
  const allowed = ["sessionId", "actionId", "expectedVersion", "policyVersion", "capabilityGrant", "workspaceId", "idea"];
  if (Object.keys(request).some((key) => !allowed.includes(key)) || request.policyVersion !== POLICY_VERSION || typeof request.idea !== "string" || request.idea.length === 0 || request.idea.length > 4_000 || typeof request.capabilityGrant !== "string" || request.capabilityGrant.length > 512) throw new Error("WORKER_REQUEST_INVALID");
  // The trusted agent boundary only returns a constrained proposal.  It never
  // treats arbitrary command text, URLs, environment values, or provider keys
  // as source code. Materialization uses the separately mounted, bounded
  // source reference via the pinned build command below.
  console.log(JSON.stringify({ status: "proposed", toolRequests: [], evidence: [{ type: "worker", detail: "bounded isolated proposal accepted" }] }));
}
async function buildSource() {
  const source = argument("--source");
  if (!source?.startsWith(`${WORKSPACE}/.napplet-cvm/`) || !source.endsWith(".json")) throw new Error("WORKER_SOURCE_REFERENCE_INVALID");
  const payload = await Bun.file(source).text();
  if (new TextEncoder().encode(payload).byteLength > 128 * 1024) throw new Error("WORKER_SOURCE_TOO_LARGE");
  const parsed = JSON.parse(payload) as { files?: unknown };
  if (!Array.isArray(parsed.files) || parsed.files.length === 0 || parsed.files.length > 8) throw new Error("WORKER_SOURCE_INVALID");
  const project = `${WORKSPACE}/project`;
  await mkdir(project, { recursive: true, mode: 0o700 });
  const create = Bun.spawn(["/toolchain/bin/napplet", "create", project, "--template", "/toolchain/boilerplate-template"], { stdout: "pipe", stderr: "pipe", env: { HOME: "/home/napplet", CI: "1", PATH: process.env.PATH ?? "" } });
  if (await create.exited !== 0) throw new Error("WORKER_SCAFFOLD_FAILED");
  for (const file of parsed.files) {
    if (!file || typeof file !== "object") throw new Error("WORKER_SOURCE_INVALID");
    const item = file as { path?: unknown; content?: unknown };
    if (typeof item.path !== "string" || !/^src\/[a-zA-Z0-9._/-]{1,240}$/u.test(item.path) || item.path.includes("..") || typeof item.content !== "string" || item.content.length > 30_000) throw new Error("WORKER_SOURCE_INVALID");
    const target = join(project, item.path); await mkdir(join(target, ".."), { recursive: true }); await writeFile(target, item.content, { mode: 0o600 });
  }
  const commands = [
    ["/toolchain/pnpm/bin/pnpm.cjs", "install", "--offline", "--frozen-lockfile", "--ignore-scripts"],
    ["/toolchain/pnpm/bin/pnpm.cjs", "build"],
    ["/toolchain/pnpm/bin/pnpm.cjs", "verify"],
    ["/toolchain/pnpm/bin/pnpm.cjs", "test:conformance"],
  ];
  for (const command of commands) {
    const child = Bun.spawn(command, { cwd: project, stdout: "pipe", stderr: "pipe", env: { HOME: "/home/napplet", CI: "1", PATH: process.env.PATH ?? "" } });
    if (await child.exited !== 0) throw new Error("WORKER_CONFORMANCE_FAILED");
  }
  await access(join(project, "dist"), constants.R_OK);
  console.log(JSON.stringify({ status: "built", root: `${project}/dist` }));
}

try {
  const command = process.argv[2];
  if (command === "ready") console.log(JSON.stringify(await readiness()));
  else if (command === "run-proposal") await runProposal();
  else if (command === "build-source") await buildSource();
  else throw new Error("WORKER_COMMAND_INVALID");
} catch (error) {
  console.error(error instanceof Error ? error.message : "WORKER_FAILED");
  process.exitCode = 1;
}
