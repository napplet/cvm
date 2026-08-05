import { NeedsTopUpResultSchema, PendingActionIntentSchema, ResumeSessionCommandSchema, ResumeSessionResultSchema, type NeedsTopUpResult, type PendingActionIntent, type ResumeCompatibility, type ResumeSessionCommand, type ResumeSessionResult } from "./contracts";
import type { CheckpointEnvelope, CheckpointEnvelopeService, CheckpointManifest } from "./checkpoint-envelope";
import type { ContinuationFundingStore } from "../persistence/funding-store";
import type { CheckpointRestoreRequest, ContinuationWorkerPort } from "../phase-02/contracts";
import { canonicalJson } from "../promotion/schema";

const GRACE_WINDOW_MS = 600_000;

function decimal(value: bigint): string { return value.toString(10); }
function shortfall(maximum: bigint, available: bigint): bigint { return maximum > available ? maximum - available : 0n; }
function frozen<T>(value: T): T { return Object.freeze(value); }
async function fingerprint(value: unknown): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(canonicalJson(value)));
  return Array.from(new Uint8Array(digest), (byte) => byte.toString(16).padStart(2, "0")).join("");
}

export type ResumeCheckpointMaterial = Readonly<{ manifest: CheckpointManifest; envelope: CheckpointEnvelope }>;
export type ResumeAllocation = Readonly<{ status: "allocated"; worker: ContinuationWorkerPort }> | Readonly<{ status: "refused" | "unknown" }>;
export type ResumeDependencies = Readonly<{
  compatibility: ResumeCompatibility;
  /** Server-owned exact-generation reader; it never accepts checkpoint material from a caller. */
  checkpoint: Readonly<{
    loadExact(checkpointId: string): Promise<ResumeCheckpointMaterial>;
    restore(material: ResumeCheckpointMaterial): Promise<Uint8Array>;
  }>;
  /** The allocation implementation must reconcile this durable intent, never allocate by a fresh caller-generated key. */
  allocate(input: Readonly<{ accountId: string; sessionId: string; checkpointId: string; leaseToken: string; allocationIntentReference: string }>): Promise<ResumeAllocation>;
}>;

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
  /** Server-fenced, internal-only capability used to report the effect outcome. */
  dispatchClaimToken?: string;
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
  #resumeInFlight = new Map<string, Promise<ResumeSessionResult>>();
  #resumeResults = new Map<string, ResumeSessionResult>();
  constructor(private readonly options: Readonly<{ store: ContinuationFundingStore; clock?: Readonly<{ nowMs(): number }>; resume?: ResumeDependencies }>) {}

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
      // One durable transition owns the replay result, exact grace deadline,
      // complete pending intent, and live-worker lease.  No secondary record
      // may be required for wake/checkpoint/resume to work.
      await transaction.pauseForFunding({
        accountId: intent.accountId,
        sessionId: intent.sessionId,
        admissionReference: intent.admissionReference,
        idempotencyKey: intent.idempotencyKey,
        fingerprint: intent.fingerprint,
        pendingFingerprint: intent.fingerprint,
        expectedSessionVersion: intent.expectedSessionVersion,
        pauseGeneration: await transaction.nextPauseGeneration(intent.sessionId),
        graceDeadlineMs: deadline,
        liveLeaseToken: `lease:live:${intent.reference}:${intent.fingerprint.slice(0, 24)}`,
        intent,
        result,
      });
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
      if (pause.pendingFingerprint !== input.pendingFingerprint) return frozen({ status: "no_effect" as const, code: "PENDING_ACTION_MISMATCH" });
      if (pause.expectedSessionVersion !== input.expectedSessionVersion) return frozen({ status: "no_effect" as const, code: "STALE_SESSION_VERSION" });

      // The full intent is the durable source for artifact lineage. A pause
      // without its matching intent is not eligible to wake a worker.
      const continuation = await this.options.store.findContinuationForSession(input.accountId, input.sessionId);
      if (!continuation || continuation.intent.fingerprint !== pause.pendingFingerprint) return frozen({ status: "no_effect" as const, code: "PENDING_ACTION_MISMATCH" });
      if (continuation.intent.expectedArtifactVersion !== input.expectedArtifactVersion) return frozen({ status: "no_effect" as const, code: "STALE_ARTIFACT_VERSION" });

      if (pause.state !== "needs_top_up" && pause.state !== "resuming") return frozen({ status: "no_effect" as const, code: "PAUSE_NOT_LIVE" });

      const funding = await transaction.continuationFundingSnapshot(pause.admissionReference);
      const amount = BigInt(continuation.intent.actionMaximum);
      if (funding.remainingCap < amount) return frozen({ status: "no_effect" as const, code: "APPROVED_CAP_INSUFFICIENT" });
      if (funding.availableBalance < amount) return frozen({ status: "no_effect" as const, code: "VERIFIED_CREDIT_REQUIRED" });

      const idempotencyKey = `continuation-wake:${pause.idempotencyKey}:${pause.pauseGeneration}`;
      // Reassert the store fence only after every coordinator predicate above.
      // The pause transition, budget, and durable effect intent commit together.
      await transaction.wakePausedAction({ sessionId: input.sessionId, pauseGeneration: input.pauseGeneration, nowMs, liveLeaseToken: input.liveLeaseToken });
      const budget = await transaction.findActionBudget(idempotencyKey) ?? await transaction.reserveActionBudget({
        accountId: input.accountId, admissionReference: pause.admissionReference, idempotencyKey,
        fingerprint: `wake:${pause.pendingFingerprint}:${pause.expectedSessionVersion}:${continuation.intent.expectedArtifactVersion}`,
        reference: `action-budget:wake:${pause.sessionId}:${pause.pauseGeneration}`, amount,
      });
      const claim = await transaction.claimWakeDispatch({ accountId: input.accountId, sessionId: input.sessionId, pauseGeneration: input.pauseGeneration, pendingFingerprint: pause.pendingFingerprint, expectedSessionVersion: pause.expectedSessionVersion, expectedArtifactVersion: continuation.intent.expectedArtifactVersion, actionBudgetReference: budget.reference, liveLeaseToken: input.liveLeaseToken });
      if (!claim.claimed) return frozen({ status: "replayed" as const, code: claim.dispatch.state === "unknown" ? "WAKE_RECONCILIATION_REQUIRED" : "WAKE_ALREADY_CLAIMED" });
      return frozen({ status: "continued" as const, code: "WAKE_DISPATCH_CLAIMED", leaseToken: input.liveLeaseToken, pendingActionReference: continuation.intent.reference, actionBudgetReference: budget.reference, dispatchClaimToken: claim.dispatch.claimToken });
    });

    if (transition.status !== "continued") return transition;
    input.onAuthorization?.();
    await input.onAuthorized?.();
    return transition;
  }

  /** The caller holding the effect claim must durably close it after dispatch. */
  async recordWakeDispatchOutcome(input: Readonly<{ accountId: string; sessionId: string; pauseGeneration: number; dispatchClaimToken: string; outcome: "completed" | "unknown" }>): Promise<void> {
    await this.options.store.transact(input.accountId, (transaction) => transaction.recordWakeDispatchOutcome({ sessionId: input.sessionId, pauseGeneration: input.pauseGeneration, claimToken: input.dispatchClaimToken, state: input.outcome }));
  }

  /**
   * Claims a post-grace checkpoint before any allocation, archive read, worker
   * restore, provider work, or charge. A later credit changes the ledger only;
   * this explicit owner command is the sole resume authority.
   */
  async resumeSession(input: unknown): Promise<ResumeSessionResult> {
    const parsed = ResumeSessionCommandSchema.safeParse(input);
    if (!parsed.success) return ResumeSessionResultSchema.parse({ status: "denied", code: "RESUME_INVALID_COMMAND" });
    if (!this.options.resume) return ResumeSessionResultSchema.parse({ status: "denied", code: "RESUME_CHECKPOINT_NOT_FOUND_OR_DENIED" });
    const command = parsed.data;
    const replayKey = `${command.principal.id}\u0000${command.idempotencyKey}`;
    const remembered = this.#resumeResults.get(replayKey);
    if (remembered) return remembered;
    const active = this.#resumeInFlight.get(replayKey);
    if (active) return active;
    const run = this.#claimAndRestore(command).then((result) => {
      this.#resumeResults.set(replayKey, result);
      return result;
    }).finally(() => this.#resumeInFlight.delete(replayKey));
    this.#resumeInFlight.set(replayKey, run);
    return run;
  }

  async #claimAndRestore(command: ResumeSessionCommand): Promise<ResumeSessionResult> {
    const dependencies = this.options.resume!;
    const accountId = command.principal.id;
    const continuation = await this.options.store.findContinuationForSession(accountId, command.sessionId);
    if (!continuation || command.checkpointId.length === 0) return ResumeSessionResultSchema.parse({ status: "denied", code: "RESUME_CHECKPOINT_NOT_FOUND_OR_DENIED" });
    if (!command.approvePendingAction) return ResumeSessionResultSchema.parse({ status: "denied", code: "RESUME_PENDING_APPROVAL_REQUIRED" });
    if (command.pendingAction.reference !== continuation.intent.reference || command.pendingAction.fingerprint !== continuation.intent.fingerprint || command.pendingAction.kind !== continuation.intent.actionKind || command.pendingAction.maximum !== continuation.intent.actionMaximum) {
      return ResumeSessionResultSchema.parse({ status: "denied", code: "RESUME_PENDING_ACTION_MISMATCH" });
    }
    if (command.capApprovalReference !== continuation.intent.admissionReference) return ResumeSessionResultSchema.parse({ status: "denied", code: "RESUME_CAP_APPROVAL_REQUIRED" });
    if (!this.#compatible(continuation.intent, dependencies.compatibility)) return ResumeSessionResultSchema.parse({ status: "denied", code: "RESUME_COMPATIBILITY_DENIED" });

    const commandFingerprint = await fingerprint({ principal: command.principal, sessionId: command.sessionId, checkpointId: command.checkpointId, expectedSessionVersion: command.expectedSessionVersion, expectedCheckpointVersion: command.expectedCheckpointVersion, idempotencyKey: command.idempotencyKey, pendingAction: command.pendingAction, capApprovalReference: command.capApprovalReference });
    const leaseToken = `lease:resume:${commandFingerprint.slice(0, 24)}`;
    const allocationIntentReference = `allocation:resume:${command.checkpointId}:${commandFingerprint.slice(0, 24)}`;
    const budgetKey = `continuation-resume:${command.checkpointId}:${command.idempotencyKey}`;
    const nowMs = (this.options.clock ?? { nowMs: Date.now }).nowMs();
    let claimed: Readonly<{ actionBudgetReference: string; allocationIntentReference: string; leaseToken: string }>;
    try {
      claimed = await this.options.store.transact(accountId, async (transaction) => {
        const funds = await transaction.continuationFundingSnapshot(continuation.intent.admissionReference);
        const amount = BigInt(continuation.intent.actionMaximum);
        if (funds.availableBalance < amount) throw new Error("RESUME_BALANCE_INSUFFICIENT");
        if (funds.remainingCap < amount) throw new Error("RESUME_CAP_INSUFFICIENT");
        const claim = await transaction.claimResume({ accountId, sessionId: command.sessionId, checkpointId: command.checkpointId, idempotencyKey: command.idempotencyKey, fingerprint: commandFingerprint, pendingFingerprint: command.pendingAction.fingerprint, expectedCheckpointVersion: command.expectedCheckpointVersion, expectedSessionVersion: command.expectedSessionVersion, nowMs, newLeaseToken: leaseToken, allocationIntentReference });
        // Claim expiry authority before reserving budget: a terminal tombstone
        // must reject a late command without creating any financial effect.
        const budget = await transaction.reserveActionBudget({ accountId, admissionReference: continuation.intent.admissionReference, idempotencyKey: budgetKey, fingerprint: commandFingerprint, reference: `action-budget:resume:${command.checkpointId}:${commandFingerprint.slice(0, 24)}`, amount });
        return frozen({ actionBudgetReference: budget.reference, allocationIntentReference: claim.allocationIntentReference, leaseToken: claim.leaseToken });
      });
    } catch (error) {
      const code = error instanceof Error ? error.message : "";
      if (code === "RESUME_BALANCE_INSUFFICIENT" || code === "RESUME_CAP_INSUFFICIENT") return ResumeSessionResultSchema.parse({ status: "denied", code });
      return ResumeSessionResultSchema.parse({ status: "denied", code: "RESUME_STALE_OR_CONFLICTING" });
    }

    let allocation: ResumeAllocation;
    try {
      allocation = await dependencies.allocate({ accountId, sessionId: command.sessionId, checkpointId: command.checkpointId, leaseToken: claimed.leaseToken, allocationIntentReference: claimed.allocationIntentReference });
    } catch { allocation = { status: "unknown" }; }
    if (allocation.status !== "allocated") {
      await this.#recordRestoreObservation(accountId, command.checkpointId, claimed.allocationIntentReference, allocation.status === "refused" ? "refused" : "reconciliation_pending");
      return ResumeSessionResultSchema.parse({ status: "reconciliation_pending", code: "RESUME_ALLOCATION_RECONCILIATION", sessionId: command.sessionId, checkpointId: command.checkpointId, pendingActionReference: continuation.intent.reference, allocationIntentReference: claimed.allocationIntentReference });
    }

    let material: ResumeCheckpointMaterial;
    let archive: Uint8Array;
    try {
      material = await dependencies.checkpoint.loadExact(command.checkpointId);
      if (!this.#materialMatches(material.manifest, command, continuation.intent, dependencies.compatibility)) throw new Error("CHECKPOINT_BINDING_DENIED");
      archive = await dependencies.checkpoint.restore(material);
    } catch {
      await this.#recordRestoreObservation(accountId, command.checkpointId, claimed.allocationIntentReference, "reconciliation_pending");
      return ResumeSessionResultSchema.parse({ status: "reconciliation_pending", code: "RESUME_CHECKPOINT_RECONCILIATION", sessionId: command.sessionId, checkpointId: command.checkpointId, pendingActionReference: continuation.intent.reference, allocationIntentReference: claimed.allocationIntentReference });
    }

    try {
      const restored = await allocation.worker.restoreCheckpoint({
        accountId, sessionId: command.sessionId, actionId: material.manifest.action.actionId, expectedVersion: command.expectedSessionVersion,
        policyVersion: continuation.intent.policyVersion, capabilityGrant: "phase-05-continuation-grant", workspaceId: material.manifest.workspaceLineage,
        checkpointId: command.checkpointId, pauseGeneration: material.manifest.pauseGeneration, actionVersion: material.manifest.actionVersion,
        workspaceLineage: material.manifest.workspaceLineage, leaseToken: claimed.leaseToken, resumeClaim: claimed.allocationIntentReference, archive, archiveSha256: material.manifest.archiveSha256,
      } satisfies CheckpointRestoreRequest);
      if (restored.status !== "restored") throw new Error("WORKER_RESTORE_DENIED");
      await this.#recordRestoreObservation(accountId, command.checkpointId, claimed.allocationIntentReference, "restored");
      return ResumeSessionResultSchema.parse({ status: "restored", code: "RESUME_RESTORED", sessionId: command.sessionId, checkpointId: command.checkpointId, pendingActionReference: continuation.intent.reference, actionBudgetReference: claimed.actionBudgetReference, allocationIntentReference: claimed.allocationIntentReference });
    } catch {
      await this.#recordRestoreObservation(accountId, command.checkpointId, claimed.allocationIntentReference, "refused");
      return ResumeSessionResultSchema.parse({ status: "reconciliation_pending", code: "RESUME_RESTORE_RECONCILIATION", sessionId: command.sessionId, checkpointId: command.checkpointId, pendingActionReference: continuation.intent.reference, allocationIntentReference: claimed.allocationIntentReference });
    }
  }

  async #recordRestoreObservation(accountId: string, checkpointId: string, allocationIntentReference: string, state: "restored" | "refused" | "reconciliation_pending"): Promise<void> {
    try { await this.options.store.transact(accountId, (transaction) => transaction.recordRestoreObservation({ checkpointId, allocationIntentReference, state })); } catch { /* Durable claim remains the fence; a retry reconciles its original intent. */ }
  }

  #compatible(intent: PendingActionIntent, pins: ResumeCompatibility): boolean {
    return intent.policyVersion === pins.policyVersion && intent.profileId === pins.profileId && intent.priceCardId === pins.priceCardId && intent.toolchainId === pins.toolchainId;
  }

  #materialMatches(manifest: CheckpointManifest, command: ResumeSessionCommand, intent: PendingActionIntent, pins: ResumeCompatibility): boolean {
    return manifest.checkpointId === command.checkpointId && manifest.accountId === command.principal.id && manifest.sessionId === command.sessionId && manifest.sessionVersion === command.expectedSessionVersion && manifest.artifactVersion === intent.expectedArtifactVersion && manifest.action.pendingActionReference === intent.reference && manifest.action.idempotencyKey === intent.idempotencyKey && manifest.compatibility.policyVersion === pins.policyVersion && manifest.compatibility.modelIdentity === pins.profileId && manifest.compatibility.nappletSdkIdentity === pins.priceCardId && manifest.compatibility.toolchainIdentity === pins.toolchainId;
  }
}
