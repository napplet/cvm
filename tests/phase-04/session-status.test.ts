import { describe, expect, test } from "bun:test";
import { accountIdForPrincipal } from "../../src/domain/account-command";
import { FundingService } from "../../src/funding/funding-service";
import { TransactionalMemoryFundingStore } from "../../src/persistence/funding-store";
import { BillingHistoryPageSchema, readSessionStatus, SessionStatusQuerySchema } from "../../src/phase-04/session-status";
import { runForeignSessionProbe, runOwnerStatusProbe } from "../support/phase-04/session-artifact-probes";

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
      topUpId: "status-topup", rail: "lightning", unit: "sat", amount: "9007199254740991",
      externalReference: "status-external", settlementReference: "status-settlement", verifiedAt: "2026-08-04T00:00:00.000Z",
    } },
  });
  return store;
}

async function seededSession(): Promise<Readonly<{ store: TransactionalMemoryFundingStore; accountId: string; sessionId: string }>> {
  const store = await creditedStore();
  const accountId = await accountIdForPrincipal(owner);
  const sessionId = "session-status-001";
  await store.transact(accountId, async (transaction) => {
    await transaction.acceptFundedAdmission({ accountId, fingerprint: "status-cap-fingerprint", idempotencyKey: "status-cap", requestedCap: 100n, capacityReference: "status-cap-ref" });
    await transaction.reserveActionBudget({ accountId, admissionReference: "status-cap-ref", idempotencyKey: "status-budget", fingerprint: "status-budget-fingerprint", reference: "status-budget-ref", amount: 100n });
    await transaction.prepareMeteredAction({
      accountId, idempotencyKey: "status-action", fingerprint: "status-action-fingerprint", sessionId, actionId: "start:status-action", expectedVersion: 0,
      admissionReference: "status-cap-ref", actionBudgetReference: "status-budget-ref", maximum: 100n, operationId: "operation:status-001", profileId: "code-proposal", priceCardId: "phase-04-deterministic-price-card-v1",
    });
    await transaction.claimProviderOperation("operation:status-001");
    await transaction.recordUsageReceipt({ operationId: "operation:status-001", protectedEvidenceReference: "protected-receipt-evidence" });
    await transaction.finalizeMeteredAction({
      idempotencyKey: "status-action", operationId: "operation:status-001", receiptCharge: "7", providerReceiptReference: "protected-provider-payload",
      status: "completed", result: { providerPayload: "must-not-leak", prompt: "must-not-leak" }, sessionVersion: 1, artifactVersion: 1,
      artifact: { artifactId: "verified:status-001", workspaceLineage: "workspace:session-status-001", checkpointReference: "checkpoint:session-status-001:start", snapshotReference: "snapshot:session-status-001:start", validationEvidenceReference: "validation:status-001" },
    });
  });
  return { store, accountId, sessionId };
}

describe("owner-safe session status", () => {
  test("reports durable read failures as unavailable rather than an invalid client cursor", async () => {
    const seeded = await seededSession();
    const store = new Proxy(seeded.store, { get(target, property) {
      if (property === "status") return async () => { throw new Error("database unavailable"); };
      const value = Reflect.get(target, property, target);
      return typeof value === "function" ? value.bind(target) : value;
    } });
    await expect(readSessionStatus({ store: store as never, cursorSecret: "test-status-secret", query: { principal: owner, sessionId: seeded.sessionId } })).resolves.toEqual({ status: "service_unavailable" });
  });

  test("uses a closed bounded query and collapses unknown or foreign sessions without financial disclosure", async () => {
    const probe = await runForeignSessionProbe();
    expect(probe.missing).toEqual({ status: "not_found_or_denied" });
    expect(probe.foreign).toEqual(probe.missing);
    expect(probe.serialized).not.toMatch(/9007199254740991|balance|receipt|provider|prompt|reasoning/i);
    const store = await creditedStore();
    const query = SessionStatusQuerySchema.parse({ principal: owner, sessionId: "missing-session" });
    const missing = await readSessionStatus({ store, query, cursorSecret: "test-status-secret" });
    const foreign = await readSessionStatus({ store, query: { ...query, principal: stranger }, cursorSecret: "test-status-secret" });

    expect(missing).toEqual({ status: "not_found_or_denied" });
    expect(foreign).toEqual({ status: "not_found_or_denied" });
    expect(JSON.stringify([missing, foreign])).not.toMatch(/9007199254740991|balance|receipt|provider|prompt|reasoning/i);
  });

  test("returns one generic no-data result for malformed or foreign billing cursors", async () => {
    const store = await creditedStore();
    const accountId = await accountIdForPrincipal(owner);
    const raw = await store.listBillingLineItems(accountId, { limit: 1 });
    expect(raw.nextCursor).toBeUndefined();

    const invalid = await readSessionStatus({
      store,
      query: { principal: owner, sessionId: "missing-session", billing: { limit: 1, cursor: "not-a-valid-status-cursor" } },
      cursorSecret: "test-status-secret",
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

  test("projects canonical lifecycle facts and all immutable owner history through signed stable pages", async () => {
    const probe = await runOwnerStatusProbe();
    expect(probe.first).toMatchObject({ status: "ok", session: { version: 1, state: "verified", latestVerifiedArtifact: { version: 1 }, nextAction: "revise_session" } });
    expect(probe.serialized).not.toMatch(/protected-provider-payload|protected-receipt-evidence|must-not-leak|prompt|providerPayload/i);
    const { store, sessionId } = await seededSession();
    const first = await readSessionStatus({ store, cursorSecret: "test-status-secret", query: { principal: owner, sessionId, billing: { limit: 1 } } });
    expect(first).toMatchObject({
      status: "ok", session: { id: sessionId, version: 1, state: "verified", maximum: "100", actualSpend: "7", latestVerifiedArtifact: { id: "verified:status-001", version: 1 }, nextAction: "revise_session" },
      action: { id: "start:status-action", operationId: "operation:status-001", price: { cardId: "phase-04-deterministic-price-card-v1", profileId: "code-proposal" } },
    });
    if (first.status !== "ok") throw new Error("expected status projection");
    expect(first.billing.items).toHaveLength(1);
    expect(first.billing.nextCursor).toEqual(expect.any(String));
    expect(JSON.stringify(first)).not.toMatch(/protected-provider-payload|protected-receipt-evidence|must-not-leak|prompt|providerPayload/i);

    const pages = [first.billing.items[0]!.id];
    let cursor = first.billing.nextCursor;
    while (cursor) {
      const page = await readSessionStatus({ store, cursorSecret: "test-status-secret", query: { principal: owner, sessionId, billing: { limit: 1, cursor } } });
      expect(page.status).toBe("ok");
      if (page.status !== "ok") break;
      pages.push(page.billing.items[0]!.id);
      cursor = page.billing.nextCursor;
    }
    expect(pages).toEqual([...pages].sort((left, right) => Number(left.split(":").at(-1)) - Number(right.split(":").at(-1))));
    expect(new Set(pages).size).toBe(pages.length);

    const foreign = await readSessionStatus({ store, cursorSecret: "test-status-secret", query: { principal: stranger, sessionId, billing: { limit: 1, cursor: first.billing.nextCursor! } } });
    expect(foreign).toEqual({ status: "invalid_cursor" });
  });
});
