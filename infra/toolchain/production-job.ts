#!/usr/bin/env bun
/** Immutable privileged supervisor. Generated commands always run in a fresh
 * PID/network namespace as UID 65532. Only this supervisor can write results. */
import { spawn } from "node:child_process";
import { constants } from "node:fs";
import { chmod, chown, lstat, mkdir, open, readFile, readdir, rename, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";

const ROOT = "/run/napplet-cvm-jobs";
const BOOTSTRAP = "/usr/local/bin/napplet-cvm-bootstrap";
const SCRIPT = "/usr/local/bin/napplet-cvm-job";
const POLICY = "production-worker-policy-2026-10-27";
const MAX_REQUEST = 131_072, CHUNK = 24_576, MAX_ARTIFACT = 16_777_216;
const MAX_RESTORE = 25_165_824;
const env = { PATH: "/usr/local/bin:/usr/bin:/bin", NAPPLET_CVM_POLICY_VERSION: POLICY };
const sha = (value: string | Uint8Array) => new Bun.CryptoHasher("sha256").update(value).digest("hex");
const fail = (code: string): never => { throw new Error(code); };
const canonical = (value: unknown): string => value === null || typeof value !== "object" ? JSON.stringify(value) : Array.isArray(value) ? `[${value.map(canonical).join(",")}]` : `{${Object.entries(value).sort(([a], [b]) => a < b ? -1 : a > b ? 1 : 0).map(([key, item]) => `${JSON.stringify(key)}:${canonical(item)}`).join(",")}}`;
type CommandResult = Awaited<ReturnType<typeof command>>;
const sanitizedTail = (value: string) => value.slice(-4096).replace(/\b(authorization|token|secret|password|api[_-]?key)\s*[:=]\s*[^\s]+/giu, "$1=[redacted]");
function commandDiagnostic(command: CommandResult, commandIndex: number) {
  return Object.freeze({ commandIndex, argv: command.argv, exitCode: command.exitCode, stdoutSha256: sha(command.stdout), stderrSha256: sha(command.stderr), stdoutTail: sanitizedTail(command.stdout), stderrTail: sanitizedTail(command.stderr) });
}
class ReproductionCommandFailure extends Error {
  constructor(readonly diagnostic: ReturnType<typeof commandDiagnostic>) { super("JOB_REPRODUCTION_COMMAND_FAILED"); }
}
// Fixed immutable image paths, measured by this privileged supervisor before
// generated commands and checked again afterward. No project-supplied receipt.
const DIRECT_CLI_PINS: Record<string, string> = {
  "linux-x64": "5fbc61d2a4be189094726c7b7d7f073a00c122d93cedfa3bd37b7571fb430d08",
  "linux-arm64": "2a78a97ae95f493a0c568366ede5a53ce99808fa2fe487572952b7f4f9770a26",
};
const DIRECT_FILE_PINS = {
  workerPackageSha256: "ca0d5a088c7650407306899eaaaa535b2bd872d746d7aee10be471894944abbf",
  workerLockSha256: "f0ac025b6f79609a159702adedfbfebd8966b1c65f78cf1e0f75912ae54a567d",
  templatePackageSha256: "81f03e8b76b15cbc025b11a67117389b579ee1ca374ddb680971f91e7293a99f",
  templateLockSha256: "ec1eb261c06641decda0c8fbd3a96e5f121cddfcc6abdc8888f78556390e28e4",
};
function validateToolchainReceipt(value: unknown): void {
  if (!value || typeof value !== "object" || Array.isArray(value)) return fail("JOB_TOOLCHAIN_RECEIPT_INVALID");
  const record: Record<string, unknown> = Object.fromEntries(Object.entries(value));
  if (Object.keys(record).sort().join(",") !== "artifactContract,cliBinarySha256,platform,templateLockSha256,templatePackageSha256,version,workerLockSha256,workerPackageSha256"
    || record.version !== 1 || record.artifactContract !== "nip5d-direct-v1" || typeof record.platform !== "string"
    || !Object.hasOwn(DIRECT_CLI_PINS, record.platform) || record.cliBinarySha256 !== DIRECT_CLI_PINS[record.platform]
    || Object.entries(DIRECT_FILE_PINS).some(([key, expected]) => record[key] !== expected)) fail("JOB_TOOLCHAIN_RECEIPT_INVALID");
}
async function immutableImageFileHash(path: string) {
  const handle = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW);
  try {
    const before = await handle.stat();
    if (!before.isFile() || before.size < 1 || before.size > 268_435_456) fail("JOB_TOOLCHAIN_FILE_INVALID");
    const hasher = new Bun.CryptoHasher("sha256"), buffer = Buffer.alloc(262_144); let total = 0;
    for (;;) {
      const part = await handle.read(buffer, 0, buffer.length, total); if (!part.bytesRead) break;
      total += part.bytesRead; if (total > before.size) fail("JOB_TOOLCHAIN_FILE_CHANGED");
      hasher.update(buffer.subarray(0, part.bytesRead));
    }
    const after = await handle.stat();
    if (total !== before.size || after.size !== before.size || after.ino !== before.ino || after.mtimeMs !== before.mtimeMs || after.ctimeMs !== before.ctimeMs) fail("JOB_TOOLCHAIN_FILE_CHANGED");
    return hasher.digest("hex");
  } finally { await handle.close(); }
}
async function measureDirectToolchain() {
  const [cliBinarySha256, workerPackageSha256, workerLockSha256, templatePackageSha256, templateLockSha256] = await Promise.all([
    "/toolchain/bin/napplet", "/toolchain/package.json", "/toolchain/pnpm-lock.yaml", "/toolchain/boilerplate-template/package.json", "/toolchain/boilerplate-template/pnpm-lock.yaml",
  ].map(immutableImageFileHash));
  const receipt = { version: 1, artifactContract: "nip5d-direct-v1", platform: `${process.platform}-${process.arch}`, cliBinarySha256,
    workerPackageSha256, workerLockSha256, templatePackageSha256, templateLockSha256 };
  validateToolchainReceipt(receipt); return receipt;
}
type RequestCore = { actionId: string; sessionId: string; expectedVersion: number; proposalSha256: string; toolchainSha256: string; deadlineEpochMs: number; files: Array<{ path: string; content: string }> };
type LegacyRequest = RequestCore & { version: 1; publication?: { server: string } };
type DirectRequest = RequestCore & { version: 2; artifactContract: "nip5d-direct-v1"; purpose: string; publication: { server: string } };
type EdgeCertification = { version: 1; candidateSha256: string; topologySha256: string; workerOperationId: string; sessionLeaseSha256: string; providerImage: string; workerProfileSha256: string };
type EdgeRequest = RequestCore & { version: 3; edgeCertification: EdgeCertification; publication?: { server: string } };
type Request = LegacyRequest | DirectRequest | EdgeRequest;
function isObject(value: unknown): value is object { return typeof value === "object" && value !== null; }
function objectRecord(value: unknown, code: string): Record<string, unknown> {
  if (!isObject(value) || Array.isArray(value)) return fail(code);
  const output: Record<string, unknown> = {};
  for (const key of Object.keys(value)) output[key] = Reflect.get(value, key);
  return output;
}
function stringField(value: Record<string, unknown>, key: string, code: string): string {
  const result = value[key]; if (typeof result === "string") return result; return fail(code);
}
function numberField(value: Record<string, unknown>, key: string, code: string): number {
  const result = value[key]; if (typeof result === "number") return result; return fail(code);
}
function publication(value: Record<string, unknown>): { server: string } | undefined {
  if (value.publication === undefined) return undefined;
  const raw = objectRecord(value.publication, "JOB_PUBLICATION_INVALID");
  if (Object.keys(raw).join(",") !== "server") fail("JOB_PUBLICATION_INVALID");
  const server = stringField(raw, "server", "JOB_PUBLICATION_INVALID");
  if (server.length > 512) fail("JOB_PUBLICATION_INVALID");
  const url = new URL(server);
  if (url.protocol !== "https:" || url.username || url.password || url.search || url.hash || url.pathname !== "/" || url.origin !== server) fail("JOB_PUBLICATION_INVALID");
  return { server };
}
function parseRequest(value: unknown): Request {
  const raw = objectRecord(value, "JOB_REQUEST_INVALID"), version = raw.version;
  if (version !== 1 && version !== 2 && version !== 3) fail("JOB_REQUEST_INVALID");
  const expectedKeys = version === 2 ? "actionId,artifactContract,deadlineEpochMs,expectedVersion,files,proposalSha256,publication,purpose,sessionId,toolchainSha256,version" : version === 3 ? (raw.publication === undefined ? "actionId,deadlineEpochMs,edgeCertification,expectedVersion,files,proposalSha256,sessionId,toolchainSha256,version" : "actionId,deadlineEpochMs,edgeCertification,expectedVersion,files,proposalSha256,publication,sessionId,toolchainSha256,version") : raw.publication === undefined ? "actionId,deadlineEpochMs,expectedVersion,files,proposalSha256,sessionId,toolchainSha256,version" : "actionId,deadlineEpochMs,expectedVersion,files,proposalSha256,publication,sessionId,toolchainSha256,version";
  if (Object.keys(raw).sort().join(",") !== expectedKeys) fail("JOB_REQUEST_INVALID");
  const actionId = stringField(raw, "actionId", "JOB_REQUEST_INVALID"), sessionId = stringField(raw, "sessionId", "JOB_REQUEST_INVALID"), proposalSha256 = stringField(raw, "proposalSha256", "JOB_REQUEST_INVALID"), toolchainSha256 = stringField(raw, "toolchainSha256", "JOB_REQUEST_INVALID");
  const expectedVersion = numberField(raw, "expectedVersion", "JOB_REQUEST_INVALID"), deadlineEpochMs = numberField(raw, "deadlineEpochMs", "JOB_REQUEST_INVALID");
  if (![actionId, sessionId].every(id => id.length > 0 && id.length <= 256) || ![proposalSha256, toolchainSha256].every(item => /^[a-f0-9]{64}$/u.test(item)) || !Number.isSafeInteger(expectedVersion) || expectedVersion < 0 || !Number.isSafeInteger(deadlineEpochMs)) fail("JOB_REQUEST_INVALID");
  const sourceFiles = raw.files;
  if (!Array.isArray(sourceFiles) || sourceFiles.length < 1 || sourceFiles.length > 3) return fail("JOB_REQUEST_INVALID");
  const allowed = new Set(["src/main.ts", "src/styles.css", "src/capabilities.json"]);
  const files = sourceFiles.map(value => { const file = objectRecord(value, "JOB_SOURCE_INVALID"), path = stringField(file, "path", "JOB_SOURCE_INVALID"), content = stringField(file, "content", "JOB_SOURCE_INVALID"); if (Object.keys(file).sort().join(",") !== "content,path" || !allowed.has(path) || Buffer.byteLength(content) > 30_000) fail("JOB_SOURCE_INVALID"); return { path, content }; });
  if (new Set(files.map(file => file.path)).size !== files.length || !files.some(file => file.path === "src/main.ts")) fail("JOB_SOURCE_INVALID");
  const common: RequestCore = { actionId, sessionId, expectedVersion, proposalSha256, toolchainSha256, deadlineEpochMs, files };
  const mountedPublication = publication(raw);
  if (version === 2) {
    if (raw.artifactContract !== "nip5d-direct-v1" || mountedPublication === undefined) return fail("JOB_DIRECT_METADATA_INVALID");
    const purpose = stringField(raw, "purpose", "JOB_DIRECT_METADATA_INVALID");
    if (!purpose.trim() || purpose !== purpose.trim() || purpose.length > 4096) fail("JOB_DIRECT_METADATA_INVALID");
    const content = files.find(file => file.path === "src/capabilities.json")?.content ?? fail("JOB_DIRECT_DECLARATION_REQUIRED");
    const declaration = JSON.parse(content);
    if (!declaration || Object.keys(declaration).sort().join(",") !== "optional,required" || ![declaration.required, declaration.optional].every(list => Array.isArray(list) && list.length <= 32 && list.every((domain: unknown) => typeof domain === "string" && /^[a-z][a-z0-9-]{0,31}$/u.test(domain)))) fail("JOB_DIRECT_DECLARATION_INVALID");
    const domains = [...declaration.required, ...declaration.optional];
    if (new Set(domains).size !== domains.length) fail("JOB_DIRECT_DECLARATION_INVALID");
    return { version: 2, ...common, artifactContract: "nip5d-direct-v1", purpose, publication: mountedPublication };
  }
  if (version === 3) {
    const edgeRaw = objectRecord(raw.edgeCertification, "JOB_EDGE_CERTIFICATION_INVALID");
    const edge: EdgeCertification = { version: edgeRaw.version === 1 ? 1 : fail("JOB_EDGE_CERTIFICATION_INVALID"), candidateSha256: stringField(edgeRaw, "candidateSha256", "JOB_EDGE_CERTIFICATION_INVALID"), topologySha256: stringField(edgeRaw, "topologySha256", "JOB_EDGE_CERTIFICATION_INVALID"), workerOperationId: stringField(edgeRaw, "workerOperationId", "JOB_EDGE_CERTIFICATION_INVALID"), sessionLeaseSha256: stringField(edgeRaw, "sessionLeaseSha256", "JOB_EDGE_CERTIFICATION_INVALID"), providerImage: stringField(edgeRaw, "providerImage", "JOB_EDGE_CERTIFICATION_INVALID"), workerProfileSha256: stringField(edgeRaw, "workerProfileSha256", "JOB_EDGE_CERTIFICATION_INVALID") };
    if (Object.keys(edgeRaw).sort().join(",") !== "candidateSha256,providerImage,sessionLeaseSha256,topologySha256,version,workerOperationId,workerProfileSha256" || edge.version !== 1
      || ![edge.candidateSha256, edge.topologySha256, edge.sessionLeaseSha256, edge.workerProfileSha256].every(item => typeof item === "string" && /^[a-f0-9]{64}$/u.test(item))
      || typeof edge.workerOperationId !== "string" || !/^capacity-[a-f0-9]{40}$/u.test(edge.workerOperationId)
      || typeof edge.providerImage !== "string" || !/^.+@sha256:[a-f0-9]{64}$/iu.test(edge.providerImage)) fail("JOB_EDGE_CERTIFICATION_INVALID");
    return { version: 3, ...common, edgeCertification: edge, ...(mountedPublication === undefined ? {} : { publication: mountedPublication }) };
  }
  return { version: 1, ...common, ...(mountedPublication === undefined ? {} : { publication: mountedPublication }) };
}
/** The immutable image selects its ABI; request data cannot upgrade it. */
async function assertImageContract(request: Request) {
  const path = "/toolchain/production-artifact-contract";
  const info = await lstat(path).catch(error => { if (error.code === "ENOENT") return undefined; throw error; });
  if (info && (!info.isFile() || info.isSymbolicLink() || info.uid !== 0 || info.nlink !== 1 || (info.mode & 0o022) !== 0 || info.size > 64)) fail("JOB_IMAGE_CONTRACT_INVALID");
  const contract = info ? (await readFile(path, "utf8")).trim() : "legacy-aggregate-v1";
  const expected = request.version === 1 ? "legacy-aggregate-v1" : request.version === 2 ? "nip5d-direct-v1" : "edge-native-v3-unpromoted";
  if (contract !== expected) fail("JOB_IMAGE_CONTRACT_MISMATCH");
  if (request.version !== 3) return;
  const selector = objectRecord(JSON.parse(await readFile("/toolchain/edge-worker-current.json", "utf8")), "JOB_EDGE_PROFILE_INVALID");
  const profile = objectRecord(JSON.parse(await readFile("/toolchain/edge-worker-profile-v3.json", "utf8")), "JOB_EDGE_PROFILE_INVALID");
  if (selector.version !== 1 || selector.status !== "unpromoted" || selector.profile !== "toolchains/recipes/capabilities-worker-profile-v3-unpromoted.json" || selector.sourceVersion !== 3 || typeof selector.profileSha256 !== "string" || !/^[a-f0-9]{64}$/u.test(selector.profileSha256)
    || profile.sourceVersion !== 3 || profile.status !== "prepared-profile-not-promoted" || profile.artifactContract !== "nip5d-direct-v1" || profile.workerContract !== "edge-native-v3-unpromoted" || profile.workerImageTarget !== "edge-production-worker" || selector.profileSha256 !== sha(canonical(profile)) || request.edgeCertification.workerProfileSha256 !== selector.profileSha256) fail("JOB_EDGE_PROFILE_MISMATCH");
}
async function dataReceipt(project: string, relative: string, limit: number) {
  const handle = await open(join(project, relative), constants.O_RDONLY | constants.O_NOFOLLOW);
  try {
    const info = await handle.stat();
    if (!info.isFile() || info.nlink !== 1 || info.uid !== 65532 || info.size < 1 || info.size > limit) fail("JOB_DATA_RECEIPT_INVALID");
    const bytes = Buffer.alloc(info.size + 1); let offset = 0;
    while (offset < bytes.length) { const next = await handle.read(bytes, offset, bytes.length - offset, offset); if (!next.bytesRead) break; offset += next.bytesRead; }
    if (offset !== info.size) fail("JOB_DATA_RECEIPT_CHANGED");
    const content = bytes.subarray(0, offset); new TextDecoder("utf-8", { fatal: true }).decode(content);
    return { sha256: sha(content), bytesBase64: content.toString("base64") };
  } finally { await handle.close(); }
}
function validateDataReceipt(value: { path: string; sha256: string; bytesBase64: string }, path: string, limit: number) {
  if (!value || Object.keys(value).sort().join(",") !== "bytesBase64,path,sha256" || value.path !== path || typeof value.bytesBase64 !== "string" || value.bytesBase64.length > Math.ceil(limit / 3) * 4) fail("RESTORE_DATA_RECEIPT_INVALID");
  const bytes = Buffer.from(value.bytesBase64, "base64");
  if (!bytes.length || bytes.length > limit || bytes.toString("base64") !== value.bytesBase64 || sha(bytes) !== value.sha256) fail("RESTORE_DATA_RECEIPT_INVALID");
  new TextDecoder("utf-8", { fatal: true }).decode(bytes);
}
async function exists(path: string) { return lstat(path).then(() => true, error => { if (error.code === "ENOENT") return false; throw error; }); }
async function immutable(path: string, bytes: Uint8Array | string) {
  try { await writeFile(path, bytes, { flag: "wx", mode: 0o600 }); }
  catch (error) { if ((error as NodeJS.ErrnoException).code !== "EEXIST" || sha(await readFile(path)) !== sha(bytes)) throw error; }
}
/** A root-only advisory lock is held by this process's open file description.
 * The short-lived flock helper only acquires it; the parent descriptor keeps
 * it across every trusted writer and SIGKILL releases it automatically. */
