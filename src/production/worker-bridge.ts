import { assertProductionWorkerJobRouter, type ProductionWorkerJobRouter } from "./worker-job-router";
import { createHash } from "node:crypto";
import { z } from "zod";
import type { ObjectStorePort } from "../continuity/object-store";
import type { PostgresSqlPool } from "../persistence/postgres-sql-funding-store";
import { CheckpointExportRequestSchema, CheckpointFenceRequestSchema, CheckpointRestoreRequestSchema, CheckpointTerminationRequestSchema, WorkerRunRequestSchema, WorkerRunResultSchema, type CheckpointExportRequest, type CheckpointExportResult, type CheckpointFenceRequest, type CheckpointFenceResult, type CheckpointRestoreRequest, type CheckpointRestoreResult, type CheckpointTerminationRequest, type CheckpointTerminationResult, type ContinuationWorkerPort, type WorkerRunRequest, type WorkerRunResult } from "../phase-02/contracts";
import type { ArtifactVerifier } from "../phase-02/trusted-core";
import type { ArtifactContractInput } from "../policy/artifact-contract";
import { evaluateArtifactContract } from "../policy/artifact-contract";
import { canonicalJson } from "../promotion/schema";
import { PostgresOperationJournal, assertPostgresOperationJournal } from "../release/deployment/postgres-operation-journal";
import type { createWorkerDeploymentClients } from "../release/deployment/worker-clients";
import { ProductionWorkerJobClient } from "../worker-adapters/production-job-client";
import type { ProductionWorkerPublication } from "../worker-adapters/publication-metadata";
import { sealProductionWorkerArtifact, sealDirectProductionWorkerArtifact } from "./sealed-worker-artifact";
import { ProductionDirectArtifactVerifier } from "./direct-artifact-verifier";
import { ProductionWorkerRequestStore } from "./worker-request-store";
import { ProductionWorkerArtifactStore } from "./worker-artifact-store";
import { ProductionArtifactVerifier, readVerifiedProductionArtifactFile, type VerifiedProductionArtifact } from "./artifact-verifier";
import { assertProductionPricedContinuationWorkers, type ProductionPricedContinuationWorkers } from "./priced-continuation-workers";
import { pricedRestoreBinding, type PricedRestoreMetadata } from "./priced-restore-binding";
import { artifactCapabilityText } from "./artifact-capability-text";

const Owner = z.object({ accountId: z.string().regex(/^account:[a-f0-9]{64}$/u), ownerId: z.string().regex(/^[a-f0-9]{64}$/u) }).strict();
const Capacity = z.object({ intentReference: z.string().regex(/^capacity-intent:[a-f0-9]{64}$/u), reference: z.string().regex(/^capacity:[a-f0-9]{64}$/u), workerOperationId: z.string().regex(/^capacity-[a-f0-9]{40}$/u), provider: z.enum(["modal", "fly"]), deadlineEpochMs: z.number().int().positive() }).passthrough();
const sha = (value: string | Uint8Array) => createHash("sha256").update(value).digest("hex");

export type ProductionWorkerOwner = z.infer<typeof Owner>;
type ResolvedWorker = ProductionWorkerOwner & Readonly<{ intentReference: string; capacityReference: string; workerOperationId: string; provider: "modal" | "fly" }>;

