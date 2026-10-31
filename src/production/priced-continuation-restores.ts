import { createHash } from "node:crypto";
import { z } from "zod";
import { bindAccountingRealmPool, createAccountingRealm } from "../funding/accounting-realm";
import { PostgresSqlFundingStore, type PostgresSqlClient, type PostgresSqlPool } from "../persistence/postgres-sql-funding-store";
import { canonicalJson } from "../promotion/schema";
import { PostgresOperationJournal, assertPostgresOperationJournal } from "../release/deployment/postgres-operation-journal";
import { ProductionRestoreEvidenceSchema } from "../worker-adapters/production-job-client";
import { ProductionCheckpointCoordinator } from "./checkpoint-coordinator";
import { ProductionPricedContinuationWorkers } from "./priced-continuation-workers";
import { pricedRestoreBinding, PricedRestoreMetadataSchema } from "./priced-restore-binding";
import { ProductionResumeAcceptance } from "./resume-acceptance";
import { ProductionResumePricingPreparer } from "./resume-pricing-preparer";
import type { ProductionWorkerBridge } from "./worker-bridge";

const Digest = z.string().regex(/^[a-f0-9]{64}$/u);
const Proof = z.discriminatedUnion("kind", [z.object({ kind: z.literal("command"), commandSha256: Digest }).strict(),
  z.object({ kind: z.literal("workspace"), nativeEvidenceSha256: Digest }).strict()]);
const RecordSchema = z.object({ claimReference: z.string().min(1), accountId: z.string().min(1), restoreOperationId: z.string().min(1), metadataSha256: Digest,
  metadata: PricedRestoreMetadataSchema, manifestSha256: Digest, commandSha256: Digest, payloadKind: z.enum(["pending_command", "workspace"]),
  state: z.enum(["claimed", "unknown", "restored"]), proof: Proof.nullable() }).strict();
export type PricedContinuationRestore = z.infer<typeof RecordSchema>;
const sha = (value: unknown) => createHash("sha256").update(canonicalJson(value)).digest("hex");

/** Durable restore lifecycle, never an admission queue or a usage receipt.
 * A lost/unknown original intent is observed only; it cannot authorize a
 * replacement upload/restore. Actual terminal accounting remains separate. */
export class ProductionPricedContinuationRestores {
  readonly #pool: PostgresSqlPool;
  readonly #funding: PostgresSqlFundingStore;
  constructor(private readonly input: Readonly<{ pool: PostgresSqlPool; acceptance: ProductionResumeAcceptance; preparer: ProductionResumePricingPreparer;
    workers: ProductionPricedContinuationWorkers; checkpoint: ProductionCheckpointCoordinator; jobJournal: PostgresOperationJournal;
    worker: Pick<ProductionWorkerBridge, "registerContinuationRequest" | "restorePricedCheckpoint" | "observePricedRestoreCheckpoint" | "repairPricedRestoreCheckpoint"> }>) {
    assertPostgresOperationJournal(input.jobJournal);
    this.#pool = bindAccountingRealmPool(input.pool, createAccountingRealm("production-real"));
    this.#funding = new PostgresSqlFundingStore(this.#pool, { deadlineMs: 5000, maxAttempts: 4 });
  }

  async assertReady(): Promise<void> {
    await this.input.workers.assertReady();
    const client = await this.#pool.connect();
    try {
      const row = (await client.query<{ permitted: boolean; guarded: number }>(`SELECT
        (has_table_privilege(current_user,'production_real.priced_continuation_restores','SELECT')
          AND has_table_privilege(current_user,'production_real.priced_continuation_restores','INSERT')
          AND NOT has_table_privilege(current_user,'production_real.priced_continuation_restores','DELETE,TRUNCATE')
          AND NOT EXISTS(SELECT 1 FROM pg_catalog.pg_attribute a WHERE a.attrelid='production_real.priced_continuation_restores'::regclass AND a.attnum>0 AND NOT a.attisdropped
            AND a.attname NOT IN ('state','proof_json','updated_at') AND has_column_privilege(current_user,a.attrelid,a.attname,'UPDATE'))
          AND NOT has_table_privilege(current_user,'production_real.priced_continuation_restore_audit','INSERT,UPDATE,DELETE,TRUNCATE')) AS permitted,
        (SELECT count(*)::int FROM pg_catalog.pg_trigger t JOIN pg_catalog.pg_class c ON c.oid=t.tgrelid
          JOIN pg_catalog.pg_namespace n ON n.oid=c.relnamespace JOIN pg_catalog.pg_proc p ON p.oid=t.tgfoid
          JOIN pg_catalog.pg_namespace pn ON pn.oid=p.pronamespace WHERE n.nspname='production_real' AND pn.nspname=n.nspname AND t.tgenabled IN ('O','A') AND NOT t.tgisinternal AND
          ((c.relname='priced_continuation_restores' AND t.tgname='priced_restore_guard' AND p.proname='guard_priced_restore') OR
           (c.relname='priced_continuation_restores' AND t.tgname='priced_restore_audit' AND p.proname='audit_priced_restore') OR
           (c.relname='priced_continuation_restore_audit' AND t.tgname='priced_restore_audit_immutable' AND p.proname='reject_phase04_append_only_change') OR
           (c.relname='release_operation_journal' AND t.tgname='priced_restored_api_claim_fence' AND p.proname='fence_priced_restored_api_claim'))) AS guarded`)).rows[0];
      if (!row?.permitted || row.guarded !== 4) throw new Error("PRODUCTION_PRICED_RESTORE_SCHEMA_REQUIRED");
    } finally { client.release(); }
  }

