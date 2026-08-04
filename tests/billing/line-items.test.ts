import { describe, expect, test } from "bun:test";
import { TransactionalMemoryFundingStore } from "../../src/persistence/funding-store";

describe("billing line-item history", () => {
  test("returns a stable explicit empty owner-scoped page", async () => {
    const store = new TransactionalMemoryFundingStore();

    await expect(store.listBillingLineItems("account:empty", { limit: 50 })).resolves.toEqual({
      items: [],
      nextCursor: undefined,
    });
  });

  test("orders immutable owner-scoped decimal projections through bounded cursors", async () => {
    const store = new TransactionalMemoryFundingStore();
    const accountId = "account:history";
    await store.transact(accountId, (tx) => tx.creditVerifiedSettlement({
      accountId, fingerprint: "credit:fingerprint", idempotencyKey: "credit:history",
      settlement: { topUpId: "topup:history", rail: "cashu", unit: "sat", amount: "20", externalReference: "external:history", settlementReference: "settlement:history", verifiedAt: "2026-08-04T00:00:00.000Z" },
    }));
    await store.transact(accountId, (tx) => tx.acceptFundedAdmission({ accountId, fingerprint: "hold:fingerprint", idempotencyKey: "hold:history", requestedCap: 10n, capacityReference: "hold:history" }));
    await store.transact(accountId, (tx) => tx.reserveActionBudget({ accountId, admissionReference: "hold:history", idempotencyKey: "budget:history", fingerprint: "budget:fingerprint", reference: "budget:history", amount: 5n }));

    const first = await store.listBillingLineItems(accountId, { limit: 1 });
    const next = await store.listBillingLineItems(accountId, { limit: 1, cursor: first.nextCursor });
    const last = await store.listBillingLineItems(accountId, { limit: 50, cursor: next.nextCursor });

    expect(first.items).toHaveLength(1);
    expect(next.items).toHaveLength(1);
    expect(last.items).toHaveLength(1);
    expect(last.nextCursor).toBeUndefined();
    expect([...first.items, ...next.items, ...last.items].map((item) => item.kind)).toEqual(["credit", "cap_hold", "action_reservation"]);
    expect([...first.items, ...next.items, ...last.items].every((item) => /^(0|[1-9][0-9]*)$/.test(item.settledAvailable) && /^(0|[1-9][0-9]*)$/.test(item.held))).toBe(true);
    await expect(store.listBillingLineItems(accountId, { limit: 0 })).rejects.toThrow("BILLING_LINE_ITEM_PAGE_LIMIT_INVALID");
  });
});
