import { describe, expect, test } from "bun:test";
import { NwcLightningReceiptPort, type AuthenticatedNwcInvoiceTransport } from "../../src/funding/nwc-receipt-port";
import { InMemoryLightningTopUpRepository, LightningTopUpCoordinator } from "../../src/funding/lightning-top-up";
import { ProtectedRailMaterialVault, InMemoryProtectedRailMaterialRepository } from "../../src/funding/protected-rail-material";
import { TransactionalMemoryFundingStore } from "../../src/persistence/funding-store";
import { FundingService } from "../../src/funding/funding-service";
import type { LightningOriginalIntent } from "../../src/funding/lightning-provider";

const now = Date.parse("2026-10-27T12:00:00.000Z");
const principal = { pubkey: "ac".repeat(32) };
const command = { principal, idempotencyKey: "lost-create-one", amount: "250", unit: "sat" as const, policyVersion: "v1", protocolVersion: "v1" };
const scope = "ab".repeat(32);
function fixture() {
  const repository = new InMemoryLightningTopUpRepository();
  const store = new TransactionalMemoryFundingStore();
  const vault = new ProtectedRailMaterialVault({ key: new Uint8Array(32).fill(1), repository: new InMemoryProtectedRailMaterialRepository() });
  const calls: { method: string; params: Readonly<Record<string, unknown>>; operation?: string }[] = [];
  let invoice: Record<string, unknown> | undefined;
  let records: Record<string, unknown>[] | undefined;
  const transport: AuthenticatedNwcInvoiceTransport = {
    connectionScopeDigest: scope, consentedMethods: ["make_invoice", "lookup_invoice", "list_transactions"],
    async request(method, params, signal, operation) {
      signal.throwIfAborted(); calls.push({ method, params, operation });
      if (method === "make_invoice") {
        const durable = await repository.transact(state => [...state.topUps.values()][0]!);
        expect(durable.originalIntent?.operationId).toBe(operation);
        expect(durable.originalIntent?.descriptionHash).toBe(String(params.description_hash));
        invoice = { type: "incoming", invoice: "lnbc2500n-fixture", payment_hash: "12".repeat(32), amount: 250000,
          description_hash: params.description_hash, created_at: now / 1000, expires_at: now / 1000 + 600, settled_at: now / 1000, state: "settled" };
        throw new Error("response lost after creation");
      }
      if (method === "lookup_invoice") return invoice;
      const all = records ?? [invoice!];
      return { transactions: all.slice(Number(params.offset), Number(params.offset) + 20), total_count: all.length };
    },
  };
  const create = (t = transport) => new LightningTopUpCoordinator({ funding: new FundingService(store), repository, vault,
    receiver: new NwcLightningReceiptPort(t, () => now), now: () => new Date(now).toISOString() });
  return { repository, store, transport, calls, create, records: (value: Record<string, unknown>[]) => { records = value; }, invoice: () => invoice! };
}

