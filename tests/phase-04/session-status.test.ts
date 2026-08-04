import { describe, expect, test } from "bun:test";
import { accountIdForPrincipal } from "../../src/domain/account-command";
import { FundingService } from "../../src/funding/funding-service";
import { TransactionalMemoryFundingStore } from "../../src/persistence/funding-store";
import { BillingHistoryPageSchema, readSessionStatus, SessionStatusQuerySchema } from "../../src/phase-04/session-status";

const owner = { pubkey: "ab".repeat(32) };
const stranger = { pubkey: "cd".repeat(32) };

async function creditedStore(): Promise<TransactionalMemoryFundingStore> {
  const store = new TransactionalMemoryFundingStore();
  const funding = new FundingService(store);
  await funding.execute({
    principal: owner,
    kind: "credit_settlement",
    idempotencyKey: "status-credit",
    policyVersion: "funding-policy-v1",
    protocolVersion: "funding-contract-v1",
    payload: { settlement: {
      topUpId: "status-topup", rail: "lightning", unit: "sat", amount: "900719925474099312345",
      externalReference: "status-external", settlementReference: "status-settlement", verifiedAt: "2026-08-04T00:00:00.000Z",
    } },
  });
  return store;
}

describe("owner-safe session status", () => {
  test("uses a closed bounded query and collapses unknown or foreign sessions without financial disclosure", async () => {
    const store = await creditedStore();
    const query = SessionStatusQuerySchema.parse({ principal: owner, sessionId: "missing-session" });
    const missing = await readSessionStatus({ store, query });
    const foreign = await readSessionStatus({ store, query: { ...query, principal: stranger } });

    expect(missing).toEqual({ status: "not_found_or_denied" });
    expect(foreign).toEqual({ status: "not_found_or_denied" });
    expect(JSON.stringify([missing, foreign])).not.toMatch(/900719925474099312345|balance|receipt|provider|prompt|reasoning/i);
  });

  test("returns one generic no-data result for malformed or foreign billing cursors", async () => {
    const store = await creditedStore();
    const accountId = await accountIdForPrincipal(owner);
    const raw = await store.listBillingLineItems(accountId, { limit: 1 });
    expect(raw.nextCursor).toBeUndefined();

    const invalid = await readSessionStatus({
      store,
      query: { principal: owner, sessionId: "missing-session", billing: { limit: 1, cursor: "not-a-valid-status-cursor" } },
    });
    expect(invalid).toEqual({ status: "invalid_cursor" });
    expect(BillingHistoryPageSchema.parse({ items: [], nextCursor: null })).toEqual({ items: [], nextCursor: null });
  });

  test("enforces the public 1–50 billing-page bounds before any durable read", () => {
    expect(() => SessionStatusQuerySchema.parse({ principal: owner, sessionId: "session", billing: { limit: 0 } })).toThrow();
    expect(() => SessionStatusQuerySchema.parse({ principal: owner, sessionId: "session", billing: { limit: 51 } })).toThrow();
    expect(SessionStatusQuerySchema.parse({ principal: owner, sessionId: "session", billing: { limit: 1 } }).billing?.limit).toBe(1);
    expect(SessionStatusQuerySchema.parse({ principal: owner, sessionId: "session", billing: { limit: 50 } }).billing?.limit).toBe(50);
  });
});
