import { describe, expect, test } from "bun:test";
import { FundingService } from "../../src/funding/funding-service";
import { FundedAdmissionService } from "../../src/funding/funded-admission";
import { DeterministicPostgresFundingExecutor, PostgresFundingStore } from "../../src/persistence/postgres-funding-store";
import { exactReadyReservation, trustedAdmissionReceipt, trustedAdmissionReceiptAuthority } from "../fixtures/admission-ready";

const principal = { pubkey: "a".repeat(64) };
const credited = (idempotencyKey = "credit-1", amount = "100") => ({
  kind: "credit_settlement", principal, idempotencyKey, policyVersion: "p1", protocolVersion: "v1",
  payload: { settlement: { topUpId: "topup-1", rail: "lightning", unit: "sat", amount, externalReference: "external-1", settlementReference: "settlement-1", verifiedAt: "2026-08-04T00:00:00.000Z" } },
} as const);
const admission = (idempotencyKey = "admit-1", cap = "60") => ({
  kind: "funded_admission", principal, idempotencyKey, policyVersion: "p1", protocolVersion: "v1",
  payload: { requestedCap: cap, unit: "sat", capacity: { reference: "capacity-1", usable: true } },
} as const);

describe("PostgresFundingStore", () => {
  test("exposes the same metered store authority as the SQL adapter", async () => {
    const store = new PostgresFundingStore(new DeterministicPostgresFundingExecutor());
    expect(typeof (store as unknown as { findMeteredAction?: unknown }).findMeteredAction).toBe("function");
    expect(typeof (store as unknown as { listBillingLineItems?: unknown }).listBillingLineItems).toBe("function");
  });

  test("replays across a fresh store instance and rejects changed fingerprints", async () => {
    const executor = new DeterministicPostgresFundingExecutor();
    const first = new FundingService(new PostgresFundingStore(executor));
    const second = new FundingService(new PostgresFundingStore(executor));
    expect(await first.execute(credited())).toMatchObject({ status: "credited", creditedAmount: "100" });
    expect(await second.execute(credited())).toMatchObject({ status: "credited", creditedAmount: "100" });
    await expect(second.execute(credited("credit-1", "101"))).rejects.toThrow("IDEMPOTENCY_KEY_CONFLICT");
    expect(executor.snapshot().ledgerTransactions).toHaveLength(1);
  });

  test("enforces settlement uniqueness, balanced postings, projection recomputation, and rollback", async () => {
    const executor = new DeterministicPostgresFundingExecutor();
    const service = new FundingService(new PostgresFundingStore(executor));
    await service.execute(credited());
    await expect(service.execute({ ...credited("credit-2"), payload: { settlement: { ...credited().payload.settlement, topUpId: "topup-2" } } })).rejects.toThrow("SETTLEMENT_REFERENCE_CONFLICT");
    expect(executor.recomputeProjection()).toEqual(executor.snapshot().projection);
    expect(executor.snapshot().ledgerTransactions[0]?.balanced).toBeTrue();
    executor.failNextCommit();
    await expect(service.execute(admission())).rejects.toThrow("INJECTED_TRANSACTION_FAILURE");
    expect(executor.snapshot().holds).toHaveLength(0);
    expect(executor.snapshot().outbox).toHaveLength(1);
  });

  test("prevents concurrent admissions from exceeding settled balance and leaves no hold when capacity is refused", async () => {
    const executor = new DeterministicPostgresFundingExecutor();
    const service = new FundingService(new PostgresFundingStore(executor));
    await service.execute(credited());
    const [left, right] = await Promise.allSettled([service.execute(admission("admit-left", "70")), service.execute(admission("admit-right", "70"))]);
    expect([left, right].filter((result) => result.status === "fulfilled")).toHaveLength(2);
    const status = await service.status(principal);
    expect(status.held).toBe("100");
    await expect(service.execute({ ...admission("refused"), payload: { ...admission().payload, capacity: { reference: "capacity-refused", usable: false } } })).rejects.toThrow("CAPACITY_UNAVAILABLE");
    expect(executor.snapshot().holds.every((hold) => hold.reference !== "capacity-refused")).toBeTrue();
  });

  test("retries only SQL serialization conflicts and never runs an external effect in the retry closure", async () => {
    const executor = new DeterministicPostgresFundingExecutor({ serializationFailures: 1 });
    const store = new PostgresFundingStore(executor, { maxAttempts: 2, deadlineMs: 1_000 });
    const service = new FundingService(store);
    await service.execute(credited());
    expect(executor.retryAttempts).toBe(2);
    expect(executor.externalEffectCount).toBe(0);
  });

  test("persists capacity ambiguity and action budgets across fresh funded-admission services", async () => {
    const executor = new DeterministicPostgresFundingExecutor();
    const firstStore = new PostgresFundingStore(executor);
    await new FundingService(firstStore).execute(credited());
    let reserveCount = 0;
    const ambiguousCapacity = {
      reserveNow: async () => { reserveCount += 1; throw new Error("response lost"); },
      observe: async () => ({ status: "unknown" as const, reference: "capacity:durable" }),
      release: async () => undefined,
    };
    const command = { principal, idempotencyKey: "durable-admission", policyVersion: "p1", protocolVersion: "v1", payload: { requestedCap: "80", unit: "sat" as const } };
    const receipt = await trustedAdmissionReceipt(command);
    expect(await new FundedAdmissionService({ funding: new FundingService(firstStore), store: firstStore, capacity: ambiguousCapacity, receiptAuthority: trustedAdmissionReceiptAuthority }).admit(command, receipt)).toMatchObject({ status: "reconciliation_pending" });
    const resumedStore = new PostgresFundingStore(executor);
    const resumedCapacity = { reserveNow: async ({ intentReference }: { intentReference: string }) => { reserveCount += 1; return exactReadyReservation(intentReference, "wrong", "2026-08-05T00:00:00.000Z"); }, observe: async ({ intentReference }: { intentReference: string }) => exactReadyReservation(intentReference, "capacity:durable", "2026-08-05T00:00:00.000Z"), release: async () => undefined };
    const resumed = new FundedAdmissionService({ funding: new FundingService(resumedStore), store: resumedStore, capacity: resumedCapacity, receiptAuthority: trustedAdmissionReceiptAuthority, now: () => Date.parse("2026-08-04T00:00:00.000Z") });
    expect(await resumed.admit(command, receipt)).toMatchObject({ status: "accepted", heldAmount: "80" });
    expect(reserveCount).toBe(1);
    const budget = await resumed.authorizeActionBudget({ principal, admissionReference: "capacity:durable", idempotencyKey: "durable-action", maximum: "40", unit: "sat" });
    const replay = await new FundedAdmissionService({ funding: new FundingService(new PostgresFundingStore(executor)), store: new PostgresFundingStore(executor), capacity: resumedCapacity, receiptAuthority: trustedAdmissionReceiptAuthority }).authorizeActionBudget({ principal, admissionReference: "capacity:durable", idempotencyKey: "durable-action", maximum: "40", unit: "sat" });
    expect(replay).toEqual(budget);
    await expect(resumed.authorizeActionBudget({ principal, admissionReference: "capacity:durable", idempotencyKey: "durable-action", maximum: "41", unit: "sat" })).rejects.toThrow("IDEMPOTENCY_KEY_CONFLICT");
    expect(executor.snapshot().capacityIntents).toHaveLength(1);
    expect(executor.snapshot().actionBudgets).toHaveLength(1);
  });
});
