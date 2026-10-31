import { canonicalJson } from "../../promotion/schema";
import { z } from "zod";
import { OPENAI_RESPONSES_PRICING_URL, type OpenAiResponsesPricingDocument } from "./official-sources";

const DigestSchema = z.string().regex(/^[a-f0-9]{64}$/iu).transform((value) => value.toLowerCase());
const PositiveMicrosSchema = z.number().int().positive().max(Number.MAX_SAFE_INTEGER);
const NonnegativeMicrosSchema = z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER);
const ModelSchema = z.string().regex(/^[a-z0-9][a-z0-9.-]*-\d{4}-\d{2}-\d{2}$/u);

/** Closed v2 accounting roles. They describe evidence semantics, rather than
 * reusing the historic v1 fixed provider/invoice enumeration. */
export const NON_GOOGLE_COST_ROLES = Object.freeze([
  "authoritative_native_usage",
  "documented_scoped_zero",
  "included_parent",
  "explicit_approved_shared_standing",
  "unknown_held",
] as const);
const CostRoleSchema = z.enum(NON_GOOGLE_COST_ROLES);
const CostTypeSchema = z.enum([
  "model_api_usage",
  "worker_sandbox_usage",
  "database_authority",
  "object_authority",
  "homelab_host",
  "funding_rail_fee",
  "contextvm_protocol",
  "publication_transport",
] as const);

export const OpenAiResponsesRateSnapshotSchema = z.object({
  version: z.literal(2),
  sourceUrl: z.literal(OPENAI_RESPONSES_PRICING_URL),
  sourceDocumentSha256: DigestSchema,
  sourceArtifactSha256: DigestSchema,
  quoteSha256: DigestSchema,
  observedAtMs: z.number().int().positive(),
  freshUntilMs: z.number().int().positive(),
  model: ModelSchema,
  currency: z.literal("USD"),
  inputMicrosPerMillion: PositiveMicrosSchema,
  cachedInputMicrosPerMillion: PositiveMicrosSchema,
  outputMicrosPerMillion: PositiveMicrosSchema,
  cacheWriteMicrosPerMillion: PositiveMicrosSchema.optional(),
}).strict().superRefine((value, context) => {
  if (value.freshUntilMs <= value.observedAtMs || value.sourceArtifactSha256 !== value.sourceDocumentSha256) context.addIssue({ code: "custom", message: "OPENAI_PRICE_SOURCE_STALE" });
});
export type OpenAiResponsesRateSnapshot = z.infer<typeof OpenAiResponsesRateSnapshotSchema>;

const UsageSchema = z.object({
  inputTokens: z.number().int().nonnegative(),
  cachedInputTokens: z.number().int().nonnegative(),
  cacheWriteTokens: z.number().int().nonnegative(),
  outputTokens: z.number().int().nonnegative(),
  /** Reasoning is a subset of output and is recorded as evidence only. */
  reasoningTokens: z.number().int().nonnegative(),
}).strict().superRefine((value, context) => {
  if (value.cachedInputTokens + value.cacheWriteTokens > value.inputTokens) context.addIssue({ code: "custom", message: "OPENAI_USAGE_INPUT_PARTITION_INVALID" });
  if (value.reasoningTokens > value.outputTokens) context.addIssue({ code: "custom", message: "OPENAI_USAGE_OUTPUT_PARTITION_INVALID" });
});
export type OpenAiResponsesUsage = z.infer<typeof UsageSchema>;

const NativeFactSchema = z.object({ role: z.literal("authoritative_native_usage"), costType: CostTypeSchema, provider: z.literal("openai_responses"), status: z.literal("available"), rate: OpenAiResponsesRateSnapshotSchema }).strict();
const ScopedZeroFactSchema = z.object({ role: z.literal("documented_scoped_zero"), costType: CostTypeSchema, provider: z.string().min(3).max(128), status: z.literal("available"), documentedScope: z.string().min(16).max(1024) }).strict();
const IncludedParentFactSchema = z.object({ role: z.literal("included_parent"), costType: CostTypeSchema, provider: z.string().min(3).max(128), status: z.literal("available"), parentCostType: z.string().min(3).max(128) }).strict();
const SharedStandingFactSchema = z.object({ role: z.literal("explicit_approved_shared_standing"), costType: CostTypeSchema, provider: z.string().min(3).max(128), status: z.literal("available"), approvalReference: z.string().min(3).max(128) }).strict();
const HeldFactSchema = z.object({ role: z.literal("unknown_held"), costType: CostTypeSchema, provider: z.string().min(3).max(128), status: z.literal("held"), holdReason: z.string().min(8).max(1024) }).strict();
export const NonGoogleCostFactSchema = z.discriminatedUnion("role", [NativeFactSchema, ScopedZeroFactSchema, IncludedParentFactSchema, SharedStandingFactSchema, HeldFactSchema]);
export type NonGoogleCostFact = z.infer<typeof NonGoogleCostFactSchema>;

