import { z } from "zod";
import type { ModelDispatchObservation, ModelGateway, ModelLookupObservation, NormalizedUsageReceipt, ProviderOperationIntent } from "../model/model-gateway";
import type { createVertexDeploymentClient, VertexProviderReceipt } from "../release/deployment/vertex-client";
import { ProductionSourceProposalStore } from "./source-proposal-store";

const Result = z.object({ files: z.array(z.object({ path: z.enum(["src/main.ts", "src/styles.css", "src/capabilities.json"]), content: z.string().min(1).max(30_000) }).strict()).min(1).max(3) }).strict();
const SYSTEM = "Return one focused napplet as JSON with only files src/main.ts, src/styles.css, and optional src/capabilities.json. Do not use network, relay, signer, storage outside declared SDK capabilities, dynamic imports, workers, or server code.";

function receipt(intent: ProviderOperationIntent, value: VertexProviderReceipt): NormalizedUsageReceipt {
  if (value.operationId !== intent.operationId) throw new Error("PRODUCTION_VERTEX_OPERATION_BINDING_INVALID");
  return {
    // `providerRequestId` is the coordinator's durable provider-operation
    // identity.  Vertex's interaction id remains in protected provenance; it
    // cannot replace the value the ledger persisted before dispatch.
    operationId: value.operationId, providerRequestId: intent.providerRequestId, provider: "vertex_ai_gemini", model: value.model,
    profileId: intent.profileId, priceCardId: intent.priceCardId, selection: "unselected", completedAt: value.completedAt,
    provenance: { protectedEvidenceReference: `vertex-receipt:${value.operationId}:${value.interactionId}`, protectedEvidenceDigest: value.requestSha256 },
    usage: [
      { dimension: "input_tokens", units: String(value.usage.inputTokens) }, { dimension: "cached_tokens", units: String(value.usage.cachedInputTokens) },
      { dimension: "output_tokens", units: String(value.usage.outputTokens) }, { dimension: "reasoning_tokens", units: String(value.usage.thoughtTokens) },
    ],
  };
}
function maximum(intent: ProviderOperationIntent): number {
  const units = intent.maximumUnits.filter(unit => unit.dimension === "output_tokens" || unit.dimension === "reasoning_tokens").reduce((sum, unit) => sum + Number(unit.units), 0);
  if (!Number.isSafeInteger(units) || units < 1 || units > 100_000) throw new Error("PRODUCTION_VERTEX_OUTPUT_BOUND_REQUIRED");
  return units;
}
function maximumInput(intent: ProviderOperationIntent): number {
  const bound = Number(intent.maximumUnits.find(unit => unit.dimension === "input_tokens")?.units);
  if (!Number.isSafeInteger(bound) || bound < 1 || bound > 100_000) throw new Error("PRODUCTION_VERTEX_INPUT_BOUND_REQUIRED");
  return bound;
}

/** Adapts the durable Vertex original-operation client to the transport-neutral
 * generation core. It has no retries: ambiguous Vertex observations become
 * query-only reconciliation states and no source proposal is persisted. */
