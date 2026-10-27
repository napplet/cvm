import { z } from "zod";
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
    /** This is the measured project recipe, never the upstream base image. */
    collectorImage: z.string().regex(/^local\/napplet-cvm-collector@sha256:[a-f0-9]{64}$/iu),
    collectorBuild: z.object({
      imageDigest: DigestSchema,
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

export const RELEASE_LIVE_CONTROLLER_STATES = [
  "receipt_valid", "bootstrap", "provisioning", "observing", "materializing",
  "protected_suite_running", "finalizing", "cleaning", "blocked", "completed",
] as const;

export const ReleaseControllerStateSchema = z.object({
  /** Version 1 records are retained verbatim for dry-run and historical resume.
   * Version 2 adds the receipt-bound live execution state machine. */
  version: z.union([z.literal(1), z.literal(2)]),
  status: z.enum([
    "initialized", "discovering", "authorization_required", "provisioning", "discovering_deployed", "topology_ready",
    "receipt_valid", "bootstrap", "observing", "materializing", "protected_suite_running", "finalizing", "cleaning",
    "blocked", "completed",
  ]),
  candidate: CandidateIdentitySchema,
  topologySha256: DigestSchema,
  capabilities: z.array(ProviderCapabilityObservationSchema).length(16),
  priorStateSha256: DigestSchema.nullable(),
  authorizationRequestSha256: DigestSchema.nullable(),
  authorizationReceiptSha256: DigestSchema.nullable(),
  providerOperationIds: z.array(z.string().regex(/^[a-z][a-z0-9_-]{2,127}$/u)).max(16),
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
