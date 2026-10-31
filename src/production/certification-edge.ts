import { ProductionDirectPublicationCertification } from "./direct-publication-certification";
import { canonicalJson } from "../promotion/schema";
import { DirectPublicationReferenceSchema, DirectPublicationSourceObservationSchema, DirectPublicationSubmissionSchema } from "../certification/live/direct-publication-contract";
import { z } from "zod";

import { assertProductionSessionBroker, type ProductionSessionBroker } from "../release/deployment/production-session-runtime";
import { ProductionPublicationCertification } from "./publication-certification";

const DigestSchema = z.string().regex(/^[a-f0-9]{64}$/iu).transform(value => value.toLowerCase());
const OperationIdSchema = z.string().regex(/^[a-z][a-z0-9:_-]{2,127}$/u);
const EdgeKindSchema = z.enum([
  "edge.security.build", "edge.security.hostile", "edge.security.browser", "edge.security.signer",
  "edge.supply.primary", "edge.supply.secondary", "edge.supply.attestation",
  "edge.payment.contextvm", "edge.payment.cep8", "edge.payment.model",
  "edge.publication.source", "edge.publication.submit", "edge.publication.reconcile",
  "edge.publication.direct.source", "edge.publication.direct.submit", "edge.publication.direct.reconcile",
]);

export type CertificationEdgeKind = z.infer<typeof EdgeKindSchema>;

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

const services = new WeakSet<object>();

/**
 * Controller-side edge dispatcher. The only injectable value is the sealed
 * Plan 67 broker; requests can select a named, schema-checked operation but
 * can never supply a browser, signer, command, rail, relay, report, or any
 * credentials. The source-build verifier is itself a sealed deployment
 * component and is invoked with immutable operation facts, rather than a
 * caller-provided command or callback.
 */
export class ProductionCertificationEdgeService {
  readonly #broker: ProductionSessionBroker;
  readonly #publication: ProductionPublicationCertification;

  constructor(input: Readonly<{ broker: unknown }>) {
    assertProductionSessionBroker(input.broker);
    this.#broker = input.broker;
    this.#publication = new ProductionPublicationCertification(input.broker.candidateSha256, input.broker.clients);
    services.add(this);
    Object.freeze(this);
  }

