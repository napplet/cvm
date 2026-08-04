import type { AccountStatus, FundedAdmission, FundingResult, VerifiedSettlement } from "../phase-03/contracts";

export type LedgerPosting = Readonly<{ id: string; accountId: string; reference: string; unit: "sat"; amount: string; balanced: true }>;
export type FundingEvidence = Readonly<{ id: string; accountId: string; kind: "settlement_credit" | "funded_admission" | "metered_receipt" | "metered_result"; reference: string }>;
export type FundingOutbox = Readonly<{ id: string; accountId: string; kind: "account_credited" | "funded_admission_accepted" | "metered_action_finalized"; reference: string }>;
export type StoredFundingCommand = Readonly<{ fingerprint: string; result: FundingResult }>;

export type CreditInput = Readonly<{ accountId: string; fingerprint: string; idempotencyKey: string; settlement: VerifiedSettlement }>;
export type AdmissionInput = Readonly<{ accountId: string; fingerprint: string; idempotencyKey: string; requestedCap: bigint; capacityReference: string }>;
export type CapacityIntent = Readonly<{ accountId: string; idempotencyKey: string; fingerprint: string; intentReference: string; state: "created" | "dispatching" | "available" | "refused" | "reconciliation_pending" | "released"; capacityReference?: string; expiresAt?: string }>;
export type CapacityIntentInput = Readonly<{ accountId: string; idempotencyKey: string; fingerprint: string; intentReference: string }>;
export type CapacityDispatchClaim = Readonly<{ intent: CapacityIntent; claimed: boolean }>;
export type CapacityObservationInput = Readonly<{ intentReference: string; state: "available" | "refused" | "reconciliation_pending"; capacityReference?: string; expiresAt?: string }>;
export type ActionBudget = Readonly<{ accountId: string; admissionReference: string; idempotencyKey: string; fingerprint: string; reference: string; amount: bigint }>;
export type ActionBudgetInput = Readonly<{ accountId: string; admissionReference: string; idempotencyKey: string; fingerprint: string; reference: string; amount: bigint }>;
export type MeteredActionStatus = "prepared" | "dispatching" | "usage_unknown" | "completed" | "failed" | "billing_invariant_failed";
export type MeteredAction = Readonly<{ accountId: string; idempotencyKey: string; fingerprint: string; sessionId: string; actionId: string; expectedVersion: number; admissionReference: string; actionBudgetReference: string; maximum: bigint; operationId: string; profileId: string; priceCardId: string; status: MeteredActionStatus; receiptCharge?: string; providerReceiptReference?: string; providerRequestId?: string; reconciliationReason?: string; reconciliationClaimed?: boolean; result?: unknown; sessionVersion?: number; artifactVersion?: number; remainingCap?: string; remainingBalance?: string }>;
export type PrepareMeteredActionInput = Omit<MeteredAction, "status" | "receiptCharge" | "providerReceiptReference" | "result" | "sessionVersion" | "artifactVersion">;
export type MeteredOperationClaim = Readonly<{ action: MeteredAction; claimed: boolean }>;
export type ReconciliationClaim = Readonly<{ action: MeteredAction; claimed: boolean }>;
export type UsageUnknownInput = Readonly<{ operationId: string; providerRequestId: string; protectedEvidenceReference: string; reason: string }>;
export type MeteredFinalizeInput = Readonly<{ idempotencyKey: string; operationId: string; receiptCharge: string; providerReceiptReference: string; status: Extract<MeteredActionStatus, "completed" | "failed" | "billing_invariant_failed">; result: unknown; sessionVersion: number; artifactVersion: number }>;
export type BillingLineItemKind = "credit" | "cap_hold" | "action_reservation" | "receipt" | "debit" | "release" | "reconciliation";
/** Immutable owner-scoped financial projection. Amounts and projections are canonical decimal strings. */
export type BillingLineItem = Readonly<{ id: string; sequence: string; accountId: string; sessionId?: string; actionId?: string; operationId?: string; sourceIdentity: string; kind: BillingLineItemKind; unit: "sat"; amount: string; settledAvailable: string; held: string; sessionSpend: string }>;
export type BillingLineItemPage = Readonly<{ items: readonly BillingLineItem[]; nextCursor?: string }>;
export type BillingLineItemPageRequest = Readonly<{ limit?: number; cursor?: string }>;
export type MeteredSessionRecord = Readonly<{ accountId: string; sessionId: string; version: number; status: "prepared" | "active" | "failed" | "usage_unknown" | "billing_invariant_failed" | "verified" }>;
export type MeteredActionRecord = MeteredAction;
export type ProviderOperationRecord = Readonly<{ accountId: string; operationId: string; actionId: string; status: MeteredActionStatus; providerReceiptReference?: string }>;
export type UsageReceiptRecord = Readonly<{ accountId: string; operationId: string; providerReceiptReference: string; charge: string }>;
export type MeteredFinalizationInput = MeteredFinalizeInput;
export type MeteredFinalizationResult = MeteredAction;

