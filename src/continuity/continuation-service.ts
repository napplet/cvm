import { NeedsTopUpResultSchema, PendingActionIntentSchema, type NeedsTopUpResult, type PendingActionIntent } from "./contracts";
import type { ContinuationFundingStore } from "../persistence/funding-store";

const GRACE_WINDOW_MS = 600_000;

function decimal(value: bigint): string { return value.toString(10); }
function shortfall(maximum: bigint, available: bigint): bigint { return maximum > available ? maximum - available : 0n; }
function frozen<T>(value: T): T { return Object.freeze(value); }

export type VerifiedCreditWakeHint = Readonly<{
  accountId: string;
  sessionId: string;
  pauseGeneration: number;
  liveLeaseToken: string;
  pendingFingerprint: string;
  expectedSessionVersion: number;
  expectedArtifactVersion: number;
}>;

export type VerifiedCreditWakeResult = Readonly<{
  status: "continued" | "replayed" | "no_effect";
  code: string;
  leaseToken?: string;
  pendingActionReference?: string;
  actionBudgetReference?: string;
}>;

export type VerifiedCreditWakeInput = VerifiedCreditWakeHint & Readonly<{
  /** Coordinator-only continuation hook; payment hints cannot provide this callback. */
  onAuthorized?: () => Promise<void> | void;
  /** Test/observability seam for proving authorization happens only after the atomic transition. */
  onAuthorization?: () => void;
}>;

/**
 * Coordinator-owned pause authority. It deliberately has no worker, provider,
 * or payment-rail dependency: a failed affordability check only records one
 * replayable pending intent in the same serialized store transaction.
 */
export class ContinuationService {
  constructor(private readonly options: Readonly<{ store: ContinuationFundingStore; clock?: Readonly<{ nowMs(): number }> }>) {}

  async pauseForFunding(input: Readonly<{ intent: PendingActionIntent }>): Promise<NeedsTopUpResult | undefined> {
    const intent = PendingActionIntentSchema.parse(input.intent);
    return this.options.store.transact(intent.accountId, async (transaction) => {
      const existing = await transaction.findContinuation(intent.idempotencyKey);
      if (existing) {
        if (existing.intent.fingerprint !== intent.fingerprint) throw new Error("IDEMPOTENCY_KEY_CONFLICT");
        return NeedsTopUpResultSchema.parse(existing.result);
      }
      const funding = await transaction.continuationFundingSnapshot(intent.admissionReference);
      const actionMaximum = BigInt(intent.actionMaximum);
      const requiredAdditionalFunding = shortfall(actionMaximum, funding.availableBalance);
      const requiredCapApproval = shortfall(actionMaximum, funding.remainingCap);
      if (requiredAdditionalFunding === 0n && requiredCapApproval === 0n) return undefined;
      const deadline = (this.options.clock ?? { nowMs: Date.now }).nowMs() + GRACE_WINDOW_MS;
      const nextRequiredAction = requiredAdditionalFunding > 0n && requiredCapApproval > 0n ? "top_up_and_approve_cap" as const : requiredAdditionalFunding > 0n ? "top_up" as const : "approve_cap" as const;
      const result = NeedsTopUpResultSchema.parse({
        status: "needs_top_up", code: "ACTION_AFFORDABILITY_REQUIRED", accountId: intent.accountId, sessionId: intent.sessionId,
        pendingActionReference: intent.reference, pendingActionFingerprint: intent.fingerprint, pendingActionKind: intent.actionKind,
        actionMaximum: intent.actionMaximum, requiredAdditionalFunding: decimal(requiredAdditionalFunding), requiredCapApproval: decimal(requiredCapApproval),
        settledBalance: decimal(funding.settledBalance), availableBalance: decimal(funding.availableBalance), remainingCap: decimal(funding.remainingCap),
        graceDeadlineMs: deadline, checkpoint: { state: "live_worker", reference: `checkpoint-pending:${intent.reference}` }, nextRequiredAction,
      });
      await transaction.pauseForFunding({ intent, result });
      return result;
    });
  }

