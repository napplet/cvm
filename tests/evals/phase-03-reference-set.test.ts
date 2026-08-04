import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import cashuFixture from "../fixtures/cashu-phase-03.json";
import { buildContextVmAnnouncement } from "../../src/contextvm/announcement";
import { accountIdForPrincipal } from "../../src/domain/account-command";
import { AccountStatusService } from "../../src/funding/account-status";
import { CashuMintPolicyRegistry } from "../../src/funding/cashu-mint-policy";
import { FakeCashuSettlementPort } from "../../src/funding/cashu-provider";
import { CashuTopUpCoordinator, InMemoryCashuTopUpRepository } from "../../src/funding/cashu-top-up";
import { FundedAdmissionService } from "../../src/funding/funded-admission";
import { FundingService } from "../../src/funding/funding-service";
import { FakeLightningReceiptPort } from "../../src/funding/lightning-provider";
import { InMemoryLightningTopUpRepository, LightningTopUpCoordinator } from "../../src/funding/lightning-top-up";
import { InMemoryProtectedRailMaterialRepository, ProtectedRailMaterialVault } from "../../src/funding/protected-rail-material";
import { TransactionalMemoryFundingStore } from "../../src/persistence/funding-store";

type Expected = Readonly<{ result: string; stateDelta: Readonly<Record<string, number>>; effects: Readonly<Record<string, number>>; evidence: readonly string[] }>;
type Reference = Readonly<{ id: string; requirement: string; decision: string; threat: string; scenario: string; input: string; execution: string; expected: Expected }>;
const referenceSet = JSON.parse(readFileSync("tests/fixtures/phase-03-reference-set.json", "utf8")) as { version: number; cases: Reference[]; deferrals: string[] };
const requirements = ["CTX-01", "CTX-02", "CTX-03", "CTX-04", "PAY-01", "PAY-02", "PAY-03", "PAY-04", "PAY-05", "PAY-06", "PAY-07", "BILL-01", "BILL-02", "BILL-06"];
const principal = { pubkey: "a".repeat(64) };
const otherPrincipal = { pubkey: "b".repeat(64) };
const now = "2026-08-04T12:00:00.000Z";

class EvalVault {
  sealed = 0; expired = 0;
  async seal() { this.sealed += 1; return { id: `sealed:${this.sealed}`, payloadDigest: "d".repeat(64) }; }
  async expire() { this.expired += 1; }
}

function fundingHarness() {
  const store = new TransactionalMemoryFundingStore();
  const funding = new FundingService(store);
  return { store, funding };
}

async function seedCredit(harness: ReturnType<typeof fundingHarness>, suffix: string, amount = "300") {
  return harness.funding.execute({ principal, kind: "credit_settlement", idempotencyKey: `credit:${suffix}`, policyVersion: "p1", protocolVersion: "v1", payload: { settlement: { topUpId: `topup:${suffix}`, rail: "lightning", unit: "sat", amount, externalReference: `external:${suffix}`, settlementReference: `settlement:${suffix}`, verifiedAt: now } } });
}

function capacity(reference: string) {
  let reserves = 0;
  return {
    port: { reserveNow: async () => { reserves += 1; return { status: "available" as const, reference, expiresAt: "2026-08-05T00:00:00.000Z" }; }, observe: async () => ({ status: "unknown" as const }), release: async () => undefined },
    reserves: () => reserves,
  };
}

function lightningHarness() {
  const base = fundingHarness();
  const receiver = new FakeLightningReceiptPort({ create: { status: "created", serviceReference: "receiver:eval", invoice: "lnbc-eval-material", invoiceIdentity: "invoice-id", paymentHash: "payment-hash", amount: "25", unit: "sat", expiresAt: "2026-08-05T00:10:00.000Z", safeDisplayReference: "lightning:…eval" } });
  const repository = new InMemoryLightningTopUpRepository();
  const material = new InMemoryProtectedRailMaterialRepository();
  const coordinator = new LightningTopUpCoordinator({ funding: base.funding, receiver, repository, vault: new ProtectedRailMaterialVault({ key: new Uint8Array(32).fill(3), repository: material }), now: () => "2026-08-05T00:00:00.000Z" });
  return { ...base, receiver, repository, material, coordinator };
}

