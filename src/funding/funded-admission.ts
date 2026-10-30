import { z } from "zod";
import { accountIdForPrincipal, fingerprintAccountCommand } from "../domain/account-command";
import { PrincipalSchema, type FundedAdmission } from "../phase-03/contracts";
import type { FundingStore, FundingTransaction, StoredFundingCommand, CapacityCompensationClaim } from "../persistence/funding-store";
import { FundingCommitOutcomeUnknownError } from "./transaction-outcome";
import { FundingService } from "./funding-service";
import type { AdmissionReceiptAuthority, VerifiedAdmissionReceipt } from "./admission-receipt";
import { AdmissionLifecycleContextSchema, emitLifecycleObservationWithCorrelation, type AdmissionLifecycleContext, type LifecycleTelemetryPort } from "../telemetry/contracts";

const SatSchema = z.string().regex(/^[1-9][0-9]*$/u).refine((value) => BigInt(value) <= BigInt(Number.MAX_SAFE_INTEGER));
const AdmissionCommandSchema = z.object({
  principal: PrincipalSchema, idempotencyKey: z.string().min(1), policyVersion: z.string().min(1), protocolVersion: z.string().min(1),
  payload: z.object({ requestedCap: SatSchema, unit: z.literal("sat") }).strict(),
}).strict();
const ActionCommandSchema = z.object({
  principal: PrincipalSchema, admissionReference: z.string().min(1), idempotencyKey: z.string().min(1), maximum: SatSchema, unit: z.literal("sat"),
}).strict();

const ProtectedDigestSchema = z.string().regex(/^sha256:[a-f0-9]{64}$/u);
export const ExactReadyProofSchema = z.object({
  intentReference: z.string().min(1),
  leaseReference: z.string().min(1),
  sessionBindingDigest: ProtectedDigestSchema,
  imageDigest: ProtectedDigestSchema,
  readinessProbeDigest: ProtectedDigestSchema,
  readyMonotonicMs: z.number().int().min(0).finite(),
}).strict();
export type ExactReadyProof = z.infer<typeof ExactReadyProofSchema>;
export type CapacityReservation = Readonly<{ status: "available"; reference: string; expiresAt: string; usable?: true; ready: ExactReadyProof }>;
export type CapacityRefusal = Readonly<{ status: "refused"; reason?: string }>;
export type CapacityUnknown = Readonly<{ status: "unknown"; reference?: string }>;
export type CapacityObservation = CapacityReservation | CapacityRefusal | CapacityUnknown;

