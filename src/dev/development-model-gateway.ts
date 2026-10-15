import { z } from "zod";
import { DeterministicModelGateway } from "../model/deterministic-model-gateway";
import { ModelDispatchObservationSchema, ModelLookupObservationSchema, NormalizedUsageReceiptSchema, ProviderOperationIntentSchema, type ModelDispatchObservation, type ModelGateway, type ModelLookupObservation, type NormalizedUsageReceipt, type ProviderOperationIntent } from "../model/model-gateway";
import { ModelProfileSchema, PriceCardSchema } from "../model/price-card";
import { SourceProposalStore } from "./source-proposal-store";

const SourceBytesSchema = z.object({ url: z.string().url(), capturedBytes: z.string().min(1).max(256_000), sha256: z.string().regex(/^[a-f0-9]{64}$/u) }).strict();
const ConfiguredProviderSchema = z.object({
  apiKey: z.string().min(1), model: z.literal("gpt-5-mini"), profile: ModelProfileSchema, priceCard: PriceCardSchema,
  priceSources: z.object({ provider: SourceBytesSchema, conversion: SourceBytesSchema }).strict(),
}).strict().superRefine((value, ctx) => {
  const now = new Date().toISOString();
  if (value.profile.provider !== "openai_responses" || value.priceCard.provider !== "openai_responses" || value.priceCard.kind !== "source_attributed_provider" || value.profile.model !== value.model || value.profile.priceCardId !== value.priceCard.id) ctx.addIssue({ code: "custom", message: "configured provider identity mismatch" });
  if (!value.priceCard.sources || value.priceCard.sources.provider.freshUntil <= now || value.priceCard.sources.conversion.freshUntil <= now) ctx.addIssue({ code: "custom", message: "configured provider price evidence is stale" });
  if (value.priceCard.validity.notBefore > now || value.priceCard.validity.notAfter < now) ctx.addIssue({ code: "custom", message: "configured provider price card is outside validity" });
  if (value.priceCard.sources && (value.priceCard.sources.provider.url !== value.priceSources.provider.url || value.priceCard.sources.provider.capturedBytesSha256 !== value.priceSources.provider.sha256 || value.priceCard.sources.conversion.url !== value.priceSources.conversion.url || value.priceCard.sources.conversion.capturedBytesSha256 !== value.priceSources.conversion.sha256)) ctx.addIssue({ code: "custom", message: "configured provider source provenance mismatch" });
  const maximum = new Map(value.profile.maximumUnits.map((line) => [line.dimension, BigInt(line.units)]));
  if (!maximum.has("output_tokens")) ctx.addIssue({ code: "custom", message: "configured provider profile must bound output tokens" });
  for (const [dimension] of maximum) if (!value.priceCard.supportedDimensions.includes(dimension) || !value.priceCard.rates[dimension]) ctx.addIssue({ code: "custom", message: `configured provider profile dimension ${dimension} is unpriced` });
  if ((maximum.get("input_tokens") ?? 0n) > BigInt(value.priceCard.ceilings.inputTokens) || (maximum.get("output_tokens") ?? 0n) > BigInt(value.priceCard.ceilings.outputTokens)) ctx.addIssue({ code: "custom", message: "configured provider profile exceeds price-card ceiling" });
});
type ConfiguredProvider = z.infer<typeof ConfiguredProviderSchema>;

const ContentSchema = z.object({ type: z.literal("output_text"), text: z.string().min(1) }).passthrough();
const ProviderResponseSchema = z.object({
  id: z.string().min(1), status: z.literal("completed"), completed_at: z.number().int().positive(),
  output: z.array(z.object({ type: z.literal("message"), role: z.literal("assistant"), content: z.array(ContentSchema).min(1) }).passthrough()).min(1),
  usage: z.object({ input_tokens: z.number().int().nonnegative(), output_tokens: z.number().int().nonnegative(), input_tokens_details: z.object({ cached_tokens: z.number().int().nonnegative().optional() }).passthrough().optional(), output_tokens_details: z.object({ reasoning_tokens: z.number().int().nonnegative().optional() }).passthrough().optional() }).passthrough(),
}).passthrough();
const GeneratedFilesSchema = z.object({ files: z.array(z.object({ path: z.enum(["src/main.ts", "src/styles.css"]), content: z.string().min(1).max(64_000) }).strict()).min(1).max(8) }).strict();
type FetchLike = (input: string | URL, init?: RequestInit) => Promise<Response>;

