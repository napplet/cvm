import { createHash } from "node:crypto";
import { z } from "zod";
import { QUOTE_FRESH_MS, quoteStatus, type ExchangeRate } from "../currency/btc-usd";
import { OperatorRates } from "./cvm-operator";

export const OPENAI_PRICING_MARKDOWN = "https://developers.openai.com/api/docs/pricing.md";
type Rate = { numerator: string; denominator: string };
type Prices = { inputUsdPerMillion: string; outputUsdPerMillion: string };
type AdminClient = { callTool(tool: "cvm_admin", args: Record<string, unknown>): Promise<any> };

/** Fail closed if OpenAI changes the Standard table or publishes two matching rows. */
export function extractStandardPrices(markdown: string, model: string): Prices {
  if (!/^[a-z0-9][a-z0-9._:-]{0,127}$/u.test(model)) throw new Error("PRICE_MODEL_INVALID");
  const heading = /^### Standard pricing data\s*$/gm;
  const match = heading.exec(markdown);
  if (!match) throw new Error("STANDARD_PRICING_TABLE_MISSING");
  const lines = markdown.slice(match.index + match[0].length).split(/\r?\n/u);
  const start = lines.findIndex(line => line.trim().startsWith("| Model |"));
  if (start < 0 || start > 12) throw new Error("STANDARD_PRICING_TABLE_MISSING");
  const columns = lines[start]!.split("|").slice(1, -1).map(item => item.trim().toLowerCase());
  const modelColumn = columns.indexOf("model");
  const inputColumn = columns.indexOf("short context input");
  const outputColumn = columns.indexOf("short context output");
  if (columns.length < 3 || modelColumn < 0 || inputColumn < 0 || outputColumn < 0) throw new Error("STANDARD_PRICE_COLUMNS_CHANGED");
  const candidates: string[][] = [];
  for (const line of lines.slice(start + 2)) {
    if (!line.trim().startsWith("|")) break;
    const cells = line.split("|").slice(1, -1).map(item => item.trim());
    if (cells.length !== columns.length) throw new Error("STANDARD_PRICE_COLUMNS_CHANGED");
    if (cells[modelColumn] === model) candidates.push(cells);
  }
  if (candidates.length !== 1) throw new Error(candidates.length ? "MODEL_PRICE_AMBIGUOUS" : "MODEL_PRICE_NOT_LISTED");
  const inputUsdPerMillion = candidates[0]![inputColumn]!;
  const outputUsdPerMillion = candidates[0]![outputColumn]!;
  for (const price of [inputUsdPerMillion, outputUsdPerMillion]) if (!/^\$(?:0|[1-9]\d{0,8})(?:\.\d{1,8})?$/u.test(price) || Number(price.slice(1)) <= 0) throw new Error("MODEL_PRICE_UNAVAILABLE");
  return { inputUsdPerMillion: inputUsdPerMillion.slice(1), outputUsdPerMillion: outputUsdPerMillion.slice(1) };
}

function decimalFraction(input: string): { numerator: bigint; denominator: bigint } {
  if (!/^(?:0|[1-9]\d{0,11})(?:\.\d{1,8})?$/u.test(input)) throw new Error("PRICE_DECIMAL_INVALID");
  const [whole, fraction = ""] = input.split(".");
  const numerator = BigInt(whole! + fraction), denominator = 10n ** BigInt(fraction.length);
  if (!numerator) throw new Error("PRICE_DECIMAL_INVALID");
  return { numerator, denominator };
}

/** USD / million tokens × 100,000,000 sats/BTC ÷ USD/BTC. */
export function satsPerToken(usdPerMillion: string, usdPerBtc: string): Rate {
  const usd = decimalFraction(usdPerMillion), btc = decimalFraction(usdPerBtc);
  let numerator = usd.numerator * 100_000_000n * btc.denominator;
  let denominator = usd.denominator * 1_000_000n * btc.numerator;
  let a = numerator, b = denominator;
  while (b) [a, b] = [b, a % b];
  numerator /= a; denominator /= a;
  return { numerator: numerator.toString(), denominator: denominator.toString() };
}

function sameRate(a: Rate, b: Rate): boolean {
  return BigInt(a.numerator) * BigInt(b.denominator) === BigInt(b.numerator) * BigInt(a.denominator);
}

function perThousand(rate: Rate): string {
  const numerator = BigInt(rate.numerator) * 1000n * 1_000_000n;
  const denominator = BigInt(rate.denominator);
  const rounded = (numerator + denominator - 1n) / denominator;
  const tail = (rounded % 1_000_000n).toString().padStart(6, "0").replace(/0+$/u, "");
  return `${rounded / 1_000_000n}${tail ? "." + tail : ""}`;
}

