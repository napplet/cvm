import { describe, expect, test } from "bun:test";
import { ContinuationDeadlineReconciler } from "../../src/continuity/deadline-reconciler";
import type { CheckpointEnvelopeService } from "../../src/continuity/checkpoint-envelope";
import { accountIdForPrincipal } from "../../src/domain/account-command";
import { readSessionStatus } from "../../src/phase-04/session-status";
import type { ContinuationWorkerPort } from "../../src/phase-02/contracts";
import { TransactionalMemoryFundingStore, type ContinuationFundingStore } from "../../src/persistence/funding-store";

const RETENTION_MS = 2_592_000_000;
const accountId = "account:retention";
const checkpointId = "checkpoint:retention";
const committedAtMs = 1_700_000_000_000;

async function fixture(nowMs: number, options: Readonly<{ failDelete?: boolean }> = {}) {
  const store = new TransactionalMemoryFundingStore();
  await store.transact(accountId, (transaction) => transaction.pauseForFunding({
    accountId, sessionId: "session:retention", admissionReference: "admission:retention", idempotencyKey: "pause:retention",
    fingerprint: "a".repeat(64), pendingFingerprint: "b".repeat(64), expectedSessionVersion: 2, pauseGeneration: 1,
    graceDeadlineMs: committedAtMs - 1, liveLeaseToken: "lease:retention",
    intent: { accountId, sessionId: "session:retention", idempotencyKey: "pause:retention", fingerprint: "b".repeat(64), reference: "pending:retention", actionKind: "revise_session", boundedPayloadHash: "d".repeat(64), expectedSessionVersion: 2, expectedArtifactVersion: 1, policyVersion: "policy:retention", priceCardId: "price:retention", profileId: "profile:retention", toolchainId: "toolchain:retention", actionMaximum: "5", admissionReference: "admission:retention" },
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
  let failDelete = options.failDelete ?? false;
  const envelope = {
    async destroyKey(keyReference: string) { destroyed.push(keyReference); },
    async scheduleDeleteGeneration(reference: unknown) { if (failDelete) throw new Error("OBJECT_DELETE_UNKNOWN"); deletes.push(reference); },
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
  return { store, reconciler, deletes, destroyed, retryDeletion() { failDelete = false; } };
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
    const claim = { accountId, sessionId: "session:retention", checkpointId, idempotencyKey: "resume:retention", fingerprint: "d".repeat(64), pendingFingerprint: "b".repeat(64), expectedCheckpointVersion: 1 as const, expectedSessionVersion: 2, nowMs: committedAtMs + RETENTION_MS - 1, newLeaseToken: "lease:restored", allocationIntentReference: "allocation:retention", actionId: "action:retention", operationId: "operation:retention", actionBudgetReference: "action-budget:retention" };
    await expect(preExpiry.store.transact(accountId, (transaction) => transaction.claimResume(claim))).resolves.toMatchObject({ claimed: true });
    await expect(preExpiry.reconciler.scanRetention()).resolves.toMatchObject([{ status: "claimed" }]);
    expect(preExpiry.destroyed).toEqual([]);

    const atExpiry = await fixture(committedAtMs + RETENTION_MS);
    await expect(atExpiry.reconciler.scanRetention()).resolves.toMatchObject([{ status: "expired" }]);
    await expect(atExpiry.store.transact(accountId, (transaction) => transaction.claimResume({ ...claim, nowMs: committedAtMs + RETENTION_MS }))).rejects.toThrow("CHECKPOINT_EXPIRED");
  });

  test("serializes duplicate reapers and reconciles an unknown exact deletion without reopening the checkpoint", async () => {
    const duplicate = await fixture(committedAtMs + RETENTION_MS);
    const [left, right] = await Promise.all([duplicate.reconciler.scanRetention(), duplicate.reconciler.scanRetention()]);
    expect(left).toMatchObject([{ status: "expired" }]);
    expect(right).toMatchObject([{ status: "expired" }]);
    expect(duplicate.destroyed).toEqual(["key:retention"]);
    expect(duplicate.deletes).toHaveLength(1);

    const unknown = await fixture(committedAtMs + RETENTION_MS, { failDelete: true });
    await expect(unknown.reconciler.scanRetention()).resolves.toMatchObject([{ status: "deletion_pending", code: "RETENTION_DELETE_RECONCILIATION" }]);
    await expect(unknown.store.findDeletionOutcome(checkpointId, "7")).resolves.toMatchObject({ state: "unknown" });
    unknown.retryDeletion();
    await expect(unknown.reconciler.scanRetention()).resolves.toMatchObject([{ status: "expired" }]);
    await expect(unknown.store.findContinuationCheckpointForSession(accountId, "session:retention")).resolves.toMatchObject({ state: "expired" });
    expect(unknown.deletes).toEqual([{ key: "checkpoints/retention", generation: 7, checksum: "c".repeat(64) }]);
  });

  test("projects only owner-safe terminal expiry with no action that can resume or top up", async () => {
    const owner = { pubkey: "ef".repeat(32) };
    const ownerAccountId = await accountIdForPrincipal(owner);
    const continuation = {
      intent: { accountId: ownerAccountId, sessionId: "session:expired", idempotencyKey: "pause:expired", fingerprint: "a".repeat(64), reference: "pending:expired", actionKind: "revise_session" as const, boundedPayloadHash: "b".repeat(64), expectedSessionVersion: 2, expectedArtifactVersion: 1, policyVersion: "policy", priceCardId: "price", profileId: "model", toolchainId: "toolchain", actionMaximum: "5", admissionReference: "admission:expired" },
      result: { status: "needs_top_up" as const, code: "ACTION_AFFORDABILITY_REQUIRED" as const, accountId: ownerAccountId, sessionId: "session:expired", pendingActionReference: "pending:expired", pendingActionFingerprint: "a".repeat(64), pendingActionKind: "revise_session" as const, actionMaximum: "5", requiredAdditionalFunding: "5", requiredCapApproval: "0", settledBalance: "0", availableBalance: "0", remainingCap: "5", graceDeadlineMs: 1, checkpoint: { state: "live_worker" as const, reference: "checkpoint-pending:expired" }, nextRequiredAction: "top_up" as const },
    };
    const store = {
      async sessionStatus() { return { accountId: ownerAccountId, sessionId: "session:expired", version: 2, status: "needs_top_up" as const }; },
      async findContinuationForSession() { return continuation; },
      async findContinuationCheckpointForSession() { return { accountId: ownerAccountId, sessionId: "session:expired", pauseGeneration: 1, checkpointId: "checkpoint:safe", expectedSessionVersion: 2, expectedArtifactVersion: 1, manifestReference: "manifest:secret", objectKey: "object:secret", objectGeneration: "7", objectChecksum: "c".repeat(64), keyReference: "key:secret", compatibilityIdentity: "toolchain", checkpointCommittedAtMs: committedAtMs, retentionDeadlineMs: committedAtMs + RETENTION_MS, state: "expired" as const }; },
      async findDeletionOutcome() { return { checkpointId: "checkpoint:safe", objectGeneration: "7", state: "unknown" as const }; },
      async listMeteredActionsForSession() { return []; },
      async status() { return { accountId: ownerAccountId, unit: "sat" as const, available: "0", held: "0", topUps: [], admissions: [] }; },
      async listBillingLineItems() { return { items: [] }; },
    };
    const result = await readSessionStatus({ store: store as never, cursorSecret: "retention-status-secret", query: { principal: owner, sessionId: "session:expired" } });
    expect(result).toMatchObject({ status: "ok", session: { state: "expired", nextAction: "none", continuation: { status: "expired", checkpoint: { reference: "checkpoint:safe" }, retentionDeadlineMs: committedAtMs + RETENTION_MS, deletionState: "unknown", nextRequiredAction: "none" } } });
    expect(JSON.stringify(result)).not.toMatch(/manifest:secret|object:secret|key:secret|checksum|archive|provider/i);
  });

});
