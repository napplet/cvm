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
});
