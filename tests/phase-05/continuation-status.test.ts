import { describe, expect, test } from "bun:test";
import { accountIdForPrincipal } from "../../src/domain/account-command";
import { FundingService } from "../../src/funding/funding-service";
import { FundedAdmissionService } from "../../src/funding/funded-admission";
import type { ModelGateway } from "../../src/model/model-gateway";
import { TransactionalMemoryFundingStore } from "../../src/persistence/funding-store";
import type { WorkerPort } from "../../src/phase-02/contracts";
import type { ArtifactVerifier } from "../../src/phase-02/trusted-core";
import { MeteredGenerationService } from "../../src/phase-04/metered-generation-service";
import { readSessionStatus } from "../../src/phase-04/session-status";
import { ContinuationService } from "../../src/continuity/continuation-service";
import { exactReadyReservation, trustedAdmissionReceipt, trustedAdmissionReceiptAuthority } from "../fixtures/admission-ready";

const owner = { pubkey: "ab".repeat(32) };
const stranger = { pubkey: "cd".repeat(32) };
const worker: WorkerPort = { async run() { throw new Error("must not run"); } };
const verifier: ArtifactVerifier = { async verify() { throw new Error("must not verify"); } };

async function pausedFixture() {
  const store = new TransactionalMemoryFundingStore();
  const funding = new FundingService(store);
  await funding.execute({ principal: owner, kind: "credit_settlement", idempotencyKey: "status-credit", policyVersion: "funding-policy-v1", protocolVersion: "funding-contract-v1", payload: { settlement: { topUpId: "status-topup", rail: "lightning", unit: "sat", amount: "4000", externalReference: "status-external", settlementReference: "status-settlement", verifiedAt: "2026-08-05T00:00:00.000Z" } } });
  const admissions = new FundedAdmissionService({ funding, store, capacity: { reserveNow: async ({ intentReference }) => exactReadyReservation(intentReference, "status-capacity", "2026-08-06T00:00:00.000Z"), observe: async ({ intentReference }) => exactReadyReservation(intentReference, "status-capacity", "2026-08-06T00:00:00.000Z"), release: async () => {} }, receiptAuthority: trustedAdmissionReceiptAuthority, now: () => Date.parse("2026-08-05T00:00:00.000Z") });
  const command = { principal: owner, idempotencyKey: "status-admission", policyVersion: "funding-policy-v1", protocolVersion: "funding-contract-v1", payload: { requestedCap: "3250", unit: "sat" as const } };
  const admission = await admissions.admit(command, await trustedAdmissionReceipt(command));
  if (admission.status !== "accepted") throw new Error("expected funded admission");
  const gateway: ModelGateway = { async dispatch() { throw new Error("must not dispatch"); }, async lookup() { throw new Error("UNEXPECTED_PROVIDER_LOOKUP"); } };
  const service = new MeteredGenerationService({ fundedAdmission: admissions, store, gateway, worker, artifactVerifier: verifier, clock: { nowMs: () => 1_700_000_000_000 } });
  const paused = await service.startSession({ principal: owner, admissionReference: admission.reference, idempotencyKey: "status-pause", expectedVersion: 0, maximum: "3250", policyVersion: "phase-02-policy-2026-08-04", idea: "Prompt canary: do not expose this text." });
  if (paused.status !== "needs_top_up") throw new Error("expected paused fixture");
  return { store, paused, funding };
}

