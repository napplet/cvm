/** Indicative display conversion only. Never use this quote to settle the ledger. */
export const QUOTE_FRESH_MS = 5 * 60_000;
export const QUOTE_MAX_AGE_MS = 60 * 60_000;
export type BtcUsdQuote = { source: "Kraken"; usdPerBtc: string; fetchedAt: number };
export type ExchangeRate = { status: "fresh" | "stale" | "unavailable"; quote?: BtcUsdQuote };
export function quoteStatus(rate: ExchangeRate | undefined, now = Date.now()): ExchangeRate["status"] {
  const quote = rate?.quote;
  if (!quote || !/^[0-9]{1,12}(?:\.[0-9]{1,8})?$/.test(quote.usdPerBtc) || Number(quote.usdPerBtc) <= 0 || !Number.isFinite(quote.fetchedAt)) return "unavailable";
  const age = now - quote.fetchedAt;
  if (age < -60_000 || age >= QUOTE_MAX_AGE_MS) return "unavailable";
  return age >= QUOTE_FRESH_MS || rate?.status !== "fresh" ? "stale" : "fresh";
}

/** Decimal/rational conversion with integer arithmetic, including sub-cent rates. */
export function usdEquivalent(sats: string, rate: ExchangeRate | undefined, denominator = "1", now = Date.now()): string {
  const status = quoteStatus(rate, now);
  if (status === "unavailable") return "USD unavailable";
  try {
    if (!/^-?\d+$/.test(sats) || !/^[1-9]\d*$/.test(denominator)) return "USD unavailable";
    const [whole, fraction = ""] = rate!.quote!.usdPerBtc.split(".");
    const raw = BigInt(sats) * BigInt(whole! + fraction);
    const negative = raw < 0n, numerator = negative ? -raw : raw;
    const divisor = BigInt(denominator) * 100_000_000n * 10n ** BigInt(fraction.length);
    const places = numerator >= divisor || numerator === 0n ? 2 : 6;
    const scale = 10n ** BigInt(places);
    const rounded = (numerator * scale + divisor / 2n) / divisor;
    const decimal = (rounded % scale).toString().padStart(places, "0").replace(/0+$/, "").padEnd(2, "0");
    const value = numerator && !rounded ? "< $0.000001" : `${negative ? "−" : ""}$${(rounded / scale).toLocaleString("en-US")}.${decimal}`;
    return `${value.startsWith("<") ? "" : "≈ "}${value} USD${status === "stale" ? " · last known" : ""}`;
  } catch { return "USD unavailable"; }
}

export function quoteCaption(rate: ExchangeRate | undefined, now = Date.now()): string {
  const status = quoteStatus(rate, now);
  if (status === "unavailable") return "USD conversion unavailable · sat prices still apply.";
  const quote = rate!.quote!;
  const price = Number(quote.usdPerBtc).toLocaleString("en-US", { style: "currency", currency: "USD" });
  const time = new Date(quote.fetchedAt).toLocaleTimeString(undefined, { hour: "numeric", minute: "2-digit" });
  return `1 BTC ≈ ${price} USD · Kraken · ${status === "stale" ? "last known" : "checked"} ${time}`;
}