async function readBoundedText(response: Response): Promise<string> {
  if (!response.ok || !response.body || !response.headers.get("content-type")?.startsWith("text/markdown")) throw new Error("OPENAI_PRICING_FETCH_FAILED");
  const reader = response.body.getReader();
  const decoder = new TextDecoder("utf-8", { fatal: true });
  let length = 0, content = "";
  try {
    while (true) {
      const chunk = await reader.read(); if (chunk.done) break;
      length += chunk.value.byteLength;
      if (length > 256_000) throw new Error("OPENAI_PRICING_TOO_LARGE");
      content += decoder.decode(chunk.value, { stream: true });
    }
    return content + decoder.decode();
  } finally { await reader.cancel().catch(() => {}); reader.releaseLock(); }
}

async function fetchPrices(fetcher: typeof fetch): Promise<{ markdown: string; sha256: string }> {
  const response = await fetcher(OPENAI_PRICING_MARKDOWN, { redirect: "error", credentials: "omit", signal: AbortSignal.timeout(10_000), headers: { accept: "text/markdown" } });
  const markdown = await readBoundedText(response);
  return { markdown, sha256: createHash("sha256").update(markdown, "utf8").digest("hex") };
}

/** Uses only signed CVM admin calls to read quote and set synthetic rates. */
export async function syncDevelopmentRates(client: AdminClient, options: { dryRun?: boolean; fetcher?: typeof fetch; now?: () => number } = {}) {
  const now = options.now ?? Date.now;
  const status = await client.callTool("cvm_admin", { action: "status" });
  if (status?.status !== "ok") throw new Error("ADMIN_STATUS_UNAVAILABLE");
  if (status.selectedApi || status.pricing?.profile?.provider !== "openai_chatgpt_development" || status.pricing?.card?.kind !== "development_test") throw new Error("SYNTHETIC_CHATGPT_MODE_REQUIRED");
  const model = z.string().regex(/^[a-z0-9][a-z0-9._:-]{0,127}$/u).parse(status.pricing.profile.model);
  const maximum = status.pricing.profile.maximumUnits?.find((line: { dimension: string }) => line.dimension === "input_tokens")?.units;
  if (!maximum || BigInt(maximum) > 272_000n) throw new Error("SHORT_CONTEXT_PRICE_NOT_APPLICABLE");
  const original = OperatorRates.parse(status.pricing.card.rates);
  const [quoteResult, source] = await Promise.all([
    client.callTool("cvm_admin", { action: "exchange_rate" }), fetchPrices(options.fetcher ?? fetch),
  ]);
  const exchangeRate = quoteResult?.exchangeRate as ExchangeRate | undefined;
  if (quoteResult?.status !== "ok" || quoteStatus(exchangeRate, now()) !== "fresh" || now() - exchangeRate!.quote!.fetchedAt >= QUOTE_FRESH_MS) throw new Error("FRESH_BTC_USD_QUOTE_REQUIRED");
  const quote = exchangeRate!.quote!;
  const prices = extractStandardPrices(source.markdown, model);
  const rates = OperatorRates.parse({ ...original,
    input_tokens: satsPerToken(prices.inputUsdPerMillion, quote.usdPerBtc),
    output_tokens: satsPerToken(prices.outputUsdPerMillion, quote.usdPerBtc),
  });
  const changed = !sameRate(original.input_tokens, rates.input_tokens) || !sameRate(original.output_tokens, rates.output_tokens);
  const result = {
    result: !changed ? "unchanged" : options.dryRun ? "dry_run" : "updated",
    model, basis: "OpenAI Standard API prices · synthetic local test sats, not ChatGPT subscription billing",
    source: { url: OPENAI_PRICING_MARKDOWN, sha256: source.sha256 },
    conversion: { source: quote.source, usdPerBtc: quote.usdPerBtc, fetchedAt: new Date(quote.fetchedAt).toISOString() },
    prices: {
      input: { usdPerMillionTokens: prices.inputUsdPerMillion, testSatsPerThousandTokens: perThousand(rates.input_tokens) },
      output: { usdPerMillionTokens: prices.outputUsdPerMillion, testSatsPerThousandTokens: perThousand(rates.output_tokens) },
    },
    previousPriceCardId: status.pricing.card.id,
  };
  if (changed && !options.dryRun) {
    const current = await client.callTool("cvm_admin", { action: "status" });
    if (current?.status !== "ok" || current.selectedApi || current.pricing?.card?.id !== status.pricing.card.id || current.pricing?.profile?.id !== status.pricing.profile.id || quoteStatus(exchangeRate, now()) !== "fresh") throw new Error("PRICING_CONTEXT_CHANGED_RETRY");
    const saved = await client.callTool("cvm_admin", { action: "save_rates", rates });
    if (saved?.status !== "ok") throw new Error(saved?.code === "CONFIGURATION_BUSY" ? "CONFIGURATION_BUSY_TRY_LATER" : "RATE_SAVE_REJECTED");
    const verified = await client.callTool("cvm_admin", { action: "status" });
    const applied = OperatorRates.parse(verified?.pricing?.card?.rates);
    if (verified?.pricing?.profile?.model !== model || !sameRate(applied.input_tokens, rates.input_tokens) || !sameRate(applied.output_tokens, rates.output_tokens)) throw new Error("RATE_SAVE_NOT_CONFIRMED");
    return { ...result, priceCardId: verified.pricing.card.id };
  }
  return result;
}