async function sha256(value: string): Promise<string> { const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(value)); return Array.from(new Uint8Array(digest), (byte) => byte.toString(16).padStart(2, "0")).join(""); }
function outputText(native: z.infer<typeof ProviderResponseSchema>): string { return native.output.flatMap((item) => item.content).map((part) => part.text).join(""); }
function sameReceipt(left: NormalizedUsageReceipt, right: NormalizedUsageReceipt): boolean { return JSON.stringify(left) === JSON.stringify(right); }

/** Server-only selector. All config absent means deterministic; partial config is an actionable error. */
export class DevelopmentModelGateway implements ModelGateway {
  readonly #deterministic: DeterministicModelGateway;
  readonly #configured?: ConfiguredProvider;
  readonly #fetch: FetchLike;
  constructor(input: Readonly<{ store: SourceProposalStore; configured?: unknown; fetch?: FetchLike }>) {
    this.#deterministic = new DeterministicModelGateway({ scenario: { dispatch: "completed", lookup: "receipt_found" }, proposalStore: input.store });
    this.#configured = input.configured === undefined ? undefined : ConfiguredProviderSchema.parse(input.configured);
    this.store = input.store; this.#fetch = input.fetch ?? fetch;
  }
  private readonly store: SourceProposalStore;

  label(): "Deterministic fixture" | "Configured OpenAI Responses" { return this.#configured ? "Configured OpenAI Responses" : "Deterministic fixture"; }
  async dispatch(input: ProviderOperationIntent, signal: AbortSignal): Promise<ModelDispatchObservation> {
    const intent = ProviderOperationIntentSchema.parse(input);
    if (!this.#configured) return this.#deterministic.dispatch(intent, signal);
    try {
      const response = await this.#request("POST", "https://api.openai.com/v1/responses", intent, signal, this.#requestBody(intent, this.#configured));
      const native = ProviderResponseSchema.parse(await response.json());
      const generated = GeneratedFilesSchema.parse(JSON.parse(outputText(native)));
      const receipt = this.#receipt(intent, this.#configured, native);
      const stored = await this.store.persist({ intent, provider: "openai_responses", model: this.#configured.model, proposal: generated });
      await this.store.recordProviderObservation({ intent, providerResponseId: native.id, receipt, sourceProposalReference: stored.proposal.reference });
      return ModelDispatchObservationSchema.parse({ status: "completed", receipt, sourceProposalReference: stored.proposal.reference });
    } catch {
      return ModelDispatchObservationSchema.parse({ status: "usage_unknown", operationId: intent.operationId, providerRequestId: intent.providerRequestId, reason: signal.aborted ? "aborted" : "uncertain_acceptance", provenance: { protectedEvidenceReference: `openai:response:unknown:${intent.operationId}` } });
    }
  }
  async lookup(input: ProviderOperationIntent, signal: AbortSignal): Promise<ModelLookupObservation> {
    const intent = ProviderOperationIntentSchema.parse(input);
    if (!this.#configured) return this.#deterministic.lookup(intent, signal);
    const observation = await this.store.lookupProviderObservation(intent);
    if (!observation) return ModelLookupObservationSchema.parse({ status: "unresolved", operationId: intent.operationId, providerRequestId: intent.providerRequestId, provenance: { protectedEvidenceReference: `openai:response:lookup:${intent.operationId}` } });
    try {
      const response = await this.#request("GET", `https://api.openai.com/v1/responses/${encodeURIComponent(observation.providerResponseId)}`, intent, signal);
      const native = ProviderResponseSchema.parse(await response.json());
      const receipt = this.#receipt(intent, this.#configured, native);
      if (native.id !== observation.providerResponseId || !sameReceipt(receipt, observation.receipt)) throw new Error("OPENAI_LOOKUP_RECEIPT_MISMATCH");
      return ModelLookupObservationSchema.parse({ status: "receipt_found", receipt: observation.receipt, sourceProposalReference: observation.sourceProposalReference });
    } catch {
      return ModelLookupObservationSchema.parse({ status: "unresolved", operationId: intent.operationId, providerRequestId: intent.providerRequestId, provenance: { protectedEvidenceReference: `openai:response:lookup:${intent.operationId}` } });
    }
  }
  #requestBody(intent: ProviderOperationIntent, configured: ConfiguredProvider) {
    const responseSchema = { type: "object", additionalProperties: false, required: ["files"], properties: { files: { type: "array", minItems: 1, maxItems: 8, items: { type: "object", additionalProperties: false, required: ["path", "content"], properties: { path: { type: "string", enum: ["src/main.ts", "src/styles.css"] }, content: { type: "string", maxLength: 64_000 } } } } } };
    const prior = intent.authorizedPriorArtifactReference ? ` Prior artifact reference: ${intent.authorizedPriorArtifactReference}; improve only its focused purpose.` : "";
    return { model: configured.model, input: [{ role: "developer", content: "Return only requested JSON. Create a safe single-purpose vanilla TypeScript napplet. Do not use fetch, browser storage, private keys, relay clients, or untrusted HTML interpolation. src/main.ts must import and call runtimeHasDomain from ./domain-availability.js." }, { role: "user", content: `${intent.prompt}${prior}` }], max_output_tokens: Number(configured.profile.maximumUnits.find((unit) => unit.dimension === "output_tokens")?.units ?? "0"), store: true, metadata: { operation_id: intent.operationId, provider_request_id: intent.providerRequestId }, text: { format: { type: "json_schema", name: "napplet_source", strict: true, schema: responseSchema } } };
  }
  async #request(method: "GET" | "POST", url: string, intent: ProviderOperationIntent, signal: AbortSignal, body?: unknown): Promise<Response> {
    const configured = this.#configured!;
    const response = await this.#fetch(url, { method, redirect: "error", signal: AbortSignal.any([signal, AbortSignal.timeout(configured.profile.deadlineMs)]), headers: { authorization: `Bearer ${configured.apiKey}`, ...(method === "POST" ? { "content-type": "application/json", "idempotency-key": intent.operationId } : {}) }, ...(body ? { body: JSON.stringify(body) } : {}) });
    if (!response.ok) throw new Error(`OPENAI_RESPONSE_HTTP_${response.status}`); return response;
  }
  #receipt(intent: ProviderOperationIntent, configured: ConfiguredProvider, native: z.infer<typeof ProviderResponseSchema>): NormalizedUsageReceipt {
    const cached = native.usage.input_tokens_details?.cached_tokens ?? 0; const reasoning = native.usage.output_tokens_details?.reasoning_tokens ?? 0;
    if (cached > native.usage.input_tokens || reasoning > native.usage.output_tokens) throw new Error("OPENAI_USAGE_SUBTOTAL_INVALID");
    const supported = new Set(configured.priceCard.supportedDimensions);
    const usage = [
      { dimension: "input_tokens" as const, units: String(supported.has("cached_tokens") ? native.usage.input_tokens - cached : native.usage.input_tokens) },
      ...(supported.has("cached_tokens") ? [{ dimension: "cached_tokens" as const, units: String(cached) }] : []),
      { dimension: "output_tokens" as const, units: String(supported.has("reasoning_tokens") ? native.usage.output_tokens - reasoning : native.usage.output_tokens) },
      ...(supported.has("reasoning_tokens") ? [{ dimension: "reasoning_tokens" as const, units: String(reasoning) }] : []),
    ].filter((line) => supported.has(line.dimension));
    if (!usage.length || usage.some((line) => BigInt(line.units) > BigInt(intent.maximumUnits.find((limit) => limit.dimension === line.dimension)?.units ?? "0"))) throw new Error("OPENAI_USAGE_EXCEEDS_PROFILE_MAXIMUM");
    return NormalizedUsageReceiptSchema.parse({ operationId: intent.operationId, providerRequestId: intent.providerRequestId, provider: "openai_responses", model: configured.model, profileId: intent.profileId, priceCardId: intent.priceCardId, selection: intent.selection, completedAt: new Date(native.completed_at * 1000).toISOString(), provenance: { protectedEvidenceReference: `openai:response:${native.id}` }, usage });
  }
}

export async function configuredProviderFromEnvironment(input: Readonly<{ apiKey?: string; model?: string; profile?: unknown; priceCard?: unknown; priceSources?: unknown }>): Promise<unknown | undefined> {
  if (!input.apiKey && !input.model && !input.profile && !input.priceCard && !input.priceSources) return undefined;
  if (!input.apiKey || !input.model || !input.profile || !input.priceCard || !input.priceSources) throw new Error("DEVELOPMENT_MODEL_CONFIGURATION_INCOMPLETE");
  const configured = ConfiguredProviderSchema.parse({ apiKey: input.apiKey, model: input.model, profile: input.profile, priceCard: input.priceCard, priceSources: input.priceSources });
  for (const source of [configured.priceSources.provider, configured.priceSources.conversion]) if (await sha256(source.capturedBytes) !== source.sha256) throw new Error("DEVELOPMENT_MODEL_PRICE_SOURCE_DIGEST_MISMATCH");
  return configured;
}
