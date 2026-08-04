import { describe, expect, test } from "bun:test";
import fixture from "../fixtures/cashu-phase-03.json";
import { FundingService } from "../../src/funding/funding-service";
import { CashuMintPolicyRegistry } from "../../src/funding/cashu-mint-policy";
import { FakeCashuSettlementPort } from "../../src/funding/cashu-provider";
import { CashuTopUpCoordinator, InMemoryCashuTopUpRepository } from "../../src/funding/cashu-top-up";
import { TransactionalMemoryFundingStore } from "../../src/persistence/funding-store";

const principal = { pubkey: "a".repeat(64) };
const token = new TextEncoder().encode("cashuB-safe-fixture-token");
const firstPolicy = fixture.policies[0]!;
const secondPolicy = fixture.policies[1]!;

class FakeCashuVault {
  sealed: readonly { id: string; payloadDigest: string }[] = [];
  expired: string[] = [];
  async seal(_: { accountId: string; topUpId: string; rail: "cashu" }, bytes: Uint8Array) {
    const record = { id: `protected:${this.sealed.length + 1}`, payloadDigest: `digest:${bytes.byteLength}` };
    this.sealed = [...this.sealed, record];
    return record;
  }
  async expire(id: string) { this.expired.push(id); }
}

function harness() {
  const policies = new CashuMintPolicyRegistry(firstPolicy);
  const provider = new FakeCashuSettlementPort();
  const vault = new FakeCashuVault();
  const store = new TransactionalMemoryFundingStore();
  const funding = new FundingService(store);
  const repository = new InMemoryCashuTopUpRepository();
  return { policies, provider, vault, store, funding, repository, coordinator: new CashuTopUpCoordinator({ policies, provider, vault, funding, repository }) };
}

function validSubmit(topUpId = "cashu-top-up-1") {
  return { principal, idempotencyKey: `submit:${topUpId}`, topUpId, amount: "21", unit: "sat" as const, pmi: fixture.pmi, token };
}

describe("Cashu policy", () => {
  test("policy rotation preserves policy-pinned historical mints", () => {
    const { policies } = harness();
    const pinned = policies.pinActive();
    policies.add(secondPolicy);
    policies.rotate(secondPolicy.version);
    expect(policies.get(pinned.version).mints.map((mint) => mint.url)).toEqual(["https://mint-a.example", "https://mint-b.example"]);
    expect(policies.pinActive().mints.map((mint) => mint.url)).toEqual(["https://mint-a.example", "https://mint-c.example"]);
    expect(() => policies.add(firstPolicy)).toThrow("CASHU_POLICY_VERSION_COLLISION");
    expect(() => new CashuMintPolicyRegistry({ ...firstPolicy, mints: [firstPolicy.mints[0]!, { ...firstPolicy.mints[0]!, url: "https://mint-a.example/" }] })).toThrow("CASHU_POLICY_MINT_COLLISION");
  });
});

describe("Cashu validation and swap", () => {
  test("validation rejects a bad PMI or oversized bearer before sealing or swap", async () => {
    const { coordinator, provider, vault } = harness();
    await expect(coordinator.submit({ ...validSubmit(), pmi: "bitcoin-cashu-v3-direct" })).rejects.toThrow("CASHU_PMI_UNSUPPORTED");
    await expect(coordinator.submit({ ...validSubmit("too-large"), token: new Uint8Array(8_193) })).rejects.toThrow("CASHU_TOKEN_TOO_LARGE");
    await expect(coordinator.submit({ ...validSubmit("amount-overflow"), amount: String(BigInt(Number.MAX_SAFE_INTEGER) + 1n) })).rejects.toThrow("CASHU_INPUT_INVALID");
    expect(provider.settleCalls).toBe(0);
    expect(vault.sealed).toHaveLength(0);
  });

  test("validation credits only a normalized online verified swap and retains no bearer material", async () => {
    const { coordinator, provider, vault, store } = harness();
    provider.nextSettlement({ status: "verified", externalReference: "mint-op-1", settlementReference: "mint-settlement-1", verifiedAt: "2026-08-04T12:00:00.000Z" });
    const result = await coordinator.submit(validSubmit());
    expect(result.state).toBe("credited");
    expect(provider.settleCalls).toBe(1);
    expect(provider.requests[0]?.policy.version).toBe(firstPolicy.version);
    expect(vault.expired).toEqual(["protected:1"]);
    expect(store.postings).toHaveLength(1);
    expect(JSON.stringify(result)).not.toContain("cashuB-safe-fixture-token");
  });

  test("validation rejects policy mismatch outcomes before credit", async () => {
    const cases = ["untrusted_mint", "wrong_unit", "wrong_amount", "inactive_keyset", "invalid_dleq", "unsupported_condition", "duplicate_proof"] as const;
    for (const code of cases) {
      const { coordinator, provider, store } = harness();
      provider.nextSettlement({ status: "failed", code });
      await expect(coordinator.submit(validSubmit(`reject:${code}`))).rejects.toThrow(`CASHU_${code.toUpperCase()}`);
      expect(store.postings).toHaveLength(0);
    }
  });

  test("swap is policy-pinned even after rotation", async () => {
    const { coordinator, policies, provider } = harness();
    provider.nextSettlement({ status: "verified", externalReference: "mint-op-rotation", settlementReference: "mint-settlement-rotation", verifiedAt: "2026-08-04T12:00:00.000Z" });
    const pending = coordinator.prepare(validSubmit("historical"));
    policies.add(secondPolicy); policies.rotate(secondPolicy.version);
    await pending;
    expect(provider.requests[0]?.policy.version).toBe(firstPolicy.version);
  });

  test("cashu-ts remains adapter-confined", async () => {
    const source = await Bun.file("src/funding/cashu-provider.ts").text();
    const core = await Bun.file("src/funding/cashu-top-up.ts").text();
    const policy = await Bun.file("src/funding/cashu-mint-policy.ts").text();
    expect(source).toContain("@cashu/cashu-ts");
    expect(`${core}\n${policy}`).not.toContain("@cashu/cashu-ts");
  });
});

