import type { CheckpointEnvelopeService } from "./checkpoint-envelope";
import type { ContinuationFundingStore, ContinuationPause } from "../persistence/funding-store";
import type { PendingActionIntent } from "./contracts";
import {
  CheckpointProposalSchema,
  type CheckpointExportRequest,
  type CheckpointFenceRequest,
  type CheckpointTerminationRequest,
  type ContinuationWorkerPort,
} from "../phase-02/contracts";

const RETENTION_MS = 2_592_000_000;

function frozen<T>(value: T): T { return Object.freeze(value); }

export type DeadlineCandidate = Readonly<{ accountId: string; sessionId: string; pauseGeneration: number; liveLeaseToken: string }>;
export type RetentionCandidate = Readonly<{ accountId: string; sessionId: string; pauseGeneration: number; checkpointId: string }>;
export type DeadlineReconcileResult = Readonly<{
  status: "not_due" | "checkpointed" | "checkpoint_retryable" | "already_checkpointed";
  code: string;
  sessionId: string;
  pauseGeneration: number;
  checkpointId?: string;
}>;
export type RetentionReconcileResult = Readonly<{
  status: "not_due" | "claimed" | "expired" | "deletion_pending";
  code: string;
  checkpointId: string;
}>;

/** The scheduling adapter supplies durable pause candidates; no queue or worker allocation is introduced here. */
export interface DeadlineCandidatePort {
  listDue(nowMs: number): Promise<readonly DeadlineCandidate[]>;
  /** Durable scheduler query; candidates are hints and SQL remains the authority. */
  listRetentionDue?(nowMs: number): Promise<readonly RetentionCandidate[]>;
}
type CheckpointSealPort = Pick<CheckpointEnvelopeService, "seal"> & Readonly<{
  retainPendingCommand?: (input: Readonly<{ checkpointId: string; accountId: string; sessionId: string; intent: PendingActionIntent }>) => Promise<void>;
}>;
type RetentionDeletionPort = Readonly<{ destroyExpired(input: Readonly<{ accountId: string; sessionId: string; checkpointId: string }>): Promise<void> }>;

/**
 * Reconciles a fixed grace deadline with three failure-independent systems.
 * A ciphertext object may precede the SQL commit, but it has no authority until
 * commitDeadlineCheckpoint atomically records its identity and revokes the
 * live lease. Worker termination is deliberately the final idempotent step.
 */
export class ContinuationDeadlineReconciler {
  #failpoint?: "before_commit" | "after_commit";
  #retentionInFlight = new Map<string, Promise<RetentionReconcileResult>>();
  #retentionResults = new Map<string, RetentionReconcileResult>();

  constructor(private readonly options: Readonly<{
    store: ContinuationFundingStore;
    worker: ContinuationWorkerPort;
    envelope: CheckpointSealPort;
    initialPending?: Readonly<{ seal(pause: ContinuationPause): ReturnType<CheckpointEnvelopeService["seal"]>; release(pause: ContinuationPause): Promise<void> }>;
    retention?: RetentionDeletionPort;
    candidates: DeadlineCandidatePort;
    clock: Readonly<{ nowMs(): number }>;
  }>) {}

  /** Deterministic fault seam for crash-point tests; production callers do not set it. */
  failNext(stage: "before_commit" | "after_commit"): void { this.#failpoint = stage; }

  async scan(): Promise<readonly DeadlineReconcileResult[]> {
    const nowMs = this.options.clock.nowMs();
    const candidates = await this.options.candidates.listDue(nowMs);
    const results: DeadlineReconcileResult[] = [];
    for (const candidate of candidates) results.push(await this.reconcile(candidate, nowMs));
    return Object.freeze(results);
  }

  /**
   * Tombstone authority is committed before any irreversible external call.
   * The port provides only a durable candidate list; strict `now >= deadline`
   * comparison and claim-versus-expiry election happen in the store.
   */
  async scanRetention(): Promise<readonly RetentionReconcileResult[]> {
    const nowMs = this.options.clock.nowMs();
    const candidates = await this.options.candidates.listRetentionDue?.(nowMs) ?? [];
    return Object.freeze(await Promise.all(candidates.map((candidate) => this.reconcileRetention(candidate, nowMs))));
  }

  private async reconcileRetention(candidate: RetentionCandidate, nowMs: number): Promise<RetentionReconcileResult> {
    const remembered = this.#retentionResults.get(candidate.checkpointId);
    if (remembered) return remembered;
    const active = this.#retentionInFlight.get(candidate.checkpointId);
    if (active) return active;
    const run = this.#tombstoneAndDelete(candidate, nowMs).then((result) => {
      if (result.status !== "deletion_pending") this.#retentionResults.set(candidate.checkpointId, result);
      return result;
    }).finally(() => this.#retentionInFlight.delete(candidate.checkpointId));
    this.#retentionInFlight.set(candidate.checkpointId, run);
    return run;
  }

