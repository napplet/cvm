import { describe, expect, test } from "bun:test";
import cashuFixture from "../fixtures/cashu-phase-03.json";
import { accountIdForPrincipal } from "../../src/domain/account-command";
import { FundingService } from "../../src/funding/funding-service";
import { FakeLightningReceiptPort } from "../../src/funding/lightning-provider";
import { InMemoryLightningTopUpRepository, LightningTopUpCoordinator } from "../../src/funding/lightning-top-up";
import { InMemoryProtectedRailMaterialRepository, ProtectedRailMaterialVault } from "../../src/funding/protected-rail-material";
import { CashuMintPolicyRegistry } from "../../src/funding/cashu-mint-policy";
import { FakeCashuSettlementPort } from "../../src/funding/cashu-provider";
import { CashuTopUpCoordinator, InMemoryCashuTopUpRepository } from "../../src/funding/cashu-top-up";
import { TransactionalMemoryFundingStore } from "../../src/persistence/funding-store";
import { MeteredGenerationService } from "../../src/phase-04/metered-generation-service";

const principal = { pubkey: "ab".repeat(32) };
const nowMs = 1_700_000_000_000;
const deadlineMs = nowMs + 600_000;
const admissionReference = "admission:rail-wake";
const liveLeaseToken = "lease:rail-wake:original-worker";
const pendingFingerprint = "a".repeat(64);

async function pausedFixture(clockMs = nowMs) {
  const store = new TransactionalMemoryFundingStore();
  const funding = new FundingService(store);
  const accountId = await accountIdForPrincipal(principal);
  await funding.execute({
    principal, kind: "credit_settlement", idempotencyKey: "rail-wake:initial-credit", policyVersion: "funding-policy-v1", protocolVersion: "funding-contract-v1",
    payload: { settlement: { topUpId: "rail-wake:initial", rail: "lightning", unit: "sat", amount: "3250", externalReference: "rail-wake:initial:external", settlementReference: "rail-wake:initial:settlement", verifiedAt: "2026-08-05T00:00:00.000Z" } },
  });
  await funding.execute({
    principal, kind: "funded_admission", idempotencyKey: "rail-wake:admission", policyVersion: "funding-policy-v1", protocolVersion: "funding-contract-v1",
    payload: { requestedCap: "3250", unit: "sat", capacity: { usable: true, reference: admissionReference } },
  });
  await store.transact(accountId, (transaction) => transaction.pauseForFunding({
    accountId, sessionId: "session:rail-wake", admissionReference, idempotencyKey: "pause:rail-wake", fingerprint: "b".repeat(64), pendingFingerprint,
    expectedSessionVersion: 4, pauseGeneration: 1, graceDeadlineMs: deadlineMs, liveLeaseToken,
    intent: { accountId, sessionId: "session:rail-wake", idempotencyKey: "pause:rail-wake", fingerprint: pendingFingerprint, reference: "pending:rail-wake", actionKind: "revise_session", boundedPayloadHash: "c".repeat(64), expectedSessionVersion: 4, expectedArtifactVersion: 4, policyVersion: "policy:rail-wake", priceCardId: "price:rail-wake", profileId: "profile:rail-wake", toolchainId: "toolchain:rail-wake", actionMaximum: "3250", admissionReference },
    result: { status: "needs_top_up", code: "ACTION_AFFORDABILITY_REQUIRED", accountId, sessionId: "session:rail-wake", pendingActionReference: "pending:rail-wake", pendingActionFingerprint: pendingFingerprint, pendingActionKind: "revise_session", actionMaximum: "3250", requiredAdditionalFunding: "3250", requiredCapApproval: "0", settledBalance: "3250", availableBalance: "0", remainingCap: "3250", graceDeadlineMs: deadlineMs, checkpoint: { state: "live_worker", reference: "checkpoint-pending:rail-wake" }, nextRequiredAction: "top_up" },
  }));
  const continuations: Readonly<{ pendingActionReference: string; actionBudgetReference: string; operationId: string; liveLeaseToken: string }>[] = [];
  const generation = new MeteredGenerationService({
    fundedAdmission: {} as never, store, gateway: {} as never, worker: {} as never, artifactVerifier: {} as never,
    clock: { nowMs: () => clockMs },
    continuationWake: { continueAction: async (input) => { continuations.push(input); } },
  });
  return { accountId, funding, generation, store, continuations };
}

