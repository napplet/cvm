import { canonicalJson } from "../../promotion/schema";
import { z } from "zod";

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
  sourceUrl: z.string().url().refine((value) => new URL(value).hostname === "developers.openai.com", "OPENAI_PRICE_SOURCE_ORIGIN_REJECTED"),
  sourceDocumentSha256: DigestSchema,
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
  if (value.freshUntilMs <= value.observedAtMs) context.addIssue({ code: "custom", message: "OPENAI_PRICE_SOURCE_STALE" });
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

/** Captures a parsed, source-bound rate snapshot. This helper deliberately does
 * not fetch, discover accounts, or accept a ceiling as a vendor rate. */
export async function createOpenAiResponsesRateSnapshot(input: Readonly<{
  sourceUrl: string;
  capturedBytes: Uint8Array;
  observedAtMs: number;
  freshUntilMs: number;
  model: string;
  currency: "USD";
  inputMicrosPerMillion: number;
  cachedInputMicrosPerMillion: number;
  outputMicrosPerMillion: number;
  cacheWriteMicrosPerMillion?: number;
}>): Promise<OpenAiResponsesRateSnapshot> {
  if (!(input.capturedBytes instanceof Uint8Array) || input.capturedBytes.byteLength === 0 || input.capturedBytes.byteLength > 8 * 1024 * 1024) throw new Error("OPENAI_PRICE_SOURCE_BYTES_REJECTED");
  const sourceDocumentSha256 = await sha256(input.capturedBytes);
  const quoteSha256 = await hashCanonical({ version: 2, sourceUrl: input.sourceUrl, sourceDocumentSha256, observedAtMs: input.observedAtMs, freshUntilMs: input.freshUntilMs, model: input.model, currency: input.currency, inputMicrosPerMillion: input.inputMicrosPerMillion, cachedInputMicrosPerMillion: input.cachedInputMicrosPerMillion, outputMicrosPerMillion: input.outputMicrosPerMillion, cacheWriteMicrosPerMillion: input.cacheWriteMicrosPerMillion });
  const { capturedBytes: _capturedBytes, ...observation } = input;
  return freeze(OpenAiResponsesRateSnapshotSchema.parse({ version: 2, ...observation, sourceDocumentSha256, quoteSha256 }));
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
