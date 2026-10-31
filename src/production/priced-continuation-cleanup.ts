import { createHash } from "node:crypto";
import { z } from "zod";
import { bindAccountingRealmPool, createAccountingRealm } from "../funding/accounting-realm";
import { PostgresSqlFundingStore, type PostgresSqlPool } from "../persistence/postgres-sql-funding-store";
import { canonicalJson } from "../promotion/schema";
import { assertPostgresOperationJournal, type PostgresOperationJournal } from "../release/deployment/postgres-operation-journal";
import type { WorkerOperationRecord } from "../release/deployment/worker-clients";
import { ProductionResumeAcceptance } from "./resume-acceptance";
import { assertProductionReadyCapacity, type ProductionReadyCapacityPort } from "./worker-capacity";
import { PRODUCTION_WORKER_POLICY } from "../worker-adapters/production-worker-policy";

const hash = (value: unknown) => createHash("sha256").update(canonicalJson(value)).digest("hex");
const Digest = z.string().regex(/^[a-f0-9]{64}$/u);
const CleanupBindingSchema = z.object({
  claimReference: z.string().min(1), accountId: z.string().min(1), capacityIntentReference: z.string().min(1), capacityReference: z.string().min(1),
  workerOperationId: z.string().min(1), provider: z.enum(["modal", "fly"]), resourceId: z.string().min(1), requestSha256: Digest,
  image: z.string().min(1), toolchainSha256: Digest, sessionBindingDigest: z.string().regex(/^sha256:[a-f0-9]{64}$/u), deadlineEpochMs: z.number().int().positive(),
  providerCreatedAtMs: z.number().int().positive().optional(),
}).strict();
const TerminalProofSchema = z.object({
  version: z.literal(2), claimReference: z.string().min(1), accountId: z.string().min(1), sessionId: z.string().min(1), checkpointId: z.string().min(1),
  actionId: z.string().min(1), operationId: z.string().min(1), leaseToken: z.string().min(1), allocationIntentReference: z.string().min(1),
  capacityIntentReference: z.string().min(1), capacityReference: z.string().min(1), sessionBindingDigest: z.string().regex(/^sha256:[a-f0-9]{64}$/u),
  expectedSessionVersion: z.number().int().nonnegative(), expectedArtifactVersion: z.number().int().nonnegative(), pauseGeneration: z.number().int().positive(),
  cleanupKey: z.string().min(1), cleanupIdentitySha256: Digest, cleanupRevision: z.literal(1), binding: CleanupBindingSchema,
}).strict();
const TerminalProofContextSchema = TerminalProofSchema.pick({
  claimReference: true, accountId: true, sessionId: true, checkpointId: true, actionId: true, operationId: true, leaseToken: true,
  allocationIntentReference: true, capacityIntentReference: true, capacityReference: true, sessionBindingDigest: true,
  expectedSessionVersion: true, expectedArtifactVersion: true, pauseGeneration: true, cleanupKey: true,
}).strict();
type TerminalProof = z.infer<typeof TerminalProofSchema>;
type TerminalProofContext = z.infer<typeof TerminalProofContextSchema>;
type TerminalProofRecord = Readonly<{ proof_json: unknown; proof_sha256: string; proof_revision: number }>;

/** Paid terminal cleanup only. It never supplies abandonment/refund authority
 * or infers absence from missing SQL/native records. All queries and mutations
 * target the retained original resource after its create returned an ID. */
export class ProductionPricedContinuationCleanup {
  readonly #pool: PostgresSqlPool;
  readonly #funding: PostgresSqlFundingStore;
  constructor(private readonly input: Readonly<{ pool: PostgresSqlPool; acceptance: ProductionResumeAcceptance;
    capacity: ProductionReadyCapacityPort; workerJournal: PostgresOperationJournal; journal: PostgresOperationJournal }>) {
    assertProductionReadyCapacity(input.capacity); assertPostgresOperationJournal(input.workerJournal); assertPostgresOperationJournal(input.journal);
    this.#pool = bindAccountingRealmPool(input.pool, createAccountingRealm("production-real"));
    this.#funding = new PostgresSqlFundingStore(this.#pool, { deadlineMs: 5000, maxAttempts: 4 });
  }