/** Binds every build to its authoritative funded action and ready capacity row. */
export class ProductionWorkerOwnershipResolver {
  constructor(private readonly input: Readonly<{ pool: PostgresSqlPool; policyVersion: string; capacityJournal?: PostgresOperationJournal; pricedContinuations?: ProductionPricedContinuationWorkers }>) {
    if (!input.pool || typeof input.pool.connect !== "function" || !z.string().min(1).safeParse(input.policyVersion).success) throw new Error("PRODUCTION_WORKER_OWNER_RESOLVER_REQUIRED");
    if (input.capacityJournal) assertPostgresOperationJournal(input.capacityJournal);
    if (input.pricedContinuations) assertProductionPricedContinuationWorkers(input.pricedContinuations);
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
  async resolvePricedRestore(metadata: PricedRestoreMetadata, request: WorkerRunRequest): Promise<ResolvedWorker> {
    if (!this.input.pricedContinuations) throw new Error("PRODUCTION_PRICED_CONTINUATION_WORKERS_REQUIRED");
    const { metadata: checkpoint } = pricedRestoreBinding(metadata);
    if (request.sessionId !== checkpoint.sessionId || request.actionId !== checkpoint.actionId || request.expectedVersion !== checkpoint.expectedVersion
      || request.policyVersion !== checkpoint.policyVersion || request.workspaceId !== checkpoint.workspaceId) throw new Error("PRODUCTION_PRICED_RESTORE_BINDING_DENIED");
    const client = await this.input.pool.connect();
    try {
      const rows = (await client.query(`SELECT c.claim_reference FROM production_real.priced_continuation_claims c
        JOIN production_real.resume_pricing_quotes q ON q.quote_reference=c.quote_reference
        JOIN production_real.continuation_checkpoints cp ON cp.checkpoint_id=c.checkpoint_id AND cp.account_id=c.account_id
        JOIN production_real.continuation_pauses p ON p.account_id=cp.account_id AND p.session_id=cp.session_id AND p.pause_generation=cp.pause_generation
        JOIN production_real.checkpoint_envelopes e ON e.checkpoint_id=cp.checkpoint_id AND e.account_id=c.account_id
        JOIN production_real.priced_continuation_worker_allocations w ON w.claim_reference=c.claim_reference AND w.account_id=c.account_id
        WHERE c.account_id=$1 AND c.session_id=$2 AND c.action_id=$3 AND c.checkpoint_id=$4 AND c.lease_token=$5
          AND c.allocation_intent_reference=$6 AND c.state IN ('accepted','dispatching') AND c.worker_claimed_at_ms IS NOT NULL
          AND cp.expected_session_version=$7 AND cp.pause_generation=$8 AND cp.state='claimed' AND p.state IN ('claimed','restored')
          AND cp.retention_deadline_ms>extract(epoch FROM clock_timestamp())*1000 AND e.state='retained' AND e.retention_until>clock_timestamp()
          AND q.quote_json->'context'->>'policyVersion'=$9 AND e.manifest_json->>'workspaceLineage'=$10
          AND (e.manifest_json->>'actionVersion')::integer=$11 AND e.manifest_json->>'archiveSha256'=$12
          AND COALESCE(e.manifest_json->>'payloadKind','workspace')='workspace' AND w.expires_at>clock_timestamp() LIMIT 2`,
      [checkpoint.accountId, checkpoint.sessionId, checkpoint.actionId, checkpoint.checkpointId, checkpoint.leaseToken, checkpoint.resumeClaim,
        checkpoint.expectedVersion, checkpoint.pauseGeneration, checkpoint.policyVersion, checkpoint.workspaceLineage, checkpoint.actionVersion, checkpoint.archiveSha256])).rows;
      if (rows.length !== 1) throw new Error("PRODUCTION_PRICED_RESTORE_BINDING_DENIED");
    } finally { client.release(); }
    const worker = await this.resolveWorker(request);
    if (worker.accountId !== checkpoint.accountId) throw new Error("PRODUCTION_PRICED_RESTORE_BINDING_DENIED");
    return worker;
  }
  async #ledger(value: WorkerRunRequest): Promise<Readonly<{ owner: ProductionWorkerOwner; intentReference: string; capacityReference: string }>> {
    const request = WorkerRunRequestSchema.parse(value);
    if (request.policyVersion !== this.input.policyVersion || request.capabilityGrant !== "phase-04-coordinator-grant" || request.workspaceId !== `workspace:${request.sessionId}`) throw new Error("PRODUCTION_WORKER_REQUEST_BINDING_INVALID");
    if (request.actionId.startsWith("priced-resume-action:") && !this.input.pricedContinuations) throw new Error("PRODUCTION_PRICED_CONTINUATION_WORKERS_REQUIRED");
    const pricedJoins = this.input.pricedContinuations ? `LEFT JOIN production_real.priced_continuation_claims pc ON pc.account_id=a.account_id AND pc.action_id=a.id
      LEFT JOIN production_real.priced_continuation_worker_allocations pw ON pw.claim_reference=pc.claim_reference AND pw.account_id=a.account_id` : "";
    const capacityReference = this.input.pricedContinuations ? "CASE WHEN pc.claim_reference IS NOT NULL THEN pw.capacity_reference ELSE COALESCE(r.capacity_reference,a.admission_reference) END" : "COALESCE(r.capacity_reference,a.admission_reference)";
    const pricedGuard = this.input.pricedContinuations ? "AND (pc.claim_reference IS NULL OR (pc.state IN ('accepted','dispatching') AND pc.worker_claimed_at_ms IS NOT NULL AND pw.expires_at>clock_timestamp()))" : "";
    const client = await this.input.pool.connect();
    try {
      const rows = await client.query(`SELECT a.account_id,trim(f.nostr_pubkey) AS owner_id,c.intent_reference,c.capacity_reference FROM production_real.metered_actions a JOIN production_real.metered_sessions s ON s.id=a.session_id AND s.account_id=a.account_id JOIN production_real.funding_accounts f ON f.account_id=a.account_id LEFT JOIN production_real.continuation_worker_allocations r ON r.account_id=a.account_id AND r.session_id=a.session_id AND r.action_id=a.id AND r.state='available'
        ${pricedJoins} JOIN production_real.capacity_intents c ON c.account_id=a.account_id AND c.capacity_reference=(${capacityReference})
        WHERE a.session_id=$1 AND a.id=$2 AND a.expected_session_version=$3 AND a.state IN ('prepared','active') AND c.state='available' AND f.accounting_realm='production-real' ${pricedGuard} LIMIT 2`, [request.sessionId, request.actionId, request.expectedVersion]);
      if (rows.rows.length !== 1) throw new Error("PRODUCTION_WORKER_ACTION_OWNER_NOT_FOUND"); const row = rows.rows[0] as Record<string, unknown>;
      return Object.freeze({ owner: Owner.parse({ accountId: row.account_id, ownerId: row.owner_id }), intentReference: z.string().regex(/^capacity-intent:[a-f0-9]{64}$/u).parse(row.intent_reference), capacityReference: z.string().regex(/^capacity:[a-f0-9]{64}$/u).parse(row.capacity_reference) });
    } finally { client.release(); }
  }
}

