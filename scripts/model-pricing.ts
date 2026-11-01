import { canonicalJson } from "../src/promotion/schema";
import { OPENAI_PRICING_MARKDOWN, satsPerToken } from "../src/dev/openai-price-sync";
import { ModelProfileSchema, PriceCardSchema } from "../src/model/price-card";
import { configuredProviderFromEnvironment } from "../src/dev/development-model-gateway";

/**
 * Builds the mounted model pricing document for the OpenAI Responses adapter
 * from two captured public sources: OpenAI's Standard price table and an
 * executable BTC-USD market quote. Both are stored byte-for-byte with their
 * digests so every charge is attributable. Rates convert to sats and charges
 * round up. Input and output (including cached and reasoning tokens) are
 * billed at their published rates; nothing is discounted.
 *
 *   bun scripts/model-pricing.ts [--model gpt-5-mini] [--fresh-hours 72] > model-pricing.json
 */
const arg = (name: string) => { const index = process.argv.indexOf(`--${name}`); return index > 0 ? process.argv[index + 1] : undefined; };
const model = arg("model") ?? "gpt-5-mini";
const freshHours = Number(arg("fresh-hours") ?? "72");
if (!["gpt-5-mini", "gpt-5-mini-2025-08-07"].includes(model) || !Number.isInteger(freshHours) || freshHours < 1 || freshHours > 168) throw new Error("MODEL_PRICING_USAGE");
const BTC_USD_TICKER_URL = "https://api.kraken.com/0/public/Ticker?pair=XBTUSD";

/** Every table in the first "Standard pricing data" section; exactly one row may match. */
function standardPrices(markdown: string, name: string): { inputUsdPerMillion: string; outputUsdPerMillion: string } {
  const start = markdown.search(/^### Standard pricing data\s*$/mu);
  if (start < 0) throw new Error("STANDARD_PRICING_SECTION_MISSING");
  const rest = markdown.slice(start).split(/\r?\n/u).slice(1);
  const end = rest.findIndex((line) => line.startsWith("#"));
  const lines = end < 0 ? rest : rest.slice(0, end);
  const matches: Array<{ input: string; output: string }> = [];
  let columns: string[] | undefined;
  for (const line of lines) {
    if (!line.trim().startsWith("|")) { columns = undefined; continue; }
    const cells = line.split("|").slice(1, -1).map((cell) => cell.trim());
    if (!columns) { columns = cells.map((cell) => cell.toLowerCase()); continue; }
    if (cells.every((cell) => /^-+$/u.test(cell))) continue;
    const input = columns.findIndex((column) => column === "input" || column === "short context input");
    const output = columns.findIndex((column) => column === "output" || column === "short context output");
    if (columns[0] !== "model" || input < 0 || output < 0 || cells.length !== columns.length) throw new Error("STANDARD_PRICE_COLUMNS_CHANGED");
    if (cells[0] === name) matches.push({ input: cells[input]!, output: cells[output]! });
  }
  if (matches.length !== 1) throw new Error(matches.length ? "MODEL_PRICE_AMBIGUOUS" : "MODEL_PRICE_NOT_LISTED");
  for (const price of [matches[0]!.input, matches[0]!.output]) if (!/^\$(?:0|[1-9]\d{0,8})(?:\.\d{1,8})?$/u.test(price) || Number(price.slice(1)) <= 0) throw new Error("MODEL_PRICE_UNAVAILABLE");
  return { inputUsdPerMillion: matches[0]!.input.slice(1), outputUsdPerMillion: matches[0]!.output.slice(1) };
}

async function capture(url: string, accept: string): Promise<{ text: string; sha256: string }> {
  const response = await fetch(url, { redirect: "error", headers: { accept }, signal: AbortSignal.timeout(15_000) });
  if (!response.ok) throw new Error(`PRICE_SOURCE_HTTP_${response.status}`);
  const text = await response.text();
  if (text.length > 250_000) throw new Error("PRICE_SOURCE_TOO_LARGE");
  return { text, sha256: new Bun.CryptoHasher("sha256").update(text).digest("hex") };
}

const observedAt = new Date();
const freshUntil = new Date(observedAt.getTime() + freshHours * 3_600_000).toISOString();
const [pricing, ticker] = await Promise.all([capture(OPENAI_PRICING_MARKDOWN, "text/markdown"), capture(BTC_USD_TICKER_URL, "application/json")]);
const prices = standardPrices(pricing.text, model.replace(/-2025-08-07$/u, ""));
const quote = JSON.parse(ticker.text) as { error?: unknown[]; result?: Record<string, { c?: [string, string] }> };
const last = Object.values(quote.result ?? {})[0]?.c?.[0];
if ((quote.error && quote.error.length) || !last || !/^\d{1,9}(\.\d{1,8})?$/u.test(last)) throw new Error("BTC_USD_QUOTE_INVALID");
const usdPerBtc = last.replace(/(\.\d*?)0+$/u, "$1").replace(/\.$/u, "");
const input = satsPerToken(prices.inputUsdPerMillion, usdPerBtc);
const output = satsPerToken(prices.outputUsdPerMillion, usdPerBtc);
const source = (url: string, sha256: string) => ({ url, capturedBytesSha256: sha256, observedAt: observedAt.toISOString(), effectiveAt: observedAt.toISOString(), freshUntil });
const maximumInputTokens = "48000";
const maximumOutputTokens = "24000";
const cardBody = {
  kind: "source_attributed_provider", provider: "openai_responses", currency: "sat", rounding: "ceil",
  supportedDimensions: ["input_tokens", "output_tokens"], rates: { input_tokens: input, output_tokens: output, cached_tokens: input, reasoning_tokens: output },
  ceilings: { inputTokens: maximumInputTokens, outputTokens: maximumOutputTokens },
  validity: { notBefore: observedAt.toISOString(), notAfter: freshUntil },
  sources: { provider: source(OPENAI_PRICING_MARKDOWN, pricing.sha256), conversion: source(BTC_USD_TICKER_URL, ticker.sha256) },
};
const cardId = `openai-${model}-${new Bun.CryptoHasher("sha256").update(canonicalJson(cardBody)).digest("hex").slice(0, 32)}`;
const priceCard = PriceCardSchema.parse({ ...cardBody, id: cardId, version: cardId });
const profile = ModelProfileSchema.parse({ id: `profile-${cardId}`, provider: "openai_responses", model, priceCardId: cardId, selection: "unselected", maximumUnits: [{ dimension: "input_tokens", units: maximumInputTokens }, { dimension: "output_tokens", units: maximumOutputTokens }], deadlineMs: 300_000 });
const document = { model, profile, priceCard, priceSources: { provider: { url: OPENAI_PRICING_MARKDOWN, capturedBytes: pricing.text, sha256: pricing.sha256 }, conversion: { url: BTC_USD_TICKER_URL, capturedBytes: ticker.text, sha256: ticker.sha256 } }, basis: { inputUsdPerMillion: prices.inputUsdPerMillion, outputUsdPerMillion: prices.outputUsdPerMillion, usdPerBtc } };
// Validate exactly as the service will, without a credential.
await configuredProviderFromEnvironment({ apiKey: "validation-only", model, profile, priceCard, priceSources: document.priceSources });
console.log(JSON.stringify(document));
