import { ProductionWorkerPublicationSchema } from "../../worker-adapters/publication-metadata";
import { z } from "zod";
import { ProductionDirectToolchainReceiptSchema } from "../../worker-adapters/direct-toolchain-receipt";
import { DirectPublicationIntentSchema, directPublicationDigest } from "../../publication/direct-publication";
import { DIRECT_CLI_NETWORK_IDENTITY } from "../../production/pinned-direct-cli-network";

const Digest = z.string().regex(/^[a-f0-9]{64}$/u);
export const DirectPublicationOriginalSchema = z.object({ principal: z.object({ pubkey: Digest }).strict(), idempotencyKey: z.string().min(1).max(256),
  intentId: DirectPublicationIntentSchema.shape.intentId, reviewSha256: Digest }).strict();
export const DirectPublicationReferenceSchema = DirectPublicationOriginalSchema.pick({ principal: true, idempotencyKey: true }).strict();
export const DirectPublicationOperationIdsSchema = z.object({ upload: z.string().regex(/^direct-upload:[a-f0-9]{64}$/u),
  owner: z.string().regex(/^direct-owner-relay:[a-f0-9]{64}$/u), attestation: z.string().regex(/^direct-attestation-relay:[a-f0-9]{64}$/u) }).strict();
export const DirectPublicationSourceObservationSchema = z.object({ version: z.literal("direct-publication-observation-v1"), status: z.literal("verified-source-bytes"), artifactContract: z.literal("nip5d-direct-v1"),
  candidateSha256: Digest, topologySha256: Digest, artifactHash: Digest, archiveSha256: Digest, toolchainSha256: Digest, server: ProductionWorkerPublicationSchema.shape.server,
  toolchain: ProductionDirectToolchainReceiptSchema,
  helper: z.object({ version: z.literal(DIRECT_CLI_NETWORK_IDENTITY.version), sourceCommit: z.literal(DIRECT_CLI_NETWORK_IDENTITY.sourceCommit), bundleSha256: z.literal(DIRECT_CLI_NETWORK_IDENTITY.bundleSha256) }).strict(),
  productionPromotion: z.literal("not_asserted"), original: DirectPublicationOriginalSchema, operationIds: DirectPublicationOperationIdsSchema }).strict();
export const DirectPublicationSubmissionSchema = z.object({ version: z.literal("direct-publication-observation-v1"), status: z.literal("submitted"),
  artifactContract: z.literal("nip5d-direct-v1"), candidateSha256: Digest, topologySha256: Digest, artifactHash: Digest, archiveSha256: Digest,
  original: DirectPublicationOriginalSchema, operationIds: DirectPublicationOperationIdsSchema, ownerEventId: Digest, attestationEventId: Digest, userSigningExternal: z.literal(true) }).strict();
export const DirectPublicationReconciliationSchema = DirectPublicationSubmissionSchema.omit({ status: true }).extend({ status: z.literal("complete"),
  locationReference: z.string().url().max(1024), originalOperationsOnly: z.literal(true) }).strict();
export async function directPublicationOperationIds(intentId: string) {
  const digest = await directPublicationDigest(DirectPublicationIntentSchema.shape.intentId.parse(intentId));
  return DirectPublicationOperationIdsSchema.parse({ upload: `direct-upload:${digest}`, owner: `direct-owner-relay:${digest}`, attestation: `direct-attestation-relay:${digest}` });
}
export type LiveDirectPublicationObservationPort = Readonly<{ artifactContract: "nip5d-direct-v1"; evidenceClass: "protected_live" | "deterministic";
  verifyPromotedSource(input: Readonly<{ candidateId: string }>): Promise<unknown>;
  submitOriginalPublication(source: z.infer<typeof DirectPublicationSourceObservationSchema>): Promise<unknown>;
  reconcileOriginalPublication(submitted: z.infer<typeof DirectPublicationSubmissionSchema>): Promise<unknown>;
}>;