export interface FundingTransaction {
  findRecordedResult(idempotencyKey: string): Promise<StoredFundingCommand | undefined>;
  creditVerifiedSettlement(input: CreditInput): Promise<FundingResult>;
  acceptFundedAdmission(input: AdmissionInput): Promise<FundedAdmission>;
  findCapacityIntent(idempotencyKey: string): Promise<CapacityIntent | undefined>;
  createCapacityIntent(input: CapacityIntentInput): Promise<CapacityIntent>;
  /** Atomically fences the sole external capacity-reservation attempt. */
  claimCapacityDispatch(intentReference: string): Promise<CapacityDispatchClaim>;
  recordCapacityObservation(input: CapacityObservationInput): Promise<CapacityIntent>;
  releaseCapacityIntent(intentReference: string): Promise<CapacityIntent>;
  findActionBudget(idempotencyKey: string): Promise<ActionBudget | undefined>;
  reserveActionBudget(input: ActionBudgetInput): Promise<ActionBudget>;
}

export interface MeteredFundingTransaction extends FundingTransaction {
  prepareMeteredAction(input: PrepareMeteredActionInput): Promise<MeteredAction>;
  /** Atomically fences the sole billable provider dispatch for an operation ID. */
  claimProviderOperation(operationId: string): Promise<MeteredOperationClaim>;
  /** Persists ambiguity without releasing authorization or creating a terminal receipt. */
  recordUsageUnknown(input: UsageUnknownInput): Promise<MeteredAction>;
  /** Claims the single lookup-only recovery attempt for an ambiguous original operation. */
  claimReconciliation(operationId: string): Promise<ReconciliationClaim>;
  /** Releases a nonterminal lookup claim so a later call can retry the original operation. */
  releaseReconciliation(operationId: string): Promise<MeteredAction>;
  recordUsageReceipt(input: Readonly<{ operationId: string; protectedEvidenceReference: string }>): Promise<MeteredAction>;
  finalizeMeteredAction(input: MeteredFinalizeInput): Promise<MeteredAction>;
}

/** Serializable financial authority port. Rail adapters never receive a posting or balance mutation API. */
export interface FundingStore {
  findRecordedResult(accountId: string, idempotencyKey: string): Promise<StoredFundingCommand | undefined>;
  transact<T>(accountId: string, operation: (transaction: FundingTransaction) => Promise<T> | T): Promise<T>;
  status(accountId: string): Promise<AccountStatus | undefined>;
}

/** Phase 4's explicit metered extension. Production SQL composition is added in the following plan. */
export interface MeteredFundingStore extends FundingStore {
  findMeteredAction(accountId: string, idempotencyKey: string): Promise<MeteredAction | undefined>;
  findMeteredActionByOperation(accountId: string, operationId: string): Promise<MeteredAction | undefined>;
  /** Owner-scoped history used to bind one automatic repair to its failed action. */
  listMeteredActionsForSession(accountId: string, sessionId: string): Promise<readonly MeteredAction[]>;
  listBillingLineItems(accountId: string, request?: BillingLineItemPageRequest): Promise<BillingLineItemPage>;
  sessionStatus(accountId: string, sessionId: string): Promise<MeteredSessionRecord | undefined>;
  transact<T>(accountId: string, operation: (transaction: MeteredFundingTransaction) => Promise<T> | T): Promise<T>;
}

