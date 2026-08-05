import type { AccountStatus, FundedAdmission, FundingResult } from "../phase-03/contracts";
import { AccountStatusSchema, FundingResultSchema } from "../phase-03/contracts";
import { canonicalMeteredTerminalResult, type ActionBudget, type ActionBudgetInput, type AdmissionInput, type BeginDeadlineCheckpointInput, type BillingLineItem, type BillingLineItemPage, type BillingLineItemPageRequest, type CapacityDispatchClaim, type CapacityIntent, type CapacityIntentInput, type CapacityObservationInput, type ContinuationCheckpoint, type ContinuationCheckpointInput, type ContinuationFundingStore, type ContinuationFundingTransaction, type ContinuationPause, type ContinuationPauseInput, type ContinuationRecord, type ContinuationResumeClaim, type ContinuationResumeClaimInput, type CreditInput, type DeletionOutcomeInput, type MeteredAction, type MeteredFinalizeInput, type MeteredFundingStore, type MeteredFundingTransaction, type MeteredOperationClaim, type MeteredSessionRecord, type PrepareMeteredActionInput, type ReconciliationClaim, type RestoreObservationInput, type StoredFundingCommand, type UsageUnknownInput } from "./funding-store";
import { SerializationFailure } from "./postgres-funding-store";

type SqlRow = Record<string, unknown>;
type SqlResult<Row extends SqlRow = SqlRow> = Readonly<{ rows: readonly Row[] }>;
export interface PostgresSqlClient {
  query<Row extends SqlRow = SqlRow>(text: string, values?: readonly unknown[]): Promise<SqlResult<Row>>;
  release(): void;
}
export interface PostgresSqlPool { connect(): Promise<PostgresSqlClient>; }
export type PostgresSqlStoreOptions = Readonly<{ maxAttempts?: number; deadlineMs?: number; now?: () => number }>;