function freeze<T>(value: T): T { return Object.freeze(value); }
async function sha256(value: Uint8Array): Promise<string> { return Buffer.from(await crypto.subtle.digest("SHA-256", new Uint8Array(value).buffer)).toString("hex"); }
async function hashCanonical(value: unknown): Promise<string> { return sha256(new TextEncoder().encode(canonicalJson(value))); }
function ceilDiv(numerator: bigint, denominator: bigint): bigint { return (numerator + denominator - 1n) / denominator; }
function safeMicros(value: bigint): number { if (value < 0n || value > BigInt(Number.MAX_SAFE_INTEGER)) throw new Error("OPENAI_USAGE_COST_OVERFLOW"); return Number(value); }
function charge(tokens: number, microsPerMillion: number): number { return safeMicros(ceilDiv(BigInt(tokens) * BigInt(microsPerMillion), 1_000_000n)); }

const CapturedPricingDocumentSchema = z.object({
  sourceUrl: z.literal(OPENAI_RESPONSES_PRICING_URL),
  bytes: z.instanceof(Uint8Array).refine((value) => value.byteLength > 0 && value.byteLength <= 8 * 1024 * 1024, "OPENAI_PRICE_SOURCE_BYTES_REJECTED"),
  observedAtMs: z.number().int().positive(),
  freshUntilMs: z.number().int().positive(),
}).strict();
const MoneyPerMillionSchema = z.string().regex(/^\d+(?:\.\d{1,6})?$/u);
const CapturedPriceRowSchema = z.object({
  input_usd_per_million: MoneyPerMillionSchema,
  cached_input_usd_per_million: MoneyPerMillionSchema,
  output_usd_per_million: MoneyPerMillionSchema,
  cache_write_usd_per_million: MoneyPerMillionSchema.optional(),
}).strict();
const CapturedPriceDocumentSchema = z.object({
  schema: z.literal("openai-responses-pricing-capture-v1"),
  currency: z.literal("USD"),
  models: z.record(ModelSchema, CapturedPriceRowSchema),
}).strict();

function micros(value: string): number {
  const [whole, fraction = ""] = MoneyPerMillionSchema.parse(value).split(".");
  const parsed = BigInt(whole) * 1_000_000n + BigInt((fraction + "000000").slice(0, 6));
  if (parsed < 1n || parsed > BigInt(Number.MAX_SAFE_INTEGER)) throw new Error("OPENAI_PRICE_SOURCE_PRECISION_REJECTED");
  return Number(parsed);
}
function parseCapturedPrices(document: OpenAiResponsesPricingDocument, model: string) {
  const parsed = CapturedPricingDocumentSchema.parse(document);
  let payload: unknown;
  try { payload = JSON.parse(new TextDecoder().decode(parsed.bytes)); }
  catch { throw new Error("OPENAI_PRICE_SOURCE_PARSER_DRIFT"); }
  const prices = CapturedPriceDocumentSchema.safeParse(payload);
  if (!prices.success) throw new Error("OPENAI_PRICE_SOURCE_PARSER_DRIFT");
  const row = prices.data.models[ModelSchema.parse(model)];
  if (!row) throw new Error("OPENAI_PRICE_SOURCE_MODEL_HELD");
  return { document: parsed, currency: prices.data.currency, inputMicrosPerMillion: micros(row.input_usd_per_million), cachedInputMicrosPerMillion: micros(row.cached_input_usd_per_million), outputMicrosPerMillion: micros(row.output_usd_per_million), ...(row.cache_write_usd_per_million === undefined ? {} : { cacheWriteMicrosPerMillion: micros(row.cache_write_usd_per_million) }) };
}

/** A quote is derived only from a bounded fixed-origin capture. The parser is
 * deliberately closed: an OpenAI document shape change holds the candidate
 * instead of accepting caller-selected rates. */
