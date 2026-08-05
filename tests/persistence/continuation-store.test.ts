import { describe, expect, test } from "bun:test";
import { TransactionalMemoryFundingStore, type ContinuationCheckpointInput, type ContinuationPauseInput, type ContinuationResumeClaimInput } from "../../src/persistence/funding-store";

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
  result: { status: "needs_top_up", sessionId: "session:one", pendingAction: "revision", pendingFingerprint: "b".repeat(64), additionalFunding: "1", remainingCap: "5", availableBalance: "0", graceDeadline: new Date(1_600).toISOString() },
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
    const first = await store.transact(accountId, (tx) => tx.pauseForFunding(pause()));
    const replay = await store.transact(accountId, (tx) => tx.pauseForFunding(pause()));
    expect(replay).toEqual(first);
    await expect(store.transact(accountId, (tx) => tx.pauseForFunding(pause({ fingerprint: "e".repeat(64) })))).rejects.toThrow("IDEMPOTENCY_KEY_CONFLICT");
  });

  test("commits a checkpoint while revoking the live lease, then elects one resume claim", async () => {
    const store = new TransactionalMemoryFundingStore();
    await store.transact(accountId, (tx) => tx.pauseForFunding(pause()));
    const committed = await store.transact(accountId, async (tx) => {
      await tx.beginDeadlineCheckpoint({ sessionId: "session:one", pauseGeneration: 1, liveLeaseToken: "lease:live" });
      return tx.commitDeadlineCheckpoint(checkpoint());
    });
    expect(committed.state).toBe("resume_required");
    expect(committed.liveLeaseToken).toBeUndefined();

    const [left, right] = await Promise.all([
      store.transact(accountId, (tx) => tx.claimResume(claim())),
      store.transact(accountId, (tx) => tx.claimResume(claim())),
    ]);
    expect(left).toEqual(right);
    expect(left.claimed).toBeTrue();
    expect(left.leaseToken).toBe("lease:restored");
  });

  test("makes expiry terminal at the exact retention deadline while preserving a pre-expiry claim", async () => {
    const store = new TransactionalMemoryFundingStore();
    await store.transact(accountId, (tx) => tx.pauseForFunding(pause()));
    await store.transact(accountId, async (tx) => { await tx.beginDeadlineCheckpoint({ sessionId: "session:one", pauseGeneration: 1, liveLeaseToken: "lease:live" }); return tx.commitDeadlineCheckpoint(checkpoint()); });
    const retentionDeadlineMs = 2_000 + 2_592_000_000;
    const claimed = await store.transact(accountId, (tx) => tx.claimResume(claim({ nowMs: retentionDeadlineMs - 1 })));
    expect(claimed.claimed).toBeTrue();
    expect((await store.transact(accountId, (tx) => tx.tombstoneExpiredCheckpoint({ checkpointId: "checkpoint:one", nowMs: retentionDeadlineMs }))).state).toBe("claimed");

    const expired = new TransactionalMemoryFundingStore();
    await expired.transact(accountId, (tx) => tx.pauseForFunding(pause()));
    await expired.transact(accountId, async (tx) => { await tx.beginDeadlineCheckpoint({ sessionId: "session:one", pauseGeneration: 1, liveLeaseToken: "lease:live" }); return tx.commitDeadlineCheckpoint(checkpoint()); });
    expect((await expired.transact(accountId, (tx) => tx.tombstoneExpiredCheckpoint({ checkpointId: "checkpoint:one", nowMs: retentionDeadlineMs }))).state).toBe("expired");
    await expect(expired.transact(accountId, (tx) => tx.claimResume(claim({ nowMs: retentionDeadlineMs })))).rejects.toThrow("CHECKPOINT_EXPIRED");
  });
});