  /**
   * A rail/relay/client delivery can call this method only as a hint. The
   * transaction rereads durable credit and the complete paused tuple; it never
   * accepts amount, settlement, or notification material from the caller.
   */
  async wakePausedAction(input: VerifiedCreditWakeInput): Promise<VerifiedCreditWakeResult> {
    const nowMs = (this.options.clock ?? { nowMs: Date.now }).nowMs();
    const transition = await this.options.store.transact(input.accountId, async (transaction) => {
      const pause = await transaction.findContinuationPause(input.sessionId, input.pauseGeneration);
      if (!pause) return frozen({ status: "no_effect" as const, code: "PAUSE_NOT_FOUND_OR_DENIED" });
      if (pause.liveLeaseToken !== input.liveLeaseToken) return frozen({ status: "no_effect" as const, code: "STALE_LIVE_LEASE" });
      if (nowMs >= pause.graceDeadlineMs) return frozen({ status: "no_effect" as const, code: "GRACE_DEADLINE_EXPIRED" });
      if (pause.state !== "needs_top_up") return frozen({ status: "no_effect" as const, code: "PAUSE_NOT_LIVE" });
      if (pause.pendingFingerprint !== input.pendingFingerprint) return frozen({ status: "no_effect" as const, code: "PENDING_ACTION_MISMATCH" });
      if (pause.expectedSessionVersion !== input.expectedSessionVersion) return frozen({ status: "no_effect" as const, code: "STALE_SESSION_VERSION" });

      // The full intent is the durable source for artifact lineage. A pause
      // without its matching intent is not eligible to wake a worker.
      const continuation = await this.options.store.findContinuationForSession(input.accountId, input.sessionId);
      if (!continuation || continuation.intent.fingerprint !== pause.pendingFingerprint) return frozen({ status: "no_effect" as const, code: "PENDING_ACTION_MISMATCH" });
      if (continuation.intent.expectedArtifactVersion !== input.expectedArtifactVersion) return frozen({ status: "no_effect" as const, code: "STALE_ARTIFACT_VERSION" });

      const funding = await transaction.continuationFundingSnapshot(pause.admissionReference);
      const amount = BigInt(continuation.intent.actionMaximum);
      if (funding.remainingCap < amount) return frozen({ status: "no_effect" as const, code: "APPROVED_CAP_INSUFFICIENT" });
      if (funding.availableBalance < amount) return frozen({ status: "no_effect" as const, code: "VERIFIED_CREDIT_REQUIRED" });

      // Reassert the store fence only after every coordinator predicate above.
      // Its deadline/lease checks protect a racing checkpoint attempt as well.
      await transaction.wakePausedAction({ sessionId: input.sessionId, pauseGeneration: input.pauseGeneration, nowMs, liveLeaseToken: input.liveLeaseToken });
      const idempotencyKey = `continuation-wake:${pause.idempotencyKey}:${pause.pauseGeneration}`;
      const existing = await transaction.findActionBudget(idempotencyKey);
      if (existing) return frozen({ status: "replayed" as const, code: "WAKE_ALREADY_AUTHORIZED", leaseToken: input.liveLeaseToken, pendingActionReference: continuation.intent.reference, actionBudgetReference: existing.reference });
      const budget = await transaction.reserveActionBudget({
        accountId: input.accountId,
        admissionReference: pause.admissionReference,
        idempotencyKey,
        fingerprint: `wake:${pause.pendingFingerprint}:${pause.expectedSessionVersion}:${continuation.intent.expectedArtifactVersion}`,
        reference: `action-budget:wake:${pause.sessionId}:${pause.pauseGeneration}`,
        amount,
      });
      return frozen({ status: "continued" as const, code: "WAKE_AUTHORIZED", leaseToken: input.liveLeaseToken, pendingActionReference: continuation.intent.reference, actionBudgetReference: budget.reference });
    });

    if (transition.status !== "continued") return transition;
    input.onAuthorization?.();
    await input.onAuthorized?.();
    return transition;
  }
}
