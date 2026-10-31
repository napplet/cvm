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

/** Evidence is mandatory even when a fact is held.  It records precisely what
 * was (or was not) established; callers cannot turn an unbound quote into an
 * available accounting fact by choosing a provider label or clock. */
const CostEvidenceSchema = z.object({
  artifactReference: z.string().regex(/^evidence:[a-z0-9._:-]{3,255}$/u),
  sourceKind: z.enum(["official_openai_model", "contextvm_transport_policy", "operator_homelab_policy", "operator_approval_policy", "unknown"]),
  sourceUrl: z.string().url().max(2048),
  sourceArtifactSha256: DigestSchema,
  sourceDocumentSha256: DigestSchema,
  observedAtMs: z.number().int().positive(),
  freshUntilMs: z.number().int().positive(),
  currency: z.literal("USD"),
  fx: z.object({ kind: z.literal("native_usd"), sourceDocumentSha256: DigestSchema, numerator: z.literal(1), denominator: z.literal(1) }).strict(),
  unit: z.string().min(3).max(128),
  precision: z.number().int().min(0).max(6),
  scope: z.string().min(16).max(1024),
  candidateSha256: DigestSchema,
  topologySha256: DigestSchema,
}).strict().superRefine((value, context) => {
  if (value.freshUntilMs <= value.observedAtMs) context.addIssue({ code: "custom", message: "NON_GOOGLE_COST_EVIDENCE_STALE" });
  if (value.fx.sourceDocumentSha256 !== value.sourceDocumentSha256) context.addIssue({ code: "custom", message: "NON_GOOGLE_COST_FX_UNBOUND" });
});
const NativeFactSchema = z.object({ role: z.literal("authoritative_native_usage"), costType: CostTypeSchema, provider: z.literal("openai_responses"), status: z.literal("available"), rate: OpenAiResponsesRateSnapshotSchema, evidence: CostEvidenceSchema }).strict().superRefine((value, context) => {
  if (value.evidence.sourceUrl !== value.rate.sourceUrl || value.evidence.sourceArtifactSha256 !== value.rate.sourceArtifactSha256 || value.evidence.sourceDocumentSha256 !== value.rate.sourceDocumentSha256 || value.evidence.observedAtMs !== value.rate.observedAtMs || value.evidence.freshUntilMs !== value.rate.freshUntilMs) context.addIssue({ code: "custom", message: "NON_GOOGLE_COST_NATIVE_EVIDENCE_UNBOUND" });
});
const ScopedZeroFactSchema = z.object({ role: z.literal("documented_scoped_zero"), costType: CostTypeSchema, provider: z.string().min(3).max(128), status: z.literal("available"), documentedScope: z.string().min(16).max(1024), evidence: CostEvidenceSchema }).strict();
const IncludedParentFactSchema = z.object({ role: z.literal("included_parent"), costType: CostTypeSchema, provider: z.string().min(3).max(128), status: z.literal("available"), parentCostType: z.string().min(3).max(128), evidence: CostEvidenceSchema }).strict();
const SharedStandingFactSchema = z.object({ role: z.literal("explicit_approved_shared_standing"), costType: CostTypeSchema, provider: z.string().min(3).max(128), status: z.literal("available"), approvalReference: z.string().min(3).max(128), evidence: CostEvidenceSchema }).strict();
const HeldFactSchema = z.object({ role: z.literal("unknown_held"), costType: CostTypeSchema, provider: z.string().min(3).max(128), status: z.literal("held"), holdReason: z.string().min(8).max(1024), evidence: CostEvidenceSchema }).strict();
export const NonGoogleCostFactSchema = z.discriminatedUnion("role", [NativeFactSchema, ScopedZeroFactSchema, IncludedParentFactSchema, SharedStandingFactSchema, HeldFactSchema]);
export type NonGoogleCostFact = z.infer<typeof NonGoogleCostFactSchema>;
export type CostEvidenceArtifactResolver = Readonly<{ read(reference: string): Promise<Readonly<{ sourceUrl: string; bytes: Uint8Array }>> }>;

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
function micros(value: string): number {
  const [whole, fraction = ""] = MoneyPerMillionSchema.parse(value).split(".");
  const parsed = BigInt(whole) * 1_000_000n + BigInt((fraction + "000000").slice(0, 6));
  if (parsed < 1n || parsed > BigInt(Number.MAX_SAFE_INTEGER)) throw new Error("OPENAI_PRICE_SOURCE_PRECISION_REJECTED");
  return Number(parsed);
}
const MAX_OPENAI_MODEL_NODES = 12_000;
const MAX_OPENAI_MODEL_DEPTH = 128;
const MAX_OPENAI_MODEL_TEXT_BYTES = 2 * 1024 * 1024;
const HtmlVoidElements = new Set(["area", "base", "br", "col", "embed", "hr", "img", "input", "link", "meta", "param", "source", "track", "wbr"]);
type OpenAiModelElement = {
  readonly parent?: OpenAiModelElement;
  readonly children: OpenAiModelElement[];
  readonly directText: string[];
  readonly tagName: string;
  readonly modelIdentity?: string;
  readonly modelView: boolean;
};
type OpenAiPriceCard = Readonly<{ label: "Input" | "Cached input" | "Output"; value: string }>;