  async execute(raw: unknown): Promise<unknown> {
    const command = z.object({ operationId: OperationIdSchema, kind: EdgeKindSchema, payload: z.unknown() }).strict().parse(raw);
    const schema = CertificationEdgePayloadSchemas[command.kind];
    const payload = schema.parse(command.payload) as Record<string, unknown>;
    if (payload.candidateId !== this.#broker.candidateSha256) throw new Error("CERTIFICATION_EDGE_CANDIDATE_MISMATCH");

    switch (command.kind) {
      case "edge.security.browser": {
        const observed = await this.#broker.clients.edge.compatibleHost.runBrowser({ sealedArtifactSha256: payload.sealedArtifactSha256 as string, aggregateSha256: payload.aggregateSha256 as string });
        return observed;
      }
      case "edge.security.signer": {
        const observed = await this.#broker.clients.edge.signer.inspectSignerBoundary({ sealedArtifactSha256: payload.sealedArtifactSha256 as string, aggregateSha256: payload.aggregateSha256 as string });
        return observed;
      }
      case "edge.payment.contextvm": {
        // This is deliberately an original-operation query. It cannot create a
        // replacement session after a signed request has become ambiguous.
        const observed = await this.#broker.clients.contextvmCertification.observeOriginal({ operationId: command.operationId });
        if (observed.state !== "observed") throw new Error("CERTIFICATION_EDGE_CONTEXTVM_ORIGINAL_UNAVAILABLE");
        return this.#verify(command, payload, observed);
      }
      case "edge.payment.model": {
        const openAi = this.#broker.clients.edge.openAiResponses;
        if (!openAi) throw new Error("CERTIFICATION_EDGE_OPENAI_SUCCESSOR_HELD");
        // The Responses client only observes the durable original: unknown
        // response IDs never POST again, while known IDs use its fixed GET.
        return openAi.client.reconcileOriginal({ operationId: command.operationId });
      }
      case "edge.payment.cep8": {
        // The native providers own wallet/NWC material.  Counts are consulted
        // only as an additional invariant; the sealed verifier performs the
        // rail scenarios and rejects a claim unless its durable original IDs
        // prove exactly-one credit on each rail.
        const scenario = await this.#broker.clients.paymentScenarioContext.resolve({ candidateSha256: this.#broker.candidateSha256, operationId: command.operationId });
        const observed = Object.freeze({
          scenario,
          lightningVerifiedSettlements: this.#broker.clients.edge.cep8.verifiedSettlementCount(),
          cashuVerifiedSettlements: this.#broker.clients.edge.cashu.verifiedSettlementCount(),
        });
        return this.#verify(command, payload, observed);
      }
      case "edge.publication.direct.source": return this.#direct(CertificationEdgePayloadSchemas["edge.publication.direct.source"].parse(payload).reference).source();
      case "edge.publication.direct.submit": { const value = CertificationEdgePayloadSchemas[command.kind].parse(payload); return this.#direct(value.source.original).submit(value.source); }
      case "edge.publication.direct.reconcile": { const value = CertificationEdgePayloadSchemas[command.kind].parse(payload); return this.#direct(value.submitted.original).reconcile(value.submitted); }
      case "edge.publication.source": return this.#publication.source();
      case "edge.publication.submit": return this.#publication.submit(PublicationSubmitPayloadSchema.parse(payload));
      case "edge.publication.reconcile": return this.#publication.reconcile(PublicationReconcilePayloadSchema.parse(payload));
      default:
        return this.#verify(command, payload);
    }
  }

  /** Original control recovery never re-enters execute(), NIP-46, CLI upload
   * or event publication. Only the three known publication kinds have a
   * read-only recovery path; other edge suites retain their refusal. */
  async reconcile(raw: unknown): Promise<unknown> {
    const command = z.object({ operationId: OperationIdSchema, kind: EdgeKindSchema, payload: z.unknown() }).strict().parse(raw);
    const payload = CertificationEdgePayloadSchemas[command.kind].parse(command.payload) as Record<string, unknown>;
    if (payload.candidateId !== this.#broker.candidateSha256) throw new Error("CERTIFICATION_EDGE_CANDIDATE_MISMATCH");
    if (command.kind === "edge.publication.direct.source") return this.#direct(CertificationEdgePayloadSchemas[command.kind].parse(payload).reference).source();
    if (command.kind === "edge.publication.direct.submit") { const value = CertificationEdgePayloadSchemas[command.kind].parse(payload); return this.#direct(value.source.original).observeSubmit(value.source); }
    if (command.kind === "edge.publication.direct.reconcile") { const value = CertificationEdgePayloadSchemas[command.kind].parse(payload); return this.#direct(value.submitted.original).reconcile(value.submitted); }
    if (command.kind === "edge.publication.source") return this.#publication.source();
    if (command.kind === "edge.publication.submit") return this.#publication.observeSubmit(PublicationSubmitPayloadSchema.parse(payload));
    if (command.kind === "edge.publication.reconcile") return this.#publication.reconcile(PublicationReconcilePayloadSchema.parse(payload));
    throw new Error("CERTIFICATION_EDGE_ORIGINAL_RECOVERY_UNAVAILABLE");
  }

  #direct(value: Readonly<{ principal: Readonly<{ pubkey: string }>; idempotencyKey: string }>) {
    const factory = this.#broker.clients.directPublication, expected = this.#broker.clients.directPublicationReference;
    if (!factory || !expected) throw new Error("CERTIFICATION_DIRECT_PUBLICATION_MATERIAL_REQUIRED");
    const parsed = DirectPublicationReferenceSchema.parse({ principal: value.principal, idempotencyKey: value.idempotencyKey });
    if (canonicalJson(parsed) !== canonicalJson(expected)) throw new Error("CERTIFICATION_DIRECT_PUBLICATION_REFERENCE_REQUIRED");
    return new ProductionDirectPublicationCertification(factory, expected, this.#broker.candidateSha256, this.#broker.topologySha256);
  }

  async #verify(command: Readonly<{ operationId: string; kind: CertificationEdgeKind }>, payload: Record<string, unknown>, observation?: unknown): Promise<unknown> {
    // The sealed verifier executes the fixed source-build/worker contract and
    // returns a transport-derived, schema-validated report. It receives no
    // shell text or report supplied by the private HTTP caller.
    return this.#broker.clients.sourceBuild.verify(Object.freeze({
      authority: "production-real" as const,
      operationId: command.operationId,
      kind: command.kind,
      candidateSha256: this.#broker.candidateSha256,
      topologySha256: this.#broker.topologySha256,
      payload: Object.freeze({ ...payload }),
      ...(observation === undefined ? {} : { observation }),
    }));
  }
}

export function assertProductionCertificationEdgeService(value: unknown): asserts value is ProductionCertificationEdgeService {
  if (!value || typeof value !== "object" || !services.has(value)) throw new Error("CERTIFICATION_EDGE_SERVICE_REQUIRED");
}