  async #tombstoneAndDelete(candidate: RetentionCandidate, nowMs: number): Promise<RetentionReconcileResult> {
    let checkpoint;
    try {
      checkpoint = await this.options.store.transact(candidate.accountId, (transaction) => transaction.tombstoneExpiredCheckpoint({ checkpointId: candidate.checkpointId, nowMs }));
    } catch (error) {
      if (error instanceof Error && error.message === "CHECKPOINT_RETENTION_ACTIVE") return frozen({ status: "not_due", code: "RETENTION_DEADLINE_PENDING", checkpointId: candidate.checkpointId });
      return frozen({ status: "deletion_pending", code: "RETENTION_TOMBSTONE_RETRYABLE", checkpointId: candidate.checkpointId });
    }
    if (checkpoint.state === "claimed") return frozen({ status: "claimed", code: "PRE_EXPIRY_CLAIM_WON", checkpointId: checkpoint.checkpointId });
    if (checkpoint.state !== "expired") return frozen({ status: "deletion_pending", code: "RETENTION_TERMINAL_STATE_RETRYABLE", checkpointId: checkpoint.checkpointId });

    // This committed audit intent is the recovery anchor.  Do not create or
    // target anything from a later caller-supplied object/key value.
    await this.options.store.transact(candidate.accountId, (transaction) => transaction.recordDeletionOutcome({ checkpointId: checkpoint.checkpointId, objectGeneration: checkpoint.objectGeneration, state: "scheduled" }));
    const object = { key: checkpoint.objectKey, generation: Number(checkpoint.objectGeneration), checksum: checkpoint.objectChecksum };
    try {
      if (this.options.retention) await this.options.retention.destroyExpired({ accountId: candidate.accountId, sessionId: candidate.sessionId, checkpointId: checkpoint.checkpointId });
      else {
        // Legacy/test envelope adapter. Production passes the coordinator
        // above so deletion remains owner-bound and cannot target a raw key.
        const envelope = this.options.envelope as CheckpointEnvelopeService;
        await envelope.destroyKey(checkpoint.keyReference);
        await envelope.scheduleDeleteGeneration(object, nowMs);
      }
      await this.options.store.transact(candidate.accountId, (transaction) => transaction.recordDeletionOutcome({ checkpointId: checkpoint.checkpointId, objectGeneration: checkpoint.objectGeneration, state: "deleted" }));
      return frozen({ status: "expired", code: "RETENTION_EXPIRED_AND_DELETE_SCHEDULED", checkpointId: checkpoint.checkpointId });
    } catch {
      await this.options.store.transact(candidate.accountId, (transaction) => transaction.recordDeletionOutcome({ checkpointId: checkpoint.checkpointId, objectGeneration: checkpoint.objectGeneration, state: "unknown" }));
      return frozen({ status: "deletion_pending", code: "RETENTION_DELETE_RECONCILIATION", checkpointId: checkpoint.checkpointId });
    }
  }

  private async reconcile(candidate: DeadlineCandidate, nowMs: number): Promise<DeadlineReconcileResult> {
    const existing = await this.options.store.transact(candidate.accountId, (transaction) => transaction.findContinuationPause(candidate.sessionId, candidate.pauseGeneration));
    if (!existing || existing.liveLeaseToken !== candidate.liveLeaseToken) return frozen({ status: "already_checkpointed", code: "LIVE_LEASE_ALREADY_FENCED", sessionId: candidate.sessionId, pauseGeneration: candidate.pauseGeneration });
    if (nowMs < existing.graceDeadlineMs) return frozen({ status: "not_due", code: "GRACE_DEADLINE_PENDING", sessionId: candidate.sessionId, pauseGeneration: candidate.pauseGeneration });
    if (existing.state === "resuming" || existing.state === "completed") return frozen({ status: "already_checkpointed", code: "WAKE_DISPATCH_OWNS_PAUSE", sessionId: candidate.sessionId, pauseGeneration: candidate.pauseGeneration });
    if (existing.state === "resume_required" || existing.state === "claimed" || existing.state === "expired") return frozen({ status: "already_checkpointed", code: "CHECKPOINT_ALREADY_COMMITTED", sessionId: candidate.sessionId, pauseGeneration: candidate.pauseGeneration });

    let pause: typeof existing;
    try {
      pause = await this.options.store.transact(candidate.accountId, (transaction) => transaction.beginDeadlineCheckpoint({ sessionId: candidate.sessionId, pauseGeneration: candidate.pauseGeneration, liveLeaseToken: candidate.liveLeaseToken }));
    } catch {
      return frozen({ status: "checkpoint_retryable", code: "CHECKPOINT_CLAIM_RETRYABLE", sessionId: candidate.sessionId, pauseGeneration: candidate.pauseGeneration });
    }

    const continuation = pause.intent;
    if (continuation.fingerprint !== pause.pendingFingerprint) return frozen({ status: "checkpoint_retryable", code: "CHECKPOINT_LINEAGE_RETRYABLE", sessionId: candidate.sessionId, pauseGeneration: candidate.pauseGeneration });

    const binding = {
      accountId: candidate.accountId,
      sessionId: candidate.sessionId,
      actionId: `action:${continuation.reference}`,
      expectedVersion: pause.expectedSessionVersion,
      policyVersion: continuation.policyVersion,
      capabilityGrant: "phase-05-continuation-grant",
      workspaceId: `workspace:${candidate.sessionId}`,
      checkpointId: `checkpoint:${candidate.sessionId}:${candidate.pauseGeneration}`,
      pauseGeneration: candidate.pauseGeneration,
      actionVersion: pause.expectedSessionVersion,
      workspaceLineage: `workspace:${candidate.sessionId}`,
      leaseToken: candidate.liveLeaseToken,
    };

    const initialPending = continuation.actionKind === "start_session" && continuation.expectedSessionVersion === 0 && (continuation.protectedCommand !== undefined || this.options.initialPending !== undefined);
    let sealed: Awaited<ReturnType<CheckpointEnvelopeService["seal"]>>;
    if (initialPending) {
      if (!this.options.initialPending) return frozen({ status: "checkpoint_retryable", code: "INITIAL_PENDING_CHECKPOINT_REQUIRED", sessionId: candidate.sessionId, pauseGeneration: candidate.pauseGeneration });
      try { sealed = await this.options.initialPending.seal(pause); }
      catch { return frozen({ status: "checkpoint_retryable", code: "INITIAL_PENDING_CHECKPOINT_RETRYABLE", sessionId: candidate.sessionId, pauseGeneration: candidate.pauseGeneration }); }
    } else {
      // Fencing is an acknowledged worker-side boundary, not merely a database
      // state label.  Export is forbidden until the worker has stopped accepting
      // model/tool/build/network effects for this exact lease.
      const fence = await this.options.worker.fenceCheckpoint(binding as CheckpointFenceRequest);
      if (fence.status !== "fenced") return frozen({ status: "checkpoint_retryable", code: "CHECKPOINT_FENCE_RETRYABLE", sessionId: candidate.sessionId, pauseGeneration: candidate.pauseGeneration });
      const exported = await this.options.worker.exportCheckpoint(binding as CheckpointExportRequest);
      if (exported.status !== "exported") return frozen({ status: "checkpoint_retryable", code: "CHECKPOINT_EXPORT_DENIED", sessionId: candidate.sessionId, pauseGeneration: candidate.pauseGeneration });

      try {
        const proposal = CheckpointProposalSchema.parse(exported.proposal);
        const archive = new Uint8Array(Buffer.from(proposal.archiveBase64, "base64"));
        if (Buffer.from(archive).toString("base64") !== proposal.archiveBase64) throw new Error("CHECKPOINT_ARCHIVE_INVALID");
        sealed = await this.options.envelope.seal({
          checkpointId: proposal.checkpointId,
          accountId: candidate.accountId,
          sessionId: candidate.sessionId,
          pauseGeneration: candidate.pauseGeneration,
          sessionVersion: pause.expectedSessionVersion,
          actionVersion: pause.expectedSessionVersion,
          artifactVersion: continuation.expectedArtifactVersion,
          workspaceVersion: pause.expectedSessionVersion,
          workspaceLineage: binding.workspaceLineage,
          action: { actionId: binding.actionId, operationId: `operation:${continuation.reference}`, ledgerReference: pause.admissionReference, pendingActionReference: continuation.reference, idempotencyKey: continuation.idempotencyKey },
          archive,
          inventory: proposal.inventory,
          evidenceSha256: proposal.evidenceSha256,
          compatibility: { policyVersion: continuation.policyVersion, modelIdentity: continuation.profileId, nappletSdkIdentity: continuation.priceCardId, toolchainIdentity: continuation.toolchainId },
          retentionUntil: new Date(nowMs + RETENTION_MS).toISOString(),
        });
      } catch {
        return frozen({ status: "checkpoint_retryable", code: "CHECKPOINT_SEAL_RETRYABLE", sessionId: candidate.sessionId, pauseGeneration: candidate.pauseGeneration });
      }

    }

    if (!initialPending && continuation.protectedCommand) {
      if (!this.options.envelope.retainPendingCommand) return frozen({ status: "checkpoint_retryable", code: "CHECKPOINT_PENDING_COMMAND_CUSTODY_REQUIRED", sessionId: candidate.sessionId, pauseGeneration: candidate.pauseGeneration });
      try { await this.options.envelope.retainPendingCommand({ checkpointId: sealed.manifest.checkpointId, accountId: candidate.accountId, sessionId: candidate.sessionId, intent: continuation }); }
      catch { return frozen({ status: "checkpoint_retryable", code: "CHECKPOINT_PENDING_COMMAND_CUSTODY_RETRYABLE", sessionId: candidate.sessionId, pauseGeneration: candidate.pauseGeneration }); }
    }

    try {
      if (this.#failpoint === "before_commit") { this.#failpoint = undefined; throw new Error("CHECKPOINT_BEFORE_COMMIT_FAULT"); }
      await this.options.store.transact(candidate.accountId, (transaction) => transaction.commitDeadlineCheckpoint({
        accountId: candidate.accountId,
        sessionId: candidate.sessionId,
        pauseGeneration: candidate.pauseGeneration,
        checkpointId: sealed.manifest.checkpointId,
        expectedSessionVersion: pause.expectedSessionVersion,
        expectedArtifactVersion: continuation.expectedArtifactVersion,
        manifestReference: `checkpoint-manifest:${sealed.manifest.checkpointId}:${sealed.envelope.manifestSha256}`,
        objectKey: sealed.envelope.object.key,
        objectGeneration: sealed.envelope.object.generation.toString(10),
        objectChecksum: sealed.envelope.object.checksum,
        keyReference: sealed.envelope.crypto.keyReference,
        compatibilityIdentity: continuation.toolchainId,
        checkpointCommittedAtMs: Date.parse(sealed.manifest.committedAt),
      }));
      if (this.#failpoint === "after_commit") { this.#failpoint = undefined; throw new Error("CHECKPOINT_AFTER_COMMIT_FAULT"); }
    } catch {
      return frozen({ status: "checkpoint_retryable", code: "CHECKPOINT_COMMIT_RETRYABLE", sessionId: candidate.sessionId, pauseGeneration: candidate.pauseGeneration });
    }

    try {
      if (initialPending) await this.options.initialPending!.release(pause);
      else {
        const terminated = await this.options.worker.terminateCheckpoint({ ...binding, checkpointId: sealed.manifest.checkpointId } as CheckpointTerminationRequest);
        if (terminated.status !== "terminated") throw new Error("CHECKPOINT_TERMINATION_NOT_CONFIRMED");
      }
      return frozen({ status: "checkpointed", code: "CHECKPOINT_COMMITTED", sessionId: candidate.sessionId, pauseGeneration: candidate.pauseGeneration, checkpointId: sealed.manifest.checkpointId });
    } catch {
      return frozen({ status: "checkpointed", code: "TERMINATION_RETRYABLE", sessionId: candidate.sessionId, pauseGeneration: candidate.pauseGeneration, checkpointId: sealed.manifest.checkpointId });
    }
  }
}
