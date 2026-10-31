import { z } from "zod";
import { canonicalJson } from "../promotion/schema";
import { ReleaseAuthorizationRequestSchema, type ReleaseAuthorizationRequest } from "./authorization";

const DigestSchema = z.string().regex(/^[a-f0-9]{64}$/iu).transform((value) => value.toLowerCase());
const NonNegativeIntegerSchema = z.number().int().nonnegative();

export const ReleaseProviderIdSchema = z.enum([
  "cloud_run", "gcs", "collector", "cloud_sql_postgres", "modal", "fly",
  "contextvm", "cep8_lightning", "cashu", "model", "compatible_host", "signer",
  "promoted_cli", "upload", "owner_relay", "attestation_relay",
]);
export type ReleaseProviderId = z.infer<typeof ReleaseProviderIdSchema>;

export const ProviderCapabilityObservationSchema = z.object({
  version: z.literal(1),
  provider: ReleaseProviderIdSchema,
  capability: z.enum(["available", "unavailable", "unsupported"]),
  authentication: z.enum(["authorized", "not_configured", "unavailable"]),
  accountScopeSha256: DigestSchema,
  costEstimateSha256: DigestSchema,
  secretReferenceNames: z.array(z.string().regex(/^[a-z][a-z0-9_.-]{0,127}$/u)).max(8),
  reasonCode: z.enum(["AVAILABLE", "AUTHORIZATION_REQUIRED", "CAPABILITY_UNAVAILABLE", "CREDENTIALS_UNAVAILABLE", "UNSUPPORTED_CAPABILITY"]),
}).strict();
export type ProviderCapabilityObservation = z.infer<typeof ProviderCapabilityObservationSchema>;

export const ReleaseEffectPlanSchema = z.object({
  version: z.literal(1),
  candidateSha256: DigestSchema,
  topologySha256: DigestSchema,
  effects: z.array(z.object({
    id: z.string().regex(/^[a-z][a-z0-9_.-]{2,127}$/u),
    provider: ReleaseProviderIdSchema,
    operation: z.enum(["create_or_update", "benchmark", "configure", "verify_integration"]),
    estimatedCostMicros: NonNegativeIntegerSchema,
  }).strict()).min(1),
  maximumAuthorizedCostMicros: NonNegativeIntegerSchema.positive(),
  effectPlanSha256: DigestSchema,
}).strict();
export type ReleaseEffectPlan = z.infer<typeof ReleaseEffectPlanSchema>;

export const ReleaseTopologyObservationSchema = z.object({
  version: z.literal(1),
  candidateSha256: DigestSchema,
  controlPlane: z.object({
    regions: z.tuple([z.string().min(1), z.string().min(1)]),
    minimumInstancesPerRegion: z.literal(3),
    /** A topology without a receipt-bound registry observation is deliberately
     * non-deployable; it must never substitute the upstream base image. */
    collectorImage: z.union([z.literal("registry-measurement-required"), z.string().regex(/^[a-z0-9.-]+(?:\/[a-z0-9._-]+)+@sha256:[a-f0-9]{64}$/iu)]),
    collectorBuild: z.object({
      manifestDigest: DigestSchema.optional(),
      configDigest: DigestSchema.optional(),
      baseImage: z.string().regex(/^otel\/opentelemetry-collector@sha256:[a-f0-9]{64}$/iu),
      dockerfileSha256: DigestSchema,
      collectorConfigSha256: DigestSchema,
    }).strict(),
  }).strict(),
  objectStore: z.object({
    dualRegion: z.string().min(1), versioning: z.literal(true), retentionDays: z.literal(30),
    encryption: z.literal("customer-managed-key-required"),
    lifecycle: z.literal("delete-after-30-days"),
  }).strict(),
  database: z.object({
    authority: z.literal("cloud_sql_postgres"), serializable: z.literal(true), region: z.string().min(1),
    availabilityType: z.literal("regional"), authorityCount: z.literal(1),
  }).strict(),
  workerCandidates: z.tuple([z.literal("modal"), z.literal("fly")]),
  integrations: z.array(ReleaseProviderIdSchema).length(10),
  deployment: z.object({
    resources: z.array(z.object({
      provider: ReleaseProviderIdSchema,
      operationId: z.string().regex(/^[a-z][a-z0-9_-]{2,127}$/u),
      region: z.string().min(1).max(64),
      desiredDigest: DigestSchema,
      configDigest: DigestSchema,
      resourceIdentitySha256: DigestSchema,
      capability: z.enum(["available", "unavailable", "unsupported"]),
      status: z.literal("observed"),
    }).strict()).length(16),
    routing: z.object({ activeRegions: z.tuple([z.string().min(1), z.string().min(1)]), standby: z.literal("none") }).strict(),
    failureDomains: z.array(z.string().min(1).max(128)).min(1).max(8),
    rtoMinutes: z.number().int().positive().max(10_080),
    rpoMinutes: z.number().int().nonnegative().max(10_080),
    limitations: z.array(z.enum(["DATABASE_CONTINUITY_NOT_CERTIFIED", "OBJECT_STORE_FAILOVER_NOT_CERTIFIED", "WORKER_CONTINUITY_NOT_CERTIFIED", "LIVE_DRILL_REQUIRED"])).min(1).max(4),
  }).strict().optional(),
  topologySha256: DigestSchema,
}).strict();
export type ReleaseTopologyObservation = z.infer<typeof ReleaseTopologyObservationSchema>;