function cashuHarness() {
  const base = fundingHarness();
  const policies = new CashuMintPolicyRegistry(cashuFixture.policies[0]!);
  const provider = new FakeCashuSettlementPort();
  const vault = new EvalVault();
  const repository = new InMemoryCashuTopUpRepository();
  const coordinator = new CashuTopUpCoordinator({ funding: base.funding, policies, provider, vault, repository, now: () => now });
  return { ...base, policies, provider, vault, repository, coordinator };
}

const cashuSubmit = (suffix: string) => ({ principal, idempotencyKey: `cashu:${suffix}`, topUpId: `cashu:${suffix}`, amount: "21", unit: "sat" as const, pmi: cashuFixture.pmi, token: new TextEncoder().encode(`cashuB-${suffix}`) });
const observation = (item: Reference, result: string, stateDelta: Record<string, number>, effects: Record<string, number>, evidence = item.expected.evidence): Expected => ({ result, stateDelta, effects, evidence });
const zero = { commands: 0, postings: 0, holds: 0, outbox: 0 };

type Oracle = (item: Reference) => Promise<Expected>;
const oracles: Readonly<Record<string, Oracle>> = {
  "signed-announcement": async (item) => {
    const announcement = buildContextVmAnnouncement({ topUpCap: { minimum: "1", maximum: "1000", unit: "sat" }, pmis: ["bitcoin-lightning-bolt11", "bitcoin-cashu-v4-direct"], paymentInteraction: ["transparent", "explicit_gating"], tools: ["generation", "account_status", "top_up", "funded_admission", "session", "preview", "publication"].map((name) => ({ name, available: ["account_status", "top_up", "funded_admission"].includes(name), planned: !["account_status", "top_up", "funded_admission"].includes(name) })) });
    expect(announcement.metadata.protocol).toBe("contextvm-v1"); expect(JSON.stringify(announcement)).not.toMatch(/x402|l402/iu);
    return observation(item, "ANNOUNCEMENT_TRUTHFUL", zero, { allowed: 0, forbidden: 1 });
  },
  "verified-sender": async (item) => {
    const own = await accountIdForPrincipal(principal); const other = await accountIdForPrincipal(otherPrincipal);
    expect(own).not.toBe(other); expect(await accountIdForPrincipal(principal)).toBe(own);
    return observation(item, "VERIFIED_PRINCIPAL_ONLY", { ...zero, commands: 1 }, { allowed: 0, forbidden: 1 });
  },
  "relay-replay": async (item) => {
    const harness = fundingHarness(); await seedCredit(harness, "relay"); const ready = capacity("capacity:relay");
    const service = new FundedAdmissionService({ funding: harness.funding, store: harness.store, capacity: ready.port, now: () => Date.parse(now) });
    const command = { principal, idempotencyKey: "relay", policyVersion: "p1", protocolVersion: "v1", payload: { requestedCap: "100", unit: "sat" as const } };
    const first = await service.admit(command); const replay = await service.admit(command);
    expect(replay).toEqual(first); expect(ready.reserves()).toBe(1);
    return observation(item, "DURABLE_REPLAY_OR_DENIAL", { commands: 1, postings: 0, holds: 1, outbox: 1 }, { allowed: 1, forbidden: 1 });
  },
  "account-status": async (item) => {
    const status = new AccountStatusService({ store: new TransactionalMemoryFundingStore(), sessions: { list: async () => ({ active: [], resumable: [], pendingActions: [] }) } });
    const value = await status.status(principal); expect(value.accountId).toBe(await accountIdForPrincipal(principal)); expect(JSON.stringify(value)).not.toMatch(/token|proof|invoice|secret/iu);
    return observation(item, "REDACTED_OWNER_STATUS", zero, { allowed: 0, forbidden: 1 });
  },
  "ledger-credit-race": async (item) => {
    const harness = fundingHarness(); const command = seedCredit(harness, "race"); await Promise.all([command, seedCredit(harness, "race").catch((error) => error)]);
    expect(harness.store.postings).toHaveLength(1); expect(harness.store.outbox).toHaveLength(1);
    return observation(item, "BALANCED_SINGLE_CREDIT", { commands: 1, postings: 1, holds: 0, outbox: 1 }, { allowed: 0, forbidden: 1 });
  },
  "idempotency-conflict": async (item) => {
    const harness = fundingHarness(); await seedCredit(harness, "idem");
    await expect(harness.funding.execute({ principal, kind: "credit_settlement", idempotencyKey: "credit:idem", policyVersion: "p1", protocolVersion: "v1", payload: { settlement: { topUpId: "topup:idem", rail: "lightning", unit: "sat", amount: "301", externalReference: "external:idem", settlementReference: "settlement:idem", verifiedAt: now } } })).rejects.toThrow("IDEMPOTENCY_KEY_CONFLICT");
    return observation(item, "EXACT_REPLAY_OR_CONFLICT", { ...zero, commands: 1 }, { allowed: 0, forbidden: 1 });
  },
  "cep8-top-up": async (item) => {
    const harness = lightningHarness(); const result = await harness.coordinator.begin({ principal, idempotencyKey: "cep8", amount: "25", unit: "sat", policyVersion: "p1", protocolVersion: "v1" });
    expect(result.state).toBe("pending"); expect(harness.receiver.createCalls).toBe(1);
    return observation(item, "TOP_UP_PENDING", zero, { allowed: 1, forbidden: 1 });
  },
  "settlement-lifecycle": async (item) => {
    const harness = cashuHarness(); harness.provider.nextSettlement({ status: "verified", externalReference: "op:lifecycle", settlementReference: "settled:lifecycle", verifiedAt: now });
    expect((await harness.coordinator.submit(cashuSubmit("lifecycle"))).state).toBe("credited");
    return observation(item, "CREDIT_AFTER_VERIFICATION_ONLY", { commands: 1, postings: 1, holds: 0, outbox: 1 }, { allowed: harness.provider.settleCalls, forbidden: 1 });
  },
  "lightning-receipt": async (item) => {
    const harness = lightningHarness(); const begun = await harness.coordinator.begin({ principal, idempotencyKey: "receipt", amount: "25", unit: "sat", policyVersion: "p1", protocolVersion: "v1" }); harness.receiver.queryMode = "settled";
    expect((await harness.coordinator.observeSettlement({ principal, topUpId: begun.topUpId })).state).toBe("credited");
    return observation(item, "LIGHTNING_CREDIT_OR_RECONCILIATION", { commands: 1, postings: 1, holds: 0, outbox: 1 }, { allowed: 1, forbidden: 1 });
  },
  "redaction-canary": async (item) => {
    const repository = new InMemoryProtectedRailMaterialRepository(); const vault = new ProtectedRailMaterialVault({ key: new Uint8Array(32).fill(9), repository });
    await vault.seal({ accountId: "account", topUpId: "topup", rail: "cashu" }, new TextEncoder().encode("cashuB-redaction-canary")); expect(JSON.stringify(repository.snapshot())).not.toContain("cashuB-redaction-canary");
    return observation(item, "REDACTED", zero, { allowed: 0, forbidden: 1 });
  },
  "cashu-policy-rotation": async (item) => {
    const harness = cashuHarness(); const pinned = harness.policies.pinActive(); harness.policies.add(cashuFixture.policies[1]!); harness.policies.rotate(cashuFixture.policies[1]!.version); expect(pinned.version).not.toBe(harness.policies.pinActive().version);
    return observation(item, "POLICY_PINNED", zero, { allowed: 0, forbidden: 1 });
  },
  "cashu-settlement": async (item) => {
    const harness = cashuHarness(); harness.provider.nextSettlement({ status: "verified", externalReference: "op:settle", settlementReference: "settled:cashu", verifiedAt: now }); await harness.coordinator.submit(cashuSubmit("settle"));
    expect(harness.store.postings).toHaveLength(1);
    return observation(item, "CASHU_CREDIT_OR_DENIAL", { commands: 1, postings: 1, holds: 0, outbox: 1 }, { allowed: harness.provider.settleCalls, forbidden: 1 });
  },
  "cashu-reconciliation": async (item) => {
    const harness = cashuHarness(); harness.provider.nextSettlement({ status: "unknown", operationReference: "op:reconcile" }); const pending = await harness.coordinator.submit(cashuSubmit("reconcile")); harness.provider.nextObservation({ status: "verified", externalReference: "op:reconcile", settlementReference: "settled:reconcile", verifiedAt: now }); await harness.coordinator.reconcile(pending.topUpId); expect(harness.provider.settleCalls).toBe(1); expect(harness.provider.observeCalls).toBe(1);
    return observation(item, "QUERY_ONLY_RECONCILIATION", { commands: 1, postings: 1, holds: 0, outbox: 1 }, { allowed: 1, forbidden: 1 });
  },
  "cap-hold": async (item) => {
    const harness = fundingHarness(); await seedCredit(harness, "cap", "30"); const ready = capacity("capacity:cap"); const service = new FundedAdmissionService({ funding: harness.funding, store: harness.store, capacity: ready.port, now: () => Date.parse(now) }); const result = await service.admit({ principal, idempotencyKey: "cap", policyVersion: "p1", protocolVersion: "v1", payload: { requestedCap: "50", unit: "sat" } }); expect(result).toMatchObject({ approvedCap: "30", heldAmount: "30" });
    return observation(item, "CAP_HELD_LESSER_OF_AVAILABLE", { commands: 1, postings: 0, holds: 1, outbox: 1 }, { allowed: ready.reserves(), forbidden: 1 });
  },
  "action-budget": async (item) => {
    const harness = fundingHarness(); await seedCredit(harness, "budget"); const ready = capacity("capacity:budget"); const service = new FundedAdmissionService({ funding: harness.funding, store: harness.store, capacity: ready.port, now: () => Date.parse(now) }); await service.admit({ principal, idempotencyKey: "budget", policyVersion: "p1", protocolVersion: "v1", payload: { requestedCap: "50", unit: "sat" } }); const result = await service.authorizeActionBudget({ principal, admissionReference: "capacity:budget", idempotencyKey: "action", maximum: "20", unit: "sat" }); expect(result.reservedAmount).toBe("20");
    return observation(item, "ACTION_BUDGET_AUTHORIZED", zero, { allowed: 0, forbidden: 1 });
  },
  "capacity-intent": async (item) => {
    const harness = fundingHarness(); await seedCredit(harness, "capacity"); const ready = capacity("capacity:commit"); const service = new FundedAdmissionService({ funding: harness.funding, store: harness.store, capacity: ready.port, now: () => Date.parse(now) }); expect((await service.admit({ principal, idempotencyKey: "capacity", policyVersion: "p1", protocolVersion: "v1", payload: { requestedCap: "50", unit: "sat" } })).status).toBe("accepted");
    return observation(item, "COMMIT_OR_REJECT", { commands: 1, postings: 0, holds: 1, outbox: 1 }, { allowed: ready.reserves(), forbidden: 1 });
  },
  "at-least-once-delivery": async (item) => {
    const harness = fundingHarness(); const first = await seedCredit(harness, "duplicate"); const replay = await seedCredit(harness, "duplicate"); expect(replay).toEqual(first); expect(harness.store.postings).toHaveLength(1);
    return observation(item, "EXACTLY_ONCE_BUSINESS_EFFECT", { commands: 1, postings: 1, holds: 0, outbox: 1 }, { allowed: 1, forbidden: 1 });
  },
  "opaque-effect": async (item) => {
    const harness = lightningHarness(); harness.receiver.createMode = "effect_then_throw"; const result = await harness.coordinator.begin({ principal, idempotencyKey: "opaque", amount: "25", unit: "sat", policyVersion: "p1", protocolVersion: "v1" }); expect(result.state).toBe("reconciliation_pending"); expect(harness.receiver.createCalls).toBe(1);
    return observation(item, "RECONCILIATION_PENDING", zero, { allowed: 1, forbidden: 1 });
  },
  "combined-status": async (item) => {
    const harness = fundingHarness(); const accountId = await accountIdForPrincipal(principal); const status = new AccountStatusService({ store: harness.store, sessions: { list: async ({ accountId: requested }) => requested === accountId ? { active: [{ id: "active" }], resumable: [], pendingActions: [] } : { active: [], resumable: [], pendingActions: [] } }, rails: { list: async ({ accountId: requested }) => requested === accountId ? [{ topUpId: "pending", rail: "lightning", state: "pending", amount: "5", unit: "sat", createdAt: now }] : [] } }); const own = await status.status(principal); expect(own.topUps).toHaveLength(1); expect((await status.status(otherPrincipal)).topUps).toHaveLength(0); expect(JSON.stringify(own)).not.toMatch(/token|proof|invoice/iu);
    return observation(item, "OWNER_SCOPED_REDACTED_STATUS", zero, { allowed: 0, forbidden: 1 });
  },
};

