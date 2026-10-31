import { createHash } from "node:crypto";
import { z } from "zod";
import { bindAccountingRealmPool, createAccountingRealm } from "../funding/accounting-realm";
import { ProviderOperationIntentSchema, NormalizedUsageReceiptSchema } from "../model/model-gateway";
import { PostgresSqlFundingStore, type PostgresSqlClient, type PostgresSqlPool } from "../persistence/postgres-sql-funding-store";
import { SessionActionResultSchema } from "../phase-04/metered-generation-service";
import { canonicalJson } from "../promotion/schema";
import { assertPostgresOperationJournal, type PostgresOperationJournal } from "../release/deployment/postgres-operation-journal";
import { ProductionPricedContinuationRestores } from "./priced-continuation-restores";
import { ProductionResumeAcceptance } from "./resume-acceptance";
import { createProductionVertexGenerationSettlement } from "./vertex-generation-settlement";
import { ProductionVertexModelGateway } from "./vertex-model-gateway";
import { ProductionWorkerBridge } from "./worker-bridge";

const Identity = z.string().min(1).max(256), Sat = z.string().regex(/^(0|[1-9][0-9]*)$/u);
const Artifact = z.object({ artifactId: Identity.optional(), workspaceLineage: Identity, checkpointReference: Identity, snapshotReference: Identity,
  validationEvidenceReference: Identity, failedArtifactId: Identity.optional(), validationReportReference: Identity.optional() }).strict();
const Command = z.object({ accountId: Identity, idempotencyKey: z.string().min(1).max(160), leaseToken: Identity, allocationIntentReference: Identity,
  intent: ProviderOperationIntentSchema, receipt: NormalizedUsageReceiptSchema,
  finalization: z.object({ idempotencyKey: Identity, operationId: Identity, receiptCharge: Sat, providerReceiptReference: Identity,
    status: z.enum(["completed", "failed"]), result: SessionActionResultSchema, sessionVersion: z.number().int().nonnegative(), artifactVersion: z.number().int().nonnegative(),
    artifact: Artifact.optional() }).strict(),
}).strict();
const hash = (value: unknown) => createHash("sha256").update(canonicalJson(value)).digest("hex");

/** Internal terminal callback. All money arithmetic stays in the shared actor;
 * native usage/accepted FX, restore and artifact authorities supply its facts.
 * No method here dispatches a model, build or replacement worker. */
export class ProductionPricedContinuationFinalizer {
  readonly #pool: PostgresSqlPool;
  readonly #funding: PostgresSqlFundingStore;
  constructor(private readonly input: Readonly<{ pool: PostgresSqlPool; acceptance: ProductionResumeAcceptance; restores: ProductionPricedContinuationRestores;
    gateway: ProductionVertexModelGateway; journal: PostgresOperationJournal; worker: ProductionWorkerBridge }>) {
    assertPostgresOperationJournal(input.journal);
    this.#pool = bindAccountingRealmPool(input.pool, createAccountingRealm("production-real"));
    this.#funding = new PostgresSqlFundingStore(this.#pool, { deadlineMs: 5000, maxAttempts: 4 });
  }
  async assertReady(): Promise<void> {
    await this.input.restores.assertReady();
    const client = await this.#pool.connect();
    try {
      const row = (await client.query<{ permitted: boolean; guarded: number }>(`SELECT
        (has_table_privilege(current_user,'production_real.priced_continuation_finalizations','SELECT')
          AND has_table_privilege(current_user,'production_real.priced_continuation_finalizations','INSERT')
          AND NOT has_table_privilege(current_user,'production_real.priced_continuation_finalizations','UPDATE,DELETE,TRUNCATE')) AS permitted,
        (SELECT count(*)::int FROM pg_catalog.pg_trigger t JOIN pg_catalog.pg_class c ON c.oid=t.tgrelid
          JOIN pg_catalog.pg_namespace n ON n.oid=c.relnamespace JOIN pg_catalog.pg_proc p ON p.oid=t.tgfoid
          JOIN pg_catalog.pg_namespace pn ON pn.oid=p.pronamespace WHERE n.nspname='production_real' AND pn.nspname=n.nspname AND t.tgenabled IN ('O','A') AND NOT t.tgisinternal AND
          c.relname='priced_continuation_finalizations' AND ((t.tgname='priced_finalization_guard' AND p.proname='guard_priced_finalization')
            OR (t.tgname='priced_finalization_immutable' AND p.proname='reject_phase04_append_only_change'))) AS guarded`)).rows[0];
      if (!row?.permitted || row.guarded !== 2) throw new Error("PRODUCTION_PRICED_FINALIZATION_SCHEMA_REQUIRED");
    } finally { client.release(); }
  }

