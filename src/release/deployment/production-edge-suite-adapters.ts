import { DirectPublicationReferenceSchema, DirectPublicationSourceObservationSchema, DirectPublicationSubmissionSchema, type LiveDirectPublicationObservationPort } from "../../certification/live/direct-publication-contract";
import type { z } from "zod";
import type { LiveContextVmPaymentModelObservationPort } from "../../certification/live/contextvm-payment-model";
import type { LivePublicationObservationPort } from "../../certification/live/publication";
import type { LiveSecurityHostObservationPort } from "../../certification/live/security-host";
import type { LiveSupplyChainObservationPort } from "../../certification/live/supply-chain";
import { CoreControlKindSchema, ProductionCoreControlClient } from "./production-core-control";
import { assertNonGooglePrivateControlClient } from "./non-google-private-control";
import type { CertificationEdgeKind } from "../../production/certification-edge";

const DIGEST = /^[a-f0-9]{64}$/iu;
const OPERATION = /^[a-z][a-z0-9_-]{2,127}$/u;
type Candidate = Readonly<{ candidateId: string }>;
type SecurityIdentity = Readonly<{ sealedArtifactSha256: string; manifestSha256: string; capabilitiesSha256: string; aggregateSha256: string }>;
type BrowserIdentity = Readonly<{ sealedArtifactSha256: string; aggregateSha256: string }>;
type PublicationSource = Readonly<{ sealedArtifactSha256: string; aggregateSha256: string }>;
type PublicationOperation = Readonly<{ intentId: string; operationIds: Readonly<{ deploy: string; ownerManifest: string; attestation: string }> }>;
type Real<T> = Omit<T, "evidenceClass"> & Readonly<{ evidenceClass: "real"; origin: "project-owned" }>;

export type ProductionEdgeSuiteAdapters = Readonly<{
  "security-host": Real<LiveSecurityHostObservationPort>;
  "supply-chain": Real<LiveSupplyChainObservationPort>;
  "ContextVM-payment-model": Real<LiveContextVmPaymentModelObservationPort>;
  publication: Real<LivePublicationObservationPort> | Real<LiveDirectPublicationObservationPort>;
}>;

function candidate(value: unknown): string {
  if (typeof value !== "string" || !DIGEST.test(value)) throw new Error("PRODUCTION_EDGE_CANDIDATE_REQUIRED");
  return value.toLowerCase();
}
function operation(value: string): string {
  if (!OPERATION.test(value)) throw new Error("PRODUCTION_EDGE_OPERATION_ID_INVALID");
  return value;
}

/** Executes an exact, receipt-bound private operation. The control client
 * persists original identity before POST, revalidates authorization before
 * auth/network, and on repeat uses GET for that original operation only. */
type EdgeControl = Readonly<{
  binding: Readonly<{ candidateSha256: string }>;
  execute(input: Readonly<{ operationId: string; kind: CertificationEdgeKind; payload: unknown }>): Promise<Readonly<{ state: string; result?: unknown }>>;
}>;

async function execute(control: EdgeControl, kind: CertificationEdgeKind, operationId: string, payload: unknown): Promise<unknown> {
  const observed = await control.execute({ operationId: operation(operationId), kind: CoreControlKindSchema.parse(kind) as CertificationEdgeKind, payload });
  if (observed.state !== "completed" || observed.result === undefined) throw new Error("PRODUCTION_EDGE_OPERATION_NOT_COMPLETE");
  return observed.result;
}

/**
 * Sole concrete Plan 69 factory. It accepts the branded private control
 * client, never caller-supplied observation callbacks or manual reports. Its
 * deployed control implementation owns the actual sealed-worker/Chromium,
 * source-build/SBOM/provenance, signed ContextVM/CEP-8/OpenAI Responses, and promoted
 * CLI/NIP-46/upload/relay operations. Construction is no-effect; every call
 * is receipt/candidate/topology bound by ProductionCoreControlClient.
 */
