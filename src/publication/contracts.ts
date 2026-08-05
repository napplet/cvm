import { z } from "zod";

const sha256 = z.string().regex(/^[a-f0-9]{64}$/i, "SHA256_REQUIRED");
const identifier = z.string().min(1).max(256);
const publicKey = z.string().regex(/^[a-f0-9]{64}$/i, "PUBLIC_KEY_REQUIRED");

export const VerifiedManifestCapabilitySchema = z.object({
  name: identifier,
  requirement: z.enum(["required", "optional"]),
  purpose: z.string().min(1).max(512),
  consent: z.enum(["required", "optional"]),
  compatibleRuntimes: z.array(identifier).max(32),
  available: z.boolean(),
}).strict();
export type VerifiedManifestCapability = Readonly<z.infer<typeof VerifiedManifestCapabilitySchema>>;

export const SealedArtifactIdentitySchema = z.object({
  accountId: identifier,
  sessionId: identifier,
  artifactId: identifier,
  artifactVersion: z.number().int().nonnegative(),
  aggregateSha256: sha256,
  manifestSha256: sha256,
  verificationEvidenceSha256: sha256,
  sealedObjectGeneration: identifier,
  sealedObjectSha256: sha256,
  entrypoint: z.string().startsWith("/"),
  normalizedDTag: z.string().min(1).max(128).regex(/^[a-z0-9][a-z0-9-]*$/),
  requiredCapabilities: z.array(identifier).max(64),
  optionalCapabilities: z.array(identifier).max(64),
  manifestCapabilities: z.array(VerifiedManifestCapabilitySchema).max(64).optional(),
  policyIdentity: identifier,
  toolchainIdentity: identifier,
  runtimeCompatibilityIdentity: identifier,
}).strict();
export type SealedArtifactIdentity = Readonly<z.infer<typeof SealedArtifactIdentitySchema>>;

export const ManifestCapabilitySchema = z.object({
  capability: identifier,
  name: identifier.optional(),
  requirement: z.enum(["required", "optional"]).optional(),
  purpose: z.string().min(1).max(512),
  consent: z.enum(["required", "optional"]),
  compatibleRuntimes: z.array(identifier).max(32).optional(),
  available: z.boolean(),
}).strict();
export type ManifestCapability = Readonly<z.infer<typeof ManifestCapabilitySchema>>;

export const CapabilityReviewSchema = z.object({
  artifactId: identifier,
  aggregateSha256: sha256,
  normalizedDTag: z.string().min(1).max(128),
  runtimeVariant: identifier,
  required: z.array(ManifestCapabilitySchema).max(64),
  optional: z.array(ManifestCapabilitySchema).max(64),
  compatibility: z.enum(["compatible", "degraded", "incompatible"]),
  capabilityDigest: sha256,
  manifestSha256: sha256.optional(),
  policyIdentity: identifier.optional(),
  toolchainIdentity: identifier.optional(),
  runtimeCompatibilityIdentity: identifier.optional(),
}).strict();
export type CapabilityReview = Readonly<z.infer<typeof CapabilityReviewSchema>>;

export const PreviewDescriptorSchema = z.object({
  artifact: SealedArtifactIdentitySchema,
  review: CapabilityReviewSchema,
  previewGrantId: identifier,
  expiresAtMs: z.number().int().positive(),
  iframeSandbox: z.literal("allow-scripts"),
  authority: z.literal("preview_read_only"),
}).strict();
export type PreviewDescriptor = Readonly<z.infer<typeof PreviewDescriptorSchema>>;

export const PublicationIntentSchema = z.object({
  intentId: identifier,
  accountId: identifier,
  sessionId: identifier,
  ownerPubkey: publicKey,
  artifact: SealedArtifactIdentitySchema,
  artifactSha256: sha256,
  manifestSha256: sha256,
  aggregateSha256: sha256,
  dTag: z.string().min(1).max(128).regex(/^[a-z0-9][a-z0-9-]*$/),
  capabilityDigest: sha256,
  runtimeVariant: identifier,
  policyVersion: identifier,
  toolchainIdentity: identifier,
  purpose: z.string().min(1).max(512),
  consent: z.literal("approved"),
  idempotencyKey: identifier,
  fingerprint: identifier,
  manifestTemplateDigest: sha256,
  createdAtMs: z.number().int().positive(),
  expiresAtMs: z.number().int().positive(),
  status: z.literal("intent_ready"),
}).strict();
export type PublicationIntent = Readonly<z.infer<typeof PublicationIntentSchema>>;

export const OwnerManifestTemplateSchema = z.object({
  kind: z.literal(35129),
  pubkey: publicKey,
  created_at: z.number().int().nonnegative(),
  tags: z.array(z.array(z.string().max(4096)).min(1).max(16)).max(128),
  content: z.string().max(64_000),
  digest: sha256,
}).strict();
export type OwnerManifestTemplate = Readonly<z.infer<typeof OwnerManifestTemplateSchema>>;