async function controlled<T>(operation: () => Promise<T>): Promise<T> {
  const handle = await open(join(ROOT, "control.lock"), constants.O_RDWR | constants.O_CREAT | constants.O_NOFOLLOW, 0o600);
  try {
    const info = await handle.stat();
    if (!info.isFile() || info.uid !== 0 || info.nlink !== 1 || (info.mode & 0o077) !== 0) fail("JOB_CONTROL_LOCK_UNTRUSTED");
    const locker = spawn("/usr/bin/flock", ["--exclusive", "--nonblock", "--conflict-exit-code=75", "3"], { stdio: ["ignore", "ignore", "ignore", handle.fd] });
    const status = await new Promise<number | null>((resolve, reject) => { locker.once("error", reject); locker.once("exit", resolve); });
    if (status !== 0) fail(status === 75 ? "JOB_CONTROL_BUSY" : "JOB_CONTROL_LOCK_FAILED");
    return await operation();
  } finally { await handle.close(); }
}
async function idle(): Promise<boolean> {
  if (await exists(join(ROOT, "active"))) return false;
  for (const entry of await readdir(ROOT)) if (/^[a-f0-9]{64}$/u.test(entry) && await exists(join(ROOT, entry, "claimed")) && !await exists(join(ROOT, entry, "result.json"))) return false;
  return true;
}
function parseRestore(bytes: Uint8Array) {
  if (bytes.length > MAX_RESTORE) fail("RESTORE_LIMIT");
  const value = JSON.parse(Buffer.from(bytes).toString("utf8"));
  if (!value || Object.keys(value).sort().join(",") !== "artifact,source,toolchainSha256,version" || value.version !== 1 || !/^[a-f0-9]{64}$/u.test(value.toolchainSha256)) fail("RESTORE_INVALID");
  const source = parseRequest(value.source);
  const artifact = value.artifact;
  const expectedArtifactKeys = artifact?.version === 3 ? (artifact.toolchainReceipt === undefined ? "artifactContract,capabilityReceipt,commandEvidence,conformanceReceipt,files,jobId,manifestReceipt,proposalSha256,toolchainSha256,version" : "artifactContract,capabilityReceipt,commandEvidence,conformanceReceipt,files,jobId,manifestReceipt,proposalSha256,toolchainReceipt,toolchainSha256,version") : artifact?.version === 2 ? "capabilityReceipt,commandEvidence,files,jobId,proposalSha256,toolchainSha256,version" : "commandEvidence,files,jobId,proposalSha256,toolchainSha256,version";
  if (source.toolchainSha256 !== value.toolchainSha256 || !artifact || Object.keys(artifact).sort().join(",") !== expectedArtifactKeys || ![1, 2, 3].includes(artifact.version) || artifact.jobId !== sha(canonical(source)) || artifact.toolchainSha256 !== value.toolchainSha256 || artifact.proposalSha256 !== source.proposalSha256 || !Array.isArray(artifact.files) || artifact.files.length < 1 || artifact.files.length > 256 || !Array.isArray(artifact.commandEvidence) || artifact.commandEvidence.length !== 8) fail("RESTORE_BINDING_INVALID");
  if ((source.version === 2) !== (artifact.version === 3)) fail("RESTORE_CONTRACT_MISMATCH");
  if (artifact.version !== 1) validateCapabilityReceipt(artifact.capabilityReceipt, source);
  if (artifact.version === 3) {
    if (artifact.artifactContract !== "nip5d-direct-v1" || artifact.files.length !== 1 || artifact.files[0]?.path !== "index.html" || artifact.capabilityReceipt.state !== "present") fail("RESTORE_CONTRACT_MISMATCH");
    if (artifact.toolchainReceipt !== undefined) validateToolchainReceipt(artifact.toolchainReceipt);
    validateDataReceipt(artifact.manifestReceipt, ".nip5a-manifest.json", 65_536);
    validateDataReceipt(artifact.conformanceReceipt, "test-results/conformance.json", 262_144);
  }
  let total = 0; const paths = new Set<string>();
  for (const file of artifact.files) {
    if (!file || Object.keys(file).sort().join(",") !== "bytesBase64,path,sha256,size" || typeof file.path !== "string" || !/^[A-Za-z0-9._-]+(?:\/[A-Za-z0-9._-]+)*$/u.test(file.path) || file.path.split("/").some((part: string) => part === "." || part === "..") || paths.has(file.path) || typeof file.bytesBase64 !== "string" || file.bytesBase64.length > 22_369_624) fail("RESTORE_FILE_INVALID");
    paths.add(file.path); const content = Buffer.from(file.bytesBase64, "base64"); total += content.length;
    if (content.length !== file.size || sha(content) !== file.sha256 || content.toString("base64") !== file.bytesBase64 || total > MAX_ARTIFACT) fail("RESTORE_FILE_INVALID");
  }
  if (!paths.has("index.html")) fail("RESTORE_ENTRY_MISSING");
  return { source, artifact, toolchainSha256: value.toolchainSha256 as string };
}
type RestorePlan = Readonly<{ version: 1; operationId: string; archiveSha256: string; chunks: number; bindingSha256: string; workerOperationId: string; workerResourceId: string; leaseSha256: string;
  expected: Readonly<{ archiveSha256: string; toolchainSha256: string; sourceSha256: string; artifactFilesSha256: string }> }>;