function createAdapters(input: Readonly<{ candidateId: unknown; control: EdgeControl; artifactContract?: "nip5d-direct-v1"; directPublicationReference?: z.infer<typeof DirectPublicationReferenceSchema> }>): ProductionEdgeSuiteAdapters {
  const candidateId = candidate(input.candidateId);
  const control = input.control;
  if (control.binding.candidateSha256 !== candidateId) throw new Error("PRODUCTION_EDGE_CANDIDATE_MISMATCH");

  const securityHost = Object.freeze({
    origin: "project-owned" as const, evidenceClass: "real" as const,
    runSealedBuild(value: Readonly<{ candidateId: string; image: string }>) {
      if (value.candidateId !== candidateId) throw new Error("PRODUCTION_EDGE_CANDIDATE_MISMATCH");
      return execute(control, "edge.security.build", "security_host_build", { candidateId, image: value.image });
    },
    runHostileMatrix(value: SecurityIdentity) { return execute(control, "edge.security.hostile", "security_host_hostile", { candidateId, ...value }); },
    runBrowser(value: BrowserIdentity) { return execute(control, "edge.security.browser", "security_host_browser", { candidateId, ...value, requiredViewports: [1280, 768, 375], browser: "chromium" }); },
    inspectSignerBoundary(value: BrowserIdentity) { return execute(control, "edge.security.signer", "security_host_signer", { candidateId, ...value, signerProtocol: "nip-46", requireExternalOwnerKey: true }); },
  });
  const supplyChain = Object.freeze({
    origin: "project-owned" as const, evidenceClass: "real" as const,
    runBuild(build: "primary" | "secondary") {
      return execute(control, build === "primary" ? "edge.supply.primary" : "edge.supply.secondary", build === "primary" ? "supply_chain_primary" : "supply_chain_secondary", { candidateId, build, frozenLockfile: true, required: ["skills", "boilerplate", "sdk", "vite", "conformance", "cli", "chromium"] });
    },
    supplyChainInput() { return execute(control, "edge.supply.attestation", "supply_chain_attestation", { candidateId, require: ["sbom", "provenance", "golden", "waiver_drill", "rollback_drill", "cross_environment_bytes"] }); },
  });
  const paymentModel = Object.freeze({
    origin: "project-owned" as const, evidenceClass: "real" as const,
    exerciseSignedTransport(value: Candidate) {
      if (value.candidateId !== candidateId) throw new Error("PRODUCTION_EDGE_CANDIDATE_MISMATCH");
      return execute(control, "edge.payment.contextvm", "contextvm_signed_transport", { candidateId, protocol: "contextvm", rail: "cep-8", require: ["signed_invocation", "replay", "redelivery", "reconnect", "original_session_observation"] });
    },
    exerciseCep8Settlement(value: Candidate) {
      if (value.candidateId !== candidateId) throw new Error("PRODUCTION_EDGE_CANDIDATE_MISMATCH");
      return execute(control, "edge.payment.cep8", "cep8_original_settlement", { candidateId, rails: ["lightning", "cashu"], require: ["cashu_semantic_identity", "cashu_reencoding_replay", "cashu_ambiguous_ownership", "nwc_lost_create", "one_credit"] });
    },
    reconcileOriginalModelOperation(value: Candidate) {
      if (value.candidateId !== candidateId) throw new Error("PRODUCTION_EDGE_CANDIDATE_MISMATCH");
      return execute(control, "edge.payment.model", "model_original_operation", { candidateId, require: ["openai_responses_usage", "openai_price_digest", "cap", "exact_settlement", "cancellation", "known_id_get_only", "unknown_id_held", "one_dispatch", "one_debit"] });
    },
  });
  const publication = Object.freeze({
    origin: "project-owned" as const, evidenceClass: "real" as const,
    verifyPromotedSource(value: Candidate) {
      if (value.candidateId !== candidateId) throw new Error("PRODUCTION_EDGE_CANDIDATE_MISMATCH");
      return execute(control, "edge.publication.source", "publication_source", { candidateId, require: ["promoted_cli_source", "promoted_cli_asset", "manifest_artifact_hash_binding"] });
    },
    submitOriginalPublication(value: PublicationSource) { return execute(control, "edge.publication.submit", "publication_submit", { candidateId, ...value, require: ["cli_upload", "external_nip46_owner_signature", "separate_attestation_key", "owner_relay", "attestation_relay"] }); },
    reconcileOriginalPublication(value: PublicationOperation) { return execute(control, "edge.publication.reconcile", "publication_reconcile", { candidateId, ...value, require: ["original_operation_ids_only", "partial_upload", "partial_relay", "bounded_owned_cleanup"] }); },
  });
  if (input.artifactContract === "nip5d-direct-v1") {
    const reference = DirectPublicationReferenceSchema.parse(input.directPublicationReference);
    const direct: Real<LiveDirectPublicationObservationPort> = Object.freeze({ artifactContract: "nip5d-direct-v1", origin: "project-owned", evidenceClass: "real",
      verifyPromotedSource(value: Candidate) {
        if (value.candidateId !== candidateId) throw new Error("PRODUCTION_EDGE_CANDIDATE_MISMATCH");
        return execute(control, "edge.publication.direct.source", "direct_publication_source", { candidateId, reference });
      },
      submitOriginalPublication(value) { const source = DirectPublicationSourceObservationSchema.parse(value); return execute(control, "edge.publication.direct.submit", "direct_publication_submit", { candidateId, source }); },
      reconcileOriginalPublication(value) { const submitted = DirectPublicationSubmissionSchema.parse(value); return execute(control, "edge.publication.direct.reconcile", "direct_publication_reconcile", { candidateId, submitted }); },
    });
    return Object.freeze({ "security-host": securityHost, "supply-chain": supplyChain, "ContextVM-payment-model": paymentModel, publication: direct });
  }
  return Object.freeze({ "security-host": securityHost, "supply-chain": supplyChain, "ContextVM-payment-model": paymentModel, publication });
}

/** The historical Cloud Run/ADC path is retained only to read or recover the
 * legacy graph. It is intentionally not selectable by successor adapters. */
export function createLegacyProductionEdgeSuiteAdapters(input: Readonly<{ candidateId: unknown; control: unknown; artifactContract?: "nip5d-direct-v1"; directPublicationReference?: z.infer<typeof DirectPublicationReferenceSchema> }>): ProductionEdgeSuiteAdapters {
  if (!(input.control instanceof ProductionCoreControlClient)) throw new Error("PRODUCTION_EDGE_CONTROL_CLIENT_REQUIRED");
  return createAdapters({ ...input, control: input.control });
}

/** Successor-only edge adapters require the private homelab/Coolify transport.
 * A Cloud Run client, descriptor, callback, or self-declared native object is
 * rejected before any operation is constructed. */
export function createProductionEdgeSuiteAdapters(input: Readonly<{ candidateId: unknown; control: unknown; artifactContract?: "nip5d-direct-v1"; directPublicationReference?: z.infer<typeof DirectPublicationReferenceSchema> }>): ProductionEdgeSuiteAdapters {
  assertNonGooglePrivateControlClient(input.control);
  return createAdapters({ ...input, control: input.control });
}
