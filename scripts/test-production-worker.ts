#!/usr/bin/env bun
/**
 * No-effect local mechanism validation for the production-worker image.
 *
 * It deliberately uses Docker's ordinary default network. The readiness
 * command must prove that trusted bootstrap created a denied inner namespace;
 * this is local compatibility evidence, never provider evidence.
 */
import { mkdir, writeFile } from "node:fs/promises";
import { dirname } from "node:path";
import { canonicalJson } from "../src/promotion/schema";

const POLICY = "production-worker-policy-2026-10-27";
const MAX_OUTPUT = 512 * 1024;
const DEFAULT_TIMEOUT_MS = 30_000;
const image = process.argv[2] ?? "napplet-cvm-production-worker:local";
const run = `${process.pid}-${crypto.randomUUID().replaceAll("-", "").slice(0, 12)}`;
const reportPath = process.env.NAPPLET_CVM_WORKER_REPORT ?? `/tmp/napplet-cvm-production-worker-${run}.json`;
const logPath = reportPath.replace(/\.json$/u, "") + ".log";
// Local compatibility test needs mount permission for trusted bootstrap.
// Docker's default AppArmor profile denies mounts even with CAP_SYS_ADMIN.
// This is deliberately not a production provider isolation certificate.
const resourceArgs = ["--cpus", "1", "--memory", "1024m", "--memory-swap", "1024m", "--security-opt", "apparmor=unconfined"];
const containers = [`napplet-cvm-production-worker-build-${run}`, `napplet-cvm-production-worker-idle-${run}`, `napplet-cvm-production-worker-ready-${run}`, `napplet-cvm-production-worker-jobs-${run}`];
const lease = "a".repeat(64);
const imageHash = "b".repeat(64);
const toolchain = "c".repeat(64);
const REQUIRED_READINESS_CHECKS = ["toolchain_readonly", "workspace_bounded", "non_root", "no_ambient_credentials", "network_denied", "no_inbound_ports", "minimal_capabilities"] as const;

type CommandResult = Readonly<{ argv: string[]; status: number; stdout: string; stderr: string; elapsedMs: number }>;
type WorkerCommand = Readonly<{ argv: string[]; cwd?: string; status: number; stdout: string; stderr: string; elapsedMs: number }>;

async function collect(stream: ReadableStream<Uint8Array>, limit = MAX_OUTPUT): Promise<string> {
  const reader = stream.getReader(); const chunks: Uint8Array[] = []; let size = 0;
  try {
    for (;;) {
      const part = await reader.read(); if (part.done) break;
      size += part.value.byteLength;
      if (size > limit) throw new Error("HOST_DOCKER_OUTPUT_LIMIT");
      chunks.push(part.value);
    }
  } finally { reader.releaseLock(); }
  return new TextDecoder().decode(Buffer.concat(chunks));
}

async function docker(argv: string[], timeoutMs = DEFAULT_TIMEOUT_MS): Promise<CommandResult> {
  const started = performance.now();
  const child = Bun.spawn(["docker", ...argv], { stdout: "pipe", stderr: "pipe" });
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    const [status, stdout, stderr] = await Promise.race([
      Promise.all([child.exited, collect(child.stdout), collect(child.stderr)]),
      new Promise<never>((_, reject) => { timer = setTimeout(() => { child.kill(); reject(new Error(`HOST_DOCKER_TIMEOUT:${argv[0] ?? ""}`)); }, timeoutMs); }),
    ]);
    return { argv, status, stdout, stderr, elapsedMs: Math.ceil(performance.now() - started) };
  } finally { clearTimeout(timer); child.kill(); }
}

async function requireDocker(argv: string[], timeoutMs?: number) {
  const result = await docker(argv, timeoutMs);
  if (result.status !== 0) throw new Error(`HOST_DOCKER_FAILED:${argv[0] ?? ""}:${result.status}:${result.stderr.slice(0, 2_000)}`);
  return result;
}

function lastJson(text: string): Record<string, unknown> {
  const line = text.trim().split("\n").filter(Boolean).at(-1);
  if (!line) throw new Error("WORKER_READINESS_MISSING");
  const value: unknown = JSON.parse(line);
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("WORKER_READINESS_INVALID");
  return value as Record<string, unknown>;
}

