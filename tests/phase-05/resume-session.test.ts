import { describe, expect, test } from "bun:test";
import { AesGcmCheckpointCrypto, CheckpointEnvelopeService } from "../../src/continuity/checkpoint-envelope";
import { ContinuationService } from "../../src/continuity/continuation-service";
import { DeterministicObjectStore } from "../../src/continuity/object-store";
import { accountIdForPrincipal } from "../../src/domain/account-command";
import { FundingService } from "../../src/funding/funding-service";
import { type ContinuationFundingTransaction, TransactionalMemoryFundingStore } from "../../src/persistence/funding-store";
import type { CheckpointRestoreRequest, CheckpointRestoreResult, ContinuationWorkerPort, WorkerRunRequest, WorkerRunResult } from "../../src/phase-02/contracts";
import { readSessionStatus } from "../../src/phase-04/session-status";
import { MeteredGenerationService } from "../../src/phase-04/metered-generation-service";
import type { LifecycleObservation } from "../../src/telemetry/contracts";

const nowMs = 1_700_000_700_000;
const principal = { pubkey: "cd".repeat(32) };
const pendingFingerprint = "a".repeat(64);
const admissionReference = "admission:resume";

async function digest(value: unknown): Promise<string> {
  const bytes = new TextEncoder().encode(JSON.stringify(value));
  const hash = await crypto.subtle.digest("SHA-256", bytes);
  return [...new Uint8Array(hash)].map((byte) => byte.toString(16).padStart(2, "0")).join("");
}

class ResumeWorker implements ContinuationWorkerPort {
  restores = 0;
  async run(_request: WorkerRunRequest, _signal: AbortSignal): Promise<WorkerRunResult> { throw new Error("resume does not run new worker work"); }
  async fenceCheckpoint(): Promise<never> { throw new Error("not used"); }
  async exportCheckpoint(): Promise<never> { throw new Error("not used"); }
  async terminateCheckpoint(): Promise<never> { throw new Error("not used"); }
  async restoreCheckpoint(_request: CheckpointRestoreRequest): Promise<CheckpointRestoreResult> {
    this.restores += 1;
    return { status: "restored", code: "WORKER_CHECKPOINT_RESTORED", workspaceId: "workspace:resume", workspaceLineage: "workspace:resume" };
  }
}