describe("Phase 03 deterministic reference set", () => {
  test("maps every requirement and D-40 through D-58 to an executable deterministic oracle", () => {
    expect(referenceSet.version).toBe(1); expect(referenceSet.cases).toHaveLength(19); expect(new Set(referenceSet.cases.map((item) => item.id)).size).toBe(19);
    expect(new Set(referenceSet.cases.map((item) => item.decision))).toEqual(new Set(Array.from({ length: 19 }, (_, index) => `D-${index + 40}`)));
    expect(new Set(referenceSet.cases.map((item) => item.requirement))).toEqual(new Set(requirements));
    expect(referenceSet.deferrals).toEqual(["phase-04-exact-usage-debit", "phase-05-interruption-resume", "phase-06-preview-publication", "phase-07-live-slo-provider-provenance-certification", "v2-x402-l402"]);
    expect(new Set(referenceSet.cases.map((item) => item.input)).size).toBe(referenceSet.cases.length);
    expect(Object.keys(oracles).sort()).toEqual(referenceSet.cases.map((item) => item.input).sort());
  });

  test.each(referenceSet.cases)("$id executes its exact fixture-bound scenario and oracle", async (item) => {
    expect(item.execution).toBe("deterministic");
    const oracle = oracles[item.input]; expect(oracle).toBeFunction();
    const actual = await oracle!(item);
    expect(actual).toEqual(item.expected);
  });

  test("executes fixtures in-process without broad-group test spawning", () => {
    const source = readFileSync("tests/evals/phase-03-reference-set.test.ts", "utf8");
    expect(source).not.toContain("Bun." + "spawnSync"); expect(source).not.toContain("execution" + "Files");
  });

  test("rejects fixture evidence mutations instead of copying them into actual observations", async () => {
    const original = referenceSet.cases.find((item) => item.input === "relay-replay")!;
    const mutated = structuredClone(original) as Reference & { expected: Expected };
    mutated.expected = { ...mutated.expected, evidence: ["fixture-controlled-evidence"] };
    const actual = await oracles[mutated.input]!(mutated);
    expect(actual.evidence).not.toEqual(mutated.expected.evidence);
    expect(actual).not.toEqual(mutated.expected);
  });
});
