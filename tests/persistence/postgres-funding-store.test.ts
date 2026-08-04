import { describe, expect, test } from "bun:test";
import { FundingService } from "../../src/funding/funding-service";
import { DeterministicPostgresFundingExecutor, PostgresFundingStore } from "../../src/persistence/postgres-funding-store";

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
});
