#!/usr/bin/env bun
/**
 * No-effect local mechanism validation for the production-worker image.
 *
 * It deliberately uses Docker's ordinary default network. The readiness
 * command must prove that trusted bootstrap created a denied inner namespace;
 * this is local compatibility evidence, never provider evidence.
 */
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { dirname } from "node:path";
import { canonicalJson } from "../src/promotion/schema";
import { ProductionDirectArtifactVerifier } from "../src/production/direct-artifact-verifier";

const POLICY = "production-worker-policy-2026-10-27";
const MAX_OUTPUT = 512 * 1024;
const DEFAULT_TIMEOUT_MS = 30_000;
const direct = process.argv.includes("--direct-artifact");
const image = process.argv[2] ?? "napplet-cvm-production-worker:local";
const run = `${process.pid}-${crypto.randomUUID().replaceAll("-", "").slice(0, 12)}`;
const reportPath = process.env.NAPPLET_CVM_WORKER_REPORT ?? `/tmp/napplet-cvm-production-worker-${run}.json`;
const logPath = reportPath.replace(/\.json$/u, "") + ".log";
// Local compatibility test needs mount permission for trusted bootstrap.
// Docker's default AppArmor profile denies mounts even with CAP_SYS_ADMIN.
// This is deliberately not a production provider isolation certificate.
const resourceArgs = ["--cpus", "1", "--memory", "1024m", "--memory-swap", "1024m", "--security-opt", "apparmor=unconfined"];
const containers = [`napplet-cvm-production-worker-build-${run}`, `napplet-cvm-production-worker-idle-${run}`, `napplet-cvm-production-worker-ready-${run}`, `napplet-cvm-production-worker-jobs-${run}`, `napplet-cvm-production-worker-restore-${run}`, `napplet-cvm-production-worker-legacy-restore-${run}`, `napplet-cvm-production-worker-restore-recovery-${run}`];
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
  if (result.status !== 0) throw new Error(`HOST_DOCKER_FAILED:${JSON.stringify({ argv: argv.slice(0, 5), status: result.status, stdout: result.stdout.slice(0, 2_000), stderr: result.stderr.slice(0, 2_000) })}`);
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
  requireManifest(records.find(record => record.argv.includes("--dry-run"))!.stdout);
}

function requireManifest(stdout: string) {
  const value = JSON.parse(stdout);
  if (value.dryRun !== true || value.plan?.items?.length !== 1 || value.manifests?.length !== 1) throw new Error("WORKER_CLI_MANIFEST_MISSING");
  const manifest = value.manifests[0];
  if (direct) {
    if (manifest.format !== "current" || manifest.files?.length !== 1 || manifest.files[0]?.path !== "/index.html" || manifest.files[0]?.sha256 !== manifest.artifactHash || "aggregateHash" in manifest || canonicalJson(manifest.template?.tags.filter((tag: string[]) => tag[0] === "x")) !== canonicalJson([["x", manifest.artifactHash]])) throw new Error("WORKER_CLI_DIRECT_MANIFEST_INVALID");
    return manifest;
  }
  if (!Array.isArray(manifest.files) || !manifest.files.some((file: { path: string }) => file.path === "/index.html") || !/^[a-f0-9]{64}$/u.test(manifest.aggregateHash)) throw new Error("WORKER_CLI_MANIFEST_INVALID");
  const hash = new Bun.CryptoHasher("sha256").update(manifest.files.map((file: { path: string; sha256: string }) => `${file.sha256} ${file.path}\n`).sort().join("")).digest("hex");
  if (hash !== manifest.aggregateHash) throw new Error("WORKER_CLI_AGGREGATE_INVALID");
  return manifest;
}

function readinessArguments(deadline: number) {
  return ["/usr/local/bin/napplet-cvm-worker", "ready", "--session-lease-sha256", lease, "--provider-image", `registry.example/worker@sha256:${imageHash}`, "--toolchain-sha256", toolchain, "--provider-deadline-epoch-ms", String(deadline)];
}