/** Public NIP-01 event fields only. This boundary deliberately has no key/token field. */
export const SignedOwnerManifestEventSchema = z.object({
  id: z.string().regex(/^[a-f0-9]{64}$/i),
  pubkey: publicKey,
  created_at: z.number().int().nonnegative(),
  kind: z.literal(35129),
  tags: z.array(z.array(z.string().max(4096)).min(1).max(16)).max(128),
  content: z.string().max(64_000),
  sig: z.string().regex(/^[a-f0-9]{128}$/i),
}).strict();
export type SignedOwnerManifestEvent = Readonly<z.infer<typeof SignedOwnerManifestEventSchema>>;

/** The adapter supplies this only after ContextVM signature verification; it carries no signer material. */
export const SignedPublicationCommandSchema = z.object({
  commandId: identifier,
  intentId: identifier,
  intentFingerprint: sha256,
  operationIds: z.object({
    deploy: identifier,
    ownerManifest: identifier,
    attestation: identifier,
  }).strict(),
}).strict();
export type SignedPublicationCommand = Readonly<z.infer<typeof SignedPublicationCommandSchema>>;

export const CvmBuildAttestationSchema = z.object({
  type: z.literal("cvm_build_attestation"),
  attestationId: identifier,
  ownerEventId: z.string().regex(/^[a-f0-9]{64}$/i),
  ownerPubkey: publicKey,
  artifactId: identifier,
  artifactSha256: sha256,
  aggregateSha256: sha256,
  sessionId: identifier,
  sessionVersion: z.number().int().nonnegative(),
  artifactVersion: z.number().int().nonnegative(),
  policyVersion: identifier,
  toolchainIdentity: identifier,
  verificationEvidenceReference: identifier,
  verificationEvidenceSha256: sha256,
  createdAtMs: z.number().int().positive(),
}).strict();
export type CvmBuildAttestation = Readonly<z.infer<typeof CvmBuildAttestationSchema>>;

export const PublicationEffectIntentSchema = z.object({
  operationId: identifier,
  intentId: identifier,
  kind: z.enum(["deploy", "owner_manifest", "attestation"]),
  aggregateSha256: sha256,
  state: z.enum(["pending", "claimed", "completed", "unknown", "failed"]),
}).strict();
export type PublicationEffectIntent = Readonly<z.infer<typeof PublicationEffectIntentSchema>>;

export const PublicationObservationSchema = z.object({
  operationId: identifier,
  state: z.enum(["completed", "unknown", "failed"]),
  observationId: identifier,
  deploymentId: identifier.optional(),
  fullServerUploadId: identifier.optional(),
  relayObservation: identifier.optional(),
  attestationId: identifier.optional(),
}).strict();
export type PublicationObservation = Readonly<z.infer<typeof PublicationObservationSchema>>;

export const PublicationStatusSchema = z.object({
  status: z.enum(["intent_ready", "publication_reconciliation_pending", "partial", "complete"]),
  intentId: identifier,
  nextAction: z.enum(["sign_manifest", "publish", "reconcile_publication", "none"]),
}).strict();
export type PublicationStatus = Readonly<z.infer<typeof PublicationStatusSchema>>;

export const PublicationResultSchema = PublicationStatusSchema.extend({
  status: z.enum(["partial", "complete"]),
  artifact: SealedArtifactIdentitySchema.pick({ aggregateSha256: true, normalizedDTag: true }),
  capabilityDigest: sha256,
  ownerEventId: z.string().regex(/^[a-f0-9]{64}$/i),
  deploymentId: identifier.optional(),
  fullServerUploadId: identifier.optional(),
  ownerRelayObservation: identifier.optional(),
  attestationId: identifier.optional(),
  attestationRelayObservation: identifier.optional(),
}).strict();
export type PublicationResult = Readonly<z.infer<typeof PublicationResultSchema>>;

export interface SealedArtifactPort {
  readVerified(input: Readonly<{ accountId: string; sessionId: string; artifactId: string }>): Promise<SealedArtifactIdentity>;
}
export interface PreviewHostPort {
  createDescriptor(input: Readonly<{ artifact: SealedArtifactIdentity; review: CapabilityReview; nowMs: number; expiresAtMs: number }>): Promise<Readonly<{ previewGrantId: string; iframeSandbox: "allow-scripts"; authority: "preview_read_only" }>>;
}
export interface OwnerEventVerifierPort {
  verify(input: Readonly<{ event: SignedOwnerManifestEvent; intent: PublicationIntent }>): Promise<Readonly<{ valid?: boolean; accepted?: boolean; eventId?: string; safeReasonCode?: "INVALID_OWNER_MANIFEST"; relayObservation?: string }>>;
}
export interface NappletDeploymentPort {
  deployExact(input: Readonly<{ operationId: string; artifact: SealedArtifactIdentity; signedOwnerManifest: SignedOwnerManifestEvent }>): Promise<PublicationObservation>;
  publishOwnerManifest(input: Readonly<{ operationId: string; event: SignedOwnerManifestEvent }>): Promise<PublicationObservation>;
}
export interface AttestationPort {
  publish(input: Readonly<{ operationId: string; artifact: SealedArtifactIdentity; ownerEventId: string }>): Promise<PublicationObservation>;
}
export interface Phase06Clock { nowMs(): number; }
