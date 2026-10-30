import { z } from "zod";
import { DirectPublicationIntentSchema, directPublicationDigest } from "./direct-publication";

const Digest = z.string().regex(/^[a-f0-9]{64}$/u);
const Body = z.object({ version: z.literal("direct-cvm-build-attestation-v1"), intentId: DirectPublicationIntentSchema.shape.intentId,
  reviewSha256: Digest, ownerEventId: Digest, ownerPubkey: Digest, artifact: DirectPublicationIntentSchema.shape.review.shape.artifact,
  capabilitiesSha256: Digest, candidateSha256: Digest, topologySha256: Digest, effectPlanSha256: Digest,
  uploadLocation: z.string().url().max(1024), createdAtMs: z.number().int().positive().safe() }).strict();
export const DirectCvmBuildAttestationSchema = Body.extend({ attestationId: z.string().regex(/^direct-attestation:[a-f0-9]{64}$/u) }).strict();
export async function createDirectCvmBuildAttestation(value: z.input<typeof Body>) {
  const body = Body.parse(value), url = new URL(body.uploadLocation);
  if (body.artifact.artifactId !== `artifact:${body.artifact.archiveSha256}` || url.protocol !== "https:" || url.username || url.password || url.search || url.hash
    || url.pathname !== `/${body.artifact.artifactHash}`) throw new Error("DIRECT_ATTESTATION_BINDING_REQUIRED");
  return DirectCvmBuildAttestationSchema.parse({ ...body, attestationId: `direct-attestation:${await directPublicationDigest(body)}` });
}
export async function validateDirectCvmBuildAttestation(value: unknown) {
  const record = DirectCvmBuildAttestationSchema.parse(value), { attestationId, ...body } = record;
  if ((await createDirectCvmBuildAttestation(body)).attestationId !== attestationId) throw new Error("DIRECT_ATTESTATION_DIGEST_REQUIRED");
  return record;
}