function openAiModelText(element: OpenAiModelElement, cache: Map<OpenAiModelElement, string>): string {
  const cached = cache.get(element);
  if (cached !== undefined) return cached;
  const text = `${element.directText.join("")} ${element.children.map(child => openAiModelText(child, cache)).join(" ")}`.replace(/\s+/gu, " ").trim();
  cache.set(element, text);
  return text;
}
function openAiModelDescendant(element: OpenAiModelElement, ancestor: OpenAiModelElement): boolean {
  for (let current: OpenAiModelElement | undefined = element.parent; current; current = current.parent) if (current === ancestor) return true;
  return false;
}
function openAiModelContainer(element: OpenAiModelElement): boolean {
  return element.modelView || ((element.tagName === "article" || element.tagName === "section") && element.modelIdentity !== undefined);
}
function openAiPriceCard(element: OpenAiModelElement, text: Map<OpenAiModelElement, string>): OpenAiPriceCard | undefined {
  if (element.children.length !== 2) return undefined;
  const label = openAiModelText(element.children[0]!, text);
  const value = /^\$([0-9]+(?:\.[0-9]{1,6})?)$/u.exec(openAiModelText(element.children[1]!, text))?.[1];
  if ((label !== "Input" && label !== "Cached input" && label !== "Output") || value === undefined) return undefined;
  return { label, value };
}
function openAiPriceGroup(element: OpenAiModelElement, text: Map<OpenAiModelElement, string>): readonly [OpenAiPriceCard, OpenAiPriceCard, OpenAiPriceCard] | undefined {
  if (element.children.length !== 3) return undefined;
  const cards = element.children.map(child => openAiPriceCard(child, text));
  if (cards.some(card => card === undefined)) return undefined;
  const [input, cached, output] = cards as [OpenAiPriceCard, OpenAiPriceCard, OpenAiPriceCard];
  return input.label === "Input" && cached.label === "Cached input" && output.label === "Output" ? [input, cached, output] : undefined;
}
/** Parse the actual ModelView tree rather than scanning for an early closing
 * tag. A model can only receive rates from its one balanced container and its
 * one direct three-card group; any nested model container holds the quote. */
