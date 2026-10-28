import { NeedsTopUpResultSchema, PendingActionIntentSchema, ResumeSessionCommandSchema, ResumeSessionResultSchema, type NeedsTopUpResult, type PendingActionIntent, type ResumeCompatibility, type ResumeSessionCommand, type ResumeSessionResult } from "./contracts";
import type { CheckpointEnvelope, CheckpointEnvelopeService, CheckpointManifest } from "./checkpoint-envelope";
import type { ContinuationFundingStore, ContinuationFundingSnapshot } from "../persistence/funding-store";
import type { CheckpointRestoreRequest, ContinuationWorkerPort } from "../phase-02/contracts";
import { canonicalJson } from "../promotion/schema";
import { emitLifecycleObservation, type LifecycleTelemetryPort } from "../telemetry/contracts";

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
    loadExact(input: Readonly<{ checkpointId: string; accountId: string; sessionId: string }>): Promise<ResumeCheckpointMaterial>;
    restore(material: ResumeCheckpointMaterial): Promise<Uint8Array>;
  }>;
  /** The allocation implementation must reconcile this durable intent, never allocate by a fresh caller-generated key. */
  allocate(input: Readonly<{ accountId: string; sessionId: string; checkpointId: string; leaseToken: string; allocationIntentReference: string; actionId: string; expectedVersion: number; policyVersion: string; workspaceId: string; sourceActionId: string }>): Promise<ResumeAllocation>;
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
  /** Stable identity for the exact coordinator/worker operation. */
  operationId?: string;
  /** Server-fenced, internal-only capability used to report the effect outcome. */
  dispatchClaimToken?: string;
}>;

/**
 * Narrow post-credit hook exposed to verified payment rails. The only input
 * is the server-derived account identity; durable continuity state chooses
 * every session, generation, action identity, and worker lease.
 */
export type VerifiedCreditWakeDispatcher = Readonly<{
  dispatchVerifiedCredit(accountId: string): Promise<readonly VerifiedCreditWakeResult[]>;
}>;

export type VerifiedCreditWakeInput = VerifiedCreditWakeHint & Readonly<{
  /** Coordinator-only continuation hook. Its result is durably closed below. */
  onAuthorized?: () => Promise<void> | void;
  /** Test/observability seam for proving authorization happens only after the atomic transition. */
  onAuthorization?: () => void;
}>;

/** Lookup-only owner for a previously claimed external wake operation. */
export type WakeEffectReconciliationPort = Readonly<{
  observe(input: Readonly<{ accountId: string; sessionId: string; pauseGeneration: number; operationId: string; actionBudgetReference: string; liveLeaseToken: string }>): Promise<"completed" | "unknown">;
}>;

/**
 * Coordinator-owned pause authority. It deliberately has no worker, provider,
 * or payment-rail dependency: a failed affordability check only records one
 * replayable pending intent in the same serialized store transaction.
 */
export class ContinuationService {
  #resumeInFlight = new Map<string, Promise<ResumeSessionResult>>();
  #resumeResults = new Map<string, ResumeSessionResult>();
  constructor(private readonly options: Readonly<{ store: ContinuationFundingStore; clock?: Readonly<{ nowMs(): number }>; resume?: ResumeDependencies; wakeReconciliation?: WakeEffectReconciliationPort; telemetry?: LifecycleTelemetryPort; includeAdmissionHold?: boolean }>) {}

