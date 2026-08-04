import { describe, expect, test } from "bun:test";
import { FundedAdmissionService } from "../../src/funding/funded-admission";
import { FundingService } from "../../src/funding/funding-service";
import { TransactionalMemoryFundingStore } from "../../src/persistence/funding-store";

const principal = { pubkey: "b".repeat(64) };
const settlement = {
  topUpId: "topup-funded-admission", rail: "lightning" as const, unit: "sat" as const, amount: "300",
  externalReference: "external-funded-admission", settlementReference: "settlement-funded-admission", verifiedAt: "2026-08-04T00:00:00.000Z",
};

function creditCommand() {
  return { principal, kind: "credit_settlement" as const, idempotencyKey: "credit-funded-admission", policyVersion: "p1", protocolVersion: "v1", payload: { settlement } };
}

describe("FundedAdmissionService", () => {
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
});