export async function createOpenAiResponsesRateSnapshot(input: Readonly<{ document: OpenAiResponsesPricingDocument; model: string }>): Promise<OpenAiResponsesRateSnapshot> {
  const parsed = parseCapturedPrices(input.document, input.model);
  if (parsed.document.freshUntilMs <= parsed.document.observedAtMs) throw new Error("OPENAI_PRICE_SOURCE_STALE");
  const sourceDocumentSha256 = await sha256(parsed.document.bytes);
  const quoteSha256 = await hashCanonical({ version: 2, sourceUrl: parsed.document.sourceUrl, sourceDocumentSha256, observedAtMs: parsed.document.observedAtMs, freshUntilMs: parsed.document.freshUntilMs, model: input.model, currency: parsed.currency, inputMicrosPerMillion: parsed.inputMicrosPerMillion, cachedInputMicrosPerMillion: parsed.cachedInputMicrosPerMillion, outputMicrosPerMillion: parsed.outputMicrosPerMillion, cacheWriteMicrosPerMillion: parsed.cacheWriteMicrosPerMillion });
  return freeze(OpenAiResponsesRateSnapshotSchema.parse({ version: 2, sourceUrl: parsed.document.sourceUrl, sourceDocumentSha256, sourceArtifactSha256: sourceDocumentSha256, quoteSha256, observedAtMs: parsed.document.observedAtMs, freshUntilMs: parsed.document.freshUntilMs, model: input.model, currency: parsed.currency, inputMicrosPerMillion: parsed.inputMicrosPerMillion, cachedInputMicrosPerMillion: parsed.cachedInputMicrosPerMillion, outputMicrosPerMillion: parsed.outputMicrosPerMillion, ...(parsed.cacheWriteMicrosPerMillion === undefined ? {} : { cacheWriteMicrosPerMillion: parsed.cacheWriteMicrosPerMillion }) }));
}

export function priceOpenAiResponsesUsage(input: Readonly<{ rate: OpenAiResponsesRateSnapshot; usage: OpenAiResponsesUsage }>): Readonly<{ status: "priced"; costMicros: number; inputChargeMicros: number; cachedInputChargeMicros: number; cacheWriteChargeMicros: number; outputChargeMicros: number }> | Readonly<{ status: "held"; reason: "cache_write_rate_unknown" }> {
  const rate = OpenAiResponsesRateSnapshotSchema.parse(input.rate);
  const usage = UsageSchema.parse(input.usage);
  if (usage.cacheWriteTokens > 0 && rate.cacheWriteMicrosPerMillion === undefined) return freeze({ status: "held" as const, reason: "cache_write_rate_unknown" as const });
  const inputChargeMicros = charge(usage.inputTokens - usage.cachedInputTokens - usage.cacheWriteTokens, rate.inputMicrosPerMillion);
  const cachedInputChargeMicros = charge(usage.cachedInputTokens, rate.cachedInputMicrosPerMillion);
  const cacheWriteChargeMicros = charge(usage.cacheWriteTokens, rate.cacheWriteMicrosPerMillion ?? 1);
  /* Output already includes reasoning tokens according to the Responses API. */
  const outputChargeMicros = charge(usage.outputTokens, rate.outputMicrosPerMillion);
  return freeze({ status: "priced" as const, costMicros: safeMicros(BigInt(inputChargeMicros) + BigInt(cachedInputChargeMicros) + BigInt(cacheWriteChargeMicros) + BigInt(outputChargeMicros)), inputChargeMicros, cachedInputChargeMicros, cacheWriteChargeMicros, outputChargeMicros });
}

export function createNonGoogleCostBound(input: Readonly<{ maximumChargeMicros: number; facts: readonly NonGoogleCostFact[] }>) {
  const maximumChargeMicros = NonnegativeMicrosSchema.parse(input.maximumChargeMicros);
  const facts = input.facts.map((fact) => NonGoogleCostFactSchema.parse(fact));
  if (facts.length !== NON_GOOGLE_COST_ROLES.length || facts.some((fact, index) => fact.role !== NON_GOOGLE_COST_ROLES[index])) throw new Error("NON_GOOGLE_COST_ROLE_COVERAGE_REQUIRED");
  if (new Set(facts.map((fact) => fact.costType)).size !== facts.length) throw new Error("NON_GOOGLE_COST_TYPE_DUPLICATE");
  const heldCostTypes = facts.filter((fact): fact is z.infer<typeof HeldFactSchema> => fact.role === "unknown_held").map((fact) => fact.costType);
  return freeze({ schemaVersion: "non-google-cost-bound-v2" as const, maximumChargeMicros, facts: freeze(facts), heldCostTypes: freeze(heldCostTypes) });
}

export function assertOpenAiUsageWithinApprovedMaximum(input: Readonly<{ usage: OpenAiResponsesUsage; maximumInputTokens: number; maximumOutputTokens: number }>): void {
  const usage = UsageSchema.parse(input.usage);
  if (!Number.isSafeInteger(input.maximumInputTokens) || !Number.isSafeInteger(input.maximumOutputTokens) || input.maximumInputTokens < 1 || input.maximumOutputTokens < 1 || usage.inputTokens > input.maximumInputTokens || usage.outputTokens > input.maximumOutputTokens) throw new Error("OPENAI_USAGE_CAP_EXCEEDED");
}