describe("Cashu credit and treasury", () => {
  test("credit deduplicates a proof commitment across coordinator instances", async () => {
    const { policies, provider, vault, funding, store, repository, coordinator } = harness();
    provider.nextSettlement({ status: "verified", externalReference: "mint-op-duplicate", settlementReference: "mint-settlement-duplicate", verifiedAt: "2026-08-04T12:00:00.000Z" });
    await coordinator.submit(validSubmit("first"));
    const second = new CashuTopUpCoordinator({ policies, provider, vault, funding, repository });
    await expect(second.submit({ ...validSubmit("second"), idempotencyKey: "submit:second" })).rejects.toThrow("CASHU_PROOF_ALREADY_CLAIMED");
    expect(store.postings).toHaveLength(1);
  });

  test("ambiguous swap is reconciliation-pending and queries without resubmission", async () => {
    const { coordinator, provider, store } = harness();
    provider.nextSettlement({ status: "unknown", operationReference: "mint-op-unknown" });
    const pending = await coordinator.submit(validSubmit("unknown"));
    expect(pending.state).toBe("reconciliation_pending");
    provider.nextObservation({ status: "verified", externalReference: "mint-op-unknown", settlementReference: "mint-settlement-unknown", verifiedAt: "2026-08-04T12:00:00.000Z" });
    const settled = await coordinator.reconcile(pending.topUpId);
    expect(settled.state).toBe("credited");
    expect(provider.settleCalls).toBe(1);
    expect(provider.observeCalls).toBe(1);
    expect(store.postings).toHaveLength(1);
  });

  test("effect-then-timeout is observed through the original operation without a second swap", async () => {
    const { coordinator, provider, store } = harness();
    provider.effectThenThrowOnce({ status: "verified", externalReference: "mint-op-effect-timeout", settlementReference: "mint-settlement-effect-timeout", verifiedAt: "2026-08-04T12:00:00.000Z" });
    const pending = await coordinator.submit(validSubmit("effect-timeout"));
    expect(pending.state).toBe("reconciliation_pending");
    expect(store.postings).toHaveLength(0);
    provider.nextObservation({ status: "verified", externalReference: "mint-op-effect-timeout", settlementReference: "mint-settlement-effect-timeout", verifiedAt: "2026-08-04T12:00:00.000Z" });
    const replay = await coordinator.reconcile(pending.topUpId);
    expect(replay.state).toBe("credited");
    expect(provider.settleCalls).toBe(1);
    expect(store.postings).toHaveLength(1);
  });

  test("unknown reconciliation remains pending and treasury movement never recredits", async () => {
    const { coordinator, provider, store } = harness();
    provider.nextSettlement({ status: "verified", externalReference: "mint-op-treasury", settlementReference: "mint-settlement-treasury", verifiedAt: "2026-08-04T12:00:00.000Z" });
    const credited = await coordinator.submit(validSubmit("treasury"));
    provider.nextTreasury({ state: "held_at_trusted_mint" });
    const first = await coordinator.reconcileTreasury(credited.topUpId);
    provider.nextTreasury({ state: "melted_settled" });
    const replay = await coordinator.reconcileTreasury(credited.topUpId);
    expect(first).toEqual(replay);
    expect(store.postings).toHaveLength(1);
  });
});
