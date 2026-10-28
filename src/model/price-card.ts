import { canonicalJson } from "../promotion/schema";
import { z } from "zod";
import { NormalizedUsageReceiptSchema, UsageDimensionSchema, type NormalizedUsageReceipt } from "./model-gateway";
import { ProfitPolicySchema, profitCharge } from "./profit";

const DecimalSchema = z.string().regex(/^(?:0|[1-9][0-9]*)$/u);
export { UsageDimensionSchema } from "./model-gateway";

export const RationalRateSchema = z.object({ numerator: DecimalSchema.refine((value) => BigInt(value) > 0n), denominator: DecimalSchema.refine((value) => BigInt(value) > 0n) }).strict();
/** Settlement-only conversion evidence. This is intentionally separate from
 * `currency/btc-usd.ts`, whose last-known values are display formatting and
 * must never authorize or debit a funded account. `satsPerUsd` is a fresh,
 * source-attributed rational and conversion always rounds up. */
const ProviderSchema = z.enum(["deterministic_fixture", "openai_responses", "openai_chatgpt_development", "vertex_ai_gemini"]);
const SourceProvenanceSchema = z.object({ url: z.string().url(), capturedBytesSha256: z.string().regex(/^[a-f0-9]{64}$/u), observedAt: z.iso.datetime(), effectiveAt: z.iso.datetime(), freshUntil: z.iso.datetime() }).strict();
export const UsdSatConversionSchema = z.object({
  source: SourceProvenanceSchema,
  satsPerUsd: RationalRateSchema,
}).strict();
export const PriceCardSchema = z.object({
  id: z.string().min(1), version: z.string().min(1), kind: z.enum(["deterministic_fixture", "source_attributed_provider", "development_test"]), provider: ProviderSchema, currency: z.enum(["sat", "usd_micros"]),
  supportedDimensions: z.array(UsageDimensionSchema).min(1), rates: z.record(UsageDimensionSchema, RationalRateSchema), rounding: z.literal("ceil"),
  ceilings: z.object({ inputTokens: DecimalSchema.refine((value) => BigInt(value) > 0n), outputTokens: DecimalSchema.refine((value) => BigInt(value) > 0n) }).strict(),
  validity: z.object({ notBefore: z.iso.datetime(), notAfter: z.iso.datetime() }).strict(), sources: z.object({ provider: SourceProvenanceSchema, conversion: SourceProvenanceSchema }).strict().optional(),
  profit: ProfitPolicySchema.optional(),
}).strict().superRefine((card, ctx) => {
  if (new Set(card.supportedDimensions).size !== card.supportedDimensions.length) ctx.addIssue({ code: "custom", message: "supported dimensions must be unique" });
  for (const dimension of card.supportedDimensions) if (!card.rates[dimension]) ctx.addIssue({ code: "custom", message: `missing rate for ${dimension}` });
  if (card.kind === "deterministic_fixture" && card.provider !== "deterministic_fixture") ctx.addIssue({ code: "custom", message: "fixture card provider mismatch" });
  if (card.kind === "source_attributed_provider" && (!card.sources || !["openai_responses", "vertex_ai_gemini"].includes(card.provider))) ctx.addIssue({ code: "custom", message: "provider card requires source provenance" });
  if ((card.kind === "development_test") !== (card.provider === "openai_chatgpt_development")) ctx.addIssue({ code: "custom", message: "ChatGPT development usage requires explicitly synthetic pricing" });
});
export const ModelProfileSchema = z.object({
  id: z.string().min(1), provider: ProviderSchema, model: z.string().min(1), priceCardId: z.string().min(1),
  selection: z.literal("unselected"), maximumUnits: z.array(z.object({ dimension: UsageDimensionSchema, units: DecimalSchema.refine((value) => BigInt(value) > 0n) }).strict()).min(1), deadlineMs: z.number().int().positive(),
}).strict();

function immutable<T>(value: T): T {
  if (value && typeof value === "object" && !Object.isFrozen(value)) {
    for (const child of Object.values(value as Record<string, unknown>)) immutable(child);
    Object.freeze(value);
  }
  return value;
}