function parseCommands(text: string): WorkerCommand[] {
  const begin = "CVM_COMMANDS_NDJSON_BEGIN\n"; const end = "\nCVM_COMMANDS_NDJSON_END";
  const start = text.lastIndexOf(begin); const finish = start < 0 ? -1 : text.indexOf(end, start + begin.length);
  if (start < 0 || finish < 0) throw new Error("WORKER_COMMAND_RECORDS_MISSING");
  const rows = text.slice(start + begin.length, finish).split("\n").filter(Boolean).map((line) => JSON.parse(line) as unknown);
  if (!rows.length) throw new Error("WORKER_COMMAND_RECORDS_EMPTY");
  return rows.map((row) => {
    if (!row || typeof row !== "object" || Array.isArray(row)) throw new Error("WORKER_COMMAND_RECORD_INVALID");
    const record = row as Record<string, unknown>;
    if (!Array.isArray(record.argv) || !record.argv.every((value) => typeof value === "string") || typeof record.status !== "number" || typeof record.stdout !== "string" || typeof record.stderr !== "string" || typeof record.elapsedMs !== "number") throw new Error("WORKER_COMMAND_RECORD_INVALID");
    return { argv: record.argv as string[], cwd: typeof record.cwd === "string" ? record.cwd : undefined, status: record.status, stdout: record.stdout, stderr: record.stderr, elapsedMs: record.elapsedMs };
  });
}

function requireCommands(records: WorkerCommand[]) {
  const includes = (...parts: string[]) => records.some((record) => parts.every((part) => record.argv.some((argument) => argument.includes(part))) && record.status === 0);
  for (const expected of [
    ["napplet", "create"], ["napplet", "init"], ["@napplet/skills", "install"], ["pnpm.cjs", "install", "--offline", "--frozen-lockfile"], ["pnpm.cjs", "build"], ["pnpm.cjs", "verify"], ["pnpm.cjs", "test:conformance"], ["napplet", "deploy", "--dry-run", "--json"],
  ]) if (!includes(...expected)) throw new Error(`WORKER_COMMAND_MISSING:${expected.join(" ")}`);
}

function readinessArguments(deadline: number) {
  return ["/usr/local/bin/napplet-cvm-worker", "ready", "--session-lease-sha256", lease, "--provider-image", `registry.example/worker@sha256:${imageHash}`, "--toolchain-sha256", toolchain, "--provider-deadline-epoch-ms", String(deadline)];
}

const sourceJson = JSON.stringify({ files: [{ path: "src/main.ts", content: "import { runtimeHasDomain } from './domain-availability.js';\nimport \"./styles.css\";\nconst root = document.querySelector<HTMLElement>(\"#app\");\nif (!root) throw new Error(\"APP_ROOT_MISSING\");\nconst message = document.createElement(\"p\");\nmessage.textContent = runtimeHasDomain(\"storage\") ? \"Local production worker proof\" : \"Local proof fallback\";\nroot.replaceChildren(message);\n" }] });
function buildCommand(deadline: number) {
  // The source is created only after bootstrap mounted the bounded workspace
  // and dropped to UID 65532. Printing the journal preserves it before the
  // tmpfs-backed container exits.
  const encoded = Buffer.from(sourceJson).toString("base64");
  return ["/usr/local/bin/napplet-cvm-bootstrap", "/bin/sh", "-ec", `mkdir -p /workspace/.napplet-cvm; printf '%s' '${encoded}' | /usr/bin/base64 -d > /workspace/.napplet-cvm/source.json; result=0; /usr/local/bin/napplet-cvm-worker build-source --source /workspace/.napplet-cvm/source.json --active-deadline-epoch-ms ${deadline} || result=$?; printf '\\nCVM_COMMANDS_NDJSON_BEGIN\\n'; cat /workspace/.napplet-cvm/commands.ndjson || true; printf '\\nCVM_COMMANDS_NDJSON_END\\n'; exit "$result"`];
}

async function containerLogs(name: string) {
  try { return await docker(["logs", name], 10_000); }
  catch (error) { return { argv: ["logs", name], status: -1, stdout: "", stderr: String(error), elapsedMs: 0 }; }
}

const report: Record<string, unknown> = {
  localMechanism: true, realProviderEvidence: false, requestedImage: image,
  startedAt: new Date().toISOString(), logPath, hostDockerNetwork: "ordinary-default (no --network override)", privilegedBootstrap: ["SYS_ADMIN", "NET_ADMIN"],
  hostAppArmor: "unconfined (trusted bootstrap mount test only)",
  resources: { cpus: 1, memoryBytes: 1_073_741_824, memoryAndSwapBytes: 1_073_741_824 },
};