type TopUp = Readonly<{ topUpId: string; rail: "lightning" | "cashu"; unit: "sat"; amount: bigint; state: "credited"; verifiedAt: string; settlementReference: string; externalReference: string }>;
type Hold = Readonly<{ reference: string; approvedCap: bigint; heldAmount: bigint }>;
type Account = Readonly<{ settledAvailable: bigint; held: bigint; topUps: readonly TopUp[]; holds: readonly Hold[] }>;
type State = { accounts: Map<string, Account>; commands: Map<string, StoredFundingCommand>; capacityIntents: Map<string, CapacityIntent>; actionBudgets: Map<string, ActionBudget>; meteredActions: Map<string, MeteredAction>; externalReferences: Set<string>; settlementReferences: Set<string>; postings: LedgerPosting[]; evidence: FundingEvidence[]; outbox: FundingOutbox[]; lineItems: BillingLineItem[]; lineItemSequence: bigint };

function clone<T>(value: T): T { return structuredClone(value); }
function freeze<T>(value: T): T {
  if (value && typeof value === "object" && !Object.isFrozen(value)) {
    for (const child of Object.values(value as Record<string, unknown>)) freeze(child);
    Object.freeze(value);
  }
  return value;
}
function commandKey(accountId: string, idempotencyKey: string): string { return `${accountId.length}:${accountId}${idempotencyKey.length}:${idempotencyKey}`; }
function decimal(value: bigint): string { return value.toString(10); }
function accountFor(state: State, accountId: string): Account { return state.accounts.get(accountId) ?? freeze({ settledAvailable: 0n, held: 0n, topUps: [], holds: [] }); }
function copyState(state: State): State { return clone(state); }
function appendLineItem(state: State, input: Omit<BillingLineItem, "id" | "sequence">): void {
  state.lineItemSequence += 1n;
  state.lineItems.push(freeze({ ...input, id: `billing:${input.accountId}:${state.lineItemSequence}`, sequence: decimal(state.lineItemSequence) }));
}
function cursorFor(accountId: string, item: BillingLineItem): string { return Buffer.from(JSON.stringify({ v: 1, a: accountId, s: item.sequence, i: item.id })).toString("base64url"); }
function cursorAfter(accountId: string, cursor: string | undefined, items: readonly BillingLineItem[]): number {
  if (!cursor) return 0;
  try {
    const value = JSON.parse(Buffer.from(cursor, "base64url").toString("utf8")) as { v?: number; a?: string; s?: string; i?: string };
    const index = items.findIndex((item) => item.sequence === value.s && item.id === value.i);
    if (value.v !== 1 || value.a !== accountId || index < 0) throw new Error();
    return index + 1;
  } catch { throw new Error("INVALID_BILLING_LINE_ITEM_CURSOR"); }
}

/**
 * Deterministic, serialized copy-then-commit double for tests only. It is not
 * a durable ledger and must never be selected as production monetary storage.
 */
export class TransactionalMemoryFundingStore implements MeteredFundingStore {
  #state: State = { accounts: new Map(), commands: new Map(), capacityIntents: new Map(), actionBudgets: new Map(), meteredActions: new Map(), externalReferences: new Set(), settlementReferences: new Set(), postings: [], evidence: [], outbox: [], lineItems: [], lineItemSequence: 0n };
  #tail: Promise<void> = Promise.resolve();

