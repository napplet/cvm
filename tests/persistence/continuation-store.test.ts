import { describe, expect, test } from "bun:test";
import { TransactionalMemoryFundingStore, type ContinuationCheckpointInput, type ContinuationFundingStore, type ContinuationPauseInput, type ContinuationResumeClaimInput } from "../../src/persistence/funding-store";

const accountId = "account:continuation";
const pause = (overrides: Partial<ContinuationPauseInput> = {}): ContinuationPauseInput => ({
  accountId,
  sessionId: "session:one",
  admissionReference: "admission:one",
  idempotencyKey: "pause:one",
  fingerprint: "a".repeat(64),
  pendingFingerprint: "b".repeat(64),
  expectedSessionVersion: 3,
  pauseGeneration: 1,
  graceDeadlineMs: 1_600,
  liveLeaseToken: "lease:live",
  intent: { accountId, sessionId: "session:one", idempotencyKey: "pause:one", fingerprint: "b".repeat(64), reference: "pending:one", actionKind: "revise_session", boundedPayloadHash: "f".repeat(64), expectedSessionVersion: 3, expectedArtifactVersion: 2, policyVersion: "policy:one", priceCardId: "price:one", profileId: "profile:one", toolchainId: "toolchain:one", actionMaximum: "5", admissionReference: "admission:one" },
  result: { status: "needs_top_up", code: "ACTION_AFFORDABILITY_REQUIRED", accountId, sessionId: "session:one", pendingActionReference: "pending:one", pendingActionFingerprint: "b".repeat(64), pendingActionKind: "revise_session", actionMaximum: "5", requiredAdditionalFunding: "1", requiredCapApproval: "0", settledBalance: "0", availableBalance: "0", remainingCap: "5", graceDeadlineMs: 1_600, checkpoint: { state: "live_worker", reference: "lease:live" }, nextRequiredAction: "top_up" },
  ...overrides,
});

const checkpoint = (overrides: Partial<ContinuationCheckpointInput> = {}): ContinuationCheckpointInput => ({
  accountId,
  sessionId: "session:one",
  pauseGeneration: 1,
  checkpointId: "checkpoint:one",
  expectedSessionVersion: 3,
  expectedArtifactVersion: 2,
  manifestReference: "manifest:one",
  objectKey: "checkpoint/session-one",
  objectGeneration: "7",
  objectChecksum: "c".repeat(64),
  keyReference: "key:one",
  compatibilityIdentity: "compat:one",
  checkpointCommittedAtMs: 2_000,
  ...overrides,
});

const claim = (overrides: Partial<ContinuationResumeClaimInput> = {}): ContinuationResumeClaimInput => ({
  accountId,
  sessionId: "session:one",
  checkpointId: "checkpoint:one",
  idempotencyKey: "resume:one",
  fingerprint: "d".repeat(64),
  pendingFingerprint: "b".repeat(64),
  expectedCheckpointVersion: 1,
  expectedSessionVersion: 3,
  nowMs: 2_001,
  newLeaseToken: "lease:restored",
  allocationIntentReference: "allocation:one",
  ...overrides,
});