async function setup(input: Readonly<{ topUp?: boolean; compatible?: boolean; includeAdmissionHold?: boolean; telemetry?: { observe(observation: LifecycleObservation): void } }> = {}) {
  const store = new TransactionalMemoryFundingStore();
  const funding = new FundingService(store);
  const accountId = await accountIdForPrincipal(principal);
  await funding.execute({
    principal, kind: "credit_settlement", idempotencyKey: "credit:initial", policyVersion: "funding-policy-v1", protocolVersion: "funding-contract-v1",
    payload: { settlement: { topUpId: "initial", rail: "lightning", unit: "sat", amount: "3250", externalReference: "external:resume:initial", settlementReference: "settlement:resume:initial", verifiedAt: "2026-08-05T00:00:00.000Z" } },
  });
  await funding.execute({
    principal, kind: "funded_admission", idempotencyKey: "admission:resume", policyVersion: "funding-policy-v1", protocolVersion: "funding-contract-v1",
    payload: { requestedCap: "3250", unit: "sat", capacity: { usable: true, reference: admissionReference } },
  });

  await store.transact(accountId, async (transaction: ContinuationFundingTransaction) => {
    await transaction.pauseForFunding({
      accountId, sessionId: "session:resume", admissionReference, idempotencyKey: "pause:resume", fingerprint: "c".repeat(64), pendingFingerprint,
      expectedSessionVersion: 4, pauseGeneration: 1, graceDeadlineMs: nowMs - 1, liveLeaseToken: "lease:old",
      intent: { accountId, sessionId: "session:resume", idempotencyKey: "pause:resume", fingerprint: pendingFingerprint, reference: "pending:resume", actionKind: "revise_session", boundedPayloadHash: "b".repeat(64), expectedSessionVersion: 4, expectedArtifactVersion: 4, policyVersion: "policy:resume", priceCardId: "price:resume", profileId: "model:resume", toolchainId: "toolchain:resume", actionMaximum: "3250", admissionReference },
      result: { status: "needs_top_up", code: "ACTION_AFFORDABILITY_REQUIRED", accountId, sessionId: "session:resume", pendingActionReference: "pending:resume", pendingActionFingerprint: pendingFingerprint, pendingActionKind: "revise_session", actionMaximum: "3250", requiredAdditionalFunding: "3250", requiredCapApproval: "0", settledBalance: "3250", availableBalance: "0", remainingCap: "3250", graceDeadlineMs: nowMs - 1, checkpoint: { state: "live_worker", reference: "checkpoint-pending:resume" }, nextRequiredAction: "top_up" },
    });
    await transaction.beginDeadlineCheckpoint({ sessionId: "session:resume", pauseGeneration: 1, liveLeaseToken: "lease:old" });
  });

  const envelope = new CheckpointEnvelopeService({ crypto: new AesGcmCheckpointCrypto({ randomValues: (bytes) => bytes.fill(5) }), objectStore: new DeterministicObjectStore(), now: () => "2026-08-05T00:20:00.000Z" });
  const sealed = await envelope.seal({
    checkpointId: "checkpoint:resume", accountId, sessionId: "session:resume", pauseGeneration: 1, sessionVersion: 4, actionVersion: 4, artifactVersion: 4, workspaceVersion: 4, workspaceLineage: "workspace:resume",
    action: { actionId: "action:resume", operationId: "operation:resume", ledgerReference: admissionReference, pendingActionReference: "pending:resume", idempotencyKey: "pause:resume" },
    archive: new TextEncoder().encode("sealed workspace"), inventory: ["harness_state", "workspace", "artifact_lineage", "validation_evidence", "financial_action", "pending_action", "compatibility_metadata"], evidenceSha256: await digest({ evidence: "resume" }),
    compatibility: { policyVersion: "policy:resume", modelIdentity: "model:resume", nappletSdkIdentity: "price:resume", toolchainIdentity: "toolchain:resume" }, retentionUntil: new Date(nowMs + 2_592_000_000).toISOString(),
  });
  await store.transact(accountId, (transaction: ContinuationFundingTransaction) => transaction.commitDeadlineCheckpoint({
    accountId, sessionId: "session:resume", pauseGeneration: 1, checkpointId: "checkpoint:resume", expectedSessionVersion: 4, expectedArtifactVersion: 4,
    manifestReference: `manifest:${sealed.envelope.manifestSha256}`, objectKey: sealed.envelope.object.key, objectGeneration: sealed.envelope.object.generation.toString(), objectChecksum: sealed.envelope.object.checksum, keyReference: sealed.envelope.crypto.keyReference, compatibilityIdentity: "toolchain:resume", checkpointCommittedAtMs: nowMs,
  }));
  if (input.topUp !== false) {
    await funding.execute({
      principal, kind: "credit_settlement", idempotencyKey: "credit:resume", policyVersion: "funding-policy-v1", protocolVersion: "funding-contract-v1",
      payload: { settlement: { topUpId: "resume", rail: "cashu", unit: "sat", amount: "3250", externalReference: "external:resume:topup", settlementReference: "settlement:resume:topup", verifiedAt: "2026-08-05T00:21:00.000Z" } },
    });
  }

  const worker = new ResumeWorker();
  let allocations = 0;
  const service = new ContinuationService({
    store, clock: { nowMs: () => nowMs }, includeAdmissionHold: input.includeAdmissionHold,
    resume: {
      compatibility: { policyVersion: "policy:resume", profileId: input.compatible === false ? "model:other" : "model:resume", priceCardId: "price:resume", toolchainId: "toolchain:resume" },
      checkpoint: { loadExact: async () => sealed, restore: (material: typeof sealed) => envelope.restore(material.envelope, material.manifest) },
      allocate: async () => { allocations += 1; return { status: "allocated" as const, worker }; },
    },
    telemetry: input.telemetry,
  });
  const command = { principal: { id: accountId }, sessionId: "session:resume", checkpointId: "checkpoint:resume", expectedSessionVersion: 4, expectedCheckpointVersion: 1, idempotencyKey: "resume:one", approvePendingAction: true, capApprovalReference: admissionReference, pendingAction: { reference: "pending:resume", fingerprint: pendingFingerprint, kind: "revise_session", maximum: "3250" } };
  const resume = (overrides: Record<string, unknown> = {}) => service.resumeSession({ ...command, ...overrides });
  return { accountId, allocations: () => allocations, command, principal, resume, service, store, worker, funding };
}