  #validateTerminalProof(row: TerminalProofRecord, context: TerminalProofContext): TerminalProof {
    const proof = TerminalProofSchema.safeParse(row.proof_json);
    if (!proof.success || row.proof_revision !== 1 || !Digest.safeParse(row.proof_sha256).success || row.proof_sha256 !== hash(proof.data)
      || Object.entries(context).some(([field, value]) => proof.data[field as keyof TerminalProofContext] !== value))
      throw new Error("PRICED_CLEANUP_PROOF_BINDING_DENIED");
    return proof.data;
  }

  async #readTerminalProof(context: TerminalProofContext): Promise<TerminalProof | undefined> {
    const client = await this.#pool.connect();
    try {
      const row = (await client.query<TerminalProofRecord>(`SELECT proof_json,proof_sha256,proof_revision
        FROM production_real.priced_continuation_cleanup_proofs WHERE claim_reference=$1 AND account_id=$2`,
      [context.claimReference, context.accountId])).rows[0];
      return row ? this.#validateTerminalProof(row, context) : undefined;
    } finally { client.release(); }
  }

  async #claimTerminalProof(context: TerminalProofContext, binding: z.infer<typeof CleanupBindingSchema>, cleanupIdentitySha256: string, cleanupRevision: number): Promise<TerminalProof> {
    const proof = TerminalProofSchema.parse({ version: 2, ...context, cleanupIdentitySha256, cleanupRevision, binding });
    const proofSha256 = hash(proof);
    const client = await this.#pool.connect();
    try {
      await client.query(`INSERT INTO production_real.priced_continuation_cleanup_proofs(claim_reference,account_id,proof_revision,proof_sha256,proof_json)
        VALUES($1,$2,1,$3,$4::jsonb) ON CONFLICT(claim_reference) DO NOTHING`, [context.claimReference, context.accountId, proofSha256, canonicalJson(proof)]);
      const row = (await client.query<TerminalProofRecord>(`SELECT proof_json,proof_sha256,proof_revision
        FROM production_real.priced_continuation_cleanup_proofs WHERE claim_reference=$1 AND account_id=$2`,
      [context.claimReference, context.accountId])).rows[0];
      if (!row) throw new Error("PRICED_CLEANUP_PROOF_READBACK_REQUIRED");
      return this.#validateTerminalProof(row, context);
    } finally { client.release(); }
  }

  async cleanup(accountId: string, idempotencyKey: string): Promise<Readonly<{ status: "cleaned" | "pending" | "blocked" }>> {
    const claim = await this.input.acceptance.find(accountId, idempotencyKey);
    if (!claim || claim.state !== "completed") throw new Error("PRICED_CLEANUP_NOT_FOUND_OR_DENIED");
    const client = await this.#pool.connect();
    let owned: Readonly<{ capacity_intent_reference: string; capacity_reference: string; session_binding_digest: string; session_id: string; expected_session_version: number; expected_artifact_version: number; pause_generation: number }> | undefined;
    try {
      owned = (await client.query<{ capacity_intent_reference: string; capacity_reference: string; session_binding_digest: string; session_id: string; expected_session_version: number; expected_artifact_version: number; pause_generation: number }>(`SELECT w.capacity_intent_reference,a.capacity_reference,w.session_binding_digest,w.session_id,cp.expected_session_version,cp.expected_artifact_version,cp.pause_generation
        FROM production_real.priced_continuation_worker_intents w
        JOIN production_real.priced_continuation_worker_allocations a ON a.claim_reference=w.claim_reference AND a.account_id=w.account_id
        JOIN production_real.priced_continuation_finalizations f ON f.claim_reference=w.claim_reference AND f.account_id=w.account_id
        JOIN production_real.continuation_checkpoints cp ON cp.checkpoint_id=$3 AND cp.account_id=w.account_id AND cp.session_id=w.session_id
        JOIN production_real.continuation_pauses p ON p.account_id=cp.account_id AND p.session_id=cp.session_id AND p.pause_generation=cp.pause_generation
        WHERE w.claim_reference=$1 AND w.account_id=$2 AND w.action_id=$4 AND w.allocation_intent_reference=$5
          AND a.capacity_intent_reference=w.capacity_intent_reference AND p.state='completed' AND p.live_lease_token IS NULL`,
      [claim.claimReference, accountId, claim.checkpointId, claim.actionId, claim.allocationIntentReference])).rows[0];
    } finally { client.release(); }
    if (!owned || owned.session_id !== claim.sessionId) throw new Error("PRICED_CLEANUP_TERMINAL_REQUIRED");
    const key = `priced-worker-cleanup:${hash({ accountId, claimReference: claim.claimReference })}`;
    const context = TerminalProofContextSchema.parse({
      claimReference: claim.claimReference, accountId, sessionId: claim.sessionId, checkpointId: claim.checkpointId,
      actionId: claim.actionId, operationId: claim.operationId, leaseToken: claim.leaseToken, allocationIntentReference: claim.allocationIntentReference,
      capacityIntentReference: owned.capacity_intent_reference, capacityReference: owned.capacity_reference, sessionBindingDigest: owned.session_binding_digest,
      expectedSessionVersion: Number(owned.expected_session_version), expectedArtifactVersion: Number(owned.expected_artifact_version), pauseGeneration: Number(owned.pause_generation), cleanupKey: key,
    });
    const complete = async (binding: z.infer<typeof CleanupBindingSchema>): Promise<Readonly<{ status: "cleaned" }>> => {
      if (binding.claimReference !== context.claimReference || binding.accountId !== context.accountId || binding.capacityIntentReference !== context.capacityIntentReference
        || binding.capacityReference !== context.capacityReference || binding.sessionBindingDigest !== context.sessionBindingDigest) throw new Error("PRICED_CLEANUP_PROOF_BINDING_DENIED");
      await this.#funding.transactWithSql(accountId, async (tx, sql) => {
        const current = (await sql.query<{ state: string }>("SELECT state FROM production_real.priced_continuation_claims WHERE claim_reference=$1 AND account_id=$2 FOR UPDATE", [claim.claimReference, accountId])).rows[0];
        const intent = await tx.findCapacityIntent(claim.allocationIntentReference);
        if (current?.state !== "completed" || !intent || intent.intentReference !== binding.capacityIntentReference || intent.capacityReference !== binding.capacityReference
          || (intent.state !== "available" && intent.state !== "released")) throw new Error("PRICED_CLEANUP_CAPACITY_BINDING_DENIED");
        if (intent.state !== "released") await tx.releaseCapacityIntent(binding.capacityIntentReference);
        const outboxId = `outbox:priced-worker-cleanup:${claim.claimReference}`;
        await sql.query(`INSERT INTO production_real.funding_outbox(outbox_id,aggregate_reference,event_kind,payload_json)
          VALUES($1,$2,'priced_continuation_worker_cleaned',$3::jsonb) ON CONFLICT(outbox_id) DO NOTHING`, [outboxId, claim.claimReference, canonicalJson(binding)]);
        const saved = (await sql.query<{ aggregate_reference: string; event_kind: string; payload_json: unknown }>("SELECT aggregate_reference,event_kind,payload_json FROM production_real.funding_outbox WHERE outbox_id=$1", [outboxId])).rows[0];
        if (!saved || saved.aggregate_reference !== claim.claimReference || saved.event_kind !== "priced_continuation_worker_cleaned"
          || canonicalJson(saved.payload_json) !== canonicalJson(binding)) throw new Error("PRICED_CLEANUP_READBACK_REQUIRED");
      });
      return { status: "cleaned" };
    };
    // The SQL-owned proof is shared by standalone and mounted cleanup
    // facades. A valid record is sufficient for the terminal ledger/outbox
    // tail, so replay must not inspect a provider-owned resource.
    const terminalProof = await this.#readTerminalProof(context);
    if (terminalProof) return complete(terminalProof.binding);
    const capacity = await this.input.capacity.inspect({ intentReference: owned.capacity_intent_reference });
    if (!capacity || capacity.intentReference !== owned.capacity_intent_reference || capacity.reference !== owned.capacity_reference || capacity.expectedSessionBindingDigest !== owned.session_binding_digest)
      return { status: "blocked" };
    const original = (await this.input.workerJournal.read<WorkerOperationRecord>(capacity.workerOperationId))?.value;
    if (!original?.resourceId || original.operationId !== capacity.workerOperationId || original.provider !== capacity.provider
      || original.sessionLeaseSha256 !== owned.session_binding_digest.slice(7) || original.providerDeadlineEpochMs !== capacity.deadlineEpochMs
      || original.policyVersion !== PRODUCTION_WORKER_POLICY.version || !original.image || !original.toolchainSha256
      || (capacity.execution && (capacity.execution.image !== original.image || capacity.execution.toolchainSha256 !== original.toolchainSha256
        || capacity.execution.policyVersion !== original.policyVersion || (original.provider === "fly" && capacity.execution.flyRegion !== original.region))))
      return { status: "blocked" };
    const binding = CleanupBindingSchema.parse({ claimReference: claim.claimReference, accountId, capacityIntentReference: capacity.intentReference, capacityReference: capacity.reference,
      workerOperationId: original.operationId, provider: capacity.provider, resourceId: original.resourceId, requestSha256: original.requestSha256,
      image: original.image, toolchainSha256: original.toolchainSha256, sessionBindingDigest: capacity.expectedSessionBindingDigest,
      deadlineEpochMs: capacity.deadlineEpochMs, ...(original.providerCreatedAtMs === undefined ? {} : { providerCreatedAtMs: original.providerCreatedAtMs }) });
    const identity = hash(binding);
    const cleanupRecord = await this.input.journal.claim(key, identity, binding);
    const release = { intentReference: capacity.intentReference, reference: capacity.reference };
    const observe = async (): Promise<Awaited<ReturnType<ProductionReadyCapacityPort["observeRelease"]>>> => {
      try { return await this.input.capacity.observeRelease(release); }
      catch { return { status: "unknown" }; }
    };
    const proof = await this.input.journal.read(`${key}:terminated`);
    if (proof && (proof.revision !== 1 || proof.identitySha256 !== identity || canonicalJson(proof.value) !== canonicalJson(binding)))
      throw new Error("PRICED_CLEANUP_PROOF_BINDING_DENIED");
    if (!proof) {
      let observed = await observe();
      if (observed.status === "pending") {
        const dispatch = await this.input.journal.claim(`${key}:dispatch`, identity, binding);
        if (dispatch.claimed) {
          try { await this.input.capacity.release(release); } catch { /* Query the same original after a lost response. */ }
          observed = await observe();
        }
      }
      if (observed.status !== "terminated") return { status: "pending" };
      await this.input.journal.claim(`${key}:terminated`, identity, binding);
    }
    const terminal = await this.#claimTerminalProof(context, binding, identity, cleanupRecord.record.revision);
    return complete(terminal.binding);
  }
}
