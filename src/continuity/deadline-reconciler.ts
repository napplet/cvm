import { CheckpointEnvelopeService } from "./checkpoint-envelope";
import type { ContinuationFundingStore } from "../persistence/funding-store";
import {
  CheckpointProposalSchema,
  type CheckpointExportRequest,
  type CheckpointTerminationRequest,
  type ContinuationWorkerPort,
} from "../phase-02/contracts";

const RETENTION_MS = 2_592_000_000;

function frozen<T>(value: T): T { return Object.freeze(value); }

export type DeadlineCandidate = Readonly<{ accountId: string; sessionId: string; pauseGeneration: number; liveLeaseToken: string }>;
export type DeadlineReconcileResult = Readonly<{
  status: "not_due" | "checkpointed" | "checkpoint_retryable" | "already_checkpointed";
  code: string;
  sessionId: string;
  pauseGeneration: number;
  checkpointId?: string;
}>;

/** The scheduling adapter supplies durable pause candidates; no queue or worker allocation is introduced here. */
export interface DeadlineCandidatePort {
  listDue(nowMs: number): Promise<readonly DeadlineCandidate[]>;
}

/**
 * Reconciles a fixed grace deadline with three failure-independent systems.
 * A ciphertext object may precede the SQL commit, but it has no authority until
 * commitDeadlineCheckpoint atomically records its identity and revokes the
 * live lease. Worker termination is deliberately the final idempotent step.
 */
export class ContinuationDeadlineReconciler {
  #failpoint?: "before_commit" | "after_commit";

  constructor(private readonly options: Readonly<{
    store: ContinuationFundingStore;
    worker: ContinuationWorkerPort;
    envelope: CheckpointEnvelopeService;
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

  private async reconcile(candidate: DeadlineCandidate, nowMs: number): Promise<DeadlineReconcileResult> {
    const existing = await this.options.store.transact(candidate.accountId, (transaction) => transaction.findContinuationPause(candidate.sessionId, candidate.pauseGeneration));
    if (!existing || existing.liveLeaseToken !== candidate.liveLeaseToken) return frozen({ status: "already_checkpointed", code: "LIVE_LEASE_ALREADY_FENCED", sessionId: candidate.sessionId, pauseGeneration: candidate.pauseGeneration });
    if (nowMs < existing.graceDeadlineMs) return frozen({ status: "not_due", code: "GRACE_DEADLINE_PENDING", sessionId: candidate.sessionId, pauseGeneration: candidate.pauseGeneration });
    if (existing.state === "resume_required" || existing.state === "claimed" || existing.state === "expired") return frozen({ status: "already_checkpointed", code: "CHECKPOINT_ALREADY_COMMITTED", sessionId: candidate.sessionId, pauseGeneration: candidate.pauseGeneration });

    let pause: typeof existing;
    try {
      pause = await this.options.store.transact(candidate.accountId, (transaction) => transaction.beginDeadlineCheckpoint({ sessionId: candidate.sessionId, pauseGeneration: candidate.pauseGeneration, liveLeaseToken: candidate.liveLeaseToken }));
    } catch {
      return frozen({ status: "checkpoint_retryable", code: "CHECKPOINT_CLAIM_RETRYABLE", sessionId: candidate.sessionId, pauseGeneration: candidate.pauseGeneration });
    }

    const continuation = await this.options.store.findContinuationForSession(candidate.accountId, candidate.sessionId);
    if (!continuation || continuation.intent.fingerprint !== pause.pendingFingerprint) return frozen({ status: "checkpoint_retryable", code: "CHECKPOINT_LINEAGE_RETRYABLE", sessionId: candidate.sessionId, pauseGeneration: candidate.pauseGeneration });

    const binding = {
      accountId: candidate.accountId,
      sessionId: candidate.sessionId,
      actionId: `action:${continuation.intent.reference}`,
      expectedVersion: pause.expectedSessionVersion,
      policyVersion: continuation.intent.policyVersion,
      capabilityGrant: "phase-05-continuation-grant",
      workspaceId: `workspace:${candidate.sessionId}`,
      checkpointId: `checkpoint:${candidate.sessionId}:${candidate.pauseGeneration}`,
      pauseGeneration: candidate.pauseGeneration,
      actionVersion: pause.expectedSessionVersion,
      workspaceLineage: `workspace:${candidate.sessionId}`,
      leaseToken: candidate.liveLeaseToken,
    };

    const exported = await this.options.worker.exportCheckpoint(binding as CheckpointExportRequest);
    if (exported.status !== "exported") return frozen({ status: "checkpoint_retryable", code: "CHECKPOINT_EXPORT_DENIED", sessionId: candidate.sessionId, pauseGeneration: candidate.pauseGeneration });

    let sealed: Awaited<ReturnType<CheckpointEnvelopeService["seal"]>>;
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
        artifactVersion: continuation.intent.expectedArtifactVersion,
        workspaceVersion: pause.expectedSessionVersion,
        workspaceLineage: binding.workspaceLineage,
        action: { actionId: binding.actionId, operationId: `operation:${continuation.intent.reference}`, ledgerReference: pause.admissionReference, pendingActionReference: continuation.intent.reference, idempotencyKey: continuation.intent.idempotencyKey },
        archive,
        inventory: proposal.inventory,
        evidenceSha256: proposal.evidenceSha256,
        compatibility: { policyVersion: continuation.intent.policyVersion, modelIdentity: continuation.intent.profileId, nappletSdkIdentity: continuation.intent.priceCardId, toolchainIdentity: continuation.intent.toolchainId },
        retentionUntil: new Date(nowMs + RETENTION_MS).toISOString(),
      });
    } catch {
      return frozen({ status: "checkpoint_retryable", code: "CHECKPOINT_SEAL_RETRYABLE", sessionId: candidate.sessionId, pauseGeneration: candidate.pauseGeneration });
    }

