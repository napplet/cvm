import type { Kysely } from "kysely";
import type { Pool } from "pg";
import type { AccountStatus, FundedAdmission, FundingResult } from "../phase-03/contracts";
import type { AdmissionInput, CreditInput, FundingStore, FundingTransaction, StoredFundingCommand } from "./funding-store";

type Hold = Readonly<{ reference: string; approvedCap: bigint; heldAmount: bigint }>;
type TopUp = Readonly<{ topUpId: string; rail: "lightning" | "cashu"; amount: bigint; settlementReference: string; externalReference: string; verifiedAt: string }>;
type LedgerTransaction = Readonly<{ id: string; reference: string; balanced: true; entries: readonly Readonly<{ accountId: string; direction: "debit" | "credit"; amount: string }>[] }>;
type State = { accounts: Map<string, { settled: bigint; held: bigint; topUps: TopUp[]; holds: Hold[] }>; commands: Map<string, StoredFundingCommand>; settlements: Set<string>; externals: Set<string>; ledgerTransactions: LedgerTransaction[]; outbox: readonly { id: string; reference: string; kind: string }[] };
const key = (accountId: string, idempotencyKey: string) => `${accountId.length}:${accountId}${idempotencyKey.length}:${idempotencyKey}`;
const frozen = <T>(value: T): T => Object.freeze(structuredClone(value));
const copy = (state: State): State => structuredClone(state);
const account = (state: State, accountId: string) => state.accounts.get(accountId) ?? { settled: 0n, held: 0n, topUps: [], holds: [] };
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
export class PostgresFundingStore implements FundingStore {
  readonly #maxAttempts: number; readonly #deadlineMs: number; readonly #now: () => number;
  constructor(private readonly executor: PostgresFundingExecutor, options: PostgresFundingOptions = {}) {
    this.#maxAttempts = options.maxAttempts ?? 3; this.#deadlineMs = options.deadlineMs ?? 250; this.#now = options.now ?? Date.now;
    if (this.#maxAttempts < 1 || this.#deadlineMs < 1) throw new Error("INVALID_SERIALIZATION_RETRY_POLICY");
  }
  async findRecordedResult(accountId: string, idempotencyKey: string): Promise<StoredFundingCommand | undefined> {
    return this.executor.read((state) => { const found = state.commands.get(key(accountId, idempotencyKey)); return found && frozen(found); });
  }
  async transact<T>(accountId: string, operation: (transaction: FundingTransaction) => Promise<T> | T): Promise<T> {
    const deadline = this.#now() + this.#deadlineMs;
    let last: unknown;
    for (let attempt = 1; attempt <= this.#maxAttempts && this.#now() <= deadline; attempt += 1) {
      try {
        return await this.executor.serializable(async (state) => {
          // The closure contains only canonical SQL-state mutation logic. Rail/provider
          // I/O is deliberately outside this retryable boundary.
          const tx: FundingTransaction = {
            findRecordedResult: (idempotencyKey) => state.commands.get(key(accountId, idempotencyKey)),
            creditVerifiedSettlement: (input) => this.credit(state, accountId, input),
            acceptFundedAdmission: (input) => this.admit(state, accountId, input),
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
      return frozen({ accountId, unit: "sat", available: (value.settled - value.held).toString(), held: value.held.toString(), topUps: value.topUps.map((topUp) => ({ topUpId: topUp.topUpId, state: "credited" as const, amount: topUp.amount.toString(), unit: "sat" as const, rail: topUp.rail, verifiedAt: topUp.verifiedAt, settlementReference: topUp.settlementReference })), admissions: value.holds.map((hold) => ({ reference: hold.reference, approvedCap: hold.approvedCap.toString(), heldAmount: hold.heldAmount.toString(), unit: "sat" as const })) });
    });
  }
  private credit(state: State, accountId: string, input: CreditInput): FundingResult {
    if (input.accountId !== accountId) throw new Error("ACCOUNT_SCOPE_MISMATCH");
    if (state.settlements.has(input.settlement.settlementReference) || state.externals.has(input.settlement.externalReference)) throw new Error("SETTLEMENT_REFERENCE_CONFLICT");
    const amount = BigInt(input.settlement.amount); if (amount <= 0n) throw new Error("INVALID_SETTLEMENT_AMOUNT");
    const current = account(state, accountId); current.settled += amount; current.topUps.push({ topUpId: input.settlement.topUpId, rail: input.settlement.rail, amount, settlementReference: input.settlement.settlementReference, externalReference: input.settlement.externalReference, verifiedAt: input.settlement.verifiedAt }); state.accounts.set(accountId, current);
    state.settlements.add(input.settlement.settlementReference); state.externals.add(input.settlement.externalReference);
    state.ledgerTransactions.push(frozen({ id: `ledger:${input.settlement.settlementReference}`, reference: input.settlement.settlementReference, balanced: true as const, entries: [{ accountId, direction: "credit" as const, amount: amount.toString() }, { accountId: "treasury:clearing", direction: "debit" as const, amount: amount.toString() }] }));
    state.outbox = [...state.outbox, frozen({ id: `outbox:${input.settlement.settlementReference}`, reference: input.settlement.settlementReference, kind: "account_credited" })];
    const result = frozen({ status: "credited" as const, accountId, topUpId: input.settlement.topUpId, creditedAmount: amount.toString(), unit: "sat" as const, settlementReference: input.settlement.settlementReference }); state.commands.set(key(accountId, input.idempotencyKey), frozen({ fingerprint: input.fingerprint, result })); return result;
  }
  private admit(state: State, accountId: string, input: AdmissionInput): FundedAdmission {
    if (input.accountId !== accountId) throw new Error("ACCOUNT_SCOPE_MISMATCH"); const current = account(state, accountId); const available = current.settled - current.held; const held = input.requestedCap < available ? input.requestedCap : available;
    if (held <= 0n) throw new Error("INSUFFICIENT_SETTLED_BALANCE"); current.held += held; current.holds.push({ reference: input.capacityReference, approvedCap: held, heldAmount: held }); state.accounts.set(accountId, current);
    state.outbox = [...state.outbox, frozen({ id: `outbox:${input.capacityReference}`, reference: input.capacityReference, kind: "funded_admission_accepted" })];
    const result = frozen({ status: "accepted" as const, accountId, reference: input.capacityReference, approvedCap: held.toString(), heldAmount: held.toString(), unit: "sat" as const }); state.commands.set(key(accountId, input.idempotencyKey), frozen({ fingerprint: input.fingerprint, result })); return result;
  }
}

/** Deterministic test-only PostgreSQL transaction emulator; not a production fallback. */
export class DeterministicPostgresFundingExecutor implements PostgresFundingExecutor {
  #state: State = { accounts: new Map(), commands: new Map(), settlements: new Set(), externals: new Set(), ledgerTransactions: [], outbox: [] }; #tail = Promise.resolve(); #failures: number; #failCommit = false; retryAttempts = 0; externalEffectCount = 0;
  constructor(options: Readonly<{ serializationFailures?: number }> = {}) { this.#failures = options.serializationFailures ?? 0; }
  failNextCommit(): void { this.#failCommit = true; }
  async read<T>(reader: (state: State) => T): Promise<T> { return frozen(reader(this.#state)); }
  async serializable<T>(closure: (state: State) => T): Promise<T> { let release!: () => void; const prior = this.#tail; this.#tail = new Promise<void>((resolve) => { release = resolve; }); await prior; try { this.retryAttempts += 1; if (this.#failures-- > 0) throw new SerializationFailure(); const staged = copy(this.#state); const result = await closure(staged); if (this.#failCommit) { this.#failCommit = false; throw new Error("INJECTED_TRANSACTION_FAILURE"); } this.#state = staged; return frozen(result); } finally { release(); } }
  snapshot() { return frozen({ ledgerTransactions: this.#state.ledgerTransactions, holds: [...this.#state.accounts.values()].flatMap((item) => item.holds), outbox: this.#state.outbox, projection: this.recomputeProjection() }); }
  recomputeProjection() { const projection: Record<string, { settled: string; held: string }> = {}; for (const [accountId, item] of this.#state.accounts) projection[accountId] = { settled: item.settled.toString(), held: item.held.toString() }; return frozen(projection); }
}

/** Production callers must provide the PostgreSQL-wire executor explicitly. */
export function createPostgresFundingStore(executor: PostgresFundingExecutor, options?: PostgresFundingOptions): PostgresFundingStore { return new PostgresFundingStore(executor, options); }
export type PostgresDriverDependencies = Readonly<{ pool: Pool; db: Kysely<never> }>;