function record(value: unknown): value is Record<string, unknown> { return !!value && typeof value === "object" && !Array.isArray(value); }
function digest(value: unknown): value is string { return typeof value === "string" && /^[a-f0-9]{64}$/u.test(value); }
function restoreDigest(value: unknown): string { if (typeof value !== "string" || !/^[a-f0-9]{64}$/u.test(value)) return fail("RESTORE_PLAN_INVALID"); return value; }
function restoreString(value: unknown, expression: RegExp): string { if (typeof value !== "string" || !expression.test(value)) return fail("RESTORE_PLAN_INVALID"); return value; }
function restoreChunks(value: unknown): number { if (typeof value !== "number" || !Number.isSafeInteger(value) || value < 1 || value > MAX_RESTORE / CHUNK) return fail("RESTORE_PLAN_INVALID"); return value; }
function parseRestorePlan(value: Record<string, unknown>): RestorePlan {
  if (Object.keys(value).sort().join(",") !== "archiveSha256,bindingSha256,chunks,expected,leaseSha256,operationId,version,workerOperationId,workerResourceId" || value.version !== 1) fail("RESTORE_PLAN_INVALID");
  const rawExpected = value.expected;
  if (!record(rawExpected)) return fail("RESTORE_PLAN_INVALID");
  const expected = rawExpected;
  if (Object.keys(expected).sort().join(",") !== "archiveSha256,artifactFilesSha256,sourceSha256,toolchainSha256") fail("RESTORE_PLAN_INVALID");
  const operationId = restoreString(value.operationId, /^[a-z][a-z0-9:_-]{2,240}$/u), archiveSha256 = restoreDigest(value.archiveSha256), chunks = restoreChunks(value.chunks), bindingSha256 = restoreDigest(value.bindingSha256);
  const workerOperationId = restoreString(value.workerOperationId, /^.{1,512}$/u), workerResourceId = restoreString(value.workerResourceId, /^.{1,512}$/u), leaseSha256 = restoreDigest(value.leaseSha256);
  const expectedArchiveSha256 = restoreDigest(expected.archiveSha256), expectedToolchainSha256 = restoreDigest(expected.toolchainSha256), expectedSourceSha256 = restoreDigest(expected.sourceSha256), expectedArtifactFilesSha256 = restoreDigest(expected.artifactFilesSha256);
  if (expectedArchiveSha256 !== archiveSha256) fail("RESTORE_PLAN_INVALID");
  return Object.freeze({ version: 1, operationId, archiveSha256, chunks, bindingSha256, workerOperationId, workerResourceId, leaseSha256, expected: Object.freeze({ archiveSha256: expectedArchiveSha256, toolchainSha256: expectedToolchainSha256, sourceSha256: expectedSourceSha256, artifactFilesSha256: expectedArtifactFilesSha256 }) });
}
async function restorePlan(path: string): Promise<RestorePlan> {
  const info = await lstat(path);
  if (!info.isFile() || info.isSymbolicLink() || info.uid !== 0 || info.nlink !== 1 || (info.mode & 0o077) !== 0 || info.size < 1 || info.size > 8192) fail("RESTORE_PLAN_UNTRUSTED");
  return parseRestorePlan(JSON.parse(await readFile(path, "utf8")));
}
function restoreValue(plan: RestorePlan, restored: ReturnType<typeof parseRestore>, actual: Awaited<ReturnType<typeof collect>>) {
  const value = { state: "restored", archiveSha256: plan.archiveSha256, toolchainSha256: restored.toolchainSha256, sourceSha256: sha(canonical(restored.source.files)), artifactFilesSha256: sha(canonical(actual)), workspacePath: "/workspace/restored" };
  if (value.toolchainSha256 !== plan.expected.toolchainSha256 || value.sourceSha256 !== plan.expected.sourceSha256 || value.artifactFilesSha256 !== plan.expected.artifactFilesSha256) fail("RESTORE_PLAN_BINDING_DENIED");
  return value;
}
function parseRestoreValue(value: Record<string, unknown>, plan: RestorePlan) {
  if (Object.keys(value).sort().join(",") !== "archiveSha256,artifactFilesSha256,sourceSha256,state,toolchainSha256,workspacePath" || value.state !== "restored" || value.archiveSha256 !== plan.archiveSha256
    || value.toolchainSha256 !== plan.expected.toolchainSha256 || value.sourceSha256 !== plan.expected.sourceSha256 || value.artifactFilesSha256 !== plan.expected.artifactFilesSha256 || value.workspacePath !== "/workspace/restored") fail("RESTORE_RECEIPT_INVALID");
  return value;
}
async function rootOwnedTree(path: string): Promise<void> {
  const info = await lstat(path);
  if (info.isSymbolicLink() || info.uid !== 0 || (info.mode & 0o022) !== 0 || (!info.isDirectory() && (!info.isFile() || info.nlink !== 1))) fail("RESTORE_STAGING_UNTRUSTED");
  if (info.isDirectory()) for (const entry of await readdir(path)) await rootOwnedTree(join(path, entry));
}
async function exactFile(path: string, bytes: Uint8Array | string): Promise<boolean> {
  try {
    const info = await lstat(path);
    return info.isFile() && !info.isSymbolicLink() && info.uid === 0 && info.nlink === 1 && (info.mode & 0o022) === 0 && sha(await readFile(path)) === sha(bytes);
  } catch (error) { if (record(error) && error.code === "ENOENT") return false; throw error; }
}
async function restoredWorkspaceMatches(path: string, restored: ReturnType<typeof parseRestore>): Promise<boolean> {
  try {
    const info = await lstat(path);
    if (!info.isDirectory() || info.isSymbolicLink() || info.uid !== 0 || (info.mode & 0o022) !== 0) return false;
    for (const file of restored.source.files) if (!await exactFile(join(path, file.path), file.content)) return false;
    for (const file of restored.artifact.files) if (!await exactFile(join(path, "dist", file.path), Buffer.from(file.bytesBase64, "base64"))) return false;
    if (restored.source.version === 2 && (!await exactFile(join(path, ".napplet-cvm-authoring.json"), canonical({ purpose: restored.source.purpose }))
      || !await exactFile(join(path, ".napplet-cvm-receipts", "manifest.json"), Buffer.from(restored.artifact.manifestReceipt.bytesBase64, "base64"))
      || !await exactFile(join(path, ".napplet-cvm-receipts", "conformance.json"), Buffer.from(restored.artifact.conformanceReceipt.bytesBase64, "base64")))) return false;
    return canonical(await collect(join(path, "dist"))) === canonical(restored.artifact.files);
  } catch { return false; }
}
async function materializeRestore(restoreDir: string, plan: RestorePlan, repair: boolean) {
  const bytes = Buffer.concat(await Promise.all(Array.from({ length: plan.chunks }, (_, index) => readFile(join(restoreDir, `part-${index}`)))));
  if (sha(bytes) !== plan.archiveSha256) fail("RESTORE_DIGEST_INVALID");
  const restored = parseRestore(bytes); await assertImageContract(restored.source);
  const target = "/workspace/restored", staging = `/workspace/restore-${plan.archiveSha256}`;
  if (!await exists(target)) {
    if (await exists(staging)) { if (!repair) fail("RESTORE_STAGING_EXISTS"); await rootOwnedTree(staging); await rm(staging, { recursive: true }); }
    await mkdir(staging, { mode: 0o755 }); await mkdir(join(staging, "src")); await mkdir(join(staging, "dist"));
    for (const file of restored.source.files) await writeFile(join(staging, file.path), file.content, { flag: "wx", mode: 0o444 });
    for (const file of restored.artifact.files) { const path = join(staging, "dist", file.path); await mkdir(join(path, ".."), { recursive: true }); await writeFile(path, Buffer.from(file.bytesBase64, "base64"), { flag: "wx", mode: 0o444 }); }
    if (restored.source.version === 2) {
      await writeFile(join(staging, ".napplet-cvm-authoring.json"), canonical({ purpose: restored.source.purpose }), { flag: "wx", mode: 0o444 });
      const receipts = join(staging, ".napplet-cvm-receipts"); await mkdir(receipts);
      for (const [path, value] of [["manifest.json", restored.artifact.manifestReceipt], ["conformance.json", restored.artifact.conformanceReceipt]] as const) await writeFile(join(receipts, path), Buffer.from(value.bytesBase64, "base64"), { flag: "wx", mode: 0o444 });
    }
    const actual = await collect(join(staging, "dist")); if (canonical(actual) !== canonical(restored.artifact.files)) fail("RESTORE_READBACK_MISMATCH");
    await protect(staging); await rename(staging, target);
  }
  if (!await restoredWorkspaceMatches(target, restored)) fail("RESTORE_READBACK_MISMATCH");
  const value = restoreValue(plan, restored, await collect(join(target, "dist"))), resultPath = join(restoreDir, "result.json");
  await immutable(resultPath, canonical(value));
  const receipt = JSON.parse(await readFile(resultPath, "utf8"));
  if (canonical(receipt) !== canonical(value)) fail("RESTORE_RECEIPT_READBACK_INVALID");
  return parseRestoreValue(receipt, plan);
}
async function legacyRestorePlan(restoreDir: string, archiveSha256: string, chunks: number): Promise<RestorePlan> {
  const bytes = Buffer.concat(await Promise.all(Array.from({ length: chunks }, (_, index) => readFile(join(restoreDir, `part-${index}`)))));
  if (sha(bytes) !== archiveSha256) fail("RESTORE_DIGEST_INVALID");
  const restored = parseRestore(bytes);
  return Object.freeze({ version: 1, operationId: `legacy-restore:${archiveSha256}`, archiveSha256, chunks, bindingSha256: sha(bytes), workerOperationId: "legacy", workerResourceId: "legacy", leaseSha256: sha(bytes),
    expected: Object.freeze({ archiveSha256, toolchainSha256: restored.toolchainSha256, sourceSha256: sha(canonical(restored.source.files)), artifactFilesSha256: sha(canonical(restored.artifact.files)) }) });
}
type CapabilityReceipt = { state: "absent"; path: "src/capabilities.json" } | { state: "present"; path: "src/capabilities.json"; sha256: string; bytesBase64: string };
function validateCapabilityReceipt(value: CapabilityReceipt, source?: Request) {
  if (!value || value.path !== "src/capabilities.json") fail("JOB_CAPABILITY_RECEIPT_INVALID");
  const requested = source?.files.find(file => file.path === value.path);
  if (value.state === "absent") {
    if (Object.keys(value).sort().join(",") !== "path,state" || requested) fail("JOB_CAPABILITY_RECEIPT_INVALID");
  } else if (value.state === "present") {
    if (Object.keys(value).sort().join(",") !== "bytesBase64,path,sha256,state" || typeof value.bytesBase64 !== "string" || value.bytesBase64.length > 40_000) fail("JOB_CAPABILITY_RECEIPT_INVALID");
    const bytes = Buffer.from(value.bytesBase64, "base64");
    if (!bytes.length || bytes.length > 30_000 || bytes.toString("base64") !== value.bytesBase64 || sha(bytes) !== value.sha256 || requested && bytes.toString("utf8") !== requested.content) fail("JOB_CAPABILITY_RECEIPT_INVALID");
    new TextDecoder("utf-8", { fatal: true }).decode(bytes);
  } else fail("JOB_CAPABILITY_RECEIPT_INVALID");
}
async function capabilityReceipt(project: string): Promise<CapabilityReceipt> {
  const path = join(project, "src/capabilities.json"), info = await lstat(path).catch(error => { if (error.code === "ENOENT") return undefined; throw error; });
  if (!info) return { state: "absent", path: "src/capabilities.json" };
  if (!info.isFile() || info.isSymbolicLink() || info.nlink !== 1 || info.uid !== 0 || info.size > 30_000) fail("JOB_CAPABILITY_RECEIPT_INVALID");
  const bytes = await readFile(path);
  const receipt: CapabilityReceipt = { state: "present", path: "src/capabilities.json", sha256: sha(bytes), bytesBase64: bytes.toString("base64") };
  validateCapabilityReceipt(receipt); return receipt;
}
async function protect(path: string): Promise<void> {
  const info = await lstat(path);
  if (info.isSymbolicLink()) return; // pnpm links target the immutable image store.
  // Files were created by the build UID, possibly with private mode bits.
  // Ownership conversion must preserve its ability to read the immutable
  // substrate. Merely stripping write bits can turn 0600 into root-only 0400.
  await chown(path, 0, 0); await chmod(path, info.isDirectory() ? 0o555 : 0o444 | (info.mode & 0o111 ? 0o111 : 0));
  if (info.isDirectory()) for (const child of await readdir(path)) await protect(join(path, child));
}
async function command(argv: string[], cwd: string, deadline: number) {
  if (deadline <= Date.now()) fail("JOB_DEADLINE_EXPIRED");
  const startedAt = Date.now();
  const child = Bun.spawn(["/usr/bin/unshare", "--pid", "--fork", "--kill-child", "--mount", "--mount-proc", "--", BOOTSTRAP, ...argv], { cwd, env, stdin: "ignore", stdout: "pipe", stderr: "pipe" });
  const drain = async (stream: ReadableStream<Uint8Array>) => {
    const reader = stream.getReader(); let bytes = 0; const parts: Uint8Array[] = [];
    try { for (;;) { const item = await reader.read(); if (item.done) break; bytes += item.value.length; if (bytes > 65_536) { child.kill(); fail("JOB_LOG_LIMIT"); } parts.push(item.value); } return Buffer.concat(parts).toString("utf8"); }
    finally { reader.releaseLock(); }
  };
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    const timeout = new Promise<never>((_, reject) => { timer = setTimeout(() => { child.kill(); reject(new Error("JOB_COMMAND_TIMEOUT")); }, Math.min(120_000, deadline - Date.now())); });
    const [exitCode, stdout, stderr] = await Promise.race([Promise.all([child.exited, drain(child.stdout), drain(child.stderr)]), timeout]);
    return { argv, exitCode, stdout, stderr, elapsedMs: Date.now() - startedAt };
  } finally { clearTimeout(timer); child.kill(); }
}
async function collect(root: string) {
  const files: { path: string; bytesBase64: string; sha256: string; size: number }[] = []; let total = 0;
  async function visit(path: string, relative = "") {
    const info = await lstat(path);
    if (info.isSymbolicLink() || (!info.isDirectory() && (!info.isFile() || info.nlink !== 1))) fail("JOB_ARTIFACT_UNTRUSTED");
    if (info.isDirectory()) { for (const child of (await readdir(path)).sort()) { if (!/^[A-Za-z0-9._-]+$/u.test(child) || child === "." || child === "..") fail("JOB_ARTIFACT_PATH_INVALID"); await visit(join(path, child), relative ? `${relative}/${child}` : child); } return; }
    total += info.size; if (total > MAX_ARTIFACT || files.length >= 256) fail("JOB_ARTIFACT_LIMIT");
    const bytes = await readFile(path); if (bytes.length !== info.size) fail("JOB_ARTIFACT_CHANGED");
    files.push({ path: relative, bytesBase64: bytes.toString("base64"), sha256: sha(bytes), size: bytes.length });
  }
  await visit(root); if (!files.some(file => file.path === "index.html")) fail("JOB_ARTIFACT_ENTRY_MISSING");
  return files;
}
async function measuredLockedFile(path: string) {
  const handle = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW);
  try {
    const info = await handle.stat();
    if (!info.isFile() || info.uid !== 0 || info.nlink !== 1 || (info.mode & 0o022) !== 0 || info.size < 1 || info.size > 4 * 1024 * 1024) fail("JOB_SUPPLY_LOCK_UNTRUSTED");
    const bytes = Buffer.alloc(info.size + 1); const result = await handle.read(bytes, 0, bytes.length, 0);
    if (result.bytesRead !== info.size) fail("JOB_SUPPLY_LOCK_CHANGED");
    const after = await handle.stat();
    if (after.ino !== info.ino || after.mtimeMs !== info.mtimeMs || after.ctimeMs !== info.ctimeMs) fail("JOB_SUPPLY_LOCK_CHANGED");
    return sha(bytes.subarray(0, result.bytesRead));
  } finally { await handle.close(); }
}
async function rootOwnedDirectory(path: string) {
  const info = await lstat(path);
  if (!info.isDirectory() || info.isSymbolicLink() || info.uid !== 0 || (info.mode & 0o022) !== 0) fail("JOB_SUPPLY_DIRECTORY_UNTRUSTED");
}
async function installedPackageInventory(project: string) {
  const store = join(project, "node_modules/.pnpm"); await rootOwnedDirectory(store);
  const packageRoots: string[] = [];
  for (const entry of (await readdir(store)).sort()) {
    const nodeModules = join(store, entry, "node_modules");
    const exists = await lstat(nodeModules).then(info => info.isDirectory() && !info.isSymbolicLink(), () => false); if (!exists) continue;
    for (const name of (await readdir(nodeModules)).sort()) {
      if (name.startsWith("@")) for (const nested of (await readdir(join(nodeModules, name))).sort()) packageRoots.push(join(nodeModules, name, nested));
      else packageRoots.push(join(nodeModules, name));
    }
  }
  const packages = [] as Array<{ name: string; version: string; packageJsonSha256: string }>;
  for (const root of packageRoots) {
    const manifest = join(root, "package.json"), handle = await open(manifest, constants.O_RDONLY | constants.O_NOFOLLOW);
    try {
      const before = await handle.stat();
      if (!before.isFile() || before.uid !== 0 || before.nlink !== 1 || (before.mode & 0o022) !== 0 || before.size < 2 || before.size > 262_144) fail("JOB_INSTALLED_PACKAGE_UNTRUSTED");
      const bytes = Buffer.alloc(before.size + 1), read = await handle.read(bytes, 0, bytes.length, 0), after = await handle.stat();
      if (read.bytesRead !== before.size || after.ino !== before.ino || after.mtimeMs !== before.mtimeMs || after.ctimeMs !== before.ctimeMs) fail("JOB_INSTALLED_PACKAGE_CHANGED");
      const value = objectRecord(JSON.parse(bytes.subarray(0, read.bytesRead).toString("utf8")), "JOB_INSTALLED_PACKAGE_INVALID"), name = stringField(value, "name", "JOB_INSTALLED_PACKAGE_INVALID"), version = stringField(value, "version", "JOB_INSTALLED_PACKAGE_INVALID");
      if (!/^(?:@[a-z0-9][a-z0-9._-]*\/)?[a-z0-9][a-z0-9._-]*$/u.test(name) || !/^[0-9]+\.[0-9]+\.[0-9]+(?:[-+][0-9A-Za-z.-]+)?$/u.test(version)) fail("JOB_INSTALLED_PACKAGE_INVALID");
      packages.push({ name, version, packageJsonSha256: sha(bytes.subarray(0, read.bytesRead)) });
    } finally { await handle.close(); }
  }
  packages.sort((left, right) => canonical(left).localeCompare(canonical(right)));
  if (!packages.length || packages.length > 2_048 || new Set(packages.map(canonical)).size !== packages.length) fail("JOB_INSTALLED_PACKAGE_INVALID");
  return Object.freeze({ format: "installed-package-inventory-v1" as const, packages: Object.freeze(packages), sha256: sha(canonical(packages)) });
}
async function measureEdgeToolchain() {
  // The v3 dispatch selector and its selected profile are executable policy:
  // changing either must change the measurement authenticated by provider
  // readback. Archived v1/v2 profile readers remain intentionally untouched.
  const paths = ["/toolchain/production-artifact-contract", "/toolchain/bin/napplet", "/toolchain/package.json", "/toolchain/pnpm-lock.yaml", "/toolchain/boilerplate-template/package.json", "/toolchain/boilerplate-template/pnpm-lock.yaml", "/toolchain/edge-worker-current.json", "/toolchain/edge-worker-profile-v3.json"] as const;
  const files = await Promise.all(paths.map(async path => Object.freeze({ path, sha256: await immutableImageFileHash(path) })));
  return Object.freeze({ format: "immutable-image-files-v1" as const, files: Object.freeze(files), sha256: sha(canonical(files)) });
}
function parsedEdgeAudit(stdout: string, request: EdgeRequest) {
  const value = objectRecord(JSON.parse(stdout), "JOB_EDGE_AUDIT_INVALID"), edge = request.edgeCertification;
  const hostile = objectRecord(value.hostile, "JOB_EDGE_AUDIT_INVALID");
  const cgroup = objectRecord(value.cgroup, "JOB_EDGE_AUDIT_INVALID");
  const [cpuQuotaMicros, cpuPeriodMicros, memoryMaxBytes, pidsMax] = ["cpuQuotaMicros", "cpuPeriodMicros", "memoryMaxBytes", "pidsMax"].map(key => numberField(cgroup, key, "JOB_EDGE_AUDIT_INVALID"));
  if (Object.keys(value).sort().join(",") !== "candidateSha256,cgroup,hostile,kind,topologySha256,version"
    || value.version !== 2 || value.kind !== "edge-native-v2" || value.candidateSha256 !== edge.candidateSha256 || value.topologySha256 !== edge.topologySha256
    || Object.keys(cgroup).sort().join(",") !== "cpuPeriodMicros,cpuQuotaMicros,memoryMaxBytes,pidsMax"
    || [cpuQuotaMicros, cpuPeriodMicros, memoryMaxBytes, pidsMax].some(item => !Number.isSafeInteger(item) || item <= 0)
    || cpuQuotaMicros > cpuPeriodMicros * 2 || memoryMaxBytes > 2_048 * 1024 * 1024 || pidsMax > 256
    || Object.keys(hostile).sort().join(",") !== "filesystemDenied,minimalCapabilities,networkDenied,noInboundPorts,nonRoot"
    || Object.values(hostile).some(item => item !== true)) fail("JOB_EDGE_AUDIT_INVALID");
  return { version: 2, candidateSha256: edge.candidateSha256, topologySha256: edge.topologySha256,
    hostile: { filesystemDenied: true, networkDenied: true, noInboundPorts: true, nonRoot: true, minimalCapabilities: true },
    cgroup: { cpuQuotaMicros, cpuPeriodMicros, memoryMaxBytes, pidsMax } };
}
async function reproduce(id: string, request: EdgeRequest) {
  const project = `/workspace/jobs/${id}/reproduction`, commands: CommandResult[] = [];
  const execute = async (argv: string[], cwd = project) => { const result = await command(argv, cwd, request.deadlineEpochMs); commands.push(result); if (result.exitCode !== 0) throw new ReproductionCommandFailure(commandDiagnostic(result, commands.length - 1)); };
  await chown(join(ROOT, id), 65532, 65532);
  await execute(["/toolchain/bin/napplet", "create", project, "--template", "/toolchain/boilerplate-template"], "/workspace");
  await execute(["/toolchain/bin/napplet", "init", "--force", "--root", "--source-dir", "dist", "--title", "Generated napplet", ...(request.publication ? ["--server", request.publication.server] : [])]);
  await execute(["/toolchain/bin/bun", "/toolchain/node_modules/@napplet/skills/dist/cli.js", "install", "--to", "codex", "--dir", "/home/napplet"]);
  const pnpm = "/toolchain/pnpm-10.8/bin/pnpm.cjs";
  await execute([pnpm, "install", "--offline", "--frozen-lockfile", "--ignore-scripts", "--store-dir", "/toolchain/pnpm-store"]);
  await chown(join(ROOT, id), 0, 0); await chown(project, 0, 0); await chmod(project, 0o755);
  for (const file of request.files) await writeFile(join(project, file.path), file.content, { mode: 0o444 });
  await protect(project); await chmod(project, 0o1777);
  for (const name of ["dist", "test-results", "playwright-report", ".cache", ".vite"]) { const path = join(project, name); await mkdir(path, { recursive: true }); await chown(path, 65532, 65532); await chmod(path, 0o700); }
  for (const argv of [[pnpm, "build"], [pnpm, "verify"], [pnpm, "test:conformance"], ["/toolchain/bin/napplet", "deploy", "--dry-run", "--json", "--name", `cvm-${id.slice(0, 24)}`]]) await execute(argv);
  const files = await collect(join(project, "dist"));
  const installed = await installedPackageInventory(project);
  return { files, aggregateSha256: sha(canonical(files)), lockSha256: await measuredLockedFile(join(project, "pnpm-lock.yaml")), installed, commandEvidenceSha256: sha(canonical(commands.map(({ stdout, stderr, ...facts }) => ({ ...facts, stdoutSha256: sha(stdout), stderrSha256: sha(stderr) })))) };
}
async function run(id: string, dir: string) {
  const requestBytes = await readFile(join(dir, "request.json")); if (sha(requestBytes) !== id) fail("JOB_REQUEST_DIGEST_INVALID");
  const request = parseRequest(JSON.parse(requestBytes.toString("utf8")));
  await assertImageContract(request);
  const commands: CommandResult[] = [];
  const project = `/workspace/jobs/${id}/project`;
  const execute = async (argv: string[], cwd: string) => { const result = await command(argv, cwd, request.deadlineEpochMs); commands.push(result); if (result.exitCode !== 0) fail("JOB_COMMAND_FAILED"); };
  let locked = false;
  try {
    await mkdir(join(ROOT, "active")); locked = true;
    if (request.deadlineEpochMs <= Date.now() || request.deadlineEpochMs > Date.now() + 600_000) fail("JOB_DEADLINE_INVALID");
    const toolchainReceipt = request.version === 2 ? await measureDirectToolchain() : undefined;
    const edgeToolchain = request.version === 3 ? await measureEdgeToolchain() : undefined;
    await mkdir(`/workspace/jobs/${id}`, { recursive: true }); await chown(`/workspace/jobs/${id}`, 65532, 65532);
    await execute(["/toolchain/bin/napplet", "create", project, "--template", "/toolchain/boilerplate-template"], "/workspace");
    await execute(["/toolchain/bin/napplet", "init", "--force", "--root", "--source-dir", "dist", "--title", "Generated napplet", ...(request.publication ? ["--server", request.publication.server] : [])], project);
    await execute(["/toolchain/bin/bun", "/toolchain/node_modules/@napplet/skills/dist/cli.js", "install", "--to", "codex", "--dir", "/home/napplet"], project);
    const pnpm = "/toolchain/pnpm-10.8/bin/pnpm.cjs";
    await execute([pnpm, "install", "--offline", "--frozen-lockfile", "--ignore-scripts", "--store-dir", "/toolchain/pnpm-store"], project);
    const originalRoot = new Set(await readdir(project));
    await chown(`/workspace/jobs/${id}`, 0, 0); await chmod(`/workspace/jobs/${id}`, 0o755);
    for (const file of request.files) { const path = join(project, file.path); const info = await lstat(path).catch(() => undefined); if (info?.isSymbolicLink() || (info && !info.isFile())) fail("JOB_SOURCE_PATH_UNTRUSTED"); await writeFile(path, file.content, { mode: 0o444 }); }
    if (request.version === 2) await writeFile(join(project, ".napplet-cvm-authoring.json"), canonical({ purpose: request.purpose }), { flag: "wx", mode: 0o444 });
    await protect(project);
    const capabilities = await capabilityReceipt(project); validateCapabilityReceipt(capabilities, request);
    // Sticky root allows new tool reports but prevents generated UID from
    // replacing any of the root-owned package/config/source files.
    await chmod(project, 0o1777);
    for (const name of ["dist", "test-results", "playwright-report", ".cache", ".vite"]) { const path = join(project, name); await mkdir(path, { recursive: true }); await chown(path, 65532, 65532); await chmod(path, 0o700); }
    for (const argv of [[pnpm, "build"], [pnpm, "verify"], [pnpm, "test:conformance", ...(request.version === 2 ? ["--reporter", "json", "--out", "test-results/conformance.json"] : [])], ["/toolchain/bin/napplet", "deploy", "--dry-run", "--json", "--name", `cvm-${id.slice(0, 24)}`, ...(request.version === 2 ? ["--no-zapstore", "--non-interactive"] : [])]]) {
      for (const name of await readdir(project)) if (!originalRoot.has(name) && /(^\.env|^\.npmrc$|^pnpm-workspace\.|\.config\.|^tsconfig\.|^napplet\.)/u.test(name)) fail("JOB_MANAGED_CONFIGURATION_CHANGED");
      await execute(argv, project);
    }
    if (toolchainReceipt && canonical(toolchainReceipt) !== canonical(await measureDirectToolchain())) fail("JOB_TOOLCHAIN_FILE_CHANGED");
    if (edgeToolchain && canonical(edgeToolchain) !== canonical(await measureEdgeToolchain())) fail("JOB_TOOLCHAIN_FILE_CHANGED");
    const collected = await collect(join(project, "dist"));
    const edgeCertification = request.version === 3 ? await (async () => {
      const hostileCommand = await command(["/usr/local/bin/napplet-cvm-worker", "edge-audit", "--candidate-sha256", request.edgeCertification.candidateSha256, "--topology-sha256", request.edgeCertification.topologySha256], project, request.deadlineEpochMs);
      if (hostileCommand.exitCode !== 0) fail("JOB_EDGE_AUDIT_FAILED");
      const hostile = parsedEdgeAudit(hostileCommand.stdout, request);
      const installed = await installedPackageInventory(project);
      const primary = { aggregateSha256: sha(canonical(collected)), lockSha256: await measuredLockedFile(join(project, "pnpm-lock.yaml")), installed, commandEvidenceSha256: sha(canonical(commands.map(({ stdout, stderr, ...facts }) => ({ ...facts, stdoutSha256: sha(stdout), stderrSha256: sha(stderr) })))) };
      const secondary = await reproduce(id, request);
      if (primary.aggregateSha256 !== secondary.aggregateSha256 || primary.lockSha256 !== secondary.lockSha256 || primary.installed.sha256 !== secondary.installed.sha256) fail("JOB_REPRODUCTION_MISMATCH");
      return { ...hostile, workerProfileSha256: request.edgeCertification.workerProfileSha256, imageToolchain: edgeToolchain ?? fail("JOB_TOOLCHAIN_FILE_CHANGED"), supply: { format: "installed-package-inventory-v1" as const, primary: { ...primary, installed: primary.installed }, secondary: { ...secondary, installed: secondary.installed } } };
    })() : undefined;
    const direct = request.version === 2 ? {
      version: 3, artifactContract: request.artifactContract, toolchainReceipt,
      manifestReceipt: { path: ".nip5a-manifest.json", ...await dataReceipt(project, "dist/.nip5a-manifest.json", 65_536) },
      conformanceReceipt: { path: "test-results/conformance.json", ...await dataReceipt(project, "test-results/conformance.json", 262_144) },
    } : request.version === 3 ? { version: 4, edgeCertification } : { version: 2 };
    const files = request.version === 2 ? collected.filter(file => file.path !== ".nip5a-manifest.json") : collected;
    if (request.version === 2 && (files.length !== 1 || files[0]?.path !== "index.html" || capabilities.state !== "present")) fail("JOB_DIRECT_ARTIFACT_INVALID");
    if (canonical(capabilities) !== canonical(await capabilityReceipt(project))) fail("JOB_CAPABILITY_RECEIPT_CHANGED");
    const artifact = canonical({ ...direct, jobId: id, proposalSha256: request.proposalSha256, toolchainSha256: request.toolchainSha256, files, commandEvidence: commands, capabilityReceipt: capabilities });
    await immutable(join(dir, "artifact.json"), artifact);
    await immutable(join(dir, "result.json"), canonical({ version: 1, jobId: id, state: "completed", requestSha256: id, artifactSha256: sha(artifact), artifactBytes: Buffer.byteLength(artifact), commands: commands.map(({ stdout, stderr, ...facts }) => ({ ...facts, stdoutSha256: sha(stdout), stderrSha256: sha(stderr) })) }));
  } catch (error) {
    // Failure status is private coordinator output. Preserve bounded tails
    // from the last command so a failed build can be diagnosed after the
    // ephemeral workspace is removed. These are untrusted diagnostic bytes,
    // never conformance or artifact evidence; full output hashes stay intact.
    const last = commands.at(-1);
    const diagnostics = last ? commandDiagnostic(last, commands.length - 1) : undefined;
    const reproductionDiagnostics = error instanceof ReproductionCommandFailure ? error.diagnostic : undefined;
    await immutable(join(dir, "result.json"), canonical({ version: 1, jobId: id, state: "failed", requestSha256: id, code: error instanceof Error ? error.message : "JOB_FAILED", commands: commands.map(({ stdout, stderr, ...facts }) => ({ ...facts, stdoutSha256: sha(stdout), stderrSha256: sha(stderr) })), ...(diagnostics ? { diagnostics } : {}), ...(reproductionDiagnostics ? { reproductionDiagnostics } : {}) })).catch(() => undefined);
  } finally {
    // The immutable input and artifact are retained under the root-only job
    // record. Free ephemeral installs so revisions cannot fill the workspace.
    if (locked) { await rm(`/workspace/jobs/${id}`, { recursive: true, force: true }).catch(() => undefined); await rm(join(ROOT, "active"), { recursive: true, force: true }); }
  }
}