const legacySourceJson = JSON.stringify({ files: [{ path: "src/main.ts", content: "import { runtimeHasDomain } from './domain-availability.js';\nimport \"./styles.css\";\nconst root = document.querySelector<HTMLElement>(\"#app\");\nif (!root) throw new Error(\"APP_ROOT_MISSING\");\nconst message = document.createElement(\"p\");\nmessage.textContent = runtimeHasDomain(\"storage\") ? \"Local production worker proof\" : \"Local proof fallback\";\nroot.replaceChildren(message);\n" + "/*" + "x".repeat(27_000) + "*/" }] });
const directFiles = direct ? await Promise.all(["main.ts", "styles.css", "capabilities.json"].map(async name => ({ path: `src/${name}`, content: await Bun.file(`tests/fixtures/direct-worker-notes/${name}${name === "main.ts" ? ".txt" : ""}`).text() + (name === "main.ts" ? "\n/*" + "x".repeat(26_000) + "*/" : "") }))) : [];
const sourceJson = direct ? JSON.stringify({ files: directFiles }) : legacySourceJson;
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
  localMechanism: true, artifactContract: direct ? "nip5d-direct-v1" : "legacy-aggregate-v1", realProviderEvidence: false, requestedImage: image,
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

  if (!direct) {
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

  } else report.buildSource = { contract: "legacy-only; new profile uses the durable job entrypoint" };

  const jobName = containers[3]!;
  await requireDocker(["run", "-d", "--name", jobName, ...resourceArgs, "--cap-add", "SYS_ADMIN", "--cap-add", "NET_ADMIN", "-e", `NAPPLET_CVM_POLICY_VERSION=${POLICY}`, image, "/usr/local/bin/napplet-cvm-worker", "idle", "--provider-deadline-epoch-ms", String(Date.now() + 1_200_000)]);
  const jobCommand = async (...args: string[]) => lastJson((await requireDocker(["exec", jobName, "/usr/local/bin/napplet-cvm-bootstrap", "/usr/local/bin/napplet-cvm-job", ...args])).stdout);
  // Queries re-enter trusted bootstrap while untrusted build processes keep
  // reading the same mount. Fixed metadata must not transiently revoke access.
  const readProbe = `const fs=require("node:fs");const path="/workspace/bootstrap-read-probe.txt";fs.writeFileSync(path,"immutable readability");const end=Date.now()+8000;let reads=0;const errors={};while(Date.now()<end){try{if(fs.readFileSync(path,"utf8")!=="immutable readability")throw Error("content changed");reads++}catch(e){errors[e.code||e.message]=(errors[e.code||e.message]||0)+1}}console.log(JSON.stringify({reads,errors,uid:process.getuid()}))`;
  const [concurrentRead] = await Promise.all([
    requireDocker(["exec", jobName, "/usr/local/bin/napplet-cvm-bootstrap", "/usr/local/bin/node", "-e", readProbe], 20_000),
    (async () => { for (let query = 0; query < 64; query++) await jobCommand("status", "a".repeat(64)); })(),
  ]);
  const readability = lastJson(concurrentRead.stdout);
  report.concurrentBootstrapReadability = { ...readability, statusQueries: 64 };
  if (readability.uid !== 65532 || typeof readability.reads !== "number" || readability.reads < 1 || !readability.errors || typeof readability.errors !== "object" || Object.keys(readability.errors).length !== 0) throw new Error("WORKER_CONCURRENT_BOOTSTRAP_READABILITY_FAILED");
  if (direct) {
    const refused = await docker(["exec", jobName, "/usr/local/bin/napplet-cvm-bootstrap", "/usr/local/bin/napplet-cvm-worker", "build-source"]);
    if (refused.status === 0 || !refused.stderr.includes("WORKER_ASYNC_DIRECT_JOB_REQUIRED")) throw new Error("WORKER_LEGACY_ENTRYPOINT_NOT_REFUSED");
    report.legacyEntrypointRefusal = "WORKER_ASYNC_DIRECT_JOB_REQUIRED";
  }
  const wrongSource = direct
    ? { version: 1, sessionId: "local-wrong-profile", actionId: "wrong", expectedVersion: 0, proposalSha256: lease, toolchainSha256: toolchain, deadlineEpochMs: Date.now() + 600_000, files: directFiles }
    : { version: 2, artifactContract: "nip5d-direct-v1", purpose: "Wrong image profile refusal", publication: { server: "https://publication.example" }, sessionId: "local-wrong-profile", actionId: "wrong", expectedVersion: 0, proposalSha256: lease, toolchainSha256: toolchain, deadlineEpochMs: Date.now() + 600_000, files: [...JSON.parse(sourceJson).files, { path: "src/capabilities.json", content: '{"required":[],"optional":[]}' }] };
  const wrongBytes = Buffer.from(canonicalJson(wrongSource)), wrongId = new Bun.CryptoHasher("sha256").update(wrongBytes).digest("hex");
  for (let offset = 0, index = 0; offset < wrongBytes.length; offset += 24_576, index++) await jobCommand("put", wrongId, String(index), wrongBytes.subarray(offset, offset + 24_576).toString("base64"));
  const wrongStart = await docker(["exec", jobName, "/usr/local/bin/napplet-cvm-bootstrap", "/usr/local/bin/napplet-cvm-job", "start", wrongId, String(Math.ceil(wrongBytes.length / 24_576))]);
  if (wrongStart.status === 0 || !wrongStart.stderr.includes("JOB_IMAGE_CONTRACT_MISMATCH") || (await jobCommand("status", wrongId)).state !== "missing") throw new Error("WORKER_MIXED_PROFILE_DISPATCHED");
  report.wrongProfileRefusedBeforeClaim = true;
  const jobs: unknown[] = [];
  let checkpointWorkspace: Buffer | undefined, lastJobId = "";
  const jobManifests: unknown[] = [];
  for (let revision = 1; revision <= 2; revision++) {
    const body = canonicalJson({ ...(direct ? { version: 2, artifactContract: "nip5d-direct-v1", purpose: `Keep one short note, revision ${revision}` } : { version: 1 }), sessionId: "local-job-proof", actionId: `revision-${revision}`, expectedVersion: revision - 1, proposalSha256: lease, toolchainSha256: toolchain, deadlineEpochMs: Date.now() + 600_000, files: [...JSON.parse(sourceJson).files, ...(!direct && revision === 2 ? [{ path: "src/capabilities.json", content: '{"required":[],"optional":[]}' }] : [])], ...(direct || revision === 2 ? { publication: { server: "https://publication.example" } } : {}) });
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
    {
      const parts: Buffer[] = [];
      for (let offset = 0; offset < Number(result.artifactBytes); offset += 24_576) {
        const part = await jobCommand("artifact", id, String(offset)); parts.push(Buffer.from(String(part.bytesBase64), "base64"));
      }
      const artifactBytes = Buffer.concat(parts);
      if (new Bun.CryptoHasher("sha256").update(artifactBytes).digest("hex") !== result.artifactSha256) throw new Error("WORKER_ARTIFACT_EXPORT_INVALID");
      const artifact = JSON.parse(artifactBytes.toString("utf8"));
      if (artifact.version !== (direct ? 3 : 2) || artifact.capabilityReceipt?.path !== "src/capabilities.json" || artifact.capabilityReceipt.state !== (!direct && revision === 1 ? "absent" : "present")) throw new Error("WORKER_CAPABILITY_RECEIPT_MISSING");
      if (direct || revision === 2) {
        const bytes = Buffer.from(artifact.capabilityReceipt.bytesBase64, "base64");
        if (bytes.toString("utf8") !== (direct ? directFiles.find(file => file.path === "src/capabilities.json")!.content : '{"required":[],"optional":[]}') || new Bun.CryptoHasher("sha256").update(bytes).digest("hex") !== artifact.capabilityReceipt.sha256) throw new Error("WORKER_CAPABILITY_RECEIPT_INVALID");
      }
      if (direct) {
        const root = await mkdtemp("/tmp/napplet-cvm-direct-job-proof-");
        try {
          for (const file of artifact.files) { if (file.path !== "index.html") throw new Error("WORKER_DIRECT_EXTRA_DEPLOYABLE_FILE"); await writeFile(`${root}/${file.path}`, Buffer.from(file.bytesBase64, "base64")); }
          const verified = await new ProductionDirectArtifactVerifier().verify({ ownerId: "f".repeat(64), accountId: "local-job-proof", sessionId: "local-job-proof", actionId: `revision-${revision}`, expectedVersion: revision - 1, proposalSha256: lease, toolchainSha256: toolchain, distRoot: root, artifactContract: artifact.artifactContract, publication: { server: "https://publication.example" }, capabilityReceipt: artifact.capabilityReceipt, conformanceReceipt: artifact.conformanceReceipt, manifestReceipt: artifact.manifestReceipt, commandEvidence: artifact.commandEvidence.map((entry: { exitCode: number; stdout: string; stderr: string }, index: number) => ({ name: ["create", "init", "skills", "install", "build", "verify", "conformance", "dry-run"][index], exitCode: entry.exitCode, stdout: entry.stdout, stderr: entry.stderr })) });
          jobs.push({ revision, directVerification: { artifactHash: verified.artifactHash, evidenceSha256: verified.verificationEvidenceSha256, declaration: verified.declaration } });
          if (verified.manifest.content !== `Keep one short note, revision ${revision}`) throw new Error("WORKER_DIRECT_PURPOSE_MISMATCH");
        } finally { await rm(root, { recursive: true, force: true }); }
      }
      const manifest = requireManifest(artifact.commandEvidence[7].stdout);
      const named = JSON.parse(artifact.commandEvidence[7].stdout).plan.items[0];
      if (named.kind !== 35129 || named.target !== "named" || named.dTag !== `cvm-${id.slice(0, 24)}` || manifest.template?.kind !== 35129 || manifest.template.tags.filter((tag: string[]) => tag[0] === "d").length !== 1 || !manifest.template.tags.some((tag: string[]) => tag.length === 2 && tag[0] === "d" && tag[1] === named.dTag)) throw new Error("WORKER_CLI_NAMED_TARGET_REQUIRED");
      const serverTags = manifest.template.tags.filter((tag: string[]) => tag[0] === "server");
      const cliServers = JSON.parse(artifact.commandEvidence[7].stdout).blossomServers;
      if (revision === 2 && (canonicalJson(serverTags) !== canonicalJson([["server", "https://publication.example"]]) || canonicalJson(cliServers) !== canonicalJson(["https://publication.example"]))) throw new Error("WORKER_CLI_APPROVED_SERVER_REQUIRED");
      jobManifests.push(manifest);
      if (manifest.files.length !== artifact.files.length || manifest.files.some((file: { path: string; sha256: string }) => !artifact.files.some((actual: { path: string; sha256: string }) => `/${actual.path}` === file.path && actual.sha256 === file.sha256))) throw new Error("WORKER_CLI_FILE_BINDING_INVALID");
      checkpointWorkspace = Buffer.from(canonicalJson({ version: 1, source: JSON.parse(body), artifact: JSON.parse(artifactBytes.toString("utf8")), toolchainSha256: toolchain })); lastJobId = id;
    }
  }
  report.durableJobs = jobs; report.durableJobManifests = jobManifests;
  const fence = await jobCommand("fence", lastJobId, lease);
  const fenceAgain = await jobCommand("fence-status", lastJobId, lease);
  if (fence.state !== "fenced" || canonicalJson(fence) !== canonicalJson(fenceAgain)) throw new Error("WORKER_FENCE_FAILED");
  const blockedBody = canonicalJson({ ...JSON.parse(checkpointWorkspace!.toString("utf8")).source, actionId: "forbidden-after-fence" });
  const blockedId = new Bun.CryptoHasher("sha256").update(blockedBody).digest("hex");
  const blockedBytes = Buffer.from(blockedBody);
  for (let offset = 0, index = 0; offset < blockedBytes.length; offset += 24_576, index++) await jobCommand("put", blockedId, String(index), blockedBytes.subarray(offset, offset + 24_576).toString("base64"));
  const blocked = await docker(["exec", jobName, "/usr/local/bin/napplet-cvm-bootstrap", "/usr/local/bin/napplet-cvm-job", "start", blockedId, String(Math.ceil(blockedBytes.length / 24_576))]);
  if (blocked.status === 0 || !blocked.stderr.includes("JOB_LEASE_FENCED")) throw new Error("WORKER_FENCE_NOT_ENFORCED");
  const freshName = containers[4]!;
  await requireDocker(["run", "-d", "--name", freshName, ...resourceArgs, "--cap-add", "SYS_ADMIN", "--cap-add", "NET_ADMIN", "-e", `NAPPLET_CVM_POLICY_VERSION=${POLICY}`, image, "/usr/local/bin/napplet-cvm-worker", "idle", "--provider-deadline-epoch-ms", String(Date.now() + 1_200_000)]);
  const restoreCommand = async (...args: string[]) => lastJson((await requireDocker(["exec", freshName, "/usr/local/bin/napplet-cvm-bootstrap", "/usr/local/bin/napplet-cvm-job", ...args])).stdout);
  const archive = checkpointWorkspace!, archiveSha256 = new Bun.CryptoHasher("sha256").update(archive).digest("hex");
  if (archive.length <= 24_576 || Buffer.byteLength(sourceJson) <= 24_576) throw new Error("WORKER_MULTICHUNK_PROOF_MISSING");
  for (let offset = 0, index = 0; offset < archive.length; offset += 24_576, index++) await restoreCommand("restore-put", archiveSha256, String(index), archive.subarray(offset, offset + 24_576).toString("base64"));
  const restored = await restoreCommand("restore", archiveSha256, String(Math.ceil(archive.length / 24_576)));
  const restoredAgain = await restoreCommand("restore-status", archiveSha256);
  if (restored.state !== "restored" || restored.archiveSha256 !== archiveSha256 || restored.toolchainSha256 !== toolchain || canonicalJson(restored) !== canonicalJson(restoredAgain)) throw new Error("WORKER_FRESH_RESTORE_FAILED");
  await requireDocker(["exec", freshName, "/usr/local/bin/napplet-cvm-bootstrap", "/bin/sh", "-ec", "test -r /workspace/restored/src/main.ts; test -r /workspace/restored/dist/index.html; test ! -w /workspace/restored/src/main.ts; test ! -r /run/napplet-cvm-jobs/restoring"]);
  const originalAbsent = await restoreCommand("status", lastJobId);
  if (originalAbsent.state !== "missing") throw new Error("WORKER_RESTORE_DISPATCHED_BUILD");
  // A FIFO makes the actual root supervisor block after its immutable claim.
  // The test harness alone is allowed to replace and restore this known part.
  const recoveryName = containers[6]!;
  await requireDocker(["run", "-d", "--name", recoveryName, ...resourceArgs, "--cap-add", "SYS_ADMIN", "--cap-add", "NET_ADMIN", "-e", `NAPPLET_CVM_POLICY_VERSION=${POLICY}`, image, "/usr/local/bin/napplet-cvm-worker", "idle", "--provider-deadline-epoch-ms", String(Date.now() + 1_200_000)]);
  const recoveryCommand = async (...args: string[]) => lastJson((await requireDocker(["exec", recoveryName, "/usr/local/bin/napplet-cvm-bootstrap", "/usr/local/bin/napplet-cvm-job", ...args])).stdout);
  const recoveryWorkspace = JSON.parse(archive.toString("utf8"));
  const recoveryPlan = { version: 1, operationId: "priced-restore:local-recovery", archiveSha256, chunks: Math.ceil(archive.length / 24_576), bindingSha256: "d".repeat(64), workerOperationId: "local-recovery-worker", workerResourceId: "local-recovery-resource", leaseSha256: lease,
    expected: { archiveSha256, toolchainSha256: toolchain, sourceSha256: new Bun.CryptoHasher("sha256").update(canonicalJson(recoveryWorkspace.source.files)).digest("hex"), artifactFilesSha256: new Bun.CryptoHasher("sha256").update(canonicalJson(recoveryWorkspace.artifact.files)).digest("hex") } };
  if ((await recoveryCommand("restore-plan", archiveSha256, Buffer.from(canonicalJson(recoveryPlan)).toString("base64"))).state !== "planned") throw new Error("WORKER_RECOVERY_PLAN_FAILED");
  for (let offset = 0, index = 0; offset < archive.length; offset += 24_576, index++) await recoveryCommand("restore-put", archiveSha256, String(index), archive.subarray(offset, offset + 24_576).toString("base64"));
  const partPath = `/run/napplet-cvm-jobs/restore-${archiveSha256}/part-0`, originalPart = archive.subarray(0, 24_576).toString("base64");
  await requireDocker(["exec", recoveryName, "/bin/sh", "-ec", `rm -f ${partPath}; mkfifo ${partPath}; chmod 600 ${partPath}`]);
  const nativeRestore = Bun.spawn(["docker", "exec", recoveryName, "/usr/local/bin/napplet-cvm-bootstrap", "/usr/local/bin/napplet-cvm-job", "restore", archiveSha256, String(recoveryPlan.chunks)], { stdout: "pipe", stderr: "pipe" });
  const claimDeadline = Date.now() + 10_000;
  for (;;) {
    if ((await docker(["exec", recoveryName, "/bin/sh", "-ec", `test -f /run/napplet-cvm-jobs/restore-${archiveSha256}/claimed`])).status === 0) break;
    if (Date.now() >= claimDeadline) throw new Error("WORKER_RECOVERY_CLAIM_NOT_REACHED");
    await Bun.sleep(50);
  }
  const claimedPid = (await requireDocker(["exec", recoveryName, "/usr/local/bin/bun", "-e", `const value=JSON.parse(await Bun.file('/run/napplet-cvm-jobs/restore-${archiveSha256}/claimed').text()); if(value.archiveSha256!=='${archiveSha256}'||!Number.isSafeInteger(value.supervisorPid)||value.supervisorPid<1)process.exit(1); console.log(value.supervisorPid)`])).stdout.trim();
  const killed = await requireDocker(["exec", recoveryName, "/bin/sh", "-ec", `kill -KILL '${claimedPid}'; echo '${claimedPid}'`]);
  await Bun.sleep(100);
  if ((await docker(["exec", recoveryName, "/bin/sh", "-ec", `kill -0 '${claimedPid}'`])).status === 0 || !killed.stdout.trim()) throw new Error("WORKER_RECOVERY_SUPERVISOR_KILL_FAILED");
  nativeRestore.kill();
  const nativeExit = await Promise.race([nativeRestore.exited, Bun.sleep(2_000).then(() => -1)]);
  await requireDocker(["exec", recoveryName, "/bin/sh", "-ec", `rm -f ${partPath}; printf '%s' '${originalPart}' | /usr/bin/base64 -d > ${partPath}; chmod 600 ${partPath}`]);
  const [repairOne, repairTwo] = await Promise.all([docker(["exec", recoveryName, "/usr/local/bin/napplet-cvm-bootstrap", "/usr/local/bin/napplet-cvm-job", "restore-repair", archiveSha256], 30_000), docker(["exec", recoveryName, "/usr/local/bin/napplet-cvm-bootstrap", "/usr/local/bin/napplet-cvm-job", "restore-repair", archiveSha256], 30_000)]);
  const repairResults = [repairOne, repairTwo].filter(result => result.status === 0).map(result => lastJson(result.stdout)), recoveryStatus = await recoveryCommand("restore-status", archiveSha256);
  if (!repairResults.length || repairResults.some(result => result.state !== "restored" || canonicalJson(result) !== canonicalJson(recoveryStatus))) throw new Error("WORKER_RECOVERY_REPAIR_FAILED");
  report.nativeRestoreRecovery = { killedSupervisor: true, nativeExit, exactSupervisorPid: killed.stdout.trim(), concurrentRepairs: [repairOne.status, repairTwo.status], repaired: repairResults.length, status: recoveryStatus };
  if (!direct) {
  // Real new-job bytes projected into the historical format exercise reader
  // compatibility. This is not an observation from an old provider/image.
  const legacyWorkspace = JSON.parse(archive.toString("utf8")); legacyWorkspace.artifact.version = 1; delete legacyWorkspace.artifact.capabilityReceipt;
  const legacyArchive = Buffer.from(canonicalJson(legacyWorkspace)), legacySha = new Bun.CryptoHasher("sha256").update(legacyArchive).digest("hex"), legacyName = containers[5]!;
  await requireDocker(["run", "-d", "--name", legacyName, ...resourceArgs, "--cap-add", "SYS_ADMIN", "--cap-add", "NET_ADMIN", "-e", `NAPPLET_CVM_POLICY_VERSION=${POLICY}`, image, "/usr/local/bin/napplet-cvm-worker", "idle", "--provider-deadline-epoch-ms", String(Date.now() + 1_200_000)]);
  const legacyCommand = async (...args: string[]) => lastJson((await requireDocker(["exec", legacyName, "/usr/local/bin/napplet-cvm-bootstrap", "/usr/local/bin/napplet-cvm-job", ...args])).stdout);
  for (let offset = 0, index = 0; offset < legacyArchive.length; offset += 24_576, index++) await legacyCommand("restore-put", legacySha, String(index), legacyArchive.subarray(offset, offset + 24_576).toString("base64"));
  const legacyRestored = await legacyCommand("restore", legacySha, String(Math.ceil(legacyArchive.length / 24_576)));
  if (legacyRestored.state !== "restored" || canonicalJson(legacyRestored) !== canonicalJson(await legacyCommand("restore-status", legacySha))) throw new Error("WORKER_LEGACY_RESTORE_FAILED");
  report.capabilityReceipts = { first: "absent", second: "present", newArchiveVersion: 2, legacyFormatProjectionRestored: legacyRestored };
  } else report.capabilityReceipts = { first: "present", second: "present", newArchiveVersion: 3, historicalProjections: "legacy profile retains its separate unchanged checks" };
  report.checkpoint = { fence, deniedNewStart: true, restored, repeatedObservationStable: true, originalJobAbsent: true, restoreChunks: Math.ceil(archive.length / 24_576), sourceBytes: Buffer.byteLength(sourceJson), freshContainer: freshName };

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
