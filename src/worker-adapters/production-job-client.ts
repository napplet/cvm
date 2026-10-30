import { z } from "zod";
import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { canonicalJson } from "../promotion/schema";
import { WorkerRunRequestSchema, type WorkerRunRequest } from "../phase-02/contracts";
import { assertPostgresOperationJournal, type PostgresOperationJournal } from "../release/deployment/postgres-operation-journal";
import { createPostgresWorkerOperationJournal } from "../release/deployment/postgres-provider-journals";
import type { createWorkerDeploymentClients } from "../release/deployment/worker-clients";
import { ProductionWorkerPublicationSchema, type ProductionWorkerPublication } from "./publication-metadata";
import { ProductionCapabilityDeclarationSchema, ProductionCapabilityReceiptSchema } from "./capability-receipt";
import { ProductionConformanceReceiptSchema, verifyProductionConformanceReceipt } from "./conformance-receipt";
import { ProductionDirectManifestReceiptSchema, verifyProductionDirectManifestReceipt } from "./direct-manifest-receipt";

const Digest = z.string().regex(/^[a-f0-9]{64}$/u);
const STEP_NAMES = ["create", "init", "skills", "install", "build", "verify", "conformance", "dry-run"] as const;
const CHUNK = 24_576, MAX_ARTIFACT_BUNDLE = 25_165_824;
const SCRIPT = "/usr/local/bin/napplet-cvm-job";
const sha = (value: string | Uint8Array) => new Bun.CryptoHasher("sha256").update(value).digest("hex");
const Summary = z.object({ argv: z.array(z.string()).max(16), exitCode: z.number().int(), elapsedMs: z.number().int().nonnegative(), stdoutSha256: Digest, stderrSha256: Digest }).strict();
export const ProductionJobObservationSchema = z.discriminatedUnion("state", [
  z.object({ state: z.enum(["pending", "missing"]), jobId: Digest }).strict(),
  z.object({ version: z.literal(1), state: z.literal("failed"), jobId: Digest, requestSha256: Digest, code: z.string().max(256), commands: z.array(Summary).max(8), diagnostics: z.object({ commandIndex: z.number().int().min(0).max(7), stdoutTail: z.string().max(4096), stderrTail: z.string().max(4096) }).strict().optional() }).strict(),
  z.object({ version: z.literal(1), state: z.literal("completed"), jobId: Digest, requestSha256: Digest, artifactSha256: Digest, artifactBytes: z.number().int().positive().max(MAX_ARTIFACT_BUNDLE), commands: z.array(Summary).length(8) }).strict(),
]);
export type ProductionJobObservation = z.infer<typeof ProductionJobObservationSchema> | Readonly<{ state: "unknown"; jobId: string }>;
const LegacyBundle = z.object({ version: z.literal(1), jobId: Digest, proposalSha256: Digest, toolchainSha256: Digest,
  files: z.array(z.object({ path: z.string().regex(/^[A-Za-z0-9._-]+(?:\/[A-Za-z0-9._-]+)*$/u).refine(value => value.split("/").every(part => part !== "." && part !== "..")), bytesBase64: z.string().max(22_369_624), sha256: Digest, size: z.number().int().nonnegative().max(16_777_216) }).strict()).min(1).max(256),
  commandEvidence: z.array(z.object({ argv: z.array(z.string()).max(16), exitCode: z.literal(0), stdout: z.string().max(65_536), stderr: z.string().max(65_536), elapsedMs: z.number().int().nonnegative() }).strict()).length(8),
}).strict();
const Bundle = z.discriminatedUnion("version", [LegacyBundle, LegacyBundle.extend({ version: z.literal(2), capabilityReceipt: ProductionCapabilityReceiptSchema }).strict(), LegacyBundle.extend({ version: z.literal(3), artifactContract: z.literal("nip5d-direct-v1"), capabilityReceipt: ProductionCapabilityReceiptSchema, conformanceReceipt: ProductionConformanceReceiptSchema, manifestReceipt: ProductionDirectManifestReceiptSchema }).strict()]);
type StoredJob = Readonly<{ workerOperationId: string; workerResourceId: string; leaseSha256: string; jobId: string; requestBody: string; deadlineEpochMs: number }>;
type Input = Readonly<{ provider: "modal" | "fly"; workerOperationId: string; clients: ReturnType<typeof createWorkerDeploymentClients>; workerJournal: PostgresOperationJournal; jobJournal: PostgresOperationJournal; toolchainSha256: string; artifactContract?: "nip5d-direct-v1"; publication?: ProductionWorkerPublication; now?: () => number }>;
const WorkspaceSource = z.object({ version: z.literal(1), actionId: z.string().min(1).max(256), sessionId: z.string().min(1).max(256), expectedVersion: z.number().int().nonnegative(), proposalSha256: Digest, toolchainSha256: Digest, deadlineEpochMs: z.number().int().positive(), files: z.array(z.object({ path: z.enum(["src/main.ts", "src/styles.css", "src/capabilities.json"]), content: z.string().refine(value => Buffer.byteLength(value) <= 30_000) }).strict()).min(1).max(3) }).strict();
const LegacySource = WorkspaceSource.extend({ publication: ProductionWorkerPublicationSchema.optional() }).strict();
const DirectSource = WorkspaceSource.extend({ version: z.literal(2), artifactContract: z.literal("nip5d-direct-v1"), purpose: z.string().trim().min(1).max(4096), publication: ProductionWorkerPublicationSchema }).strict().superRefine((source, context) => {
  const content = source.files.find(file => file.path === "src/capabilities.json")?.content;
  try { ProductionCapabilityDeclarationSchema.parse(JSON.parse(content ?? "null")); }
  catch { context.addIssue({ code: "custom", message: "PRODUCTION_DIRECT_DECLARATION_INVALID" }); }
});
const PublishedWorkspaceSource = z.discriminatedUnion("version", [LegacySource, DirectSource]);
const Workspace = z.object({ version: z.literal(1), source: PublishedWorkspaceSource, artifact: Bundle, toolchainSha256: Digest }).strict();
function validateDirectBundle(source: z.infer<typeof PublishedWorkspaceSource>, bundle: z.infer<typeof Bundle>) {
  if ((source.version === 2) !== (bundle.version === 3)) throw new Error("PRODUCTION_JOB_ARTIFACT_CONTRACT_MISMATCH");
  if (source.version === 2 && bundle.version === 3) {
    if (bundle.files.length !== 1 || bundle.files[0]?.path !== "index.html" || bundle.capabilityReceipt.state !== "present") throw new Error("PRODUCTION_JOB_ARTIFACT_CONTRACT_MISMATCH");
    verifyProductionConformanceReceipt(bundle.conformanceReceipt);
    const declaration = ProductionCapabilityDeclarationSchema.parse(JSON.parse(source.files.find(file => file.path === "src/capabilities.json")!.content));
    verifyProductionDirectManifestReceipt(bundle.manifestReceipt, { artifactHash: bundle.files[0].sha256, purpose: source.purpose, declaration });
  }
}
const RestoreObservation = z.discriminatedUnion("state", [
  z.object({ state: z.enum(["pending", "missing"]), archiveSha256: Digest }).strict(),
  z.object({ state: z.literal("restored"), archiveSha256: Digest, toolchainSha256: Digest, sourceSha256: Digest, artifactFilesSha256: Digest, workspacePath: z.literal("/workspace/restored") }).strict(),
]);
type StoredRestore = Readonly<{ workerOperationId: string; workerResourceId: string; leaseSha256: string; archiveSha256: string; bindingSha256: string }>;
export const ProductionRestoreEvidenceSchema = z.object({ schemaVersion: z.literal("worker-restore-evidence-v1"), originalOperationId: z.string().min(1).max(256),
  originalIdentitySha256: Digest, expected: z.object({ archiveSha256: Digest, toolchainSha256: Digest, sourceSha256: Digest, artifactFilesSha256: Digest }).strict() }).strict();

