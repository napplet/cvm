import type { AccountStatus, FundedAdmission, FundingResult, VerifiedSettlement } from "../phase-03/contracts";

export type LedgerPosting = Readonly<{ id: string; accountId: string; reference: string; unit: "sat"; amount: string; balanced: true }>;
export type FundingEvidence = Readonly<{ id: string; accountId: string; kind: "settlement_credit" | "funded_admission"; reference: string }>;
export type FundingOutbox = Readonly<{ id: string; accountId: string; kind: "account_credited" | "funded_admission_accepted"; reference: string }>;
export type StoredFundingCommand = Readonly<{ fingerprint: string; result: FundingResult }>;

export type CreditInput = Readonly<{ accountId: string; fingerprint: string; idempotencyKey: string; settlement: VerifiedSettlement }>;
export type AdmissionInput = Readonly<{ accountId: string; fingerprint: string; idempotencyKey: string; requestedCap: bigint; capacityReference: string }>;
export type CapacityIntent = Readonly<{ accountId: string; idempotencyKey: string; fingerprint: string; intentReference: string; state: "created" | "dispatching" | "available" | "refused" | "reconciliation_pending" | "released"; capacityReference?: string; expiresAt?: string }>;
export type CapacityIntentInput = Readonly<{ accountId: string; idempotencyKey: string; fingerprint: string; intentReference: string }>;
export type CapacityDispatchClaim = Readonly<{ intent: CapacityIntent; claimed: boolean }>;
export type CapacityObservationInput = Readonly<{ intentReference: string; state: "available" | "refused" | "reconciliation_pending"; capacityReference?: string; expiresAt?: string }>;
export type ActionBudget = Readonly<{ accountId: string; admissionReference: string; idempotencyKey: string; fingerprint: string; reference: string; amount: bigint }>;
export type ActionBudgetInput = Readonly<{ accountId: string; admissionReference: string; idempotencyKey: string; fingerprint: string; reference: string; amount: bigint }>;

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

/** Serializable financial authority port. Rail adapters never receive a posting or balance mutation API. */
export interface FundingStore {
  findRecordedResult(accountId: string, idempotencyKey: string): Promise<StoredFundingCommand | undefined>;
  transact<T>(accountId: string, operation: (transaction: FundingTransaction) => Promise<T> | T): Promise<T>;
  status(accountId: string): Promise<AccountStatus | undefined>;
}

type TopUp = Readonly<{ topUpId: string; rail: "lightning" | "cashu"; unit: "sat"; amount: bigint; state: "credited"; verifiedAt: string; settlementReference: string; externalReference: string }>;
type Hold = Readonly<{ reference: string; approvedCap: bigint; heldAmount: bigint }>;
type Account = Readonly<{ settledAvailable: bigint; held: bigint; topUps: readonly TopUp[]; holds: readonly Hold[] }>;
type State = { accounts: Map<string, Account>; commands: Map<string, StoredFundingCommand>; capacityIntents: Map<string, CapacityIntent>; actionBudgets: Map<string, ActionBudget>; externalReferences: Set<string>; settlementReferences: Set<string>; postings: LedgerPosting[]; evidence: FundingEvidence[]; outbox: FundingOutbox[] };

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

/**
 * Deterministic, serialized copy-then-commit double for tests only. It is not
 * a durable ledger and must never be selected as production monetary storage.
 */
export class TransactionalMemoryFundingStore implements FundingStore {
  #state: State = { accounts: new Map(), commands: new Map(), capacityIntents: new Map(), actionBudgets: new Map(), externalReferences: new Set(), settlementReferences: new Set(), postings: [], evidence: [], outbox: [] };
  #tail: Promise<void> = Promise.resolve();

  get postings(): readonly LedgerPosting[] { return freeze(clone(this.#state.postings)); }
  get evidence(): readonly FundingEvidence[] { return freeze(clone(this.#state.evidence)); }
  get outbox(): readonly FundingOutbox[] { return freeze(clone(this.#state.outbox)); }
  get activeHolds(): readonly Hold[] { return freeze(clone([...this.#state.accounts.values()].flatMap((account) => account.holds))); }
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

  async transact<T>(accountId: string, operation: (transaction: FundingTransaction) => Promise<T> | T): Promise<T> {
    let release!: () => void;
    const prior = this.#tail;
    this.#tail = new Promise<void>((resolve) => { release = resolve; });
    await prior;
    try {
      const state = copyState(this.#state);
      const transaction: FundingTransaction = {
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
          if (input.amount <= 0n || input.amount > hold.approvedCap - reserved) throw new Error("ACTION_BUDGET_EXCEEDS_APPROVED_CAP"); const next = freeze(input); state.actionBudgets.set(key, next); return next;
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