  get postings(): readonly LedgerPosting[] { return freeze(clone(this.#state.postings)); }
  get evidence(): readonly FundingEvidence[] { return freeze(clone(this.#state.evidence)); }
  get outbox(): readonly FundingOutbox[] { return freeze(clone(this.#state.outbox)); }
  get activeHolds(): readonly Hold[] { return freeze(clone([...this.#state.accounts.values()].flatMap((account) => account.holds))); }
  get meteredActions(): readonly MeteredAction[] { return freeze(clone([...this.#state.meteredActions.values()])); }
  get billingLineItems(): readonly BillingLineItem[] { return freeze(clone(this.#state.lineItems)); }
  snapshot(): Readonly<{ postings: readonly LedgerPosting[]; evidence: readonly FundingEvidence[]; outbox: readonly FundingOutbox[]; accounts: readonly [string, Account][] }> {
    return freeze(clone({ postings: this.#state.postings, evidence: this.#state.evidence, outbox: this.#state.outbox, accounts: [...this.#state.accounts.entries()] }));
  }
  projection(accountId: string): Readonly<{ settledAvailable: string; held: string; unit: "sat" }> {
    const account = accountFor(this.#state, accountId);
    return freeze({ settledAvailable: decimal(account.settledAvailable), held: decimal(account.held), unit: "sat" });
  }

  async findRecordedResult(accountId: string, idempotencyKey: string): Promise<StoredFundingCommand | undefined> {
    const found = this.#state.commands.get(commandKey(accountId, idempotencyKey));
    return found ? freeze(clone(found)) : undefined;
  }
  async findMeteredAction(accountId: string, idempotencyKey: string): Promise<MeteredAction | undefined> {
    const found = this.#state.meteredActions.get(commandKey(accountId, idempotencyKey));
    return found ? freeze(clone(found)) : undefined;
  }
  async findMeteredActionByOperation(accountId: string, operationId: string): Promise<MeteredAction | undefined> {
    const found = [...this.#state.meteredActions.values()].find((action) => action.accountId === accountId && action.operationId === operationId);
    return found ? freeze(clone(found)) : undefined;
  }
  async listMeteredActionsForSession(accountId: string, sessionId: string): Promise<readonly MeteredAction[]> {
    return freeze(clone([...this.#state.meteredActions.values()].filter((action) => action.accountId === accountId && action.sessionId === sessionId)));
  }
  async listBillingLineItems(accountId: string, request: BillingLineItemPageRequest = {}): Promise<BillingLineItemPage> {
    const limit = request.limit ?? 50;
    if (!Number.isInteger(limit) || limit < 1 || limit > 50) throw new Error("BILLING_LINE_ITEM_PAGE_LIMIT_INVALID");
    const all = this.#state.lineItems.filter((item) => item.accountId === accountId).sort((left, right) => BigInt(left.sequence) < BigInt(right.sequence) ? -1 : BigInt(left.sequence) > BigInt(right.sequence) ? 1 : left.id.localeCompare(right.id));
    const start = cursorAfter(accountId, request.cursor, all);
    const items = all.slice(start, start + limit);
    const last = items.at(-1);
    return freeze({ items: freeze(clone(items)), ...(last && start + items.length < all.length ? { nextCursor: cursorFor(accountId, last) } : {}) });
  }
  async sessionStatus(accountId: string, sessionId: string): Promise<MeteredSessionRecord | undefined> {
    const actions = [...this.#state.meteredActions.values()].filter((action) => action.accountId === accountId && action.sessionId === sessionId);
    const action = actions.sort((left, right) => (right.sessionVersion ?? 0) - (left.sessionVersion ?? 0))[0];
    if (!action) return undefined;
    const status = action.status === "completed" ? "verified" : action.status === "dispatching" ? "active" : action.status;
    return freeze({ accountId, sessionId, version: action.sessionVersion ?? action.expectedVersion, status });
  }

  async transact<T>(accountId: string, operation: (transaction: MeteredFundingTransaction) => Promise<T> | T): Promise<T> {
    let release!: () => void;
    const prior = this.#tail;
    this.#tail = new Promise<void>((resolve) => { release = resolve; });
    await prior;
    try {
      const state = copyState(this.#state);
      const transaction: MeteredFundingTransaction = {
        findRecordedResult: async (idempotencyKey) => state.commands.get(commandKey(accountId, idempotencyKey)),
        creditVerifiedSettlement: async (input) => {
          if (input.accountId !== accountId) throw new Error("ACCOUNT_SCOPE_MISMATCH");
          if (state.externalReferences.has(input.settlement.externalReference) || state.settlementReferences.has(input.settlement.settlementReference)) throw new Error("SETTLEMENT_REFERENCE_CONFLICT");
          const amount = BigInt(input.settlement.amount);
          if (amount <= 0n) throw new Error("INVALID_SETTLEMENT_AMOUNT");
          const account = accountFor(state, accountId);
          const result = freeze({ status: "credited" as const, accountId, topUpId: input.settlement.topUpId, creditedAmount: decimal(amount), unit: "sat" as const, settlementReference: input.settlement.settlementReference });
          state.accounts.set(accountId, freeze({ ...account, settledAvailable: account.settledAvailable + amount, topUps: [...account.topUps, freeze({ topUpId: input.settlement.topUpId, rail: input.settlement.rail, unit: "sat" as const, amount, state: "credited" as const, verifiedAt: input.settlement.verifiedAt, settlementReference: input.settlement.settlementReference, externalReference: input.settlement.externalReference })] }));
          state.externalReferences.add(input.settlement.externalReference); state.settlementReferences.add(input.settlement.settlementReference);
          state.postings.push(freeze({ id: `posting:${input.settlement.settlementReference}`, accountId, reference: input.settlement.settlementReference, unit: "sat" as const, amount: decimal(amount), balanced: true as const }));
          appendLineItem(state, { accountId, sourceIdentity: `settlement:${input.settlement.settlementReference}`, kind: "credit", unit: "sat", amount: decimal(amount), settledAvailable: decimal(account.settledAvailable + amount), held: decimal(account.held), sessionSpend: "0" });
          state.evidence.push(freeze({ id: `evidence:${input.settlement.settlementReference}`, accountId, kind: "settlement_credit" as const, reference: input.settlement.settlementReference }));
          state.outbox.push(freeze({ id: `outbox:${input.settlement.settlementReference}`, accountId, kind: "account_credited" as const, reference: input.settlement.settlementReference }));
          state.commands.set(commandKey(accountId, input.idempotencyKey), freeze({ fingerprint: input.fingerprint, result }));
          return result;
        },
        acceptFundedAdmission: async (input) => {
          if (input.accountId !== accountId) throw new Error("ACCOUNT_SCOPE_MISMATCH");
          const account = accountFor(state, accountId);
          const available = account.settledAvailable - account.held;
          if (available <= 0n) throw new Error("INSUFFICIENT_SETTLED_BALANCE");
          const heldAmount = input.requestedCap < available ? input.requestedCap : available;
          if (heldAmount <= 0n) throw new Error("INVALID_CAP_HOLD");
          const result = freeze({ status: "accepted" as const, accountId, reference: input.capacityReference, approvedCap: decimal(heldAmount), heldAmount: decimal(heldAmount), unit: "sat" as const });
          state.accounts.set(accountId, freeze({ ...account, held: account.held + heldAmount, holds: [...account.holds, freeze({ reference: input.capacityReference, approvedCap: heldAmount, heldAmount })] }));
          appendLineItem(state, { accountId, sourceIdentity: `cap_hold:${input.capacityReference}`, kind: "cap_hold", unit: "sat", amount: decimal(heldAmount), settledAvailable: decimal(account.settledAvailable), held: decimal(account.held + heldAmount), sessionSpend: "0" });
          state.evidence.push(freeze({ id: `evidence:${input.capacityReference}`, accountId, kind: "funded_admission" as const, reference: input.capacityReference }));
          state.outbox.push(freeze({ id: `outbox:${input.capacityReference}`, accountId, kind: "funded_admission_accepted" as const, reference: input.capacityReference }));
          state.commands.set(commandKey(accountId, input.idempotencyKey), freeze({ fingerprint: input.fingerprint, result }));
          return result;
        },
        findCapacityIntent: async (idempotencyKey) => state.capacityIntents.get(commandKey(accountId, idempotencyKey)),
        createCapacityIntent: async (input) => {
          if (input.accountId !== accountId) throw new Error("ACCOUNT_SCOPE_MISMATCH");
          const key = commandKey(accountId, input.idempotencyKey); const existing = state.capacityIntents.get(key);
          if (existing) { if (existing.fingerprint !== input.fingerprint || existing.intentReference !== input.intentReference) throw new Error("IDEMPOTENCY_KEY_CONFLICT"); return existing; }
          const next = freeze({ ...input, state: "created" as const }); state.capacityIntents.set(key, next); return next;
        },
        claimCapacityDispatch: async (intentReference) => {
          const current = [...state.capacityIntents.values()].find((intent) => intent.accountId === accountId && intent.intentReference === intentReference);
          if (!current) throw new Error("CAPACITY_INTENT_NOT_FOUND");
          if (current.state !== "created") return freeze({ intent: current, claimed: false });
          const next = freeze({ ...current, state: "dispatching" as const }); state.capacityIntents.set(commandKey(accountId, current.idempotencyKey), next); return freeze({ intent: next, claimed: true });
        },
        recordCapacityObservation: async (input) => {
          const current = [...state.capacityIntents.values()].find((intent) => intent.accountId === accountId && intent.intentReference === input.intentReference);
          if (!current) throw new Error("CAPACITY_INTENT_NOT_FOUND");
          if (current.state === "released" || current.state === "refused") return current;
          if (input.state === "available" && (!input.capacityReference || !input.expiresAt)) throw new Error("CAPACITY_OBSERVATION_INVALID");
          const next = freeze({ ...current, state: input.state, ...(input.capacityReference ? { capacityReference: input.capacityReference } : {}), ...(input.expiresAt ? { expiresAt: input.expiresAt } : {}) });
          state.capacityIntents.set(commandKey(accountId, current.idempotencyKey), next); return next;
        },
        releaseCapacityIntent: async (intentReference) => {
          const current = [...state.capacityIntents.values()].find((intent) => intent.accountId === accountId && intent.intentReference === intentReference);
          if (!current) throw new Error("CAPACITY_INTENT_NOT_FOUND"); const next = freeze({ ...current, state: "released" as const }); state.capacityIntents.set(commandKey(accountId, current.idempotencyKey), next); return next;
        },
        findActionBudget: async (idempotencyKey) => state.actionBudgets.get(commandKey(accountId, idempotencyKey)),
        reserveActionBudget: async (input) => {
          if (input.accountId !== accountId) throw new Error("ACCOUNT_SCOPE_MISMATCH"); const key = commandKey(accountId, input.idempotencyKey); const existing = state.actionBudgets.get(key); if (existing) { if (existing.fingerprint !== input.fingerprint) throw new Error("IDEMPOTENCY_KEY_CONFLICT"); return existing; }
          const account = accountFor(state, accountId); const hold = account.holds.find((candidate) => candidate.reference === input.admissionReference); if (!hold) throw new Error("ACTIVE_ADMISSION_REQUIRED");
          const reserved = [...state.actionBudgets.values()].filter((budget) => budget.accountId === accountId && budget.admissionReference === input.admissionReference).reduce((total, budget) => total + budget.amount, 0n);
          if (input.amount <= 0n || input.amount > hold.approvedCap - reserved) throw new Error("ACTION_BUDGET_EXCEEDS_APPROVED_CAP"); const next = freeze(input); state.actionBudgets.set(key, next);
          appendLineItem(state, { accountId, sourceIdentity: `action_reservation:${input.reference}`, kind: "action_reservation", unit: "sat", amount: decimal(input.amount), settledAvailable: decimal(account.settledAvailable), held: decimal(account.held), sessionSpend: "0" });
          return next;
        },
        prepareMeteredAction: async (input) => {
          if (input.accountId !== accountId) throw new Error("ACCOUNT_SCOPE_MISMATCH");
          const key = commandKey(accountId, input.idempotencyKey); const existing = state.meteredActions.get(key);
          if (existing) { if (existing.fingerprint !== input.fingerprint || existing.expectedVersion !== input.expectedVersion) throw new Error("IDEMPOTENCY_KEY_CONFLICT"); return existing; }
          const budget = [...state.actionBudgets.values()].find((candidate) => candidate.accountId === accountId && candidate.reference === input.actionBudgetReference);
          if (!budget || budget.admissionReference !== input.admissionReference || budget.amount !== input.maximum) throw new Error("METERED_ACTION_BUDGET_MISMATCH");
          const action = freeze({ ...input, status: "prepared" as const }); state.meteredActions.set(key, action); return action;
        },
        claimProviderOperation: async (operationId) => {
          const found = [...state.meteredActions.values()].find((action) => action.accountId === accountId && action.operationId === operationId);
          if (!found) throw new Error("METERED_OPERATION_NOT_FOUND");
          if (found.status !== "prepared") return freeze({ action: found, claimed: false });
          const next = freeze({ ...found, status: "dispatching" as const }); state.meteredActions.set(commandKey(accountId, found.idempotencyKey), next); return freeze({ action: next, claimed: true });
        },
        recordUsageUnknown: async (input) => {
          const found = [...state.meteredActions.values()].find((action) => action.accountId === accountId && action.operationId === input.operationId);
          if (!found) throw new Error("METERED_OPERATION_NOT_FOUND");
          if (found.status === "usage_unknown") return found;
          if (found.status !== "dispatching") throw new Error("METERED_UNKNOWN_STATE_INVALID");
          const next = freeze({ ...found, status: "usage_unknown" as const, providerReceiptReference: input.protectedEvidenceReference, providerRequestId: input.providerRequestId, reconciliationReason: input.reason });
          state.meteredActions.set(commandKey(accountId, found.idempotencyKey), next);
          state.evidence.push(freeze({ id: `evidence:${input.operationId}:ambiguity`, accountId, kind: "metered_receipt" as const, reference: input.protectedEvidenceReference }));
          appendLineItem(state, { accountId, sessionId: found.sessionId, actionId: found.actionId, operationId: found.operationId, sourceIdentity: `reconciliation:${input.operationId}`, kind: "reconciliation", unit: "sat", amount: "0", settledAvailable: decimal(accountFor(state, accountId).settledAvailable), held: decimal(accountFor(state, accountId).held), sessionSpend: "0" });
          return next;
        },
        claimReconciliation: async (operationId) => {
          const found = [...state.meteredActions.values()].find((action) => action.accountId === accountId && action.operationId === operationId);
          if (!found) throw new Error("METERED_OPERATION_NOT_FOUND");
          if (found.status !== "usage_unknown" || found.reconciliationClaimed) return freeze({ action: found, claimed: false });
          const next = freeze({ ...found, reconciliationClaimed: true });
          state.meteredActions.set(commandKey(accountId, found.idempotencyKey), next);
          return freeze({ action: next, claimed: true });
        },
        releaseReconciliation: async (operationId) => {
          const found = [...state.meteredActions.values()].find((action) => action.accountId === accountId && action.operationId === operationId);
          if (!found) throw new Error("METERED_OPERATION_NOT_FOUND");
          if (found.status !== "usage_unknown" || !found.reconciliationClaimed) return found;
          const next = freeze({ ...found, reconciliationClaimed: false });
          state.meteredActions.set(commandKey(accountId, found.idempotencyKey), next);
          return next;
        },
        recordUsageReceipt: async (input) => {
          const found = [...state.meteredActions.values()].find((action) => action.accountId === accountId && action.operationId === input.operationId);
          if (!found || (found.status !== "dispatching" && found.status !== "usage_unknown")) throw new Error("METERED_RECEIPT_STATE_INVALID");
          const next = freeze({ ...found, providerReceiptReference: input.protectedEvidenceReference }); state.meteredActions.set(commandKey(accountId, found.idempotencyKey), next);
          state.evidence.push(freeze({ id: `evidence:${input.operationId}:receipt`, accountId, kind: "metered_receipt" as const, reference: input.protectedEvidenceReference })); return next;
        },
        finalizeMeteredAction: async (input) => {
          const found = state.meteredActions.get(commandKey(accountId, input.idempotencyKey));
          if (!found || found.operationId !== input.operationId) throw new Error("METERED_FINALIZATION_STATE_INVALID");
          if (found.result) {
            if (found.receiptCharge !== input.receiptCharge || found.providerReceiptReference !== input.providerReceiptReference) throw new Error("METERED_FINALIZATION_IDENTITY_CONFLICT");
            return found;
          }
          if (found.status !== "dispatching" && found.status !== "usage_unknown") throw new Error("METERED_FINALIZATION_STATE_INVALID");
          const receiptCharge = BigInt(input.receiptCharge); if (receiptCharge < 0n || receiptCharge > found.maximum) throw new Error("METERED_RECEIPT_EXCEEDS_RESERVATION");
          const account = accountFor(state, accountId); const hold = account.holds.find((candidate) => candidate.reference === found.admissionReference);
          if (!hold || receiptCharge > hold.heldAmount || receiptCharge > account.settledAvailable) throw new Error("METERED_SETTLEMENT_EXCEEDS_HOLD");
          const nextHold = freeze({ ...hold, heldAmount: hold.heldAmount - receiptCharge });
          const nextAccount = freeze({ ...account, settledAvailable: account.settledAvailable - receiptCharge, held: account.held - receiptCharge, holds: account.holds.map((candidate) => candidate.reference === hold.reference ? nextHold : candidate) });
          state.accounts.set(accountId, nextAccount);
          const next = freeze({ ...found, status: input.status, receiptCharge: input.receiptCharge, providerReceiptReference: input.providerReceiptReference, result: clone(input.result), sessionVersion: input.sessionVersion, artifactVersion: input.artifactVersion, remainingCap: nextHold.heldAmount.toString(), remainingBalance: nextAccount.settledAvailable.toString() });
          state.meteredActions.set(commandKey(accountId, found.idempotencyKey), next);
          state.postings.push(freeze({ id: `posting:${found.operationId}:debit`, accountId, reference: found.operationId, unit: "sat" as const, amount: `-${input.receiptCharge}`, balanced: true as const }));
          state.postings.push(freeze({ id: `posting:${found.operationId}:release`, accountId, reference: found.actionBudgetReference, unit: "sat" as const, amount: (found.maximum - receiptCharge).toString(), balanced: true as const }));
          appendLineItem(state, { accountId, sessionId: found.sessionId, actionId: found.actionId, operationId: found.operationId, sourceIdentity: `receipt:${input.providerReceiptReference}`, kind: "receipt", unit: "sat", amount: "0", settledAvailable: decimal(nextAccount.settledAvailable), held: decimal(nextAccount.held), sessionSpend: decimal(receiptCharge) });
          appendLineItem(state, { accountId, sessionId: found.sessionId, actionId: found.actionId, operationId: found.operationId, sourceIdentity: `debit:${found.operationId}`, kind: "debit", unit: "sat", amount: `-${input.receiptCharge}`, settledAvailable: decimal(nextAccount.settledAvailable), held: decimal(nextAccount.held), sessionSpend: decimal(receiptCharge) });
          appendLineItem(state, { accountId, sessionId: found.sessionId, actionId: found.actionId, operationId: found.operationId, sourceIdentity: `release:${found.operationId}`, kind: "release", unit: "sat", amount: decimal(found.maximum - receiptCharge), settledAvailable: decimal(nextAccount.settledAvailable), held: decimal(nextAccount.held), sessionSpend: decimal(receiptCharge) });
          state.evidence.push(freeze({ id: `evidence:${found.operationId}:result`, accountId, kind: "metered_result" as const, reference: input.providerReceiptReference }));
          state.outbox.push(freeze({ id: `outbox:${found.operationId}:finalized`, accountId, kind: "metered_action_finalized" as const, reference: found.operationId }));
          return next;
        },
      };
      const result = await operation(transaction);
      this.#state = state;
      return freeze(clone(result));
    } finally { release(); }
  }

  async status(accountId: string): Promise<AccountStatus | undefined> {
    const account = this.#state.accounts.get(accountId);
    if (!account) return undefined;
    return freeze({
      accountId, unit: "sat", available: decimal(account.settledAvailable - account.held), held: decimal(account.held),
      topUps: account.topUps.map((topUp) => ({ topUpId: topUp.topUpId, state: topUp.state, amount: decimal(topUp.amount), unit: topUp.unit, rail: topUp.rail, createdAt: topUp.verifiedAt, verifiedAt: topUp.verifiedAt, settlementReference: topUp.settlementReference })),
      admissions: account.holds.map((hold) => ({ reference: hold.reference, approvedCap: decimal(hold.approvedCap), heldAmount: decimal(hold.heldAmount), unit: "sat" as const })),
    });
  }
}
