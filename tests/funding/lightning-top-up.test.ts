import { describe, expect, test } from "bun:test";
import { FundingService } from "../../src/funding/funding-service";
import { FakeLightningReceiptPort } from "../../src/funding/lightning-provider";
import { InMemoryProtectedRailMaterialRepository, ProtectedRailMaterialVault } from "../../src/funding/protected-rail-material";
import { InMemoryLightningTopUpRepository, LightningTopUpCoordinator } from "../../src/funding/lightning-top-up";
import { TransactionalMemoryFundingStore } from "../../src/persistence/funding-store";

const principal = { pubkey: "cd".repeat(32) };
const key = new Uint8Array(32).fill(7);
const canaryInvoice = "lnbc123-secret-invoice-canary";

function fixture() {
  const fundingStore = new TransactionalMemoryFundingStore();
  const topUps = new InMemoryLightningTopUpRepository();
  const material = new InMemoryProtectedRailMaterialRepository();
  const receiver = new FakeLightningReceiptPort({
    create: {
      status: "created",
      topUpId: "",
      serviceReference: "receiver:invoice:001",
      invoice: canaryInvoice,
      invoiceIdentity: "invoice-identity-001",
      paymentHash: "payment-hash-001",
      amount: "250",
      unit: "sat",
      expiresAt: "2026-08-05T00:10:00.000Z",
      safeDisplayReference: "lightning:…0001",
    },
  });
  const coordinator = new LightningTopUpCoordinator({
    funding: new FundingService(fundingStore), receiver, repository: topUps,
    vault: new ProtectedRailMaterialVault({ key, repository: material }),
    now: () => "2026-08-05T00:00:00.000Z",
  });
  return { fundingStore, topUps, material, receiver, coordinator };
}

const request = (idempotencyKey = "lightning-command-001", amount = "250") => ({
  principal, idempotencyKey, amount, unit: "sat" as const,
  policyVersion: "funding-policy-v1", protocolVersion: "funding-contract-v1",
});

describe("Lightning top-up initiation and protected material", () => {
  test("protected material encrypts bearer data with bound metadata and authorizes only the matching rail coordinator", async () => {
    const repository = new InMemoryProtectedRailMaterialRepository();
    const vault = new ProtectedRailMaterialVault({ key, repository });
    const sealed = await vault.seal({ accountId: "account-1", topUpId: "topup-1", rail: "lightning" }, new TextEncoder().encode(canaryInvoice));

    expect(JSON.stringify(repository.snapshot())).not.toContain(canaryInvoice);
    await expect(vault.open({ id: sealed.id, accountId: "account-2", topUpId: "topup-1", rail: "lightning" })).rejects.toThrow("PROTECTED_MATERIAL_ACCESS_DENIED");
    expect(new TextDecoder().decode(await vault.open({ id: sealed.id, accountId: "account-1", topUpId: "topup-1", rail: "lightning" }))).toBe(canaryInvoice);
    expect(() => new ProtectedRailMaterialVault({ key: new Uint8Array(31), repository })).toThrow("PROTECTED_MATERIAL_KEY_INVALID");
  });

  test("initiation persists one invoice intent before I/O and exact replay never creates a second invoice", async () => {
    const { coordinator, receiver, topUps, material } = fixture();
    const first = await coordinator.begin(request());
    const replay = await coordinator.begin(request());

    expect(first).toEqual(replay);
    expect(first).toMatchObject({ status: "payment_required", rail: "lightning", amount: "250", unit: "sat" });
    expect(receiver.createCalls).toBe(1);
    expect(JSON.stringify(topUps.snapshot())).not.toMatch(/lnbc|preimage|credential|secret/i);
    expect(JSON.stringify(material.snapshot())).not.toContain(canaryInvoice);
    await expect(coordinator.begin(request("lightning-command-001", "251"))).rejects.toThrow("IDEMPOTENCY_KEY_CONFLICT");
  });

  test("initiation reconciles an opaque create result by the original service reference without blind invoice reissue", async () => {
    const { coordinator, receiver } = fixture();
    receiver.createMode = "effect_then_throw";
    const pending = await coordinator.begin(request());
    expect(pending).toMatchObject({ status: "reconciliation_pending", state: "reconciliation_pending" });
    expect(receiver.createCalls).toBe(1);

    receiver.queryMode = "created";
    const resolved = await coordinator.begin(request());
    expect(resolved).toMatchObject({ status: "payment_required", state: "pending" });
    expect(receiver.createCalls).toBe(1);
    expect(receiver.queryCalls).toBe(1);
  });

  test("bounds receiver calls and durably reconciles without blind invoice reissue", async () => {
    let creates = 0; let queries = 0;
    const never = () => new Promise<never>(() => undefined);
    const receiver = {
      createInvoice: async () => { creates += 1; return never(); },
      queryInvoice: async () => { queries += 1; return never(); },
    };
    const fundingStore = new TransactionalMemoryFundingStore();
    const topUps = new InMemoryLightningTopUpRepository();
    const coordinator = new LightningTopUpCoordinator({
      funding: new FundingService(fundingStore), receiver, repository: topUps,
      vault: new ProtectedRailMaterialVault({ key, repository: new InMemoryProtectedRailMaterialRepository() }),
      providerTimeoutMs: 5,
    });

    const first = await Promise.race([coordinator.begin(request("bounded-lightning")), Bun.sleep(50).then(() => ({ status: "unbounded" as const }))]);
    expect(first).toMatchObject({ status: "reconciliation_pending", state: "reconciliation_pending" });
    const replay = await Promise.race([coordinator.begin(request("bounded-lightning")), Bun.sleep(50).then(() => ({ status: "unbounded" as const }))]);
    expect(replay).toMatchObject({ status: "reconciliation_pending", state: "reconciliation_pending" });
    expect(creates).toBe(1);
    expect(queries).toBe(1);
  });
});

