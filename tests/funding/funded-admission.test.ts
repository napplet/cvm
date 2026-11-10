import type { ContextVmTransportPort } from "../../src/contextvm/sdk-bridge";
import type { ContextVmAnnouncement } from "../../src/contextvm/announcement";
import { describe, expect, test } from "bun:test";
import { FundedAdmissionService, type ReadyCapacityPort } from "../../src/funding/funded-admission";
import { AccountStatusService } from "../../src/funding/account-status";
import { FundingService } from "../../src/funding/funding-service";
import { TransactionalMemoryFundingStore } from "../../src/persistence/funding-store";
import type { FundingStore, FundingTransaction } from "../../src/persistence/funding-store";
import { exactReadyReservation, trustedAdmissionReceipt, trustedAdmissionReceiptAuthority } from "../fixtures/admission-ready";

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

  test("requires immediately usable capacity before taking a bounded cap hold", async () => {
    const store = new TransactionalMemoryFundingStore();
    const funding = new FundingService(store);
    await funding.execute(creditCommand());
    const capacity: ReadyCapacityPort = {
      reserveNow: async ({ intentReference }) => exactReadyReservation(intentReference, "capacity:one", "2026-08-05T00:00:00.000Z"),
      observe: async () => ({ status: "unknown" as const }),
      release: async () => undefined,
    };
    const admission = new FundedAdmissionService({ funding, store, capacity, receiptAuthority: trustedAdmissionReceiptAuthority, now: () => Date.parse("2026-08-04T00:00:00.000Z") });
    const command = { principal, idempotencyKey: "funded-admission", policyVersion: "p1", protocolVersion: "v1", payload: { requestedCap: "500", unit: "sat" as const } };
    const accepted = await admission.admit(command, await trustedAdmissionReceipt(command));
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
    const capacity: ReadyCapacityPort = {
      reserveNow: async () => { reserves += 1; throw new Error("timeout after effect"); },
      observe: async ({ intentReference }) => {
        observations += 1;
        return observations === 1 ? { status: "unknown" as const, reference: "capacity:ambiguous" } : exactReadyReservation(intentReference, "capacity:ambiguous", "2026-08-05T00:00:00.000Z");
      },
      release: async () => undefined,
    };
    const admission = new FundedAdmissionService({ funding, store, capacity, receiptAuthority: trustedAdmissionReceiptAuthority, now: () => Date.parse("2026-08-04T00:00:00.000Z") });
    const request = { principal, idempotencyKey: "ambiguous-admission", policyVersion: "p1", protocolVersion: "v1", payload: { requestedCap: "200", unit: "sat" as const } };
    expect(await admission.admit(request, await trustedAdmissionReceipt(request))).toMatchObject({ status: "reconciliation_pending" });
    expect(store.activeHolds).toHaveLength(0);
    expect(await admission.admit(request, await trustedAdmissionReceipt(request))).toMatchObject({ status: "accepted", heldAmount: "200" });
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
    let signalEntered!: () => void;
    const entered = new Promise<void>((resolve) => { signalEntered = resolve; });
    const capacity: ReadyCapacityPort = {
      reserveNow: async ({ intentReference }) => { reserves += 1; signalEntered(); await started; return exactReadyReservation(intentReference, "capacity:fenced", "2026-08-05T00:00:00.000Z"); },
      observe: async () => ({ status: "unknown" as const }), release: async () => undefined,
    };
    const admission = new FundedAdmissionService({ funding, store, capacity, receiptAuthority: trustedAdmissionReceiptAuthority, now: () => Date.parse("2026-08-04T00:00:00.000Z") });
    const request = { principal, idempotencyKey: "fenced", policyVersion: "p1", protocolVersion: "v1", payload: { requestedCap: "100", unit: "sat" as const } };
    const receipt = await trustedAdmissionReceipt(request);
    const first = admission.admit(request, receipt);
    await entered;
    expect(reserves).toBe(1);
    const second = admission.admit(request, receipt);
    release();
    const outcomes = await Promise.all([first, second]);
    expect(reserves).toBe(1);
    expect(outcomes.some((item) => item.status === "accepted")).toBe(true);

    const expiredStore = new TransactionalMemoryFundingStore(); const expiredFunding = new FundingService(expiredStore);
    await expiredFunding.execute(creditCommand());
    const expiredAdmission = new FundedAdmissionService({ funding: expiredFunding, store: expiredStore, capacity: {
      reserveNow: async ({ intentReference }) => exactReadyReservation(intentReference, "capacity:expired", "2026-08-03T23:59:59.000Z"),
      observe: async () => ({ status: "unknown" as const }), release: async () => undefined,
    }, receiptAuthority: trustedAdmissionReceiptAuthority, now: () => Date.parse("2026-08-04T00:00:00.000Z") });
    const expiredRequest = { ...request, idempotencyKey: "expired" };
    expect(await expiredAdmission.admit(expiredRequest, await trustedAdmissionReceipt(expiredRequest))).toMatchObject({ status: "refused" });
    expect(expiredStore.activeHolds).toHaveLength(0);

  });

  test("aggregates owner-scoped pending, failed, reconciliation, and credited rail lifecycle state", async () => {
    const store = new TransactionalMemoryFundingStore();
    const funding = new FundingService(store);
    await funding.execute(creditCommand());
    const status = new AccountStatusService({
      store,
      sessions: { list: async () => ({ active: [], resumable: [], pendingActions: [] }) },
      rails: {
        list: async ({ accountId }: { accountId: string }) => accountId === (await funding.status(principal)).accountId ? [
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

  test("bounds capacity-provider waits and persists an ambiguous outcome", async () => {
    const store = new TransactionalMemoryFundingStore();
    const funding = new FundingService(store);
    await funding.execute(creditCommand());
    const never = () => new Promise<never>(() => undefined);
    const admission = new FundedAdmissionService({ funding, store, capacity: { reserveNow: never, observe: never, release: never }, receiptAuthority: trustedAdmissionReceiptAuthority, capacityTimeoutMs: 5 });
    const command = { principal, idempotencyKey: "bounded-capacity", policyVersion: "p1", protocolVersion: "v1", payload: { requestedCap: "20", unit: "sat" as const } };
    const observed = await Promise.race([
      admission.admit(command, await trustedAdmissionReceipt(command)),
      Bun.sleep(1000).then(() => ({ status: "unbounded" as const })),
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
      const capacity: ReadyCapacityPort = {
        reserveNow: async ({ intentReference }) => { reserves += 1; return exactReadyReservation(intentReference, `capacity:compensation:${failOn}`, "2026-08-05T00:00:00.000Z"); },
        observe: async () => ({ status: "unknown" as const }),
        release: async () => { releases += 1; },
      };
      const admission = new FundedAdmissionService({ funding: new FundingService(store), store, capacity, receiptAuthority: trustedAdmissionReceiptAuthority, now: () => Date.parse("2026-08-04T00:00:00.000Z") });
      const command = { principal, idempotencyKey: `compensation:${failOn}`, policyVersion: "p1", protocolVersion: "v1", payload: { requestedCap: "20", unit: "sat" as const } };
      const receipt = await trustedAdmissionReceipt(command);
      expect(await admission.admit(command, receipt)).toMatchObject({ status: "refused" });
      expect(await admission.admit(command, receipt)).toMatchObject({ status: "refused" });
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
    const capacity: ReadyCapacityPort = {
      reserveNow: async ({ intentReference }) => { reserves += 1; return exactReadyReservation(intentReference, "capacity:release-ambiguous", "2026-08-05T00:00:00.000Z"); },
      observe: async () => { observations += 1; return { status: "unknown" as const, reference: "capacity:release-ambiguous" }; },
      release: async () => { releases += 1; throw new Error("CAPACITY_RELEASE_UNKNOWN"); },
      observeRelease: async () => { observations += 1; return { status: "unknown" }; },
    };
    const admission = new FundedAdmissionService({ funding: new FundingService(store), store, capacity, receiptAuthority: trustedAdmissionReceiptAuthority, now: () => Date.parse("2026-08-04T00:00:00.000Z") });
    const command = { principal, idempotencyKey: "release-ambiguous", policyVersion: "p1", protocolVersion: "v1", payload: { requestedCap: "20", unit: "sat" as const } };
    const receipt = await trustedAdmissionReceipt(command);
    expect(await admission.admit(command, receipt)).toMatchObject({ status: "reconciliation_pending" });
    expect(await admission.admit(command, receipt)).toMatchObject({ status: "reconciliation_pending" });
    expect({ reserves, releases, observations }).toEqual({ reserves: 1, releases: 1, observations: 1 });
    expect(inner.activeHolds).toHaveLength(0);
  });

  test("FAIL_4 preserves the original worker when the durable compensation fence is unavailable", async () => {
    const inner = new TransactionalMemoryFundingStore();
    await new FundingService(inner).execute({ ...creditCommand(), idempotencyKey: "credit-fail-4", payload: { settlement: { ...settlement, topUpId: "topup-fail-4", externalReference: "external-fail-4", settlementReference: "settlement-fail-4" } } });
    const store = new FailAvailableAndPreFenceStore(inner);
    let reserves = 0; let releases = 0; let observations = 0;
    const capacity: ReadyCapacityPort = {
      reserveNow: async ({ intentReference }) => { reserves += 1; return exactReadyReservation(intentReference, "capacity:fail-4", "2026-08-05T00:00:00.000Z"); },
      release: async () => { releases += 1; },
      observe: async ({ intentReference }) => { observations += 1; return exactReadyReservation(intentReference, "capacity:fail-4", "2026-08-05T00:00:00.000Z"); },
    };
    const admission = new FundedAdmissionService({ funding: new FundingService(store), store, capacity, receiptAuthority: trustedAdmissionReceiptAuthority, now: () => Date.parse("2026-08-04T00:00:00.000Z") });
    const command = { principal, idempotencyKey: "fail-4", policyVersion: "p1", protocolVersion: "v1", payload: { requestedCap: "20", unit: "sat" as const } };

    const receipt = await trustedAdmissionReceipt(command);
    expect(await admission.admit(command, receipt)).toMatchObject({ status: "reconciliation_pending" });
    expect(inner.activeHolds).toHaveLength(0);
    expect({ reserves, releases, observations }).toEqual({ reserves: 1, releases: 0, observations: 0 });
    expect(await admission.admit(command, receipt)).toMatchObject({ status: "accepted" });
    expect({ reserves, releases, observations }).toEqual({ reserves: 1, releases: 0, observations: 1 });
    expect(store.acceptAttempts).toBe(1);
    expect(inner.activeHolds).toHaveLength(1);
  });

  test("FAIL_5 fences retry when external release succeeds but released-state persistence fails", async () => {
    const inner = new TransactionalMemoryFundingStore();
    await new FundingService(inner).execute({ ...creditCommand(), idempotencyKey: "credit-fail-5", payload: { settlement: { ...settlement, topUpId: "topup-fail-5", externalReference: "external-fail-5", settlementReference: "settlement-fail-5" } } });
    const store = new FailReleaseFinalizationStore(inner);
    let reserves = 0; let releases = 0; let observations = 0;
    const capacity: ReadyCapacityPort = {
      reserveNow: async ({ intentReference }) => { reserves += 1; return exactReadyReservation(intentReference, "capacity:fail-5", "2026-08-05T00:00:00.000Z"); },
      release: async () => { releases += 1; },
      observe: async () => { observations += 1; return { status: "refused" as const, reason: "already-released" }; },
      observeRelease: async () => { observations += 1; return { status: "terminated" }; },
    };
    const admission = new FundedAdmissionService({ funding: new FundingService(store), store, capacity, receiptAuthority: trustedAdmissionReceiptAuthority, now: () => Date.parse("2026-08-04T00:00:00.000Z") });
    const command = { principal, idempotencyKey: "fail-5", policyVersion: "p1", protocolVersion: "v1", payload: { requestedCap: "20", unit: "sat" as const } };

    const receipt = await trustedAdmissionReceipt(command);
    expect(await admission.admit(command, receipt)).toMatchObject({ status: "reconciliation_pending" });
    expect(await admission.admit(command, receipt)).toMatchObject({ status: "refused" });
    expect({ reserves, releases, observations }).toEqual({ reserves: 1, releases: 1, observations: 1 });
    expect(store.acceptAttempts).toBe(1);
    expect(inner.activeHolds).toHaveLength(0);
  });
});
