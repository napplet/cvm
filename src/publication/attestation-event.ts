import { createHash } from "node:crypto";

import { CvmBuildAttestationSchema, SealedArtifactIdentitySchema, type CvmBuildAttestation } from "./contracts.js";

const encoder = new TextEncoder();
const digest = (value: unknown): string => createHash("sha256").update(encoder.encode(JSON.stringify(value))).digest("hex");

/** Builds a service provenance record only; it links the owner event but does not claim owner authorship. */
export function buildCvmAttestation(input: Readonly<{
  ownerEventId: string;
  ownerPubkey: string;
  artifact: unknown;
  sessionVersion: number;
  policyVersion: string;
  toolchainIdentity: string;
  verificationEvidenceReference: string;
  createdAtMs: number;
}>): CvmBuildAttestation {
  const artifact = SealedArtifactIdentitySchema.parse(input.artifact);
  const record = {
    type: "cvm_build_attestation" as const,
    ownerEventId: input.ownerEventId,
    ownerPubkey: input.ownerPubkey.toLowerCase(),
    artifactId: artifact.artifactId,
    artifactSha256: artifact.aggregateSha256,
    aggregateSha256: artifact.aggregateSha256,
    sessionId: artifact.sessionId,
    sessionVersion: input.sessionVersion,
    artifactVersion: artifact.artifactVersion,
    policyVersion: input.policyVersion,
    toolchainIdentity: input.toolchainIdentity,
    verificationEvidenceReference: input.verificationEvidenceReference,
    verificationEvidenceSha256: artifact.verificationEvidenceSha256,
    createdAtMs: input.createdAtMs,
  };
  return Object.freeze(CvmBuildAttestationSchema.parse({ ...record, attestationId: `attestation:${digest(record)}` }));
}
