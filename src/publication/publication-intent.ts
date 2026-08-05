import { createHash } from "node:crypto";

import { canonicalCapabilityBytes, canonicalCapabilityReviewSync } from "./capability-review.js";
import { CapabilityReviewSchema, PublicationIntentSchema, SealedArtifactIdentitySchema, type CapabilityReview, type OwnerManifestTemplate, type PublicationIntent, type SealedArtifactIdentity } from "./contracts.js";

const encoder = new TextEncoder();
const SHA256 = /^[a-f0-9]{64}$/i;
const D_TAG = /^[a-z0-9][a-z0-9-]{0,127}$/;

type PublicationIntentInput = Readonly<{
  accountId: string;
  sessionId: string;
  artifact: SealedArtifactIdentity;
  review: CapabilityReview;
  ownerPubkey: string;
  idempotencyKey: string;
  purpose: string;
  consent: "approved";
  runtimeVariant: string;
  createdAtMs: number;
  expiresAtMs: number;
}>;

function hash(bytes: Uint8Array): string {
  return createHash("sha256").update(bytes).digest("hex");
}

function canonicalArtifact(artifact: SealedArtifactIdentity) {
  return {
    accountId: artifact.accountId,
    sessionId: artifact.sessionId,
    artifactId: artifact.artifactId,
    artifactVersion: artifact.artifactVersion,
    aggregateSha256: artifact.aggregateSha256,
    manifestSha256: artifact.manifestSha256,
    verificationEvidenceSha256: artifact.verificationEvidenceSha256,
    sealedObjectGeneration: artifact.sealedObjectGeneration,
    sealedObjectSha256: artifact.sealedObjectSha256,
    entrypoint: artifact.entrypoint,
    normalizedDTag: normalizePublicationDTag(artifact.normalizedDTag),
    requiredCapabilities: [...artifact.requiredCapabilities],
    optionalCapabilities: [...artifact.optionalCapabilities],
    manifestCapabilities: artifact.manifestCapabilities ?? null,
    policyIdentity: artifact.policyIdentity,
    toolchainIdentity: artifact.toolchainIdentity,
    runtimeCompatibilityIdentity: artifact.runtimeCompatibilityIdentity,
  };
}

/** Normalizes the promoted named-target grammar and rejects root/snapshot-style values. */
export function normalizePublicationDTag(value: string): string {
  const normalized = value.trim().toLowerCase().replace(/[_\s]+/g, "-").replace(/-+/g, "-");
  if (!D_TAG.test(normalized) || normalized === "root" || normalized === "snapshot") throw new Error("PUBLICATION_D_TAG_INVALID");
  return normalized;
}

function parsedInput(input: PublicationIntentInput) {
  const artifact = SealedArtifactIdentitySchema.parse(input.artifact);
  const review = CapabilityReviewSchema.parse(input.review);
  const canonicalReview = canonicalCapabilityReviewSync(artifact, input.runtimeVariant);
  const dTag = normalizePublicationDTag(artifact.normalizedDTag);
  if (artifact.accountId !== input.accountId || artifact.sessionId !== input.sessionId || review.capabilityDigest.length !== 64 || !SHA256.test(review.capabilityDigest) || review.compatibility === "incompatible" || review.manifestSha256 === undefined || review.policyIdentity === undefined || review.toolchainIdentity === undefined || review.runtimeCompatibilityIdentity === undefined || JSON.stringify(review) !== JSON.stringify(canonicalReview)) throw new Error("PUBLICATION_APPROVAL_BINDING_INVALID");
  // Keep the digest check explicit even though canonical equality already binds it:
  // approval data remains safe if the schema later gains a non-canonical field.
  if (createHash("sha256").update(canonicalCapabilityBytes(review)).digest("hex") !== review.capabilityDigest) throw new Error("PUBLICATION_APPROVAL_BINDING_INVALID");
  if (!Number.isInteger(input.createdAtMs) || !Number.isInteger(input.expiresAtMs) || input.createdAtMs <= 0 || input.expiresAtMs <= input.createdAtMs) throw new Error("PUBLICATION_EXPIRY_INVALID");
  return { artifact, review, dTag };
}