const commandKind = "funding";
const asText = (value: unknown): string => String(value);
const asBigInt = (value: unknown): bigint => BigInt(asText(value));
const first = <T extends SqlRow>(result: SqlResult<T>, code: string): T => { const value = result.rows[0]; if (!value) throw new Error(code); return value; };
const frozen = <T>(value: T): T => Object.freeze(structuredClone(value));
const id = (prefix: string, reference: string) => `${prefix}:${reference}`;
const actionStatus = (state: string): MeteredAction["status"] => state === "active" ? "dispatching" : state === "verified" ? "completed" : state as MeteredAction["status"];
const sessionStatus = (state: string): MeteredSessionRecord["status"] => state === "verified" ? "verified" : state === "active" ? "active" : state as MeteredSessionRecord["status"];
const lineCursor = (accountId: string, item: BillingLineItem) => Buffer.from(JSON.stringify({ v: 1, a: accountId, s: item.sequence, i: item.id })).toString("base64url");
const actionFromRow = (row: SqlRow): MeteredAction => frozen({ accountId: asText(row.account_id), idempotencyKey: asText(row.idempotency_key), fingerprint: asText(row.fingerprint), sessionId: asText(row.session_id), actionId: asText(row.id), expectedVersion: Number(row.expected_session_version), admissionReference: asText(row.admission_reference), actionBudgetReference: asText(row.budget_reference), maximum: asBigInt(row.reservation_sat), operationId: asText(row.operation_id), profileId: asText(row.profile_id), priceCardId: asText(row.price_card_id), status: actionStatus(asText(row.state)), ...(row.receipt_charge !== undefined && row.receipt_charge !== null ? { receiptCharge: asText(row.receipt_charge) } : {}), ...(row.provider_receipt_reference ? { providerReceiptReference: asText(row.provider_receipt_reference) } : {}), ...(row.provider_request_id ? { providerRequestId: asText(row.provider_request_id) } : {}), ...(row.terminal_result ? { result: row.terminal_result } : {}), ...(row.session_version !== undefined && row.session_version !== null ? { sessionVersion: Number(row.session_version) } : {}), ...(row.artifact_version !== undefined && row.artifact_version !== null ? { artifactVersion: Number(row.artifact_version) } : {}), ...(row.remaining_cap_sat !== undefined && row.remaining_cap_sat !== null ? { remainingCap: asText(row.remaining_cap_sat) } : {}), ...(row.remaining_balance_sat !== undefined && row.remaining_balance_sat !== null ? { remainingBalance: asText(row.remaining_balance_sat) } : {}), ...(row.workspace_lineage ? { artifact: { ...(row.artifact_id ? { artifactId: asText(row.artifact_id) } : {}), workspaceLineage: asText(row.workspace_lineage), checkpointReference: asText(row.checkpoint_reference), snapshotReference: asText(row.snapshot_reference), validationEvidenceReference: asText(row.validation_evidence_reference), ...(row.failed_artifact_id ? { failedArtifactId: asText(row.failed_artifact_id) } : {}), ...(row.validation_report_reference ? { validationReportReference: asText(row.validation_report_reference) } : {}) } } : {}) });
const actionFromOperationRow = (row: SqlRow, operationId: string): MeteredAction => actionFromRow({ ...row, operation_id: operationId, profile_id: row.profile_id ?? "unknown", price_card_id: row.price_card_id ?? "unknown" });
const lineItemFromRow = (row: SqlRow): BillingLineItem => frozen({ id: asText(row.id), sequence: asText(row.sequence), accountId: asText(row.account_id), ...(row.session_id ? { sessionId: asText(row.session_id) } : {}), ...(row.action_id ? { actionId: asText(row.action_id) } : {}), ...(row.operation_id ? { operationId: asText(row.operation_id) } : {}), sourceIdentity: asText(row.source_identity), kind: asText(row.kind) as BillingLineItem["kind"], unit: "sat", amount: asText(row.amount_sat), settledAvailable: asText(row.settled_available_sat), held: asText(row.held_sat), sessionSpend: asText(row.session_spend_sat) });
const pauseFromRow = (row: SqlRow): ContinuationPause => frozen({ accountId: asText(row.account_id), sessionId: asText(row.session_id), admissionReference: asText(row.admission_reference), idempotencyKey: asText(row.idempotency_key), fingerprint: asText(row.fingerprint_sha256), pendingFingerprint: asText(row.pending_fingerprint_sha256), expectedSessionVersion: Number(row.expected_session_version), pauseGeneration: Number(row.pause_generation), graceDeadlineMs: Number(row.grace_deadline_ms), ...(row.live_lease_token ? { liveLeaseToken: asText(row.live_lease_token) } : {}), result: row.result_json as ContinuationPause["result"], state: asText(row.state) as ContinuationPause["state"] });
const checkpointFromRow = (row: SqlRow): ContinuationCheckpoint => frozen({ accountId: asText(row.account_id), sessionId: asText(row.session_id), pauseGeneration: Number(row.pause_generation), checkpointId: asText(row.checkpoint_id), expectedSessionVersion: Number(row.expected_session_version), expectedArtifactVersion: Number(row.expected_artifact_version), manifestReference: asText(row.manifest_reference), objectKey: asText(row.object_key), objectGeneration: asText(row.object_generation), objectChecksum: asText(row.object_checksum), keyReference: asText(row.key_reference), compatibilityIdentity: asText(row.compatibility_identity), checkpointCommittedAtMs: Number(row.checkpoint_committed_at_ms), retentionDeadlineMs: Number(row.retention_deadline_ms), state: asText(row.state) as ContinuationCheckpoint["state"] });
const deadlineError = () => new Error("POSTGRES_OPERATION_DEADLINE_EXCEEDED");
async function beforeDeadline<T>(promise: Promise<T>, deadline: number, now: () => number): Promise<T> {
  const remaining = deadline - now();
  if (remaining <= 0) throw deadlineError();
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([promise, new Promise<T>((_, reject) => { timer = setTimeout(() => reject(deadlineError()), remaining); })]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}

class DeadlineSqlClient implements PostgresSqlClient {
  constructor(private readonly client: PostgresSqlClient, private readonly deadline: number, private readonly now: () => number) {}
  query<Row extends SqlRow = SqlRow>(text: string, values?: readonly unknown[]): Promise<SqlResult<Row>> { return beforeDeadline(this.client.query<Row>(text, values), this.deadline, this.now); }
  release(): void { this.client.release(); }
}

/**
 * Real PostgreSQL-wire funding authority.  Every mutating callback executes on
 * one checked-out pg client after `BEGIN ... SERIALIZABLE`; the deterministic
 * map executor remains a test double in its own module.
 */
export class PostgresSqlFundingStore implements MeteredFundingStore, ContinuationFundingStore {
  readonly production = true as const;
  readonly #maxAttempts: number;
  readonly #deadlineMs: number;
  readonly #now: () => number;
  constructor(private readonly pool: PostgresSqlPool, options: PostgresSqlStoreOptions = {}) {
    this.#maxAttempts = options.maxAttempts ?? 3;
    this.#deadlineMs = options.deadlineMs ?? 250;
    this.#now = options.now ?? Date.now;
    if (this.#maxAttempts < 1 || this.#deadlineMs < 1) throw new Error("INVALID_SERIALIZATION_RETRY_POLICY");
  }

  async findRecordedResult(accountId: string, idempotencyKey: string): Promise<StoredFundingCommand | undefined> {
    const deadline = this.#now() + this.#deadlineMs;
    const client = new DeadlineSqlClient(await beforeDeadline(this.pool.connect(), deadline, this.#now), deadline, this.#now);
    try {
      const result = await client.query<{ fingerprint_sha256: string; result_json: FundingResult }>("SELECT fingerprint_sha256, result_json FROM funding_commands WHERE account_id = $1 AND idempotency_key = $2 ORDER BY created_at DESC LIMIT 1", [accountId, idempotencyKey]);
      const row = result.rows[0];
      return row && frozen({ fingerprint: row.fingerprint_sha256, result: FundingResultSchema.parse(row.result_json) });
    } finally { client.release(); }
  }

  async findMeteredAction(accountId: string, idempotencyKey: string): Promise<MeteredAction | undefined> {
    const client = await this.pool.connect();
    try { const row = (await client.query("SELECT account_id,idempotency_key,fingerprint,session_id,id,expected_session_version,admission_reference,budget_reference,reservation_sat,operation_id,profile_id,price_card_id,state,receipt_charge,provider_receipt_reference,terminal_result,session_version,artifact_version,remaining_cap_sat,remaining_balance_sat,artifact_id,workspace_lineage,checkpoint_reference,snapshot_reference,validation_evidence_reference,failed_artifact_id,validation_report_reference FROM metered_actions WHERE account_id=$1 AND idempotency_key=$2", [accountId, idempotencyKey])).rows[0]; return row && actionFromRow(row); } finally { client.release(); }
  }
  async findContinuation(accountId: string, idempotencyKey: string): Promise<ContinuationRecord | undefined> {
    const client = await this.pool.connect();
    try {
      const row = (await client.query("SELECT account_id,session_id,idempotency_key,fingerprint_sha256,pending_fingerprint_sha256,expected_session_version,result_json FROM continuation_pauses WHERE account_id=$1 AND idempotency_key=$2", [accountId, idempotencyKey])).rows[0];
      return row && frozen({ intent: { accountId, sessionId: asText(row.session_id), idempotencyKey, fingerprint: asText(row.fingerprint_sha256), pendingFingerprint: asText(row.pending_fingerprint_sha256), expectedSessionVersion: Number(row.expected_session_version) }, result: row.result_json } as unknown as ContinuationRecord);
    } finally { client.release(); }
  }
  async findContinuationForSession(accountId: string, sessionId: string): Promise<ContinuationRecord | undefined> {
    const client = await this.pool.connect();
    try {
      const row = (await client.query("SELECT account_id,session_id,idempotency_key,fingerprint_sha256,pending_fingerprint_sha256,expected_session_version,result_json FROM continuation_pauses WHERE account_id=$1 AND session_id=$2 ORDER BY pause_generation DESC LIMIT 1", [accountId, sessionId])).rows[0];
      return row && frozen({ intent: { accountId, sessionId, idempotencyKey: asText(row.idempotency_key), fingerprint: asText(row.fingerprint_sha256), pendingFingerprint: asText(row.pending_fingerprint_sha256), expectedSessionVersion: Number(row.expected_session_version) }, result: row.result_json } as unknown as ContinuationRecord);
    } finally { client.release(); }
  }
  async findContinuationCheckpointForSession(accountId: string, sessionId: string): Promise<ContinuationCheckpoint | undefined> {
    const client = await this.pool.connect();
    try {
      const row = (await client.query("SELECT account_id,session_id,pause_generation,checkpoint_id,expected_session_version,expected_artifact_version,manifest_reference,object_key,object_generation,object_checksum,key_reference,compatibility_identity,checkpoint_committed_at_ms,retention_deadline_ms,state FROM continuation_checkpoints WHERE account_id=$1 AND session_id=$2 ORDER BY pause_generation DESC LIMIT 1", [accountId, sessionId])).rows[0];
      return row && checkpointFromRow(row);
    } finally { client.release(); }
  }
  async findDeletionOutcome(checkpointId: string, objectGeneration: string): Promise<DeletionOutcomeInput | undefined> {
    const client = await this.pool.connect();
    try {
      const row = (await client.query("SELECT checkpoint_id,object_generation,state FROM continuation_deletions WHERE checkpoint_id=$1 AND object_generation=$2", [checkpointId, objectGeneration])).rows[0];
      return row && frozen({ checkpointId: asText(row.checkpoint_id), objectGeneration: asText(row.object_generation), state: asText(row.state) as DeletionOutcomeInput["state"] });
    } finally { client.release(); }
  }
  async findMeteredActionByOperation(accountId: string, operationId: string): Promise<MeteredAction | undefined> {
    const client = await this.pool.connect();
    try { const row = (await client.query("SELECT a.account_id,a.idempotency_key,a.fingerprint,a.session_id,a.id,a.expected_session_version,a.admission_reference,a.budget_reference,a.reservation_sat,a.operation_id,a.profile_id,a.price_card_id,a.state,a.receipt_charge,a.provider_receipt_reference,a.terminal_result,a.session_version,a.artifact_version,a.remaining_cap_sat,a.remaining_balance_sat,a.artifact_id,a.workspace_lineage,a.checkpoint_reference,a.snapshot_reference,a.validation_evidence_reference,a.failed_artifact_id,a.validation_report_reference,o.provider_request_id FROM metered_actions a JOIN provider_operations o ON o.id=a.operation_id WHERE a.account_id=$1 AND a.operation_id=$2", [accountId, operationId])).rows[0]; return row && actionFromRow(row); } finally { client.release(); }
  }
  async listMeteredActionsForSession(accountId: string, sessionId: string): Promise<readonly MeteredAction[]> {
    const client = await this.pool.connect();
    try { return frozen((await client.query("SELECT account_id,idempotency_key,fingerprint,session_id,id,expected_session_version,admission_reference,budget_reference,reservation_sat,operation_id,profile_id,price_card_id,state,receipt_charge,provider_receipt_reference,terminal_result,session_version,artifact_version,remaining_cap_sat,remaining_balance_sat,artifact_id,workspace_lineage,checkpoint_reference,snapshot_reference,validation_evidence_reference,failed_artifact_id,validation_report_reference FROM metered_actions WHERE account_id=$1 AND session_id=$2 ORDER BY id", [accountId, sessionId])).rows.map(actionFromRow)); } finally { client.release(); }
  }
  async listBillingLineItems(accountId: string, request: BillingLineItemPageRequest = {}): Promise<BillingLineItemPage> {
    const limit = request.limit ?? 50; if (!Number.isInteger(limit) || limit < 1 || limit > 50) throw new Error("BILLING_LINE_ITEM_PAGE_LIMIT_INVALID");
    let after = 0n;
    if (request.cursor) try { const value = JSON.parse(Buffer.from(request.cursor, "base64url").toString("utf8")) as { v?: number; a?: string; s?: string }; if (value.v !== 1 || value.a !== accountId || !/^[0-9]+$/u.test(value.s ?? "")) throw new Error(); after = BigInt(value.s!); } catch { throw new Error("INVALID_BILLING_LINE_ITEM_CURSOR"); }
    const client = await this.pool.connect();
    try {
      const rows = (await client.query("SELECT sequence,id,account_id,session_id,action_id,operation_id,source_identity,kind,unit,amount_sat,settled_available_sat,held_sat,session_spend_sat FROM billing_line_items WHERE account_id=$1 AND sequence>$2 ORDER BY sequence,id LIMIT $3", [accountId, after.toString(), limit + 1])).rows;
      const items = rows.slice(0, limit).map(lineItemFromRow); const last = items.at(-1); return frozen({ items, ...(last && rows.length > limit ? { nextCursor: lineCursor(accountId, last) } : {}) });
    } finally { client.release(); }
  }
  async sessionStatus(accountId: string, sessionId: string): Promise<MeteredSessionRecord | undefined> {
    const client = await this.pool.connect();
    try { const row = (await client.query("SELECT account_id,id,version,state FROM metered_sessions WHERE account_id=$1 AND id=$2", [accountId, sessionId])).rows[0]; return row && frozen({ accountId: asText(row.account_id), sessionId: asText(row.id), version: Number(row.version), status: sessionStatus(asText(row.state)) }); } finally { client.release(); }
  }

  async transact<T>(accountId: string, operation: (transaction: MeteredFundingTransaction) => Promise<T> | T): Promise<T>;
  async transact<T>(accountId: string, operation: (transaction: ContinuationFundingTransaction) => Promise<T> | T): Promise<T>;
  async transact<T>(accountId: string, operation: (transaction: MeteredFundingTransaction & ContinuationFundingTransaction) => Promise<T> | T): Promise<T> {
    const deadline = this.#now() + this.#deadlineMs;
    let last: unknown;
    for (let attempt = 0; attempt < this.#maxAttempts && this.#now() < deadline; attempt += 1) {
      const raw = await beforeDeadline(this.pool.connect(), deadline, this.#now);
      const client = new DeadlineSqlClient(raw, deadline, this.#now);
      try {
        await client.query("BEGIN ISOLATION LEVEL SERIALIZABLE");
        const result = await operation(new PgFundingTransaction(client, accountId));
        await client.query("COMMIT");
        return frozen(result);
      } catch (error) {
        await beforeDeadline(raw.query("ROLLBACK"), this.#now() + Math.min(50, this.#deadlineMs), this.#now).catch(() => undefined);
        last = error;
        if ((error as { code?: unknown }).code !== "40001" || attempt + 1 === this.#maxAttempts || this.#now() >= deadline) {
          if ((error as { code?: unknown }).code === "40001") throw new SerializationFailure();
          throw error;
        }
      } finally { raw.release(); }
    }
    throw last ?? new Error("SERIALIZATION_RETRY_EXHAUSTED");
  }

  async status(accountId: string): Promise<AccountStatus | undefined> {
    const deadline = this.#now() + this.#deadlineMs;
    const client = new DeadlineSqlClient(await beforeDeadline(this.pool.connect(), deadline, this.#now), deadline, this.#now);
    try {
      const balance = await client.query<{ settled_available: string; held: string }>("SELECT settled_available, held FROM account_balance_projection WHERE account_id = $1", [accountId]);
      if (!balance.rows[0]) return undefined;
      const topUps = await client.query<{ top_up_id: string; state: "pending" | "verifying" | "settled" | "credited" | "failed" | "reconciliation_pending"; amount: string; unit: "sat"; rail: "lightning" | "cashu"; created_at: string; settlement_reference: string }>("SELECT top_up_id, state, amount, unit, rail, created_at, settlement_reference FROM top_ups WHERE account_id = $1 ORDER BY created_at", [accountId]);
      const admissions = await client.query<{ reference: string; requested_cap: string; held_amount: string }>("SELECT reference, requested_cap, held_amount FROM session_cap_holds WHERE account_id = $1 AND state = 'active' ORDER BY created_at", [accountId]);
      const row = first(balance, "ACCOUNT_BALANCE_NOT_FOUND");
      return AccountStatusSchema.parse({ accountId, unit: "sat", available: (asBigInt(row.settled_available) - asBigInt(row.held)).toString(), held: asText(row.held), topUps: topUps.rows.map((topUp) => ({ topUpId: topUp.top_up_id, state: topUp.state, amount: asText(topUp.amount), unit: topUp.unit, rail: topUp.rail, createdAt: new Date(topUp.created_at).toISOString(), verifiedAt: new Date(topUp.created_at).toISOString(), settlementReference: topUp.settlement_reference })), admissions: admissions.rows.map((hold) => ({ reference: hold.reference, approvedCap: asText(hold.held_amount), heldAmount: asText(hold.held_amount), unit: "sat" })) });
    } finally { client.release(); }
  }
}

class PgFundingTransaction implements MeteredFundingTransaction, ContinuationFundingTransaction {
  constructor(private readonly client: PostgresSqlClient, private readonly accountId: string) {}
  async findRecordedResult(idempotencyKey: string): Promise<StoredFundingCommand | undefined> {
    const result = await this.client.query<{ fingerprint_sha256: string; result_json: FundingResult }>("SELECT fingerprint_sha256, result_json FROM funding_commands WHERE account_id = $1 AND idempotency_key = $2 ORDER BY created_at DESC LIMIT 1", [this.accountId, idempotencyKey]);
    const row = result.rows[0]; return row && frozen({ fingerprint: row.fingerprint_sha256, result: FundingResultSchema.parse(row.result_json) });
  }
  async continuationFundingSnapshot(admissionReference: string) {
    const balance = first(await this.client.query("SELECT settled_available,held FROM account_balance_projection WHERE account_id=$1 FOR UPDATE", [this.accountId]), "ACCOUNT_BALANCE_NOT_FOUND");
    const hold = first(await this.client.query("SELECT held_amount FROM session_cap_holds WHERE account_id=$1 AND reference=$2 AND state='active' FOR UPDATE", [this.accountId, admissionReference]), "ACTIVE_ADMISSION_REQUIRED");
    return frozen({ settledBalance: asBigInt(balance.settled_available), availableBalance: asBigInt(balance.settled_available) - asBigInt(balance.held), remainingCap: asBigInt(hold.held_amount) });
  }
  async findContinuation(idempotencyKey: string): Promise<ContinuationRecord | undefined> {
    const row = (await this.client.query("SELECT account_id,session_id,idempotency_key,fingerprint_sha256,pending_fingerprint_sha256,expected_session_version,result_json FROM continuation_pauses WHERE account_id=$1 AND idempotency_key=$2 FOR UPDATE", [this.accountId, idempotencyKey])).rows[0];
    return row && frozen({ intent: { accountId: this.accountId, sessionId: asText(row.session_id), idempotencyKey, fingerprint: asText(row.fingerprint_sha256), pendingFingerprint: asText(row.pending_fingerprint_sha256), expectedSessionVersion: Number(row.expected_session_version) }, result: row.result_json } as unknown as ContinuationRecord);
  }
  async pauseForFunding(input: ContinuationRecord): Promise<ContinuationRecord>;
  async pauseForFunding(input: ContinuationPauseInput): Promise<ContinuationPause>;
  async pauseForFunding(input: ContinuationRecord | ContinuationPauseInput): Promise<ContinuationRecord | ContinuationPause> {
    if ("intent" in input) {
      const prior = await this.findContinuation(input.intent.idempotencyKey);
      if (prior) { if (prior.intent.fingerprint !== input.intent.fingerprint) throw new Error("IDEMPOTENCY_KEY_CONFLICT"); return prior; }
      // The Phase 01 façade is retained for compatibility; durable checkpoint
      // generation uses the richer pause input below.
      return frozen(input);
    }
    this.assertScope(input.accountId);
    const existing = await this.client.query("SELECT account_id,session_id,admission_reference,idempotency_key,fingerprint_sha256,pending_fingerprint_sha256,expected_session_version,pause_generation,grace_deadline_ms,live_lease_token,result_json,state FROM continuation_pauses WHERE account_id=$1 AND idempotency_key=$2 FOR UPDATE", [this.accountId, input.idempotencyKey]);
    if (existing.rows[0]) { const pause = pauseFromRow(existing.rows[0]); if (pause.fingerprint !== input.fingerprint || pause.sessionId !== input.sessionId || pause.pauseGeneration !== input.pauseGeneration) throw new Error("IDEMPOTENCY_KEY_CONFLICT"); return pause; }
    const generation = await this.client.query("SELECT pause_id FROM continuation_pauses WHERE account_id=$1 AND session_id=$2 AND pause_generation=$3 FOR UPDATE", [this.accountId, input.sessionId, input.pauseGeneration]);
    if (generation.rows[0]) throw new Error("PAUSE_GENERATION_CONFLICT");
    await this.client.query("INSERT INTO continuation_pauses(pause_id,account_id,session_id,admission_reference,idempotency_key,fingerprint_sha256,pending_fingerprint_sha256,pause_generation,expected_session_version,grace_deadline_ms,live_lease_token,state,result_json) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,'needs_top_up',$12)", [id("pause", `${input.sessionId}:${input.pauseGeneration}`), this.accountId, input.sessionId, input.admissionReference, input.idempotencyKey, input.fingerprint, input.pendingFingerprint, input.pauseGeneration, input.expectedSessionVersion, input.graceDeadlineMs, input.liveLeaseToken, JSON.stringify(input.result)]);
    return frozen({ ...input, state: "needs_top_up" as const });
  }
  async findContinuationPause(sessionId: string, pauseGeneration: number): Promise<ContinuationPause | undefined> {
    const row = (await this.client.query("SELECT account_id,session_id,admission_reference,idempotency_key,fingerprint_sha256,pending_fingerprint_sha256,expected_session_version,pause_generation,grace_deadline_ms,live_lease_token,result_json,state FROM continuation_pauses WHERE account_id=$1 AND session_id=$2 AND pause_generation=$3 FOR UPDATE", [this.accountId, sessionId, pauseGeneration])).rows[0];
    return row && pauseFromRow(row);
  }
  async wakePausedAction(input: Readonly<{ sessionId: string; pauseGeneration: number; nowMs: number; liveLeaseToken: string }>): Promise<ContinuationPause> {
    const pause = await this.findContinuationPause(input.sessionId, input.pauseGeneration);
    if (!pause) throw new Error("CONTINUATION_PAUSE_NOT_FOUND");
    if (pause.liveLeaseToken !== input.liveLeaseToken) throw new Error("STALE_WORKER_LEASE");
    if (input.nowMs >= pause.graceDeadlineMs) throw new Error("GRACE_DEADLINE_EXPIRED");
    if (pause.state !== "needs_top_up") return pause;
    return pause;
  }
  async beginDeadlineCheckpoint(input: BeginDeadlineCheckpointInput): Promise<ContinuationPause> {
    const pause = await this.findContinuationPause(input.sessionId, input.pauseGeneration);
    if (!pause) throw new Error("CONTINUATION_PAUSE_NOT_FOUND");
    if (pause.liveLeaseToken !== input.liveLeaseToken) throw new Error("STALE_WORKER_LEASE");
    if (pause.state === "checkpointing") return pause;
    if (pause.state !== "needs_top_up") throw new Error("CHECKPOINT_STATE_INVALID");
    await this.client.query("UPDATE continuation_pauses SET state='checkpointing' WHERE account_id=$1 AND session_id=$2 AND pause_generation=$3 AND state='needs_top_up'", [this.accountId, input.sessionId, input.pauseGeneration]);
    return frozen({ ...pause, state: "checkpointing" as const });
  }
  async commitDeadlineCheckpoint(input: ContinuationCheckpointInput): Promise<ContinuationCheckpoint> {
    this.assertScope(input.accountId);
    const existing = await this.client.query("SELECT account_id,session_id,pause_generation,checkpoint_id,expected_session_version,expected_artifact_version,manifest_reference,object_key,object_generation,object_checksum,key_reference,compatibility_identity,checkpoint_committed_at_ms,retention_deadline_ms,state FROM continuation_checkpoints WHERE checkpoint_id=$1 FOR UPDATE", [input.checkpointId]);
    if (existing.rows[0]) { const checkpoint = checkpointFromRow(existing.rows[0]); if (checkpoint.objectGeneration !== input.objectGeneration || checkpoint.objectChecksum !== input.objectChecksum) throw new Error("CHECKPOINT_IDENTITY_CONFLICT"); return checkpoint; }
    const pause = await this.findContinuationPause(input.sessionId, input.pauseGeneration);
    if (!pause || pause.state !== "checkpointing") throw new Error("CHECKPOINT_STATE_INVALID");
    const deadline = input.checkpointCommittedAtMs + 2_592_000_000;
    await this.client.query("INSERT INTO continuation_checkpoints(checkpoint_id,account_id,session_id,pause_generation,expected_session_version,expected_artifact_version,manifest_reference,object_key,object_generation,object_checksum,key_reference,compatibility_identity,checkpoint_committed_at_ms,retention_deadline_ms,state) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,'resume_required')", [input.checkpointId, this.accountId, input.sessionId, input.pauseGeneration, input.expectedSessionVersion, input.expectedArtifactVersion, input.manifestReference, input.objectKey, input.objectGeneration, input.objectChecksum, input.keyReference, input.compatibilityIdentity, input.checkpointCommittedAtMs, deadline]);
    await this.client.query("UPDATE continuation_pauses SET state='resume_required',live_lease_token=NULL WHERE account_id=$1 AND session_id=$2 AND pause_generation=$3 AND state='checkpointing'", [this.accountId, input.sessionId, input.pauseGeneration]);
    return frozen({ ...input, retentionDeadlineMs: deadline, state: "resume_required" as const });
  }
  async claimResume(input: ContinuationResumeClaimInput): Promise<ContinuationResumeClaim> {
    this.assertScope(input.accountId);
    const replay = await this.client.query("SELECT account_id,checkpoint_id,idempotency_key,fingerprint_sha256,lease_token,allocation_intent_reference FROM continuation_resume_commands WHERE account_id=$1 AND idempotency_key=$2 FOR UPDATE", [this.accountId, input.idempotencyKey]);
    if (replay.rows[0]) { const row = replay.rows[0]; if (asText(row.fingerprint_sha256) !== input.fingerprint || asText(row.checkpoint_id) !== input.checkpointId) throw new Error("IDEMPOTENCY_KEY_CONFLICT"); return frozen({ accountId: this.accountId, checkpointId: input.checkpointId, idempotencyKey: input.idempotencyKey, fingerprint: input.fingerprint, leaseToken: asText(row.lease_token), allocationIntentReference: asText(row.allocation_intent_reference), claimed: true }); }
    const row = first(await this.client.query("SELECT account_id,session_id,pause_generation,checkpoint_id,expected_session_version,expected_artifact_version,manifest_reference,object_key,object_generation,object_checksum,key_reference,compatibility_identity,checkpoint_committed_at_ms,retention_deadline_ms,state FROM continuation_checkpoints WHERE checkpoint_id=$1 AND account_id=$2 FOR UPDATE", [input.checkpointId, this.accountId]), "CHECKPOINT_NOT_FOUND_OR_DENIED");
    const checkpoint = checkpointFromRow(row);
    if (input.nowMs >= checkpoint.retentionDeadlineMs || checkpoint.state === "expired") throw new Error("CHECKPOINT_EXPIRED");
    if (checkpoint.state !== "resume_required") throw new Error("CHECKPOINT_ALREADY_CLAIMED");
    if (checkpoint.sessionId !== input.sessionId || checkpoint.expectedSessionVersion !== input.expectedSessionVersion || input.expectedCheckpointVersion !== 1) throw new Error("STALE_CHECKPOINT_VERSION");
    const pause = await this.findContinuationPause(input.sessionId, checkpoint.pauseGeneration);
    if (!pause || pause.pendingFingerprint !== input.pendingFingerprint) throw new Error("PENDING_ACTION_CONFLICT");
    const result = frozen({ accountId: this.accountId, checkpointId: input.checkpointId, idempotencyKey: input.idempotencyKey, fingerprint: input.fingerprint, leaseToken: input.newLeaseToken, allocationIntentReference: input.allocationIntentReference, claimed: true as const });
    await this.client.query("INSERT INTO continuation_resume_commands(command_id,account_id,checkpoint_id,idempotency_key,fingerprint_sha256,pending_fingerprint_sha256,expected_checkpoint_version,expected_session_version,lease_token,allocation_intent_reference,result_json) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11)", [id("resume", input.idempotencyKey), this.accountId, input.checkpointId, input.idempotencyKey, input.fingerprint, input.pendingFingerprint, input.expectedCheckpointVersion, input.expectedSessionVersion, input.newLeaseToken, input.allocationIntentReference, JSON.stringify(result)]);
    await this.client.query("UPDATE continuation_checkpoints SET state='claimed' WHERE checkpoint_id=$1 AND state='resume_required'", [input.checkpointId]);
    await this.client.query("UPDATE continuation_pauses SET state='claimed' WHERE account_id=$1 AND session_id=$2 AND pause_generation=$3", [this.accountId, input.sessionId, checkpoint.pauseGeneration]);
    return result;
  }
  async recordRestoreObservation(input: RestoreObservationInput): Promise<RestoreObservationInput> { await this.client.query("INSERT INTO continuation_restore_observations(checkpoint_id,allocation_intent_reference,state) VALUES ($1,$2,$3) ON CONFLICT (checkpoint_id,allocation_intent_reference) DO NOTHING", [input.checkpointId, input.allocationIntentReference, input.state]); return frozen(input); }
  async tombstoneExpiredCheckpoint(input: Readonly<{ checkpointId: string; nowMs: number }>): Promise<ContinuationCheckpoint> {
    const row = first(await this.client.query("SELECT account_id,session_id,pause_generation,checkpoint_id,expected_session_version,expected_artifact_version,manifest_reference,object_key,object_generation,object_checksum,key_reference,compatibility_identity,checkpoint_committed_at_ms,retention_deadline_ms,state FROM continuation_checkpoints WHERE checkpoint_id=$1 AND account_id=$2 FOR UPDATE", [input.checkpointId, this.accountId]), "CHECKPOINT_NOT_FOUND");
    const checkpoint = checkpointFromRow(row);
    if (checkpoint.state === "claimed" || checkpoint.state === "expired") return checkpoint;
    if (input.nowMs < checkpoint.retentionDeadlineMs) throw new Error("CHECKPOINT_RETENTION_ACTIVE");
    await this.client.query("UPDATE continuation_checkpoints SET state='expired' WHERE checkpoint_id=$1 AND state='resume_required'", [input.checkpointId]);
    await this.client.query("INSERT INTO continuation_tombstones(checkpoint_id,account_id,expired_at_ms) VALUES ($1,$2,$3) ON CONFLICT (checkpoint_id) DO NOTHING", [input.checkpointId, this.accountId, input.nowMs]);
    return frozen({ ...checkpoint, state: "expired" as const });
  }
  async recordDeletionOutcome(input: DeletionOutcomeInput): Promise<DeletionOutcomeInput> { await this.client.query("INSERT INTO continuation_deletions(checkpoint_id,object_generation,state) VALUES ($1,$2,$3) ON CONFLICT (checkpoint_id,object_generation) DO UPDATE SET state=EXCLUDED.state WHERE continuation_deletions.state IN ('scheduled','unknown')", [input.checkpointId, input.objectGeneration, input.state]); return frozen(input); }
  async creditVerifiedSettlement(input: CreditInput): Promise<FundingResult> {
    this.assertScope(input.accountId); await this.ensureAccount(this.accountId); await this.ensureAccount("treasury:clearing");
    const amount = BigInt(input.settlement.amount); if (amount <= 0n) throw new Error("INVALID_SETTLEMENT_AMOUNT");
    const duplicate = await this.client.query("SELECT 1 FROM settlement_attempts WHERE external_reference = $1 OR top_up_id = $2", [input.settlement.externalReference, input.settlement.topUpId]);
    if (duplicate.rows.length) throw new Error("SETTLEMENT_REFERENCE_CONFLICT");
    await this.client.query("INSERT INTO ledger_transactions(transaction_id, reference, unit) VALUES ($1, $2, 'sat')", [id("ledger", input.settlement.settlementReference), input.settlement.settlementReference]);
    await this.client.query("INSERT INTO top_ups(top_up_id, account_id, rail, amount, unit, state, settlement_reference) VALUES ($1,$2,$3,$4,'sat','credited',$5)", [input.settlement.topUpId, this.accountId, input.settlement.rail, amount.toString(), input.settlement.settlementReference]);
    await this.client.query("INSERT INTO settlement_attempts(attempt_id, top_up_id, external_reference, observed_state) VALUES ($1,$2,$3,'verified')", [id("attempt", input.settlement.topUpId), input.settlement.topUpId, input.settlement.externalReference]);
    await this.client.query("INSERT INTO account_balance_projection(account_id, unit, settled_available, held) VALUES ($1,'sat',$2,0) ON CONFLICT (account_id) DO UPDATE SET settled_available = account_balance_projection.settled_available + EXCLUDED.settled_available", [this.accountId, amount.toString()]);
    await this.lineItem(`settlement:${input.settlement.settlementReference}`, "credit", amount.toString());
    await this.client.query("INSERT INTO ledger_entries(entry_id, transaction_id, account_id, direction, amount, unit, entry_reference) VALUES ($1,$2,$3,'credit',$4,'sat',$5), ($6,$2,'treasury:clearing','debit',$4,'sat',$7)", [id("entry", `${input.settlement.settlementReference}:credit`), id("ledger", input.settlement.settlementReference), this.accountId, amount.toString(), id("entry-ref", `${input.settlement.settlementReference}:credit`), id("entry", `${input.settlement.settlementReference}:debit`), id("entry-ref", `${input.settlement.settlementReference}:debit`)]);
    const result = frozen({ status: "credited" as const, accountId: this.accountId, topUpId: input.settlement.topUpId, creditedAmount: amount.toString(), unit: "sat" as const, settlementReference: input.settlement.settlementReference });
    await this.command(input.idempotencyKey, input.fingerprint, result); await this.outbox(input.settlement.settlementReference, "account_credited", result); return result;
  }
  async acceptFundedAdmission(input: AdmissionInput): Promise<FundedAdmission> {
    this.assertScope(input.accountId); await this.ensureAccount(this.accountId);
    const balance = first(await this.client.query<{ settled_available: string; held: string }>("INSERT INTO account_balance_projection(account_id, unit, settled_available, held) VALUES ($1,'sat',0,0) ON CONFLICT (account_id) DO UPDATE SET account_id = EXCLUDED.account_id RETURNING settled_available, held", [this.accountId]), "ACCOUNT_BALANCE_NOT_FOUND");
    const available = asBigInt(balance.settled_available) - asBigInt(balance.held); const amount = input.requestedCap < available ? input.requestedCap : available;
    if (amount <= 0n) throw new Error("INSUFFICIENT_SETTLED_BALANCE");
    await this.client.query("INSERT INTO session_cap_holds(hold_id, account_id, reference, requested_cap, held_amount, state) VALUES ($1,$2,$3,$4,$5,'active')", [id("hold", input.capacityReference), this.accountId, input.capacityReference, input.requestedCap.toString(), amount.toString()]);
    await this.client.query("INSERT INTO admissions(admission_id, account_id, reference, capacity_reference, state) VALUES ($1,$2,$3,$3,'accepted')", [id("admission", input.capacityReference), this.accountId, input.capacityReference]);
    await this.client.query("UPDATE account_balance_projection SET held = held + $2 WHERE account_id = $1", [this.accountId, amount.toString()]);
    await this.lineItem(`cap_hold:${input.capacityReference}`, "cap_hold", amount.toString());
    const result = frozen({ status: "accepted" as const, accountId: this.accountId, reference: input.capacityReference, approvedCap: amount.toString(), heldAmount: amount.toString(), unit: "sat" as const });
    await this.command(input.idempotencyKey, input.fingerprint, result); await this.outbox(input.capacityReference, "funded_admission_accepted", result); return result;
  }
  async findCapacityIntent(idempotencyKey: string): Promise<CapacityIntent | undefined> { const result = await this.client.query("SELECT account_id,idempotency_key,fingerprint_sha256,intent_reference,state,capacity_reference,expires_at FROM capacity_intents WHERE account_id=$1 AND idempotency_key=$2", [this.accountId, idempotencyKey]); return result.rows[0] && this.intent(result.rows[0]); }
  async createCapacityIntent(input: CapacityIntentInput): Promise<CapacityIntent> { this.assertScope(input.accountId); const prior = await this.findCapacityIntent(input.idempotencyKey); if (prior) { if (prior.fingerprint !== input.fingerprint || prior.intentReference !== input.intentReference) throw new Error("IDEMPOTENCY_KEY_CONFLICT"); return prior; } await this.client.query("INSERT INTO capacity_intents(intent_id,account_id,idempotency_key,fingerprint_sha256,intent_reference,state) VALUES ($1,$2,$3,$4,$5,'created')", [id("capacity", input.intentReference), this.accountId, input.idempotencyKey, input.fingerprint, input.intentReference]); return { ...input, state: "created" }; }
  async claimCapacityDispatch(intentReference: string): Promise<CapacityDispatchClaim> { const updated = await this.client.query("UPDATE capacity_intents SET state='dispatching' WHERE account_id=$1 AND intent_reference=$2 AND state='created' RETURNING account_id,idempotency_key,fingerprint_sha256,intent_reference,state,capacity_reference,expires_at", [this.accountId, intentReference]); if (updated.rows[0]) return frozen({ intent: this.intent(updated.rows[0]), claimed: true }); const current = first(await this.client.query("SELECT account_id,idempotency_key,fingerprint_sha256,intent_reference,state,capacity_reference,expires_at FROM capacity_intents WHERE account_id=$1 AND intent_reference=$2", [this.accountId, intentReference]), "CAPACITY_INTENT_NOT_FOUND"); return frozen({ intent: this.intent(current), claimed: false }); }
  async recordCapacityObservation(input: CapacityObservationInput): Promise<CapacityIntent> { const row = first(await this.client.query("UPDATE capacity_intents SET state=$3, capacity_reference=COALESCE($4,capacity_reference), expires_at=COALESCE($5,expires_at) WHERE account_id=$1 AND intent_reference=$2 RETURNING account_id,idempotency_key,fingerprint_sha256,intent_reference,state,capacity_reference,expires_at", [this.accountId, input.intentReference, input.state, input.capacityReference ?? null, input.expiresAt ?? null]), "CAPACITY_INTENT_NOT_FOUND"); return this.intent(row); }
  async releaseCapacityIntent(intentReference: string): Promise<CapacityIntent> { const row = first(await this.client.query("UPDATE capacity_intents SET state='released' WHERE account_id=$1 AND intent_reference=$2 RETURNING account_id,idempotency_key,fingerprint_sha256,intent_reference,state,capacity_reference,expires_at", [this.accountId, intentReference]), "CAPACITY_INTENT_NOT_FOUND"); return this.intent(row); }
  async findActionBudget(idempotencyKey: string): Promise<ActionBudget | undefined> { const result = await this.client.query("SELECT account_id,admission_reference,idempotency_key,fingerprint_sha256,reservation_reference,amount,state FROM action_budget_reservations WHERE account_id=$1 AND idempotency_key=$2", [this.accountId, idempotencyKey]); const row = result.rows[0]; return row && frozen({ accountId: asText(row.account_id), admissionReference: asText(row.admission_reference), idempotencyKey: asText(row.idempotency_key), fingerprint: asText(row.fingerprint_sha256), reference: asText(row.reservation_reference), amount: asBigInt(row.amount), state: asText(row.state) as ActionBudget["state"] }); }
  async reserveActionBudget(input: ActionBudgetInput): Promise<ActionBudget> { this.assertScope(input.accountId); const prior = await this.findActionBudget(input.idempotencyKey); if (prior) { if (prior.fingerprint !== input.fingerprint) throw new Error("IDEMPOTENCY_KEY_CONFLICT"); return prior; } const hold = first(await this.client.query("SELECT held_amount FROM session_cap_holds WHERE account_id=$1 AND reference=$2 AND state='active'", [this.accountId, input.admissionReference]), "ACTIVE_ADMISSION_REQUIRED"); const already = first(await this.client.query<{ total: string }>("SELECT COALESCE(SUM(amount),0) AS total FROM action_budget_reservations WHERE account_id=$1 AND admission_reference=$2 AND state='authorized'", [this.accountId, input.admissionReference]), "ACTION_BUDGET_TOTAL_MISSING"); if (input.amount <= 0n || input.amount > asBigInt(hold.held_amount) - asBigInt(already.total)) throw new Error("ACTION_BUDGET_EXCEEDS_APPROVED_CAP"); await this.client.query("INSERT INTO action_budget_reservations(reservation_id,account_id,admission_reference,idempotency_key,fingerprint_sha256,reservation_reference,amount,unit,state) VALUES ($1,$2,$3,$4,$5,$6,$7,'sat','authorized')", [id("budget", input.reference), this.accountId, input.admissionReference, input.idempotencyKey, input.fingerprint, input.reference, input.amount.toString()]); await this.lineItem(`action_reservation:${input.reference}`, "action_reservation", input.amount.toString()); return frozen({ ...input, state: "authorized" as const }); }
  async prepareMeteredAction(input: PrepareMeteredActionInput): Promise<MeteredAction> {
    this.assertScope(input.accountId); const prior = await this.client.query("SELECT account_id,idempotency_key,fingerprint,session_id,id,expected_session_version,admission_reference,budget_reference,reservation_sat,operation_id,profile_id,price_card_id,state,receipt_charge,provider_receipt_reference,terminal_result,session_version,artifact_version,remaining_cap_sat,remaining_balance_sat FROM metered_actions WHERE account_id=$1 AND idempotency_key=$2 FOR UPDATE", [this.accountId, input.idempotencyKey]);
    if (prior.rows[0]) { const action = actionFromRow(prior.rows[0]); if (action.fingerprint !== input.fingerprint || action.operationId !== input.operationId) throw new Error("IDEMPOTENCY_KEY_CONFLICT"); return action; }
    const budget = first(await this.client.query("SELECT account_id,admission_reference,amount FROM action_budget_reservations WHERE account_id=$1 AND reservation_reference=$2 FOR UPDATE", [this.accountId, input.actionBudgetReference]), "METERED_ACTION_BUDGET_MISMATCH"); if (asText(budget.admission_reference) !== input.admissionReference || asBigInt(budget.amount) !== input.maximum) throw new Error("METERED_ACTION_BUDGET_MISMATCH");
    await this.client.query("INSERT INTO metered_sessions(id,account_id,admission_reference,profile_id,price_card_id,version,state) VALUES ($1,$2,$3,$4,$5,$6,'prepared') ON CONFLICT (id) DO NOTHING", [input.sessionId, this.accountId, input.admissionReference, input.profileId, input.priceCardId, input.expectedVersion]);
    await this.client.query("INSERT INTO metered_actions(id,account_id,session_id,idempotency_key,fingerprint,expected_session_version,admission_reference,budget_reference,reservation_sat,operation_id,profile_id,price_card_id,state) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,'prepared')", [input.actionId, this.accountId, input.sessionId, input.idempotencyKey, input.fingerprint, input.expectedVersion, input.admissionReference, input.actionBudgetReference, input.maximum.toString(), input.operationId, input.profileId, input.priceCardId]);
    await this.client.query("INSERT INTO provider_operations(id,account_id,action_id,provider,model,provider_request_id,sub_reservation_sat,state) VALUES ($1,$2,$3,$4,$5,$6,$7,'prepared')", [input.operationId, this.accountId, input.actionId, input.profileId, input.profileId, input.operationId, input.maximum.toString()]);
    return frozen({ ...input, status: "prepared" as const });
  }
  async claimProviderOperation(operationId: string): Promise<MeteredOperationClaim> {
    const operation = first(await this.client.query("SELECT o.id,o.action_id,a.account_id,a.idempotency_key,a.fingerprint,a.session_id,a.expected_session_version,a.admission_reference,a.budget_reference,a.reservation_sat,a.operation_id,a.profile_id,a.price_card_id,a.state,a.terminal_result,a.session_version,a.artifact_version,a.remaining_cap_sat,a.remaining_balance_sat FROM provider_operations o JOIN metered_actions a ON a.id=o.action_id WHERE o.id=$1 AND a.account_id=$2 FOR UPDATE", [operationId, this.accountId]), "METERED_OPERATION_NOT_FOUND"); const action = actionFromOperationRow(operation, operationId);
    if (action.status !== "prepared") return frozen({ action, claimed: false }); await this.client.query("UPDATE provider_operations SET state='active' WHERE id=$1", [operationId]); await this.client.query("UPDATE metered_actions SET state='active' WHERE id=$1", [action.actionId]); return frozen({ action: frozen({ ...action, status: "dispatching" as const }), claimed: true });
  }
  async recordUsageUnknown(input: UsageUnknownInput): Promise<MeteredAction> {
    const action = first(await this.client.query("SELECT a.account_id,a.idempotency_key,a.fingerprint,a.session_id,a.id,a.expected_session_version,a.admission_reference,a.budget_reference,a.reservation_sat,a.operation_id,a.profile_id,a.price_card_id,a.state,a.terminal_result,a.session_version,a.artifact_version,a.remaining_cap_sat,a.remaining_balance_sat,o.provider_request_id FROM provider_operations o JOIN metered_actions a ON a.id=o.action_id WHERE o.id=$1 AND a.account_id=$2 FOR UPDATE", [input.operationId, this.accountId]), "METERED_OPERATION_NOT_FOUND");
    const parsed = actionFromOperationRow(action, input.operationId);
    if (parsed.status === "usage_unknown") return parsed;
    if (parsed.status !== "dispatching") throw new Error("METERED_UNKNOWN_STATE_INVALID");
    await this.client.query("UPDATE provider_operations SET state='usage_unknown',provider_request_id=$2 WHERE id=$1", [input.operationId, input.providerRequestId]);
    await this.client.query("UPDATE metered_actions SET state='usage_unknown',provider_receipt_reference=$2 WHERE id=$1", [parsed.actionId, input.protectedEvidenceReference]);
    await this.client.query("UPDATE metered_sessions SET state='usage_unknown' WHERE id=$1", [parsed.sessionId]);
    await this.lineItem(`reconciliation:${input.operationId}`, "reconciliation", "0");
    return frozen({ ...parsed, status: "usage_unknown", providerRequestId: input.providerRequestId, providerReceiptReference: input.protectedEvidenceReference, reconciliationReason: input.reason });
  }
  async claimReconciliation(operationId: string): Promise<ReconciliationClaim> {
    const action = first(await this.client.query("SELECT a.account_id,a.idempotency_key,a.fingerprint,a.session_id,a.id,a.expected_session_version,a.admission_reference,a.budget_reference,a.reservation_sat,a.operation_id,a.profile_id,a.price_card_id,a.state,a.terminal_result,a.session_version,a.artifact_version,a.remaining_cap_sat,a.remaining_balance_sat,o.provider_request_id FROM provider_operations o JOIN metered_actions a ON a.id=o.action_id WHERE o.id=$1 AND a.account_id=$2 FOR UPDATE", [operationId, this.accountId]), "METERED_OPERATION_NOT_FOUND");
    const parsed = actionFromOperationRow(action, operationId);
    if (parsed.status !== "usage_unknown") return frozen({ action: parsed, claimed: false });
    const claimed = await this.client.query("INSERT INTO provider_reconciliations(id,account_id,action_id,operation_id,reason,state) VALUES ($1,$2,$3,$4,'usage_unknown','open') ON CONFLICT (operation_id) DO NOTHING RETURNING id", [id("reconciliation", operationId), this.accountId, parsed.actionId, operationId]);
    return frozen({ action: parsed, claimed: Boolean(claimed.rows[0]) });
  }
  async releaseReconciliation(operationId: string): Promise<MeteredAction> {
    const row = first(await this.client.query("SELECT a.account_id,a.idempotency_key,a.fingerprint,a.session_id,a.id,a.expected_session_version,a.admission_reference,a.budget_reference,a.reservation_sat,a.operation_id,a.profile_id,a.price_card_id,a.state,a.receipt_charge,a.provider_receipt_reference,a.terminal_result,a.session_version,a.artifact_version,a.remaining_cap_sat,a.remaining_balance_sat,o.provider_request_id FROM provider_operations o JOIN metered_actions a ON a.id=o.action_id WHERE o.id=$1 AND a.account_id=$2 FOR UPDATE", [operationId, this.accountId]), "METERED_OPERATION_NOT_FOUND");
    const action = actionFromOperationRow(row, operationId);
    if (action.status !== "usage_unknown") return action;
    await this.client.query("DELETE FROM provider_reconciliations WHERE account_id=$1 AND operation_id=$2 AND state='open'", [this.accountId, operationId]);
    return action;
  }
  async recordUsageReceipt(input: Readonly<{ operationId: string; protectedEvidenceReference: string }>): Promise<MeteredAction> {
    const action = first(await this.client.query("SELECT a.account_id,a.idempotency_key,a.fingerprint,a.session_id,a.id,a.expected_session_version,a.admission_reference,a.budget_reference,a.reservation_sat,a.operation_id,a.profile_id,a.price_card_id,a.state,a.terminal_result,a.session_version,a.artifact_version,a.remaining_cap_sat,a.remaining_balance_sat FROM provider_operations o JOIN metered_actions a ON a.id=o.action_id WHERE o.id=$1 AND a.account_id=$2 FOR UPDATE", [input.operationId, this.accountId]), "METERED_OPERATION_NOT_FOUND"); const parsed = actionFromOperationRow(action, input.operationId); if (parsed.status !== "dispatching" && parsed.status !== "usage_unknown") throw new Error("METERED_RECEIPT_STATE_INVALID"); await this.client.query("UPDATE metered_actions SET provider_receipt_reference=$2 WHERE id=$1", [parsed.actionId, input.protectedEvidenceReference]); return frozen({ ...parsed, providerReceiptReference: input.protectedEvidenceReference });
  }
  async finalizeMeteredAction(input: MeteredFinalizeInput): Promise<MeteredAction> {
    const row = first(await this.client.query("SELECT account_id,idempotency_key,fingerprint,session_id,id,expected_session_version,admission_reference,budget_reference,reservation_sat,operation_id,profile_id,price_card_id,state,receipt_charge,provider_receipt_reference,terminal_result,session_version,artifact_version,remaining_cap_sat,remaining_balance_sat FROM metered_actions WHERE account_id=$1 AND idempotency_key=$2 FOR UPDATE", [this.accountId, input.idempotencyKey]), "METERED_FINALIZATION_STATE_INVALID"); const action = actionFromRow(row);
    if (action.operationId !== input.operationId) throw new Error("METERED_FINALIZATION_STATE_INVALID"); if (action.result) { if (action.receiptCharge !== input.receiptCharge || action.providerReceiptReference !== input.providerReceiptReference) throw new Error("METERED_FINALIZATION_IDENTITY_CONFLICT"); return action; }
    if (action.status !== "dispatching" && action.status !== "usage_unknown") throw new Error("METERED_FINALIZATION_STATE_INVALID");
    const charge = BigInt(input.receiptCharge); if (charge < 0n || charge > action.maximum) return this.billingInvariant(action, input, "METERED_RECEIPT_EXCEEDS_RESERVATION");
    const balance = first(await this.client.query("SELECT settled_available,held FROM account_balance_projection WHERE account_id=$1 FOR UPDATE", [this.accountId]), "ACCOUNT_BALANCE_NOT_FOUND"); const hold = first(await this.client.query("SELECT hold_id,held_amount FROM session_cap_holds WHERE account_id=$1 AND reference=$2 AND state='active' FOR UPDATE", [this.accountId, action.admissionReference]), "ACTIVE_ADMISSION_REQUIRED");
    if (charge > asBigInt(balance.settled_available) || charge > asBigInt(hold.held_amount)) return this.billingInvariant(action, input, "METERED_SETTLEMENT_EXCEEDS_HOLD");
    const nextBalance = asBigInt(balance.settled_available) - charge; const nextHeld = asBigInt(balance.held) - charge; const nextCap = asBigInt(hold.held_amount) - charge;
    await this.client.query("INSERT INTO usage_receipts(id,account_id,action_id,operation_id,provider,model,provider_receipt_id,normalized_receipt,protected_evidence_reference) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9) ON CONFLICT (operation_id) DO NOTHING", [id("receipt", input.operationId), this.accountId, action.actionId, input.operationId, action.profileId, action.profileId, input.providerReceiptReference, JSON.stringify({ charge: input.receiptCharge }), input.providerReceiptReference]);
    await this.client.query("INSERT INTO ledger_transactions(transaction_id,reference,unit) VALUES ($1,$2,'sat')", [id("ledger", input.operationId), input.operationId]); await this.client.query("INSERT INTO ledger_entries(entry_id,transaction_id,account_id,direction,amount,unit,entry_reference) VALUES ($1,$2,$3,'debit',$4,'sat',$5),($6,$2,'treasury:clearing','credit',$4,'sat',$7)", [id("entry", `${input.operationId}:debit`), id("ledger", input.operationId), this.accountId, input.receiptCharge, id("entry-ref", `${input.operationId}:debit`), id("entry", `${input.operationId}:credit`), id("entry-ref", `${input.operationId}:credit`)]);
    await this.client.query("UPDATE account_balance_projection SET settled_available=$2,held=$3 WHERE account_id=$1", [this.accountId, nextBalance.toString(), nextHeld.toString()]); await this.client.query("UPDATE session_cap_holds SET held_amount=$2 WHERE hold_id=$1", [asText(hold.hold_id), nextCap.toString()]);
    const released = await this.client.query("UPDATE action_budget_reservations SET state='released' WHERE account_id=$1 AND reservation_reference=$2 AND state='authorized' RETURNING reservation_id", [this.accountId, action.actionBudgetReference]); if (!released.rows[0]) throw new Error("METERED_ACTION_BUDGET_STATE_INVALID");
    // Session truth advances in the same SERIALIZABLE transaction as the
    // receipt debit. Failed actions retain the prior verified artifact.
    const sessionState = input.status === "completed" ? "verified" : input.status;
    const session = await this.client.query("UPDATE metered_sessions SET version=$3,state=$4,confirmed_spend_sat=confirmed_spend_sat+$5,current_verified_artifact_version=CASE WHEN $4='verified' THEN $6 ELSE current_verified_artifact_version END WHERE account_id=$1 AND id=$2 AND version=$7 RETURNING id", [this.accountId, action.sessionId, input.sessionVersion, sessionState, input.receiptCharge, input.artifactVersion, action.expectedVersion]);
    if (!session.rows[0]) throw new Error("METERED_SESSION_VERSION_CONFLICT");
    if (input.status === "completed") {
      if (!input.artifact?.artifactId) throw new Error("VERIFIED_ARTIFACT_ID_REQUIRED");
      await this.client.query("INSERT INTO session_artifacts(id,account_id,session_id,action_id,version,lineage,validation_evidence_reference,verified) VALUES ($1,$2,$3,$4,$5,$6,$7,true)", [input.artifact.artifactId, this.accountId, action.sessionId, action.actionId, input.artifactVersion, JSON.stringify({ workspaceLineage: input.artifact.workspaceLineage, checkpointReference: input.artifact.checkpointReference, snapshotReference: input.artifact.snapshotReference, parentArtifactVersion: action.expectedVersion }), input.artifact.validationEvidenceReference]);
    }
    const terminalResult = canonicalMeteredTerminalResult(input.result, { confirmedSpend: input.receiptCharge, remainingCap: nextCap.toString(), remainingBalance: nextBalance.toString() });
    const state = input.status === "completed" ? "verified" : input.status; await this.client.query("UPDATE metered_actions SET state=$2,receipt_charge=$3,provider_receipt_reference=$4,terminal_result=$5,session_version=$6,artifact_version=$7,remaining_cap_sat=$8,remaining_balance_sat=$9,artifact_id=$10,workspace_lineage=$11,checkpoint_reference=$12,snapshot_reference=$13,validation_evidence_reference=$14,failed_artifact_id=$15,validation_report_reference=$16,settled_at=now() WHERE id=$1", [action.actionId, state, input.receiptCharge, input.providerReceiptReference, JSON.stringify(terminalResult), input.sessionVersion, input.artifactVersion, nextCap.toString(), nextBalance.toString(), input.artifact?.artifactId ?? null, input.artifact?.workspaceLineage ?? null, input.artifact?.checkpointReference ?? null, input.artifact?.snapshotReference ?? null, input.artifact?.validationEvidenceReference ?? null, input.artifact?.failedArtifactId ?? null, input.artifact?.validationReportReference ?? null]);
    for (const [kind, amount] of [["receipt", "0"], ["debit", `-${charge}`], ["release", (action.maximum - charge).toString()]] as const) await this.client.query("INSERT INTO billing_line_items(id,account_id,session_id,action_id,operation_id,source_identity,kind,unit,amount_sat,settled_available_sat,held_sat,session_spend_sat) VALUES ($1,$2,$3,$4,$5,$6,$7,'sat',$8,$9,$10,$11)", [id("line", `${input.operationId}:${kind}`), this.accountId, action.sessionId, action.actionId, input.operationId, `${kind}:${input.operationId}`, kind, amount, nextBalance.toString(), nextHeld.toString(), input.receiptCharge]);
    await this.outbox(input.operationId, "metered_action_finalized", terminalResult); return frozen({ ...action, status: input.status, receiptCharge: input.receiptCharge, providerReceiptReference: input.providerReceiptReference, result: terminalResult, sessionVersion: input.sessionVersion, artifactVersion: input.artifactVersion, remainingCap: nextCap.toString(), remainingBalance: nextBalance.toString(), ...(input.artifact ? { artifact: input.artifact } : {}) });
  }
  private async billingInvariant(action: MeteredAction, input: MeteredFinalizeInput, reason: string): Promise<MeteredAction> { await this.client.query("INSERT INTO provider_reconciliations(id,account_id,action_id,operation_id,reason,receipt_reference) VALUES ($1,$2,$3,$4,$5,$6)", [id("reconciliation", action.operationId), this.accountId, action.actionId, action.operationId, reason, input.providerReceiptReference]); await this.client.query("INSERT INTO profile_quarantines(id,profile_id,price_card_id,action_id,reason) VALUES ($1,$2,$3,$4,$5) ON CONFLICT (profile_id,price_card_id) DO NOTHING", [id("quarantine", `${action.profileId}:${action.priceCardId}`), action.profileId, action.priceCardId, action.actionId, reason]); await this.client.query("UPDATE metered_actions SET state='billing_invariant_failed',provider_receipt_reference=$2,terminal_result=$3,settled_at=now() WHERE id=$1", [action.actionId, input.providerReceiptReference, JSON.stringify(input.result)]); return frozen({ ...action, status: "billing_invariant_failed", providerReceiptReference: input.providerReceiptReference, result: input.result }); }
  private async ensureAccount(accountId: string): Promise<void> { await this.client.query("INSERT INTO funding_accounts(account_id,unit) VALUES ($1,'sat') ON CONFLICT (account_id) DO NOTHING", [accountId]); }
  private async lineItem(sourceIdentity: string, kind: BillingLineItem["kind"], amount: string): Promise<void> { const projection = first(await this.client.query("SELECT settled_available,held FROM account_balance_projection WHERE account_id=$1 FOR UPDATE", [this.accountId]), "ACCOUNT_BALANCE_NOT_FOUND"); await this.client.query("INSERT INTO billing_line_items(id,account_id,source_identity,kind,unit,amount_sat,settled_available_sat,held_sat,session_spend_sat) VALUES ($1,$2,$3,$4,'sat',$5,$6,$7,0)", [id("line", sourceIdentity), this.accountId, sourceIdentity, kind, amount, asText(projection.settled_available), asText(projection.held)]); }
  private async command(idempotencyKey: string, fingerprint: string, result: FundingResult): Promise<void> { await this.client.query("INSERT INTO funding_commands(account_id,command_kind,idempotency_key,fingerprint_sha256,result_json) VALUES ($1,$2,$3,$4,$5)", [this.accountId, commandKind, idempotencyKey, fingerprint, JSON.stringify(result)]); }
  private async outbox(reference: string, kind: string, payload: unknown): Promise<void> { await this.client.query("INSERT INTO funding_outbox(outbox_id,aggregate_reference,event_kind,payload_json) VALUES ($1,$2,$3,$4)", [id("outbox", `${reference}:${kind}`), reference, kind, JSON.stringify(payload)]); }
  private assertScope(accountId: string): void { if (accountId !== this.accountId) throw new Error("ACCOUNT_SCOPE_MISMATCH"); }
  private intent(row: SqlRow): CapacityIntent { return frozen({ accountId: asText(row.account_id), idempotencyKey: asText(row.idempotency_key), fingerprint: asText(row.fingerprint_sha256), intentReference: asText(row.intent_reference), state: asText(row.state) as CapacityIntent["state"], ...(row.capacity_reference ? { capacityReference: asText(row.capacity_reference) } : {}), ...(row.expires_at ? { expiresAt: new Date(asText(row.expires_at)).toISOString() } : {}) }); }
}
