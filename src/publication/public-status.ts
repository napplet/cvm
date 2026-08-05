import { z } from "zod";

import { PreviewDescriptorSchema, type PreviewDescriptor, type PublicationIntent, type SignedOwnerManifestEvent } from "./contracts.js";
import type { PublicationRecord } from "../persistence/publication-store.js";

const RuntimeObservationSchema = z.object({ state: z.enum(["ready", "incompatible", "expired", "denied"]) }).passthrough();
const PreviewRuntimeStatusSchema = z.object({
  state: z.enum(["ready", "incompatible", "expired", "denied"]), artifactId: z.string().min(1), artifactSha256: z.string().regex(/^[a-f0-9]{64}$/i), descriptorId: z.string().min(1), operationId: z.string().min(1), runtimeVariant: z.string().min(1), capabilityDigest: z.string().regex(/^[a-f0-9]{64}$/i), missingRequired: z.array(z.string().min(1)), unavailableOptional: z.array(z.string().min(1)), expiresAt: z.number().int().positive(), nextAction: z.enum(["preview", "review_capabilities"]), safeReasonCode: z.enum(["none", "runtime_incompatible", "preview_expired", "runtime_denied"]),
}).strict();
export type PreviewRuntimeStatus = Readonly<z.infer<typeof PreviewRuntimeStatusSchema>>;
export type SafePreviewDenial = Readonly<{ state: "denied"; safeReasonCode: "preview_not_available"; nextAction: "preview" }>;

export function safePreviewDenial(): SafePreviewDenial { return Object.freeze({ state: "denied", safeReasonCode: "preview_not_available", nextAction: "preview" }); }

/** Projects attacker-controlled runtime observations into the finite owner-safe status contract. */
export function projectPreviewRuntimeStatus(input: Readonly<{ descriptor: unknown; observation: unknown; nowMs: number }>): PreviewRuntimeStatus {
  const descriptor = PreviewDescriptorSchema.parse(input.descriptor);
  const observation = RuntimeObservationSchema.safeParse(input.observation);
  const missingRequired = descriptor.review.required.filter((capability) => !capability.available).map((capability) => capability.capability);
  const unavailableOptional = descriptor.review.optional.filter((capability) => !capability.available).map((capability) => capability.capability);
  const expired = !Number.isInteger(input.nowMs) || input.nowMs >= descriptor.expiresAtMs;
  const state = expired ? "expired" : observation.success ? observation.data.state : "denied";
  const safeReasonCode = state === "expired" ? "preview_expired" : state === "incompatible" ? "runtime_incompatible" : state === "denied" ? "runtime_denied" : "none";
  const nextAction = state === "ready" || state === "incompatible" ? "review_capabilities" : "preview";
  return Object.freeze(PreviewRuntimeStatusSchema.parse({ state, artifactId: descriptor.artifact.artifactId, artifactSha256: descriptor.artifact.aggregateSha256, descriptorId: descriptor.previewGrantId, operationId: `preview:${descriptor.previewGrantId}`, runtimeVariant: descriptor.review.runtimeVariant, capabilityDigest: descriptor.review.capabilityDigest, missingRequired, unavailableOptional, expiresAt: descriptor.expiresAtMs, nextAction, safeReasonCode }));
}

export type ProjectedPublicationStatus = Readonly<{
  state: "intent_ready" | "publication_reconciliation_pending" | "partial" | "complete";
  intentId: string;
  artifactId: string;
  ownerEventId?: string;
  attestationId?: string;
  deployOperationId: string;
  safeServerEvidenceCount: number;
  safeRelayEvidenceCount: number;
  nextAction: "sign_manifest" | "publish" | "reconcile_publication" | "none";
}>;

export function publicationCompletionPredicate(record: PublicationRecord, event?: SignedOwnerManifestEvent): boolean {
  const deploy = record.effects.deploy.observation;
  const owner = record.effects.owner_manifest.observation;
  const attestation = record.effects.attestation.observation;
  return event !== undefined && deploy?.state === "completed" && Boolean(deploy.fullServerUploadId) && owner?.state === "completed" && Boolean(owner.relayObservation) && attestation?.state === "completed" && Boolean(attestation.attestationId) && Boolean(attestation.relayObservation);
}

/** Projects only stored identities and evidence references; provider payloads never cross this boundary. */
export function projectPublicationStatus(input: Readonly<{ intent: PublicationIntent; record: PublicationRecord; event?: SignedOwnerManifestEvent }>): ProjectedPublicationStatus {
  const deploy = input.record.effects.deploy;
  const owner = input.record.effects.owner_manifest;
  const attestation = input.record.effects.attestation;
  const complete = publicationCompletionPredicate(input.record, input.event);
  const unresolved = [deploy, owner, attestation].some((effect) => ["created", "dispatching", "unknown"].includes(effect.state));
  const state = complete ? "complete" : !input.event ? "intent_ready" : unresolved ? "publication_reconciliation_pending" : "partial";
  const relayCount = Number(Boolean(owner.observation?.relayObservation)) + Number(Boolean(attestation.observation?.relayObservation));
  return Object.freeze({
    state,
    intentId: input.intent.intentId,
    artifactId: input.intent.artifact.artifactId,
    ...(input.event ? { ownerEventId: input.event.id } : {}),
    ...(attestation.observation?.attestationId ? { attestationId: attestation.observation.attestationId } : {}),
    deployOperationId: deploy.operationId,
    safeServerEvidenceCount: Number(Boolean(deploy.observation?.fullServerUploadId)),
    safeRelayEvidenceCount: relayCount,
    nextAction: state === "complete" ? "none" : state === "intent_ready" ? "sign_manifest" : state === "partial" || state === "publication_reconciliation_pending" ? "reconcile_publication" : "publish",
  });
}
