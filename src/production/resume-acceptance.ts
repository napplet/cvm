import { createHash } from "node:crypto";
import { z } from "zod";
import { canonicalJson } from "../promotion/schema";
import { ResumeSessionV2CommandSchema } from "../continuity/resume-v2-contracts";
import { ResumePricingQuoteSchema, verifyStoredResumePricingQuote, type ResumePricingQuote } from "../continuity/resume-pricing";
import { bindAccountingRealmPool, createAccountingRealm } from "../funding/accounting-realm";
import { PostgresSqlFundingStore, type PostgresSqlClient, type PostgresSqlPool } from "../persistence/postgres-sql-funding-store";
import { PendingActionIntentSchema } from "../continuity/contracts";
import { ProductionVertexSettlementBindingSchema } from "./vertex-generation-settlement";
import { ProductionResumePricingPreparer } from "./resume-pricing-preparer";
import { ProductionResumePricingQuotes } from "./resume-pricing-quotes";

const Identity = z.string().min(1).max(256), Digest = z.string().regex(/^[a-f0-9]{64}$/u);
const Claim = z.object({
  claimReference: Identity, accountId: Identity, sessionId: Identity, checkpointId: Identity,
  idempotencyKey: z.string().min(1).max(160), fingerprint: Digest, quoteReference: Identity, quoteSha256: Digest,
  actionKey: Identity, actionId: Identity, operationId: Identity, actionBudgetReference: Identity,
  leaseToken: Identity, allocationIntentReference: Identity,
  acceptedAtMs: z.coerce.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER),
  settlement: ProductionVertexSettlementBindingSchema,
  state: z.enum(["accepted", "dispatching", "superseded", "completed"]), quote: ResumePricingQuoteSchema,
  apiClaimedAtMs: z.coerce.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER).nullable(),
  apiNamespace: Identity.nullable(), apiScopeSha256: Digest.nullable(), apiRequestSha256: Digest.nullable(),
}).strict();
export type AcceptedPricedContinuation = z.infer<typeof Claim>;
type Command = z.infer<typeof ResumeSessionV2CommandSchema>;
const hash = (value: unknown) => createHash("sha256").update(canonicalJson(value)).digest("hex");
const columns = `c.claim_reference AS "claimReference",c.account_id AS "accountId",c.session_id AS "sessionId",c.checkpoint_id AS "checkpointId",
  c.idempotency_key AS "idempotencyKey",c.fingerprint_sha256 AS fingerprint,c.quote_reference AS "quoteReference",c.quote_sha256 AS "quoteSha256",
  c.action_key AS "actionKey",c.action_id AS "actionId",c.operation_id AS "operationId",c.action_budget_reference AS "actionBudgetReference",
  c.lease_token AS "leaseToken",c.allocation_intent_reference AS "allocationIntentReference",c.accepted_at_ms AS "acceptedAtMs",c.settlement_json AS settlement,c.state,q.quote_json AS quote,
  c.api_claimed_at_ms AS "apiClaimedAtMs",c.api_namespace AS "apiNamespace",c.api_scope_sha256 AS "apiScopeSha256",c.api_request_sha256 AS "apiRequestSha256"`;

/** Internal financial preparation for an explicit resume, not public admission
 * or a work queue. The synchronous runner must own capacity/execution/cleanup
 * before exposing any successful v2 result. No model/worker I/O occurs here. */
export class ProductionResumeAcceptance {
  readonly #pool: PostgresSqlPool;
  readonly #funding: PostgresSqlFundingStore;
  constructor(private readonly input: Readonly<{ pool: PostgresSqlPool; quotes: ProductionResumePricingQuotes; preparer: ProductionResumePricingPreparer; now?: () => number }>) {
    this.#pool = bindAccountingRealmPool(input.pool, createAccountingRealm("production-real"));
    this.#funding = new PostgresSqlFundingStore(this.#pool, { deadlineMs: 5000, maxAttempts: 4 });
  }

