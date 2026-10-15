import { z } from "zod";

export const UsageDimensionSchema = z.enum(["input_tokens", "output_tokens", "cached_tokens", "reasoning_tokens"]);
const DecimalSchema = z.string().regex(/^(?:0|[1-9][0-9]*)$/u);
const ProtectedEvidenceSchema = z.object({
  protectedEvidenceReference: z.string().min(1),
  protectedEvidenceDigest: z.string().regex(/^[a-f0-9]{64}$/u).optional(),
}).strict();
const ObservationCorrelationSchema = z.object({
  operationId: z.string().min(1),
  providerRequestId: z.string().min(1),
}).strict();
const PromptSchema = z.string().min(1).max(4_000);
const RelativePathSchema = z.string().min(1).max(240).regex(/^(?!\/)(?!.*(?:^|\/)\.\.?\/)[A-Za-z0-9._/-]+$/u);
export const SourceProposalReferenceSchema = z.string().regex(/^proposal:sha256:[a-f0-9]{64}$/u);
export const SourceProposalFileSchema = z.object({ path: RelativePathSchema, content: z.string().min(1).max(64_000) }).strict();
export const SourceProposalSchema = z.object({
  reference: SourceProposalReferenceSchema,
  sha256: z.string().regex(/^[a-f0-9]{64}$/u),
  files: z.array(SourceProposalFileSchema).min(1).max(8),
}).strict().superRefine((proposal, ctx) => {
  if (new Set(proposal.files.map((file) => file.path)).size !== proposal.files.length) ctx.addIssue({ code: "custom", message: "proposal paths must be unique" });
});

/** Persisted, coordinator-created billable request. Provider adapters never receive a mutable price policy. */
export const ProviderOperationIntentSchema = z.object({
  operationId: z.string().min(1), providerRequestId: z.string().min(1), accountId: z.string().min(1), sessionId: z.string().min(1), actionId: z.string().min(1),
  expectedVersion: z.number().int().nonnegative(), actionBudgetReference: z.string().min(1), profileId: z.string().min(1),
  priceCardId: z.string().min(1), requestFingerprint: z.string().regex(/^[a-f0-9]{64}$/u),
  // The default keeps historical reconciliation fixtures decodable. All new
  // dispatch callers supply a bounded prompt before crossing the provider seam.
  prompt: PromptSchema.optional().default("legacy-recovery"), authorizedPriorArtifactReference: z.string().min(1).max(256).optional(),
  maximumUnits: z.array(z.object({ dimension: UsageDimensionSchema, units: DecimalSchema }).strict()).min(1),
  selection: z.literal("unselected"),
}).strict();

export const NormalizedUsageReceiptSchema = z.object({
  operationId: z.string().min(1), providerRequestId: z.string().min(1), provider: z.enum(["deterministic_fixture", "openai_responses", "openai_chatgpt_development"]),
  model: z.string().min(1), profileId: z.string().min(1), priceCardId: z.string().min(1), selection: z.literal("unselected"),
  completedAt: z.iso.datetime(), provenance: ProtectedEvidenceSchema,
  usage: z.array(z.object({ dimension: UsageDimensionSchema, units: DecimalSchema }).strict()).min(1),
}).strict();

export const UsageUnknownReasonSchema = z.enum(["accepted_timeout", "aborted", "lost_response", "malformed_receipt", "mismatched_receipt", "uncertain_acceptance"]);

/** Dispatch may yield an authoritative receipt, proven zero usage, or an explicit ambiguity fence. */
export const ModelDispatchObservationSchema = z.discriminatedUnion("status", [
  z.object({ status: z.literal("completed"), receipt: NormalizedUsageReceiptSchema, sourceProposalReference: SourceProposalReferenceSchema.optional() }).strict(),
  z.object({ status: z.literal("failed"), receipt: NormalizedUsageReceiptSchema, sourceProposalReference: SourceProposalReferenceSchema.optional() }).strict(),
  z.object({ status: z.literal("definitive_not_accepted"), ...ObservationCorrelationSchema.shape, reason: z.literal("pre_dispatch_rejected"), provenance: ProtectedEvidenceSchema }).strict(),
  z.object({ status: z.literal("usage_unknown"), ...ObservationCorrelationSchema.shape, reason: UsageUnknownReasonSchema, provenance: ProtectedEvidenceSchema }).strict(),
]);

/** Lookup has no fresh-dispatch state: it only reports what the stored operation can authoritatively establish. */
export const ModelLookupObservationSchema = z.discriminatedUnion("status", [
  z.object({ status: z.literal("pending"), ...ObservationCorrelationSchema.shape, provenance: ProtectedEvidenceSchema }).strict(),
  z.object({ status: z.literal("receipt_found"), receipt: NormalizedUsageReceiptSchema, sourceProposalReference: SourceProposalReferenceSchema.optional() }).strict(),
  z.object({ status: z.literal("definitive_not_accepted"), ...ObservationCorrelationSchema.shape, reason: z.literal("pre_dispatch_rejected"), provenance: ProtectedEvidenceSchema }).strict(),
  z.object({ status: z.literal("unresolved"), ...ObservationCorrelationSchema.shape, provenance: ProtectedEvidenceSchema }).strict(),
]);

/** Backwards-compatible local name used by the initial funded tracer. */
export const ModelObservationSchema = ModelDispatchObservationSchema;

export type ProviderOperationIntent = z.infer<typeof ProviderOperationIntentSchema>;
export type SourceProposal = z.infer<typeof SourceProposalSchema>;
export type NormalizedUsageReceipt = z.infer<typeof NormalizedUsageReceiptSchema>;
export type ModelDispatchObservation = z.infer<typeof ModelDispatchObservationSchema>;
export type ModelObservation = ModelDispatchObservation;
export type ModelLookupObservation = z.infer<typeof ModelLookupObservationSchema>;

/** The sole provider boundary: project-owned values in, safe normalized observations out. */
export interface ModelGateway {
  dispatch(intent: ProviderOperationIntent, signal: AbortSignal): Promise<ModelDispatchObservation>;
  lookup(intent: ProviderOperationIntent, signal: AbortSignal): Promise<ModelLookupObservation>;
}