  async complete(raw: unknown) {
    const command = Command.parse(raw), { accountId, idempotencyKey, finalization } = command, requestSha256 = hash(command);
    const client = await this.#pool.connect();
    try {
      const prior = await this.#read(client, accountId, idempotencyKey, requestSha256);
      if (prior) return prior;
    } finally { client.release(); }
    const claim = await this.input.acceptance.find(accountId, idempotencyKey);
    if (!claim || claim.state !== "dispatching" || claim.apiClaimedAtMs === null || command.leaseToken !== claim.leaseToken
      || command.allocationIntentReference !== claim.allocationIntentReference || finalization.idempotencyKey !== claim.actionKey || finalization.operationId !== claim.operationId)
      throw new Error("PRICED_FINALIZATION_BINDING_DENIED");
    const restore = await this.input.restores.read(accountId, claim.claimReference);
    if (!restore || restore.state !== "restored" || restore.metadata.leaseToken !== claim.leaseToken
      || restore.metadata.resumeClaim !== claim.allocationIntentReference || restore.metadata.actionId !== claim.actionId
      || restore.commandSha256 !== claim.quote.context.commandSha256 || restore.manifestSha256 !== claim.quote.context.checkpointSha256)
      throw new Error("PRICED_FINALIZATION_RESTORE_REQUIRED");
    const result = finalization.result;
    if ((result.status !== "completed" && result.status !== "failed") || result.status !== finalization.status || result.accountId !== accountId
      || result.sessionId !== claim.sessionId || result.operationId !== claim.operationId || result.sessionVersion !== finalization.sessionVersion
      || result.artifactVersion !== finalization.artifactVersion || finalization.sessionVersion !== claim.quote.context.expectedSessionVersion + (result.status === "completed" ? 1 : 0)
      || finalization.artifactVersion !== (result.status === "completed" ? finalization.sessionVersion : claim.quote.context.expectedArtifactVersion))
      throw new Error("PRICED_FINALIZATION_VERSION_DENIED");
    if (finalization.artifact && (finalization.artifact.workspaceLineage !== restore.metadata.workspaceLineage
      || finalization.artifact.checkpointReference !== `checkpoint:${claim.sessionId}:${claim.actionId}`
      || finalization.artifact.snapshotReference !== `snapshot:${claim.sessionId}:${claim.actionId}`)) throw new Error("PRICED_FINALIZATION_ARTIFACT_DENIED");
    if (result.status === "completed") {
      const verified = await this.input.worker.readVerifiedContinuationArtifact({ accountId, sessionId: claim.sessionId, actionId: claim.actionId,
        expectedVersion: claim.quote.context.expectedSessionVersion, policyVersion: claim.quote.context.policyVersion, workspaceId: restore.metadata.workspaceId });
      if (!verified || !finalization.artifact || result.artifactId !== verified.artifactId || finalization.artifact.artifactId !== verified.artifactId
        || finalization.artifact.workspaceLineage !== verified.workspaceLineage || finalization.artifact.validationEvidenceReference !== verified.validationEvidenceReference)
        throw new Error("PRICED_FINALIZATION_ARTIFACT_DENIED");
    } else if (finalization.artifact?.artifactId) throw new Error("PRICED_FINALIZATION_ARTIFACT_DENIED");
    const settlement = createProductionVertexGenerationSettlement({ gateway: this.input.gateway, conversion: claim.settlement.conversion,
      journal: this.input.journal, resumeSettlements: this.input.acceptance });
    const converted = await settlement.finalize({ accountId, intent: command.intent, receipt: command.receipt, pricedAmount: "0" });
    if (finalization.receiptCharge !== converted.amount || result.confirmedSpend !== converted.amount || finalization.providerReceiptReference !== converted.providerReceiptReference)
      throw new Error("PRICED_FINALIZATION_RECEIPT_DENIED");
    return this.#funding.transactWithSql(accountId, async (tx, sql) => {
      // Match the provider claim's action/provider -> priced claim lock order.
      await sql.query("SELECT a.id FROM production_real.metered_actions a JOIN production_real.provider_operations o ON o.action_id=a.id WHERE a.account_id=$1 AND a.id=$2 AND o.id=$3 FOR UPDATE OF a,o", [accountId, claim.actionId, claim.operationId]);
      const current = (await sql.query<{ state: string }>("SELECT state FROM production_real.priced_continuation_claims WHERE claim_reference=$1 AND account_id=$2 FOR UPDATE", [claim.claimReference, accountId])).rows[0];
      const prior = await this.#read(sql, accountId, idempotencyKey, requestSha256);
      if (prior) return prior;
      if (current?.state !== "dispatching") throw new Error("PRICED_FINALIZATION_BINDING_DENIED");
      const lifecycle = (await sql.query(`SELECT p.pause_id FROM production_real.continuation_checkpoints cp
        JOIN production_real.continuation_pauses p ON p.account_id=cp.account_id AND p.session_id=cp.session_id AND p.pause_generation=cp.pause_generation
        JOIN production_real.priced_continuation_restores r ON r.claim_reference=$3 AND r.account_id=cp.account_id
        WHERE cp.checkpoint_id=$1 AND cp.account_id=$2 AND cp.state='claimed' AND p.state='restored' AND r.state='restored' FOR UPDATE OF cp,p,r`,
      [claim.checkpointId, accountId, claim.claimReference])).rows[0];
      if (!lifecycle) throw new Error("PRICED_FINALIZATION_RESTORE_REQUIRED");
      const action = await tx.finalizeMeteredAction(finalization);
      if (!action.result || action.status !== finalization.status) throw new Error("PRICED_FINALIZATION_ACCOUNTING_DENIED");
      await sql.query(`INSERT INTO production_real.priced_continuation_finalizations(claim_reference,account_id,request_sha256,receipt_charge_sat,provider_receipt_reference,normalized_receipt_json,settlement_json)
        VALUES($1,$2,$3,$4,$5,$6::jsonb,$7::jsonb)`, [claim.claimReference, accountId, requestSha256, converted.amount, converted.providerReceiptReference,
        canonicalJson(command.receipt), canonicalJson(claim.settlement)]);
      await sql.query("UPDATE production_real.continuation_pauses SET state='completed',live_lease_token=NULL WHERE pause_id=$1", [lifecycle.pause_id]);
      await sql.query("UPDATE production_real.priced_continuation_claims SET state='completed' WHERE claim_reference=$1", [claim.claimReference]);
      await sql.query("INSERT INTO production_real.funding_outbox(outbox_id,aggregate_reference,event_kind,payload_json) VALUES($1,$2,'priced_continuation_terminal',$3::jsonb)",
        [`outbox:priced-resume-terminal:${claim.claimReference}`, claim.claimReference, canonicalJson({ operationId: claim.operationId, accounting: "durably_finalized" })]);
      const saved = await this.#read(sql, accountId, idempotencyKey, requestSha256);
      if (!saved) throw new Error("PRICED_FINALIZATION_READBACK_REQUIRED");
      return saved;
    });
  }

  async #read(client: PostgresSqlClient, accountId: string, idempotencyKey: string, requestSha256: string) {
    const row = (await client.query<{ request_sha256: string; terminal_result: unknown; claim_state: string; pause_state: string }>(`SELECT f.request_sha256,a.terminal_result,c.state AS claim_state,p.state AS pause_state
      FROM production_real.priced_continuation_claims c JOIN production_real.priced_continuation_finalizations f ON f.claim_reference=c.claim_reference AND f.account_id=c.account_id
      JOIN production_real.metered_actions a ON a.id=c.action_id AND a.account_id=c.account_id
      JOIN production_real.continuation_checkpoints cp ON cp.checkpoint_id=c.checkpoint_id AND cp.account_id=c.account_id
      JOIN production_real.continuation_pauses p ON p.account_id=cp.account_id AND p.session_id=cp.session_id AND p.pause_generation=cp.pause_generation
      WHERE c.account_id=$1 AND c.idempotency_key=$2`, [accountId, idempotencyKey])).rows[0];
    if (!row) return undefined;
    if (row.request_sha256 !== requestSha256) throw new Error("PRICED_FINALIZATION_IDENTITY_CONFLICT");
    if (row.claim_state !== "completed" || row.pause_state !== "completed") throw new Error("PRICED_FINALIZATION_ACCOUNTING_DENIED");
    const result = SessionActionResultSchema.parse(row.terminal_result);
    if (result.status !== "completed" && result.status !== "failed") throw new Error("PRICED_FINALIZATION_ACCOUNTING_DENIED");
    return result;
  }
}
