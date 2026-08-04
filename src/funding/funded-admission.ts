import { z } from "zod";
import { accountIdForPrincipal, fingerprintAccountCommand } from "../domain/account-command";
import { PrincipalSchema, type FundedAdmission } from "../phase-03/contracts";
import type { FundingStore } from "../persistence/funding-store";
import { FundingService } from "./funding-service";

const SatSchema = z.string().regex(/^[1-9][0-9]*$/u).refine((value) => BigInt(value) <= BigInt(Number.MAX_SAFE_INTEGER));
const AdmissionCommandSchema = z.object({
  principal: PrincipalSchema, idempotencyKey: z.string().min(1), policyVersion: z.string().min(1), protocolVersion: z.string().min(1),
  payload: z.object({ requestedCap: SatSchema, unit: z.literal("sat") }).strict(),
}).strict();
const ActionCommandSchema = z.object({
  principal: PrincipalSchema, admissionReference: z.string().min(1), idempotencyKey: z.string().min(1), maximum: SatSchema, unit: z.literal("sat"),
}).strict();

export type CapacityReservation = Readonly<{ status: "available"; reference: string; expiresAt: string; usable?: true }>;
export type CapacityRefusal = Readonly<{ status: "refused"; reason?: string }>;
export type CapacityUnknown = Readonly<{ status: "unknown"; reference?: string }>;
export type CapacityObservation = CapacityReservation | CapacityRefusal | CapacityUnknown;

/** Provider-neutral, immediate-only capacity authority. It cannot create workers or debit value. */
export interface ReadyCapacityPort {
  reserveNow(input: Readonly<{ intentReference: string }>): Promise<CapacityObservation>;
  observe(input: Readonly<{ intentReference: string; reference?: string }>): Promise<CapacityObservation>;
  release(input: Readonly<{ intentReference: string; reference: string }>): Promise<void>;
}

export type FundedAdmissionOutcome = FundedAdmission | Readonly<{
  status: "refused" | "reconciliation_pending"; accountId: string; intentReference: string; retryable: boolean; unit: "sat";
}>;
export type ActionBudgetAuthorization = Readonly<{
  status: "authorized"; accountId: string; admissionReference: string; reference: string; reservedAmount: string; unit: "sat";
}>;


function freeze<T>(value: T): T {
  if (value && typeof value === "object" && !Object.isFrozen(value)) {
    for (const child of Object.values(value as Record<string, unknown>)) freeze(child);
    Object.freeze(value);
  }
  return value;
}
async function hash(value: string): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(value));
  return [...new Uint8Array(digest)].map((byte) => byte.toString(16).padStart(2, "0")).join("");
}
function intentKey(accountId: string, idempotencyKey: string): string { return `${accountId.length}:${accountId}${idempotencyKey.length}:${idempotencyKey}`; }

/**
 * Couples a serializable cap hold with a capacity reservation that is usable at
 * return time. Capacity intent and action-budget correlation are persisted by
 * FundingStore before external I/O; the store remains the replay authority.
 */
