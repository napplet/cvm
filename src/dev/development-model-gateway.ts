import { z } from "zod";
import { DeterministicModelGateway } from "../model/deterministic-model-gateway";
import { ModelDispatchObservationSchema, ModelLookupObservationSchema, NormalizedUsageReceiptSchema, ProviderOperationIntentSchema, type ModelDispatchObservation, type ModelGateway, type ModelLookupObservation, type ProviderOperationIntent } from "../model/model-gateway";
import { ModelProfileSchema, PriceCardSchema, type ModelProfile, type PriceCard } from "../model/price-card";
import { SourceProposalStore } from "./source-proposal-store";

const ConfiguredProviderSchema = z.object({
  apiKey: z.string().min(1), model: z.literal("gpt-5-mini"), profile: ModelProfileSchema, priceCard: PriceCardSchema,
}).strict().superRefine((value, ctx) => {
  const now = new Date().toISOString();
  if (value.profile.provider !== "openai_responses" || value.priceCard.provider !== "openai_responses" || value.priceCard.kind !== "source_attributed_provider" || value.profile.model !== value.model || value.profile.priceCardId !== value.priceCard.id) ctx.addIssue({ code: "custom", message: "configured provider identity mismatch" });
  if (!value.priceCard.sources || value.priceCard.sources.provider.freshUntil <= now || value.priceCard.sources.conversion.freshUntil <= now) ctx.addIssue({ code: "custom", message: "configured provider price evidence is stale" });
});
type ConfiguredProvider = z.infer<typeof ConfiguredProviderSchema>;

const ProviderResponseSchema = z.object({
  id: z.string().min(1), output_text: z.string().min(1), usage: z.object({ input_tokens: z.number().int().nonnegative(), output_tokens: z.number().int().nonnegative(), input_tokens_details: z.object({ cached_tokens: z.number().int().nonnegative().optional() }).optional(), output_tokens_details: z.object({ reasoning_tokens: z.number().int().nonnegative().optional() }).optional() }).strict(),
}).strict();
const GeneratedFilesSchema = z.object({ files: z.array(z.object({ path: z.enum(["src/main.ts", "src/styles.css", "src/domain-availability.js"]), content: z.string().min(1).max(64_000) }).strict()).min(1).max(8) }).strict();

/** Server-only development selector. Absence of complete fresh provider evidence stays deterministic. */
export class DevelopmentModelGateway implements ModelGateway {
  readonly #deterministic: DeterministicModelGateway;
  readonly #configured?: ConfiguredProvider;
  constructor(input: Readonly<{ store: SourceProposalStore; configured?: unknown }>) {
    this.#deterministic = new DeterministicModelGateway({ scenario: { dispatch: "completed", lookup: "receipt_found" }, proposalStore: input.store });
    this.#configured = input.configured === undefined ? undefined : ConfiguredProviderSchema.parse(input.configured);
    this.store = input.store;
  }
  private readonly store: SourceProposalStore;

  label(): "Deterministic fixture" | "Configured OpenAI Responses" { return this.#configured ? "Configured OpenAI Responses" : "Deterministic fixture"; }
  async dispatch(input: ProviderOperationIntent, signal: AbortSignal): Promise<ModelDispatchObservation> {
    const intent = ProviderOperationIntentSchema.parse(input);
    if (!this.#configured) return this.#deterministic.dispatch(intent, signal);
    const configured = this.#configured;
    try {
      const responseSchema = { type: "object", additionalProperties: false, required: ["files"], properties: { files: { type: "array", minItems: 1, maxItems: 8, items: { type: "object", additionalProperties: false, required: ["path", "content"], properties: { path: { type: "string", enum: ["src/main.ts", "src/styles.css", "src/domain-availability.js"] }, content: { type: "string", maxLength: 64_000 } } } } } };
      const response = await fetch("https://api.openai.com/v1/responses", { method: "POST", redirect: "error", signal: AbortSignal.any([signal, AbortSignal.timeout(configured.profile.deadlineMs)]), headers: { authorization: `Bearer ${configured.apiKey}`, "content-type": "application/json", "idempotency-key": intent.operationId }, body: JSON.stringify({ model: configured.model, input: intent.prompt, text: { format: { type: "json_schema", name: "napplet_source", strict: true, schema: responseSchema } } }) });
      if (!response.ok) return ModelDispatchObservationSchema.parse({ status: "usage_unknown", operationId: intent.operationId, providerRequestId: intent.providerRequestId, reason: "uncertain_acceptance", provenance: { protectedEvidenceReference: `openai:response:unknown:${intent.operationId}` } });
      const native = ProviderResponseSchema.parse(await response.json());
      const generated = GeneratedFilesSchema.parse(JSON.parse(native.output_text));
      const stored = await this.store.persist({ intent, provider: "openai_responses", model: configured.model, proposal: generated });
      const receipt = NormalizedUsageReceiptSchema.parse({ operationId: intent.operationId, providerRequestId: intent.providerRequestId, provider: "openai_responses", model: configured.model, profileId: intent.profileId, priceCardId: intent.priceCardId, selection: intent.selection, completedAt: new Date().toISOString(), provenance: { protectedEvidenceReference: `openai:response:${native.id}` }, usage: [
        { dimension: "input_tokens", units: String(native.usage.input_tokens) }, { dimension: "output_tokens", units: String(native.usage.output_tokens) },
        { dimension: "cached_tokens", units: String(native.usage.input_tokens_details?.cached_tokens ?? 0) }, { dimension: "reasoning_tokens", units: String(native.usage.output_tokens_details?.reasoning_tokens ?? 0) },
      ] });
      return ModelDispatchObservationSchema.parse({ status: "completed", receipt, sourceProposalReference: stored.proposal.reference });
    } catch {
      return ModelDispatchObservationSchema.parse({ status: "usage_unknown", operationId: intent.operationId, providerRequestId: intent.providerRequestId, reason: signal.aborted ? "aborted" : "uncertain_acceptance", provenance: { protectedEvidenceReference: `openai:response:unknown:${intent.operationId}` } });
    }
  }
  async lookup(input: ProviderOperationIntent, signal: AbortSignal): Promise<ModelLookupObservation> {
    const intent = ProviderOperationIntentSchema.parse(input);
    if (!this.#configured) return this.#deterministic.lookup(intent, signal);
    const proposal = await this.store.lookup({ intent });
    // Provider ambiguity never permits a replacement dispatch. A future durable
    // provider-observation reconciler may enrich this row; until then it stays pending.
    return ModelLookupObservationSchema.parse(proposal ? { status: "pending", operationId: intent.operationId, providerRequestId: intent.providerRequestId, provenance: { protectedEvidenceReference: `openai:response:lookup:${intent.operationId}` } } : { status: "unresolved", operationId: intent.operationId, providerRequestId: intent.providerRequestId, provenance: { protectedEvidenceReference: `openai:response:lookup:${intent.operationId}` } });
  }
}

export function configuredProviderFromEnvironment(input: Readonly<{ apiKey?: string; model?: string; profile?: unknown; priceCard?: unknown }>): unknown | undefined {
  if (!input.apiKey && !input.model && !input.profile && !input.priceCard) return undefined;
  return { apiKey: input.apiKey, model: input.model, profile: input.profile, priceCard: input.priceCard };
}
