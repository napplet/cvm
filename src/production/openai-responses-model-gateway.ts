import { z } from "zod";
import type { ModelDispatchObservation, ModelGateway, ModelLookupObservation, NormalizedUsageReceipt, ProviderOperationIntent } from "../model/model-gateway";
import { parseOpenAiResponsesProviderReceipt, type OpenAiResponsesProviderReceipt, type createOpenAiResponsesClient } from "../release/deployment/openai-responses-client";

const SYSTEM = "Return one focused napplet as JSON. Do not use network, relay, signer, storage outside declared SDK capabilities, dynamic imports, workers, or server code.";
const PRE_DISPATCH_REJECTIONS = new Set([
  "OPENAI_RESPONSES_INTENT_CAP_REQUIRED",
  "OPENAI_USAGE_CAP_EXCEEDED",
  "OPENAI_RESPONSES_PRICE_STALE",
  "OPENAI_RESPONSES_INPUT_CAP_EXCEEDED",
  "OPENAI_RESPONSES_MAXIMUM_CAP_EXCEEDED",
]);

function maximum(intent: ProviderOperationIntent, dimension: "input_tokens" | "output_tokens"): number {
  const unit = intent.maximumUnits.find((value) => value.dimension === dimension)?.units;
  const value = Number(unit);
  if (!Number.isSafeInteger(value) || value < 1 || value > 100_000) throw new Error("OPENAI_RESPONSES_INTENT_CAP_REQUIRED");
  return value;
}
function receipt(intent: ProviderOperationIntent, value: OpenAiResponsesProviderReceipt): NormalizedUsageReceipt {
  if (value.operationId !== intent.operationId || value.model.length === 0) throw new Error("OPENAI_RESPONSES_OPERATION_BINDING_INVALID");
  return {
    operationId: value.operationId,
    providerRequestId: intent.providerRequestId,
    provider: "openai_responses",
    model: value.model,
    profileId: intent.profileId,
    priceCardId: intent.priceCardId,
    selection: "unselected",
    completedAt: new Date(value.completedAtMs).toISOString(),
    provenance: { protectedEvidenceReference: `openai-responses-receipt:${value.operationId}:${value.responseId}`, protectedEvidenceDigest: value.requestSha256 },
    usage: [
      { dimension: "input_tokens", units: String(value.usage.inputTokens) },
      { dimension: "cached_tokens", units: String(value.usage.cachedInputTokens) },
      { dimension: "output_tokens", units: String(value.usage.outputTokens) },
      { dimension: "reasoning_tokens", units: String(value.usage.reasoningTokens) },
    ],
  };
}

/** Candidate-only transport-neutral gateway. It receives a fully constructed,
 * explicit client and does not read configuration, credentials, or environment
 * values. Runtime selection remains blocked for the later full graph. */
export class OpenAiResponsesCandidateModelGateway implements ModelGateway {
  constructor(private readonly client: ReturnType<typeof createOpenAiResponsesClient>) {}
  async dispatch(intent: ProviderOperationIntent, signal: AbortSignal): Promise<ModelDispatchObservation> {
    if (signal.aborted) return { status: "usage_unknown", operationId: intent.operationId, providerRequestId: intent.providerRequestId, reason: "aborted", provenance: { protectedEvidenceReference: `openai-responses-operation:${intent.operationId}` } };
    try {
      const observed = await this.client.dispatch({ operationId: intent.operationId, idea: intent.prompt, systemInstruction: SYSTEM, maximumInputTokens: maximum(intent, "input_tokens"), maximumOutputTokens: maximum(intent, "output_tokens") });
      return this.#observation(intent, observed);
    } catch (error) {
      if (error instanceof Error && PRE_DISPATCH_REJECTIONS.has(error.message)) return { status: "definitive_not_accepted", operationId: intent.operationId, providerRequestId: intent.providerRequestId, reason: "pre_dispatch_rejected", provenance: { protectedEvidenceReference: `openai-responses-pre-dispatch:${intent.operationId}` } };
      return { status: "usage_unknown", operationId: intent.operationId, providerRequestId: intent.providerRequestId, reason: "lost_response", provenance: { protectedEvidenceReference: `openai-responses-operation:${intent.operationId}` } };
    }
  }
  async lookup(intent: ProviderOperationIntent, signal: AbortSignal): Promise<ModelLookupObservation> {
    if (signal.aborted) return { status: "unresolved", operationId: intent.operationId, providerRequestId: intent.providerRequestId, provenance: { protectedEvidenceReference: `openai-responses-operation:${intent.operationId}` } };
    try {
      const observed = await this.client.reconcileOriginal({ operationId: intent.operationId });
      const result = this.#observation(intent, observed);
      if (result.status === "completed" || result.status === "failed") return { status: "receipt_found", receipt: result.receipt };
      if (result.status === "definitive_not_accepted") return result;
      return { status: "unresolved", operationId: intent.operationId, providerRequestId: intent.providerRequestId, provenance: result.provenance };
    } catch { return { status: "unresolved", operationId: intent.operationId, providerRequestId: intent.providerRequestId, provenance: { protectedEvidenceReference: `openai-responses-operation:${intent.operationId}` } }; }
  }
  async providerReceipt(intent: ProviderOperationIntent): Promise<OpenAiResponsesProviderReceipt | undefined> {
    const observed = await this.client.reconcileOriginal({ operationId: intent.operationId });
    const value = parseOpenAiResponsesProviderReceipt(observed);
    return value?.operationId === intent.operationId ? value : undefined;
  }
  #observation(intent: ProviderOperationIntent, raw: unknown): ModelDispatchObservation {
    const state = z.object({ status: z.enum(["completed", "incomplete", "unknown", "pending"]), operationId: z.string() }).passthrough().safeParse(raw);
    if (!state.success || state.data.operationId !== intent.operationId || state.data.status === "unknown" || state.data.status === "pending") return { status: "usage_unknown", operationId: intent.operationId, providerRequestId: intent.providerRequestId, reason: "uncertain_acceptance", provenance: { protectedEvidenceReference: `openai-responses-operation:${intent.operationId}` } };
    const parsed = parseOpenAiResponsesProviderReceipt(raw);
    if (!parsed) return { status: "usage_unknown", operationId: intent.operationId, providerRequestId: intent.providerRequestId, reason: "malformed_receipt", provenance: { protectedEvidenceReference: `openai-responses-operation:${intent.operationId}` } };
    const normalized = receipt(intent, parsed);
    return parsed.status === "completed" ? { status: "completed", receipt: normalized } : { status: "failed", receipt: normalized };
  }
}