  #spendable(funding: ContinuationFundingSnapshot): bigint {
    return funding.availableBalance + (this.options.includeAdmissionHold ? funding.remainingCap : 0n);
  }

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
      // Explicit production/development compositions spend this admission
      // hold, never money held for another session. Legacy callers retain
      // their default policy until deliberately opting into this authority.
      const spendable = this.#spendable(funding);
      const requiredAdditionalFunding = shortfall(actionMaximum, spendable);
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

      // The locked pause contains the immutable action identity. Never select
      // a newer pause generation while waking this worker.
      const continuation = pause.intent;
      if (continuation.fingerprint !== pause.pendingFingerprint) return frozen({ status: "no_effect" as const, code: "PENDING_ACTION_MISMATCH" });
      if (continuation.expectedArtifactVersion !== input.expectedArtifactVersion) return frozen({ status: "no_effect" as const, code: "STALE_ARTIFACT_VERSION" });

      if (pause.state !== "needs_top_up" && pause.state !== "resuming") return frozen({ status: "no_effect" as const, code: "PAUSE_NOT_LIVE" });

      const funding = await transaction.continuationFundingSnapshot(pause.admissionReference);
      const amount = BigInt(continuation.actionMaximum);
      if (funding.remainingCap < amount) return frozen({ status: "no_effect" as const, code: "APPROVED_CAP_INSUFFICIENT" });
      if (this.#spendable(funding) < amount) return frozen({ status: "no_effect" as const, code: "VERIFIED_CREDIT_REQUIRED" });

      const idempotencyKey = `continuation-wake:${pause.idempotencyKey}:${pause.pauseGeneration}`;
      // Reassert the store fence only after every coordinator predicate above.
      // The pause transition, budget, and durable effect intent commit together.
      await transaction.wakePausedAction({ sessionId: input.sessionId, pauseGeneration: input.pauseGeneration, nowMs, liveLeaseToken: input.liveLeaseToken });
      const budget = await transaction.findActionBudget(idempotencyKey) ?? await transaction.reserveActionBudget({
        accountId: input.accountId, admissionReference: pause.admissionReference, idempotencyKey,
        fingerprint: `wake:${pause.pendingFingerprint}:${pause.expectedSessionVersion}:${continuation.expectedArtifactVersion}`,
        reference: `action-budget:wake:${pause.sessionId}:${pause.pauseGeneration}`, amount,
      });
      const claim = await transaction.claimWakeDispatch({ accountId: input.accountId, sessionId: input.sessionId, pauseGeneration: input.pauseGeneration, pendingFingerprint: pause.pendingFingerprint, expectedSessionVersion: pause.expectedSessionVersion, expectedArtifactVersion: continuation.expectedArtifactVersion, actionBudgetReference: budget.reference, operationId: `wake-operation:${pause.sessionId}:${pause.pauseGeneration}:${budget.reference}`, liveLeaseToken: input.liveLeaseToken });
      if (!claim.claimed) return frozen({ status: "replayed" as const, code: claim.dispatch.state === "unknown" || claim.dispatch.state === "reconciliation_terminal" ? "WAKE_RECONCILIATION_REQUIRED" : "WAKE_ALREADY_CLAIMED" });
      return frozen({ status: "continued" as const, code: "WAKE_DISPATCH_CLAIMED", leaseToken: input.liveLeaseToken, pendingActionReference: continuation.reference, actionBudgetReference: budget.reference, operationId: claim.dispatch.operationId, dispatchClaimToken: claim.dispatch.claimToken });
    });

    if (transition.status !== "continued") return transition;
    if (!input.onAuthorization && !input.onAuthorized) return transition;
    try {
      input.onAuthorization?.();
      await input.onAuthorized?.();
      await this.recordWakeDispatchOutcome({ accountId: input.accountId, sessionId: input.sessionId, pauseGeneration: input.pauseGeneration, dispatchClaimToken: transition.dispatchClaimToken!, outcome: "completed" });
    } catch (error) {
      await this.recordWakeDispatchOutcome({ accountId: input.accountId, sessionId: input.sessionId, pauseGeneration: input.pauseGeneration, dispatchClaimToken: transition.dispatchClaimToken!, outcome: "unknown" }).catch(() => undefined);
      throw error;
    }
    return transition;
  }

  /** The caller holding the effect claim must durably close it after dispatch. */
  async recordWakeDispatchOutcome(input: Readonly<{ accountId: string; sessionId: string; pauseGeneration: number; dispatchClaimToken: string; outcome: "completed" | "unknown" }>): Promise<void> {
    await this.options.store.transact(input.accountId, (transaction) => transaction.recordWakeDispatchOutcome({ sessionId: input.sessionId, pauseGeneration: input.pauseGeneration, claimToken: input.dispatchClaimToken, state: input.outcome }));
  }

  /** Restart-safe, lookup-only closure for a claim whose original handoff died. */
  async reconcileWakeDispatch(input: Readonly<{ accountId: string; sessionId: string; pauseGeneration: number }>): Promise<"completed" | "unknown" | "not_found"> {
    const dispatch = await this.options.store.findWakeDispatch(input.accountId, input.sessionId, input.pauseGeneration);
    const pause = await this.options.store.findContinuationPause(input.accountId, input.sessionId, input.pauseGeneration);
    if (!dispatch || !pause || dispatch.pendingFingerprint !== pause.pendingFingerprint || dispatch.expectedSessionVersion !== pause.expectedSessionVersion || dispatch.expectedArtifactVersion !== pause.intent.expectedArtifactVersion) return "not_found";
    if (dispatch.state === "completed") return "completed";
    if (dispatch.state === "late_evidence_requires_operator") return "unknown";
    let outcome: "completed" | "unknown" = "unknown";
    try { outcome = await this.options.wakeReconciliation?.observe({ accountId: input.accountId, sessionId: input.sessionId, pauseGeneration: input.pauseGeneration, operationId: dispatch.operationId, actionBudgetReference: dispatch.actionBudgetReference, liveLeaseToken: dispatch.liveLeaseToken }) ?? "unknown"; } catch { outcome = "unknown"; }
    await this.recordWakeDispatchOutcome({ accountId: input.accountId, sessionId: input.sessionId, pauseGeneration: input.pauseGeneration, dispatchClaimToken: dispatch.claimToken!, outcome });
    return outcome;
  }

  /**
   * Coordinator restart surface. Discovery is owner-scoped and reads only
   * durable claimed/unknown effect intents; it never creates work or calls a
   * continuation handoff. Each item is reconciled by its exact operation ID.
   */
  async reconcileOutstandingWakeDispatches(accountId: string): Promise<readonly Readonly<{ sessionId: string; pauseGeneration: number; outcome: "completed" | "unknown" | "not_found" }>[]> {
    const outstanding = await this.options.store.listOutstandingWakeDispatches(accountId);
    const results = await Promise.all(outstanding.map(async (dispatch) => frozen({
      sessionId: dispatch.sessionId,
      pauseGeneration: dispatch.pauseGeneration,
      outcome: await this.reconcileWakeDispatch({ accountId, sessionId: dispatch.sessionId, pauseGeneration: dispatch.pauseGeneration }),
    })));
    return frozen(results);
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
    const run = this.#claimAndRestore(command).then(async (result) => {
      this.#resumeResults.set(replayKey, result);
      await emitLifecycleObservation(this.options.telemetry, [command.principal.id, command.sessionId, command.checkpointId], "resume", result.status === "restored" ? "succeeded" : result.status === "reconciliation_pending" ? "pending" : "blocked", (this.options.clock ?? { nowMs: Date.now }).nowMs());
      return result;
    }).finally(() => this.#resumeInFlight.delete(replayKey));
    this.#resumeInFlight.set(replayKey, run);
    return run;
  }

  /**
   * The resumed worker's terminal callback retires its exact pause only after
   * the checkpoint restore has been durably observed. This is intentionally a
   * coordinator-only lifecycle completion, not an automatic post-grace resume.
   */
  async completeResumedAction(input: Readonly<{ accountId: string; checkpointId: string; allocationIntentReference: string; leaseToken: string; actionId: string; operationId: string; finalization: import("../persistence/funding-store").MeteredFinalizeInput }>): Promise<void> {
    await this.options.store.transact(input.accountId, (transaction) => transaction.completeResumedAction(input));
  }

  async #claimAndRestore(command: ResumeSessionCommand): Promise<ResumeSessionResult> {
    const dependencies = this.options.resume!;
    const accountId = command.principal.id;
    const checkpoint = command.checkpointId.length > 0 ? await this.options.store.findContinuationCheckpoint(accountId, command.checkpointId) : undefined;
    const pause = checkpoint ? await this.options.store.findContinuationPause(accountId, command.sessionId, checkpoint.pauseGeneration) : undefined;
    const continuation = pause ? { intent: pause.intent, result: pause.result, state: pause.state } : undefined;
    if (!checkpoint || !continuation) return ResumeSessionResultSchema.parse({ status: "denied", code: "RESUME_CHECKPOINT_NOT_FOUND_OR_DENIED" });
    if (!command.approvePendingAction) return ResumeSessionResultSchema.parse({ status: "denied", code: "RESUME_PENDING_APPROVAL_REQUIRED" });
    if (command.pendingAction.reference !== continuation.intent.reference || command.pendingAction.fingerprint !== continuation.intent.fingerprint || command.pendingAction.kind !== continuation.intent.actionKind || command.pendingAction.maximum !== continuation.intent.actionMaximum) {
      return ResumeSessionResultSchema.parse({ status: "denied", code: "RESUME_PENDING_ACTION_MISMATCH" });
    }
    if (command.capApprovalReference !== continuation.intent.admissionReference) return ResumeSessionResultSchema.parse({ status: "denied", code: "RESUME_CAP_APPROVAL_REQUIRED" });
    if (!this.#compatible(continuation.intent, dependencies.compatibility)) return ResumeSessionResultSchema.parse({ status: "denied", code: "RESUME_COMPATIBILITY_DENIED" });

    // A replacement instance must prove the retained encrypted object and all
    // durable bindings before it can claim budget, provider authority, or a
    // worker allocation. Object presence alone is never resume authority.
    let material: ResumeCheckpointMaterial;
    let archive: Uint8Array;
    try {
      material = await dependencies.checkpoint.loadExact({ checkpointId: command.checkpointId, accountId, sessionId: command.sessionId });
      if (!this.#materialMatches(material.manifest, command, continuation.intent, dependencies.compatibility)) throw new Error("CHECKPOINT_BINDING_DENIED");
      archive = await dependencies.checkpoint.restore(material);
    } catch {
      return ResumeSessionResultSchema.parse({ status: "reconciliation_pending", code: "RESUME_CHECKPOINT_RECONCILIATION", sessionId: command.sessionId, checkpointId: command.checkpointId, pendingActionReference: continuation.intent.reference });
    }

    const commandFingerprint = await fingerprint({ principal: command.principal, sessionId: command.sessionId, checkpointId: command.checkpointId, expectedSessionVersion: command.expectedSessionVersion, expectedCheckpointVersion: command.expectedCheckpointVersion, idempotencyKey: command.idempotencyKey, pendingAction: command.pendingAction, capApprovalReference: command.capApprovalReference });
    const leaseToken = `lease:resume:${commandFingerprint.slice(0, 24)}`;
    const allocationIntentReference = `allocation:resume:${command.checkpointId}:${commandFingerprint.slice(0, 24)}`;
    const budgetKey = `continuation-resume:${command.checkpointId}:${command.idempotencyKey}`;
    const actionBudgetReference = `action-budget:resume:${command.checkpointId}:${commandFingerprint.slice(0, 24)}`;
    const actionId = `resume-action:${command.checkpointId}:${commandFingerprint.slice(0, 24)}`;
    const operationId = `resume-operation:${command.checkpointId}:${commandFingerprint.slice(0, 24)}`;
    const nowMs = (this.options.clock ?? { nowMs: Date.now }).nowMs();
    let claimed: Readonly<{ actionBudgetReference: string; allocationIntentReference: string; leaseToken: string; actionId: string; operationId: string }>;
    try {
      claimed = await this.options.store.transact(accountId, async (transaction) => {
        const funds = await transaction.continuationFundingSnapshot(continuation.intent.admissionReference);
        const amount = BigInt(continuation.intent.actionMaximum);
        if (this.#spendable(funds) < amount) throw new Error("RESUME_BALANCE_INSUFFICIENT");
        if (funds.remainingCap < amount) throw new Error("RESUME_CAP_INSUFFICIENT");
        const claim = await transaction.claimResume({ accountId, sessionId: command.sessionId, checkpointId: command.checkpointId, idempotencyKey: command.idempotencyKey, fingerprint: commandFingerprint, pendingFingerprint: command.pendingAction.fingerprint, expectedCheckpointVersion: command.expectedCheckpointVersion, expectedSessionVersion: command.expectedSessionVersion, nowMs, newLeaseToken: leaseToken, allocationIntentReference, actionId, operationId, actionBudgetReference });
        // Claim expiry authority before reserving budget: a terminal tombstone
        // must reject a late command without creating any financial effect.
        const budget = await transaction.reserveActionBudget({ accountId, admissionReference: continuation.intent.admissionReference, idempotencyKey: budgetKey, fingerprint: commandFingerprint, reference: actionBudgetReference, amount });
        await transaction.prepareMeteredAction({ accountId, idempotencyKey: budgetKey, fingerprint: commandFingerprint, sessionId: command.sessionId, actionId: claim.actionId, expectedVersion: continuation.intent.expectedSessionVersion, admissionReference: continuation.intent.admissionReference, actionBudgetReference: budget.reference, maximum: amount, operationId: claim.operationId, profileId: continuation.intent.profileId, priceCardId: continuation.intent.priceCardId });
        await transaction.claimProviderOperation(claim.operationId);
        return frozen({ actionBudgetReference: budget.reference, allocationIntentReference: claim.allocationIntentReference, leaseToken: claim.leaseToken, actionId: claim.actionId, operationId: claim.operationId });
      });
    } catch (error) {
      const code = error instanceof Error ? error.message : "";
      if (code === "RESUME_BALANCE_INSUFFICIENT" || code === "RESUME_CAP_INSUFFICIENT") return ResumeSessionResultSchema.parse({ status: "denied", code });
      return ResumeSessionResultSchema.parse({ status: "denied", code: "RESUME_STALE_OR_CONFLICTING" });
    }

    let allocation: ResumeAllocation;
    try {
      allocation = await dependencies.allocate({ accountId, sessionId: command.sessionId, checkpointId: command.checkpointId, leaseToken: claimed.leaseToken, allocationIntentReference: claimed.allocationIntentReference, actionId: claimed.actionId, expectedVersion: command.expectedSessionVersion, policyVersion: continuation.intent.policyVersion, workspaceId: material.manifest.workspaceLineage, sourceActionId: material.manifest.action.actionId });
    } catch { allocation = { status: "unknown" }; }
    if (allocation.status !== "allocated") {
      await this.#recordRestoreObservation(accountId, command.checkpointId, claimed.allocationIntentReference, allocation.status === "refused" ? "refused" : "reconciliation_pending");
      return ResumeSessionResultSchema.parse({ status: "reconciliation_pending", code: "RESUME_ALLOCATION_RECONCILIATION", sessionId: command.sessionId, checkpointId: command.checkpointId, pendingActionReference: continuation.intent.reference });
    }

    try {
      const restored = await allocation.worker.restoreCheckpoint({
        accountId, sessionId: command.sessionId, actionId: claimed.actionId, expectedVersion: command.expectedSessionVersion,
        policyVersion: continuation.intent.policyVersion, capabilityGrant: "phase-05-continuation-grant", workspaceId: material.manifest.workspaceLineage,
        checkpointId: command.checkpointId, pauseGeneration: material.manifest.pauseGeneration, actionVersion: material.manifest.actionVersion,
        workspaceLineage: material.manifest.workspaceLineage, leaseToken: claimed.leaseToken, resumeClaim: claimed.allocationIntentReference, archive: archive as Uint8Array<ArrayBuffer>, archiveSha256: material.manifest.archiveSha256,
      } satisfies CheckpointRestoreRequest);
      if (restored.status !== "restored") throw new Error("WORKER_RESTORE_DENIED");
      await this.#recordRestoreObservation(accountId, command.checkpointId, claimed.allocationIntentReference, "restored");
      return ResumeSessionResultSchema.parse({ status: "restored", code: "RESUME_RESTORED", sessionId: command.sessionId, checkpointId: command.checkpointId, pendingActionReference: continuation.intent.reference });
    } catch {
      await this.#recordRestoreObservation(accountId, command.checkpointId, claimed.allocationIntentReference, "refused");
      return ResumeSessionResultSchema.parse({ status: "reconciliation_pending", code: "RESUME_RESTORE_RECONCILIATION", sessionId: command.sessionId, checkpointId: command.checkpointId, pendingActionReference: continuation.intent.reference });
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
