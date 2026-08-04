import type { Kysely } from "kysely";
import type { Pool } from "pg";
import type { AccountStatus, FundedAdmission, FundingResult } from "../phase-03/contracts";
import type { ActionBudget, ActionBudgetInput, AdmissionInput, BillingLineItem, BillingLineItemPage, BillingLineItemPageRequest, CapacityIntent, CapacityIntentInput, CapacityObservationInput, CreditInput, MeteredAction, MeteredFinalizeInput, MeteredFundingStore, MeteredFundingTransaction, MeteredOperationClaim, MeteredSessionRecord, PrepareMeteredActionInput, ReconciliationClaim, StoredFundingCommand, UsageUnknownInput } from "./funding-store";

type Hold = Readonly<{ reference: string; approvedCap: bigint; heldAmount: bigint }>;
type TopUp = Readonly<{ topUpId: string; rail: "lightning" | "cashu"; amount: bigint; settlementReference: string; externalReference: string; verifiedAt: string }>;
type LedgerTransaction = Readonly<{ id: string; reference: string; balanced: true; entries: readonly Readonly<{ accountId: string; direction: "debit" | "credit"; amount: string }>[] }>;
type State = { accounts: Map<string, { settled: bigint; held: bigint; topUps: TopUp[]; holds: Hold[] }>; commands: Map<string, StoredFundingCommand>; capacityIntents: Map<string, CapacityIntent>; actionBudgets: Map<string, ActionBudget>; meteredActions: Map<string, MeteredAction>; billingLineItems: BillingLineItem[]; settlements: Set<string>; externals: Set<string>; ledgerTransactions: LedgerTransaction[]; outbox: readonly { id: string; reference: string; kind: string }[] };
const key = (accountId: string, idempotencyKey: string) => `${accountId.length}:${accountId}${idempotencyKey.length}:${idempotencyKey}`;
const frozen = <T>(value: T): T => Object.freeze(structuredClone(value));
const copy = (state: State): State => structuredClone(state);
const account = (state: State, accountId: string) => state.accounts.get(accountId) ?? { settled: 0n, held: 0n, topUps: [], holds: [] };
const line = (state: State, input: Omit<BillingLineItem, "id" | "sequence">) => { const sequence = String(state.billingLineItems.length + 1); state.billingLineItems.push(frozen({ ...input, id: `billing:${input.accountId}:${sequence}`, sequence })); };
const lineCursor = (accountId: string, item: BillingLineItem) => Buffer.from(JSON.stringify({ v: 1, a: accountId, s: item.sequence, i: item.id })).toString("base64url");
export class SerializationFailure extends Error { code = "40001"; constructor() { super("SERIALIZATION_FAILURE"); } }

/**
 * A narrow PostgreSQL-wire transaction seam. Production composition must inject a
 * pg/Kysely-backed implementation; no SQLite or in-memory authority is selected by
 * this adapter. The deterministic implementation below exists only for store tests.
 */
export interface PostgresFundingExecutor {
  serializable<T>(closure: (state: State) => T): Promise<T>;
  read<T>(reader: (state: State) => T): Promise<T>;
}