/** Production image protocol only. Provider exec runs a fixed root-owned
 * supervisor for <=15s; generated build work runs asynchronously exactly once. */
export class ProductionWorkerJobClient {
  constructor(private readonly input: Input) {
    this.input = Object.freeze({ ...input, ...(input.publication === undefined ? {} : { publication: ProductionWorkerPublicationSchema.parse(input.publication) }) });
    assertPostgresOperationJournal(input.workerJournal); assertPostgresOperationJournal(input.jobJournal);
    Digest.parse(input.toolchainSha256);
    if (input.artifactContract !== undefined) { z.literal("nip5d-direct-v1").parse(input.artifactContract); if (!input.publication) throw new Error("PRODUCTION_DIRECT_PUBLICATION_REQUIRED"); }
    if (!["modal", "fly"].includes(input.provider) || !/^[a-z][a-z0-9_-]{2,48}$/u.test(input.workerOperationId)) throw new Error("PRODUCTION_JOB_WORKER_INVALID");
  }
  get toolchainSha256(): string { return this.input.toolchainSha256; }
  #key(request: WorkerRunRequest) { return `worker-build:${sha(canonicalJson({ sessionId: request.sessionId, actionId: request.actionId, expectedVersion: request.expectedVersion }))}`; }
  #identity(request: WorkerRunRequest, publication?: ProductionWorkerPublication, artifactContract?: "nip5d-direct-v1") { return sha(canonicalJson(artifactContract ? { request, publication, artifactContract } : publication === undefined ? request : { request, publication })); }
  async #worker() {
    const record = await createPostgresWorkerOperationJournal(this.input.workerJournal).read(this.input.workerOperationId);
    if (!record || record.provider !== this.input.provider || !record.resourceId || !record.sessionLeaseSha256 || record.toolchainSha256 !== this.input.toolchainSha256 || !record.providerDeadlineEpochMs || !["dispatched", "reconciled"].includes(record.state)) throw new Error("PRODUCTION_JOB_READY_WORKER_REQUIRED");
    return record;
  }
  async #original(request: WorkerRunRequest) {
    WorkerRunRequestSchema.parse(request);
    const record = await this.input.jobJournal.read<StoredJob>(this.#key(request));
    if (!record || record.value.workerOperationId !== this.input.workerOperationId || typeof record.value.requestBody !== "string" || Buffer.byteLength(record.value.requestBody) > 131_072 || sha(record.value.requestBody) !== record.value.jobId) throw new Error("PRODUCTION_JOB_ORIGINAL_REQUIRED");
    const source = PublishedWorkspaceSource.parse(JSON.parse(record.value.requestBody));
    if (record.identitySha256 !== this.#identity(request, source.publication, source.version === 2 ? source.artifactContract : undefined) || source.sessionId !== request.sessionId || source.actionId !== request.actionId || source.expectedVersion !== request.expectedVersion
      || source.version === 2 && source.purpose !== request.idea?.trim() || source.proposalSha256 !== request.sourceProposalSha256 || source.toolchainSha256 !== this.input.toolchainSha256 || canonicalJson(source.files) !== canonicalJson(request.sourceProposalFiles)) throw new Error("PRODUCTION_JOB_ORIGINAL_REQUIRED");
    return record.value;
  }
  async #exec(job: Pick<StoredJob, "workerResourceId" | "leaseSha256">, args: string[]): Promise<unknown> {
    const worker = await this.#worker();
    if (worker.resourceId !== job.workerResourceId || worker.sessionLeaseSha256 !== job.leaseSha256) throw new Error("PRODUCTION_JOB_WORKER_REPLACED");
    const command = [SCRIPT, ...args];
    const result = this.input.provider === "modal"
      ? await this.input.clients.modal.exec({ operationId: this.input.workerOperationId, command, timeoutMs: 15_000 })
      : await this.input.clients.fly.exec({ operationId: this.input.workerOperationId, command, timeoutSeconds: 15 });
    if (result.status !== "completed" || result.exitCode !== 0 || !result.stdout || Buffer.byteLength(result.stdout) > 131_072) throw new Error("PRODUCTION_JOB_EXEC_UNKNOWN");
    return JSON.parse(result.stdout);
  }
  async start(value: WorkerRunRequest): Promise<ProductionJobObservation> {
    const request = WorkerRunRequestSchema.parse(value);
    if (!request.sourceProposalFiles || !request.sourceProposalSha256 || request.sourceProposalReference !== `proposal:sha256:${request.sourceProposalSha256}`) throw new Error("PRODUCTION_JOB_SOURCE_REQUIRED");
    const allowed = new Set(["src/main.ts", "src/styles.css", "src/capabilities.json"]);
    if (request.sourceProposalFiles.length > 3 || !request.sourceProposalFiles.some(file => file.path === "src/main.ts") || new Set(request.sourceProposalFiles.map(file => file.path)).size !== request.sourceProposalFiles.length || request.sourceProposalFiles.some(file => !allowed.has(file.path) || Buffer.byteLength(file.content) > 30_000)) throw new Error("PRODUCTION_JOB_SOURCE_INVALID");
    const original = await this.input.jobJournal.read<StoredJob>(this.#key(request));
    if (original) {
      // Re-entry always observes the retained original, including a legacy
      // job or an action created before controller publication settings changed.
      try { await this.#original(request); } catch { throw new Error("OPERATION_IDENTITY_CONFLICT"); }
      return this.observe(request);
    }
    const worker = await this.#worker(); const now = (this.input.now ?? Date.now)();
    // A build must leave the full live-worker grace window available after its
    // boundary. Expiring capacity is rejected before any upload/start effect.
    const deadlineEpochMs = Math.min(now + 600_000, worker.providerDeadlineEpochMs! - 600_000);
    if (deadlineEpochMs <= now) throw new Error("PRODUCTION_JOB_LEASE_EXPIRED");
    const publication = this.input.publication === undefined ? {} : { publication: this.input.publication };
    const profile = this.input.artifactContract ? { version: 2, artifactContract: this.input.artifactContract, purpose: DirectSource.shape.purpose.parse(request.idea) } : { version: 1 };
    if (this.input.artifactContract && !request.sourceProposalFiles.some(file => file.path === "src/capabilities.json")) throw new Error("PRODUCTION_DIRECT_DECLARATION_REQUIRED");
    const requestBody = canonicalJson({ ...profile, actionId: request.actionId, sessionId: request.sessionId, expectedVersion: request.expectedVersion, proposalSha256: request.sourceProposalSha256, toolchainSha256: this.input.toolchainSha256, deadlineEpochMs, files: request.sourceProposalFiles, ...publication });
    PublishedWorkspaceSource.parse(JSON.parse(requestBody));
    const bytes = Buffer.from(requestBody); if (bytes.length > 131_072) throw new Error("PRODUCTION_JOB_REQUEST_TOO_LARGE");
    const jobId = sha(bytes);
    const claim = await this.input.jobJournal.claim<StoredJob>(this.#key(request), this.#identity(request, this.input.publication, this.input.artifactContract), { workerOperationId: this.input.workerOperationId, workerResourceId: worker.resourceId!, leaseSha256: worker.sessionLeaseSha256!, jobId, requestBody, deadlineEpochMs });
    if (!claim.claimed) return this.observe(request);
    const job = claim.record.value;
    try {
      for (let offset = 0, index = 0; offset < bytes.length; offset += CHUNK, index++) {
        const part = bytes.subarray(offset, offset + CHUNK);
        z.object({ state: z.literal("stored"), jobId: z.literal(jobId), chunk: z.literal(index), sha256: z.literal(sha(part)) }).strict().parse(await this.#exec(job, ["put", jobId, String(index), part.toString("base64")]));
      }
      z.object({ state: z.literal("pending"), jobId: z.literal(jobId) }).strict().parse(await this.#exec(job, ["start", jobId, String(Math.ceil(bytes.length / CHUNK))]));
      return { state: "pending", jobId };
    } catch { return { state: "unknown", jobId }; }
  }
  async observe(request: WorkerRunRequest): Promise<ProductionJobObservation> {
    const job = await this.#original(request);
    try {
      const value = ProductionJobObservationSchema.parse(await this.#exec(job, ["status", job.jobId]));
      if (value.jobId !== job.jobId || ("requestSha256" in value && value.requestSha256 !== job.jobId)) throw new Error("PRODUCTION_JOB_RESPONSE_MISMATCH");
      return value;
    } catch { return { state: "unknown", jobId: job.jobId }; }
  }
  async wait(request: WorkerRunRequest, signal: AbortSignal): Promise<ProductionJobObservation> {
    const job = await this.#original(request);
    for (;;) {
      signal.throwIfAborted();
      const result = await this.observe(request);
      if (result.state === "completed" || result.state === "failed" || result.state === "missing" || (this.input.now ?? Date.now)() >= job.deadlineEpochMs) return result;
      await new Promise<void>((resolve, reject) => { const abort = () => { clearTimeout(timer); reject(new Error("PRODUCTION_JOB_WAIT_ABORTED")); }; const timer = setTimeout(() => { signal.removeEventListener("abort", abort); resolve(); }, 1_000); signal.addEventListener("abort", abort, { once: true }); if (signal.aborted) abort(); });
    }
  }
  async readArtifact(request: WorkerRunRequest) {
    const job = await this.#original(request), observed = await this.observe(request);
    if (observed.state !== "completed") throw new Error("PRODUCTION_JOB_ARTIFACT_UNAVAILABLE");
    const parts: Uint8Array[] = [];
    for (let offset = 0; offset < observed.artifactBytes; offset += CHUNK) {
      const part = z.object({ jobId: z.literal(job.jobId), offset: z.literal(offset), totalBytes: z.literal(observed.artifactBytes), artifactSha256: z.literal(observed.artifactSha256), bytesBase64: z.string().max(32_768) }).strict().parse(await this.#exec(job, ["artifact", job.jobId, String(offset)]));
      const bytes = Buffer.from(part.bytesBase64, "base64"); if (bytes.toString("base64") !== part.bytesBase64 || bytes.length !== Math.min(CHUNK, observed.artifactBytes - offset)) throw new Error("PRODUCTION_JOB_ARTIFACT_CHUNK_INVALID"); parts.push(bytes);
    }
    const bytes = Buffer.concat(parts); if (sha(bytes) !== observed.artifactSha256) throw new Error("PRODUCTION_JOB_ARTIFACT_DIGEST_INVALID");
    const bundle = Bundle.parse(JSON.parse(bytes.toString("utf8")));
    const source = PublishedWorkspaceSource.parse(JSON.parse(job.requestBody));
    validateDirectBundle(source, bundle);
    if (bundle.jobId !== job.jobId || bundle.proposalSha256 !== request.sourceProposalSha256 || bundle.toolchainSha256 !== this.input.toolchainSha256 || new Set(bundle.files.map(file => file.path)).size !== bundle.files.length || !bundle.files.some(file => file.path === "index.html")) throw new Error("PRODUCTION_JOB_ARTIFACT_BINDING_INVALID");
    if (bundle.version !== 1) {
      const requested = request.sourceProposalFiles?.find(file => file.path === "src/capabilities.json");
      if (requested && (bundle.capabilityReceipt.state !== "present" || Buffer.from(bundle.capabilityReceipt.bytesBase64, "base64").toString("utf8") !== requested.content)) throw new Error("PRODUCTION_JOB_CAPABILITY_RECEIPT_MISMATCH");
    }
    let total = 0;
    for (const file of bundle.files) { const content = Buffer.from(file.bytesBase64, "base64"); total += content.length; if (content.length !== file.size || sha(content) !== file.sha256 || content.toString("base64") !== file.bytesBase64 || total > 16_777_216) throw new Error("PRODUCTION_JOB_FILE_INVALID"); }
    bundle.commandEvidence.forEach((entry, index) => { const fact = observed.commands[index]!; if (canonicalJson(entry.argv) !== canonicalJson(fact.argv) || entry.exitCode !== fact.exitCode || sha(entry.stdout) !== fact.stdoutSha256 || sha(entry.stderr) !== fact.stderrSha256) throw new Error("PRODUCTION_JOB_COMMAND_EVIDENCE_INVALID"); });
    return bundle;
  }
  async materializeArtifact(request: WorkerRunRequest, owner: Readonly<{ ownerId: string; accountId: string }>) {
    if (!/^[a-f0-9]{64}$/u.test(owner.ownerId) || !owner.accountId) throw new Error("PRODUCTION_JOB_OWNER_REQUIRED");
    const source = PublishedWorkspaceSource.parse(JSON.parse((await this.#original(request)).requestBody));
    const publication = source.publication === undefined ? {} : { publication: source.publication };
    const bundle = await this.readArtifact(request), distRoot = await mkdtemp(join(tmpdir(), "napplet-cvm-production-artifact-"));
    try {
      for (const file of bundle.files) { const path = join(distRoot, file.path); await mkdir(dirname(path), { recursive: true, mode: 0o700 }); await writeFile(path, Buffer.from(file.bytesBase64, "base64"), { flag: "wx", mode: 0o600 }); }
      return Object.freeze({ accountId: owner.accountId, ownerId: owner.ownerId, ...publication, ...(bundle.version !== 1 ? { capabilityReceipt: bundle.capabilityReceipt } : {}), ...(bundle.version === 3 ? { artifactContract: bundle.artifactContract, conformanceReceipt: bundle.conformanceReceipt, manifestReceipt: bundle.manifestReceipt } : {}), sessionId: request.sessionId, actionId: request.actionId, expectedVersion: request.expectedVersion, proposalSha256: bundle.proposalSha256, toolchainSha256: bundle.toolchainSha256, distRoot, commandEvidence: bundle.commandEvidence.map((entry, index) => ({ name: STEP_NAMES[index]!, exitCode: entry.exitCode, stdout: entry.stdout, stderr: entry.stderr })), cleanup: () => rm(distRoot, { recursive: true, force: true }) });
    } catch (error) { await rm(distRoot, { recursive: true, force: true }); throw error; }
  }
  /** Persist the original fence before writing it; uncertain responses only
   * query that fence, and the immutable supervisor excludes concurrent starts. */
  async fence(request: WorkerRunRequest, bindingSha256: string) {
    Digest.parse(bindingSha256); const job = await this.#original(request);
    const key = `worker-fence:${this.input.workerOperationId}`;
    const identity = sha(canonicalJson({ jobId: job.jobId, bindingSha256, workerResourceId: job.workerResourceId, leaseSha256: job.leaseSha256 }));
    const claimed = await this.input.jobJournal.claim(key, identity, { jobId: job.jobId, bindingSha256 });
    try {
      return z.object({ state: z.enum(["fenced", "pending", "missing"]), jobId: z.literal(job.jobId), fenceSha256: z.literal(bindingSha256) }).strict().parse(await this.#exec(job, [claimed.claimed ? "fence" : "fence-status", job.jobId, bindingSha256]));
    } catch { return { state: "unknown" as const, jobId: job.jobId, fenceSha256: bindingSha256 }; }
  }
  /** Workspace bytes contain only bounded source/artifact data, never financial
   * authority, owner keys or checkpoint encryption keys. The coordinator seals
   * these alongside its independently resolved six remaining inventory classes. */
  async exportWorkspace(request: WorkerRunRequest, bindingSha256: string): Promise<Uint8Array> {
    if ((await this.fence(request, bindingSha256)).state !== "fenced") throw new Error("PRODUCTION_WORKSPACE_FENCE_REQUIRED");
    const job = await this.#original(request), artifact = await this.readArtifact(request);
    const bytes = Buffer.from(canonicalJson(Workspace.parse({ version: 1, source: JSON.parse(job.requestBody), artifact, toolchainSha256: this.input.toolchainSha256 })));
    if (bytes.length > MAX_ARTIFACT_BUNDLE) throw new Error("PRODUCTION_WORKSPACE_LIMIT");
    return new Uint8Array(bytes);
  }
  async restoreWorkspace(input: Readonly<{ operationId: string; bindingSha256: string; bytes: Uint8Array }>) {
    if (!/^[a-z][a-z0-9:_-]{2,240}$/u.test(input.operationId)) throw new Error("PRODUCTION_RESTORE_OPERATION_INVALID");
    Digest.parse(input.bindingSha256);
    if (!(input.bytes instanceof Uint8Array) || input.bytes.length > MAX_ARTIFACT_BUNDLE) throw new Error("PRODUCTION_WORKSPACE_LIMIT");
    const text = new TextDecoder("utf-8", { fatal: true }).decode(input.bytes), workspace = Workspace.parse(JSON.parse(text));
    const archiveSha256 = sha(input.bytes);
    if (canonicalJson(workspace) !== text || workspace.toolchainSha256 !== this.input.toolchainSha256 || workspace.source.toolchainSha256 !== workspace.toolchainSha256 || workspace.artifact.toolchainSha256 !== workspace.toolchainSha256 || workspace.artifact.jobId !== sha(canonicalJson(workspace.source)) || workspace.source.proposalSha256 !== workspace.artifact.proposalSha256) throw new Error("PRODUCTION_WORKSPACE_BINDING_INVALID");
    validateDirectBundle(workspace.source, workspace.artifact);
    if (workspace.artifact.version !== 1) {
      const requested = workspace.source.files.find(file => file.path === "src/capabilities.json");
      const receipt = workspace.artifact.capabilityReceipt;
      if (requested && (receipt.state !== "present" || Buffer.from(receipt.bytesBase64, "base64").toString("utf8") !== requested.content)) throw new Error("PRODUCTION_WORKSPACE_CAPABILITY_RECEIPT_MISMATCH");
    }
    if (new Set(workspace.source.files.map(file => file.path)).size !== workspace.source.files.length || !workspace.source.files.some(file => file.path === "src/main.ts") || new Set(workspace.artifact.files.map(file => file.path)).size !== workspace.artifact.files.length || !workspace.artifact.files.some(file => file.path === "index.html")) throw new Error("PRODUCTION_WORKSPACE_FILES_INVALID");
    let total = 0;
    for (const file of workspace.artifact.files) { const content = Buffer.from(file.bytesBase64, "base64"); total += content.length; if (content.length !== file.size || sha(content) !== file.sha256 || content.toString("base64") !== file.bytesBase64 || total > 16_777_216) throw new Error("PRODUCTION_WORKSPACE_FILES_INVALID"); }
    const worker = await this.#worker();
    const initial: StoredRestore = { workerOperationId: this.input.workerOperationId, workerResourceId: worker.resourceId!, leaseSha256: worker.sessionLeaseSha256!, archiveSha256, bindingSha256: input.bindingSha256 };
    const originalOperationId = `worker-restore:${input.operationId}`, originalIdentitySha256 = sha(canonicalJson(initial));
    const evidence = ProductionRestoreEvidenceSchema.parse({ schemaVersion: "worker-restore-evidence-v1", originalOperationId, originalIdentitySha256,
      expected: { archiveSha256, toolchainSha256: workspace.toolchainSha256, sourceSha256: sha(canonicalJson(workspace.source.files)), artifactFilesSha256: sha(canonicalJson(workspace.artifact.files)) } });
    const claim = await this.input.jobJournal.claimWithCompanion({ operationId: originalOperationId, identitySha256: originalIdentitySha256, value: initial,
      companion: { operationId: `worker-restore-evidence:${input.operationId}`, identitySha256: sha(canonicalJson(evidence)), value: evidence } });
    const job = claim.record.value;
    const validate = (value: unknown) => {
      const observed = RestoreObservation.parse(value);
      if (observed.archiveSha256 !== archiveSha256 || (observed.state === "restored" && (observed.toolchainSha256 !== workspace.toolchainSha256 || observed.sourceSha256 !== sha(canonicalJson(workspace.source.files)) || observed.artifactFilesSha256 !== sha(canonicalJson(workspace.artifact.files))))) throw new Error("PRODUCTION_RESTORE_RESPONSE_INVALID");
      return observed;
    };
    try {
      if (!claim.claimed) return validate(await this.#exec(job, ["restore-status", archiveSha256]));
      for (let offset = 0, index = 0; offset < input.bytes.length; offset += CHUNK, index++) {
        const part = Buffer.from(input.bytes.subarray(offset, offset + CHUNK));
        z.object({ state: z.literal("stored"), archiveSha256: z.literal(archiveSha256), chunk: z.literal(index), sha256: z.literal(sha(part)) }).strict().parse(await this.#exec(job, ["restore-put", archiveSha256, String(index), part.toString("base64")]));
      }
      return validate(await this.#exec(job, ["restore", archiveSha256, String(Math.ceil(input.bytes.length / CHUNK))]));
    } catch { return { state: "unknown" as const, archiveSha256 }; }
  }
  /** Strictly query the original restore claim.  In particular, this never
   * claims a journal record, uploads archive chunks, or sends restore. */
  async observeRestoreWorkspace(input: Readonly<{ operationId: string; archiveSha256: string; bindingSha256: string }>) {
    if (!/^[a-z][a-z0-9:_-]{2,240}$/u.test(input.operationId)) throw new Error("PRODUCTION_RESTORE_OPERATION_INVALID");
    const archiveSha256 = Digest.parse(input.archiveSha256); Digest.parse(input.bindingSha256);
    const record = await this.input.jobJournal.read<StoredRestore>(`worker-restore:${input.operationId}`);
    if (!record || record.identitySha256 !== sha(canonicalJson({ workerOperationId: record.value.workerOperationId, workerResourceId: record.value.workerResourceId, leaseSha256: record.value.leaseSha256, archiveSha256, bindingSha256: input.bindingSha256 })) || record.value.workerOperationId !== this.input.workerOperationId || record.value.archiveSha256 !== archiveSha256 || record.value.bindingSha256 !== input.bindingSha256) return { state: "unknown" as const, archiveSha256 };
    const companion = await this.input.jobJournal.read(`worker-restore-evidence:${input.operationId}`);
    const evidence = ProductionRestoreEvidenceSchema.safeParse(companion?.value);
    if (!companion || companion.revision !== 1 || !evidence.success || companion.identitySha256 !== sha(canonicalJson(evidence.data))
      || evidence.data.originalOperationId !== record.operationId || evidence.data.originalIdentitySha256 !== record.identitySha256
      || evidence.data.expected.archiveSha256 !== archiveSha256) return { state: "unknown" as const, archiveSha256 };
    try {
      const observed = RestoreObservation.parse(await this.#exec(record.value, ["restore-status", archiveSha256]));
      if (observed.archiveSha256 !== archiveSha256 || (observed.state === "restored" && (observed.toolchainSha256 !== evidence.data.expected.toolchainSha256
        || observed.sourceSha256 !== evidence.data.expected.sourceSha256 || observed.artifactFilesSha256 !== evidence.data.expected.artifactFilesSha256)))
        return { state: "unknown" as const, archiveSha256 };
      return observed;
    } catch { return { state: "unknown" as const, archiveSha256 }; }
  }
  /** Called only after the coordinator commits encrypted checkpoint ownership.
   * Provider transports reconcile deletion of their exact original resource. */
  async terminate() {
    return this.input.clients[this.input.provider].terminate({ operationId: this.input.workerOperationId });
  }
}
