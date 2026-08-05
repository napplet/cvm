import { NeedsTopUpResultSchema, PendingActionIntentSchema, type NeedsTopUpResult, type PendingActionIntent } from "./contracts";
import type { ContinuationFundingStore } from "../persistence/funding-store";

const GRACE_WINDOW_MS = 600_000;

function decimal(value: bigint): string { return value.toString(10); }
function shortfall(maximum: bigint, available: bigint): bigint { return maximum > available ? maximum - available : 0n; }

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
}
