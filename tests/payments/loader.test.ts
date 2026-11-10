import { expect, test } from "bun:test";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { FundingService } from "../../src/funding/funding-service";
import { TransactionalMemoryFundingStore } from "../../src/persistence/funding-store";
import { loadPaymentAdapters, type PaymentAdapterHost } from "../../src/payments/loader";

const principal = { pubkey: "ab".repeat(32) };
const host: Omit<PaymentAdapterHost, "credits"> = { key: new Uint8Array(32), realm: "test", pool: {
  async connect() { throw new Error("ADAPTER_DOES_NOT_REQUIRE_DATABASE_ACCESS"); },
  async query() { throw new Error("ADAPTER_DOES_NOT_REQUIRE_DATABASE_ACCESS"); },
} };

test("operator modules receive a scoped grant port and close when later initialization fails", async () => {
  const root = await mkdtemp(join(tmpdir(), "cvm-payment-module-"));
  const funding = new FundingService(new TransactionalMemoryFundingStore());
  const module = join(root, "adapter.ts"); const incompatible = join(root, "incompatible.ts");
  await writeFile(module, `
export const version = 1;
export let closed = false;
export async function create(host, options) {
  return { id: "operator", methods: [{ id: "operator-credit", label: "Operator", input: "external" }],
    async request(input) {
      await host.credits.grant({ principal: input.principal, reference: "verified-event", credits: options.credits, policyVersion: "sale-v1", verifiedAt: new Date().toISOString() });
      return { topUpId: "operator-1", state: "credited", amount: options.credits, unit: "sat", secret: "redacted" };
    }, close() { closed = true; } };
}
`);
  await writeFile(incompatible, "export const version = 2; export async function create() {}");
  try {
    const config = { id: "operator", module, options: { credits: "250" } };
    const registry = await loadPaymentAdapters({ funding, host, modules: [config] });
    const request = { principal, method: "operator-credit", amount: "250", idempotencyKey: "buy-1", invocationHash: "a".repeat(64), mode: "transparent" as const, policyVersion: "v1", protocolVersion: "v1" };
    expect(await registry.request(request)).not.toHaveProperty("secret");
    await registry.request(request);
    expect((await funding.status(principal)).available).toBe("250");
    await registry.close();
    await expect(loadPaymentAdapters({ funding, host, modules: [config, { id: "broken", module: incompatible, options: {} }] })).rejects.toThrow("PAYMENT_MODULE_VERSION_INVALID");
    expect((await import(pathToFileURL(module).href)).closed).toBe(true);
  } finally { await rm(root, { recursive: true, force: true }); }
});