  async read(accountId: string, claimReference: string): Promise<PricedContinuationRestore | undefined> {
    const client = await this.#pool.connect();
    try { return await this.#read(client, accountId, claimReference); } finally { client.release(); }
  }

  async restore(accountId: string, idempotencyKey: string): Promise<Readonly<{ status: "restored"; restore: PricedContinuationRestore }> | Readonly<{ status: "reconciliation_pending" }>> {
    const claim = await this.input.acceptance.find(accountId, idempotencyKey);
    if (!claim || (claim.state !== "accepted" && claim.state !== "dispatching")) throw new Error("PRICED_RESTORE_NOT_FOUND_OR_DENIED");
    const prior = await this.read(accountId, claim.claimReference);
    if (prior?.state === "restored") return { status: "restored", restore: prior };
    const authority = await this.input.preparer.loadAcceptedAuthority({ principal: { id: accountId }, idempotencyKey });
    const allocation = await this.input.workers.read(accountId, claim.claimReference);
    if (!allocation || Date.parse(allocation.expiresAt) <= Date.now()) throw new Error("PRICED_RESTORE_ALLOCATION_REQUIRED");
    const manifest = authority.material.manifest;
    const binding = pricedRestoreBinding({ accountId, sessionId: claim.sessionId, actionId: claim.actionId, expectedVersion: claim.quote.context.expectedSessionVersion,
      policyVersion: claim.quote.context.policyVersion, capabilityGrant: "phase-05-continuation-grant", workspaceId: `workspace:${claim.sessionId}`,
      checkpointId: claim.checkpointId, pauseGeneration: manifest.pauseGeneration, actionVersion: manifest.actionVersion, workspaceLineage: manifest.workspaceLineage,
      leaseToken: claim.leaseToken, resumeClaim: claim.allocationIntentReference, archiveSha256: manifest.archiveSha256 });
    const expected = RecordSchema.parse({ claimReference: claim.claimReference, accountId, restoreOperationId: binding.operationId, metadataSha256: binding.bindingSha256,
      metadata: binding.metadata, manifestSha256: authority.context.checkpointSha256, commandSha256: authority.context.commandSha256,
      payloadKind: manifest.payloadKind ?? "workspace", state: "claimed", proof: null });
    const dispatch = await this.#funding.transactWithSql(accountId, async (_tx, client) => {
      const existing = await this.#read(client, accountId, claim.claimReference);
      if (existing) { this.#same(existing, expected); return false; }
      await client.query(`INSERT INTO production_real.priced_continuation_restores(claim_reference,account_id,restore_operation_id,metadata_sha256,metadata_json,manifest_sha256,command_sha256,payload_kind,state)
        VALUES($1,$2,$3,$4,$5::jsonb,$6,$7,$8,'claimed')`, [expected.claimReference, accountId, expected.restoreOperationId, expected.metadataSha256,
        canonicalJson(expected.metadata), expected.manifestSha256, expected.commandSha256, expected.payloadKind]);
      return true;
    });
    let proof: z.infer<typeof Proof> | undefined;
    if (expected.payloadKind === "pending_command") proof = { kind: "command", commandSha256: authority.context.commandSha256 };
    else {
      let restored = false;
      try {
        if (dispatch) {
          await this.input.worker.registerContinuationRequest({ accountId, sessionId: claim.sessionId, sourceActionId: manifest.action.actionId,
            actionId: claim.actionId, expectedVersion: binding.metadata.expectedVersion, policyVersion: binding.metadata.policyVersion, workspaceId: binding.metadata.workspaceId });
          const archive = await this.input.checkpoint.restore({ checkpointId: claim.checkpointId, accountId, sessionId: claim.sessionId });
          const transferArchive = new Uint8Array(archive);
          try { restored = (await this.input.worker.restorePricedCheckpoint({ ...binding.metadata, archive: transferArchive })).status === "restored"; }
          finally { transferArchive.fill(0); archive.fill(0); }
        } else {
          const observed = await this.input.worker.observePricedRestoreCheckpoint(binding.metadata);
          restored = observed.status === "restored" || observed.status === "pending" && (await this.input.worker.repairPricedRestoreCheckpoint(binding.metadata)).status === "restored";
        }
        if (restored) {
          const native = await this.input.jobJournal.read(`worker-restore-evidence:${binding.operationId}`);
          const evidence = ProductionRestoreEvidenceSchema.parse(native?.value);
          const original = await this.input.jobJournal.read(evidence.originalOperationId);
          if (!native || native.revision !== 1 || native.identitySha256 !== sha(evidence) || evidence.originalOperationId !== `worker-restore:${binding.operationId}`
            || !original || original.revision !== 1 || original.identitySha256 !== evidence.originalIdentitySha256 || original.identitySha256 !== sha(original.value)
            || evidence.expected.archiveSha256 !== binding.metadata.archiveSha256) throw new Error("PRICED_RESTORE_NATIVE_PROOF_DENIED");
          proof = { kind: "workspace", nativeEvidenceSha256: native.identitySha256 };
        }
      } catch { proof = undefined; }
    }
    return this.#funding.transactWithSql(accountId, async (_tx, client) => {
      await client.query("SELECT claim_reference FROM production_real.priced_continuation_restores WHERE claim_reference=$1 AND account_id=$2 FOR UPDATE", [claim.claimReference, accountId]);
      const saved = await this.#read(client, accountId, claim.claimReference);
      if (!saved) throw new Error("PRICED_RESTORE_READBACK_REQUIRED");
      this.#same(saved, expected);
      if (saved.state === "restored") return { status: "restored" as const, restore: saved };
      if (!proof) {
        await client.query("UPDATE production_real.priced_continuation_restores SET state='unknown' WHERE claim_reference=$1", [claim.claimReference]);
        return { status: "reconciliation_pending" as const };
      }
      await client.query("UPDATE production_real.priced_continuation_restores SET state='restored',proof_json=$2::jsonb WHERE claim_reference=$1", [claim.claimReference, canonicalJson(proof)]);
      const pause = await client.query("UPDATE production_real.continuation_pauses SET state='restored' WHERE account_id=$1 AND session_id=$2 AND pause_generation=$3 AND state IN ('claimed','restored') RETURNING pause_id", [accountId, claim.sessionId, manifest.pauseGeneration]);
      if (!pause.rows[0]) throw new Error("PRICED_RESTORE_PAUSE_BINDING_DENIED");
      const complete = await this.#read(client, accountId, claim.claimReference);
      if (!complete || complete.state !== "restored") throw new Error("PRICED_RESTORE_READBACK_REQUIRED");
      return { status: "restored" as const, restore: complete };
    });
  }

  async #read(client: PostgresSqlClient, accountId: string, claimReference: string): Promise<PricedContinuationRestore | undefined> {
    const row = (await client.query(`SELECT claim_reference AS "claimReference",account_id AS "accountId",restore_operation_id AS "restoreOperationId",
      metadata_sha256 AS "metadataSha256",metadata_json AS metadata,manifest_sha256 AS "manifestSha256",command_sha256 AS "commandSha256",payload_kind AS "payloadKind",state,proof_json AS proof
      FROM production_real.priced_continuation_restores WHERE account_id=$1 AND claim_reference=$2`, [accountId, claimReference])).rows[0];
    if (!row) return undefined;
    const record = RecordSchema.parse(row), binding = pricedRestoreBinding(record.metadata);
    if (record.accountId !== accountId || record.claimReference !== claimReference || record.restoreOperationId !== binding.operationId || record.metadataSha256 !== binding.bindingSha256
      || (record.state === "restored") !== (record.proof !== null) || (record.proof?.kind === "command" && (record.payloadKind !== "pending_command" || record.proof.commandSha256 !== record.commandSha256))
      || (record.proof?.kind === "workspace" && record.payloadKind !== "workspace")) throw new Error("PRICED_RESTORE_BINDING_DENIED");
    return record;
  }
  #same(actual: PricedContinuationRestore, expected: PricedContinuationRestore): void {
    if (canonicalJson({ ...actual, state: "claimed", proof: null }) !== canonicalJson(expected)) throw new Error("PRICED_RESTORE_BINDING_DENIED");
  }
}
