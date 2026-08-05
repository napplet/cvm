import { describe, expect, test } from "bun:test";
import { AesGcmCheckpointCrypto, CheckpointEnvelopeService } from "../../src/continuity/checkpoint-envelope";
import { ContinuationDeadlineReconciler } from "../../src/continuity/deadline-reconciler";
import { DeterministicObjectStore } from "../../src/continuity/object-store";
import { ContinuationService } from "../../src/continuity/continuation-service";
import { accountIdForPrincipal } from "../../src/domain/account-command";
import { FundingService } from "../../src/funding/funding-service";
import { TransactionalMemoryFundingStore } from "../../src/persistence/funding-store";
import type { CheckpointExportRequest, CheckpointExportResult, CheckpointProposal, CheckpointTerminationRequest, CheckpointTerminationResult, ContinuationWorkerPort, WorkerRunRequest, WorkerRunResult } from "../../src/phase-02/contracts";

const principal = { pubkey: "ab".repeat(32) };
const deadlineMs = 1_700_000_600_000;
const leaseToken = "lease:deadline-worker";
const inventory = ["harness_state", "workspace", "artifact_lineage", "validation_evidence", "financial_action", "pending_action", "compatibility_metadata"];

async function digest(value: Uint8Array | unknown): Promise<string> {
  const bytes = value instanceof Uint8Array ? value : new TextEncoder().encode(JSON.stringify(value));
  const hash = await crypto.subtle.digest("SHA-256", bytes);
  return [...new Uint8Array(hash)].map((byte) => byte.toString(16).padStart(2, "0")).join("");
}

class DeadlineWorker implements ContinuationWorkerPort {
  exports = 0;
  terminations = 0;
  invalid = false;
  terminateFailure = false;
  constructor(private readonly proposal: CheckpointProposal, private readonly onTerminate: () => Promise<void>) {}
  async run(_request: WorkerRunRequest, _signal: AbortSignal): Promise<WorkerRunResult> { throw new Error("deadline reconciliation never runs new worker work"); }
  async exportCheckpoint(_request: CheckpointExportRequest): Promise<CheckpointExportResult> {
    this.exports += 1;
    return this.invalid ? { status: "denied", code: "WORKER_CONTINUATION_DENIED" } : { status: "exported", code: "WORKER_CHECKPOINT_EXPORTED", proposal: this.proposal };
  }
  async restoreCheckpoint(): Promise<never> { throw new Error("not used"); }
  async terminateCheckpoint(_request: CheckpointTerminationRequest): Promise<CheckpointTerminationResult> {
    this.terminations += 1;
    await this.onTerminate();
    if (this.terminateFailure) throw new Error("TERMINATION_UNAVAILABLE");
    return { status: "terminated", code: "WORKER_LEASE_TERMINATED" };
  }
}

async function setup(nowMs = deadlineMs) {
  const store = new TransactionalMemoryFundingStore();
  const accountId = await accountIdForPrincipal(principal);
  const funding = new FundingService(store);
  await funding.execute({ principal, kind: "credit_settlement", idempotencyKey: "initial-credit", policyVersion: "funding-policy-v1", protocolVersion: "funding-contract-v1", payload: { settlement: { topUpId: "initial", rail: "lightning", unit: "sat", amount: "3250", externalReference: "external:initial", settlementReference: "settlement:initial", verifiedAt: "2026-08-05T00:00:00.000Z" } } });
  await funding.execute({ principal, kind: "funded_admission", idempotencyKey: "admission", policyVersion: "funding-policy-v1", protocolVersion: "funding-contract-v1", payload: { requestedCap: "3250", unit: "sat", capacity: { usable: true, reference: "admission:deadline" } } });
  const continuation = new ContinuationService({ store, clock: { nowMs: () => deadlineMs - 1 } });
  await continuation.pauseForFunding({ intent: { accountId, sessionId: "session:deadline", idempotencyKey: "pause:deadline", fingerprint: "a".repeat(64), reference: "pending:deadline", actionKind: "revise_session", boundedPayloadHash: "b".repeat(64), expectedSessionVersion: 4, expectedArtifactVersion: 4, policyVersion: "policy:deadline", priceCardId: "price:deadline", profileId: "model:deadline", toolchainId: "toolchain:deadline", actionMaximum: "3250", admissionReference: "admission:deadline" } });
  await store.transact(accountId, (transaction) => transaction.pauseForFunding({ accountId, sessionId: "session:deadline", admissionReference: "admission:deadline", idempotencyKey: "pause:deadline", fingerprint: "c".repeat(64), pendingFingerprint: "a".repeat(64), expectedSessionVersion: 4, pauseGeneration: 1, graceDeadlineMs: deadlineMs, liveLeaseToken: leaseToken, result: { status: "needs_top_up", code: "ACTION_AFFORDABILITY_REQUIRED", accountId, sessionId: "session:deadline", pendingActionReference: "pending:deadline", pendingActionFingerprint: "a".repeat(64), pendingActionKind: "revise_session", actionMaximum: "3250", requiredAdditionalFunding: "3250", requiredCapApproval: "0", settledBalance: "3250", availableBalance: "0", remainingCap: "3250", graceDeadlineMs: deadlineMs, checkpoint: { state: "live_worker", reference: "checkpoint-pending:deadline" }, nextRequiredAction: "top_up" } }));
  const archive = new TextEncoder().encode("complete durable workspace");
  const proposal: CheckpointProposal = { sessionId: "session:deadline", actionId: "action:pending:deadline", expectedVersion: 4, policyVersion: "policy:deadline", capabilityGrant: "phase-05-continuation-grant", workspaceId: "workspace:session:deadline", checkpointId: "checkpoint:deadline", formatVersion: "portable-checkpoint-v1", inventory, archiveBase64: Buffer.from(archive).toString("base64"), archiveSha256: await digest(archive), evidenceSha256: await digest({ evidence: "checkpoint" }), inventorySha256: await digest(inventory) };
  let pauseAfterTermination: unknown;
  const worker = new DeadlineWorker(proposal, async () => { pauseAfterTermination = await store.transact(accountId, (transaction) => transaction.findContinuationPause("session:deadline", 1)); });
  const objects = new DeterministicObjectStore();
  const envelope = new CheckpointEnvelopeService({ crypto: new AesGcmCheckpointCrypto({ randomValues: (bytes) => bytes.fill(7) }), objectStore: objects, now: () => "2026-08-05T00:10:00.000Z" });
  const reconciler = new ContinuationDeadlineReconciler({ store, worker, envelope, clock: { nowMs: () => nowMs }, candidates: { listDue: async () => [{ accountId, sessionId: "session:deadline", pauseGeneration: 1, liveLeaseToken: leaseToken }] } });
  return { accountId, envelope, objects, pauseAfterTermination: () => pauseAfterTermination, reconciler, store, worker };
}