describe("Lightning settlement receipt matrix", () => {
  test("credits one authoritative fully matched settled receipt exactly once across coordinator instances", async () => {
    const { coordinator, receiver, fundingStore, topUps, material } = fixture();
    const payment = await coordinator.begin(request());
    receiver.queryMode = "settled";
    const other = new LightningTopUpCoordinator({
      funding: new FundingService(fundingStore), receiver, repository: topUps,
      vault: new ProtectedRailMaterialVault({ key, repository: material }), now: () => "2026-08-05T00:00:00.000Z",
    });

    const [first, duplicate] = await Promise.all([
      coordinator.observeSettlement({ principal, topUpId: payment.topUpId }),
      other.observeSettlement({ principal, topUpId: payment.topUpId }),
    ]);
    expect(first).toMatchObject({ status: "credited", state: "credited" });
    expect(duplicate).toMatchObject({ status: "credited", state: "credited" });
    expect(fundingStore.postings).toHaveLength(1);
    expect(fundingStore.projection((await new FundingService(fundingStore).status(principal)).accountId)).toEqual({ settledAvailable: "250", held: "0", unit: "sat" });
    expect(JSON.stringify(topUps.snapshot())).not.toMatch(/lnbc|preimage|credential|secret/i);
  });

  test("wrong or non-final receipt fields never credit and unknown is retained for query-only reconciliation", async () => {
    const { coordinator, receiver, fundingStore } = fixture();
    const payment = await coordinator.begin(request());
    receiver.queryObservation = {
      status: "settled", topUpId: payment.topUpId, serviceReference: "ignored", invoiceIdentity: "invoice-identity-001",
      paymentHash: "payment-hash-001", amount: "251", unit: "sat", expiresAt: "2026-08-05T00:10:00.000Z",
      settledAt: "2026-08-05T00:01:00.000Z", final: true, settlementReference: "settlement-wrong-amount", receiverAuthenticated: true,
    };
    const pending = await coordinator.observeSettlement({ principal, topUpId: payment.topUpId });
    expect(pending).toMatchObject({ status: "reconciliation_pending", state: "reconciliation_pending" });
    expect(fundingStore.postings).toHaveLength(0);

    receiver.queryObservation = { status: "unknown", topUpId: payment.topUpId, serviceReference: "ignored" };
    const replay = await coordinator.observeSettlement({ principal, topUpId: payment.topUpId });
    expect(replay).toEqual(pending);
    expect(fundingStore.postings).toHaveLength(0);
  });

  test("failed authoritative observation remains failed with no credit", async () => {
    const { coordinator, receiver, fundingStore } = fixture();
    const payment = await coordinator.begin(request());
    receiver.queryMode = "failed";
    expect(await coordinator.observeSettlement({ principal, topUpId: payment.topUpId })).toMatchObject({ status: "failed", state: "failed" });
    expect(fundingStore.postings).toHaveLength(0);
  });

  test("does not credit a receipt observed after the service-created invoice expiry", async () => {
    const { coordinator, receiver, fundingStore, topUps, material } = fixture();
    const payment = await coordinator.begin(request());
    receiver.queryMode = "settled";
    const afterExpiry = new LightningTopUpCoordinator({
      funding: new FundingService(fundingStore), receiver, repository: topUps,
      vault: new ProtectedRailMaterialVault({ key, repository: material }), now: () => "2026-08-05T00:20:00.000Z",
    });
    expect(await afterExpiry.observeSettlement({ principal, topUpId: payment.topUpId })).toMatchObject({ status: "reconciliation_pending" });
    expect(fundingStore.postings).toHaveLength(0);
  });
});
