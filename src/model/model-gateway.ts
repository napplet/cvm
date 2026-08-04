import { z } from "zod";

export const UsageDimensionSchema = z.enum(["input_tokens", "output_tokens", "cached_tokens", "reasoning_tokens"]);
const DecimalSchema = z.string().regex(/^(?:0|[1-9][0-9]*)$/u);

/** Persisted, coordinator-created billable request. Provider adapters never receive a mutable price policy. */
export const ProviderOperationIntentSchema = z.object({
  operationId: z.string().min(1), accountId: z.string().min(1), sessionId: z.string().min(1), actionId: z.string().min(1),
  expectedVersion: z.number().int().nonnegative(), actionBudgetReference: z.string().min(1), profileId: z.string().min(1),
  priceCardId: z.string().min(1), requestFingerprint: z.string().regex(/^[a-f0-9]{64}$/u),
  maximumUnits: z.array(z.object({ dimension: UsageDimensionSchema, units: DecimalSchema }).strict()).min(1),
  selection: z.literal("unselected"),
}).strict();

export const NormalizedUsageReceiptSchema = z.object({
  operationId: z.string().min(1), providerRequestId: z.string().min(1), provider: z.literal("deterministic_fixture"),
  model: z.string().min(1), profileId: z.string().min(1), priceCardId: z.string().min(1), selection: z.literal("unselected"),
  completedAt: z.iso.datetime(), provenance: z.object({ protectedEvidenceReference: z.string().min(1) }).strict(),
  usage: z.array(z.object({ dimension: UsageDimensionSchema, units: DecimalSchema }).strict()).min(1),
}).strict();

export const ModelObservationSchema = z.discriminatedUnion("status", [
  z.object({ status: z.literal("completed"), receipt: NormalizedUsageReceiptSchema }).strict(),
  z.object({ status: z.literal("failed"), receipt: NormalizedUsageReceiptSchema }).strict(),
  z.object({ status: z.literal("usage_unknown"), protectedEvidenceReference: z.string().min(1) }).strict(),
]);
export const ModelLookupObservationSchema = z.discriminatedUnion("status", [
  z.object({ status: z.literal("not_found") }).strict(),
  z.object({ status: z.literal("completed"), receipt: NormalizedUsageReceiptSchema }).strict(),
  z.object({ status: z.literal("usage_unknown"), protectedEvidenceReference: z.string().min(1) }).strict(),
]);

export type ProviderOperationIntent = z.infer<typeof ProviderOperationIntentSchema>;
export type NormalizedUsageReceipt = z.infer<typeof NormalizedUsageReceiptSchema>;
export type ModelObservation = z.infer<typeof ModelObservationSchema>;
export type ModelLookupObservation = z.infer<typeof ModelLookupObservationSchema>;

/** The sole provider boundary: project-owned values in, safe normalized observations out. */
export interface ModelGateway {
  dispatch(intent: ProviderOperationIntent, signal: AbortSignal): Promise<ModelObservation>;
  lookup(intent: ProviderOperationIntent, signal: AbortSignal): Promise<ModelLookupObservation>;
}