try {
  const inspected = await requireDocker(["image", "inspect", "--format", "{{.Id}} {{.Os}}/{{.Architecture}}", image]);
  const [imageId, platform] = inspected.stdout.trim().split(/\s+/u);
  if (!imageId || !platform) throw new Error("IMAGE_INSPECT_INVALID");
  report.image = { requested: image, id: imageId, platform };

  const readyDeadline = Date.now() + 60_000; const readyArgv = readinessArguments(readyDeadline);
  const readiness = await requireDocker(["run", "--name", containers[2]!, ...resourceArgs, "--cap-add", "SYS_ADMIN", "--cap-add", "NET_ADMIN", "-e", `NAPPLET_CVM_POLICY_VERSION=${POLICY}`, image, "/usr/local/bin/napplet-cvm-bootstrap", ...readyArgv], 90_000);
  const readinessJson = lastJson(readiness.stdout); const checks = readinessJson.checks;
  if (readinessJson.policyVersion !== POLICY || readinessJson.sessionLeaseSha256 !== lease || !checks || typeof checks !== "object" || !REQUIRED_READINESS_CHECKS.every((key) => (checks as Record<string, unknown>)[key] === true)) throw new Error("WORKER_READINESS_ATTESTATION_INVALID");
  report.readiness = { argv: readyArgv, attestation: readinessJson };

  const buildName = containers[0]!; const buildDeadline = Date.now() + 600_000;
  await requireDocker(["create", "--name", buildName, ...resourceArgs, "--cap-add", "SYS_ADMIN", "--cap-add", "NET_ADMIN", "-e", `NAPPLET_CVM_POLICY_VERSION=${POLICY}`, image, ...buildCommand(buildDeadline)]);
  const buildConfig = JSON.parse((await requireDocker(["inspect", "--format", "{{json .HostConfig}}", buildName])).stdout);
  if (!["default", "bridge"].includes(buildConfig.NetworkMode)) throw new Error("HOST_NETWORK_NOT_ORDINARY");
  if (buildConfig.NanoCpus !== 1_000_000_000 || buildConfig.Memory !== 1_073_741_824 || buildConfig.MemorySwap !== 1_073_741_824) throw new Error("LOCAL_RESOURCE_LIMITS_UNVERIFIED");
  await requireDocker(["start", buildName]);
  const buildExit = await requireDocker(["wait", buildName], 11 * 60_000);
  if (buildExit.stdout.trim() !== "0") throw new Error(`WORKER_BUILD_EXIT:${buildExit.stdout.trim()}`);
  const buildLogs = await containerLogs(buildName);
  if (buildLogs.status !== 0) throw new Error(`WORKER_BUILD_LOGS_FAILED:${buildLogs.stderr}`);
  const commands = parseCommands(buildLogs.stdout); requireCommands(commands);
  report.build = { exitCode: 0, logsPath: logPath, commands, conformance: commands.find((record) => record.argv.includes("test:conformance")) };

  const jobName = containers[3]!;
  await requireDocker(["run", "-d", "--name", jobName, ...resourceArgs, "--cap-add", "SYS_ADMIN", "--cap-add", "NET_ADMIN", "-e", `NAPPLET_CVM_POLICY_VERSION=${POLICY}`, image, "/usr/local/bin/napplet-cvm-worker", "idle", "--provider-deadline-epoch-ms", String(Date.now() + 1_200_000)]);
  const jobCommand = async (...args: string[]) => lastJson((await requireDocker(["exec", jobName, "/usr/local/bin/napplet-cvm-bootstrap", "/usr/local/bin/napplet-cvm-job", ...args])).stdout);
  const jobs: unknown[] = [];
  for (let revision = 1; revision <= 2; revision++) {
    const body = canonicalJson({ version: 1, sessionId: "local-job-proof", actionId: `revision-${revision}`, expectedVersion: revision - 1, proposalSha256: lease, toolchainSha256: toolchain, deadlineEpochMs: Date.now() + 600_000, files: JSON.parse(sourceJson).files });
    const bytes = Buffer.from(body), id = new Bun.CryptoHasher("sha256").update(bytes).digest("hex");
    for (let offset = 0, index = 0; offset < bytes.length; offset += 24_576, index++) {
      const stored = await jobCommand("put", id, String(index), bytes.subarray(offset, offset + 24_576).toString("base64"));
      if (stored.state !== "stored" || stored.jobId !== id) throw new Error("WORKER_JOB_UPLOAD_FAILED");
    }
    await jobCommand("start", id, String(Math.ceil(bytes.length / 24_576)));
    // Replay after a lost response must never add another eight commands.
    await jobCommand("start", id, String(Math.ceil(bytes.length / 24_576)));
    let result: Record<string, unknown> | undefined;
    const deadline = Date.now() + 600_000;
    do { result = await jobCommand("status", id); if (result.state !== "pending") break; await Bun.sleep(1_000); } while (Date.now() < deadline);
    if (result?.state !== "completed" || result.requestSha256 !== id || !Array.isArray(result.commands) || result.commands.length !== 8 || result.commands.some(command => command.exitCode !== 0)) throw new Error(`WORKER_DURABLE_JOB_FAILED:${JSON.stringify(result)}`);
    const denied = await requireDocker(["exec", jobName, "/usr/local/bin/napplet-cvm-bootstrap", "/bin/sh", "-ec", `test ! -r /run/napplet-cvm-jobs/${id}/result.json; test ! -w /run/napplet-cvm-jobs/${id}/result.json`]);
    if (denied.status !== 0) throw new Error("WORKER_JOB_RESULT_FORGEABLE");
    const replayed = await jobCommand("start", id, String(Math.ceil(bytes.length / 24_576)));
    const observedAgain = await jobCommand("status", id);
    if (replayed.jobId !== id || canonicalJson(observedAgain) !== canonicalJson(result)) throw new Error("WORKER_JOB_REDISPATCHED");
    jobs.push({ ...result, revision, resultAccess: "denied-to-generated-uid" });
  }
  report.durableJobs = jobs;

  const idleName = containers[1]!; const idleDeadline = Date.now() + 12_000;
  const idleArgv = ["/usr/local/bin/napplet-cvm-worker", "idle", "--provider-deadline-epoch-ms", String(idleDeadline)];
  await requireDocker(["run", "-d", "--name", idleName, ...resourceArgs, "--cap-add", "SYS_ADMIN", "--cap-add", "NET_ADMIN", "-e", `NAPPLET_CVM_POLICY_VERSION=${POLICY}`, image, "/usr/local/bin/napplet-cvm-bootstrap", ...idleArgv]);
  const stopAttempt = await requireDocker(["exec", idleName, "/usr/local/bin/napplet-cvm-bootstrap", "/bin/sh", "-ec", "if kill -STOP 1; then echo CVM_SIGSTOP_UNEXPECTED; exit 1; else test $? -eq 1; echo CVM_SIGSTOP_EPERM; fi"], 30_000);
  if (!stopAttempt.stdout.includes("CVM_SIGSTOP_EPERM") || !/Operation not permitted/iu.test(stopAttempt.stderr)) throw new Error("WORKER_SUPERVISOR_STOP_NOT_DENIED");
  const idleExit = await requireDocker(["wait", idleName], 30_000);
  if (idleExit.stdout.trim() !== "0") throw new Error(`WORKER_IDLE_EXIT:${idleExit.stdout.trim()}`);
  report.idleSupervisor = { argv: idleArgv, sigstop: "EPERM", exitCode: 0 };
  report.status = "passed";
} catch (error) {
  report.status = "failed"; report.error = error instanceof Error ? error.message : String(error);
} finally {
  report.finishedAt = new Date().toISOString();
  const logs = await Promise.all(containers.map(async (name) => [name, await containerLogs(name)] as const));
  report.containerLogs = Object.fromEntries(logs.map(([name, value]) => [name, { status: value.status, stdout: value.stdout, stderr: value.stderr }]));
  const cleanup: Array<{ name: string; absent: boolean }> = [];
  for (const name of containers) {
    await docker(["rm", "-f", name], 10_000).catch(() => undefined);
    const observed = await docker(["container", "inspect", name], 10_000).catch(() => undefined);
    cleanup.push({ name, absent: Boolean(observed && observed.status !== 0 && /No such (?:container|object)/iu.test(observed.stderr)) });
  }
  report.cleanup = cleanup;
  if (!cleanup.every((item) => item.absent)) { report.status = "failed"; report.cleanupError = "LOCAL_CONTAINER_ABSENCE_UNVERIFIED"; }
  await mkdir(dirname(reportPath), { recursive: true });
  await writeFile(logPath, logs.map(([name, value]) => `=== ${name} stdout ===\n${value.stdout}\n=== ${name} stderr ===\n${value.stderr}\n`).join(""), { mode: 0o600 });
  await writeFile(reportPath, `${JSON.stringify(report, null, 2)}\n`, { mode: 0o600 });
}

if (report.status !== "passed") {
  console.error(`production worker local mechanism validation failed; retained report: ${reportPath}`); process.exitCode = 1;
} else console.log(`production worker local mechanism validation passed; report: ${reportPath}`);