describe("fixed-deadline checkpoint reconciliation", () => {
  test("does no checkpoint work before the deadline, then seals, commits lease revocation, and terminates once", async () => {
    const before = await setup(deadlineMs - 1);
    await expect(before.reconciler.scan()).resolves.toEqual([{ status: "not_due", code: "GRACE_DEADLINE_PENDING", sessionId: "session:deadline", pauseGeneration: 1 }]);
    expect(before.worker.exports).toBe(0);
    expect(before.worker.terminations).toBe(0);

    const at = await setup();
    await expect(at.reconciler.scan()).resolves.toMatchObject([{ status: "checkpointed", checkpointId: "checkpoint:deadline" }]);
    expect(at.worker.exports).toBe(1);
    expect(at.worker.terminations).toBe(1);
    expect(at.objects.entries()).toHaveLength(1);
    expect(at.pauseAfterTermination()).toMatchObject({ state: "resume_required", liveLeaseToken: undefined });
    await expect(at.reconciler.scan()).resolves.toMatchObject([{ status: "already_checkpointed" }]);
    expect(at.worker.terminations).toBe(1);
  });

  test("keeps the live lease for invalid proposal and pre-commit failure, while a post-commit termination loss leaves it fenced", async () => {
    const invalid = await setup();
    invalid.worker.invalid = true;
    await expect(invalid.reconciler.scan()).resolves.toMatchObject([{ status: "checkpoint_retryable", code: "CHECKPOINT_EXPORT_DENIED" }]);
    const invalidPause = await invalid.store.transact(invalid.accountId, (transaction) => transaction.findContinuationPause("session:deadline", 1));
    expect(invalidPause).toMatchObject({ state: "checkpointing", liveLeaseToken: leaseToken });
    expect(invalid.worker.terminations).toBe(0);

    const preCommit = await setup();
    preCommit.reconciler.failNext("before_commit");
    await expect(preCommit.reconciler.scan()).resolves.toMatchObject([{ status: "checkpoint_retryable", code: "CHECKPOINT_COMMIT_RETRYABLE" }]);
    const preCommitPause = await preCommit.store.transact(preCommit.accountId, (transaction) => transaction.findContinuationPause("session:deadline", 1));
    expect(preCommit.objects.entries()).toHaveLength(1);
    expect(preCommitPause).toMatchObject({ state: "checkpointing", liveLeaseToken: leaseToken });
    expect(preCommit.worker.terminations).toBe(0);

    const postCommit = await setup();
    postCommit.worker.terminateFailure = true;
    await expect(postCommit.reconciler.scan()).resolves.toMatchObject([{ status: "checkpointed", code: "TERMINATION_RETRYABLE" }]);
    const postCommitPause = await postCommit.store.transact(postCommit.accountId, (transaction) => transaction.findContinuationPause("session:deadline", 1));
    expect(postCommitPause).toMatchObject({ state: "resume_required", liveLeaseToken: undefined });
  });
});