/** Coordinator-only job bridge: GCS persistence occurs only after independent
 * CLI/conformance and static boundary verification of root-owned bytes. */
export class ProductionWorkerBridge implements ContinuationWorkerPort, ArtifactVerifier {
  readonly #requests: ProductionWorkerRequestStore; readonly #artifacts: ProductionWorkerArtifactStore; readonly #verifier = new ProductionArtifactVerifier();
  constructor(private readonly input: Readonly<{ resolver: ProductionWorkerOwnershipResolver; workers: ReturnType<typeof createWorkerDeploymentClients>; workerJournal: PostgresOperationJournal; jobJournal: PostgresOperationJournal; requestJournal: PostgresOperationJournal; artifactStore: ObjectStorePort; toolchainSha256: string; publication?: ProductionWorkerPublication; jobRouter?: ProductionWorkerJobRouter }>) {
    assertPostgresOperationJournal(input.workerJournal); assertPostgresOperationJournal(input.jobJournal); assertPostgresOperationJournal(input.requestJournal);
    if (!/^[a-f0-9]{64}$/u.test(input.toolchainSha256)) throw new Error("PRODUCTION_WORKER_TOOLCHAIN_REQUIRED");
    if (input.jobRouter) { assertProductionWorkerJobRouter(input.jobRouter); if (!input.jobRouter.toolchainSha256s.includes(input.toolchainSha256)) throw new Error("PRODUCTION_WORKER_TOOLCHAIN_REQUIRED"); }
    this.#requests = new ProductionWorkerRequestStore(input.requestJournal);
    this.#artifacts = new ProductionWorkerArtifactStore({ journal: input.requestJournal, objects: input.artifactStore, toolchainSha256: input.toolchainSha256, retainedToolchainSha256s: input.jobRouter?.toolchainSha256s });
  }
  async prepareRunRequest(value: WorkerRunRequest, purpose: string): Promise<WorkerRunRequest> {
    const request = WorkerRunRequestSchema.parse(value);
    const job = await this.#job(await this.input.resolver.resolveWorker(request));
    if (job.artifactContract === "legacy-aggregate-v1") return request;
    const prepared = WorkerRunRequestSchema.parse({ ...request, idea: z.string().trim().min(1).max(4096).parse(purpose) });
    const original = await this.#requests.read(prepared);
    if (original && canonicalJson(original) !== canonicalJson(prepared)) throw new Error("PRODUCTION_CHECKPOINT_REQUEST_BINDING_INVALID");
    return prepared;
  }
  async run(value: WorkerRunRequest, signal: AbortSignal): Promise<WorkerRunResult> {
    let request: WorkerRunRequest; try { request = WorkerRunRequestSchema.parse(value); } catch { return { status: "unavailable", code: "WORKER_UNAVAILABLE" }; }
    if (signal.aborted) return { status: "interrupted", code: "WORKER_INTERRUPTED" };
    try {
      await this.#persist(request);
      const original = await this.#artifacts.read(request); if (original) return original.result;
      const worker = await this.input.resolver.resolveWorker(request); const job = await this.#job(worker); const started = await job.start(request);
      if (started.state === "missing") return { status: "unavailable", code: "WORKER_UNAVAILABLE" };
      // START may have succeeded before its acknowledgment was lost. The job
      // claim owns that ambiguity: wait only observes the same immutable job,
      // under its original deadline, without another upload or START.
      const observed = await job.wait(request, signal);
      if (observed.state === "pending" || observed.state === "unknown") return { status: "interrupted", code: "WORKER_INTERRUPTED" };
      if (observed.state !== "completed") return { status: "unavailable", code: "WORKER_UNAVAILABLE" };
      const materialized = await job.materializeArtifact(request, worker);
      try {
        if (materialized.commandEvidence.some(command => Buffer.byteLength(command.stdout) > 40_000 || Buffer.byteLength(command.stderr) > 20_000)) throw new Error("PRODUCTION_ARTIFACT_EVIDENCE_LIMIT");
        const { cleanup: _cleanup, ...facts } = materialized;
        let bytes: Uint8Array, contractInput: ArtifactContractInput, scannerReportSha256: string, conformanceReportSha256: string;
        if (job.artifactContract === "nip5d-direct-v1") {
          const verified = await new ProductionDirectArtifactVerifier().verify(facts);
          if (verified.manifest.content !== request.idea?.trim()) throw new Error("PRODUCTION_DIRECT_PURPOSE_MISMATCH");
          contractInput = await this.#contract(request, verified, verified.declaration);
          bytes = await sealDirectProductionWorkerArtifact(verified); scannerReportSha256 = verified.verificationEvidenceSha256;
          conformanceReportSha256 = verified.conformanceReceipt.sha256;
        } else {
          const verified = await this.#verifier.verify(facts);
          contractInput = await this.#contract(request, verified);
          bytes = await sealProductionWorkerArtifact(verified); scannerReportSha256 = verified.verificationEvidenceSha256;
          conformanceReportSha256 = sha(verified.aggregateSha256);
        }
        if ((await evaluateArtifactContract(contractInput)).verdict !== "pass") throw new Error("PRODUCTION_ARTIFACT_CONTRACT_DENIED");
        const artifactId = `artifact:${sha(bytes)}`;
        const result = WorkerRunResultSchema.parse({ status: "completed", code: "WORKER_PROPOSALS_VALIDATED", events: [{ kind: "progress", turn: 1, detail: `root-owned worker job verified:${scannerReportSha256}` }], artifact: { sessionId: request.sessionId, actionId: request.actionId, expectedVersion: request.expectedVersion, policyVersion: request.policyVersion, capabilityGrant: request.capabilityGrant, workspaceId: request.workspaceId, artifactId, ...contractInput } });
        if (result.status !== "completed") throw new Error("PRODUCTION_ARTIFACT_RESULT_INVALID");
        await new ProductionWorkerArtifactStore({ journal: this.input.requestJournal, objects: this.input.artifactStore, toolchainSha256: job.toolchainSha256 }).persist({ request, accountId: worker.accountId, ownerId: worker.ownerId, bytes, scannerReportSha256, conformanceReportSha256, result }); return result;
      } finally { await materialized.cleanup(); }
    } catch (error) { return signal.aborted || error instanceof DOMException && error.name === "AbortError" ? { status: "interrupted", code: "WORKER_INTERRUPTED" } : { status: "unavailable", code: "WORKER_UNAVAILABLE" }; }
  }
  async verify(facts: Parameters<ArtifactVerifier["verify"]>[0]) {
    try {
      const stored = await this.#artifacts.read(facts.request);
      if (!stored || facts.result.status !== "completed" || canonicalJson(facts.result.artifact) !== canonicalJson(stored.result.artifact)) return undefined;
      const { sessionId: _session, actionId: _action, expectedVersion: _version, policyVersion: _policy, capabilityGrant: _grant, workspaceId: _workspace, artifactId, ...contractInput } = stored.result.artifact;
      return Object.freeze({ artifact: { artifactId, artifactSha256: stored.checksum, scannerReportSha256: stored.scannerReportSha256, conformanceReportSha256: stored.conformanceReportSha256 }, contractInput });
    } catch { return undefined; }
  }
  /** Coordinator-only terminal evidence. Reads the exact real run request and
   * root-verified durable artifact, never an artifact ID supplied by a caller. */
  async readVerifiedContinuationArtifact(input: Readonly<{ accountId: string; sessionId: string; actionId: string; expectedVersion: number; policyVersion: string; workspaceId: string }>) {
    try {
      const request = await this.#request({ ...input, capabilityGrant: "phase-04-coordinator-grant" });
      const owner = await this.input.resolver.resolve(request), stored = await this.#artifacts.read(request);
      if (!stored || owner.accountId !== input.accountId || stored.accountId !== owner.accountId || stored.ownerId !== owner.ownerId) return undefined;
      const { sessionId: _session, actionId: _action, expectedVersion: _version, policyVersion: _policy, capabilityGrant: _grant, workspaceId: _workspace, artifactId, ...contractInput } = stored.result.artifact;
      if ((await evaluateArtifactContract(contractInput)).verdict !== "pass") return undefined;
      return Object.freeze({ artifactId, workspaceLineage: request.workspaceId, validationEvidenceReference: `verification:${artifactId}` });
    } catch { return undefined; }
  }