class CashuVault {
  #contents = new Map<string, Uint8Array>();
  async seal(_: { accountId: string; topUpId: string; rail: "cashu" }, bytes: Uint8Array) {
    const id = `cashu-material:${this.#contents.size + 1}`;
    this.#contents.set(id, bytes.slice());
    return { id, payloadDigest: `digest:${bytes.byteLength}` };
  }
  async expire(id: string) { this.#contents.delete(id); }
  async open(input: { id: string }) { return this.#contents.get(input.id)!.slice(); }
}

describe("verified rail credit to same-worker continuation", () => {
  test("a verified Lightning receipt discovers the durable pause and continues the stored live lease exactly once", async () => {
    const fixture = await pausedFixture();
    const receiver = new FakeLightningReceiptPort({ create: {
      status: "created", topUpId: "", serviceReference: "receiver:rail-wake", invoice: "lnbc-rail-wake", invoiceIdentity: "invoice:rail-wake", paymentHash: "payment-hash:rail-wake", amount: "3250", unit: "sat", expiresAt: "2026-08-05T00:10:00.000Z", safeDisplayReference: "lightning:rail-wake",
    } });
    const coordinator = new LightningTopUpCoordinator({
      funding: fixture.funding, receiver, repository: new InMemoryLightningTopUpRepository(),
      vault: new ProtectedRailMaterialVault({ key: new Uint8Array(32).fill(9), repository: new InMemoryProtectedRailMaterialRepository() }),
      verifiedCreditWake: fixture.generation, now: () => "2026-08-05T00:01:00.000Z",
    });
    const pending = await coordinator.begin({ principal, idempotencyKey: "lightning:rail-wake", amount: "3250", unit: "sat", policyVersion: "funding-policy-v1", protocolVersion: "funding-contract-v1" });
    receiver.queryMode = "settled";

    await expect(coordinator.observeSettlement({ principal, topUpId: pending.topUpId })).resolves.toMatchObject({ status: "credited" });
    await expect(coordinator.observeSettlement({ principal, topUpId: pending.topUpId })).resolves.toMatchObject({ status: "credited" });

    expect(fixture.continuations).toEqual([expect.objectContaining({ pendingActionReference: "pending:rail-wake", liveLeaseToken })]);
    expect(await fixture.store.findContinuationPause(fixture.accountId, "session:rail-wake", 1)).toMatchObject({ state: "completed", liveLeaseToken: undefined });
    expect(fixture.store.postings).toHaveLength(2); // initial cap funding plus one replay-safe rail credit
  });

  test("a verified Cashu swap reaches the same dispatcher once, while post-grace credit and replay have no continuation effect", async () => {
    const active = await pausedFixture();
    const activeProvider = new FakeCashuSettlementPort();
    activeProvider.nextSettlement({ status: "verified", externalReference: "cashu:rail-wake:external", settlementReference: "cashu:rail-wake:settlement", verifiedAt: "2026-08-05T00:01:00.000Z" });
    const activeCoordinator = new CashuTopUpCoordinator({ policies: new CashuMintPolicyRegistry(cashuFixture.policies[0]!), provider: activeProvider, vault: new CashuVault(), funding: active.funding, repository: new InMemoryCashuTopUpRepository(), verifiedCreditWake: active.generation });
    const submit = { principal, idempotencyKey: "cashu:rail-wake", topUpId: "cashu:rail-wake", amount: "3250", unit: "sat" as const, pmi: cashuFixture.pmi, token: new TextEncoder().encode("cashuB-rail-wake") };

    await expect(activeCoordinator.submit(submit)).resolves.toMatchObject({ state: "credited" });
    await expect(activeCoordinator.submit(submit)).resolves.toMatchObject({ state: "credited" });
    expect(active.continuations).toEqual([expect.objectContaining({ pendingActionReference: "pending:rail-wake", liveLeaseToken })]);

    const late = await pausedFixture(deadlineMs);
    const lateProvider = new FakeCashuSettlementPort();
    lateProvider.nextSettlement({ status: "verified", externalReference: "cashu:late:external", settlementReference: "cashu:late:settlement", verifiedAt: "2026-08-05T00:11:00.000Z" });
    const lateCoordinator = new CashuTopUpCoordinator({ policies: new CashuMintPolicyRegistry(cashuFixture.policies[0]!), provider: lateProvider, vault: new CashuVault(), funding: late.funding, repository: new InMemoryCashuTopUpRepository(), verifiedCreditWake: late.generation });
    const lateSubmit = { ...submit, idempotencyKey: "cashu:late", topUpId: "cashu:late", token: new TextEncoder().encode("cashuB-late") };
    await expect(lateCoordinator.submit(lateSubmit)).resolves.toMatchObject({ state: "credited" });
    await expect(lateCoordinator.submit(lateSubmit)).resolves.toMatchObject({ state: "credited" });
    expect(late.continuations).toEqual([]);
    expect(await late.store.findContinuationPause(late.accountId, "session:rail-wake", 1)).toMatchObject({ state: "needs_top_up", liveLeaseToken });
  });
});