describe("explicit post-grace resume", () => {
  test("claims one approved checkpoint, creates one fresh budget and lease, then restores it exactly once", async () => {
    const observations: LifecycleObservation[] = [];
    const fixture = await setup({ telemetry: { observe: (observation) => { observations.push(observation); } } });
    const [first, duplicate, concurrent] = await Promise.all([fixture.resume(), fixture.resume(), fixture.resume()]);
    expect(first).toMatchObject({ status: "restored", checkpointId: "checkpoint:resume", pendingActionReference: "pending:resume" });
    expect(duplicate).toEqual(first);
    expect(concurrent).toEqual(first);
    expect(fixture.allocations()).toBe(1);
    expect(fixture.worker.restores).toBe(1);
    expect(observations).toEqual([expect.objectContaining({ stage: "resume", outcome: "succeeded", correlationDigest: expect.stringMatching(/^sha256:[a-f0-9]{64}$/u) })]);
  });

  test("a later verified credit lets the exact previously denied owner command retry", async () => {
    const fixture = await setup({ topUp: false });
    expect(await fixture.resume()).toMatchObject({ status: "denied", code: "RESUME_BALANCE_INSUFFICIENT" });
    await fixture.funding.execute({
      principal, kind: "credit_settlement", idempotencyKey: "credit:retry", policyVersion: "funding-policy-v1", protocolVersion: "funding-contract-v1",
      payload: { settlement: { topUpId: "retry", rail: "cashu", unit: "sat", amount: "3250", externalReference: "external:resume:retry", settlementReference: "settlement:resume:retry", verifiedAt: "2026-08-05T00:21:00.000Z" } },
    });
    expect(await fixture.resume()).toMatchObject({ status: "restored" });
    expect(fixture.allocations()).toBe(1);
    expect(fixture.worker.restores).toBe(1);
  });

  test("completed replay is bound to the complete consent command", async () => {
    const fixture = await setup();
    const altered = { pendingAction: { ...fixture.command.pendingAction, fingerprint: "d".repeat(64) } };
    const [original, changed] = await Promise.all([fixture.resume(), fixture.resume(altered)]);
    expect(original).toMatchObject({ status: "restored" });
    expect(changed).toMatchObject({ status: "denied", code: "RESUME_PENDING_ACTION_MISMATCH" });
    expect(await fixture.resume(altered)).toMatchObject({ status: "denied", code: "RESUME_PENDING_ACTION_MISMATCH" });
    expect(fixture.allocations()).toBe(1);
    expect(fixture.worker.restores).toBe(1);
  });

  test("an explicitly authorized own admission hold funds the resume budget without an extra credit", async () => {
    const fixture = await setup({ topUp: false, includeAdmissionHold: true });
    expect(await fixture.resume()).toMatchObject({ status: "restored" });
    expect(fixture.allocations()).toBe(1);
    expect(fixture.worker.restores).toBe(1);
    expect(fixture.store.projection(fixture.accountId)).toEqual({ settledAvailable: "3250", held: "3250", unit: "sat" });
  });

  test("denies missing consent, altered pending approval, foreign ownership, insufficient funding, and incompatible pins before effects", async () => {
    const baseline = await setup();
    await expect(baseline.resume({ approvePendingAction: false })).resolves.toMatchObject({ status: "denied" });
    await expect(baseline.resume({ pendingAction: { reference: "pending:resume", fingerprint: "d".repeat(64), kind: "revise_session", maximum: "3250" } })).resolves.toMatchObject({ status: "denied" });
    await expect(baseline.resume({ principal: { id: "account:foreign" } })).resolves.toMatchObject({ status: "denied" });
    expect(baseline.allocations()).toBe(0);
    expect(baseline.worker.restores).toBe(0);

    const unfunded = await setup({ topUp: false });
    await expect(unfunded.resume()).resolves.toMatchObject({ status: "denied", code: "RESUME_BALANCE_INSUFFICIENT" });
    expect(unfunded.allocations()).toBe(0);

    const incompatible = await setup({ compatible: false });
    await expect(incompatible.resume()).resolves.toMatchObject({ status: "denied", code: "RESUME_COMPATIBILITY_DENIED" });
    expect(incompatible.allocations()).toBe(0);
  });

  test("keeps resume capabilities private and retires only the exact lease-bound, durably accounted action", async () => {
    const fixture = await setup();
    const pending = await readSessionStatus({ store: fixture.store, cursorSecret: "resume-status-secret", query: { principal: fixture.principal, sessionId: fixture.command.sessionId } });
    expect(pending).toMatchObject({ status: "ok", session: { state: "active", progress: "waiting_for_dispatch", nextAction: "resume_session", continuation: { status: "resume_required", checkpoint: { reference: "checkpoint:resume" } } } });

    const restored = await fixture.resume() as Record<string, unknown>;
    expect(restored).toMatchObject({ status: "restored", checkpointId: "checkpoint:resume" });
    expect(restored.allocationIntentReference).toBeUndefined();
    expect(restored.actionBudgetReference).toBeUndefined();
    expect(restored.leaseToken).toBeUndefined();
    const claim = (await fixture.store.findContinuationCheckpoint(fixture.accountId, "checkpoint:resume"))?.claim;
    if (!claim) throw new Error("expected durable coordinator claim");
    const running = await readSessionStatus({ store: fixture.store, cursorSecret: "resume-status-secret", query: { principal: fixture.principal, sessionId: fixture.command.sessionId } });
    expect(running).toMatchObject({ status: "ok", session: { state: "active", progress: "running", nextAction: "wait_for_current_action", continuation: { status: "restored", checkpoint: { reference: "checkpoint:resume" } } } });

    const coordinator = new MeteredGenerationService({ fundedAdmission: {} as never, store: fixture.store, gateway: {} as never, worker: {} as never, artifactVerifier: {} as never, continuation: fixture.service });
    const completion = {
      accountId: fixture.accountId, checkpointId: "checkpoint:resume", allocationIntentReference: claim.allocationIntentReference,
      leaseToken: claim.leaseToken, actionId: claim.actionId, operationId: claim.operationId,
      finalization: {
        idempotencyKey: "continuation-resume:checkpoint:resume:resume:one", operationId: claim.operationId, receiptCharge: "0", providerReceiptReference: "receipt:resume:one", status: "completed" as const,
        result: { status: "completed", code: "ACTION_COMMITTED", accountId: fixture.accountId, sessionId: "session:resume", sessionVersion: 5, artifactVersion: 5, confirmedSpend: "untrusted", remainingCap: "untrusted", remainingBalance: "untrusted", nextAction: "revise_session", operationId: claim.operationId },
        sessionVersion: 5, artifactVersion: 5,
        artifact: { artifactId: "artifact:resume:five", workspaceLineage: "workspace:resume", checkpointReference: "checkpoint:resume", snapshotReference: "snapshot:resume:five", validationEvidenceReference: "evidence:resume:five" },
      },
    };
    await expect(coordinator.completeResumedAction({ ...completion, leaseToken: "lease:forged" })).rejects.toThrow("RESUMED_ACTION_FENCE_INVALID");
    await expect(coordinator.completeResumedAction({ ...completion, operationId: "operation:forged" })).rejects.toThrow("RESUMED_ACTION_FENCE_INVALID");
    await expect(coordinator.completeResumedAction(({ ...completion, finalization: undefined } as unknown) as typeof completion)).rejects.toThrow("RESUMED_ACTION_ACCOUNTING_INVALID");
    expect(await fixture.store.transact(fixture.accountId, (tx: ContinuationFundingTransaction) => tx.findContinuationPause("session:resume", 1))).toMatchObject({ state: "restored" });

    await coordinator.completeResumedAction(completion);
    await coordinator.completeResumedAction(completion);
    await expect(coordinator.completeResumedAction({ ...completion, finalization: { ...completion.finalization, providerReceiptReference: "receipt:resume:conflict" } })).rejects.toThrow("METERED_FINALIZATION_IDENTITY_CONFLICT");
    await expect(coordinator.completeResumedAction({ ...completion, finalization: { ...completion.finalization, sessionVersion: 6 } })).rejects.toThrow("METERED_FINALIZATION_IDENTITY_CONFLICT");
    expect(await fixture.store.transact(fixture.accountId, (tx: ContinuationFundingTransaction) => tx.findContinuationPause("session:resume", 1))).toMatchObject({ state: "completed", liveLeaseToken: undefined });
    const terminal = await readSessionStatus({ store: fixture.store, cursorSecret: "resume-status-secret", query: { principal: fixture.principal, sessionId: fixture.command.sessionId } });
    expect(terminal).toMatchObject({ status: "ok", session: { state: "verified", progress: "verified", nextAction: "revise_session", continuation: null } });
    const completedCheckpoint = await fixture.store.findContinuationCheckpoint(fixture.accountId, "checkpoint:resume");
    if (!completedCheckpoint) throw new Error("COMPLETED_CHECKPOINT_REQUIRED");
    const savedAction = await fixture.store.findMeteredAction(fixture.accountId, completion.finalization.idempotencyKey);
    await expect(fixture.store.transact(fixture.accountId, (tx: ContinuationFundingTransaction) => tx.tombstoneExpiredCheckpoint({
      checkpointId: completedCheckpoint.checkpointId, nowMs: completedCheckpoint.retentionDeadlineMs - 1 }))).rejects.toThrow("CHECKPOINT_RETENTION_ACTIVE");
    for (let replay = 0; replay < 2; replay++) {
      expect((await fixture.store.transact(fixture.accountId, (tx: ContinuationFundingTransaction) => tx.tombstoneExpiredCheckpoint({
        checkpointId: completedCheckpoint.checkpointId, nowMs: completedCheckpoint.retentionDeadlineMs }))).state).toBe("expired");
    }
    expect(await fixture.store.findMeteredAction(fixture.accountId, completion.finalization.idempotencyKey)).toEqual(savedAction);
    expect(await fixture.store.transact(fixture.accountId, (tx: ContinuationFundingTransaction) => tx.findContinuationPause("session:resume", 1))).toMatchObject({ state: "completed", liveLeaseToken: undefined });
  });
});
