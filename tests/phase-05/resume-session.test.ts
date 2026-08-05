import { describe, expect, test } from "bun:test";
import { AesGcmCheckpointCrypto, CheckpointEnvelopeService } from "../../src/continuity/checkpoint-envelope";
import { ContinuationService } from "../../src/continuity/continuation-service";
import { DeterministicObjectStore } from "../../src/continuity/object-store";
import { accountIdForPrincipal } from "../../src/domain/account-command";
import { FundingService } from "../../src/funding/funding-service";
import { TransactionalMemoryFundingStore } from "../../src/persistence/funding-store";
import type { CheckpointRestoreRequest, CheckpointRestoreResult, ContinuationWorkerPort, WorkerRunRequest, WorkerRunResult } from "../../src/phase-02/contracts";

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

async function setup(input: Readonly<{ topUp?: boolean; compatible?: boolean }> = {}) {
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

  await store.transact(accountId, async (transaction) => {
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
  await store.transact(accountId, (transaction) => transaction.commitDeadlineCheckpoint({
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
    store, clock: { nowMs: () => nowMs },
    resume: {
      compatibility: { policyVersion: "policy:resume", profileId: input.compatible === false ? "model:other" : "model:resume", priceCardId: "price:resume", toolchainId: "toolchain:resume" },
      checkpoint: { loadExact: async () => sealed, restore: (material: typeof sealed) => envelope.restore(material.envelope, material.manifest) },
      allocate: async () => { allocations += 1; return { status: "allocated" as const, worker }; },
    },
  } as never);
  const command = { principal: { id: accountId }, sessionId: "session:resume", checkpointId: "checkpoint:resume", expectedSessionVersion: 4, expectedCheckpointVersion: 1, idempotencyKey: "resume:one", approvePendingAction: true, capApprovalReference: admissionReference, pendingAction: { reference: "pending:resume", fingerprint: pendingFingerprint, kind: "revise_session", maximum: "3250" } };
  const resume = (overrides: Record<string, unknown> = {}) => (service as unknown as { resumeSession(input: unknown): Promise<unknown> }).resumeSession({ ...command, ...overrides });
  return { allocations: () => allocations, command, resume, store, worker };
}

describe("explicit post-grace resume", () => {
  test("claims one approved checkpoint, creates one fresh budget and lease, then restores it exactly once", async () => {
    const fixture = await setup();
    const [first, duplicate, concurrent] = await Promise.all([fixture.resume(), fixture.resume(), fixture.resume()]);
    expect(first).toMatchObject({ status: "restored", checkpointId: "checkpoint:resume", pendingActionReference: "pending:resume" });
    expect(duplicate).toEqual(first);
    expect(concurrent).toEqual(first);
    expect(fixture.allocations()).toBe(1);
    expect(fixture.worker.restores).toBe(1);
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
});
