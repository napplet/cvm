import { createHash } from "node:crypto";
import { z } from "zod";
import type { ObjectStorePort } from "../continuity/object-store";
import type { PostgresSqlPool } from "../persistence/postgres-sql-funding-store";
import { CheckpointExportRequestSchema, CheckpointFenceRequestSchema, CheckpointRestoreRequestSchema, CheckpointTerminationRequestSchema, WorkerRunRequestSchema, WorkerRunResultSchema, type CheckpointExportRequest, type CheckpointExportResult, type CheckpointFenceRequest, type CheckpointFenceResult, type CheckpointRestoreRequest, type CheckpointRestoreResult, type CheckpointTerminationRequest, type CheckpointTerminationResult, type ContinuationWorkerPort, type WorkerRunRequest, type WorkerRunResult } from "../phase-02/contracts";
import type { ArtifactVerifier } from "../phase-02/trusted-core";
import type { ArtifactContractInput } from "../policy/artifact-contract";
import { canonicalJson } from "../promotion/schema";
import { PostgresOperationJournal, assertPostgresOperationJournal } from "../release/deployment/postgres-operation-journal";
import type { createWorkerDeploymentClients } from "../release/deployment/worker-clients";
import { ProductionWorkerJobClient } from "../worker-adapters/production-job-client";
import { ProductionArtifactVerifier, readVerifiedProductionArtifactFile, type VerifiedProductionArtifact } from "./artifact-verifier";

const Owner = z.object({ accountId: z.string().regex(/^account:[a-f0-9]{64}$/u), ownerId: z.string().regex(/^[a-f0-9]{64}$/u) }).strict();
const Capacity = z.object({ intentReference: z.string().regex(/^capacity-intent:[a-f0-9]{64}$/u), reference: z.string().regex(/^capacity:[a-f0-9]{64}$/u), workerOperationId: z.string().regex(/^capacity-[a-f0-9]{48}$/u), provider: z.enum(["modal", "fly"]), deadlineEpochMs: z.number().int().positive() }).passthrough();
const StoredRequest = z.object({ request: WorkerRunRequestSchema }).strict();
const sha = (value: string | Uint8Array) => createHash("sha256").update(value).digest("hex");
const key = (request: Pick<WorkerRunRequest, "sessionId" | "actionId" | "expectedVersion">) => `worker-request:${sha(canonicalJson(request))}`;

export type ProductionWorkerOwner = z.infer<typeof Owner>;
type ResolvedWorker = ProductionWorkerOwner & Readonly<{ intentReference: string; capacityReference: string; workerOperationId: string; provider: "modal" | "fly" }>;
type Verified = Readonly<{ requestSha256: string; artifactId: string; artifactSha256: string; scannerReportSha256: string; conformanceReportSha256: string; contractInput: ArtifactContractInput }>;

