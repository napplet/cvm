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
});