export const PHASE_04_DETERMINISTIC_PRICE_CARD = immutable(PriceCardSchema.parse({
  id: "phase-04-deterministic-card-2026-08-04", version: "phase-04-deterministic-card-2026-08-04", kind: "deterministic_fixture", provider: "deterministic_fixture", currency: "sat", rounding: "ceil", ceilings: { inputTokens: "1000", outputTokens: "1000" },
  supportedDimensions: ["input_tokens", "output_tokens", "cached_tokens", "reasoning_tokens"],
  rates: { input_tokens: { numerator: "1", denominator: "1" }, output_tokens: { numerator: "1", denominator: "1" }, cached_tokens: { numerator: "1", denominator: "2" }, reasoning_tokens: { numerator: "2", denominator: "1" } },
  validity: { notBefore: "2026-08-04T00:00:00.000Z", notAfter: "2027-08-04T00:00:00.000Z" },
}));
export const PHASE_04_MODEL_PROFILES = immutable({
  "plan-classify": ModelProfileSchema.parse({ id: "plan-classify", provider: "deterministic_fixture", model: "phase-04-fixture-model", priceCardId: PHASE_04_DETERMINISTIC_PRICE_CARD.id, selection: "unselected", maximumUnits: [{ dimension: "input_tokens", units: "200" }, { dimension: "output_tokens", units: "100" }], deadlineMs: 5_000 }),
  "code-proposal": ModelProfileSchema.parse({ id: "code-proposal", provider: "deterministic_fixture", model: "phase-04-fixture-model", priceCardId: PHASE_04_DETERMINISTIC_PRICE_CARD.id, selection: "unselected", maximumUnits: [{ dimension: "input_tokens", units: "1000" }, { dimension: "output_tokens", units: "1000" }, { dimension: "cached_tokens", units: "500" }, { dimension: "reasoning_tokens", units: "500" }], deadlineMs: 30_000 }),
  "repair-proposal": ModelProfileSchema.parse({ id: "repair-proposal", provider: "deterministic_fixture", model: "phase-04-fixture-model", priceCardId: PHASE_04_DETERMINISTIC_PRICE_CARD.id, selection: "unselected", maximumUnits: [{ dimension: "input_tokens", units: "500" }, { dimension: "output_tokens", units: "500" }], deadlineMs: 20_000 }),
});

export type PriceCard = z.infer<typeof PriceCardSchema>;
export type ModelProfile = z.infer<typeof ModelProfileSchema>;
export type UsdSatConversion = z.infer<typeof UsdSatConversionSchema>;
export type PricedUsageLine = Readonly<{ dimension: z.infer<typeof UsageDimensionSchema> | "service_fee"; units: string; numerator: string; denominator: string; quotient: string; remainder: string; charge: string }>;
export type ReceiptPricing = Readonly<{ status: "priced"; profileId: string; priceCardId: string; lines: readonly PricedUsageLine[]; total: string }> | Readonly<{ status: "billing_invariant_failed"; code: string }>;
export type VertexGeminiProductionPriceObservation = Readonly<{
  sourceUrl: string;
  bytes: Uint8Array;
  observedAtMs: number;
  freshUntilMs: number;
  currency: "USD";
  location: "global";
  model: "gemini-4-argon";
  inputMicrosPerMillion: number;
  cachedInputMicrosPerMillion: number;
  outputAndThoughtMicrosPerMillion: number;
}>;

function freeze<T>(value: T): T { return Object.freeze(value); }
function ceilDivide(value: bigint, divisor: bigint): readonly [bigint, bigint, bigint] { const quotient = value / divisor; const remainder = value % divisor; return [quotient, remainder, remainder === 0n ? quotient : quotient + 1n]; }
async function sha256Bytes(bytes: Uint8Array): Promise<string> { const digest = await crypto.subtle.digest("SHA-256", new Uint8Array(bytes).buffer); return Array.from(new Uint8Array(digest), (byte) => byte.toString(16).padStart(2, "0")).join(""); }

/** Constructs production pricing only from the exact captured Vertex source
 * and a fresh settlement FX quote.  It deliberately has no rate arguments:
 * callers cannot turn a project ceiling or a synthetic fixture into a billable
 * Gemini price card. */