export type PostgresFundingOptions = Readonly<{ maxAttempts?: number; deadlineMs?: number; now?: () => number }>;
export class PostgresFundingStore implements MeteredFundingStore {
  readonly #maxAttempts: number; readonly #deadlineMs: number; readonly #now: () => number;
  constructor(private readonly executor: PostgresFundingExecutor, options: PostgresFundingOptions = {}) {
    this.#maxAttempts = options.maxAttempts ?? 3; this.#deadlineMs = options.deadlineMs ?? 250; this.#now = options.now ?? Date.now;
    if (this.#maxAttempts < 1 || this.#deadlineMs < 1) throw new Error("INVALID_SERIALIZATION_RETRY_POLICY");
  }
  async findRecordedResult(accountId: string, idempotencyKey: string): Promise<StoredFundingCommand | undefined> {
    return this.executor.read((state) => { const found = state.commands.get(key(accountId, idempotencyKey)); return found && frozen(found); });
  }
  async findMeteredAction(accountId: string, idempotencyKey: string): Promise<MeteredAction | undefined> { return this.executor.read((state) => { const value = state.meteredActions.get(key(accountId, idempotencyKey)); return value && frozen(value); }); }
  async findMeteredActionByOperation(accountId: string, operationId: string): Promise<MeteredAction | undefined> { return this.executor.read((state) => { const value = [...state.meteredActions.values()].find((action) => action.accountId === accountId && action.operationId === operationId); return value && frozen(value); }); }
  async listBillingLineItems(accountId: string, request: BillingLineItemPageRequest = {}): Promise<BillingLineItemPage> {
    const limit = request.limit ?? 50; if (!Number.isInteger(limit) || limit < 1 || limit > 50) throw new Error("BILLING_LINE_ITEM_PAGE_LIMIT_INVALID");
    return this.executor.read((state) => {
      const all = state.billingLineItems.filter((item) => item.accountId === accountId);
      let start = 0;
      if (request.cursor) try { const value = JSON.parse(Buffer.from(request.cursor, "base64url").toString("utf8")) as { v?: number; a?: string; s?: string; i?: string }; const index = all.findIndex((item) => item.sequence === value.s && item.id === value.i); if (value.v !== 1 || value.a !== accountId || index < 0) throw new Error(); start = index + 1; } catch { throw new Error("INVALID_BILLING_LINE_ITEM_CURSOR"); }
      const items = all.slice(start, start + limit); const last = items.at(-1); return frozen({ items, ...(last && start + items.length < all.length ? { nextCursor: lineCursor(accountId, last) } : {}) });
    });
  }
  async sessionStatus(accountId: string, sessionId: string): Promise<MeteredSessionRecord | undefined> { return this.executor.read((state) => { const action = [...state.meteredActions.values()].filter((item) => item.accountId === accountId && item.sessionId === sessionId).at(-1); if (!action) return undefined; return frozen({ accountId, sessionId, version: action.sessionVersion ?? action.expectedVersion, status: action.status === "completed" ? "verified" : action.status === "dispatching" ? "active" : action.status }); }); }
  async transact<T>(accountId: string, operation: (transaction: MeteredFundingTransaction) => Promise<T> | T): Promise<T> {
    const deadline = this.#now() + this.#deadlineMs;
    let last: unknown;
    for (let attempt = 1; attempt <= this.#maxAttempts && this.#now() <= deadline; attempt += 1) {
      try {
        return await this.executor.serializable(async (state) => {
          // The closure contains only canonical SQL-state mutation logic. Rail/provider
          // I/O is deliberately outside this retryable boundary.
          const tx: MeteredFundingTransaction = {
            findRecordedResult: async (idempotencyKey) => state.commands.get(key(accountId, idempotencyKey)),
            creditVerifiedSettlement: async (input) => this.credit(state, accountId, input),
            acceptFundedAdmission: async (input) => this.admit(state, accountId, input),
            findCapacityIntent: async (idempotencyKey) => state.capacityIntents.get(key(accountId, idempotencyKey)),
            createCapacityIntent: async (input) => this.createCapacityIntent(state, accountId, input),
            claimCapacityDispatch: async (intentReference) => this.claimCapacityDispatch(state, accountId, intentReference),
            recordCapacityObservation: async (input) => this.recordCapacityObservation(state, accountId, input),
            releaseCapacityIntent: async (intentReference) => this.releaseCapacityIntent(state, accountId, intentReference),
            findActionBudget: async (idempotencyKey) => state.actionBudgets.get(key(accountId, idempotencyKey)),
            reserveActionBudget: async (input) => this.reserveActionBudget(state, accountId, input),
            prepareMeteredAction: async (input) => this.prepareMeteredAction(state, accountId, input),
            claimProviderOperation: async (operationId) => this.claimProviderOperation(state, accountId, operationId),
            recordUsageUnknown: async (input) => this.recordUsageUnknown(state, accountId, input),
            claimReconciliation: async (operationId) => this.claimReconciliation(state, accountId, operationId),
            recordUsageReceipt: async (input) => this.recordUsageReceipt(state, accountId, input),
            finalizeMeteredAction: async (input) => this.finalizeMeteredAction(state, accountId, input),
          };
          return frozen(await operation(tx));
        });
      } catch (error) {
        last = error;
        if (!(error instanceof SerializationFailure) || attempt === this.#maxAttempts || this.#now() > deadline) throw error;
      }
    }
    throw last ?? new Error("SERIALIZATION_RETRY_EXHAUSTED");
  }
  async status(accountId: string): Promise<AccountStatus | undefined> {
    return this.executor.read((state) => {
      const value = state.accounts.get(accountId); if (!value) return undefined;
      return frozen({ accountId, unit: "sat", available: (value.settled - value.held).toString(), held: value.held.toString(), topUps: value.topUps.map((topUp) => ({ topUpId: topUp.topUpId, state: "credited" as const, amount: topUp.amount.toString(), unit: "sat" as const, rail: topUp.rail, createdAt: topUp.verifiedAt, verifiedAt: topUp.verifiedAt, settlementReference: topUp.settlementReference })), admissions: value.holds.map((hold) => ({ reference: hold.reference, approvedCap: hold.approvedCap.toString(), heldAmount: hold.heldAmount.toString(), unit: "sat" as const })) });
    });
  }
  private credit(state: State, accountId: string, input: CreditInput): FundingResult {
    if (input.accountId !== accountId) throw new Error("ACCOUNT_SCOPE_MISMATCH");
    if (state.settlements.has(input.settlement.settlementReference) || state.externals.has(input.settlement.externalReference)) throw new Error("SETTLEMENT_REFERENCE_CONFLICT");
    const amount = BigInt(input.settlement.amount); if (amount <= 0n) throw new Error("INVALID_SETTLEMENT_AMOUNT");
    const current = account(state, accountId); current.settled += amount; current.topUps.push({ topUpId: input.settlement.topUpId, rail: input.settlement.rail, amount, settlementReference: input.settlement.settlementReference, externalReference: input.settlement.externalReference, verifiedAt: input.settlement.verifiedAt }); state.accounts.set(accountId, current);
    line(state, { accountId, sourceIdentity: `settlement:${input.settlement.settlementReference}`, kind: "credit", unit: "sat", amount: amount.toString(), settledAvailable: current.settled.toString(), held: current.held.toString(), sessionSpend: "0" });
    state.settlements.add(input.settlement.settlementReference); state.externals.add(input.settlement.externalReference);
    state.ledgerTransactions.push(frozen({ id: `ledger:${input.settlement.settlementReference}`, reference: input.settlement.settlementReference, balanced: true as const, entries: [{ accountId, direction: "credit" as const, amount: amount.toString() }, { accountId: "treasury:clearing", direction: "debit" as const, amount: amount.toString() }] }));
    state.outbox = [...state.outbox, frozen({ id: `outbox:${input.settlement.settlementReference}`, reference: input.settlement.settlementReference, kind: "account_credited" })];
    const result = frozen({ status: "credited" as const, accountId, topUpId: input.settlement.topUpId, creditedAmount: amount.toString(), unit: "sat" as const, settlementReference: input.settlement.settlementReference }); state.commands.set(key(accountId, input.idempotencyKey), frozen({ fingerprint: input.fingerprint, result })); return result;
  }
  private admit(state: State, accountId: string, input: AdmissionInput): FundedAdmission {
    if (input.accountId !== accountId) throw new Error("ACCOUNT_SCOPE_MISMATCH"); const current = account(state, accountId); const available = current.settled - current.held; const held = input.requestedCap < available ? input.requestedCap : available;
    if (held <= 0n) throw new Error("INSUFFICIENT_SETTLED_BALANCE"); current.held += held; current.holds.push({ reference: input.capacityReference, approvedCap: held, heldAmount: held }); state.accounts.set(accountId, current);
    line(state, { accountId, sourceIdentity: `cap_hold:${input.capacityReference}`, kind: "cap_hold", unit: "sat", amount: held.toString(), settledAvailable: current.settled.toString(), held: current.held.toString(), sessionSpend: "0" });
    state.outbox = [...state.outbox, frozen({ id: `outbox:${input.capacityReference}`, reference: input.capacityReference, kind: "funded_admission_accepted" })];
    const result = frozen({ status: "accepted" as const, accountId, reference: input.capacityReference, approvedCap: held.toString(), heldAmount: held.toString(), unit: "sat" as const }); state.commands.set(key(accountId, input.idempotencyKey), frozen({ fingerprint: input.fingerprint, result })); return result;
  }
  private createCapacityIntent(state: State, accountId: string, input: CapacityIntentInput): CapacityIntent {
    if (input.accountId !== accountId) throw new Error("ACCOUNT_SCOPE_MISMATCH"); const command = key(accountId, input.idempotencyKey); const existing = state.capacityIntents.get(command);
    if (existing) { if (existing.fingerprint !== input.fingerprint || existing.intentReference !== input.intentReference) throw new Error("IDEMPOTENCY_KEY_CONFLICT"); return existing; }
    const next = frozen({ ...input, state: "created" as const }); state.capacityIntents.set(command, next); return next;
  }
  private claimCapacityDispatch(state: State, accountId: string, intentReference: string) {
    const current = [...state.capacityIntents.values()].find((intent) => intent.accountId === accountId && intent.intentReference === intentReference);
    if (!current) throw new Error("CAPACITY_INTENT_NOT_FOUND");
    if (current.state !== "created") return frozen({ intent: current, claimed: false });
    const next = frozen({ ...current, state: "dispatching" as const }); state.capacityIntents.set(key(accountId, current.idempotencyKey), next);
    return frozen({ intent: next, claimed: true });
  }
  private recordCapacityObservation(state: State, accountId: string, input: CapacityObservationInput): CapacityIntent {
    const current = [...state.capacityIntents.values()].find((intent) => intent.accountId === accountId && intent.intentReference === input.intentReference); if (!current) throw new Error("CAPACITY_INTENT_NOT_FOUND");
    if (current.state === "released" || current.state === "refused") return current;
    if (input.state === "available" && (!input.capacityReference || !input.expiresAt)) throw new Error("CAPACITY_OBSERVATION_INVALID");
    const next = frozen({ ...current, state: input.state, ...(input.capacityReference ? { capacityReference: input.capacityReference } : {}), ...(input.expiresAt ? { expiresAt: input.expiresAt } : {}) }); state.capacityIntents.set(key(accountId, current.idempotencyKey), next); return next;
  }
  private releaseCapacityIntent(state: State, accountId: string, intentReference: string): CapacityIntent {
    const current = [...state.capacityIntents.values()].find((intent) => intent.accountId === accountId && intent.intentReference === intentReference); if (!current) throw new Error("CAPACITY_INTENT_NOT_FOUND"); const next = frozen({ ...current, state: "released" as const }); state.capacityIntents.set(key(accountId, current.idempotencyKey), next); return next;
  }
  private reserveActionBudget(state: State, accountId: string, input: ActionBudgetInput): ActionBudget {
    if (input.accountId !== accountId) throw new Error("ACCOUNT_SCOPE_MISMATCH"); const command = key(accountId, input.idempotencyKey); const existing = state.actionBudgets.get(command); if (existing) { if (existing.fingerprint !== input.fingerprint) throw new Error("IDEMPOTENCY_KEY_CONFLICT"); return existing; }
    const current = account(state, accountId); const hold = current.holds.find((candidate) => candidate.reference === input.admissionReference); if (!hold) throw new Error("ACTIVE_ADMISSION_REQUIRED"); const reserved = [...state.actionBudgets.values()].filter((budget) => budget.accountId === accountId && budget.admissionReference === input.admissionReference).reduce((total, budget) => total + budget.amount, 0n);
    if (input.amount <= 0n || input.amount > hold.approvedCap - reserved) throw new Error("ACTION_BUDGET_EXCEEDS_APPROVED_CAP"); const next = frozen(input); state.actionBudgets.set(command, next); line(state, { accountId, sourceIdentity: `action_reservation:${input.reference}`, kind: "action_reservation", unit: "sat", amount: input.amount.toString(), settledAvailable: current.settled.toString(), held: current.held.toString(), sessionSpend: "0" }); return next;
  }
  private prepareMeteredAction(state: State, accountId: string, input: PrepareMeteredActionInput): MeteredAction {
    if (input.accountId !== accountId) throw new Error("ACCOUNT_SCOPE_MISMATCH"); const command = key(accountId, input.idempotencyKey); const existing = state.meteredActions.get(command);
    if (existing) { if (existing.fingerprint !== input.fingerprint || existing.operationId !== input.operationId) throw new Error("IDEMPOTENCY_KEY_CONFLICT"); return existing; }
    const budget = [...state.actionBudgets.values()].find((item) => item.accountId === accountId && item.reference === input.actionBudgetReference);
    if (!budget || budget.admissionReference !== input.admissionReference || budget.amount !== input.maximum) throw new Error("METERED_ACTION_BUDGET_MISMATCH"); const next = frozen({ ...input, status: "prepared" as const }); state.meteredActions.set(command, next); return next;
  }
  private claimProviderOperation(state: State, accountId: string, operationId: string): MeteredOperationClaim {
    const action = [...state.meteredActions.values()].find((item) => item.accountId === accountId && item.operationId === operationId); if (!action) throw new Error("METERED_OPERATION_NOT_FOUND");
    if (action.status !== "prepared") return frozen({ action, claimed: false }); const next = frozen({ ...action, status: "dispatching" as const }); state.meteredActions.set(key(accountId, action.idempotencyKey), next); return frozen({ action: next, claimed: true });
  }
  private recordUsageUnknown(state: State, accountId: string, input: UsageUnknownInput): MeteredAction {
    const action = [...state.meteredActions.values()].find((item) => item.accountId === accountId && item.operationId === input.operationId); if (!action) throw new Error("METERED_OPERATION_NOT_FOUND");
    if (action.status === "usage_unknown") return action;
    if (action.status !== "dispatching") throw new Error("METERED_UNKNOWN_STATE_INVALID");
    const next = frozen({ ...action, status: "usage_unknown" as const, providerReceiptReference: input.protectedEvidenceReference, providerRequestId: input.providerRequestId, reconciliationReason: input.reason }); state.meteredActions.set(key(accountId, action.idempotencyKey), next);
    line(state, { accountId, sessionId: action.sessionId, actionId: action.actionId, operationId: action.operationId, sourceIdentity: `reconciliation:${action.operationId}`, kind: "reconciliation", unit: "sat", amount: "0", settledAvailable: account(state, accountId).settled.toString(), held: account(state, accountId).held.toString(), sessionSpend: "0" }); return next;
  }
  private claimReconciliation(state: State, accountId: string, operationId: string): ReconciliationClaim {
    const action = [...state.meteredActions.values()].find((item) => item.accountId === accountId && item.operationId === operationId); if (!action) throw new Error("METERED_OPERATION_NOT_FOUND");
    if (action.status !== "usage_unknown" || action.reconciliationClaimed) return frozen({ action, claimed: false });
    const next = frozen({ ...action, reconciliationClaimed: true }); state.meteredActions.set(key(accountId, action.idempotencyKey), next); return frozen({ action: next, claimed: true });
  }
  private recordUsageReceipt(state: State, accountId: string, input: Readonly<{ operationId: string; protectedEvidenceReference: string }>): MeteredAction {
    const action = [...state.meteredActions.values()].find((item) => item.accountId === accountId && item.operationId === input.operationId); if (!action || (action.status !== "dispatching" && action.status !== "usage_unknown")) throw new Error("METERED_RECEIPT_STATE_INVALID");
    const next = frozen({ ...action, providerReceiptReference: input.protectedEvidenceReference }); state.meteredActions.set(key(accountId, action.idempotencyKey), next); return next;
  }
  private finalizeMeteredAction(state: State, accountId: string, input: MeteredFinalizeInput): MeteredAction {
    const action = state.meteredActions.get(key(accountId, input.idempotencyKey)); if (!action || action.operationId !== input.operationId) throw new Error("METERED_FINALIZATION_STATE_INVALID");
    if (action.result) { if (action.receiptCharge !== input.receiptCharge || action.providerReceiptReference !== input.providerReceiptReference) throw new Error("METERED_FINALIZATION_IDENTITY_CONFLICT"); return action; }
    if (action.status !== "dispatching" && action.status !== "usage_unknown") throw new Error("METERED_FINALIZATION_STATE_INVALID"); const charge = BigInt(input.receiptCharge); if (charge < 0n || charge > action.maximum) throw new Error("METERED_RECEIPT_EXCEEDS_RESERVATION");
    const current = account(state, accountId); const hold = current.holds.find((item) => item.reference === action.admissionReference); if (!hold || charge > hold.heldAmount || charge > current.settled) throw new Error("METERED_SETTLEMENT_EXCEEDS_HOLD");
    current.settled -= charge; current.held -= charge; current.holds = current.holds.map((item) => item.reference === hold.reference ? { ...item, heldAmount: item.heldAmount - charge } : item); state.accounts.set(accountId, current);
    const next = frozen({ ...action, status: input.status, receiptCharge: input.receiptCharge, providerReceiptReference: input.providerReceiptReference, result: structuredClone(input.result), sessionVersion: input.sessionVersion, artifactVersion: input.artifactVersion, remainingCap: (hold.heldAmount - charge).toString(), remainingBalance: current.settled.toString() }); state.meteredActions.set(key(accountId, action.idempotencyKey), next);
    state.ledgerTransactions.push(frozen({ id: `ledger:${action.operationId}`, reference: action.operationId, balanced: true as const, entries: [{ accountId, direction: "debit" as const, amount: charge.toString() }, { accountId: "treasury:clearing", direction: "credit" as const, amount: charge.toString() }] }));
    line(state, { accountId, sessionId: action.sessionId, actionId: action.actionId, operationId: action.operationId, sourceIdentity: `receipt:${input.providerReceiptReference}`, kind: "receipt", unit: "sat", amount: "0", settledAvailable: current.settled.toString(), held: current.held.toString(), sessionSpend: charge.toString() });
    line(state, { accountId, sessionId: action.sessionId, actionId: action.actionId, operationId: action.operationId, sourceIdentity: `debit:${action.operationId}`, kind: "debit", unit: "sat", amount: `-${charge}`, settledAvailable: current.settled.toString(), held: current.held.toString(), sessionSpend: charge.toString() });
    line(state, { accountId, sessionId: action.sessionId, actionId: action.actionId, operationId: action.operationId, sourceIdentity: `release:${action.operationId}`, kind: "release", unit: "sat", amount: (action.maximum - charge).toString(), settledAvailable: current.settled.toString(), held: current.held.toString(), sessionSpend: charge.toString() });
    state.outbox = [...state.outbox, frozen({ id: `outbox:${action.operationId}:finalized`, reference: action.operationId, kind: "metered_action_finalized" })]; return next;
  }
}

/** Deterministic test-only PostgreSQL transaction emulator; not a production fallback. */
export class DeterministicPostgresFundingExecutor implements PostgresFundingExecutor {
  #state: State = { accounts: new Map(), commands: new Map(), capacityIntents: new Map(), actionBudgets: new Map(), meteredActions: new Map(), billingLineItems: [], settlements: new Set(), externals: new Set(), ledgerTransactions: [], outbox: [] }; #tail = Promise.resolve(); #failures: number; #failCommit = false; retryAttempts = 0; externalEffectCount = 0;
  constructor(options: Readonly<{ serializationFailures?: number }> = {}) { this.#failures = options.serializationFailures ?? 0; }
  failNextCommit(): void { this.#failCommit = true; }
  async read<T>(reader: (state: State) => T): Promise<T> { return frozen(reader(this.#state)); }
  async serializable<T>(closure: (state: State) => T): Promise<T> { let release!: () => void; const prior = this.#tail; this.#tail = new Promise<void>((resolve) => { release = resolve; }); await prior; try { this.retryAttempts += 1; if (this.#failures-- > 0) throw new SerializationFailure(); const staged = copy(this.#state); const result = await closure(staged); if (this.#failCommit) { this.#failCommit = false; throw new Error("INJECTED_TRANSACTION_FAILURE"); } this.#state = staged; return frozen(result); } finally { release(); } }
  snapshot() { return frozen({ ledgerTransactions: this.#state.ledgerTransactions, holds: [...this.#state.accounts.values()].flatMap((item) => item.holds), capacityIntents: [...this.#state.capacityIntents.values()], actionBudgets: [...this.#state.actionBudgets.values()], meteredActions: [...this.#state.meteredActions.values()], billingLineItems: this.#state.billingLineItems, outbox: this.#state.outbox, projection: this.recomputeProjection() }); }
  recomputeProjection() { const projection: Record<string, { settled: string; held: string }> = {}; for (const [accountId, item] of this.#state.accounts) projection[accountId] = { settled: item.settled.toString(), held: item.held.toString() }; return frozen(projection); }
}

/** Production callers must provide the PostgreSQL-wire executor explicitly. */
export function createPostgresFundingStore(executor: PostgresFundingExecutor, options?: PostgresFundingOptions): PostgresFundingStore { return new PostgresFundingStore(executor, options); }
export type PostgresDriverDependencies = Readonly<{ pool: Pool; db: Kysely<never> }>;
