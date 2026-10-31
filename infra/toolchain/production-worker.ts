#!/usr/bin/env bun
import { lookup } from "node:dns/promises";
import { access, appendFile, constants, lstat, mkdir, readFile, realpath, rm, statfs, writeFile } from "node:fs/promises";
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
  const started = performance.now();
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
    await appendFile(`${WORKSPACE}/.napplet-cvm/commands.ndjson`, `${JSON.stringify({ argv, cwd, status, stdout, stderr, elapsedMs: Math.ceil(performance.now() - started) })}\n`, { mode: 0o600 });
    if (status !== 0) throw new Error(`WORKER_CHILD_FAILED:${`${stdout}\n${stderr}`.slice(0, 2_000).replace(/[\r\n]+/gu, " ")}`);
  } finally { clearTimeout(timer); child.kill(); }
}
async function boundedStream(stream: ReadableStream<Uint8Array>, limit = MAX_OUTPUT) {
  const reader = stream.getReader(); const chunks: Uint8Array[] = []; let length = 0;
  try {
    for (;;) {
      const next = await reader.read(); if (next.done) break;
      length += next.value.byteLength;
      if (length > limit) { await reader.cancel(new Error("WORKER_OUTPUT_LIMIT")); throw new Error("WORKER_OUTPUT_LIMIT"); }
      chunks.push(next.value);
    }
  } finally { reader.releaseLock(); }
  return new TextDecoder().decode(Buffer.concat(chunks));
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
type WritableSurfaceAudit = Readonly<{ ok: boolean; stage: string }>;
async function writableSurfaceConfined(): Promise<WritableSurfaceAudit> {
  // `find / -xdev` omits every separately-mounted filesystem. Enumerate the
  // kernel mount table instead, then ask the current (unprivileged) UID which
  // mount roots it can actually write. A writable mount not in this list is a
  // refusal, not a best-effort finding.
  const allowed = new Map<string, number>([[WORKSPACE, 512 * 1024 * 1024], ["/home/napplet", 64 * 1024 * 1024], ["/tmp", 64 * 1024 * 1024], ["/var/tmp", 64 * 1024 * 1024], ["/work", 64 * 1024 * 1024], ["/run/lock", 16 * 1024 * 1024], ["/dev/shm", 64 * 1024 * 1024]]);
  const label = (path: string) => {
    const fixed: Record<string, string> = { [WORKSPACE]: "WORKSPACE", "/home/napplet": "HOME", "/tmp": "TMP", "/var/tmp": "VARTMP", "/work": "WORK", "/run/lock": "LOCK", "/dev/shm": "SHM", "/proc/interrupts": "PROC_INTERRUPTS", "/proc/kcore": "PROC_KCORE", "/proc/keys": "PROC_KEYS", "/proc/latency_stats": "PROC_LATENCY_STATS", "/proc/sched_debug": "PROC_SCHED_DEBUG", "/proc/timer_list": "PROC_TIMER_LIST", "/proc/timer_stats": "PROC_TIMER_STATS" };
    return fixed[path] ?? "OTHER";
  };
  const failed = (stage: string): WritableSurfaceAudit => Object.freeze({ ok: false, stage });
  const unescapeMount = (value: string) => value.replace(/\\040|\\011|\\012|\\134/gu, token => ({ "\\040": " ", "\\011": "\t", "\\012": "\n", "\\134": "\\" })[token]!);
  try {
    const lines = (await readFile("/proc/self/mountinfo", "utf8")).trim().split("\n").filter(Boolean);
    const mounts = lines.map(line => {
      const separator = line.indexOf(" - "); const fields = separator < 0 ? [] : line.slice(0, separator).split(" ");
      if (fields.length < 6 || !fields[4]?.startsWith("/")) throw new Error("WORKER_MOUNTINFO_INVALID");
      return Object.freeze({ path: unescapeMount(fields[4]), readOnly: fields[5]!.split(",").includes("ro") });
    });
    if (new Set(mounts.map(mount => mount.path)).size !== mounts.length) return failed("MOUNTINFO_DUPLICATE_TARGET");
    for (const mount of mounts) {
      const { path } = mount;
      // Mount-root permissions do not describe writable descendants. The exact
      // policy therefore rejects every unlisted read-write mount by mountinfo
      // metadata before consulting discretionary access bits.
      if (!mount.readOnly && !allowed.has(path)) return failed(`RW_${label(path)}`);
      const writable = await access(path, constants.W_OK).then(() => true).catch(() => false);
      if (!writable) continue;
      const maximum = allowed.get(path); if (maximum === undefined) return failed(`WRITABLE_${label(path)}`);
      const fs = await statfs(path);
      if (Number(fs.type) !== 0x01021994) return failed(`FSTYPE_${label(path)}`);
      if (Number(fs.bsize) * Number(fs.blocks) <= 0 || Number(fs.bsize) * Number(fs.blocks) > maximum) return failed(`SIZE_${label(path)}`);
    }
    return Object.freeze({ ok: true, stage: "OK" });
  } catch { return failed("MOUNTINFO_READ"); }
}
async function cgroupV2Limits() {
  const membership = (await readFile("/proc/self/cgroup", "utf8")).trim().split("\n").find(line => line.startsWith("0::"));
  if (!membership) throw new Error("WORKER_CGROUP_V2_REQUIRED");
  const relative = membership.slice(3);
  if (!relative.startsWith("/") || relative.split("/").some(part => part === "..")) throw new Error("WORKER_CGROUP_V2_INVALID");
  const root = `/sys/fs/cgroup${relative}`;
  const [controllers, cpu, memory, pids] = await Promise.all([readFile("/sys/fs/cgroup/cgroup.controllers", "utf8"), readFile(`${root}/cpu.max`, "utf8"), readFile(`${root}/memory.max`, "utf8"), readFile(`${root}/pids.max`, "utf8")]);
  if (!controllers.split(/\s+/u).includes("cpu") || !controllers.split(/\s+/u).includes("memory") || !controllers.split(/\s+/u).includes("pids")) throw new Error("WORKER_CGROUP_V2_REQUIRED");
  const cpuParts = cpu.trim().split(/\s+/u); const quota = Number(cpuParts[0]), period = Number(cpuParts[1]), memoryMax = Number(memory.trim()), pidsMax = Number(pids.trim());
  if (cpuParts.length !== 2 || cpuParts[0] === "max" || !Number.isSafeInteger(quota) || !Number.isSafeInteger(period) || quota <= 0 || period <= 0 || quota > period * 2 || !Number.isSafeInteger(memoryMax) || memoryMax <= 0 || memoryMax > 2_048 * 1024 * 1024 || !Number.isSafeInteger(pidsMax) || pidsMax <= 0 || pidsMax > 256) throw new Error("WORKER_CGROUP_LIMIT_REQUIRED");
  return Object.freeze({ cpuQuotaMicros: quota, cpuPeriodMicros: period, memoryMaxBytes: memoryMax, pidsMax });
}
async function noInboundListeners() {
  const listening = await Promise.all(["/proc/net/tcp", "/proc/net/tcp6"].map(async path => (await readFile(path, "utf8")).split("\n").slice(1).some(line => line.trim().split(/\s+/u)[3] === "0A")));
  return !listening.some(Boolean);
}
async function deniedProbe(probe: string) {
  const child = Bun.spawn(["/toolchain/bin/bun", "/toolchain/bin/denial-probe", `--probe=${probe}`], { stdout: "pipe", stderr: "pipe", env: { PATH: "/toolchain/bin:/usr/bin:/bin" } });
  const timer = setTimeout(() => child.kill(), 5_000);
  try { const [exit, stderr] = await Promise.all([child.exited, boundedStream(child.stderr, 8 * 1024)]); return exit === 1 && stderr.includes(`CVM_DENIAL_PROBE:${probe}:denied`); }
  finally { clearTimeout(timer); child.kill(); }
}
async function namespaceConfined() {
  const run = async (argv: string[]) => {
    const child = Bun.spawn(["/toolchain/bin/busybox", "ip", ...argv], { stdout: "pipe", stderr: "pipe", env: { PATH: "/toolchain/bin:/usr/bin:/bin" } });
    const timer = setTimeout(() => child.kill(), 5_000);
    try { const [exit, stdout, stderr] = await Promise.all([child.exited, boundedStream(child.stdout, 8 * 1024), boundedStream(child.stderr, 8 * 1024)]); return exit === 0 && stderr === "" ? stdout : undefined; }
    finally { clearTimeout(timer); child.kill(); }
  };
  const [links, ipv4Default, ipv6Default] = await Promise.all([run(["-o", "link", "show"]), run(["route", "show", "default"]), run(["-6", "route", "show", "default"])]);
  const activeNonLoopback = links?.trim().split("\n").some((line) => !/^1:\s+lo:/u.test(line) && /<[^>]*\bUP\b/u.test(line));
  return links !== undefined && ipv4Default !== undefined && ipv6Default !== undefined && /^1:\s+lo:/mu.test(links) && !activeNonLoopback && !ipv4Default.trim() && !ipv6Default.trim();
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
  const [boundedWorkspace, writableSurfaceAudit, network, namespace, kernel, toolchain] = await Promise.all([workspaceBounded().catch(() => false), writableSurfaceConfined(), networkDenied().catch(() => false), namespaceConfined().catch(() => false), kernelIsolation().catch(() => false), access("/toolchain", constants.W_OK).then(() => false).catch(() => true)]);
  const writableSurface = writableSurfaceAudit.ok;
  const ports = await noInboundListeners().catch(() => false);
  if (!boundedWorkspace || !writableSurface || !network || !namespace || !kernel || !toolchain || !ports || !environmentClean || process.getuid?.() !== 65532) {
    console.error(JSON.stringify({ code: "WORKER_ISOLATION_REFUSED", checks: { workspaceBounded, writableSurface, ...(writableSurface ? {} : { writableSurfaceStage: writableSurfaceAudit.stage }), network, namespace, kernel, toolchain, ports, environmentClean, nonRoot: process.getuid?.() === 65532 } }));
    throw new Error("WORKER_ISOLATION_REFUSED");
  }
  console.log(JSON.stringify({ version: 1, policyVersion: POLICY, image, sessionLeaseSha256, toolchainSha256: toolchainDigest, remainingLifetimeMs, checks: { toolchain_readonly: true, workspace_bounded: true, non_root: true, no_ambient_credentials: true, network_denied: true, no_inbound_ports: true, minimal_capabilities: true } }));
}
/** A fixed hostile probe, run through the same unprivileged bootstrap path as
 * generated work. Its facts are measured here, not accepted from a project
 * report: network denial, bounded writable surfaces, capability dropping, and
 * lease lifetime are all checked against the running worker namespace. */
async function edgeAudit() {
  const candidateSha256 = digest(arg("--candidate-sha256"), "EDGE_AUDIT_CANDIDATE_REQUIRED");
  const topologySha256 = digest(arg("--topology-sha256"), "EDGE_AUDIT_TOPOLOGY_REQUIRED");
  if (process.argv.length !== 7 || process.env.NAPPLET_CVM_POLICY_VERSION !== POLICY) throw new Error("EDGE_AUDIT_ARGUMENTS_REQUIRED");
  const environmentClean = Object.keys(process.env).every((key) => ["HOME", "CI", "PATH", "PLAYWRIGHT_BROWSERS_PATH", "NAPPLET_CVM_POLICY_VERSION"].includes(key));
  const [boundedWorkspace, writableSurfaceAudit, network, namespace, kernel, toolchain, limits, ports] = await Promise.all([workspaceBounded(), writableSurfaceConfined(), networkDenied(), namespaceConfined(), kernelIsolation(), access("/toolchain", constants.W_OK).then(() => false).catch(() => true), cgroupV2Limits(), noInboundListeners()]);
  const writableSurface = writableSurfaceAudit.ok;
  if (!boundedWorkspace || !writableSurface || !network || !namespace || !kernel || !toolchain || !ports || !environmentClean || process.getuid?.() !== 65532) throw new Error("EDGE_AUDIT_HARD_STOP_REQUIRED");
  // Provider image identity and expiry are intentionally absent. They are not
  // observable inside the sandbox and must come from authenticated
  // control-plane readback before this output may become an edge certificate.
  console.log(JSON.stringify({ version: 2, kind: "edge-native-v2", candidateSha256, topologySha256, cgroup: limits,
    hostile: { filesystemDenied: true, networkDenied: true, noInboundPorts: true, nonRoot: true, minimalCapabilities: true } }));
}
async function build() {
  const profile = Bun.file("/toolchain/production-artifact-contract");
  if (await profile.exists() && (await profile.text()).trim() === "nip5d-direct-v1") throw new Error("WORKER_ASYNC_DIRECT_JOB_REQUIRED");
  activeDeadlineEpochMs = Number(arg("--active-deadline-epoch-ms"));
  if (!Number.isSafeInteger(activeDeadlineEpochMs) || activeDeadlineEpochMs <= Date.now() || activeDeadlineEpochMs > Date.now() + 600_000) throw new Error("WORKER_ACTIVE_DEADLINE_INVALID");
  const sourcePath = await regularContained(arg("--source") ?? ""); const sourceBytes = await Bun.file(sourcePath).bytes();
  if (sourceBytes.byteLength > MAX_BYTES) throw new Error("WORKER_SOURCE_TOO_LARGE"); const sourceText = new TextDecoder().decode(sourceBytes);
  const source = JSON.parse(sourceText) as { files?: Array<{ path?: unknown; content?: unknown }> };
  if (!Array.isArray(source.files) || source.files.length < 1 || source.files.length > 3) throw new Error("WORKER_SOURCE_INVALID");
  // The exact, pinned boilerplate owns the entrypoint.  The proven development
  // worker accepts this same surface; old fixture snippets that overlayed an
  // unused App.tsx are not a source-of-truth for this production path.
  const allowed = new Set(["src/main.ts", "src/styles.css", "src/capabilities.json"]);
  const files = source.files.map((file) => {
    if (!file || typeof file.path !== "string" || !allowed.has(file.path) || typeof file.content !== "string" || new TextEncoder().encode(file.content).byteLength > 30_000) throw new Error("WORKER_SOURCE_INVALID");
    return { path: file.path, content: file.content };
  });
  if (new Set(files.map((file) => file.path)).size !== files.length) throw new Error("WORKER_SOURCE_DUPLICATE");
  const project = `${WORKSPACE}/project`;
  // Validate every untrusted source fact before invoking the CLI or changing
  // the project filesystem.  The commands below match the proven fixture flow.
  await bounded(["/toolchain/bin/napplet", "create", project, "--template", "/toolchain/boilerplate-template"], WORKSPACE);
  await bounded(["/toolchain/bin/napplet", "init", "--force", "--root", "--source-dir", "dist", "--title", "Generated napplet"], project);
  // Skills are policy input for the worker, not generated artifact content.
  // Keep their installed text outside the project so boilerplate guidance does
  // not see a forked skill body in the published tree.
  await bounded(["/toolchain/bin/bun", "/toolchain/node_modules/@napplet/skills/dist/cli.js", "install", "--to", "codex", "--dir", "/home/napplet"], project);
  for (const file of files) {
    const target = resolve(project, file.path); if (!target.startsWith(`${project}/src/`)) throw new Error("WORKER_SOURCE_INVALID");
    await mkdir(dirname(target), { recursive: true }); await writeFile(target, file.content, { mode: 0o600 });
  }
  const pnpm = "/toolchain/pnpm-10.8/bin/pnpm.cjs";
  await bounded([pnpm, "install", "--offline", "--frozen-lockfile", "--ignore-scripts", "--store-dir", "/toolchain/pnpm-store"], project);
  for (const command of [[pnpm, "build"], [pnpm, "verify"], [pnpm, "test:conformance"], ["/toolchain/bin/napplet", "deploy", "--dry-run", "--json", "--root"]]) await bounded(command, project);
  console.log(JSON.stringify({ status: "built", root: `${project}/dist` }));
}
async function idle() {
  const remaining = Number(arg("--provider-deadline-epoch-ms")) - Date.now();
  if (process.argv.length !== 5 || process.getuid?.() !== 0 || process.env.NAPPLET_CVM_POLICY_VERSION !== POLICY || !Number.isSafeInteger(remaining) || remaining <= 0 || remaining > 1_200_000) throw new Error("WORKER_SUPERVISOR_DEADLINE_INVALID");
  // Bun's timer is monotonic: wall-clock adjustment cannot extend this lease.
  await Bun.sleep(remaining);
}
try {
  if (process.argv[2] === "idle") await idle();
  else if (process.argv[2] === "ready") await ready();
  else if (process.argv[2] === "edge-audit") await edgeAudit();
  else if (process.argv[2] === "build-source") await build();
  else if (process.argv[2] === "run-proposal") console.log(JSON.stringify({ status: "unavailable", code: "WORKER_UNAVAILABLE" }));
  else throw new Error("WORKER_COMMAND_INVALID");
} catch (error) { console.error(error instanceof Error ? error.message : "WORKER_FAILED"); process.exitCode = 1; }