export async function createVertexGeminiProductionPricing(input: Readonly<{
  observation: VertexGeminiProductionPriceObservation;
  conversion: UsdSatConversion;
  profileId: string;
  maximumInputTokens: string;
  maximumOutputTokens: string;
  deadlineMs: number;
}>): Promise<Readonly<{ card: PriceCard; profile: ModelProfile; conversion: UsdSatConversion }>> {
  const observation = input.observation;
  if (!(observation.bytes instanceof Uint8Array) || observation.bytes.byteLength === 0 || observation.bytes.byteLength > 8 * 1024 * 1024
    || observation.currency !== "USD" || observation.location !== "global" || observation.model !== "gemini-4-argon"
    || !Number.isSafeInteger(observation.observedAtMs) || observation.observedAtMs <= 0
    || !Number.isSafeInteger(observation.freshUntilMs) || observation.freshUntilMs <= observation.observedAtMs
    || !Number.isSafeInteger(observation.inputMicrosPerMillion) || observation.inputMicrosPerMillion <= 0
    || !Number.isSafeInteger(observation.cachedInputMicrosPerMillion) || observation.cachedInputMicrosPerMillion <= 0
    || !Number.isSafeInteger(observation.outputAndThoughtMicrosPerMillion) || observation.outputAndThoughtMicrosPerMillion <= 0
    || new URL(observation.sourceUrl).hostname !== "cloud.google.com") throw new Error("VERTEX_PRODUCTION_PRICE_SOURCE_INVALID");
  const conversion = UsdSatConversionSchema.parse(input.conversion);
  const observedAt = new Date(observation.observedAtMs).toISOString();
  const freshUntil = new Date(observation.freshUntilMs).toISOString();
  const source = freeze({ url: observation.sourceUrl, capturedBytesSha256: await sha256Bytes(observation.bytes), observedAt, effectiveAt: observedAt, freshUntil });
  const cardBody = {
    kind: "source_attributed_provider", provider: "vertex_ai_gemini", currency: "usd_micros", rounding: "ceil",
    supportedDimensions: ["input_tokens", "cached_tokens", "output_tokens", "reasoning_tokens"],
    rates: {
      input_tokens: { numerator: String(observation.inputMicrosPerMillion), denominator: "1000000" },
      cached_tokens: { numerator: String(observation.cachedInputMicrosPerMillion), denominator: "1000000" },
      output_tokens: { numerator: String(observation.outputAndThoughtMicrosPerMillion), denominator: "1000000" },
      reasoning_tokens: { numerator: String(observation.outputAndThoughtMicrosPerMillion), denominator: "1000000" },
    },
    ceilings: { inputTokens: input.maximumInputTokens, outputTokens: input.maximumOutputTokens },
    validity: { notBefore: observedAt, notAfter: freshUntil }, sources: { provider: source, conversion: conversion.source },
  };
  const cardId = `vertex-gemini-4-argon-${await sha256Bytes(new TextEncoder().encode(canonicalJson({ card: cardBody, profileId: input.profileId, deadlineMs: input.deadlineMs })))}`;
  const card = freeze(PriceCardSchema.parse({ ...cardBody, id: cardId, version: cardId }));
  const profile = freeze(ModelProfileSchema.parse({
    id: input.profileId, provider: "vertex_ai_gemini", model: "gemini-4-argon", priceCardId: card.id, selection: "unselected",
    maximumUnits: [
      { dimension: "input_tokens", units: input.maximumInputTokens },
      { dimension: "cached_tokens", units: input.maximumInputTokens },
      { dimension: "output_tokens", units: input.maximumOutputTokens },
      { dimension: "reasoning_tokens", units: input.maximumOutputTokens },
    ], deadlineMs: input.deadlineMs,
  }));
  return freeze({ card, profile, conversion });
}

/** Converts an immutable gross USD-micro receipt to the sat ledger amount.
 * Callers must bind this exact conversion evidence to the same operation;
 * there is no fallback, cached quote, or display-rate path. */
