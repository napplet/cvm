import { describe, expect, test } from "bun:test";
import { ContinuationDeadlineReconciler } from "../../src/continuity/deadline-reconciler";
import type { CheckpointEnvelopeService } from "../../src/continuity/checkpoint-envelope";
import type { ContinuationWorkerPort } from "../../src/phase-02/contracts";
import { TransactionalMemoryFundingStore, type ContinuationFundingStore } from "../../src/persistence/funding-store";

const RETENTION_MS = 2_592_000_000;
const accountId = "account:retention";
const checkpointId = "checkpoint:retention";
const committedAtMs = 1_700_000_000_000;

async function fixture(nowMs: number) {
  const store = new TransactionalMemoryFundingStore() as TransactionalMemoryFundingStore & ContinuationFundingStore;
  await store.transact(accountId, (transaction) => transaction.pauseForFunding({
    accountId, sessionId: "session:retention", admissionReference: "admission:retention", idempotencyKey: "pause:retention",
    fingerprint: "a".repeat(64), pendingFingerprint: "b".repeat(64), expectedSessionVersion: 2, pauseGeneration: 1,
    graceDeadlineMs: committedAtMs - 1, liveLeaseToken: "lease:retention",
    result: { status: "needs_top_up", code: "ACTION_AFFORDABILITY_REQUIRED", accountId, sessionId: "session:retention", pendingActionReference: "pending:retention", pendingActionFingerprint: "b".repeat(64), pendingActionKind: "revise_session", actionMaximum: "5", requiredAdditionalFunding: "5", requiredCapApproval: "0", settledBalance: "0", availableBalance: "0", remainingCap: "5", graceDeadlineMs: committedAtMs - 1, checkpoint: { state: "live_worker", reference: "checkpoint-pending:retention" }, nextRequiredAction: "top_up" },
  }));
  await store.transact(accountId, async (transaction) => {
    await transaction.beginDeadlineCheckpoint({ sessionId: "session:retention", pauseGeneration: 1, liveLeaseToken: "lease:retention" });
    return transaction.commitDeadlineCheckpoint({
      accountId, sessionId: "session:retention", pauseGeneration: 1, checkpointId, expectedSessionVersion: 2, expectedArtifactVersion: 1,
      manifestReference: "manifest:retention", objectKey: "checkpoints/retention", objectGeneration: "7", objectChecksum: "c".repeat(64), keyReference: "key:retention", compatibilityIdentity: "toolchain:retention", checkpointCommittedAtMs: committedAtMs,
    });
  });
  const deletes: unknown[] = [];
  const destroyed: string[] = [];
  const envelope = {
    async destroyKey(keyReference: string) { destroyed.push(keyReference); },
    async scheduleDeleteGeneration(reference: unknown) { deletes.push(reference); },
  } as unknown as CheckpointEnvelopeService;
  const reconciler = new ContinuationDeadlineReconciler({
    store,
    worker: {} as ContinuationWorkerPort,
    envelope,
    candidates: {
      async listDue() { return []; },
      async listRetentionDue() { return [{ accountId, sessionId: "session:retention", pauseGeneration: 1, checkpointId }]; },
    },
    clock: { nowMs: () => nowMs },
  });
  return { store, reconciler, deletes, destroyed };
}

describe("CONT-07 retention expiry", () => {
  test("uses server time exactly: before is inert, deadline tombstones before exact key/object deletion, and replay is idempotent", async () => {
    const before = await fixture(committedAtMs + RETENTION_MS - 1);
    await expect(before.reconciler.scanRetention()).resolves.toMatchObject([{ status: "not_due" }]);
    expect(before.destroyed).toEqual([]);
    expect(before.deletes).toEqual([]);

    const due = await fixture(committedAtMs + RETENTION_MS);
    await expect(due.reconciler.scanRetention()).resolves.toMatchObject([{ status: "expired", checkpointId }]);
    expect(due.destroyed).toEqual(["key:retention"]);
    expect(due.deletes).toEqual([{ key: "checkpoints/retention", generation: 7, checksum: "c".repeat(64) }]);
    await expect(due.reconciler.scanRetention()).resolves.toMatchObject([{ status: "expired" }]);
    expect(due.destroyed).toEqual(["key:retention"]);
    expect(due.deletes).toEqual([{ key: "checkpoints/retention", generation: 7, checksum: "c".repeat(64) }]);
  });

  test("allows only a pre-expiry claim to win and fences claims at the deadline", async () => {
    const preExpiry = await fixture(committedAtMs + RETENTION_MS - 1);
    const claim = { accountId, sessionId: "session:retention", checkpointId, idempotencyKey: "resume:retention", fingerprint: "d".repeat(64), pendingFingerprint: "b".repeat(64), expectedCheckpointVersion: 1 as const, expectedSessionVersion: 2, nowMs: committedAtMs + RETENTION_MS - 1, newLeaseToken: "lease:restored", allocationIntentReference: "allocation:retention" };
    await expect(preExpiry.store.transact(accountId, (transaction) => transaction.claimResume(claim))).resolves.toMatchObject({ claimed: true });
    await expect(preExpiry.reconciler.scanRetention()).resolves.toMatchObject([{ status: "claimed" }]);
    expect(preExpiry.destroyed).toEqual([]);

    const atExpiry = await fixture(committedAtMs + RETENTION_MS);
    await expect(atExpiry.reconciler.scanRetention()).resolves.toMatchObject([{ status: "expired" }]);
    await expect(atExpiry.store.transact(accountId, (transaction) => transaction.claimResume({ ...claim, nowMs: committedAtMs + RETENTION_MS }))).rejects.toThrow("CHECKPOINT_EXPIRED");
  });
});