    try {
      if (this.#failpoint === "before_commit") { this.#failpoint = undefined; throw new Error("CHECKPOINT_BEFORE_COMMIT_FAULT"); }
      await this.options.store.transact(candidate.accountId, (transaction) => transaction.commitDeadlineCheckpoint({
        accountId: candidate.accountId,
        sessionId: candidate.sessionId,
        pauseGeneration: candidate.pauseGeneration,
        checkpointId: sealed.manifest.checkpointId,
        expectedSessionVersion: pause.expectedSessionVersion,
        expectedArtifactVersion: continuation.intent.expectedArtifactVersion,
        manifestReference: `checkpoint-manifest:${sealed.manifest.checkpointId}:${sealed.envelope.manifestSha256}`,
        objectKey: sealed.envelope.object.key,
        objectGeneration: sealed.envelope.object.generation.toString(10),
        objectChecksum: sealed.envelope.object.checksum,
        keyReference: sealed.envelope.crypto.keyReference,
        compatibilityIdentity: continuation.intent.toolchainId,
        checkpointCommittedAtMs: nowMs,
      }));
      if (this.#failpoint === "after_commit") { this.#failpoint = undefined; throw new Error("CHECKPOINT_AFTER_COMMIT_FAULT"); }
    } catch {
      return frozen({ status: "checkpoint_retryable", code: "CHECKPOINT_COMMIT_RETRYABLE", sessionId: candidate.sessionId, pauseGeneration: candidate.pauseGeneration });
    }

    try {
      await this.options.worker.terminateCheckpoint({ ...binding, checkpointId: sealed.manifest.checkpointId } as CheckpointTerminationRequest);
      return frozen({ status: "checkpointed", code: "CHECKPOINT_COMMITTED", sessionId: candidate.sessionId, pauseGeneration: candidate.pauseGeneration, checkpointId: sealed.manifest.checkpointId });
    } catch {
      return frozen({ status: "checkpointed", code: "TERMINATION_RETRYABLE", sessionId: candidate.sessionId, pauseGeneration: candidate.pauseGeneration, checkpointId: sealed.manifest.checkpointId });
    }
  }
}
