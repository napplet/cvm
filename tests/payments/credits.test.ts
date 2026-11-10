import { expect, test } from "bun:test";
import { nip19 } from "nostr-tools";
import { accountIdForPrincipal } from "../../src/domain/account-command";
import { FundingService } from "../../src/funding/funding-service";
import { TransactionalMemoryFundingStore } from "../../src/persistence/funding-store";
import { adapterCreditGrants, purchasedCredits } from "../../src/payments/credits";
import { FreeCreditAccess } from "../../src/payments/free-access";
import { PaymentAdapterRegistry } from "../../src/payments/registry";
import type { PaymentAdapter, PaymentRequest } from "../../src/payments/contracts";
import { creditsPerToken } from "../../src/payments/pricing";

const principal = { pubkey: "ab".repeat(32) };
const grant = { principal, reference: "receipt-1", credits: "125", policyVersion: "sale-v1", verifiedAt: "2026-11-10T00:00:00.000Z" };

test("credit grants replay once across concurrent delivery and later re-observation", async () => {
  const store = new TransactionalMemoryFundingStore(); const funding = new FundingService(store);
  const credits = adapterCreditGrants(funding, "subscription");
  await Promise.all(Array.from({ length: 8 }, () => credits.grant(grant)));
  const original = await credits.grant(grant);
  expect(await credits.grant({ ...grant, verifiedAt: "2026-11-11T00:00:00.000Z" })).toEqual(original);
  expect((await funding.status(principal)).available).toBe("125");
  await expect(credits.grant({ ...grant, credits: "126" })).rejects.toThrow("IDEMPOTENCY_KEY_CONFLICT");
  await expect(credits.grant({ ...grant, policyVersion: "sale-v2" })).rejects.toThrow("IDEMPOTENCY_KEY_CONFLICT");
  expect((await funding.status(principal)).available).toBe("125");
});

test("adapters have independent receipt namespaces and cannot reuse an event for another owner", async () => {
  const funding = new FundingService(new TransactionalMemoryFundingStore());
  const card = adapterCreditGrants(funding, "card"); const subscription = adapterCreditGrants(funding, "subscription");
  await card.grant(grant); await subscription.grant(grant);
  expect((await funding.status(principal)).available).toBe("250");
  await expect(card.grant({ ...grant, principal: { pubkey: "cd".repeat(32) } })).rejects.toThrow("SETTLEMENT_REFERENCE_CONFLICT");
  expect((await funding.status({ pubkey: "cd".repeat(32) })).available).toBe("0");
});

test("credit purchase ratios use exact integer arithmetic, round down and reject invalid grants", () => {
  expect(purchasedCredits("101", { numerator: "3", denominator: "2" })).toBe("151");
  expect(purchasedCredits("9007199254740991", { numerator: "1", denominator: "1" })).toBe("9007199254740991");
  for (const [amount, numerator, denominator] of [["1", "1", "2"], ["1", "1", "0"], ["-1", "1", "1"], ["1.5", "1", "1"], ["9007199254740991", "2", "1"]]) {
    expect(() => purchasedCredits(amount!, { numerator: numerator!, denominator: denominator! })).toThrow();
  }
});

test("model credit pricing is independent of payment currency and cumulative credit overflow rolls back", async () => {
  expect(creditsPerToken("0.25", { numerator: "1000", denominator: "1" })).toEqual({ numerator: "1", denominator: "4000" });
  expect(creditsPerToken("2", { numerator: "3", denominator: "2" })).toEqual({ numerator: "3", denominator: "1000000" });
  const funding = new FundingService(new TransactionalMemoryFundingStore());
  const credits = adapterCreditGrants(funding, "subscription");
  await credits.grant({ ...grant, credits: String(Number.MAX_SAFE_INTEGER) });
  await expect(credits.grant({ ...grant, reference: "overflow", credits: "1" })).rejects.toThrow("CREDIT_BALANCE_LIMIT");
  expect((await funding.status(principal)).available).toBe(String(Number.MAX_SAFE_INTEGER));
});

test("multiple adapters route independently and cannot add secret fields to payment responses", async () => {
  const calls: string[] = [];
  const adapter = (id: string): PaymentAdapter => ({ id, methods: [{ id: `${id}-method`, label: id, input: "external" }], request: async () => {
    calls.push(id); return { topUpId: `top-up-${id}`, state: "pending", status: "payment_required", checkoutUrl: `https://pay.example/${id}`, secret: "never-on-wire", accountId: "internal" };
  } });
  const registry = new PaymentAdapterRegistry([adapter("card"), adapter("subscription")]);
  const request: PaymentRequest = { principal, method: "card-method", amount: "100", mode: "transparent", idempotencyKey: "payment-1", invocationHash: "a".repeat(64), policyVersion: "v1", protocolVersion: "v1" };
  expect(registry.methods.map(method => method.id)).toEqual(["card-method", "subscription-method"]);
  const result = await registry.request(request);
  expect(result.checkoutUrl).toBe("https://pay.example/card"); expect(result).not.toHaveProperty("secret"); expect(result).not.toHaveProperty("accountId");
  await registry.request({ ...request, method: "subscription-method" });
  expect(calls).toEqual(["card", "subscription"]);
  await expect(registry.request({ ...request, method: "unknown" })).rejects.toThrow("PAYMENT_METHOD_UNAVAILABLE");
  expect(() => new PaymentAdapterRegistry([adapter("card"), { ...adapter("other"), methods: adapter("card").methods }])).toThrow("PAYMENT_METHOD_CONFLICT");
});

test("payment-free operation accepts npubs, sponsors bounded credits and preserves cap holds", async () => {
  const store = new TransactionalMemoryFundingStore(); const funding = new FundingService(store);
  const free = new FreeCreditAccess(funding, { allowlist: [nip19.npubEncode(principal.pubkey)], maximumCredits: "1000" });
  await free.prepare(principal, "funded_admission", { idempotencyKey: "free-1", requestedCap: "500" });
  await free.prepare(principal, "funded_admission", { idempotencyKey: "free-1", requestedCap: "500" });
  expect((await funding.status(principal)).available).toBe("500");
  await expect(free.prepare(principal, "funded_admission", { idempotencyKey: "free-2", requestedCap: "1001" })).rejects.toThrow("FREE_ACCESS_MAXIMUM_EXCEEDED");
  await expect(free.prepare({ pubkey: "cd".repeat(32) }, "funded_admission", { idempotencyKey: "free-3", requestedCap: "500" })).rejects.toThrow("FREE_ACCESS_DENIED");
  const admitted = await funding.execute({ kind: "funded_admission", principal, idempotencyKey: "free-1", policyVersion: "v1", protocolVersion: "v1", payload: { requestedCap: "500", unit: "sat", capacity: { reference: "ready:free", usable: true } } });
  expect(admitted.status).toBe("accepted");
  expect((await funding.status(principal)).held).toBe("500");
  expect((await funding.status(principal)).available).toBe("0");
  expect((await funding.status({ pubkey: "cd".repeat(32) })).available).toBe("0");
  expect(await accountIdForPrincipal(principal)).toStartWith("account:");
});
