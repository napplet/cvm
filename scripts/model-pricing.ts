import { canonicalJson } from "../src/promotion/schema";
import { creditsPerToken } from "../src/payments/pricing";
const OPENAI_PRICING_MARKDOWN = "https://developers.openai.com/api/docs/pricing.md";
import { ModelProfileSchema, PriceCardSchema } from "../src/model/price-card";
import { configuredProviderFromEnvironment } from "../src/dev/development-model-gateway";

/** Capture provider prices and normalize them into operator-defined credits.
 * bun scripts/model-pricing.ts --credits-per-usd 1000/1 --policy-id credits-v1
 * Each immutable price card retains the exact ratio and provider source bytes.
 */
const arg = (name: string) => { const index = process.argv.indexOf(`--${name}`); return index > 0 ? process.argv[index + 1] : undefined; };
const model = arg("model") ?? "gpt-5-mini";
const freshHours = Number(arg("fresh-hours") ?? "72");
if (!["gpt-5-mini", "gpt-5-mini-2025-08-07"].includes(model) || !Number.isInteger(freshHours) || freshHours < 1 || freshHours > 168) throw new Error("MODEL_PRICING_USAGE");
const ratioText = arg("credits-per-usd");
const policyId = arg("policy-id");
if (!ratioText || !/^[1-9][0-9]{0,35}\/[1-9][0-9]{0,35}$/u.test(ratioText) || !policyId || !/^[a-z][a-z0-9._-]{0,95}$/u.test(policyId)) throw new Error("CREDIT_PRICING_POLICY_REQUIRED");
const [numerator, denominator] = ratioText.split("/") as [string, string];
const ratio = { numerator, denominator };
const policyBytes = canonicalJson({ id: policyId, creditsPerUsd: ratio });
const policyUrl = `urn:napplet-cvm:credit-policy:${policyId}`;
const conversion = { text: policyBytes, sha256: new Bun.CryptoHasher("sha256").update(policyBytes).digest("hex") };

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
const pricing = await capture(OPENAI_PRICING_MARKDOWN, "text/markdown");
const prices = standardPrices(pricing.text, model.replace(/-2025-08-07$/u, ""));
const input = creditsPerToken(prices.inputUsdPerMillion, ratio);
const output = creditsPerToken(prices.outputUsdPerMillion, ratio);
const source = (url: string, sha256: string) => ({ url, capturedBytesSha256: sha256, observedAt: observedAt.toISOString(), effectiveAt: observedAt.toISOString(), freshUntil });
// The authoring guidance alone is ~61 KB; the request guard compares bytes to tokens.
const maximumInputTokens = "128000";
const maximumOutputTokens = "24000";
const cardBody = {
  kind: "source_attributed_provider", provider: "openai_responses", currency: "sat", rounding: "ceil",
  supportedDimensions: ["input_tokens", "output_tokens"], rates: { input_tokens: input, output_tokens: output, cached_tokens: input, reasoning_tokens: output },
  ceilings: { inputTokens: maximumInputTokens, outputTokens: maximumOutputTokens },
  validity: { notBefore: observedAt.toISOString(), notAfter: freshUntil },
  sources: { provider: source(OPENAI_PRICING_MARKDOWN, pricing.sha256), conversion: source(policyUrl, conversion.sha256) },
};
const cardId = `openai-${model}-${new Bun.CryptoHasher("sha256").update(canonicalJson(cardBody)).digest("hex").slice(0, 32)}`;
const priceCard = PriceCardSchema.parse({ ...cardBody, id: cardId, version: cardId });
const profile = ModelProfileSchema.parse({ id: `profile-${cardId}`, provider: "openai_responses", model, priceCardId: cardId, selection: "unselected", maximumUnits: [{ dimension: "input_tokens", units: maximumInputTokens }, { dimension: "output_tokens", units: maximumOutputTokens }], deadlineMs: 300_000 });
const document = { model, profile, priceCard, priceSources: { provider: { url: OPENAI_PRICING_MARKDOWN, capturedBytes: pricing.text, sha256: pricing.sha256 }, conversion: { url: policyUrl, capturedBytes: conversion.text, sha256: conversion.sha256 } }, basis: { inputUsdPerMillion: prices.inputUsdPerMillion, outputUsdPerMillion: prices.outputUsdPerMillion, creditsPerUsd: ratio, policyId } };
// Validate exactly as the service will, without a credential.
await configuredProviderFromEnvironment({ apiKey: "validation-only", model, profile, priceCard, priceSources: document.priceSources });
console.log(JSON.stringify(document));
