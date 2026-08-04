import { describe, expect, test } from "bun:test";
import fixture from "../fixtures/cashu-phase-03.json";
import { FundingService } from "../../src/funding/funding-service";
import { CashuMintPolicyRegistry } from "../../src/funding/cashu-mint-policy";
import { FakeCashuSettlementPort } from "../../src/funding/cashu-provider";
import { CashuTsSettlementAdapter } from "../../src/funding/cashu-provider";
import { CashuTopUpCoordinator, InMemoryCashuTopUpRepository } from "../../src/funding/cashu-top-up";
import { TransactionalMemoryFundingStore } from "../../src/persistence/funding-store";
import { getEncodedToken, type RequestFn } from "@cashu/cashu-ts";

const principal = { pubkey: "a".repeat(64) };
const token = new TextEncoder().encode("cashuB-safe-fixture-token");
const firstPolicy = fixture.policies[0]!;
const secondPolicy = fixture.policies[1]!;

class FakeCashuVault {
  sealed: readonly { id: string; payloadDigest: string }[] = [];
  expired: string[] = [];
  contents = new Map<string, Uint8Array>();
  async seal(_: { accountId: string; topUpId: string; rail: "cashu" }, bytes: Uint8Array) {
    const record = { id: `protected:${this.sealed.length + 1}`, payloadDigest: `digest:${bytes.byteLength}` };
    this.sealed = [...this.sealed, record];
    this.contents.set(record.id, bytes.slice());
    return record;
  }
  async expire(id: string) { this.expired.push(id); }
  async open(request: { id: string }) { return this.contents.get(request.id)!.slice(); }
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

const adapterToken = new TextEncoder().encode(getEncodedToken({
  mint: "https://mint-a.example", unit: "sat",
  proofs: [{ amount: 21n, id: "009a1b2c3d4e5f60", secret: "adapter-secret", C: `02${"11".repeat(32)}`, dleq: { e: "11".repeat(32), s: "22".repeat(32), r: "33".repeat(32) } }],
}));
const defaultAdapterKeysetId = "01b318594eee08c75392d79ea6d2429df1e882991128bc12c55966ac34407b5044";
const adapterTokenWithoutDleq = new TextEncoder().encode(getEncodedToken({
  mint: "https://mint-b.example", unit: "sat",
  proofs: [{ amount: 21n, id: defaultAdapterKeysetId, secret: "default-adapter-secret", C: `02${"79be667ef9dcbbac55a06295ce870b07029bfcdb2dce28d959f2815b16f81798"}` }],
}));

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