export function convertUsdMicrosToSats(input: Readonly<{ usdMicros: number; conversion: UsdSatConversion; at: string }>): Readonly<{ currency: "sat"; amount: string; conversion: UsdSatConversion }> {
  if (!Number.isSafeInteger(input.usdMicros) || input.usdMicros < 0) throw new Error("USD_MICROS_INVALID");
  const conversion = UsdSatConversionSchema.parse(input.conversion);
  if (input.at < conversion.source.observedAt || input.at > conversion.source.freshUntil) throw new Error("USD_SAT_CONVERSION_STALE");
  const numerator = BigInt(input.usdMicros) * BigInt(conversion.satsPerUsd.numerator);
  const denominator = 1_000_000n * BigInt(conversion.satsPerUsd.denominator);
  const [, , amount] = ceilDivide(numerator, denominator);
  return freeze({ currency: "sat" as const, amount: amount.toString(), conversion });
}

/** Reproduces a pinned normalized receipt using only integer/rational arithmetic. */
export function priceReceipt(input: Readonly<{ receipt: NormalizedUsageReceipt; card: PriceCard; profile: ModelProfile; reservation?: string; at?: string }>): ReceiptPricing {
  const receipt = NormalizedUsageReceiptSchema.parse(input.receipt); const card = PriceCardSchema.parse(input.card); const profile = ModelProfileSchema.parse(input.profile);
  if (receipt.profileId !== profile.id || receipt.priceCardId !== card.id || profile.priceCardId !== card.id || receipt.provider !== card.provider || profile.provider !== card.provider || receipt.model !== profile.model) return freeze({ status: "billing_invariant_failed", code: "RECEIPT_PRICE_IDENTITY_MISMATCH" });
  const at = input.at ?? receipt.completedAt;
  if (at < card.validity.notBefore || at > card.validity.notAfter) return freeze({ status: "billing_invariant_failed", code: "PRICE_CARD_OUTSIDE_VALIDITY" });
  const seen = new Set<string>(); const lines: PricedUsageLine[] = [];
  for (const item of [...receipt.usage].sort((a, b) => a.dimension.localeCompare(b.dimension))) {
    if (seen.has(item.dimension) || !card.supportedDimensions.includes(item.dimension) || !card.rates[item.dimension]) return freeze({ status: "billing_invariant_failed", code: "UNSUPPORTED_OR_DUPLICATE_USAGE_DIMENSION" });
    seen.add(item.dimension); const units = BigInt(item.units); const rate = card.rates[item.dimension]!; const numerator = BigInt(rate.numerator); const denominator = BigInt(rate.denominator);
    const [quotient, remainder, charge] = ceilDivide(units * numerator, denominator);
    lines.push(freeze({ dimension: item.dimension, units: item.units, numerator: rate.numerator, denominator: rate.denominator, quotient: quotient.toString(), remainder: remainder.toString(), charge: charge.toString() }));
  }
  const base = lines.reduce((sum, line) => sum + BigInt(line.charge), 0n);
  const fee = profitCharge(base, receipt.usage.reduce((sum, line) => sum + BigInt(line.units), 0n), card.profit);
  if (fee) lines.push(freeze({ dimension: "service_fee", units: "1", numerator: fee.toString(), denominator: "1", quotient: fee.toString(), remainder: "0", charge: fee.toString() }));
  const total = base + fee;
  if (input.reservation !== undefined && total > BigInt(input.reservation)) return freeze({ status: "billing_invariant_failed", code: "RECEIPT_EXCEEDS_RESERVATION" });
  return freeze({ status: "priced", profileId: profile.id, priceCardId: card.id, lines: freeze(lines), total: total.toString() });
}

export function maximumOperationCharge(input: Readonly<{ card: PriceCard; profile: ModelProfile }>): string {
  const card = PriceCardSchema.parse(input.card); const profile = ModelProfileSchema.parse(input.profile);
  if (profile.priceCardId !== card.id) throw new Error("PROFILE_CARD_MISMATCH");
  const base = profile.maximumUnits.reduce((sum, item) => {
    const rate = card.rates[item.dimension]; if (!rate) throw new Error("PROFILE_DIMENSION_UNPRICED");
    const [, , charge] = ceilDivide(BigInt(item.units) * BigInt(rate.numerator), BigInt(rate.denominator)); return sum + charge;
  }, 0n);
  return (base + profitCharge(base, profile.maximumUnits.reduce((sum, line) => sum + BigInt(line.units), 0n), card.profit)).toString();
}