const CandidateIdentitySchema = z.object({
  candidateSha256: DigestSchema,
  sourceSha256: DigestSchema,
  packageSha256: DigestSchema,
  lockfileSha256: DigestSchema,
  toolchainSha256: DigestSchema,
  policySha256: DigestSchema,
  datasetSha256: DigestSchema,
}).strict();

export { ReleaseAuthorizationRequestSchema };
export type { ReleaseAuthorizationRequest };

/** Disjoint successor bytes. Historical v2/v3 authorization records stay
 * query-only and must never be coerced into this envelope. The successor is
 * deliberately only a review binding in Plan 67: it has no receipt issuer,
 * secret reference or effect callback. */
const SuccessorIdentitySchema = z.object({
  candidateSha256: DigestSchema,
  sourceSha256: DigestSchema,
  configSha256: DigestSchema,
  toolchainSha256: DigestSchema,
  topologySha256: DigestSchema,
  failureDomainSha256: DigestSchema,
  retentionSha256: DigestSchema,
  cleanupSha256: DigestSchema,
  controllerStateSha256: DigestSchema,
}).strict();
const SuccessorEnvelopeBindingSchema = z.object({
  providerGraphRevision: z.literal("non-google-v1"),
  roleInventorySha256: DigestSchema,
  roleCostBoundSha256: DigestSchema,
  scopesSha256: DigestSchema,
  effectsSha256: DigestSchema,
}).strict();
export const NonGoogleAuthorizationRequestV3Schema = z.object({
  kind: z.literal("release-authorization-request-v3"),
  version: z.literal(3),
  identity: SuccessorIdentitySchema,
  binding: SuccessorEnvelopeBindingSchema,
  requestSha256: DigestSchema,
}).strict();
export type NonGoogleAuthorizationRequestV3 = z.infer<typeof NonGoogleAuthorizationRequestV3Schema>;

async function successorRequestDigest(input: Readonly<{
  identity: z.infer<typeof SuccessorIdentitySchema>;
  binding: z.infer<typeof SuccessorEnvelopeBindingSchema>;
}>): Promise<string> {
  const bytes = new TextEncoder().encode(canonicalJson({ identity: input.identity, binding: input.binding }));
  const digest = await crypto.subtle.digest("SHA-256", bytes);
  return Array.from(new Uint8Array(digest), (byte) => byte.toString(16).padStart(2, "0")).join("");
}

/** The only v3 constructor.  Its digest binds exactly the canonical identity
 * and binding, and it deliberately has no issuer or effect capability. */
export async function createNonGoogleAuthorizationRequestV3(input: Readonly<{
  identity: unknown;
  binding: unknown;
}>): Promise<NonGoogleAuthorizationRequestV3> {
  const identity = SuccessorIdentitySchema.parse(input.identity);
  const binding = SuccessorEnvelopeBindingSchema.parse(input.binding);
  return NonGoogleAuthorizationRequestV3Schema.parse({
    kind: "release-authorization-request-v3",
    version: 3,
    identity,
    binding,
    requestSha256: await successorRequestDigest({ identity, binding }),
  });
}

/** Verify a successor review record immediately after parsing it. */
export async function verifyNonGoogleAuthorizationRequestV3(input: unknown): Promise<NonGoogleAuthorizationRequestV3> {
  const request = NonGoogleAuthorizationRequestV3Schema.safeParse(input);
  if (!request.success) throw new Error("SUCCESSOR_GRAPH_REQUEST_INVALID");
  if (request.data.requestSha256 !== await successorRequestDigest(request.data)) {
    throw new Error("SUCCESSOR_GRAPH_REQUEST_DIGEST_INVALID");
  }
  return request.data;
}

export const NonGoogleAuthorizationReceiptV4Schema = z.object({
  kind: z.literal("release-authorization-receipt-v4"),
  version: z.literal(4),
  requestSha256: DigestSchema,
  candidateSha256: DigestSchema,
  topologySha256: DigestSchema,
  providerGraphRevision: z.literal("non-google-v1"),
  roleInventorySha256: DigestSchema,
  roleCostBoundSha256: DigestSchema,
  receiptSha256: DigestSchema,
}).strict();
export type NonGoogleAuthorizationReceiptV4 = z.infer<typeof NonGoogleAuthorizationReceiptV4Schema>;