async function parseOfficialHtml(bytes: Uint8Array, model: string) {
  const html = new TextDecoder("utf-8", { fatal: true }).decode(bytes);
  if (!/^\s*<!doctype html|^\s*<html\b/iu.test(html) || /\u0000/u.test(html)) throw new Error("OPENAI_PRICE_SOURCE_PARSER_DRIFT");
  const stack: OpenAiModelElement[] = [];
  const elements: OpenAiModelElement[] = [];
  const encoder = new TextEncoder();
  let textBytes = 0;
  try {
    const parsed = new HTMLRewriter().on("*", {
      element(element) {
        const parent = stack.at(-1);
        const tagName = element.tagName.toLowerCase();
        const current: OpenAiModelElement = {
          ...(parent ? { parent } : {}), children: [], directText: [], tagName,
          ...(element.getAttribute("data-openai-model") === null ? {} : { modelIdentity: element.getAttribute("data-openai-model")! }),
          modelView: tagName === "astro-island" && (element.getAttribute("component-url")?.includes("ModelView") ?? false),
        };
        if (parent) parent.children.push(current);
        elements.push(current);
        if (elements.length > MAX_OPENAI_MODEL_NODES || stack.length >= MAX_OPENAI_MODEL_DEPTH) throw new Error("OPENAI_PRICE_SOURCE_PARSER_DRIFT");
        if (!HtmlVoidElements.has(tagName)) {
          stack.push(current);
          element.onEndTag(() => { if (stack.pop() !== current) throw new Error("OPENAI_PRICE_SOURCE_PARSER_DRIFT"); });
        }
      },
      text(chunk) {
        const current = stack.at(-1);
        if (!current || !chunk.text) return;
        textBytes += encoder.encode(chunk.text).byteLength;
        if (textBytes > MAX_OPENAI_MODEL_TEXT_BYTES) throw new Error("OPENAI_PRICE_SOURCE_PARSER_DRIFT");
        current.directText.push(chunk.text);
      },
    }).transform(new Response(html));
    await parsed.text();
  } catch { throw new Error("OPENAI_PRICE_SOURCE_PARSER_DRIFT"); }
  if (stack.length !== 0) throw new Error("OPENAI_PRICE_SOURCE_PARSER_DRIFT");
  const text = new Map<OpenAiModelElement, string>();
  const candidates = elements.filter(element => openAiModelContainer(element) && elements.some(code => code.tagName === "code" && openAiModelText(code, text) === model && openAiModelDescendant(code, element)));
  if (candidates.length === 0) throw new Error("OPENAI_PRICE_SOURCE_MODEL_HELD");
  if (candidates.length !== 1) throw new Error("OPENAI_PRICE_SOURCE_PARSER_DRIFT");
  const container = candidates[0]!;
  if (elements.some(element => element !== container && openAiModelContainer(element) && openAiModelDescendant(element, container))) throw new Error("OPENAI_PRICE_SOURCE_PARSER_DRIFT");
  const groups = elements.filter(element => openAiModelDescendant(element, container) && openAiPriceGroup(element, text) !== undefined);
  if (groups.length !== 1) throw new Error("OPENAI_PRICE_SOURCE_PARSER_DRIFT");
  const [input, cached, output] = openAiPriceGroup(groups[0]!, text)!;
  return { currency: "USD" as const, inputMicrosPerMillion: micros(input.value), cachedInputMicrosPerMillion: micros(cached.value), outputMicrosPerMillion: micros(output.value) };
}
async function parseCapturedPrices(document: OpenAiResponsesPricingDocument, model: string) {
  const parsed = CapturedPricingDocumentSchema.parse(document);
  const selectedModel = ModelSchema.parse(model);
  try { return { document: parsed, ...await parseOfficialHtml(parsed.bytes, selectedModel) }; }
  catch (error) { if (error instanceof Error && /OPENAI_PRICE_SOURCE_(?:MODEL_HELD|PARSER_DRIFT|PRECISION_REJECTED)/u.test(error.message)) throw error; throw new Error("OPENAI_PRICE_SOURCE_PARSER_DRIFT"); }
}

/** A quote is derived only from a bounded fixed-origin capture. The parser is
 * deliberately closed: an OpenAI document shape change holds the candidate
 * instead of accepting caller-selected rates. */
