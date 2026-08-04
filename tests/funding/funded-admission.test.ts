import { describe, expect, test } from "bun:test";
import { FundedAdmissionService } from "../../src/funding/funded-admission";
import { AccountStatusService } from "../../src/funding/account-status";
import { FundingService } from "../../src/funding/funding-service";
import { TransactionalMemoryFundingStore } from "../../src/persistence/funding-store";
import type { FundingStore, FundingTransaction } from "../../src/persistence/funding-store";
import { createFundedCore } from "../../src/phase-03/funded-core";
import cashuFixture from "../fixtures/cashu-phase-03.json";
import { CashuMintPolicyRegistry } from "../../src/funding/cashu-mint-policy";
import { FakeCashuSettlementPort } from "../../src/funding/cashu-provider";
import { FakeLightningReceiptPort } from "../../src/funding/lightning-provider";

const principal = { pubkey: "b".repeat(64) };
const settlement = {
  topUpId: "topup-funded-admission", rail: "lightning" as const, unit: "sat" as const, amount: "300",
  externalReference: "external-funded-admission", settlementReference: "settlement-funded-admission", verifiedAt: "2026-08-04T00:00:00.000Z",
};

function creditCommand() {
  return { principal, kind: "credit_settlement" as const, idempotencyKey: "credit-funded-admission", policyVersion: "p1", protocolVersion: "v1", payload: { settlement } };
}

class FailOnceFundingStore implements FundingStore {
  transactions = 0;
  constructor(readonly inner: FundingStore, private readonly failOn: number) {}
  findRecordedResult(accountId: string, idempotencyKey: string) { return this.inner.findRecordedResult(accountId, idempotencyKey); }
  status(accountId: string) { return this.inner.status(accountId); }
  async transact<T>(accountId: string, operation: (transaction: FundingTransaction) => Promise<T> | T): Promise<T> {
    this.transactions += 1;
    if (this.transactions === this.failOn) throw new Error("INJECTED_POST_RESERVATION_PERSISTENCE_FAILURE");
    return this.inner.transact(accountId, operation);
  }
}

class FailReleaseFinalizationStore implements FundingStore {
  acceptAttempts = 0; releaseFinalizations = 0;
  constructor(readonly inner: FundingStore) {}
  findRecordedResult(accountId: string, idempotencyKey: string) { return this.inner.findRecordedResult(accountId, idempotencyKey); }
  status(accountId: string) { return this.inner.status(accountId); }
  transact<T>(accountId: string, operation: (transaction: FundingTransaction) => Promise<T> | T): Promise<T> {
    return this.inner.transact(accountId, (transaction) => operation({
      ...transaction,
      acceptFundedAdmission: async (input) => {
        this.acceptAttempts += 1;
        if (this.acceptAttempts === 1) throw new Error("FAIL_CAP_HOLD_AFTER_CAPACITY");
        return transaction.acceptFundedAdmission(input);
      },
      releaseCapacityIntent: async (intentReference) => {
        this.releaseFinalizations += 1;
        if (this.releaseFinalizations === 1) throw new Error("FAIL_5_RELEASE_INTENT_PERSISTENCE");
        return transaction.releaseCapacityIntent(intentReference);
      },
    }));
  }
}

class FailAvailableAndPreFenceStore implements FundingStore {
  transactions = 0; acceptAttempts = 0;
  constructor(readonly inner: FundingStore) {}
  findRecordedResult(accountId: string, idempotencyKey: string) { return this.inner.findRecordedResult(accountId, idempotencyKey); }
  status(accountId: string) { return this.inner.status(accountId); }
  async transact<T>(accountId: string, operation: (transaction: FundingTransaction) => Promise<T> | T): Promise<T> {
    this.transactions += 1;
    if (this.transactions === 3 || this.transactions === 4) throw new Error(`FAIL_${this.transactions}`);
    return this.inner.transact(accountId, (transaction) => operation({
      ...transaction,
      acceptFundedAdmission: async (input) => {
        this.acceptAttempts += 1;
        return transaction.acceptFundedAdmission(input);
      },
    }));
  }
}