describe("owner-safe needs_top_up status", () => {
  test("projects canonical pause facts without protected durable content or owner/session existence disclosure", async () => {
    const { store, paused } = await pausedFixture();
    const ownerStatus = await readSessionStatus({ store, cursorSecret: "continuation-status-secret", query: { principal: owner, sessionId: paused.sessionId } });
    expect(ownerStatus).toMatchObject({
      status: "ok",
      session: {
        id: paused.sessionId, state: "needs_top_up", continuation: {
          status: "needs_top_up", actionMaximum: "3250", requiredAdditionalFunding: "2500", requiredCapApproval: "0",
          settledBalance: "4000", availableBalance: "750", remainingCap: "3250", graceDeadlineMs: 1_700_000_600_000,
          checkpoint: { state: "live_worker" }, nextRequiredAction: "top_up",
        },
      },
      action: null,
    });
    expect(JSON.stringify(ownerStatus)).not.toMatch(/Prompt canary|reasoning|credential|bearer|provider|archive|nonce|key reference/i);
    const accountId = await accountIdForPrincipal(owner);
    const record = await store.findContinuation(accountId, "status-pause");
    if (!record) throw new Error("expected continuation record");
    const canaryStore = new Proxy(store, { get(target, property) {
      if (property === "findContinuationForSession") return async () => ({ ...record, result: { ...record.result, prompt: "prompt-canary", generatedSource: "source-canary", rawReasoning: "reasoning-canary", bearer: "credential-canary", nativeProviderPayload: "provider-canary", archiveBytes: "archive-canary", nonce: "nonce-canary", keyReference: "key-reference-canary" } });
      const value = Reflect.get(target, property, target);
      return typeof value === "function" ? value.bind(target) : value;
    } });
    const safeCanaryStatus = await readSessionStatus({ store: canaryStore, cursorSecret: "continuation-status-secret", query: { principal: owner, sessionId: paused.sessionId } });
    expect(JSON.stringify(safeCanaryStatus)).not.toMatch(/prompt-canary|source-canary|reasoning-canary|credential-canary|provider-canary|archive-canary|nonce-canary|key-reference-canary/i);
    const foreign = await readSessionStatus({ store, cursorSecret: "continuation-status-secret", query: { principal: stranger, sessionId: paused.sessionId } });
    const missing = await readSessionStatus({ store, cursorSecret: "continuation-status-secret", query: { principal: owner, sessionId: "missing-session" } });
    expect(foreign).toEqual({ status: "not_found_or_denied" });
    expect(foreign).toEqual(missing);
  });

  test("keeps one-sat and large bigint pause facts as canonical strings", async () => {
    const { store, paused } = await pausedFixture();
    const accountId = await accountIdForPrincipal(owner);
    const record = await store.findContinuation(accountId, "status-pause");
    if (!record) throw new Error("expected continuation record");
    expect(record.result.graceDeadlineMs).toBe(1_700_000_600_000);
    expect(record.result.requiredAdditionalFunding).toBe("2500");
    expect(record.result.requiredCapApproval).toBe("0");
    expect(record.result.pendingActionFingerprint).toMatch(/^[a-f0-9]{64}$/);
    expect(paused.sessionId).toBe(record.intent.sessionId);
  });

  test("projects a claimed wake as active/recovery and never as needs_top_up", async () => {
    const { store, paused, funding } = await pausedFixture();
    await funding.execute({ principal: owner, kind: "credit_settlement", idempotencyKey: "status-wake-credit", policyVersion: "funding-policy-v1", protocolVersion: "funding-contract-v1", payload: { settlement: { topUpId: "status-wake", rail: "cashu", unit: "sat", amount: "3250", externalReference: "status-wake-external", settlementReference: "status-wake-settlement", verifiedAt: "2026-08-05T00:01:00.000Z" } } });
    const accountId = await accountIdForPrincipal(owner);
    const record = await store.findContinuation(accountId, "status-pause");
    if (!record) throw new Error("expected continuation record");
    const pause = await store.transact(accountId, (tx) => tx.findContinuationPause(paused.sessionId, 1));
    if (!pause?.liveLeaseToken) throw new Error("expected live pause");
    await new ContinuationService({ store, clock: { nowMs: () => 1_700_000_000_001 } }).wakePausedAction({ accountId, sessionId: paused.sessionId, pauseGeneration: 1, liveLeaseToken: pause.liveLeaseToken, pendingFingerprint: record.intent.fingerprint, expectedSessionVersion: record.intent.expectedSessionVersion, expectedArtifactVersion: record.intent.expectedArtifactVersion });
    const status = await readSessionStatus({ store, cursorSecret: "continuation-status-secret", query: { principal: owner, sessionId: paused.sessionId } });
    expect(status).toMatchObject({ status: "ok", session: { state: "active", continuation: null, nextAction: "wait_for_current_action" } });
    expect(JSON.stringify(status)).not.toContain("needs_top_up");
  });
});
