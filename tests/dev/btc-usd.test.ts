import { test, expect } from "bun:test";
import { KrakenQuoteReader, KRAKEN_BTC_USD_URL } from "../../src/currency/kraken-quote";
import { usdEquivalent, quoteStatus, QUOTE_FRESH_MS, QUOTE_MAX_AGE_MS, type ExchangeRate } from "../../src/currency/btc-usd";

const body = (price = "80000.00000") => ({ error: [], result: { XXBTZUSD: { c: [price, "0.01"] } } });
test("conversion preserves rational sat precision and shows sub-cent USD without floating point", () => {
  const rate: ExchangeRate = { status: "fresh", quote: { source: "Kraken", usdPerBtc: "80000.00000", fetchedAt: 1000 } };
  const convert = (sats: string, denominator = "1") => usdEquivalent(sats, rate, denominator, 1000);
  expect(convert("100000000")).toBe("≈ $80,000.00 USD");
  expect(convert("1")).toBe("≈ $0.0008 USD");
  expect(convert("12")).toBe("≈ $0.0096 USD");
  expect(convert("1", "2")).toBe("≈ $0.0004 USD");
  expect(convert("0")).toBe("≈ $0.00 USD");
  expect(convert("-5")).toBe("≈ −$0.004 USD");
  expect(convert("1", "1000000")).toBe("< $0.000001 USD");
  expect(convert("9007199254740993")).toBe("≈ $7,205,759,403,792.79 USD");
  expect(convert("1000", "3")).toBe("≈ $0.266667 USD");
  expect(convert("not money")).toBe("USD unavailable");
  expect(usdEquivalent("1", rate, "1", 1000 + QUOTE_FRESH_MS)).toContain("last known");
  expect(usdEquivalent("1", rate, "1", 1000 + QUOTE_MAX_AGE_MS)).toBe("USD unavailable");
  expect(quoteStatus({ ...rate, quote: { ...rate.quote!, usdPerBtc: "0" } }, 1000)).toBe("unavailable");
});

test("CVM reader shares in-flight requests, caches five minutes and never sends credentials", async () => {
  let calls = 0, now = 1000, release!: () => void;
  const gate = new Promise<void>(resolve => { release = resolve; });
  const reader = new KrakenQuoteReader((async (url, init) => {
    calls++; expect(url).toBe(KRAKEN_BTC_USD_URL); expect(init?.credentials).toBe("omit"); expect(init?.redirect).toBe("error");
    expect(init?.headers).toEqual({ accept: "application/json" }); expect(init?.signal).toBeInstanceOf(AbortSignal);
    await gate; return Response.json(body());
  }), () => now);
  const pending = [reader.read(), reader.read(), reader.read()]; release();
  const results = await Promise.all(pending);
  expect(calls).toBe(1); expect(results[0]).toMatchObject({ status: "fresh", quote: { usdPerBtc: "80000.00000", fetchedAt: 1000 } });
  now += QUOTE_FRESH_MS - 1; await reader.read(); expect(calls).toBe(1);
  now++; await reader.read(); expect(calls).toBe(2);
});

test("quote failures use bounded last-known data and retry cooldown, never a fabricated price", async () => {
  let calls = 0, now = 1000, fail = false;
  const reader = new KrakenQuoteReader((async () => { calls++; if (fail) throw new Error("offline"); return Response.json(body()); }), () => now);
  await reader.read(); fail = true; now += QUOTE_FRESH_MS;
  expect(await reader.read()).toMatchObject({ status: "stale", quote: { fetchedAt: 1000 } });
  await reader.read(); expect(calls).toBe(2);
  now += QUOTE_MAX_AGE_MS;
  expect(await reader.read()).toEqual({ status: "unavailable" });
  for (const response of [Response.json(body("0")), Response.json(body("NaN")), Response.json(body("-1")), Response.json({ ...body(), error: ["rate limited"] }), new Response("oops"), new Response("x".repeat(16385)), new Response(null, { status: 429 })]) {
    const invalid = new KrakenQuoteReader((async () => response), () => now);
    expect(await invalid.read()).toEqual({ status: "unavailable" });
  }
});

test("a stalled quote request stops at the five-second deadline", async () => {
  const reader = new KrakenQuoteReader((_url, init) => new Promise((_resolve, reject) => {
    init.signal!.addEventListener("abort", () => reject(init.signal!.reason), { once: true });
  }));
  expect(await reader.read()).toEqual({ status: "unavailable" });
}, 6500);
