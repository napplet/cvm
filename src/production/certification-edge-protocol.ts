import { z } from "zod";

import { DirectPublicationReferenceSchema, DirectPublicationSourceObservationSchema, DirectPublicationSubmissionSchema } from "../certification/live/direct-publication-contract";

const DigestSchema = z.string().regex(/^[a-f0-9]{64}$/iu).transform(value => value.toLowerCase());
const OperationIdSchema = z.string().regex(/^[a-z][a-z0-9:_-]{2,127}$/u);
export const CertificationEdgeKindSchema = z.enum([
  "edge.security.build", "edge.security.hostile", "edge.security.browser", "edge.security.signer",
  "edge.supply.primary", "edge.supply.secondary", "edge.supply.attestation",
  "edge.payment.contextvm", "edge.payment.cep8", "edge.payment.model",
  "edge.publication.source", "edge.publication.submit", "edge.publication.reconcile",
  "edge.publication.direct.source", "edge.publication.direct.submit", "edge.publication.direct.reconcile",
]);
export type CertificationEdgeKind = z.infer<typeof CertificationEdgeKindSchema>;

const SecurityBuildPayloadSchema = z.object({ candidateId: DigestSchema, image: z.string().regex(/^.+@sha256:[a-f0-9]{64}$/iu) }).strict();
const SecurityIdentitySchema = z.object({ candidateId: DigestSchema, sealedArtifactSha256: DigestSchema, manifestSha256: DigestSchema, capabilitiesSha256: DigestSchema, aggregateSha256: DigestSchema }).strict();
const BrowserPayloadSchema = z.object({ candidateId: DigestSchema, sealedArtifactSha256: DigestSchema, aggregateSha256: DigestSchema, requiredViewports: z.tuple([z.literal(1280), z.literal(768), z.literal(375)]), browser: z.literal("chromium") }).strict();
const SignerPayloadSchema = z.object({ candidateId: DigestSchema, sealedArtifactSha256: DigestSchema, aggregateSha256: DigestSchema, signerProtocol: z.literal("nip-46"), requireExternalOwnerKey: z.literal(true) }).strict();
const SupplyBuildPayloadSchema = z.object({ candidateId: DigestSchema, build: z.enum(["primary", "secondary"]), frozenLockfile: z.literal(true), required: z.tuple([z.literal("skills"), z.literal("boilerplate"), z.literal("sdk"), z.literal("vite"), z.literal("conformance"), z.literal("cli"), z.literal("chromium")]) }).strict();
const SupplyAttestationPayloadSchema = z.object({ candidateId: DigestSchema, require: z.tuple([z.literal("sbom"), z.literal("provenance"), z.literal("golden"), z.literal("waiver_drill"), z.literal("rollback_drill"), z.literal("cross_environment_bytes")]) }).strict();
const ContextVmPayloadSchema = z.object({ candidateId: DigestSchema, protocol: z.literal("contextvm"), rail: z.literal("cep-8"), require: z.tuple([z.literal("signed_invocation"), z.literal("replay"), z.literal("redelivery"), z.literal("reconnect"), z.literal("original_session_observation")]) }).strict();
const Cep8PayloadSchema = z.object({ candidateId: DigestSchema, rails: z.tuple([z.literal("lightning"), z.literal("cashu")]), require: z.tuple([z.literal("cashu_semantic_identity"), z.literal("cashu_reencoding_replay"), z.literal("cashu_ambiguous_ownership"), z.literal("nwc_lost_create"), z.literal("one_credit")]) }).strict();
const ModelPayloadSchema = z.object({ candidateId: DigestSchema, require: z.tuple([z.literal("openai_responses_usage"), z.literal("openai_price_digest"), z.literal("cap"), z.literal("exact_settlement"), z.literal("cancellation"), z.literal("known_id_get_only"), z.literal("unknown_id_held"), z.literal("one_dispatch"), z.literal("one_debit")]) }).strict();
const PublicationSourcePayloadSchema = z.object({ candidateId: DigestSchema, require: z.tuple([z.literal("promoted_cli_source"), z.literal("promoted_cli_asset"), z.literal("manifest_artifact_hash_binding")]) }).strict();
const PublicationSubmitPayloadSchema = z.object({ candidateId: DigestSchema, sealedArtifactSha256: DigestSchema, aggregateSha256: DigestSchema, require: z.tuple([z.literal("cli_upload"), z.literal("external_nip46_owner_signature"), z.literal("separate_attestation_key"), z.literal("owner_relay"), z.literal("attestation_relay")]) }).strict();
const PublicationReconcilePayloadSchema = z.object({ candidateId: DigestSchema, intentId: z.string().min(1).max(256), operationIds: z.object({ deploy: z.string().min(1).max(300), ownerManifest: z.string().min(1).max(300), attestation: z.string().min(1).max(300) }).strict(), require: z.tuple([z.literal("original_operation_ids_only"), z.literal("partial_upload"), z.literal("partial_relay"), z.literal("bounded_owned_cleanup")]) }).strict();

export const CertificationEdgePayloadSchemas = Object.freeze({
  "edge.security.build": SecurityBuildPayloadSchema,
  "edge.security.hostile": SecurityIdentitySchema,
  "edge.security.browser": BrowserPayloadSchema,
  "edge.security.signer": SignerPayloadSchema,
  "edge.supply.primary": SupplyBuildPayloadSchema,
  "edge.supply.secondary": SupplyBuildPayloadSchema,
  "edge.supply.attestation": SupplyAttestationPayloadSchema,
  "edge.payment.contextvm": ContextVmPayloadSchema,
  "edge.payment.cep8": Cep8PayloadSchema,
  "edge.payment.model": ModelPayloadSchema,
  "edge.publication.direct.source": z.object({ candidateId: DigestSchema, reference: DirectPublicationReferenceSchema }).strict(),
  "edge.publication.direct.submit": z.object({ candidateId: DigestSchema, source: DirectPublicationSourceObservationSchema }).strict(),
  "edge.publication.direct.reconcile": z.object({ candidateId: DigestSchema, submitted: DirectPublicationSubmissionSchema }).strict(),
  "edge.publication.source": PublicationSourcePayloadSchema,
  "edge.publication.submit": PublicationSubmitPayloadSchema,
  "edge.publication.reconcile": PublicationReconcilePayloadSchema,
} as const);
export type ProductionCertificationEdgeCommand = Readonly<{ operationId: string; kind: CertificationEdgeKind; payload: unknown }>;
