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

type Intent = { state: "created" | "unknown" | "available" | "refused" | "released"; reference?: string; outcome?: FundedAdmissionOutcome };
type Action = { amount: bigint; result: ActionBudgetAuthorization };

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
 * return time. The local journal is deliberately a correlation cache only: the
 * FundingStore remains the durable monetary/replay authority.
 */
export class FundedAdmissionService {
  #intents = new Map<string, Intent>();
  #actions = new Map<string, Action>();
  #actionTail: Promise<void> = Promise.resolve();

  constructor(private readonly options: Readonly<{ funding: FundingService; store: FundingStore; capacity: ReadyCapacityPort }>) {}

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

    let intent = this.#intents.get(key);
    const intentReference = `capacity-intent:${await hash(`${accountId}:${command.idempotencyKey}`)}`;
    if (!intent) { intent = { state: "created" }; this.#intents.set(key, intent); }
    if (intent.outcome && intent.outcome.status !== "reconciliation_pending") return freeze(structuredClone(intent.outcome));

    let observation: CapacityObservation;
    if (intent.state === "unknown") {
      observation = await this.options.capacity.observe({ intentReference, reference: intent.reference });
    } else {
      try { observation = await this.options.capacity.reserveNow({ intentReference }); }
      catch { intent.state = "unknown"; observation = await this.options.capacity.observe({ intentReference, reference: intent.reference }); }
    }

    if (observation.status === "refused") {
      const outcome = freeze({ status: "refused" as const, accountId, intentReference, retryable: true, unit: "sat" as const });
      intent.state = "refused"; intent.outcome = outcome; return outcome;
    }
    if (observation.status === "unknown") {
      intent.state = "unknown"; intent.reference = observation.reference;
      const outcome = freeze({ status: "reconciliation_pending" as const, accountId, intentReference, retryable: true, unit: "sat" as const });
      intent.outcome = outcome; return outcome;
    }

    intent.state = "available"; intent.reference = observation.reference;
    try {
      const accepted = await this.options.funding.execute(this.fundingCommand(command, observation.reference));
      if (accepted.status !== "accepted") throw new Error("FUNDED_ADMISSION_NOT_ACCEPTED");
      intent.outcome = freeze(structuredClone(accepted));
      return intent.outcome;
    } catch (error) {
      await this.options.capacity.release({ intentReference, reference: observation.reference });
      intent.state = "released";
      const outcome = freeze({ status: "refused" as const, accountId, intentReference, retryable: true, unit: "sat" as const });
      intent.outcome = outcome;
      return outcome;
    }
  }

  async authorizeActionBudget(input: unknown): Promise<ActionBudgetAuthorization> {
    const command = ActionCommandSchema.parse(input);
    const accountId = await accountIdForPrincipal(command.principal);
    const actionKey = `${intentKey(accountId, command.admissionReference)}:${command.idempotencyKey}`;
    const existing = this.#actions.get(actionKey);
    if (existing) return freeze(structuredClone(existing.result));

    let release!: () => void;
    const prior = this.#actionTail;
    this.#actionTail = new Promise<void>((resolve) => { release = resolve; });
    await prior;
    try {
      const replay = this.#actions.get(actionKey);
      if (replay) return freeze(structuredClone(replay.result));
      const status = await this.options.store.status(accountId);
      const admission = status?.admissions.find((candidate) => candidate.reference === command.admissionReference);
      if (!admission) throw new Error("ACTIVE_ADMISSION_REQUIRED");
      const reserved = [...this.#actions.entries()]
        .filter(([key]) => key.startsWith(`${intentKey(accountId, command.admissionReference)}:`))
        .reduce((total, [, action]) => total + action.amount, 0n);
      const maximum = BigInt(command.maximum);
      const remaining = BigInt(admission.approvedCap) - reserved;
      if (maximum > remaining) throw new Error("ACTION_BUDGET_EXCEEDS_APPROVED_CAP");
      const result = freeze({ status: "authorized" as const, accountId, admissionReference: command.admissionReference, reference: `action-budget:${await hash(actionKey)}`, reservedAmount: command.maximum, unit: "sat" as const });
      this.#actions.set(actionKey, { amount: maximum, result });
      return result;
    } finally { release(); }
  }

  private fundingCommand(command: z.infer<typeof AdmissionCommandSchema>, capacityReference: string) {
    return freeze({
      principal: command.principal, kind: "funded_admission" as const, idempotencyKey: command.idempotencyKey,
      policyVersion: command.policyVersion, protocolVersion: command.protocolVersion,
      payload: { requestedCap: command.payload.requestedCap, unit: "sat" as const, capacity: { reference: capacityReference, usable: true as const } },
    });
  }
}
