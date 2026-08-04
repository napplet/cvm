import { describe, expect, test } from "bun:test";
import { TransactionalMemoryFundingStore } from "../../src/persistence/funding-store";

describe("metered operation finalization", () => {
  test("records one replayable terminal settlement without duplicate financial effects", async () => {
    const store = new TransactionalMemoryFundingStore();
    const accountId = "account:metered-finalization";

    await store.transact(accountId, (tx) => tx.creditVerifiedSettlement({
      accountId,
      fingerprint: "credit:fingerprint",
      idempotencyKey: "credit:one",
      settlement: { topUpId: "topup:one", rail: "lightning", unit: "sat", amount: "20", externalReference: "external:one", settlementReference: "settlement:one", verifiedAt: "2026-08-04T00:00:00.000Z" },
    }));
    await store.transact(accountId, (tx) => tx.acceptFundedAdmission({ accountId, fingerprint: "admission:fingerprint", idempotencyKey: "admission:one", requestedCap: 10n, capacityReference: "admission:one" }));
    await store.transact(accountId, (tx) => tx.reserveActionBudget({ accountId, admissionReference: "admission:one", idempotencyKey: "budget:one", fingerprint: "budget:fingerprint", reference: "budget:one", amount: 10n }));

    const prepared = await store.transact(accountId, (tx) => tx.prepareMeteredAction({
      accountId,
      idempotencyKey: "action:one",
      fingerprint: "fingerprint:one",
      sessionId: "session:one",
      actionId: "action:one",
      expectedVersion: 0,
      admissionReference: "admission:one",
      actionBudgetReference: "budget:one",
      maximum: 10n,
      operationId: "operation:one",
      profileId: "profile:one",
      priceCardId: "card:one",
    }));

    expect(prepared.status).toBe("prepared");
    await store.transact(accountId, (tx) => tx.claimProviderOperation("operation:one"));
    await store.transact(accountId, (tx) => tx.recordUsageReceipt({ operationId: "operation:one", protectedEvidenceReference: "receipt:one" }));
    await expect(store.transact(accountId, (tx) => tx.finalizeMeteredAction({
      idempotencyKey: "action:one",
      operationId: "operation:one",
      receiptCharge: "4",
      providerReceiptReference: "receipt:one",
      status: "completed",
      result: { status: "completed" },
      sessionVersion: 1,
      artifactVersion: 1,
    }))).resolves.toMatchObject({ status: "completed", receiptCharge: "4" });

    const replay = await store.transact(accountId, (tx) => tx.finalizeMeteredAction({
      idempotencyKey: "action:one",
      operationId: "operation:one",
      receiptCharge: "4",
      providerReceiptReference: "receipt:one",
      status: "completed",
      result: { status: "completed" },
      sessionVersion: 1,
      artifactVersion: 1,
    }));

    expect(replay).toMatchObject({ status: "completed", receiptCharge: "4" });
    expect(store.meteredActions).toHaveLength(1);
    expect(store.postings.filter((posting) => posting.reference === "operation:one")).toHaveLength(1);
  });
});