  test("never returns a prior Cashu lifecycle result to a different owner", async () => {
    const { coordinator, provider } = harness();
    provider.nextSettlement({ status: "unknown", operationReference: "owner-scope" });
    await coordinator.submit(validSubmit("owner-scope"));
    await expect(coordinator.submit({ ...validSubmit("owner-scope"), principal: { pubkey: "b".repeat(64) } })).rejects.toThrow("CASHU_TOP_UP_NOT_OWNER");
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

  test("bounds swap and observation calls while retaining one durable reconciliation intent", async () => {
    let settles = 0; let observations = 0; const signals: AbortSignal[] = [];
    const never = () => new Promise<never>(() => undefined);
    const provider = {
      settle: async (input: { signal: AbortSignal }) => { settles += 1; signals.push(input.signal); return never(); },
      observe: async (input: { signal: AbortSignal }) => { observations += 1; signals.push(input.signal); return never(); },
      reconcileTreasury: async () => never(),
    };
    const { policies, vault, store, funding, repository } = harness();
    const coordinator = new CashuTopUpCoordinator({ policies, provider, vault, funding, repository, providerTimeoutMs: 5 });

    const pending = await Promise.race([coordinator.submit(validSubmit("bounded-cashu")), Bun.sleep(50).then(() => ({ state: "unbounded" as const }))]);
    expect(pending).toMatchObject({ state: "reconciliation_pending" });
    expect(await coordinator.submit(validSubmit("bounded-cashu"))).toMatchObject({ state: "reconciliation_pending" });
    const reconciled = await Promise.race([coordinator.reconcile("bounded-cashu"), Bun.sleep(50).then(() => ({ state: "unbounded" as const }))]);
    expect(reconciled).toMatchObject({ state: "reconciliation_pending" });
    expect(settles).toBe(1);
    expect(observations).toBe(1);
    expect(signals).toHaveLength(2);
    expect(signals.every((signal) => signal.aborted)).toBeTrue();
    expect(store.postings).toHaveLength(0);
  });

  test("default Cashu adapter aborts side effects and query-reconciles consumed proofs by the original operation", async () => {
    let swaps = 0; let observations = 0; const signals: AbortSignal[] = [];
    const operations = {
      settle: async (input: { signal: AbortSignal }) => {
        swaps += 1; signals.push(input.signal);
        await new Promise<never>((_, reject) => input.signal.addEventListener("abort", () => reject(new Error("SWAP_ABORTED_AFTER_CONSUMPTION")), { once: true }));
      },
      observe: async (input: { signal: AbortSignal }) => { observations += 1; signals.push(input.signal); return "spent" as const; },
    };
    const policies = new CashuMintPolicyRegistry(firstPolicy);
    const vault = new FakeCashuVault();
    const store = new TransactionalMemoryFundingStore();
    const coordinator = new CashuTopUpCoordinator({
      policies, vault,
      provider: new CashuTsSettlementAdapter({ operations, now: () => "2026-08-04T12:00:00.000Z" }),
      funding: new FundingService(store), repository: new InMemoryCashuTopUpRepository(), providerTimeoutMs: 5,
    });
    const command = { ...validSubmit("adapter-timeout"), token: adapterToken };
    const nativeFetch = globalThis.fetch;
    globalThis.fetch = (async () => new Promise<never>(() => undefined)) as typeof fetch;
    try {
      expect(await coordinator.submit(command)).toMatchObject({ state: "reconciliation_pending" });
      expect(await coordinator.reconcile(command.topUpId)).toMatchObject({ state: "credited", settlementReference: expect.stringContaining("adapter-timeout") });
      expect({ swaps, observations }).toEqual({ swaps: 1, observations: 1 });
      expect(signals).toHaveLength(2);
      expect(signals[0]?.aborted).toBeTrue();
      expect(store.postings).toHaveLength(1);
    } finally {
      globalThis.fetch = nativeFetch;
    }
  });

  test("cashu-ts default Wallet binds the operation AbortSignal to load, swap, and proof-state requests", async () => {
    const generator = `02${"79be667ef9dcbbac55a06295ce870b07029bfcdb2dce28d959f2815b16f81798"}`;
    const adapterPolicy = { ...firstPolicy, mints: firstPolicy.mints.map((mint) => mint.url === "https://mint-b.example" ? { ...mint, keysetIds: [defaultAdapterKeysetId] } : mint) };
    const seen: { endpoint: string; signal?: AbortSignal }[] = [];
    const request: RequestFn = async (input) => {
      seen.push({ endpoint: input.endpoint, signal: input.signal });
      if (input.endpoint.endsWith("/v1/info")) return { name: "test", version: "Nutshell/0.0", nuts: {} } as never;
      if (input.endpoint.endsWith("/v1/keysets")) return { keysets: [{ id: defaultAdapterKeysetId, unit: "sat", active: true, input_fee_ppk: 0 }] } as never;
      if (input.endpoint.endsWith("/v1/keys") || input.endpoint.includes("/v1/keys/")) return { keysets: [{ id: defaultAdapterKeysetId, unit: "sat", keys: Object.fromEntries([1, 2, 4, 8, 16, 32].map((amount) => [String(amount), generator])) }] } as never;
      if (input.endpoint.endsWith("/v1/checkstate")) {
        const ys = (input.requestBody as { Ys: string[] }).Ys;
        return { states: ys.map((Y) => ({ Y, state: "SPENT", witness: null })) } as never;
      }
      if (input.endpoint.endsWith("/v1/swap")) {
        return new Promise<never>((_, reject) => input.signal!.addEventListener("abort", () => reject(new Error("ABORTED_SWAP_REQUEST")), { once: true }));
      }
      throw new Error(`UNEXPECTED_CASHU_ENDPOINT:${input.endpoint}`);
    };
    const adapter = new CashuTsSettlementAdapter({ request, now: () => "2026-08-04T12:00:00.000Z" });
    const commitment = [...new Uint8Array(await crypto.subtle.digest("SHA-256", adapterTokenWithoutDleq))].map((byte) => byte.toString(16).padStart(2, "0")).join("");
    const abort = new AbortController();
    const settling = adapter.settle({ topUpId: "default-adapter", policy: adapterPolicy, amount: "21", commitment, token: adapterTokenWithoutDleq, signal: abort.signal });
    setTimeout(() => abort.abort(), 5);

    expect(await settling).toEqual({ status: "unknown", operationReference: `cashu:${commitment}` });
    expect(seen.some(({ endpoint }) => endpoint.endsWith("/v1/swap"))).toBeTrue();
    expect(seen.every(({ signal }) => signal === abort.signal)).toBeTrue();
    const observeAbort = new AbortController();
    expect(await adapter.observe({ topUpId: "default-adapter", policy: adapterPolicy, amount: "21", commitment, token: adapterTokenWithoutDleq, signal: observeAbort.signal })).toMatchObject({ status: "verified", settlementReference: `cashu-swap:default-adapter:${commitment}` });
    expect(seen.find(({ endpoint }) => endpoint.endsWith("/v1/checkstate"))?.signal).toBe(observeAbort.signal);
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