  async fenceCheckpoint(value: CheckpointFenceRequest): Promise<CheckpointFenceResult> { try { const checkpoint = CheckpointFenceRequestSchema.parse(value), request = await this.#request(checkpoint), result = await (await this.#job(await this.input.resolver.resolveWorker(request))).fence(request, sha(canonicalJson(checkpoint))); return result.state === "fenced" ? { status: "fenced", code: "WORKER_EFFECTS_FENCED" } : { status: "denied", code: "WORKER_CONTINUATION_DENIED" }; } catch { return { status: "denied", code: "WORKER_CONTINUATION_DENIED" }; } }
  async exportCheckpoint(value: CheckpointExportRequest): Promise<CheckpointExportResult> { try { const checkpoint = CheckpointExportRequestSchema.parse(value), request = await this.#request(checkpoint), bytes = await (await this.#job(await this.input.resolver.resolveWorker(request))).exportWorkspace(request, sha(canonicalJson(checkpoint))); const workspace = z.object({ source: z.object({ files: z.array(z.object({ path: z.string() })) }), artifact: z.object({ files: z.array(z.object({ path: z.string() })) }) }).passthrough().parse(JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(bytes))); const inventory = [...workspace.source.files, ...workspace.artifact.files].map(file => file.path).sort(); return { status: "exported", code: "WORKER_CHECKPOINT_EXPORTED", proposal: { ...checkpoint, formatVersion: "portable-checkpoint-v1", inventory, archiveBase64: Buffer.from(bytes).toString("base64"), archiveSha256: sha(bytes), evidenceSha256: sha(canonicalJson(checkpoint)), inventorySha256: sha(canonicalJson(inventory)) } }; } catch { return { status: "denied", code: "WORKER_CONTINUATION_DENIED" }; } }
  async restoreCheckpoint(value: CheckpointRestoreRequest): Promise<CheckpointRestoreResult> { try { const checkpoint = CheckpointRestoreRequestSchema.parse(value), request = await this.#request(checkpoint), result = await (await this.#job(await this.input.resolver.resolveWorker(request))).restoreWorkspace({ operationId: `restore:${checkpoint.checkpointId}`, bindingSha256: sha(canonicalJson(checkpoint)), bytes: checkpoint.archive }); return result.state === "restored" ? { status: "restored", code: "WORKER_CHECKPOINT_RESTORED", workspaceId: request.workspaceId, workspaceLineage: checkpoint.workspaceLineage } : { status: "denied", code: "WORKER_CONTINUATION_DENIED" }; } catch { return { status: "denied", code: "WORKER_CONTINUATION_DENIED" }; } }
  /** Query-only recovery for an acknowledgement lost after the original
   * restore.  It is deliberately separate from restoreCheckpoint so recovery
   * cannot upload or dispatch another workspace restore. */
  async observeRestoreCheckpoint(value: Omit<CheckpointRestoreRequest, "archive"> & Readonly<{ archiveSha256: string }>): Promise<Readonly<{ status: "restored" | "pending" | "unknown"; workerId?: string }>> {
    try {
      const checkpoint = CheckpointRestoreRequestSchema.omit({ archive: true }).extend({ archiveSha256: z.string().regex(/^[a-f0-9]{64}$/u) }).parse(value);
      const request = await this.#request(checkpoint);
      const result = await (await this.#job(await this.input.resolver.resolveWorker(request))).observeRestoreWorkspace({ operationId: `restore:${checkpoint.checkpointId}`, archiveSha256: checkpoint.archiveSha256, bindingSha256: sha(canonicalJson(checkpoint)) });
      return result.state === "restored" ? Object.freeze({ status: "restored" as const, workerId: request.workspaceId }) : result.state === "pending" ? Object.freeze({ status: "pending" as const }) : Object.freeze({ status: "unknown" as const });
    } catch { return Object.freeze({ status: "unknown" as const }); }
  }
  /** V2 uses one archive-omitted identity for dispatch and observation. V1
   * keys remain unchanged; uncertain original effects are query-only. */
  async restorePricedCheckpoint(value: CheckpointRestoreRequest): Promise<Readonly<{ status: "restored"; workspaceId: string; workspaceLineage: string }> | Readonly<{ status: "reconciliation_pending" }>> {
    try {
      const { archive, ...metadata } = CheckpointRestoreRequestSchema.parse(value), binding = pricedRestoreBinding(metadata);
      if (sha(archive) !== metadata.archiveSha256) throw new Error("PRODUCTION_PRICED_RESTORE_ARCHIVE_DENIED");
      const request = await this.#request(metadata), worker = await this.input.resolver.resolvePricedRestore(binding.metadata, request);
      const result = await (await this.#job(worker)).restoreWorkspace({ operationId: binding.operationId, bindingSha256: binding.bindingSha256, bytes: archive });
      return result.state === "restored" ? { status: "restored", workspaceId: request.workspaceId, workspaceLineage: metadata.workspaceLineage }
        : { status: "reconciliation_pending" };
    } catch { return { status: "reconciliation_pending" }; }
  }
  async observePricedRestoreCheckpoint(value: PricedRestoreMetadata): Promise<Readonly<{ status: "restored" | "pending" | "unknown"; workerId?: string }>> {
    try {
      const binding = pricedRestoreBinding(value), request = await this.#request(binding.metadata);
      const worker = await this.input.resolver.resolvePricedRestore(binding.metadata, request);
      const result = await (await this.#job(worker)).observeRestoreWorkspace({ operationId: binding.operationId, bindingSha256: binding.bindingSha256, archiveSha256: binding.metadata.archiveSha256 });
      return result.state === "restored" ? { status: "restored", workerId: request.workspaceId } : result.state === "pending" ? { status: "pending" } : { status: "unknown" };
    } catch { return { status: "unknown" }; }
  }
  /** Explicit same-worker recovery of a native restore that is already
   * journaled and claimed. It has no archive upload or dispatch authority. */
  async repairPricedRestoreCheckpoint(value: PricedRestoreMetadata): Promise<Readonly<{ status: "restored" | "pending" | "unknown"; workerId?: string }>> {
    try {
      const binding = pricedRestoreBinding(value), request = await this.#request(binding.metadata);
      const worker = await this.input.resolver.resolvePricedRestore(binding.metadata, request);
      const result = await (await this.#job(worker)).repairRestoreWorkspace({ operationId: binding.operationId, bindingSha256: binding.bindingSha256, archiveSha256: binding.metadata.archiveSha256 });
      return result.state === "restored" ? { status: "restored", workerId: request.workspaceId } : result.state === "pending" ? { status: "pending" } : { status: "unknown" };
    } catch { return { status: "unknown" }; }
  }
  async terminateCheckpoint(value: CheckpointTerminationRequest): Promise<CheckpointTerminationResult> { try { const request = await this.#request(CheckpointTerminationRequestSchema.parse(value)), result = await (await this.#job(await this.input.resolver.resolveWorker(request))).terminate(); return result.status === "terminated" ? { status: "terminated", code: "WORKER_LEASE_TERMINATED" } : { status: "denied", code: "WORKER_CONTINUATION_DENIED" }; } catch { return { status: "denied", code: "WORKER_CONTINUATION_DENIED" }; } }
  /** Correlates restore with the original durable source request. The new
   * action's run request remains available for its own model proposal. This
   * never creates a worker; capacity must already be durably recorded. */
  async registerContinuationRequest(input: Readonly<{ accountId: string; sessionId: string; sourceActionId: string; actionId: string; expectedVersion: number; policyVersion: string; workspaceId: string }>): Promise<void> {
    const source = await this.#request({ sessionId: input.sessionId, actionId: input.sourceActionId, expectedVersion: input.expectedVersion, policyVersion: input.policyVersion, capabilityGrant: "phase-04-coordinator-grant", workspaceId: input.workspaceId });
    if (source.sessionId !== input.sessionId || source.expectedVersion !== input.expectedVersion || source.policyVersion !== input.policyVersion) throw new Error("PRODUCTION_CONTINUATION_SOURCE_BINDING_INVALID");
    await this.#requests.persistRestore(source, { ...source, actionId: input.actionId, workspaceId: input.workspaceId });
  }
  async #job(worker: ResolvedWorker) {
    if (this.input.jobRouter) return this.input.jobRouter.resolve(worker);
    return new ProductionWorkerJobClient({ provider: worker.provider, workerOperationId: worker.workerOperationId, clients: this.input.workers, workerJournal: this.input.workerJournal, jobJournal: this.input.jobJournal, toolchainSha256: this.input.toolchainSha256, publication: this.input.publication }); }
  async #persist(request: WorkerRunRequest): Promise<void> { await this.#requests.persist(request); }
  async #request(binding: Pick<CheckpointFenceRequest, "sessionId" | "actionId" | "expectedVersion" | "policyVersion" | "capabilityGrant" | "workspaceId">): Promise<WorkerRunRequest> {
    const lookup = { ...binding, capabilityGrant: binding.capabilityGrant === "phase-05-continuation-grant" ? "phase-04-coordinator-grant" : binding.capabilityGrant };
    const stored = await this.#requests.read(lookup) ?? await this.#requests.readRestore(lookup);
    if (!stored) throw new Error("PRODUCTION_CHECKPOINT_REQUEST_BINDING_INVALID");
    for (const property of ["sessionId", "actionId", "expectedVersion", "policyVersion", "workspaceId"] as const) if (stored[property] !== binding[property]) throw new Error("PRODUCTION_CHECKPOINT_REQUEST_BINDING_INVALID");
    if (stored.capabilityGrant !== lookup.capabilityGrant) throw new Error("PRODUCTION_CHECKPOINT_REQUEST_BINDING_INVALID");
    return stored;
  }

  async #contract(request: WorkerRunRequest, verified: Pick<VerifiedProductionArtifact, "files" | "distRoot">, declaration?: Readonly<{ required: readonly string[]; optional: readonly string[] }>): Promise<ArtifactContractInput> {
    const purpose = request.idea?.trim() ?? request.sourceProposalReference;
    if (!purpose) throw new Error("PRODUCTION_ARTIFACT_PURPOSE_REQUIRED"); const source = request.sourceProposalFiles?.map(file => file.content).join("\n") ?? purpose;
    const outputs = await Promise.all(verified.files.map(async file => ({ path: file.path, text: new TextDecoder("utf-8", { fatal: true }).decode(await readVerifiedProductionArtifactFile(verified.distRoot, file)) })));
    const actual = `${source}\n${outputs.map(file => file.text).join("\n")}`;
    // A direct declaration is independently verified metadata. It cannot
    // supply its own evidence that the app actually observes that domain.
    const capabilitySource = declaration ? request.sourceProposalFiles?.filter(file => file.path !== "src/capabilities.json").map(file => file.content).join("\n") ?? purpose : source;
    const capabilityAuthority = `${capabilitySource}\n${(await Promise.all(outputs.map(file => artifactCapabilityText(file.path, file.text)))).join("\n")}`;
    const deny = (pattern: RegExp, code: string) => { if (pattern.test(actual)) throw new Error(code); }; deny(/\b(?:fetch|XMLHttpRequest|WebSocket|EventSource|navigator\.serviceWorker|new\s+(?:Worker|SharedWorker))\b/u, "PRODUCTION_ARTIFACT_NETWORK_OR_WORKER_DENIED"); deny(/\b(?:window\.nostr|nsec[0-9a-z]+|SimplePool|relay\.publish|pool\.publish|nostr-tools)\b/iu, "PRODUCTION_ARTIFACT_SIGNER_RELAY_DENIED"); deny(/\b(?:eval|Function|import)\s*\(/u, "PRODUCTION_ARTIFACT_DYNAMIC_AUTHORITY_DENIED");
    const declaredHard: readonly string[] = declaration?.required ?? [...new Set(request.sourceProposalFiles?.find(file => file.path === "src/capabilities.json")?.content.match(/\b(?:storage|intent)\b/gu) ?? [])];
    const observedDomains: readonly string[] = ["storage", "intent", ...(declaration ? ["gamepad"] : [])].filter(domain => new RegExp(`\\b${domain}\\b`, "iu").test(capabilityAuthority));
    if (observedDomains.some(domain => !declaredHard.includes(domain) && !declaration?.optional.includes(domain)) || declaredHard.some(domain => !observedDomains.includes(domain))) throw new Error("PRODUCTION_ARTIFACT_CAPABILITY_MISMATCH"); const intentPresent = observedDomains.includes("intent"); if (intentPresent && (!/\bif\s*\([^)]*intent/iu.test(capabilityAuthority) || !/@napplet\/sdk/u.test(capabilityAuthority))) throw new Error("PRODUCTION_ARTIFACT_INTENT_BOUNDARY_DENIED");
    return Object.freeze({ purpose: { kind: "focused", statements: [purpose] }, surface: { hasBackend: false, hasSecondPurpose: false, serviceWorker: false, dynamicAuthority: false }, dependencies: { appOwnedSignerOrRelay: false, privateNappletImport: false }, capabilities: { declaredHard, ...(declaration ? { declaredOptional: declaration.optional } : {}), observedDomains, optionalIntentPresenceRead: intentPresent, intentUsedThroughSdk: intentPresent }, upstream: { scanner: { verdict: "pass", checkId: "upstream:cli-verify" }, conformance: { verdict: "pass", checkId: "upstream:chromium-conformance" } } });
  }
}
