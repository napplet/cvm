import { z } from "zod";
import { NormalizedUsageReceiptSchema, UsageDimensionSchema, type NormalizedUsageReceipt } from "./model-gateway";

const DecimalSchema = z.string().regex(/^(?:0|[1-9][0-9]*)$/u);
export { UsageDimensionSchema } from "./model-gateway";

export const RationalRateSchema = z.object({ numerator: DecimalSchema.refine((value) => BigInt(value) > 0n), denominator: DecimalSchema.refine((value) => BigInt(value) > 0n) }).strict();
const ProviderSchema = z.enum(["deterministic_fixture", "openai_responses", "openai_chatgpt_development"]);
const SourceProvenanceSchema = z.object({ url: z.string().url(), capturedBytesSha256: z.string().regex(/^[a-f0-9]{64}$/u), observedAt: z.iso.datetime(), effectiveAt: z.iso.datetime(), freshUntil: z.iso.datetime() }).strict();
export const PriceCardSchema = z.object({
  id: z.string().min(1), version: z.string().min(1), kind: z.enum(["deterministic_fixture", "source_attributed_provider", "development_test"]), provider: ProviderSchema, currency: z.literal("sat"),
  supportedDimensions: z.array(UsageDimensionSchema).min(1), rates: z.record(UsageDimensionSchema, RationalRateSchema), rounding: z.literal("ceil"),
  ceilings: z.object({ inputTokens: DecimalSchema.refine((value) => BigInt(value) > 0n), outputTokens: DecimalSchema.refine((value) => BigInt(value) > 0n) }).strict(),
  validity: z.object({ notBefore: z.iso.datetime(), notAfter: z.iso.datetime() }).strict(), sources: z.object({ provider: SourceProvenanceSchema, conversion: SourceProvenanceSchema }).strict().optional(),
}).strict().superRefine((card, ctx) => {
  if (new Set(card.supportedDimensions).size !== card.supportedDimensions.length) ctx.addIssue({ code: "custom", message: "supported dimensions must be unique" });
  for (const dimension of card.supportedDimensions) if (!card.rates[dimension]) ctx.addIssue({ code: "custom", message: `missing rate for ${dimension}` });
  if (card.kind === "deterministic_fixture" && card.provider !== "deterministic_fixture") ctx.addIssue({ code: "custom", message: "fixture card provider mismatch" });
  if (card.kind === "source_attributed_provider" && (!card.sources || card.provider !== "openai_responses")) ctx.addIssue({ code: "custom", message: "provider card requires source provenance" });
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
export type PricedUsageLine = Readonly<{ dimension: z.infer<typeof UsageDimensionSchema>; units: string; numerator: string; denominator: string; quotient: string; remainder: string; charge: string }>;
export type ReceiptPricing = Readonly<{ status: "priced"; profileId: string; priceCardId: string; lines: readonly PricedUsageLine[]; total: string }> | Readonly<{ status: "billing_invariant_failed"; code: string }>;

function freeze<T>(value: T): T { return Object.freeze(value); }
function ceilDivide(value: bigint, divisor: bigint): readonly [bigint, bigint, bigint] { const quotient = value / divisor; const remainder = value % divisor; return [quotient, remainder, remainder === 0n ? quotient : quotient + 1n]; }

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
  const total = lines.reduce((sum, line) => sum + BigInt(line.charge), 0n);
  if (input.reservation !== undefined && total > BigInt(input.reservation)) return freeze({ status: "billing_invariant_failed", code: "RECEIPT_EXCEEDS_RESERVATION" });
  return freeze({ status: "priced", profileId: profile.id, priceCardId: card.id, lines: freeze(lines), total: total.toString() });
}

export function maximumOperationCharge(input: Readonly<{ card: PriceCard; profile: ModelProfile }>): string {
  const card = PriceCardSchema.parse(input.card); const profile = ModelProfileSchema.parse(input.profile);
  if (profile.priceCardId !== card.id) throw new Error("PROFILE_CARD_MISMATCH");
  return profile.maximumUnits.reduce((sum, item) => {
    const rate = card.rates[item.dimension]; if (!rate) throw new Error("PROFILE_DIMENSION_UNPRICED");
    const [, , charge] = ceilDivide(BigInt(item.units) * BigInt(rate.numerator), BigInt(rate.denominator)); return sum + charge;
  }, 0n).toString();
}