/** A future receipt consumer must revalidate the reviewed v3 binding first.
 * Plan 67 does not construct or issue receipts. */
export async function verifyNonGoogleAuthorizationReceiptV4(input: Readonly<{
  request: unknown;
  receipt: unknown;
}>): Promise<NonGoogleAuthorizationReceiptV4> {
  const request = await verifyNonGoogleAuthorizationRequestV3(input.request);
  const receipt = NonGoogleAuthorizationReceiptV4Schema.parse(input.receipt);
  if (receipt.requestSha256 !== request.requestSha256
    || receipt.candidateSha256 !== request.identity.candidateSha256
    || receipt.topologySha256 !== request.identity.topologySha256
    || receipt.providerGraphRevision !== request.binding.providerGraphRevision
    || receipt.roleInventorySha256 !== request.binding.roleInventorySha256
    || receipt.roleCostBoundSha256 !== request.binding.roleCostBoundSha256) {
    throw new Error("SUCCESSOR_GRAPH_RECEIPT_BINDING_INVALID");
  }
  return receipt;
}

/** Plan 67 deliberately leaves successor issuance closed. Parsing validates
 * only immutable review bytes; the architecture guard stops before any
 * credential or client boundary even when every supplied digest is shaped. */
export function assertNonGoogleSuccessorRequestHeld(input: unknown): never {
  const successor = NonGoogleAuthorizationRequestV3Schema.safeParse(input);
  if (!successor.success) {
    if (ReleaseAuthorizationRequestSchema.safeParse(input).success) throw new Error("SUCCESSOR_GRAPH_HISTORICAL_AUTHORITY_QUERY_ONLY");
    throw new Error("SUCCESSOR_GRAPH_REQUEST_INVALID");
  }
  throw new Error("SUCCESSOR_GRAPH_ARCHITECTURE_GUARD_ACTIVE");
}

export const RELEASE_LIVE_CONTROLLER_STATES = [
  "receipt_valid", "bootstrap", "provisioning", "observing", "billing_observing", "materializing",
  "protected_suite_running", "finalizing", "cleaning", "blocked", "completed",
] as const;

export const ReleaseControllerStateSchema = z.object({
  /** Version 1 records are retained verbatim for dry-run and historical resume.
   * Version 2 adds the receipt-bound live execution state machine. */
  version: z.union([z.literal(1), z.literal(2)]),
  status: z.enum([
    "initialized", "discovering", "authorization_required", "provisioning", "discovering_deployed", "topology_ready",
    "receipt_valid", "bootstrap", "observing", "billing_observing", "materializing", "protected_suite_running", "finalizing", "cleaning",
    "blocked", "completed",
  ]),
  candidate: CandidateIdentitySchema,
  topologySha256: DigestSchema,
  capabilities: z.array(ProviderCapabilityObservationSchema).length(16),
  priorStateSha256: DigestSchema.nullable(),
  authorizationRequestSha256: DigestSchema.nullable(),
  authorizationReceiptSha256: DigestSchema.nullable(),
  providerOperationIds: z.array(z.string().regex(/^[a-z][a-z0-9_-]{2,127}$/u)).max(16),
  /** New live states bind their operation snapshots by content digest. The
   * field stays optional so historical v1/v2 controller states remain
   * readable, but they cannot become new billing evidence. */
  providerOperationRecordSha256s: z.array(DigestSchema).max(16).optional(),
  deployedTopologySha256: DigestSchema.nullable(),
  blockReasonCode: z.enum([
    "AUTHORIZATION_REQUIRED", "PROVIDER_UNAVAILABLE", "PROVIDER_AMBIGUOUS", "TOPOLOGY_DRIFT", "COST_EXCEEDED",
    "EVIDENCE_INVALID", "EVIDENCE_STALE", "PROTECTED_SUITE_BLOCKED", "RESUME_ATTEMPTS_EXHAUSTED",
  ]).nullable(),
  createdAtMs: z.number().int().positive(),
  stateSha256: DigestSchema,
}).strict();
export type ReleaseControllerState = z.infer<typeof ReleaseControllerStateSchema>;

export const ReleaseControllerCurrentPointerSchema = z.object({
  version: z.literal(1),
  stateSha256: DigestSchema,
  candidateSha256: DigestSchema,
  pointerSha256: DigestSchema,
}).strict();

/** Read-only discovery only. Provider implementations must not expose native output. */
export interface ReleaseProviderPort {
  discover(): Promise<Omit<ProviderCapabilityObservation, "version" | "provider" | "accountScopeSha256" | "costEstimateSha256" | "secretReferenceNames"> & Partial<Pick<ProviderCapabilityObservation, "accountScopeSha256" | "costEstimateSha256" | "secretReferenceNames">>>;
}

export type ReleaseProviderRegistry = Partial<Record<ReleaseProviderId, ReleaseProviderPort>>;