describe("TransactionalMemoryFundingStore continuation authority", () => {
  test("stores one pause generation, replays an exact duplicate, and rejects altered reuse", async () => {
    const store = new TransactionalMemoryFundingStore();
    const continuationStore = store as ContinuationFundingStore;
    const first = await continuationStore.transact(accountId, (tx) => tx.pauseForFunding(pause()));
    const replay = await continuationStore.transact(accountId, (tx) => tx.pauseForFunding(pause()));
    expect(replay).toEqual(first);
    await expect(continuationStore.transact(accountId, (tx) => tx.pauseForFunding(pause({ fingerprint: "e".repeat(64) })))).rejects.toThrow("IDEMPOTENCY_KEY_CONFLICT");
  });

  test("independent coordinators cannot create overlapping live pause generations", async () => {
    const store = new TransactionalMemoryFundingStore();
    const continuationStore = store as ContinuationFundingStore;
    const second = pause({ idempotencyKey: "pause:two", pauseGeneration: 2, fingerprint: "c".repeat(64), pendingFingerprint: "d".repeat(64), intent: { ...pause().intent, idempotencyKey: "pause:two", fingerprint: "d".repeat(64) } });
    const outcomes = await Promise.allSettled([
      continuationStore.transact(accountId, (tx) => tx.pauseForFunding(pause())),
      continuationStore.transact(accountId, (tx) => tx.pauseForFunding(second)),
    ]);
    expect(outcomes.filter((outcome) => outcome.status === "fulfilled")).toHaveLength(1);
    expect(outcomes.find((outcome) => outcome.status === "rejected")).toMatchObject({ reason: expect.objectContaining({ message: "CONTINUATION_PAUSE_ALREADY_ACTIVE" }) });
    expect(await continuationStore.transact(accountId, (tx) => tx.findContinuationPause("session:one", 1))).toMatchObject({ liveLeaseToken: "lease:live", state: "needs_top_up" });
  });

  test("retires a completed wake and allocates the next monotonic pause generation", async () => {
    const store = new TransactionalMemoryFundingStore();
    const continuationStore = store as ContinuationFundingStore;
    await continuationStore.transact(accountId, (tx) => tx.pauseForFunding(pause()));
    const claim = await continuationStore.transact(accountId, async (tx) => {
      await tx.wakePausedAction({ sessionId: "session:one", pauseGeneration: 1, nowMs: 1_000, liveLeaseToken: "lease:live" });
      return tx.claimWakeDispatch({ accountId, sessionId: "session:one", pauseGeneration: 1, pendingFingerprint: "b".repeat(64), expectedSessionVersion: 3, expectedArtifactVersion: 2, actionBudgetReference: "action-budget:wake:one", operationId: "wake-operation:session:one:1", liveLeaseToken: "lease:live" });
    });
    expect(claim.claimed).toBeTrue();
    await continuationStore.transact(accountId, (tx) => tx.recordWakeDispatchOutcome({ sessionId: "session:one", pauseGeneration: 1, claimToken: claim.dispatch.claimToken!, state: "completed" }));
    expect(await continuationStore.transact(accountId, (tx) => tx.nextPauseGeneration("session:one"))).toBe(2);
    const second = pause({ idempotencyKey: "pause:two", pauseGeneration: 2, fingerprint: "c".repeat(64), pendingFingerprint: "d".repeat(64), intent: { ...pause().intent, idempotencyKey: "pause:two", fingerprint: "d".repeat(64) } });
    await expect(continuationStore.transact(accountId, (tx) => tx.pauseForFunding(second))).resolves.toMatchObject({ pauseGeneration: 2, state: "needs_top_up" });
  });

  test("commits a checkpoint while revoking the live lease, then elects one resume claim", async () => {
    const store = new TransactionalMemoryFundingStore();
    const continuationStore = store as ContinuationFundingStore;
    await continuationStore.transact(accountId, (tx) => tx.pauseForFunding(pause()));
    const committed = await continuationStore.transact(accountId, async (tx) => {
      await tx.beginDeadlineCheckpoint({ sessionId: "session:one", pauseGeneration: 1, liveLeaseToken: "lease:live" });
      return tx.commitDeadlineCheckpoint(checkpoint());
    });
    expect(committed.state).toBe("resume_required");
    expect(committed.liveLeaseToken).toBeUndefined();

    const [left, right] = await Promise.all([
      continuationStore.transact(accountId, (tx) => tx.claimResume(claim())),
      continuationStore.transact(accountId, (tx) => tx.claimResume(claim())),
    ]);
    expect(left).toEqual(right);
    expect(left.claimed).toBeTrue();
    expect(left.leaseToken).toBe("lease:restored");
  });

  test("restores then retires a resumed pause before admitting the next monotonic generation", async () => {
    const store = new TransactionalMemoryFundingStore();
    const continuationStore = store as ContinuationFundingStore;
    await continuationStore.transact(accountId, (tx) => tx.pauseForFunding(pause()));
    await continuationStore.transact(accountId, async (tx) => {
      await tx.beginDeadlineCheckpoint({ sessionId: "session:one", pauseGeneration: 1, liveLeaseToken: "lease:live" });
      return tx.commitDeadlineCheckpoint(checkpoint());
    });
    await continuationStore.transact(accountId, (tx) => tx.claimResume(claim()));
    expect(await continuationStore.transact(accountId, (tx) => tx.findContinuationPause("session:one", 1))).toMatchObject({ state: "claimed" });
    await continuationStore.transact(accountId, (tx) => tx.recordRestoreObservation({ checkpointId: "checkpoint:one", allocationIntentReference: "allocation:one", state: "restored" }));
    expect(await continuationStore.transact(accountId, (tx) => tx.findContinuationPause("session:one", 1))).toMatchObject({ state: "restored" });
    const second = pause({ idempotencyKey: "pause:two", pauseGeneration: 2, fingerprint: "c".repeat(64), pendingFingerprint: "d".repeat(64), intent: { ...pause().intent, idempotencyKey: "pause:two", fingerprint: "d".repeat(64) } });
    await expect(continuationStore.transact(accountId, (tx) => tx.pauseForFunding(second))).rejects.toThrow("CONTINUATION_PAUSE_ALREADY_ACTIVE");
    await continuationStore.transact(accountId, (tx) => tx.retireResumedPause({ checkpointId: "checkpoint:one", allocationIntentReference: "allocation:one", terminalActionReference: "action:resumed:one", terminalStatus: "completed" }));
    expect(await continuationStore.transact(accountId, (tx) => tx.nextPauseGeneration("session:one"))).toBe(2);
    await expect(continuationStore.transact(accountId, (tx) => tx.pauseForFunding(second))).resolves.toMatchObject({ state: "needs_top_up", pauseGeneration: 2 });
  });

  test("makes expiry terminal at the exact retention deadline while preserving a pre-expiry claim", async () => {
    const store = new TransactionalMemoryFundingStore();
    const continuationStore = store as ContinuationFundingStore;
    await continuationStore.transact(accountId, (tx) => tx.pauseForFunding(pause()));
    await continuationStore.transact(accountId, async (tx) => { await tx.beginDeadlineCheckpoint({ sessionId: "session:one", pauseGeneration: 1, liveLeaseToken: "lease:live" }); return tx.commitDeadlineCheckpoint(checkpoint()); });
    const retentionDeadlineMs = 2_000 + 2_592_000_000;
    const claimed = await continuationStore.transact(accountId, (tx) => tx.claimResume(claim({ nowMs: retentionDeadlineMs - 1 })));
    expect(claimed.claimed).toBeTrue();
    expect((await continuationStore.transact(accountId, (tx) => tx.tombstoneExpiredCheckpoint({ checkpointId: "checkpoint:one", nowMs: retentionDeadlineMs }))).state).toBe("claimed");

    const expired = new TransactionalMemoryFundingStore();
    const expiredStore = expired as ContinuationFundingStore;
    await expiredStore.transact(accountId, (tx) => tx.pauseForFunding(pause()));
    await expiredStore.transact(accountId, async (tx) => { await tx.beginDeadlineCheckpoint({ sessionId: "session:one", pauseGeneration: 1, liveLeaseToken: "lease:live" }); return tx.commitDeadlineCheckpoint(checkpoint()); });
    expect((await expiredStore.transact(accountId, (tx) => tx.tombstoneExpiredCheckpoint({ checkpointId: "checkpoint:one", nowMs: retentionDeadlineMs }))).state).toBe("expired");
    await expect(expiredStore.transact(accountId, (tx) => tx.claimResume(claim({ nowMs: retentionDeadlineMs })))).rejects.toThrow("CHECKPOINT_EXPIRED");
  });
});