export async function createOpenAiResponsesRateSnapshot(input: Readonly<{ document: OpenAiResponsesPricingDocument; model: string }>): Promise<OpenAiResponsesRateSnapshot> {
  const parsed = await parseCapturedPrices(input.document, input.model);
  if (parsed.document.freshUntilMs <= parsed.document.observedAtMs) throw new Error("OPENAI_PRICE_SOURCE_STALE");
  const sourceDocumentSha256 = await sha256(parsed.document.bytes);
  const quoteSha256 = await hashCanonical({ version: 2, sourceUrl: parsed.document.sourceUrl, sourceDocumentSha256, observedAtMs: parsed.document.observedAtMs, freshUntilMs: parsed.document.freshUntilMs, model: input.model, currency: parsed.currency, inputMicrosPerMillion: parsed.inputMicrosPerMillion, cachedInputMicrosPerMillion: parsed.cachedInputMicrosPerMillion, outputMicrosPerMillion: parsed.outputMicrosPerMillion });
  return freeze(OpenAiResponsesRateSnapshotSchema.parse({ version: 2, sourceUrl: parsed.document.sourceUrl, sourceDocumentSha256, sourceArtifactSha256: sourceDocumentSha256, quoteSha256, observedAtMs: parsed.document.observedAtMs, freshUntilMs: parsed.document.freshUntilMs, model: input.model, currency: parsed.currency, inputMicrosPerMillion: parsed.inputMicrosPerMillion, cachedInputMicrosPerMillion: parsed.cachedInputMicrosPerMillion, outputMicrosPerMillion: parsed.outputMicrosPerMillion }));
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

export function createNonGoogleCostBound(input: Readonly<{ maximumChargeMicros: number; candidateSha256: string; topologySha256: string; facts: readonly NonGoogleCostFact[] }>) {
  const maximumChargeMicros = NonnegativeMicrosSchema.parse(input.maximumChargeMicros);
  const candidateSha256 = DigestSchema.parse(input.candidateSha256);
  const topologySha256 = DigestSchema.parse(input.topologySha256);
  const facts = input.facts.map((fact) => NonGoogleCostFactSchema.parse(fact));
  if (facts.length !== CostTypeSchema.options.length || new Set(facts.map((fact) => fact.costType)).size !== CostTypeSchema.options.length || !CostTypeSchema.options.every(type => facts.some(fact => fact.costType === type))) throw new Error("NON_GOOGLE_COST_COMPONENT_COVERAGE_REQUIRED");
  if (facts.some((fact) => fact.evidence.candidateSha256 !== candidateSha256)) throw new Error("NON_GOOGLE_COST_CANDIDATE_MISMATCH");
  if (facts.some((fact) => fact.evidence.topologySha256 !== topologySha256)) throw new Error("NON_GOOGLE_COST_TOPOLOGY_MISMATCH");
  for (const fact of facts) {
    const kind = fact.evidence.sourceKind;
    const expected = fact.role === "authoritative_native_usage" ? "official_openai_model"
      : fact.role === "documented_scoped_zero" ? "contextvm_transport_policy"
        : fact.role === "included_parent" ? "operator_homelab_policy"
          : fact.role === "explicit_approved_shared_standing" ? "operator_approval_policy" : "unknown";
    if (kind !== expected) throw new Error("NON_GOOGLE_COST_EVIDENCE_POLICY_MISMATCH");
    if (kind === "official_openai_model" && fact.evidence.sourceUrl !== OPENAI_RESPONSES_PRICING_URL) throw new Error("NON_GOOGLE_COST_EVIDENCE_POLICY_MISMATCH");
    if (kind !== "official_openai_model" && fact.evidence.sourceUrl === OPENAI_RESPONSES_PRICING_URL) throw new Error("NON_GOOGLE_COST_EVIDENCE_POLICY_MISMATCH");
  }
  const heldCostTypes = facts.filter((fact): fact is z.infer<typeof HeldFactSchema> => fact.status === "held").map((fact) => fact.costType);
  return freeze({ schemaVersion: "non-google-cost-bound-v2" as const, maximumChargeMicros, candidateSha256, topologySha256, facts: freeze(facts), heldCostTypes: freeze(heldCostTypes) });
}

/** The admission path must call this immediately before asserting a bound. */
export async function assertNonGoogleCostBoundAuthorizable(input: Readonly<{ bound: ReturnType<typeof createNonGoogleCostBound>; candidateSha256: string; topologySha256: string; nowMs: number; evidence: CostEvidenceArtifactResolver }>): Promise<void> {
  const candidateSha256 = DigestSchema.parse(input.candidateSha256);
  if (!Number.isSafeInteger(input.nowMs) || input.nowMs < 1) throw new Error("NON_GOOGLE_COST_CLOCK_INVALID");
  if (input.bound.candidateSha256 !== candidateSha256) throw new Error("NON_GOOGLE_COST_CANDIDATE_MISMATCH");
  if (input.bound.topologySha256 !== DigestSchema.parse(input.topologySha256)) throw new Error("NON_GOOGLE_COST_TOPOLOGY_MISMATCH");
  for (const fact of input.bound.facts) {
    if (fact.status !== "available") throw new Error("NON_GOOGLE_COST_BOUND_HELD");
    if (fact.evidence.freshUntilMs <= input.nowMs) throw new Error("NON_GOOGLE_COST_EVIDENCE_STALE");
    if (fact.evidence.candidateSha256 !== candidateSha256) throw new Error("NON_GOOGLE_COST_CANDIDATE_MISMATCH");
    if (fact.evidence.topologySha256 !== input.bound.topologySha256) throw new Error("NON_GOOGLE_COST_TOPOLOGY_MISMATCH");
    const artifact = await input.evidence.read(fact.evidence.artifactReference);
    if (!(artifact.bytes instanceof Uint8Array) || artifact.sourceUrl !== fact.evidence.sourceUrl || await sha256(artifact.bytes) !== fact.evidence.sourceArtifactSha256 || fact.evidence.sourceArtifactSha256 !== fact.evidence.sourceDocumentSha256) throw new Error("NON_GOOGLE_COST_EVIDENCE_ARTIFACT_INVALID");
  }
  if (input.bound.heldCostTypes.length > 0) throw new Error("NON_GOOGLE_COST_BOUND_HELD");
}

export function assertOpenAiUsageWithinApprovedMaximum(input: Readonly<{ usage: OpenAiResponsesUsage; maximumInputTokens: number; maximumOutputTokens: number }>): void {
  const usage = UsageSchema.parse(input.usage);
  if (!Number.isSafeInteger(input.maximumInputTokens) || !Number.isSafeInteger(input.maximumOutputTokens) || input.maximumInputTokens < 1 || input.maximumOutputTokens < 1 || usage.inputTokens > input.maximumInputTokens || usage.outputTokens > input.maximumOutputTokens) throw new Error("OPENAI_USAGE_CAP_EXCEEDED");
}
