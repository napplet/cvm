import { expect, test } from "bun:test";
import { PHASE_04_DETERMINISTIC_PRICE_CARD as card, PHASE_04_MODEL_PROFILES, maximumOperationCharge, priceReceipt } from "../../src/model/price-card";
import { profitCharge, resolveProfit } from "../../src/model/profit";
import { withOperatorProfit } from "../../src/model/operator-pricing";
import { costLines } from "../../src/dev/project-costs";

const profile = PHASE_04_MODEL_PROFILES["code-proposal"];
const receipt = (pricing: typeof base, units = "100") => ({ operationId: "operation", providerRequestId: "request", provider: card.provider,
  model: profile.model, profileId: pricing.profile.id, priceCardId: pricing.card.id, selection: "unselected" as const,
  completedAt: "2026-08-04T00:00:01.000Z", provenance: { protectedEvidenceReference: "receipt" }, usage: [{ dimension: "input_tokens" as const, units }] });
const base = { card, profile };

test("markup and fixed profits are exact, separately disclosed, capped and never double applied", () => {
  for (const setting of [{ mode: "percentage" as const, value: "20" }, { mode: "sats" as const, value: "200" }]) {
    const customer = withOperatorProfit(base, resolveProfit(setting));
    expect(customer.card.rates).toEqual(card.rates);
    expect(customer.card.id).not.toBe(card.id);
    const priced = priceReceipt({ ...customer, receipt: receipt(customer), reservation: "120" });
    expect(priced).toMatchObject({ status: "priced", total: "120", lines: [{ dimension: "input_tokens", charge: "100" }, { dimension: "service_fee", charge: "20" }] });
    expect(priceReceipt({ ...customer, receipt: receipt(customer), reservation: "119" })).toEqual({ status: "billing_invariant_failed", code: "RECEIPT_EXCEEDS_RESERVATION" });
    if (priced.status === "priced") expect(costLines(receipt(customer).usage, customer.card, priced.total).reduce((sum, line) => sum + BigInt(line.charge), 0n)).toBe(120n);
    expect(priceReceipt({ ...customer, receipt: receipt(customer, "0") })).toMatchObject({ status: "priced", total: "0" });
    expect(() => withOperatorProfit(customer, resolveProfit(setting))).toThrow("PROFIT_ALREADY_APPLIED");
  }
  expect(maximumOperationCharge(withOperatorProfit(base, resolveProfit({ mode: "percentage", value: "20" })))).toBe("3900");
  expect(maximumOperationCharge(withOperatorProfit(base, resolveProfit({ mode: "sats", value: "20" })))).toBe("3310");
  expect(profitCharge(1n, 1n, resolveProfit({ mode: "percentage", value: "0.000001" }))).toBe(1n);
  expect(profitCharge(100n, 1500n, resolveProfit({ mode: "sats", value: "2.5" }))).toBe(4n);
  expect(withOperatorProfit(base, resolveProfit({ mode: "percentage", value: "0" }))).toEqual(base);
  const split = withOperatorProfit(base, resolveProfit({ mode: "sats", value: "0.1" }));
  expect(priceReceipt({ ...split, receipt: { ...receipt(split), usage: [{ dimension: "input_tokens", units: "501" }, { dimension: "output_tokens", units: "499" }] } })).toMatchObject({ status: "priced", total: "1001", lines: [{ dimension: "input_tokens" }, { dimension: "output_tokens" }, { dimension: "service_fee", charge: "1" }] });
});

test("USD conversion is pinned to the saved policy; stale and invalid settings fail closed", () => {
  const now = Date.now();
  const policy = resolveProfit({ mode: "usd", value: "0.01" }, { status: "fresh", quote: { source: "Kraken", usdPerBtc: "80000", fetchedAt: now } }, now);
  expect(profitCharge(100n, 1000n, policy)).toBe(13n);
  const customer = withOperatorProfit(base, policy);
  expect(priceReceipt({ ...customer, receipt: receipt(customer) })).toMatchObject({ status: "priced", total: "102" });
  const laterPolicy = resolveProfit({ mode: "usd", value: "0.01" }, { status: "fresh", quote: { source: "Kraken", usdPerBtc: "100000", fetchedAt: now } }, now);
  expect(profitCharge(100n, 1000n, laterPolicy)).toBe(10n);
  expect(profitCharge(100n, 1000n, customer.card.profit)).toBe(13n);
  expect(() => resolveProfit({ mode: "usd", value: "1" }, { status: "stale", quote: policy.conversion }, now)).toThrow("FRESH_BTC_USD_QUOTE_REQUIRED");
  for (const value of ["-1", "1e3", "", "0.1234567"]) expect(() => resolveProfit({ mode: "percentage", value })).toThrow();
});