export class FundedAdmissionService {
  readonly #now: () => number;
  readonly #minimumLeaseMs: number;
  readonly #capacityTimeoutMs: number;
  constructor(private readonly options: Readonly<{ funding: FundingService; store: FundingStore; capacity: ReadyCapacityPort; now?: () => number; minimumLeaseMs?: number; capacityTimeoutMs?: number }>) {
    this.#now = options.now ?? Date.now;
    this.#minimumLeaseMs = options.minimumLeaseMs ?? 5_000;
    this.#capacityTimeoutMs = options.capacityTimeoutMs ?? 5_000;
    if (this.#capacityTimeoutMs < 1) throw new Error("INVALID_CAPACITY_TIMEOUT");
  }

  async admit(input: unknown): Promise<FundedAdmissionOutcome> {
    const command = AdmissionCommandSchema.parse(input);
    const accountId = await accountIdForPrincipal(command.principal);
    const key = intentKey(accountId, command.idempotencyKey);
    const recorded = await this.options.store.findRecordedResult(accountId, command.idempotencyKey);
    if (recorded) {
      if (recorded.result.status !== "accepted") throw new Error("FUNDED_ADMISSION_REPLAY_INVALID");
      const replayCommand = this.fundingCommand(command, recorded.result.reference);
      const fingerprint = await fingerprintAccountCommand(replayCommand, accountId);
      if (recorded.fingerprint !== fingerprint) throw new Error("IDEMPOTENCY_KEY_CONFLICT");
      return freeze(structuredClone(recorded.result));
    }

    const intentReference = `capacity-intent:${await hash(`${accountId}:${command.idempotencyKey}`)}`;
    const intentFingerprint = await hash(JSON.stringify({ accountId, command }));
    let intent = await this.options.store.transact(accountId, async (transaction) => {
      const existing = await transaction.findCapacityIntent(command.idempotencyKey);
      return existing ?? transaction.createCapacityIntent({ accountId, idempotencyKey: command.idempotencyKey, fingerprint: intentFingerprint, intentReference });
    });
    if (intent.fingerprint !== intentFingerprint || intent.intentReference !== intentReference) throw new Error("IDEMPOTENCY_KEY_CONFLICT");

    let observation: CapacityObservation;
    if (intent.state === "available") {
      observation = { status: "available", reference: intent.capacityReference!, expiresAt: intent.expiresAt! };
    } else if (intent.state === "reconciliation_pending") {
      observation = await this.observeCapacity({ intentReference, reference: intent.capacityReference });
    } else if (intent.state === "refused" || intent.state === "released") {
      return freeze({ status: "refused" as const, accountId, intentReference, retryable: true, unit: "sat" as const });
    } else {
      const dispatch = await this.options.store.transact(accountId, (transaction) => transaction.claimCapacityDispatch(intentReference));
      if (dispatch.claimed) {
        try { observation = await this.bounded(this.options.capacity.reserveNow({ intentReference })); }
        catch { observation = await this.observeCapacity({ intentReference }); }
      } else {
        observation = await this.observeCapacity({ intentReference, reference: dispatch.intent.capacityReference });
      }
    }

    if (observation.status === "refused") {
      const outcome = freeze({ status: "refused" as const, accountId, intentReference, retryable: true, unit: "sat" as const });
      await this.options.store.transact(accountId, (transaction) => transaction.recordCapacityObservation({ intentReference, state: "refused" }));
      return outcome;
    }
    if (observation.status === "unknown") {
      const outcome = freeze({ status: "reconciliation_pending" as const, accountId, intentReference, retryable: true, unit: "sat" as const });
      await this.options.store.transact(accountId, (transaction) => transaction.recordCapacityObservation({ intentReference, state: "reconciliation_pending", ...(observation.reference ? { capacityReference: observation.reference } : {}) }));
      return outcome;
    }

    if (!this.isUsableLease(observation.expiresAt)) {
      return this.compensateReservation(accountId, intentReference, observation.reference);
    }
    try {
      intent = await this.options.store.transact(accountId, (transaction) => transaction.recordCapacityObservation({ intentReference, state: "available", capacityReference: observation.reference, expiresAt: observation.expiresAt }));
      const accepted = await this.options.funding.execute(this.fundingCommand(command, intent.capacityReference!));
      if (accepted.status !== "accepted") throw new Error("FUNDED_ADMISSION_NOT_ACCEPTED");
      return freeze(structuredClone(accepted));
    } catch {
      return this.compensateReservation(accountId, intentReference, observation.reference);
    }
  }

  async authorizeActionBudget(input: unknown): Promise<ActionBudgetAuthorization> {
    const command = ActionCommandSchema.parse(input);
    const accountId = await accountIdForPrincipal(command.principal);
    const actionKey = `${intentKey(accountId, command.admissionReference)}:${command.idempotencyKey}`;
    const actionFingerprint = await hash(JSON.stringify({ accountId, command }));
    const result = await this.options.store.transact(accountId, async (transaction) => {
      const existing = await transaction.findActionBudget(command.idempotencyKey);
      if (existing && existing.fingerprint !== actionFingerprint) throw new Error("IDEMPOTENCY_KEY_CONFLICT");
      const action = existing ?? await transaction.reserveActionBudget({ accountId, admissionReference: command.admissionReference, idempotencyKey: command.idempotencyKey, fingerprint: actionFingerprint, reference: `action-budget:${await hash(actionKey)}`, amount: BigInt(command.maximum) });
      return freeze({ status: "authorized" as const, accountId, admissionReference: action.admissionReference, reference: action.reference, reservedAmount: action.amount.toString(), unit: "sat" as const });
    });
    return result;
  }

  private fundingCommand(command: z.infer<typeof AdmissionCommandSchema>, capacityReference: string) {
    return freeze({
      principal: command.principal, kind: "funded_admission" as const, idempotencyKey: command.idempotencyKey,
      policyVersion: command.policyVersion, protocolVersion: command.protocolVersion,
      payload: { requestedCap: command.payload.requestedCap, unit: "sat" as const, capacity: { reference: capacityReference, usable: true as const } },
    });
  }

  private isUsableLease(expiresAt: string): boolean {
    const parsed = z.iso.datetime().safeParse(expiresAt);
    if (!parsed.success) return false;
    const expiry = Date.parse(parsed.data);
    return Number.isFinite(expiry) && expiry - this.#now() >= this.#minimumLeaseMs;
  }

  private async observeCapacity(input: Readonly<{ intentReference: string; reference?: string }>): Promise<CapacityObservation> {
    try { return await this.bounded(this.options.capacity.observe(input)); }
    catch { return freeze({ status: "unknown" as const, ...(input.reference ? { reference: input.reference } : {}) }); }
  }

  private async compensateReservation(accountId: string, intentReference: string, reference: string): Promise<FundedAdmissionOutcome> {
    // Fence retries durably before releasing externally. If release succeeds but
    // finalization cannot commit, a fresh service observes this ambiguity rather
    // than trusting the stale prior `available` observation.
    await this.options.store.transact(accountId, (transaction) => transaction.recordCapacityObservation({ intentReference, state: "reconciliation_pending", capacityReference: reference }));
    let released = false;
    try { await this.bounded(this.options.capacity.release({ intentReference, reference })); released = true; }
    catch { released = false; }
    if (released) {
      try {
        await this.options.store.transact(accountId, (transaction) => transaction.releaseCapacityIntent(intentReference));
        return freeze({ status: "refused" as const, accountId, intentReference, retryable: true, unit: "sat" as const });
      } catch {
        return freeze({ status: "reconciliation_pending" as const, accountId, intentReference, retryable: true, unit: "sat" as const });
      }
    }
    return freeze({ status: "reconciliation_pending" as const, accountId, intentReference, retryable: true, unit: "sat" as const });
  }

  private async bounded<T>(operation: Promise<T>): Promise<T> {
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
      return await Promise.race([operation, new Promise<T>((_, reject) => { timer = setTimeout(() => reject(new Error("CAPACITY_OPERATION_DEADLINE_EXCEEDED")), this.#capacityTimeoutMs); })]);
    } finally {
      if (timer) clearTimeout(timer);
    }
  }
}