  async assertReady(): Promise<void> {
    await this.input.quotes.assertReady();
    const client = await this.#pool.connect();
    try {
      const row = (await client.query<{ readable: boolean; insertable: boolean; mutable: boolean; guards: number }>(`SELECT
        has_table_privilege(current_user,'production_real.priced_continuation_claims','SELECT') AS readable,
        has_table_privilege(current_user,'production_real.priced_continuation_claims','INSERT') AS insertable,
        (has_table_privilege(current_user,'production_real.priced_continuation_claims','DELETE,TRUNCATE') OR
          EXISTS(SELECT 1 FROM pg_catalog.pg_attribute a WHERE a.attrelid='production_real.priced_continuation_claims'::regclass
            AND a.attnum>0 AND NOT a.attisdropped AND a.attname NOT IN ('state','updated_at','api_claimed_at_ms','api_namespace','api_scope_sha256','api_request_sha256')
            AND has_column_privilege(current_user,'production_real.priced_continuation_claims',a.attname,'UPDATE')) OR
          has_table_privilege(current_user,'production_real.priced_continuation_audit','INSERT,UPDATE,DELETE,TRUNCATE')) AS mutable,
        (SELECT count(*)::int FROM pg_catalog.pg_trigger t JOIN pg_catalog.pg_class c ON c.oid=t.tgrelid
          JOIN pg_catalog.pg_namespace n ON n.oid=c.relnamespace JOIN pg_catalog.pg_proc p ON p.oid=t.tgfoid
          JOIN pg_catalog.pg_namespace pn ON pn.oid=p.pronamespace WHERE n.nspname='production_real' AND pn.nspname=n.nspname
            AND t.tgenabled IN ('O','A') AND NOT t.tgisinternal AND
            ((c.relname='priced_continuation_claims' AND t.tgname='priced_continuation_guard' AND p.proname='guard_priced_continuation') OR
             (c.relname='priced_continuation_claims' AND t.tgname='priced_continuation_audit' AND p.proname='audit_priced_continuation') OR
             (c.relname='priced_continuation_audit' AND t.tgname='priced_continuation_audit_immutable' AND p.proname='reject_phase04_append_only_change') OR
             (c.relname='provider_operations' AND t.tgname='priced_provider_dispatch_fence' AND p.proname='fence_priced_provider_dispatch') OR
             (c.relname='release_operation_journal' AND t.tgname='priced_vertex_api_claim_fence' AND p.proname='fence_priced_vertex_api_claim'))) AS guards`)).rows[0];
      if (!row?.readable || !row.insertable || row.mutable || row.guards !== 5) throw new Error("PRODUCTION_PRICED_CONTINUATION_SCHEMA_REQUIRED");
    } finally { client.release(); }
  }