/** Binds every build to its authoritative funded action and ready capacity row. */
export class ProductionWorkerOwnershipResolver {
  constructor(private readonly input: Readonly<{ pool: PostgresSqlPool; policyVersion: string; capacityJournal?: PostgresOperationJournal }>) {
    if (!input.pool || typeof input.pool.connect !== "function" || !z.string().min(1).safeParse(input.policyVersion).success) throw new Error("PRODUCTION_WORKER_OWNER_RESOLVER_REQUIRED");
    if (input.capacityJournal) assertPostgresOperationJournal(input.capacityJournal);
  }
  async resolve(requestValue: WorkerRunRequest): Promise<ProductionWorkerOwner> {
    const request = WorkerRunRequestSchema.parse(requestValue);
    if (request.policyVersion !== this.input.policyVersion || request.capabilityGrant !== "phase-04-coordinator-grant" || request.workspaceId !== `workspace:${request.sessionId}`) throw new Error("PRODUCTION_WORKER_REQUEST_BINDING_INVALID");
    const client = await this.input.pool.connect();
    try {
      const rows = await client.query("SELECT a.account_id,trim(f.nostr_pubkey) AS owner_id FROM production_real.metered_actions a JOIN production_real.metered_sessions s ON s.id=a.session_id AND s.account_id=a.account_id JOIN production_real.funding_accounts f ON f.account_id=a.account_id WHERE a.session_id=$1 AND a.id=$2 AND a.expected_session_version=$3 AND a.state IN ('prepared','active') AND f.accounting_realm='production-real' LIMIT 2", [request.sessionId, request.actionId, request.expectedVersion]);
      if (rows.rows.length !== 1) throw new Error("PRODUCTION_WORKER_ACTION_OWNER_NOT_FOUND"); const row = rows.rows[0] as Record<string, unknown>; return Object.freeze(Owner.parse({ accountId: row.account_id, ownerId: row.owner_id }));
    } finally { client.release(); }
  }
  async resolveWorker(requestValue: WorkerRunRequest): Promise<ResolvedWorker> {
    if (!this.input.capacityJournal) throw new Error("PRODUCTION_WORKER_CAPACITY_JOURNAL_REQUIRED");
    const ledger = await this.#ledger(requestValue); const record = await this.input.capacityJournal.read<unknown>(`capacity-intent:${sha(ledger.intentReference)}`); const capacity = Capacity.parse(record?.value);
    if (capacity.intentReference !== ledger.intentReference || capacity.reference !== ledger.capacityReference || capacity.deadlineEpochMs <= Date.now()) throw new Error("PRODUCTION_WORKER_CAPACITY_BINDING_INVALID");
    return Object.freeze({ ...ledger.owner, intentReference: ledger.intentReference, capacityReference: ledger.capacityReference, workerOperationId: capacity.workerOperationId, provider: capacity.provider });
  }
  async #ledger(value: WorkerRunRequest): Promise<Readonly<{ owner: ProductionWorkerOwner; intentReference: string; capacityReference: string }>> {
    const request = WorkerRunRequestSchema.parse(value);
    if (request.policyVersion !== this.input.policyVersion || request.capabilityGrant !== "phase-04-coordinator-grant" || request.workspaceId !== `workspace:${request.sessionId}`) throw new Error("PRODUCTION_WORKER_REQUEST_BINDING_INVALID");
    const client = await this.input.pool.connect();
    try {
      const rows = await client.query("SELECT a.account_id,trim(f.nostr_pubkey) AS owner_id,c.intent_reference,c.capacity_reference FROM production_real.metered_actions a JOIN production_real.metered_sessions s ON s.id=a.session_id AND s.account_id=a.account_id JOIN production_real.funding_accounts f ON f.account_id=a.account_id LEFT JOIN production_real.continuation_worker_allocations r ON r.account_id=a.account_id AND r.session_id=a.session_id AND r.action_id=a.id AND r.state='available' JOIN production_real.capacity_intents c ON c.account_id=a.account_id AND c.capacity_reference=COALESCE(r.capacity_reference,a.admission_reference) WHERE a.session_id=$1 AND a.id=$2 AND a.expected_session_version=$3 AND a.state IN ('prepared','active') AND c.state='available' AND f.accounting_realm='production-real' LIMIT 2", [request.sessionId, request.actionId, request.expectedVersion]);
      if (rows.rows.length !== 1) throw new Error("PRODUCTION_WORKER_ACTION_OWNER_NOT_FOUND"); const row = rows.rows[0] as Record<string, unknown>;
      return Object.freeze({ owner: Owner.parse({ accountId: row.account_id, ownerId: row.owner_id }), intentReference: z.string().regex(/^capacity-intent:[a-f0-9]{64}$/u).parse(row.intent_reference), capacityReference: z.string().regex(/^capacity:[a-f0-9]{64}$/u).parse(row.capacity_reference) });
    } finally { client.release(); }
  }
}

/** Coordinator-only job bridge: GCS persistence occurs only after independent
 * CLI/conformance and static boundary verification of root-owned bytes. */