try {
  if (process.getuid?.() !== 0 || process.env.NAPPLET_CVM_POLICY_VERSION !== POLICY) fail("JOB_TRUSTED_SUPERVISOR_REQUIRED");
  const [action, id, argument, data] = process.argv.slice(2);
  if (!id || !/^[a-f0-9]{64}$/u.test(id)) fail("JOB_ID_INVALID");
  const rootInfo = await lstat(ROOT); if (!rootInfo.isDirectory() || rootInfo.uid !== 0 || (rootInfo.mode & 0o077) !== 0) fail("JOB_ROOT_UNTRUSTED");
  const dir = join(ROOT, id);
  if (action === "put") {
    if (!argument || !/^[0-5]$/u.test(argument) || !data || data.length > 32_768 || !/^[A-Za-z0-9+/]+={0,2}$/u.test(data)) fail("JOB_CHUNK_INVALID");
    const bytes = Buffer.from(data, "base64"); if (!bytes.length || bytes.length > CHUNK || bytes.toString("base64") !== data) fail("JOB_CHUNK_INVALID");
    await mkdir(dir, { recursive: true, mode: 0o700 });
    if (await exists(join(dir, "claimed"))) fail("JOB_ALREADY_CLAIMED");
    await immutable(join(dir, `part-${argument}`), bytes); console.log(JSON.stringify({ state: "stored", jobId: id, chunk: Number(argument), sha256: sha(bytes) }));
  } else if (action === "start") {
    if (!argument || !/^[1-6]$/u.test(argument) || data) fail("JOB_START_INVALID");
    // Re-entry is an observation of an immutable claim, so it need not wait
    // behind the original privileged build writer.
    if (!await exists(join(dir, "claimed"))) await controlled(async () => {
      if (!await exists(join(dir, "claimed"))) {
      if (await exists(join(ROOT, "fence.json"))) fail("JOB_LEASE_FENCED");
      if (await exists(join(ROOT, "restoring"))) {
        const restoreId = await readFile(join(ROOT, "restoring"), "utf8");
        if (!/^[a-f0-9]{64}$/u.test(restoreId) || !await exists(join(ROOT, `restore-${restoreId}`, "result.json"))) fail("JOB_RESTORE_PENDING");
      }
      const bytes = Buffer.concat(await Promise.all(Array.from({ length: Number(argument) }, (_, index) => readFile(join(dir, `part-${index}`)))));
      if (bytes.length > MAX_REQUEST || sha(bytes) !== id) fail("JOB_REQUEST_DIGEST_INVALID");
      const request = parseRequest(JSON.parse(bytes.toString("utf8"))); await assertImageContract(request); if (request.deadlineEpochMs <= Date.now() || request.deadlineEpochMs > Date.now() + 600_000) fail("JOB_DEADLINE_INVALID");
      await immutable(join(dir, "request.json"), bytes);
      // Exclusive claim precedes process creation. An ambiguous start is never
      // dispatched again, even if the supervisor dies before spawning.
      try {
        await writeFile(join(dir, "claimed"), id, { flag: "wx", mode: 0o600 });
        const child = spawn("/usr/local/bin/bun", [SCRIPT, "run", id], { detached: true, stdio: "ignore", env }); child.unref();
      } catch (error) { if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error; }
      }
    });
    console.log(JSON.stringify({ state: "pending", jobId: id }));
  } else if (action === "status") {
    if (argument || data) fail("JOB_STATUS_INVALID");
    console.log(await exists(join(dir, "result.json")) ? await readFile(join(dir, "result.json"), "utf8") : JSON.stringify({ state: await exists(join(dir, "claimed")) ? "pending" : "missing", jobId: id }));
  } else if (action === "artifact") {
    if (!argument || !/^(0|[1-9][0-9]{0,7})$/u.test(argument) || data || Number(argument) % CHUNK !== 0) fail("JOB_ARTIFACT_OFFSET_INVALID");
    const result = JSON.parse(await readFile(join(dir, "result.json"), "utf8")); if (result.state !== "completed") fail("JOB_ARTIFACT_NOT_VERIFIED");
    const bytes = await readFile(join(dir, "artifact.json")); if (sha(bytes) !== result.artifactSha256 || Number(argument) >= bytes.length) fail("JOB_ARTIFACT_BINDING_INVALID");
    console.log(JSON.stringify({ jobId: id, offset: Number(argument), totalBytes: bytes.length, artifactSha256: result.artifactSha256, bytesBase64: bytes.subarray(Number(argument), Number(argument) + CHUNK).toString("base64") }));
  } else if (action === "fence" || action === "fence-status") {
    if (!argument || !/^[a-f0-9]{64}$/u.test(argument) || data) fail("JOB_FENCE_INVALID");
    const marker = canonical({ jobId: id, fenceSha256: argument });
    const result = await controlled(async () => {
      if (action === "fence") {
        if (!await exists(join(dir, "request.json"))) fail("JOB_FENCE_ORIGINAL_REQUIRED");
        await immutable(join(ROOT, "fence.json"), marker);
      }
      if (!await exists(join(ROOT, "fence.json"))) return "missing";
      if (await readFile(join(ROOT, "fence.json"), "utf8") !== marker) fail("JOB_FENCE_CONFLICT");
      return await idle() ? "fenced" : "pending";
    });
    console.log(JSON.stringify({ state: result, jobId: id, fenceSha256: argument }));
  } else if (action === "restore-plan") {
    if (!argument || data || argument.length > 8192 || !/^[A-Za-z0-9+/]+={0,2}$/u.test(argument)) fail("RESTORE_PLAN_INVALID");
    const encoded = Buffer.from(argument, "base64"); if (!encoded.length || encoded.toString("base64") !== argument) fail("RESTORE_PLAN_INVALID");
    const plan = parseRestorePlan(JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(encoded)));
    if (plan.archiveSha256 !== id) fail("RESTORE_PLAN_BINDING_DENIED");
    await controlled(async () => {
      if (!await idle() || await exists(join(ROOT, "fence.json"))) fail("RESTORE_FRESH_LEASE_REQUIRED");
      for (const entry of await readdir(ROOT)) if (/^[a-f0-9]{64}$/u.test(entry) && await exists(join(ROOT, entry, "claimed"))) fail("RESTORE_FRESH_LEASE_REQUIRED");
      await immutable(join(ROOT, "restoring"), id);
      const restoreDir = join(ROOT, `restore-${id}`); await mkdir(restoreDir, { recursive: true, mode: 0o700 });
      if (await exists(join(restoreDir, "result.json"))) fail("RESTORE_ALREADY_COMPLETED");
      await immutable(join(restoreDir, "plan.json"), canonical(plan));
    });
    console.log(JSON.stringify({ state: "planned", archiveSha256: id, chunks: plan.chunks }));
  } else if (action === "restore-put") {
    if (!argument || !/^(0|[1-9][0-9]{0,3})$/u.test(argument) || Number(argument) >= MAX_RESTORE / CHUNK || !data || data.length > 32_768) fail("RESTORE_CHUNK_INVALID");
    const bytes = Buffer.from(data, "base64"); if (!bytes.length || bytes.length > CHUNK || bytes.toString("base64") !== data) fail("RESTORE_CHUNK_INVALID");
    await controlled(async () => {
      if (!await idle() || await exists(join(ROOT, "fence.json"))) fail("RESTORE_FRESH_LEASE_REQUIRED");
      for (const entry of await readdir(ROOT)) if (/^[a-f0-9]{64}$/u.test(entry) && await exists(join(ROOT, entry, "claimed"))) fail("RESTORE_FRESH_LEASE_REQUIRED");
      const restoring = join(ROOT, "restoring");
      if (await exists(restoring) && await readFile(restoring, "utf8") !== id) fail("RESTORE_FRESH_LEASE_REQUIRED");
      await immutable(restoring, id);
      const restoreDir = join(ROOT, `restore-${id}`); await mkdir(restoreDir, { recursive: true, mode: 0o700 });
      const planPath = join(restoreDir, "plan.json");
      if (await exists(planPath)) { const plan = await restorePlan(planPath); if (plan.archiveSha256 !== id || Number(argument) >= plan.chunks) fail("RESTORE_PLAN_BINDING_DENIED"); }
      if (await exists(join(restoreDir, "result.json"))) fail("RESTORE_ALREADY_COMPLETED");
      await immutable(join(restoreDir, `part-${argument}`), bytes);
    });
    console.log(JSON.stringify({ state: "stored", archiveSha256: id, chunk: Number(argument), sha256: sha(bytes) }));
  } else if (action === "restore") {
    if (!argument || !/^[1-9][0-9]{0,3}$/u.test(argument) || Number(argument) > MAX_RESTORE / CHUNK || data) fail("RESTORE_INVALID");
    const result = await controlled(async () => {
      if (await readFile(join(ROOT, "restoring"), "utf8") !== id || !await idle()) fail("RESTORE_FRESH_LEASE_REQUIRED");
      const restoreDir = join(ROOT, `restore-${id}`), resultPath = join(restoreDir, "result.json"), planPath = join(restoreDir, "plan.json");
      const plan = await (await exists(planPath) ? restorePlan(planPath) : legacyRestorePlan(restoreDir, id, Number(argument)));
      if (plan.archiveSha256 !== id || plan.chunks !== Number(argument)) fail("RESTORE_PLAN_BINDING_DENIED");
      if (await exists(resultPath)) return parseRestoreValue(JSON.parse(await readFile(resultPath, "utf8")), plan);
      // Exclusive dispatch fence also covers a crash while materializing files.
      // Ordinary retries observe only; repair is a separately bound operation.
      await writeFile(join(restoreDir, "claimed"), canonical({ archiveSha256: id, supervisorPid: process.pid }), { flag: "wx", mode: 0o600 });
      return materializeRestore(restoreDir, plan, false);
    });
    console.log(JSON.stringify(result));
  } else if (action === "restore-repair") {
    if (argument || data) fail("RESTORE_REPAIR_INVALID");
    const result = await controlled(async () => {
      if (await readFile(join(ROOT, "restoring"), "utf8") !== id || !await idle()) fail("RESTORE_FRESH_LEASE_REQUIRED");
      const restoreDir = join(ROOT, `restore-${id}`), resultPath = join(restoreDir, "result.json"), plan = await restorePlan(join(restoreDir, "plan.json"));
      if (plan.archiveSha256 !== id) fail("RESTORE_PLAN_BINDING_DENIED");
      if (await exists(resultPath)) return parseRestoreValue(JSON.parse(await readFile(resultPath, "utf8")), plan);
      if (!await exists(join(restoreDir, "claimed"))) fail("RESTORE_REPAIR_NOT_CLAIMED");
      return materializeRestore(restoreDir, plan, true);
    });
    console.log(JSON.stringify(result));
  } else if (action === "restore-status") {
    if (argument || data) fail("RESTORE_STATUS_INVALID");
    const restoreDir = join(ROOT, `restore-${id}`), resultPath = join(restoreDir, "result.json");
    console.log(await exists(resultPath) ? await readFile(resultPath, "utf8") : JSON.stringify({ state: await exists(join(restoreDir, "claimed")) ? "pending" : "missing", archiveSha256: id }));
  } else if (action === "run") { if (argument || data) fail("JOB_RUN_INVALID"); await controlled(() => run(id, dir)); }
  else fail("JOB_COMMAND_INVALID");
} catch (error) { console.error(error instanceof Error ? error.message : "JOB_FAILED"); process.exitCode = 1; }