/** Versioned, exact UTF-8 approval bytes. The capability digest already binds its runtime detail. */
export function canonicalPublicationIntentBytes(input: PublicationIntentInput): Uint8Array {
  const { artifact, review, dTag } = parsedInput(input);
  return encoder.encode(JSON.stringify({
    v: 1,
    accountId: input.accountId,
    sessionId: input.sessionId,
    ownerPubkey: input.ownerPubkey.toLowerCase(),
    artifact: canonicalArtifact({ ...artifact, normalizedDTag: dTag }),
    artifactSha256: artifact.aggregateSha256,
    manifestSha256: artifact.manifestSha256,
    aggregateSha256: artifact.aggregateSha256,
    dTag,
    capabilityDigest: review.capabilityDigest.toLowerCase(),
    runtimeVariant: input.runtimeVariant,
    policyVersion: artifact.policyIdentity,
    toolchainIdentity: artifact.toolchainIdentity,
    purpose: input.purpose,
    consent: input.consent,
    idempotencyKey: input.idempotencyKey,
    createdAtMs: input.createdAtMs,
    expiresAtMs: input.expiresAtMs,
  }));
}

export function publicationIntentFingerprint(input: PublicationIntentInput): string {
  return hash(canonicalPublicationIntentBytes(input));
}

/** Builds the immutable owner-scoped record before the host/external signer sees its public template. */
export function createPublicationIntent(input: PublicationIntentInput): PublicationIntent {
  const { artifact, review, dTag } = parsedInput(input);
  const fingerprint = publicationIntentFingerprint(input);
  const intentId = `intent:${fingerprint}`;
  const draft = {
    intentId,
    accountId: input.accountId,
    sessionId: input.sessionId,
    ownerPubkey: input.ownerPubkey.toLowerCase(),
    artifact: { ...artifact, normalizedDTag: dTag },
    artifactSha256: artifact.aggregateSha256,
    manifestSha256: artifact.manifestSha256,
    aggregateSha256: artifact.aggregateSha256,
    dTag,
    capabilityDigest: review.capabilityDigest.toLowerCase(),
    runtimeVariant: input.runtimeVariant,
    policyVersion: artifact.policyIdentity,
    toolchainIdentity: artifact.toolchainIdentity,
    purpose: input.purpose,
    consent: input.consent,
    idempotencyKey: input.idempotencyKey,
    fingerprint,
    manifestTemplateDigest: "0".repeat(64),
    createdAtMs: input.createdAtMs,
    expiresAtMs: input.expiresAtMs,
    status: "intent_ready" as const,
  };
  const withoutDigest = PublicationIntentSchema.parse(draft);
  const template = canonicalOwnerManifestTemplate(withoutDigest);
  return PublicationIntentSchema.parse({ ...withoutDigest, manifestTemplateDigest: template.digest });
}

/** This is public signing data only. No signer, token, callback, or private key crosses this boundary. */
export function canonicalOwnerManifestTemplate(intentInput: PublicationIntent): OwnerManifestTemplate {
  const intent = PublicationIntentSchema.parse(intentInput);
  const tags = [
    ["d", intent.dTag],
    ["x", intent.aggregateSha256],
    ["manifest", intent.manifestSha256],
    ["capability", intent.capabilityDigest],
    ["intent", intent.intentId],
    ["expires-at-ms", `${intent.expiresAtMs}`],
  ] as const;
  const content = JSON.stringify({
    v: 1,
    artifactId: intent.artifact.artifactId,
    artifactSha256: intent.artifactSha256,
    manifestSha256: intent.manifestSha256,
    aggregateSha256: intent.aggregateSha256,
    dTag: intent.dTag,
    capabilityDigest: intent.capabilityDigest,
    intentId: intent.intentId,
    runtimeVariant: intent.runtimeVariant,
    policyVersion: intent.policyVersion,
    toolchainIdentity: intent.toolchainIdentity,
    expiresAtMs: intent.expiresAtMs,
  });
  const unsigned = { kind: 35129 as const, pubkey: intent.ownerPubkey, created_at: Math.floor(intent.createdAtMs / 1000), tags, content };
  return Object.freeze({ ...unsigned, digest: hash(encoder.encode(JSON.stringify(unsigned))) });
}

export function isPublicationIntentExpired(intentInput: PublicationIntent, nowMs: number): boolean {
  const intent = PublicationIntentSchema.parse(intentInput);
  if (!Number.isInteger(nowMs)) throw new Error("PUBLICATION_CLOCK_INVALID");
  return nowMs >= intent.expiresAtMs;
}