export class ProductionWorkerBridge implements ContinuationWorkerPort, ArtifactVerifier {
  readonly #verified = new Map<string, Verified>(); readonly #verifier = new ProductionArtifactVerifier();
  constructor(private readonly input: Readonly<{ resolver: ProductionWorkerOwnershipResolver; workers: ReturnType<typeof createWorkerDeploymentClients>; workerJournal: PostgresOperationJournal; jobJournal: PostgresOperationJournal; requestJournal: PostgresOperationJournal; artifactStore: ObjectStorePort; toolchainSha256: string }>) {
    assertPostgresOperationJournal(input.workerJournal); assertPostgresOperationJournal(input.jobJournal); assertPostgresOperationJournal(input.requestJournal);
    if (!/^[a-f0-9]{64}$/u.test(input.toolchainSha256)) throw new Error("PRODUCTION_WORKER_TOOLCHAIN_REQUIRED");
  }
  async run(value: WorkerRunRequest, signal: AbortSignal): Promise<WorkerRunResult> {
    let request: WorkerRunRequest; try { request = WorkerRunRequestSchema.parse(value); } catch { return { status: "unavailable", code: "WORKER_UNAVAILABLE" }; }
    if (signal.aborted) return { status: "interrupted", code: "WORKER_INTERRUPTED" };
    try {
      await this.#persist(request); const worker = await this.input.resolver.resolveWorker(request); const job = this.#job(worker); const started = await job.start(request);
      if (started.state === "unknown" || started.state === "missing") return { status: "unavailable", code: "WORKER_UNAVAILABLE" };
      const observed = await job.wait(request, signal);
      if (observed.state === "pending" || observed.state === "unknown") return { status: "interrupted", code: "WORKER_INTERRUPTED" };
      if (observed.state !== "completed") return { status: "unavailable", code: "WORKER_UNAVAILABLE" };
      const materialized = await job.materializeArtifact(request, worker);
      try {
        if (materialized.commandEvidence.some(command => Buffer.byteLength(command.stdout) > 40_000 || Buffer.byteLength(command.stderr) > 20_000)) throw new Error("PRODUCTION_ARTIFACT_EVIDENCE_LIMIT");
        const { cleanup: _cleanup, ...facts } = materialized; const verified = await this.#verifier.verify(facts); const contractInput = await this.#contract(request, verified);
        const object = await this.input.artifactStore.createImmutable({ key: `artifacts/${verified.sealedObjectSha256}.json`, bytes: await this.#seal(verified) }); const artifactId = `artifact:${object.checksum}`;
        const result = WorkerRunResultSchema.parse({ status: "completed", code: "WORKER_PROPOSALS_VALIDATED", events: [{ kind: "progress", turn: 1, detail: `root-owned worker job verified:${verified.verificationEvidenceSha256}` }], artifact: { sessionId: request.sessionId, actionId: request.actionId, expectedVersion: request.expectedVersion, policyVersion: request.policyVersion, capabilityGrant: request.capabilityGrant, workspaceId: request.workspaceId, artifactId, ...contractInput } });
        this.#verified.set(key(request), Object.freeze({ requestSha256: sha(canonicalJson(request)), artifactId, artifactSha256: object.checksum, scannerReportSha256: verified.verificationEvidenceSha256, conformanceReportSha256: sha(verified.aggregateSha256), contractInput })); return result;
      } finally { await materialized.cleanup(); }
    } catch (error) { return signal.aborted || error instanceof DOMException && error.name === "AbortError" ? { status: "interrupted", code: "WORKER_INTERRUPTED" } : { status: "unavailable", code: "WORKER_UNAVAILABLE" }; }
  }
  async verify(facts: Parameters<ArtifactVerifier["verify"]>[0]) {
    const stored = this.#verified.get(key(facts.request));
    if (!stored || stored.requestSha256 !== sha(canonicalJson(facts.request)) || facts.result.status !== "completed" || facts.result.artifact.artifactId !== stored.artifactId) return undefined;
    return Object.freeze({ artifact: { artifactId: stored.artifactId, artifactSha256: stored.artifactSha256, scannerReportSha256: stored.scannerReportSha256, conformanceReportSha256: stored.conformanceReportSha256 }, contractInput: stored.contractInput });
  }
  async fenceCheckpoint(value: CheckpointFenceRequest): Promise<CheckpointFenceResult> { try { const checkpoint = CheckpointFenceRequestSchema.parse(value), request = await this.#request(checkpoint), result = await this.#job(await this.input.resolver.resolveWorker(request)).fence(request, sha(canonicalJson(checkpoint))); return result.state === "fenced" ? { status: "fenced", code: "WORKER_EFFECTS_FENCED" } : { status: "denied", code: "WORKER_CONTINUATION_DENIED" }; } catch { return { status: "denied", code: "WORKER_CONTINUATION_DENIED" }; } }
  async exportCheckpoint(value: CheckpointExportRequest): Promise<CheckpointExportResult> { try { const checkpoint = CheckpointExportRequestSchema.parse(value), request = await this.#request(checkpoint), bytes = await this.#job(await this.input.resolver.resolveWorker(request)).exportWorkspace(request, sha(canonicalJson(checkpoint))); const workspace = z.object({ source: z.object({ files: z.array(z.object({ path: z.string() })) }), artifact: z.object({ files: z.array(z.object({ path: z.string() })) }) }).passthrough().parse(JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(bytes))); const inventory = [...workspace.source.files, ...workspace.artifact.files].map(file => file.path).sort(); return { status: "exported", code: "WORKER_CHECKPOINT_EXPORTED", proposal: { ...checkpoint, formatVersion: "portable-checkpoint-v1", inventory, archiveBase64: Buffer.from(bytes).toString("base64"), archiveSha256: sha(bytes), evidenceSha256: sha(canonicalJson(checkpoint)), inventorySha256: sha(canonicalJson(inventory)) } }; } catch { return { status: "denied", code: "WORKER_CONTINUATION_DENIED" }; } }
  async restoreCheckpoint(value: CheckpointRestoreRequest): Promise<CheckpointRestoreResult> { try { const checkpoint = CheckpointRestoreRequestSchema.parse(value), request = await this.#request(checkpoint), result = await this.#job(await this.input.resolver.resolveWorker(request)).restoreWorkspace({ operationId: `restore:${checkpoint.checkpointId}`, bindingSha256: sha(canonicalJson(checkpoint)), bytes: checkpoint.archive }); return result.state === "restored" ? { status: "restored", code: "WORKER_CHECKPOINT_RESTORED", workspaceId: request.workspaceId, workspaceLineage: checkpoint.workspaceLineage } : { status: "denied", code: "WORKER_CONTINUATION_DENIED" }; } catch { return { status: "denied", code: "WORKER_CONTINUATION_DENIED" }; } }
  async terminateCheckpoint(value: CheckpointTerminationRequest): Promise<CheckpointTerminationResult> { try { const request = await this.#request(CheckpointTerminationRequestSchema.parse(value)), result = await this.#job(await this.input.resolver.resolveWorker(request)).terminate(); return result.status === "terminated" ? { status: "terminated", code: "WORKER_LEASE_TERMINATED" } : { status: "denied", code: "WORKER_CONTINUATION_DENIED" }; } catch { return { status: "denied", code: "WORKER_CONTINUATION_DENIED" }; } }
  /** Copies the original durable source request into the newly claimed resume
   * action. It exposes no proposal bytes to callers and never creates a
   * worker; capacity must already be recorded by the continuation coordinator. */
  async registerContinuationRequest(input: Readonly<{ accountId: string; sessionId: string; sourceActionId: string; actionId: string; expectedVersion: number; policyVersion: string; workspaceId: string }>): Promise<void> {
    const source = await this.#request({ sessionId: input.sessionId, actionId: input.sourceActionId, expectedVersion: input.expectedVersion, policyVersion: input.policyVersion, capabilityGrant: "phase-04-coordinator-grant", workspaceId: input.workspaceId });
    if (source.sessionId !== input.sessionId || source.expectedVersion !== input.expectedVersion || source.policyVersion !== input.policyVersion) throw new Error("PRODUCTION_CONTINUATION_SOURCE_BINDING_INVALID");
    await this.#persist(WorkerRunRequestSchema.parse({ ...source, actionId: input.actionId, workspaceId: input.workspaceId }));
  }
  #job(worker: ResolvedWorker) { return new ProductionWorkerJobClient({ provider: worker.provider, workerOperationId: worker.workerOperationId, clients: this.input.workers, workerJournal: this.input.workerJournal, jobJournal: this.input.jobJournal, toolchainSha256: this.input.toolchainSha256 }); }
  async #persist(request: WorkerRunRequest): Promise<void> { await this.input.requestJournal.claim(key(request), sha(canonicalJson(request)), { request }); }
  async #request(binding: Pick<CheckpointFenceRequest, "sessionId" | "actionId" | "expectedVersion" | "policyVersion" | "capabilityGrant" | "workspaceId">): Promise<WorkerRunRequest> {
    const lookup = { ...binding, capabilityGrant: binding.capabilityGrant === "phase-05-continuation-grant" ? "phase-04-coordinator-grant" : binding.capabilityGrant };
    const stored = StoredRequest.parse((await this.input.requestJournal.read<unknown>(key(lookup)))?.value).request;
    for (const property of ["sessionId", "actionId", "expectedVersion", "policyVersion", "workspaceId"] as const) if (stored[property] !== binding[property]) throw new Error("PRODUCTION_CHECKPOINT_REQUEST_BINDING_INVALID");
    if (stored.capabilityGrant !== lookup.capabilityGrant) throw new Error("PRODUCTION_CHECKPOINT_REQUEST_BINDING_INVALID");
    return stored;
  }
  async #seal(verified: VerifiedProductionArtifact): Promise<Uint8Array> { const files = await Promise.all(verified.files.map(async file => ({ path: file.path, sha256: file.sha256, bytesBase64: Buffer.from(await readVerifiedProductionArtifactFile(verified.distRoot, file)).toString("base64") }))); return new TextEncoder().encode(canonicalJson({ version: 1, aggregateSha256: verified.aggregateSha256, sealedObjectSha256: verified.sealedObjectSha256, verificationEvidenceSha256: verified.verificationEvidenceSha256, files })); }
  async #contract(request: WorkerRunRequest, verified: VerifiedProductionArtifact): Promise<ArtifactContractInput> {
    const purpose = request.idea?.trim() ?? request.sourceProposalReference;
    if (!purpose) throw new Error("PRODUCTION_ARTIFACT_PURPOSE_REQUIRED"); const source = request.sourceProposalFiles?.map(file => file.content).join("\n") ?? purpose; const output = (await Promise.all(verified.files.map(file => readVerifiedProductionArtifactFile(verified.distRoot, file).then(bytes => new TextDecoder("utf-8", { fatal: true }).decode(bytes))))).join("\n"); const actual = `${source}\n${output}`;
    const deny = (pattern: RegExp, code: string) => { if (pattern.test(actual)) throw new Error(code); }; deny(/\b(?:fetch|XMLHttpRequest|WebSocket|EventSource|navigator\.serviceWorker|new\s+(?:Worker|SharedWorker))\b/u, "PRODUCTION_ARTIFACT_NETWORK_OR_WORKER_DENIED"); deny(/\b(?:window\.nostr|nsec[0-9a-z]+|SimplePool|relay\.publish|pool\.publish|nostr-tools)\b/iu, "PRODUCTION_ARTIFACT_SIGNER_RELAY_DENIED"); deny(/\b(?:eval|Function|import)\s*\(/u, "PRODUCTION_ARTIFACT_DYNAMIC_AUTHORITY_DENIED");
    const declaredHard = [...new Set((request.sourceProposalFiles?.find(file => file.path === "src/capabilities.json")?.content.match(/\b(?:storage|intent)\b/gu) ?? []))] as ("storage" | "intent")[]; const observedDomains = ([/\bstorage\b/iu.test(actual) ? "storage" : undefined, /\bintent\b/iu.test(actual) ? "intent" : undefined].filter((value): value is "storage" | "intent" => value !== undefined)); if (observedDomains.some(domain => !declaredHard.includes(domain)) || declaredHard.some(domain => !observedDomains.includes(domain))) throw new Error("PRODUCTION_ARTIFACT_CAPABILITY_MISMATCH"); const intentPresent = observedDomains.includes("intent"); if (intentPresent && (!/\bif\s*\([^)]*intent/iu.test(actual) || !/@napplet\/sdk/u.test(actual))) throw new Error("PRODUCTION_ARTIFACT_INTENT_BOUNDARY_DENIED");
    return Object.freeze({ purpose: { kind: "focused", statements: [purpose] }, surface: { hasBackend: false, hasSecondPurpose: false, serviceWorker: false, dynamicAuthority: false }, dependencies: { appOwnedSignerOrRelay: false, privateNappletImport: false }, capabilities: { declaredHard, observedDomains, optionalIntentPresenceRead: intentPresent, intentUsedThroughSdk: intentPresent }, upstream: { scanner: { verdict: "pass", checkId: "upstream:cli-verify" }, conformance: { verdict: "pass", checkId: "upstream:chromium-conformance" } } });
  }
}