export class ProductionVertexModelGateway implements ModelGateway {
  constructor(private readonly input: Readonly<{ vertex: ReturnType<typeof createVertexDeploymentClient>; proposals: ProductionSourceProposalStore }>) {}
  async dispatch(intent: ProviderOperationIntent, signal: AbortSignal): Promise<ModelDispatchObservation> {
    if (signal.aborted) return { status: "usage_unknown", operationId: intent.operationId, providerRequestId: intent.providerRequestId, reason: "aborted", provenance: { protectedEvidenceReference: `vertex-operation:${intent.operationId}` } };
    try { return await this.#observation(intent, await this.input.vertex.dispatch({ operationId: intent.operationId, idea: intent.prompt, systemInstruction: SYSTEM, maximumOutputTokens: maximum(intent), maximumInputTokens: maximumInput(intent) })); }
    catch (error) {
      // These checks run before a fresh provider journal claim/POST. Transport
      // failures occur inside the client and remain original-only unknowns.
      if (error instanceof Error && ["VERTEX_INPUT_CAP_EXCEEDED", "VERTEX_PRICE_SNAPSHOT_STALE", "PRODUCTION_VERTEX_INPUT_BOUND_REQUIRED"].includes(error.message)) return { status: "definitive_not_accepted", operationId: intent.operationId, providerRequestId: intent.providerRequestId, reason: "pre_dispatch_rejected", provenance: { protectedEvidenceReference: `vertex-pre-dispatch:${intent.operationId}` } };
      return { status: "usage_unknown", operationId: intent.operationId, providerRequestId: intent.providerRequestId, reason: "lost_response", provenance: { protectedEvidenceReference: `vertex-operation:${intent.operationId}` } };
    }
  }
  async lookup(intent: ProviderOperationIntent, signal: AbortSignal): Promise<ModelLookupObservation> {
    if (signal.aborted) return { status: "unresolved", operationId: intent.operationId, providerRequestId: intent.providerRequestId, provenance: { protectedEvidenceReference: `vertex-operation:${intent.operationId}` } };
    try {
      const observed = await this.input.vertex.reconcileOriginal({ operationId: intent.operationId });
      const state = z.object({ status: z.enum(["completed", "incomplete", "pending", "unknown"]), operationId: z.string() }).passthrough().safeParse(observed);
      if (!state.success || state.data.operationId !== intent.operationId) return { status: "unresolved", operationId: intent.operationId, providerRequestId: intent.providerRequestId, provenance: { protectedEvidenceReference: `vertex-operation:${intent.operationId}` } };
      // A durable operation is known but not terminal.  This is distinct from
      // dispatch ambiguity and tells the ledger to reconcile rather than make
      // a second Vertex request.
      if (state.data.status === "pending") return { status: "pending", operationId: intent.operationId, providerRequestId: intent.providerRequestId, provenance: { protectedEvidenceReference: `vertex-operation:${intent.operationId}` } };
      if (state.data.status === "unknown") return { status: "unresolved", operationId: intent.operationId, providerRequestId: intent.providerRequestId, provenance: { protectedEvidenceReference: `vertex-operation:${intent.operationId}` } };
      const result = await this.#observation(intent, observed);
      if (result.status === "completed" || result.status === "failed") return { status: "receipt_found", receipt: result.receipt, ...(result.sourceProposalReference ? { sourceProposalReference: result.sourceProposalReference } : {}) };
      if (result.status === "definitive_not_accepted") return result;
      return result.status === "usage_unknown" ? { status: "unresolved", operationId: intent.operationId, providerRequestId: intent.providerRequestId, provenance: result.provenance } : { status: "pending", operationId: intent.operationId, providerRequestId: intent.providerRequestId, provenance: { protectedEvidenceReference: `vertex-operation:${intent.operationId}` } };
    } catch { return { status: "unresolved", operationId: intent.operationId, providerRequestId: intent.providerRequestId, provenance: { protectedEvidenceReference: `vertex-operation:${intent.operationId}` } }; }
  }
  /** Coordinator-only exact original receipt for sat settlement.  It is a
   * read/reconcile operation, never a second model dispatch. */
  async providerReceipt(intent: ProviderOperationIntent): Promise<VertexProviderReceipt | undefined> {
    const observed = await this.input.vertex.reconcileOriginal({ operationId: intent.operationId });
    const value = observed as Partial<VertexProviderReceipt>;
    if ((value.status !== "completed" && value.status !== "incomplete") || value.operationId !== intent.operationId) return undefined;
    const normalized = receipt(intent, value as VertexProviderReceipt);
    if (normalized.providerRequestId !== intent.providerRequestId) return undefined;
    return value as VertexProviderReceipt;
  }
  async #observation(intent: ProviderOperationIntent, raw: unknown): Promise<ModelDispatchObservation> {
    const result = z.object({ status: z.enum(["completed", "incomplete", "pending", "unknown"]), operationId: z.string(), interactionId: z.string().optional(), generatedResult: z.string().optional() }).passthrough().safeParse(raw);
    if (!result.success || result.data.operationId !== intent.operationId) return { status: "usage_unknown", operationId: intent.operationId, providerRequestId: intent.providerRequestId, reason: "mismatched_receipt", provenance: { protectedEvidenceReference: `vertex-operation:${intent.operationId}` } };
    if (result.data.status === "pending") return { status: "usage_unknown", operationId: intent.operationId, providerRequestId: intent.providerRequestId, reason: "accepted_timeout", provenance: { protectedEvidenceReference: `vertex-operation:${intent.operationId}` } };
    if (result.data.status === "unknown") return { status: "usage_unknown", operationId: intent.operationId, providerRequestId: intent.providerRequestId, reason: "uncertain_acceptance", provenance: { protectedEvidenceReference: `vertex-operation:${intent.operationId}` } };
    const parsedReceipt = raw as VertexProviderReceipt; const normalized = receipt(intent, parsedReceipt);
    if (result.data.status === "incomplete") return { status: "failed", receipt: normalized };
    let decoded: unknown;
    try { decoded = JSON.parse(result.data.generatedResult ?? "null"); }
    catch { return { status: "failed", receipt: normalized }; }
    const proposal = Result.safeParse(decoded);
    if (!proposal.success) return { status: "failed", receipt: normalized };
    const saved = await this.input.proposals.persist({ intent, provider: "vertex_ai_gemini", model: "gemini-4-argon", proposal: proposal.data });
    return { status: "completed", receipt: normalized, sourceProposalReference: saved.proposal.reference };
  }
}
