import type { AccountStatus, FundedAdmission, FundingResult } from "../phase-03/contracts";
import { AccountStatusSchema, FundingResultSchema } from "../phase-03/contracts";
import type { ActionBudget, ActionBudgetInput, AdmissionInput, CapacityDispatchClaim, CapacityIntent, CapacityIntentInput, CapacityObservationInput, CreditInput, FundingStore, FundingTransaction, StoredFundingCommand } from "./funding-store";
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
export class PostgresSqlFundingStore implements FundingStore {
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

  async transact<T>(accountId: string, operation: (transaction: FundingTransaction) => Promise<T> | T): Promise<T> {
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

class PgFundingTransaction implements FundingTransaction {
  constructor(private readonly client: PostgresSqlClient, private readonly accountId: string) {}
  async findRecordedResult(idempotencyKey: string): Promise<StoredFundingCommand | undefined> {
    const result = await this.client.query<{ fingerprint_sha256: string; result_json: FundingResult }>("SELECT fingerprint_sha256, result_json FROM funding_commands WHERE account_id = $1 AND idempotency_key = $2 ORDER BY created_at DESC LIMIT 1", [this.accountId, idempotencyKey]);
    const row = result.rows[0]; return row && frozen({ fingerprint: row.fingerprint_sha256, result: FundingResultSchema.parse(row.result_json) });
  }
  async creditVerifiedSettlement(input: CreditInput): Promise<FundingResult> {
    this.assertScope(input.accountId); await this.ensureAccount(this.accountId); await this.ensureAccount("treasury:clearing");
    const amount = BigInt(input.settlement.amount); if (amount <= 0n) throw new Error("INVALID_SETTLEMENT_AMOUNT");
    const duplicate = await this.client.query("SELECT 1 FROM settlement_attempts WHERE external_reference = $1 OR top_up_id = $2", [input.settlement.externalReference, input.settlement.topUpId]);
    if (duplicate.rows.length) throw new Error("SETTLEMENT_REFERENCE_CONFLICT");
    await this.client.query("INSERT INTO ledger_transactions(transaction_id, reference, unit) VALUES ($1, $2, 'sat')", [id("ledger", input.settlement.settlementReference), input.settlement.settlementReference]);
    await this.client.query("INSERT INTO top_ups(top_up_id, account_id, rail, amount, unit, state, settlement_reference) VALUES ($1,$2,$3,$4,'sat','credited',$5)", [input.settlement.topUpId, this.accountId, input.settlement.rail, amount.toString(), input.settlement.settlementReference]);
    await this.client.query("INSERT INTO settlement_attempts(attempt_id, top_up_id, external_reference, observed_state) VALUES ($1,$2,$3,'verified')", [id("attempt", input.settlement.topUpId), input.settlement.topUpId, input.settlement.externalReference]);
    await this.client.query("INSERT INTO account_balance_projection(account_id, unit, settled_available, held) VALUES ($1,'sat',$2,0) ON CONFLICT (account_id) DO UPDATE SET settled_available = account_balance_projection.settled_available + EXCLUDED.settled_available", [this.accountId, amount.toString()]);
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
    const result = frozen({ status: "accepted" as const, accountId: this.accountId, reference: input.capacityReference, approvedCap: amount.toString(), heldAmount: amount.toString(), unit: "sat" as const });
    await this.command(input.idempotencyKey, input.fingerprint, result); await this.outbox(input.capacityReference, "funded_admission_accepted", result); return result;
  }
  async findCapacityIntent(idempotencyKey: string): Promise<CapacityIntent | undefined> { const result = await this.client.query("SELECT account_id,idempotency_key,fingerprint_sha256,intent_reference,state,capacity_reference,expires_at FROM capacity_intents WHERE account_id=$1 AND idempotency_key=$2", [this.accountId, idempotencyKey]); return result.rows[0] && this.intent(result.rows[0]); }
  async createCapacityIntent(input: CapacityIntentInput): Promise<CapacityIntent> { this.assertScope(input.accountId); const prior = await this.findCapacityIntent(input.idempotencyKey); if (prior) { if (prior.fingerprint !== input.fingerprint || prior.intentReference !== input.intentReference) throw new Error("IDEMPOTENCY_KEY_CONFLICT"); return prior; } await this.client.query("INSERT INTO capacity_intents(intent_id,account_id,idempotency_key,fingerprint_sha256,intent_reference,state) VALUES ($1,$2,$3,$4,$5,'created')", [id("capacity", input.intentReference), this.accountId, input.idempotencyKey, input.fingerprint, input.intentReference]); return { ...input, state: "created" }; }
  async claimCapacityDispatch(intentReference: string): Promise<CapacityDispatchClaim> { const updated = await this.client.query("UPDATE capacity_intents SET state='dispatching' WHERE account_id=$1 AND intent_reference=$2 AND state='created' RETURNING account_id,idempotency_key,fingerprint_sha256,intent_reference,state,capacity_reference,expires_at", [this.accountId, intentReference]); if (updated.rows[0]) return frozen({ intent: this.intent(updated.rows[0]), claimed: true }); const current = first(await this.client.query("SELECT account_id,idempotency_key,fingerprint_sha256,intent_reference,state,capacity_reference,expires_at FROM capacity_intents WHERE account_id=$1 AND intent_reference=$2", [this.accountId, intentReference]), "CAPACITY_INTENT_NOT_FOUND"); return frozen({ intent: this.intent(current), claimed: false }); }
  async recordCapacityObservation(input: CapacityObservationInput): Promise<CapacityIntent> { const row = first(await this.client.query("UPDATE capacity_intents SET state=$3, capacity_reference=COALESCE($4,capacity_reference), expires_at=COALESCE($5,expires_at) WHERE account_id=$1 AND intent_reference=$2 RETURNING account_id,idempotency_key,fingerprint_sha256,intent_reference,state,capacity_reference,expires_at", [this.accountId, input.intentReference, input.state, input.capacityReference ?? null, input.expiresAt ?? null]), "CAPACITY_INTENT_NOT_FOUND"); return this.intent(row); }
  async releaseCapacityIntent(intentReference: string): Promise<CapacityIntent> { const row = first(await this.client.query("UPDATE capacity_intents SET state='released' WHERE account_id=$1 AND intent_reference=$2 RETURNING account_id,idempotency_key,fingerprint_sha256,intent_reference,state,capacity_reference,expires_at", [this.accountId, intentReference]), "CAPACITY_INTENT_NOT_FOUND"); return this.intent(row); }
  async findActionBudget(idempotencyKey: string): Promise<ActionBudget | undefined> { const result = await this.client.query("SELECT account_id,admission_reference,idempotency_key,fingerprint_sha256,reservation_reference,amount FROM action_budget_reservations WHERE account_id=$1 AND idempotency_key=$2", [this.accountId, idempotencyKey]); const row = result.rows[0]; return row && frozen({ accountId: asText(row.account_id), admissionReference: asText(row.admission_reference), idempotencyKey: asText(row.idempotency_key), fingerprint: asText(row.fingerprint_sha256), reference: asText(row.reservation_reference), amount: asBigInt(row.amount) }); }
  async reserveActionBudget(input: ActionBudgetInput): Promise<ActionBudget> { this.assertScope(input.accountId); const prior = await this.findActionBudget(input.idempotencyKey); if (prior) { if (prior.fingerprint !== input.fingerprint) throw new Error("IDEMPOTENCY_KEY_CONFLICT"); return prior; } const hold = first(await this.client.query("SELECT held_amount FROM session_cap_holds WHERE account_id=$1 AND reference=$2 AND state='active'", [this.accountId, input.admissionReference]), "ACTIVE_ADMISSION_REQUIRED"); const already = first(await this.client.query<{ total: string }>("SELECT COALESCE(SUM(amount),0) AS total FROM action_budget_reservations WHERE account_id=$1 AND admission_reference=$2", [this.accountId, input.admissionReference]), "ACTION_BUDGET_TOTAL_MISSING"); if (input.amount <= 0n || input.amount > asBigInt(hold.held_amount) - asBigInt(already.total)) throw new Error("ACTION_BUDGET_EXCEEDS_APPROVED_CAP"); await this.client.query("INSERT INTO action_budget_reservations(reservation_id,account_id,admission_reference,idempotency_key,fingerprint_sha256,reservation_reference,amount,unit,state) VALUES ($1,$2,$3,$4,$5,$6,$7,'sat','authorized')", [id("budget", input.reference), this.accountId, input.admissionReference, input.idempotencyKey, input.fingerprint, input.reference, input.amount.toString()]); return frozen(input); }
  private async ensureAccount(accountId: string): Promise<void> { await this.client.query("INSERT INTO funding_accounts(account_id,unit) VALUES ($1,'sat') ON CONFLICT (account_id) DO NOTHING", [accountId]); }
  private async command(idempotencyKey: string, fingerprint: string, result: FundingResult): Promise<void> { await this.client.query("INSERT INTO funding_commands(account_id,command_kind,idempotency_key,fingerprint_sha256,result_json) VALUES ($1,$2,$3,$4,$5)", [this.accountId, commandKind, idempotencyKey, fingerprint, JSON.stringify(result)]); }
  private async outbox(reference: string, kind: string, payload: unknown): Promise<void> { await this.client.query("INSERT INTO funding_outbox(outbox_id,aggregate_reference,event_kind,payload_json) VALUES ($1,$2,$3,$4)", [id("outbox", `${reference}:${kind}`), reference, kind, JSON.stringify(payload)]); }
  private assertScope(accountId: string): void { if (accountId !== this.accountId) throw new Error("ACCOUNT_SCOPE_MISMATCH"); }
  private intent(row: SqlRow): CapacityIntent { return frozen({ accountId: asText(row.account_id), idempotencyKey: asText(row.idempotency_key), fingerprint: asText(row.fingerprint_sha256), intentReference: asText(row.intent_reference), state: asText(row.state) as CapacityIntent["state"], ...(row.capacity_reference ? { capacityReference: asText(row.capacity_reference) } : {}), ...(row.expires_at ? { expiresAt: new Date(asText(row.expires_at)).toISOString() } : {}) }); }
}