  async find(accountId: string, idempotencyKey: string): Promise<AcceptedPricedContinuation | undefined> {
    const client = await this.#pool.connect();
    try { return await this.#read(client, accountId, idempotencyKey); }
    finally { client.release(); }
  }

  /** Historical operation settlement, including after quote expiry. This is a
   * lookup of an accepted binding, never fresh quote or dispatch authority. */
  async readOperation(accountId: string, operationId: string): Promise<AcceptedPricedContinuation | undefined> {
    const client = await this.#pool.connect();
    try {
      const row = (await client.query<{ idempotency_key: string }>("SELECT idempotency_key FROM production_real.priced_continuation_claims WHERE account_id=$1 AND operation_id=$2", [accountId, operationId])).rows[0];
      if (!row) return undefined;
      const claim = await this.#read(client, accountId, row.idempotency_key);
      if (!claim || claim.operationId !== operationId || claim.state === "superseded") throw new Error("PRODUCTION_PRICED_SETTLEMENT_BINDING_DENIED");
      return claim;
    } finally { client.release(); }
  }

  async readSettlement(accountId: string, operationId: string) {
    return (await this.readOperation(accountId, operationId))?.settlement;
  }

  async claim(raw: unknown): Promise<Readonly<{ claim: AcceptedPricedContinuation; replayed: boolean }>> {
    const command = ResumeSessionV2CommandSchema.parse(raw), accountId = command.principal.id;
    const prior = await this.find(accountId, command.idempotencyKey);
    if (prior) { this.#requestMatches(prior, command); return { claim: prior, replayed: true }; }
    let quote: ResumePricingQuote;
    let authority: Awaited<ReturnType<ProductionResumePricingPreparer["loadAuthority"]>>;
    let nowMs: number;
    try {
      const found = await this.input.quotes.findReference(accountId, command.pricingApproval.quoteReference);
      if (!found) throw new Error("RESUME_QUOTE_NOT_FOUND_OR_DENIED");
      quote = found;
      if (command.sessionId !== quote.context.sessionId || command.checkpointId !== quote.context.checkpointId
        || command.expectedSessionVersion !== quote.context.expectedSessionVersion || command.expectedCheckpointVersion !== quote.context.checkpointVersion
        || canonicalJson(command.pendingAction) !== canonicalJson(quote.context.pendingAction)) throw new Error("RESUME_QUOTE_CONTEXT_MISMATCH");
      authority = await this.input.preparer.loadAuthority({ principal: command.principal, sessionId: command.sessionId, checkpointId: command.checkpointId,
        expectedSessionVersion: command.expectedSessionVersion, expectedCheckpointVersion: command.expectedCheckpointVersion, idempotencyKey: quote.preparationKey });
      if (command.capApprovalReference !== authority.intent.admissionReference) throw new Error("RESUME_CAP_APPROVAL_REQUIRED");
      nowMs = (this.input.now ?? Date.now)();
      await verifyStoredResumePricingQuote({ stored: quote, expectedContext: authority.context, approval: command.pricingApproval, nowMs });
    } catch (error) {
      const concurrent = await this.find(accountId, command.idempotencyKey);
      if (concurrent) { this.#requestMatches(concurrent, command); return { claim: concurrent, replayed: true }; }
      throw error;
    }
    const fingerprint = hash(command), suffix = fingerprint;
    const binding = {
      claimReference: `priced-resume:${suffix}`, accountId, sessionId: command.sessionId, checkpointId: command.checkpointId,
      idempotencyKey: command.idempotencyKey, fingerprint, quoteReference: quote.quoteReference, quoteSha256: quote.quoteSha256,
      actionKey: `priced-resume-key:${suffix}`, actionId: `priced-resume-action:${suffix}`, operationId: `priced-resume-operation:${suffix}`,
      actionBudgetReference: `priced-resume-budget:${suffix}`, leaseToken: `priced-resume-lease:${suffix}`, allocationIntentReference: `priced-resume-allocation:${suffix}`,
      acceptedAtMs: nowMs,
    };
    const settlement = ProductionVertexSettlementBindingSchema.parse({ accountId, operationId: binding.operationId, conversion: quote.pricing.conversion,
      acceptedAt: new Date(nowMs).toISOString(), maximumUsdMicros: quote.maximumUsdMicros });
    return this.#funding.transactWithSql(accountId, async (tx, client) => {
      const duplicate = await this.#read(client, accountId, command.idempotencyKey);
      if (duplicate) { this.#requestMatches(duplicate, command); return { claim: duplicate, replayed: true }; }
      const row = (await client.query<{ state: string; intent_json: unknown; expected_session_version: number; expected_artifact_version: number; retention_deadline_ms: string; manifest_reference: string }>(`SELECT c.state,p.intent_json,c.expected_session_version,c.expected_artifact_version,c.retention_deadline_ms,c.manifest_reference
        FROM production_real.continuation_checkpoints c JOIN production_real.continuation_pauses p
          ON p.account_id=c.account_id AND p.session_id=c.session_id AND p.pause_generation=c.pause_generation
        WHERE c.checkpoint_id=$1 AND c.account_id=$2 AND c.session_id=$3 AND p.state='resume_required' FOR UPDATE OF c,p`,
      [command.checkpointId, accountId, command.sessionId])).rows[0];
      if (!row || row.state !== "resume_required" || Number(row.expected_session_version) !== quote.context.expectedSessionVersion
        || Number(row.expected_artifact_version) !== quote.context.expectedArtifactVersion || Number(row.retention_deadline_ms) <= nowMs
        || row.manifest_reference !== authority.checkpoint.manifestReference
        || canonicalJson(PendingActionIntentSchema.parse(row.intent_json)) !== canonicalJson(authority.intent)) throw new Error("RESUME_STALE_OR_CONFLICTING");
      if ((this.input.now ?? Date.now)() >= quote.expiresAtMs) throw new Error("RESUME_QUOTE_EXPIRED");
      const funds = await tx.continuationFundingSnapshot(authority.intent.admissionReference), maximum = BigInt(quote.maximumSat);
      if (funds.availableBalance + funds.remainingCap < maximum) throw new Error("RESUME_BALANCE_INSUFFICIENT");
      if (funds.remainingCap < maximum) throw new Error("RESUME_CAP_INSUFFICIENT");
      const budget = await tx.reserveActionBudget({ accountId, admissionReference: authority.intent.admissionReference, idempotencyKey: binding.actionKey,
        fingerprint, reference: binding.actionBudgetReference, amount: maximum });
      await tx.prepareMeteredAction({ accountId, idempotencyKey: binding.actionKey, fingerprint, sessionId: command.sessionId, actionId: binding.actionId,
        expectedVersion: command.expectedSessionVersion, admissionReference: authority.intent.admissionReference, actionBudgetReference: budget.reference,
        maximum, operationId: binding.operationId, profileId: quote.pricing.profile.id, priceCardId: quote.pricing.card.id });
      await client.query(`INSERT INTO production_real.priced_continuation_claims
        (claim_reference,account_id,session_id,checkpoint_id,idempotency_key,fingerprint_sha256,quote_reference,quote_sha256,action_key,action_id,operation_id,action_budget_reference,lease_token,allocation_intent_reference,accepted_at_ms,settlement_json,state)
        VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16::jsonb,'accepted')`,
      [binding.claimReference, accountId, binding.sessionId, binding.checkpointId, binding.idempotencyKey, fingerprint, binding.quoteReference, binding.quoteSha256,
        binding.actionKey, binding.actionId, binding.operationId, binding.actionBudgetReference, binding.leaseToken, binding.allocationIntentReference, nowMs, canonicalJson(settlement)]);
      await client.query("UPDATE production_real.continuation_checkpoints SET state='claimed' WHERE checkpoint_id=$1 AND account_id=$2", [binding.checkpointId, accountId]);
      await client.query("UPDATE production_real.continuation_pauses SET state='claimed',live_lease_token=NULL WHERE account_id=$1 AND session_id=$2 AND pause_generation=$3", [accountId, binding.sessionId, authority.checkpoint.pauseGeneration]);
      const saved = await this.#read(client, accountId, command.idempotencyKey);
      if (!saved) throw new Error("PRICED_CONTINUATION_READBACK_REQUIRED");
      return { claim: saved, replayed: false };
    });
  }

  async #read(client: PostgresSqlClient, accountId: string, idempotencyKey: string): Promise<AcceptedPricedContinuation | undefined> {
    const row = (await client.query(`SELECT ${columns} FROM production_real.priced_continuation_claims c
      JOIN production_real.resume_pricing_quotes q ON q.quote_reference=c.quote_reference WHERE c.account_id=$1 AND c.idempotency_key=$2`, [accountId, idempotencyKey])).rows[0];
    if (!row) return undefined;
    const record = Claim.parse(row), quote = record.quote;
    if ((record.apiClaimedAtMs === null) !== (record.apiNamespace === null) || (record.apiClaimedAtMs === null) !== (record.apiScopeSha256 === null)
      || (record.apiClaimedAtMs === null) !== (record.apiRequestSha256 === null)) throw new Error("PRICED_CONTINUATION_API_BINDING_INVALID");
    await verifyStoredResumePricingQuote({ stored: quote, expectedContext: quote.context, nowMs: quote.preparedAtMs,
      approval: { quoteReference: quote.quoteReference, quoteSha256: quote.quoteSha256, maximumSat: quote.maximumSat } });
    if (record.accountId !== accountId || record.idempotencyKey !== idempotencyKey || quote.context.accountId !== accountId
      || quote.context.sessionId !== record.sessionId || quote.context.checkpointId !== record.checkpointId
      || quote.quoteReference !== record.quoteReference || quote.quoteSha256 !== record.quoteSha256
      || record.settlement.accountId !== accountId || record.settlement.operationId !== record.operationId
      || record.settlement.maximumUsdMicros !== quote.maximumUsdMicros || Date.parse(record.settlement.acceptedAt) !== record.acceptedAtMs
      || canonicalJson(record.settlement.conversion) !== canonicalJson(quote.pricing.conversion)) throw new Error("PRICED_CONTINUATION_BINDING_INVALID");
    return record;
  }

  #requestMatches(record: AcceptedPricedContinuation, command: Command): void {
    if (record.fingerprint !== hash(command)) throw new Error("IDEMPOTENCY_KEY_CONFLICT");
  }
}