describe("original NWC invoice intent recovery", () => {
  test("lost-before-hash survives new coordinator and credits once across concurrent queries without another make_invoice", async () => {
    const f = fixture(); const first = await f.create().begin(command);
    expect(first.state).toBe("reconciliation_pending"); expect(f.store.postings).toHaveLength(0);
    const results = await Promise.all(Array.from({ length: 3 }, () => f.create().reconcile({ principal, topUpId: first.topUpId })));
    expect(results.every(result => result.state === "credited")).toBeTrue();
    expect(f.store.postings).toHaveLength(1);
    expect(f.calls.filter(call => call.method === "make_invoice")).toHaveLength(1);
    expect(f.calls.filter(call => call.method === "list_transactions")).toHaveLength(3);
    expect(f.calls.filter(call => call.method === "lookup_invoice").length).toBeLessThanOrEqual(3);
    const list = f.calls.find(call => call.method === "list_transactions")!;
    expect(list.params).toMatchObject({ unpaid: true, type: "incoming", limit: 20, offset: 0 });
    const durable = await f.repository.transact(state => [...state.topUps.values()][0]!);
    expect(durable.originalIntent).toMatchObject({ realm: "production-real", connectionScopeDigest: scope, type: "incoming", amount: "250" });
    expect(JSON.stringify(f.repository.snapshot())).not.toContain("lnbc");
  });

  for (const scenario of ["none", "duplicate", "wrong amount", "wrong hash", "outside window", "expired", "unsupported", "wrong scope"] as const) {
    test(`${scenario} stays pending with no credit or create redispatch`, async () => {
      const f = fixture(); const first = await f.create().begin(command); const invoice = f.invoice();
      if (scenario === "none") f.records([]);
      if (scenario === "duplicate") f.records([invoice, { ...invoice, payment_hash: "34".repeat(32) }]);
      if (scenario === "wrong amount") f.records([{ ...invoice, amount: 251000 }]);
      if (scenario === "wrong hash") f.records([{ ...invoice, description_hash: "56".repeat(32) }]);
      if (scenario === "outside window") f.records([{ ...invoice, created_at: now / 1000 - 100 }]);
      if (scenario === "expired") f.records([{ ...invoice, expires_at: now / 1000 - 1 }]);
      const transport = scenario === "unsupported" ? { ...f.transport, consentedMethods: ["make_invoice", "lookup_invoice"] } : scenario === "wrong scope" ? { ...f.transport, connectionScopeDigest: "ff".repeat(32) } : f.transport;
      const result = await f.create(transport).reconcile({ principal, topUpId: first.topUpId });
      expect(result.state).toBe("reconciliation_pending"); expect(f.store.postings).toHaveLength(0);
      expect(f.calls.filter(call => call.method === "make_invoice")).toHaveLength(1);
      expect(f.calls.filter(call => call.method === "lookup_invoice")).toHaveLength(0);
    });
  }

  test("checks later pages for a second match and never treats a truncated traversal as unique", async () => {
    const f = fixture(); const first = await f.create().begin(command);
    const unrelated = Array.from({ length: 19 }, (_, i) => ({ ...f.invoice(), description_hash: "99".repeat(32), payment_hash: i.toString(16).padStart(64, "0") }));
    f.records([f.invoice(), ...unrelated, { ...f.invoice(), payment_hash: "98".repeat(32) }]);
    expect((await f.create().reconcile({ principal, topUpId: first.topUpId })).state).toBe("reconciliation_pending");
    expect(f.calls.filter(call => call.method === "list_transactions")).toHaveLength(2);
    expect(f.store.postings).toHaveLength(0);
    f.records(Array.from({ length: 201 }, (_, i) => ({ ...f.invoice(), description_hash: "99".repeat(32), payment_hash: i.toString(16).padStart(64, "0") })));
    expect((await f.create().reconcile({ principal, topUpId: first.topUpId })).state).toBe("reconciliation_pending");
    expect(f.calls.filter(call => call.method === "make_invoice")).toHaveLength(1);
  });

  test("query adapter rejects changed realm/original operation without touching transport", async () => {
    const f = fixture(); const first = await f.create().begin(command);
    const record = await f.repository.transact(state => state.topUps.get(first.topUpId)!);
    const adapter = new NwcLightningReceiptPort(f.transport, () => now);
    for (const patch of [{ realm: "development-test" }, { operationId: "replacement" }]) {
      const count = f.calls.length;
      expect((await adapter.queryOriginalIntent({ topUpId: first.topUpId, intent: { ...record.originalIntent!, ...patch } as LightningOriginalIntent, signal: AbortSignal.timeout(1000) })).status).toBe("unknown");
      expect(f.calls).toHaveLength(count);
    }
  });

  test("retained authenticated original response recovers without history permission or request republication", async () => {
    const f = fixture(); const first = await f.create().begin(command);
    let observedOperation = "";
    const transport = { ...f.transport, consentedMethods: ["make_invoice", "lookup_invoice"],
      observeOriginalResponse: async (operation: string) => { observedOperation = operation; return f.invoice(); } };
    expect((await f.create(transport).reconcile({ principal, topUpId: first.topUpId })).state).toBe("credited");
    expect(observedOperation).toBe(`invoice-create:${first.topUpId}`);
    expect(f.calls.filter(call => call.method === "make_invoice")).toHaveLength(1);
    expect(f.calls.filter(call => call.method === "list_transactions")).toHaveLength(0);
    expect(f.store.postings).toHaveLength(1);
  });
});