/** Provider-neutral, immediate-only capacity authority. It cannot create workers or debit value. */
export interface ReadyCapacityPort {
  reserveNow(input: Readonly<{ intentReference: string; expectedSessionBindingDigest: string }>): Promise<CapacityObservation>;
  observe(input: Readonly<{ intentReference: string; expectedSessionBindingDigest: string; reference?: string }>): Promise<CapacityObservation>;
  release(input: Readonly<{ intentReference: string; reference: string }>): Promise<void>;
  observeRelease?(input: Readonly<{ intentReference: string; reference: string }>): Promise<Readonly<{ status: "terminated" | "pending" | "unknown" | "blocked" }>>;
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
  /** Process-local coalescing is not a durable queue: the store remains the cross-process claim fence. */
  readonly #inflight = new Map<string, Readonly<{ fingerprint: string; outcome: Promise<FundedAdmissionOutcome> }>>();
  constructor(private readonly options: Readonly<{ funding: FundingService; store: FundingStore; capacity: ReadyCapacityPort; receiptAuthority: AdmissionReceiptAuthority; now?: () => number; minimumLeaseMs?: number; capacityTimeoutMs?: number; telemetry?: LifecycleTelemetryPort }>) {
    this.#now = options.now ?? Date.now;
    this.#minimumLeaseMs = options.minimumLeaseMs ?? 5_000;
    this.#capacityTimeoutMs = options.capacityTimeoutMs ?? 5_000;
    if (this.#capacityTimeoutMs < 1) throw new Error("INVALID_CAPACITY_TIMEOUT");
  }

  async admit(input: unknown, receiptInput?: unknown, lifecycleInput?: unknown): Promise<FundedAdmissionOutcome> {
    const command = AdmissionCommandSchema.parse(input);
    // Receipt validation is deliberately the first authority check. Neither a
    // caller-shaped lifecycle object nor an unauthenticated token may reach a
    // capacity provider, durable capacity intent, or funding hold.
    const lifecycle = lifecycleInput === undefined ? undefined : AdmissionLifecycleContextSchema.parse(lifecycleInput);
    const receipt = await this.options.receiptAuthority.verify(receiptInput, command, lifecycle?.correlationDigest);
    const accountId = await accountIdForPrincipal(command.principal);
    const key = intentKey(accountId, command.idempotencyKey);
    const intentFingerprint = await hash(JSON.stringify({ accountId, command }));
    const active = this.#inflight.get(key);
    if (active) {
      if (active.fingerprint !== intentFingerprint) throw new Error("IDEMPOTENCY_KEY_CONFLICT");
      return freeze(structuredClone(await active.outcome));
    }
    const execution = this.admitParsed(command, accountId, receipt, lifecycle, intentFingerprint);
    const inFlight = freeze({ fingerprint: intentFingerprint, outcome: execution });
    this.#inflight.set(key, inFlight);
    try {
      return freeze(structuredClone(await execution));
    } finally {
      if (this.#inflight.get(key) === inFlight) this.#inflight.delete(key);
    }
  }

  private async admitParsed(command: z.infer<typeof AdmissionCommandSchema>, accountId: string, receipt: VerifiedAdmissionReceipt, lifecycle: AdmissionLifecycleContext | undefined, intentFingerprint: string): Promise<FundedAdmissionOutcome> {
    const recorded = await this.options.store.findRecordedResult(accountId, command.idempotencyKey);
    if (recorded) return this.matchRecordedAdmission(command, accountId, recorded);

    const intentReference = `capacity-intent:${await hash(`${accountId}:${command.idempotencyKey}`)}`;
    this.observeLifecycle(lifecycle, "capacity_intent_created", lifecycle?.receiptMonotonicMs);
    let intent = await this.options.store.transact(accountId, async (transaction) => {
      const existing = await transaction.findCapacityIntent(command.idempotencyKey);
      return existing ?? transaction.createCapacityIntent({ accountId, idempotencyKey: command.idempotencyKey, fingerprint: intentFingerprint, intentReference });
    });
    if (intent.fingerprint !== intentFingerprint || intent.intentReference !== intentReference) throw new Error("IDEMPOTENCY_KEY_CONFLICT");

    let observation: CapacityObservation;
    if (intent.state === "available") {
      // A persisted lease record contains no ready-proof bytes. Re-observe the
      // original reservation rather than reconstructing an accept-able lease
      // from partial durable state.
      observation = await this.observeCapacity({ intentReference, expectedSessionBindingDigest: receipt.expectedSessionBindingDigest, reference: intent.capacityReference });
    } else if (intent.state === "reconciliation_pending") {
      observation = await this.observeCapacity({ intentReference, expectedSessionBindingDigest: receipt.expectedSessionBindingDigest, reference: intent.capacityReference });
    } else if (intent.state === "refused" && intent.capacityReference) {
      return this.observeCompensation(accountId, intentReference, intent.capacityReference);
    } else if (intent.state === "refused" || intent.state === "released") {
      return freeze({ status: "refused" as const, accountId, intentReference, retryable: true, unit: "sat" as const });
    } else {
      const dispatch = await this.options.store.transact(accountId, (transaction) => transaction.claimCapacityDispatch(intentReference));
      if (dispatch.claimed) {
        this.observeLifecycle(lifecycle, "capacity_reserve_started", lifecycle?.receiptMonotonicMs);
        try { observation = await this.bounded(this.options.capacity.reserveNow({ intentReference, expectedSessionBindingDigest: receipt.expectedSessionBindingDigest })); }
        catch { observation = await this.observeCapacity({ intentReference, expectedSessionBindingDigest: receipt.expectedSessionBindingDigest }); }
      } else {
        observation = await this.observeCapacity({ intentReference, expectedSessionBindingDigest: receipt.expectedSessionBindingDigest, reference: dispatch.intent.capacityReference });
      }
    }

    if (observation.status === "refused") {
      const outcome = freeze({ status: "refused" as const, accountId, intentReference, retryable: true, unit: "sat" as const });
      const refused = await this.options.store.transact(accountId, (transaction) => transaction.recordCapacityObservation({ intentReference, state: "refused" }));
      if (refused.state === "available") {
        const recorded = await this.options.store.findRecordedResult(accountId, command.idempotencyKey);
        if (recorded) return this.matchRecordedAdmission(command, accountId, recorded, refused.capacityReference);
        return freeze({ status: "reconciliation_pending" as const, accountId, intentReference, retryable: true, unit: "sat" as const });
      }
      this.observeLifecycle(lifecycle, "capacity_refused", lifecycle?.receiptMonotonicMs, "capacity_unavailable");
      return outcome;
    }
    if (observation.status === "unknown") {
      const outcome = freeze({ status: "reconciliation_pending" as const, accountId, intentReference, retryable: true, unit: "sat" as const });
      await this.options.store.transact(accountId, (transaction) => transaction.recordCapacityObservation({ intentReference, state: "reconciliation_pending", ...(observation.reference ? { capacityReference: observation.reference } : {}) }));
      return outcome;
    }

    if (!this.isUsableLease(observation.expiresAt) || !this.hasExactReadyProof(observation, intentReference, receipt)) {
      return this.reconcileBeforeCompensation(command, accountId, intentReference, observation);
    }
    try {
      intent = await this.options.store.transact(accountId, (transaction) => transaction.recordCapacityObservation({ intentReference, state: "available", capacityReference: observation.reference, expiresAt: observation.expiresAt }));
      if (intent.state !== "available") throw new Error("CAPACITY_INTENT_NOT_AVAILABLE");
      const accepted = await this.options.funding.execute(this.fundingCommand(command, intent.capacityReference!));
      if (accepted.status !== "accepted") throw new Error("FUNDED_ADMISSION_NOT_ACCEPTED");
      this.observeLifecycle(lifecycle, "exact_session_ready", observation.ready?.readyMonotonicMs, "accepted");
      return freeze(structuredClone(accepted));
    } catch (error) {
      const recovered = await this.reconcileBeforeCompensation(command, accountId, intentReference, observation, error instanceof FundingCommitOutcomeUnknownError);
      if (recovered.status === "accepted") this.observeLifecycle(lifecycle, "exact_session_ready", observation.ready?.readyMonotonicMs, "accepted");
      return recovered;
    }
  }

  private async reconcileBeforeCompensation(command: z.infer<typeof AdmissionCommandSchema>, accountId: string, intentReference: string, observation: CapacityReservation, commitUnknown = false): Promise<FundedAdmissionOutcome> {
    // The hold may have committed before its acknowledgement was lost. Read
    // that original before any compensation, never terminate accepted work.
    let committed: StoredFundingCommand | undefined;
    try { committed = await this.options.store.findRecordedResult(accountId, command.idempotencyKey); }
    catch { return freeze({ status: "reconciliation_pending" as const, accountId, intentReference, retryable: true, unit: "sat" as const }); }
    if (committed) {
      return this.matchRecordedAdmission(command, accountId, committed, observation.reference);
    }
    if (commitUnknown) return freeze({ status: "reconciliation_pending" as const, accountId, intentReference, retryable: true, unit: "sat" as const });
    return this.compensateReservation(command, accountId, intentReference, observation.reference);
  }

  private async matchRecordedAdmission(command: z.infer<typeof AdmissionCommandSchema>, accountId: string, recorded: StoredFundingCommand, expectedReference?: string): Promise<FundedAdmission> {
    if (recorded.result.status !== "accepted" || recorded.result.accountId !== accountId || (expectedReference !== undefined && recorded.result.reference !== expectedReference)) throw new Error("FUNDED_ADMISSION_REPLAY_INVALID");
    const fingerprint = await fingerprintAccountCommand(this.fundingCommand(command, recorded.result.reference), accountId);
    if (recorded.fingerprint !== fingerprint) throw new Error("IDEMPOTENCY_KEY_CONFLICT");
    return freeze(structuredClone(recorded.result));
  }

  async authorizeActionBudget(input: unknown, transaction?: FundingTransaction): Promise<ActionBudgetAuthorization> {
    const command = ActionCommandSchema.parse(input);
    const accountId = await accountIdForPrincipal(command.principal);
    const actionKey = `${intentKey(accountId, command.admissionReference)}:${command.idempotencyKey}`;
    const actionFingerprint = await hash(JSON.stringify({ accountId, command }));
    const authorize = async (transaction: FundingTransaction) => {
      const existing = await transaction.findActionBudget(command.idempotencyKey);
      if (existing && existing.fingerprint !== actionFingerprint) throw new Error("IDEMPOTENCY_KEY_CONFLICT");
      const action = existing ?? await transaction.reserveActionBudget({ accountId, admissionReference: command.admissionReference, idempotencyKey: command.idempotencyKey, fingerprint: actionFingerprint, reference: `action-budget:${await hash(actionKey)}`, amount: BigInt(command.maximum) });
      return freeze({ status: "authorized" as const, accountId, admissionReference: action.admissionReference, reference: action.reference, reservedAmount: action.amount.toString(), unit: "sat" as const });
    };
    // A metered action may share this transaction so a rejected/stale action
    // cannot strand a separately committed budget reservation.
    return transaction ? authorize(transaction) : this.options.store.transact(accountId, authorize);
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

  private hasExactReadyProof(observation: CapacityReservation, intentReference: string, receipt: VerifiedAdmissionReceipt): boolean {
    // The ready proof is useful only when it names the exact, authenticated
    // binding minted at the signed-command boundary. Lifecycle telemetry is
    // never consulted as authorization material.
    const parsed = ExactReadyProofSchema.safeParse(observation.ready);
    return parsed.success
      && parsed.data.intentReference === intentReference
      && parsed.data.leaseReference === observation.reference
      && parsed.data.sessionBindingDigest === receipt.expectedSessionBindingDigest;
  }

  private observeLifecycle(context: AdmissionLifecycleContext | undefined, stage: "correlated_receipt" | "capacity_intent_created" | "capacity_reserve_started" | "exact_session_ready" | "capacity_refused" | "reconciliation_pending", monotonicMs: number | undefined, outcome?: "accepted" | "capacity_unavailable" | "reconciliation_pending"): void {
    if (!context || monotonicMs === undefined) return;
    void emitLifecycleObservationWithCorrelation(this.options.telemetry, context.correlationDigest, stage, outcome, monotonicMs);
  }

  private async observeCapacity(input: Readonly<{ intentReference: string; expectedSessionBindingDigest: string; reference?: string }>): Promise<CapacityObservation> {
    try { return await this.bounded(this.options.capacity.observe(input)); }
    catch { return freeze({ status: "unknown" as const, ...(input.reference ? { reference: input.reference } : {}) }); }
  }

  private async compensateReservation(command: z.infer<typeof AdmissionCommandSchema>, accountId: string, intentReference: string, reference: string): Promise<FundedAdmissionOutcome> {
    let claim: CapacityCompensationClaim;
    try {
      claim = await this.options.store.transact(accountId, transaction => {
        if (!transaction.claimCapacityCompensation) throw new Error("CAPACITY_COMPENSATION_FENCE_REQUIRED");
        return transaction.claimCapacityCompensation({ idempotencyKey: command.idempotencyKey, intentReference, capacityReference: reference });
      });
    } catch { return freeze({ status: "reconciliation_pending" as const, accountId, intentReference, retryable: true, unit: "sat" as const }); }
    if (claim.status === "accepted") return this.matchRecordedAdmission(command, accountId, claim.command, reference);
    if (claim.status === "observing") {
      if (claim.intent.state === "released") return freeze({ status: "refused" as const, accountId, intentReference, retryable: true, unit: "sat" as const });
      return this.observeCompensation(accountId, intentReference, reference);
    }
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

  private async observeCompensation(accountId: string, intentReference: string, reference: string): Promise<FundedAdmissionOutcome> {
    try {
      const observed = await this.bounded(this.options.capacity.observeRelease?.({ intentReference, reference }) ?? Promise.resolve({ status: "unknown" as const }));
      if (observed.status === "terminated") {
        await this.options.store.transact(accountId, transaction => transaction.releaseCapacityIntent(intentReference));
        return freeze({ status: "refused" as const, accountId, intentReference, retryable: true, unit: "sat" as const });
      }
    } catch { /* No proof grants a repeated release or admission attempt. */ }
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
