import { z } from "zod";

import { PreviewDescriptorSchema, type PreviewDescriptor } from "./contracts.js";

const RuntimeObservationSchema = z.object({
  state: z.enum(["ready", "incompatible", "expired", "denied"]),
}).passthrough();

const PreviewRuntimeStatusSchema = z.object({
  state: z.enum(["ready", "incompatible", "expired", "denied"]),
  artifactId: z.string().min(1),
  artifactSha256: z.string().regex(/^[a-f0-9]{64}$/i),
  descriptorId: z.string().min(1),
  operationId: z.string().min(1),
  runtimeVariant: z.string().min(1),
  capabilityDigest: z.string().regex(/^[a-f0-9]{64}$/i),
  missingRequired: z.array(z.string().min(1)),
  unavailableOptional: z.array(z.string().min(1)),
  expiresAt: z.number().int().positive(),
  nextAction: z.enum(["preview", "review_capabilities"]),
  safeReasonCode: z.enum(["none", "runtime_incompatible", "preview_expired", "runtime_denied"]),
}).strict();

export type PreviewRuntimeStatus = Readonly<z.infer<typeof PreviewRuntimeStatusSchema>>;
export type SafePreviewDenial = Readonly<{ state: "denied"; safeReasonCode: "preview_not_available"; nextAction: "preview" }>;

export function safePreviewDenial(): SafePreviewDenial {
  return Object.freeze({ state: "denied", safeReasonCode: "preview_not_available", nextAction: "preview" });
}

/** Projects attacker-controlled runtime observations into the finite owner-safe status contract. */
export function projectPreviewRuntimeStatus(input: Readonly<{ descriptor: unknown; observation: unknown; nowMs: number }>): PreviewRuntimeStatus {
  const descriptor = PreviewDescriptorSchema.parse(input.descriptor);
  const observation = RuntimeObservationSchema.safeParse(input.observation);
  const missingRequired = descriptor.review.required.filter((capability) => !capability.available).map((capability) => capability.capability);
  const unavailableOptional = descriptor.review.optional.filter((capability) => !capability.available).map((capability) => capability.capability);
  const expired = !Number.isInteger(input.nowMs) || input.nowMs >= descriptor.expiresAtMs;
  const state = expired ? "expired" : observation.success ? observation.data.state : "denied";
  const safeReasonCode = state === "expired" ? "preview_expired"
    : state === "incompatible" ? "runtime_incompatible"
      : state === "denied" ? "runtime_denied" : "none";
  const nextAction = state === "ready" || state === "incompatible" ? "review_capabilities" : "preview";
  return Object.freeze(PreviewRuntimeStatusSchema.parse({
    state,
    artifactId: descriptor.artifact.artifactId,
    artifactSha256: descriptor.artifact.aggregateSha256,
    descriptorId: descriptor.previewGrantId,
    operationId: `preview:${descriptor.previewGrantId}`,
    runtimeVariant: descriptor.review.runtimeVariant,
    capabilityDigest: descriptor.review.capabilityDigest,
    missingRequired,
    unavailableOptional,
    expiresAt: descriptor.expiresAtMs,
    nextAction,
    safeReasonCode,
  }));
}