describe("FundedAdmissionService", () => {
  test("requires a stable status cursor secret for a production generation composition", () => {
    expect(() => createFundedCore({ meteredService: {} as never })).toThrow("PRODUCTION_STATUS_CURSOR_SECRET_REQUIRED");
  });

  test("requires immediately usable capacity before taking a bounded cap hold", async () => {
    const store = new TransactionalMemoryFundingStore();
    const funding = new FundingService(store);
    await funding.execute(creditCommand());
    const capacity = {
      reserveNow: async () => ({ status: "available" as const, reference: "capacity:one", expiresAt: "2026-08-05T00:00:00.000Z" }),
      observe: async () => ({ status: "unknown" as const }),
      release: async () => undefined,
    };
    const admission = new FundedAdmissionService({ funding, store, capacity });
    const accepted = await admission.admit({ principal, idempotencyKey: "funded-admission", policyVersion: "p1", protocolVersion: "v1", payload: { requestedCap: "500", unit: "sat" } });
    expect(accepted).toMatchObject({ status: "accepted", approvedCap: "300", heldAmount: "300", reference: "capacity:one" });
    const budget = await admission.authorizeActionBudget({ principal, admissionReference: "capacity:one", idempotencyKey: "action-one", maximum: "200", unit: "sat" });
    expect(budget).toMatchObject({ status: "authorized", reservedAmount: "200", unit: "sat" });
    expect(store.postings).toHaveLength(1);
  });

  test("refuses unavailable capacity without a hold and reconciles ambiguity without a second reserve", async () => {
    const store = new TransactionalMemoryFundingStore();
    const funding = new FundingService(store);
    await funding.execute(creditCommand());
    let reserves = 0;
    let observations = 0;
    const capacity = {
      reserveNow: async () => { reserves += 1; throw new Error("timeout after effect"); },
      observe: async () => {
        observations += 1;
        return observations === 1 ? { status: "unknown" as const, reference: "capacity:ambiguous" } : { status: "available" as const, reference: "capacity:ambiguous", expiresAt: "2026-08-05T00:00:00.000Z" };
      },
      release: async () => undefined,
    };
    const admission = new FundedAdmissionService({ funding, store, capacity });
    const request = { principal, idempotencyKey: "ambiguous-admission", policyVersion: "p1", protocolVersion: "v1", payload: { requestedCap: "200", unit: "sat" as const } };
    expect(await admission.admit(request)).toMatchObject({ status: "reconciliation_pending" });
    expect(store.activeHolds).toHaveLength(0);
    expect(await admission.admit(request)).toMatchObject({ status: "accepted", heldAmount: "200" });
    expect(reserves).toBe(1);
    expect(observations).toBe(2);
    await expect(admission.authorizeActionBudget({ principal, admissionReference: "capacity:ambiguous", idempotencyKey: "too-large", maximum: "201", unit: "sat" })).rejects.toThrow("ACTION_BUDGET_EXCEEDS_APPROVED_CAP");
  });

  test("atomically fences concurrent capacity dispatch and rejects an expired lease", async () => {
    const store = new TransactionalMemoryFundingStore();
    const funding = new FundingService(store);
    await funding.execute(creditCommand());
    let reserves = 0; let release!: () => void;
    const started = new Promise<void>((resolve) => { release = resolve; });
    const capacity = {
      reserveNow: async () => { reserves += 1; await started; return { status: "available" as const, reference: "capacity:fenced", expiresAt: "2026-08-05T00:00:00.000Z" }; },
      observe: async () => ({ status: "unknown" as const }), release: async () => undefined,
    };
    const admission = new FundedAdmissionService({ funding, store, capacity, now: () => Date.parse("2026-08-04T00:00:00.000Z") });
    const request = { principal, idempotencyKey: "fenced", policyVersion: "p1", protocolVersion: "v1", payload: { requestedCap: "100", unit: "sat" as const } };
    const first = admission.admit(request);
    await new Promise<void>((resolve) => setTimeout(resolve, 0));
    expect(reserves).toBe(1);
    const second = admission.admit(request);
    release();
    const outcomes = await Promise.all([first, second]);
    expect(reserves).toBe(1);
    expect(outcomes.some((item) => item.status === "accepted")).toBe(true);

    const expiredStore = new TransactionalMemoryFundingStore(); const expiredFunding = new FundingService(expiredStore);
    await expiredFunding.execute(creditCommand());
    const expiredAdmission = new FundedAdmissionService({ funding: expiredFunding, store: expiredStore, capacity: {
      reserveNow: async () => ({ status: "available" as const, reference: "capacity:expired", expiresAt: "2026-08-03T23:59:59.000Z" }),
      observe: async () => ({ status: "unknown" as const }), release: async () => undefined,
    }, now: () => Date.parse("2026-08-04T00:00:00.000Z") });
    expect(await expiredAdmission.admit({ ...request, idempotencyKey: "expired" })).toMatchObject({ status: "refused" });
    expect(expiredStore.activeHolds).toHaveLength(0);

  });

  test("projects only the authenticated account and declares offline provider surfaces", async () => {
    const store = new TransactionalMemoryFundingStore();
    const funding = new FundingService(store);
    await funding.execute(creditCommand());
    const status = new AccountStatusService({
      store,
      sessions: { list: async () => ({ active: [{ id: "session:active" }], resumable: [{ id: "session:resume" }], pendingActions: [{ id: "action:pending", state: "authorized" }] }) },
    });
    const own = await status.status(principal);
    expect(own).toMatchObject({ available: "300", held: "0", activeSessions: [{ id: "session:active" }], resumableSessions: [{ id: "session:resume" }], pendingActions: [{ id: "action:pending", state: "authorized" }] });
    expect(JSON.stringify(own)).not.toMatch(/token|proof|preimage|invoice|secret|private/i);
    expect((await status.status({ pubkey: "c".repeat(64) })).available).toBe("0");
    const offline = createFundedCore({ testOnly: true, store, capacity: { reserveNow: async () => ({ status: "refused" as const }), observe: async () => ({ status: "unknown" as const }), release: async () => undefined } });
    expect(offline.mode).toBe("offline_design_ready");
    expect(offline.externalSurfaces).toEqual(expect.objectContaining({ modal: "unselected", contextvm: "blocked", lightning: "blocked", cashu: "blocked", postgres: "blocked" }));
  });

  test("aggregates owner-scoped pending, failed, reconciliation, and credited rail lifecycle state", async () => {
    const store = new TransactionalMemoryFundingStore();
    const funding = new FundingService(store);
    await funding.execute(creditCommand());
    const status = new AccountStatusService({
      store,
      sessions: { list: async () => ({ active: [], resumable: [], pendingActions: [] }) },
      rails: {
        list: async ({ accountId }) => accountId === (await funding.status(principal)).accountId ? [
          { topUpId: "lightning-pending", rail: "lightning", state: "pending", amount: "20", unit: "sat", createdAt: "2026-08-04T00:01:00.000Z", safeDisplayReference: "lightning:…pending" },
          { topUpId: "lightning-failed", rail: "lightning", state: "failed", amount: "30", unit: "sat", createdAt: "2026-08-04T00:02:00.000Z" },
          { topUpId: "cashu-reconcile", rail: "cashu", state: "reconciliation_pending", amount: "40", unit: "sat", createdAt: "2026-08-04T00:03:00.000Z" },
          { topUpId: settlement.topUpId, rail: "lightning", state: "credited", amount: settlement.amount, unit: "sat", createdAt: settlement.verifiedAt, verifiedAt: settlement.verifiedAt, settlementReference: settlement.settlementReference },
        ] : [],
      },
    } as never);

    const own = await status.status(principal);
    expect(own.topUps.map(({ topUpId, state }) => ({ topUpId, state }))).toEqual([
      { topUpId: settlement.topUpId, state: "credited" },
      { topUpId: "lightning-pending", state: "pending" },
      { topUpId: "lightning-failed", state: "failed" },
      { topUpId: "cashu-reconcile", state: "reconciliation_pending" },
    ]);
    expect(JSON.stringify(own)).not.toMatch(/token|proof|preimage|invoice|secret|private/i);
    expect((await status.status({ pubkey: "c".repeat(64) })).topUps).toEqual([]);
  });

  test("production composition rejects structural durability claims without a database-owned encrypted vault", () => {
    const pool = { connect: async () => { throw new Error("unused"); } };
    const transport = { configureAnnouncement: () => undefined, onInbound: () => undefined, canonicalInvocation: () => ({ invocationHash: "f".repeat(64) }), sendResponse: async () => undefined, sendNotification: async () => undefined };
    const capacity = { reserveNow: async () => ({ status: "refused" as const }), observe: async () => ({ status: "unknown" as const }), release: async () => undefined };
    const forgedLightning = { durable: true, begin: async () => ({ topUpId: "forged", state: "pending" }) };
    const forgedCashu = { durable: true, submit: async () => ({ topUpId: "forged", state: "verifying" }) };
    expect(() => createFundedCore({ postgresPool: pool, transport, capacity, lightning: forgedLightning, cashu: forgedCashu } as never)).toThrow("PRODUCTION_RAIL_COMPOSITION_REQUIRED");
  });

  test("production composition builds both durable rails around one database-owned AES-GCM vault", () => {
    const pool = { connect: async () => { throw new Error("unused"); } };
    const transport = { configureAnnouncement: () => undefined, onInbound: () => undefined, canonicalInvocation: () => ({ invocationHash: "f".repeat(64) }), sendResponse: async () => undefined, sendNotification: async () => undefined };
    const capacity = { reserveNow: async () => ({ status: "refused" as const }), observe: async () => ({ status: "unknown" as const }), release: async () => undefined };
    const lightningReceiver = new FakeLightningReceiptPort({ create: { status: "created", serviceReference: "receiver:compose", invoice: "lnbc-compose", invoiceIdentity: "compose", paymentHash: "compose", amount: "20", unit: "sat", expiresAt: "2026-08-05T00:00:00.000Z", safeDisplayReference: "lightning:…compose" } });
    const railOptions = { postgresPool: pool, transport, capacity, lightningReceiver, cashuProvider: new FakeCashuSettlementPort(), cashuPolicies: new CashuMintPolicyRegistry(cashuFixture.policies[0]!) };
    expect(createFundedCore({ ...railOptions, protectedMaterialKey: new Uint8Array(32).fill(8) }).mode).toBe("configured");
    expect(() => createFundedCore({ ...railOptions, protectedMaterialKey: new Uint8Array(31) })).toThrow("PROTECTED_MATERIAL_KEY_INVALID");
  });

  test("bounds capacity-provider waits and persists an ambiguous outcome", async () => {
    const store = new TransactionalMemoryFundingStore();
    const funding = new FundingService(store);
    await funding.execute(creditCommand());
    const never = () => new Promise<never>(() => undefined);
    const admission = new FundedAdmissionService({ funding, store, capacity: { reserveNow: never, observe: never, release: never }, capacityTimeoutMs: 5 });
    const observed = await Promise.race([
      admission.admit({ principal, idempotencyKey: "bounded-capacity", policyVersion: "p1", protocolVersion: "v1", payload: { requestedCap: "20", unit: "sat" } }),
      Bun.sleep(50).then(() => ({ status: "unbounded" as const })),
    ]);
    expect(observed).toMatchObject({ status: "reconciliation_pending" });
    expect(store.activeHolds).toHaveLength(0);
  });

  test("compensates capacity when observation or cap-hold persistence fails after reservation", async () => {
    for (const failOn of [3, 4]) {
      const inner = new TransactionalMemoryFundingStore();
      await new FundingService(inner).execute({ ...creditCommand(), idempotencyKey: `credit-compensation:${failOn}`, payload: { settlement: { ...settlement, topUpId: `topup-compensation:${failOn}`, externalReference: `external-compensation:${failOn}`, settlementReference: `settlement-compensation:${failOn}` } } });
      const store = new FailOnceFundingStore(inner, failOn);
      let reserves = 0; let releases = 0;
      const capacity = {
        reserveNow: async () => { reserves += 1; return { status: "available" as const, reference: `capacity:compensation:${failOn}`, expiresAt: "2026-08-05T00:00:00.000Z" }; },
        observe: async () => ({ status: "unknown" as const }),
        release: async () => { releases += 1; },
      };
      const admission = new FundedAdmissionService({ funding: new FundingService(store), store, capacity, now: () => Date.parse("2026-08-04T00:00:00.000Z") });
      const command = { principal, idempotencyKey: `compensation:${failOn}`, policyVersion: "p1", protocolVersion: "v1", payload: { requestedCap: "20", unit: "sat" as const } };
      expect(await admission.admit(command)).toMatchObject({ status: "refused" });
      expect(await admission.admit(command)).toMatchObject({ status: "refused" });
      expect(reserves).toBe(1);
      expect(releases).toBe(1);
      expect(inner.activeHolds).toHaveLength(0);
    }
  });

  test("retains durable ambiguity when post-reservation compensation cannot confirm release", async () => {
    const inner = new TransactionalMemoryFundingStore();
    await new FundingService(inner).execute({ ...creditCommand(), idempotencyKey: "credit-release-ambiguous", payload: { settlement: { ...settlement, topUpId: "topup-release-ambiguous", externalReference: "external-release-ambiguous", settlementReference: "settlement-release-ambiguous" } } });
    const store = new FailOnceFundingStore(inner, 4);
    let reserves = 0; let releases = 0; let observations = 0;
    const capacity = {
      reserveNow: async () => { reserves += 1; return { status: "available" as const, reference: "capacity:release-ambiguous", expiresAt: "2026-08-05T00:00:00.000Z" }; },
      observe: async () => { observations += 1; return { status: "unknown" as const, reference: "capacity:release-ambiguous" }; },
      release: async () => { releases += 1; throw new Error("CAPACITY_RELEASE_UNKNOWN"); },
    };
    const admission = new FundedAdmissionService({ funding: new FundingService(store), store, capacity, now: () => Date.parse("2026-08-04T00:00:00.000Z") });
    const command = { principal, idempotencyKey: "release-ambiguous", policyVersion: "p1", protocolVersion: "v1", payload: { requestedCap: "20", unit: "sat" as const } };
    expect(await admission.admit(command)).toMatchObject({ status: "reconciliation_pending" });
    expect(await admission.admit(command)).toMatchObject({ status: "reconciliation_pending" });
    expect({ reserves, releases, observations }).toEqual({ reserves: 1, releases: 1, observations: 1 });
    expect(inner.activeHolds).toHaveLength(0);
  });

  test("FAIL_4 cannot suppress external release after the available-state write fails", async () => {
    const inner = new TransactionalMemoryFundingStore();
    await new FundingService(inner).execute({ ...creditCommand(), idempotencyKey: "credit-fail-4", payload: { settlement: { ...settlement, topUpId: "topup-fail-4", externalReference: "external-fail-4", settlementReference: "settlement-fail-4" } } });
    const store = new FailAvailableAndPreFenceStore(inner);
    let reserves = 0; let releases = 0; let observations = 0;
    const capacity = {
      reserveNow: async () => { reserves += 1; return { status: "available" as const, reference: "capacity:fail-4", expiresAt: "2026-08-05T00:00:00.000Z" }; },
      release: async () => { releases += 1; },
      observe: async () => { observations += 1; return { status: "refused" as const, reason: "already-released" }; },
    };
    const admission = new FundedAdmissionService({ funding: new FundingService(store), store, capacity, now: () => Date.parse("2026-08-04T00:00:00.000Z") });
    const command = { principal, idempotencyKey: "fail-4", policyVersion: "p1", protocolVersion: "v1", payload: { requestedCap: "20", unit: "sat" as const } };

    expect(await admission.admit(command)).toMatchObject({ status: "refused" });
    expect(await admission.admit(command)).toMatchObject({ status: "refused" });
    expect({ reserves, releases, observations }).toEqual({ reserves: 1, releases: 1, observations: 0 });
    expect(store.acceptAttempts).toBe(0);
    expect(inner.activeHolds).toHaveLength(0);
  });

  test("FAIL_5 fences retry when external release succeeds but released-state persistence fails", async () => {
    const inner = new TransactionalMemoryFundingStore();
    await new FundingService(inner).execute({ ...creditCommand(), idempotencyKey: "credit-fail-5", payload: { settlement: { ...settlement, topUpId: "topup-fail-5", externalReference: "external-fail-5", settlementReference: "settlement-fail-5" } } });
    const store = new FailReleaseFinalizationStore(inner);
    let reserves = 0; let releases = 0; let observations = 0;
    const capacity = {
      reserveNow: async () => { reserves += 1; return { status: "available" as const, reference: "capacity:fail-5", expiresAt: "2026-08-05T00:00:00.000Z" }; },
      release: async () => { releases += 1; },
      observe: async () => { observations += 1; return { status: "refused" as const, reason: "already-released" }; },
    };
    const admission = new FundedAdmissionService({ funding: new FundingService(store), store, capacity, now: () => Date.parse("2026-08-04T00:00:00.000Z") });
    const command = { principal, idempotencyKey: "fail-5", policyVersion: "p1", protocolVersion: "v1", payload: { requestedCap: "20", unit: "sat" as const } };

    expect(await admission.admit(command)).toMatchObject({ status: "reconciliation_pending" });
    expect(await admission.admit(command)).toMatchObject({ status: "refused" });
    expect({ reserves, releases, observations }).toEqual({ reserves: 1, releases: 1, observations: 1 });
    expect(store.acceptAttempts).toBe(1);
    expect(inner.activeHolds).toHaveLength(0);
  });
});
