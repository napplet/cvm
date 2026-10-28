import { z } from "zod";
import {
  ReleaseAuthorizationReceiptSchema,
  validateAuthorizationReceipt,
  validateAuthorizationRequest,
  type ReleaseAuthorizationReceipt,
  type ReleaseAuthorizationRequest,
} from "../authorization";
import { canonicalJson } from "../../promotion/schema";

const DigestSchema = z.string().regex(/^[a-f0-9]{64}$/iu).transform((value) => value.toLowerCase());
const ImageDigestSchema = z.string().regex(/^sha256:[a-f0-9]{64}$/iu).transform((value) => value.toLowerCase());
const OperationIdSchema = z.string().regex(/^[a-z][a-z0-9_-]{2,127}$/u);
const ProjectIdSchema = z.string().regex(/^[a-z][a-z0-9-]{4,28}[a-z0-9]$/u);
const RegionSchema = z.string().regex(/^[a-z]+-[a-z]+[0-9]$/u);
const ServiceNameSchema = z.string().regex(/^[a-z][a-z0-9-]{2,62}$/u);
const ServiceAccountReferenceSchema = z.string().regex(/^serviceAccounts\/[a-z][a-z0-9-]{2,62}@[a-z][a-z0-9-]{4,28}[a-z0-9]\.iam\.gserviceaccount\.com$/u);
const IngressSchema = z.literal("internal-and-cloud-load-balancing");

const CloudRunConfigSchema = z.object({
  candidateSha256: DigestSchema,
  topologySha256: DigestSchema,
  effectPlanSha256: DigestSchema,
  accountScopeSha256: DigestSchema,
  projectScopeSha256: DigestSchema,
  projectId: ProjectIdSchema,
  serviceName: ServiceNameSchema,
  serviceAccountReference: ServiceAccountReferenceSchema,
  imageDigest: ImageDigestSchema,
  environmentReferenceSha256: DigestSchema,
  minimumInstances: z.literal(3),
  ingress: IngressSchema,
  concurrency: z.number().int().min(1).max(1_000),
  admissionRefusal: z.literal("capacity_unavailable"),
}).strict();
type CloudRunConfig = z.infer<typeof CloudRunConfigSchema>;

const CompletedObservationSchema = z.object({
  status: z.literal("completed"), operationId: OperationIdSchema, projectId: ProjectIdSchema, region: RegionSchema, serviceName: ServiceNameSchema,
  revisionName: z.string().regex(/^[a-z][a-z0-9-]{2,62}-[a-z0-9-]{3,62}$/u), imageDigest: ImageDigestSchema,
  serviceAccountReference: ServiceAccountReferenceSchema, environmentReferenceSha256: DigestSchema, minimumInstances: z.literal(3),
  ingress: IngressSchema, concurrency: z.number().int().min(1).max(1_000), admissionRefusal: z.literal("capacity_unavailable"),
  generationQueueResourceCount: z.literal(0),
}).strict();
const ObservationSchema = z.union([
  CompletedObservationSchema,
  z.object({ status: z.enum(["missing", "pending", "unknown", "blocked"]) }).strict(),
]);
type CloudRunObservation = z.infer<typeof ObservationSchema>;
const CleanupObservationSchema = z.object({ status: z.enum(["cleaned", "missing", "pending", "unknown", "blocked"]) }).strict();

export type CloudRunControlPlanePort = Readonly<{
  /** Persisting an original operation is a coordinator-owned, injected durability seam. */
  persist(input: Readonly<{ operationId: string; kind: "deploy" | "cleanup"; authorizationRequestSha256: string; authorizationReceiptSha256: string; projectScopeSha256: string }>): Promise<void>;
  /** Read-only reconciliation of exactly one run-owned service operation. */
  observe(input: Readonly<{ operationId: string; projectId: string; region: string; serviceName: string }>): Promise<unknown>;
  /** Read-only reconciliation of the original service and its cleanup intent. Never dispatches deletion. */
  observeCleanup(input: Readonly<{ operationId: string; projectId: string; region: string; serviceName: string }>): Promise<unknown>;
  deploy(input: Readonly<{ operationId: string; projectId: string; region: string; serviceName: string; imageDigest: string; serviceAccountReference: string; environmentReferenceSha256: string; minimumInstances: 3; ingress: "internal-and-cloud-load-balancing"; concurrency: number; admissionRefusal: "capacity_unavailable" }>): Promise<void>;
  /** Never accepts arbitrary service names. It resolves only after deletion is actually confirmed. */
  deleteService(input: Readonly<{ operationId: string; projectId: string; region: string; serviceName: string }>): Promise<void>;
}>;

export type CloudRunProviderInput = Readonly<{ request: unknown; receipt: unknown; operationId: string; region: string }>;
type Authorized = Readonly<{ request: ReleaseAuthorizationRequest; receipt: ReleaseAuthorizationReceipt; operationId: string; region: string }>;

async function sha256(value: unknown): Promise<string> {
  const bytes = new TextEncoder().encode(canonicalJson(value));
  const hash = await crypto.subtle.digest("SHA-256", bytes);
  return Array.from(new Uint8Array(hash), (byte) => byte.toString(16).padStart(2, "0")).join("");
}

function cloudRunScopeIsBound(request: ReleaseAuthorizationRequest, config: CloudRunConfig): boolean {
  const effects = request.orderedEffects.filter((effect) => effect.provider === "cloud_run");
  const scopes = request.providerScopes.filter((scope) => scope.provider === "cloud_run");
  return effects.length === 1 && effects[0]?.id === "cloud-run-ingress" && effects[0]?.operation === "create_or_update"
    && scopes.length === 1 && scopes[0]?.accountScopeSha256 === config.accountScopeSha256 && scopes[0]?.projectScopeSha256 === config.projectScopeSha256;
}

async function authorize(input: CloudRunProviderInput, config: CloudRunConfig, nowMs: number, readOnly = false): Promise<Authorized> {
  try {
    const request = await validateAuthorizationRequest(input.request);
    const originalReceipt = ReleaseAuthorizationReceiptSchema.parse(input.receipt);
    const receipt = await validateAuthorizationReceipt({ request, receipt: originalReceipt, nowMs: readOnly ? Math.min(nowMs, originalReceipt.expiresAtMs - 1) : nowMs });
    const operationId = OperationIdSchema.parse(input.operationId);
    const region = RegionSchema.parse(input.region);
    if (request.candidateSha256 !== config.candidateSha256 || request.topologySha256 !== config.topologySha256
      || request.effectPlanSha256 !== config.effectPlanSha256 || !cloudRunScopeIsBound(request, config)
      || receipt.candidateSha256 !== config.candidateSha256 || receipt.topologySha256 !== config.topologySha256
      || receipt.effectPlanSha256 !== config.effectPlanSha256) throw new Error("scope");
    return Object.freeze({ request, receipt, operationId, region });
  } catch {
    throw new Error("CLOUD_RUN_AUTHORIZATION_INVALID");
  }
}

function observationMatches(observation: CloudRunObservation, authorized: Authorized, config: CloudRunConfig): observation is z.infer<typeof CompletedObservationSchema> {
  return observation.status === "completed" && observation.operationId === authorized.operationId && observation.projectId === config.projectId
    && observation.region === authorized.region && observation.serviceName === config.serviceName && observation.imageDigest === config.imageDigest
    && observation.serviceAccountReference === config.serviceAccountReference && observation.environmentReferenceSha256 === config.environmentReferenceSha256
    && observation.minimumInstances === config.minimumInstances && observation.ingress === config.ingress && observation.concurrency === config.concurrency
    && observation.admissionRefusal === config.admissionRefusal && observation.generationQueueResourceCount === 0;
}

/**
 * Native Cloud Run composition is intentionally only a receipt-gated adapter.
 * The protected runner injects persistence and official API clients; this module
 * neither authenticates, creates a client, nor introduces a durable work queue.
 */
export function createNativeCloudRunProvider(input: Readonly<{ config: unknown; port: CloudRunControlPlanePort; now?: () => number }>) {
  const config = Object.freeze(CloudRunConfigSchema.parse(input.config));
  const now = input.now ?? Date.now;
  const configSha256 = sha256(config);

  async function observeAuthorized(authorized: Authorized) {
    const observation = ObservationSchema.parse(await input.port.observe({ operationId: authorized.operationId, projectId: config.projectId, region: authorized.region, serviceName: config.serviceName }));
    if (observation.status === "completed" && !observationMatches(observation, authorized, config)) throw new Error("CLOUD_RUN_OBSERVATION_MISMATCH");
    return observation;
  }

  return Object.freeze({
    async plan(raw: CloudRunProviderInput) {
      const authorized = await authorize(raw, config, now());
      return Object.freeze({ status: "planned" as const, operationId: authorized.operationId, region: authorized.region, candidateSha256: config.candidateSha256, topologySha256: config.topologySha256, configSha256: await configSha256, imageDigest: config.imageDigest, serviceAccountReferenceSha256: await sha256(config.serviceAccountReference), environmentReferenceSha256: config.environmentReferenceSha256, minimumInstances: 3 as const, ingress: config.ingress, concurrency: config.concurrency, admissionRefusal: config.admissionRefusal, generationQueue: "absent" as const });
    },
    async apply(raw: CloudRunProviderInput) {
      const authorized = await authorize(raw, config, now());
      await input.port.persist({ operationId: authorized.operationId, kind: "deploy", authorizationRequestSha256: authorized.request.authorizationRequestSha256, authorizationReceiptSha256: authorized.receipt.authorizationReceiptSha256, projectScopeSha256: config.projectScopeSha256 });
      const existing = await observeAuthorized(authorized);
      if (existing.status === "completed") return Object.freeze({ status: "completed" as const, reused: true as const, revisionSha256: await sha256(existing.revisionName) });
      if (existing.status !== "missing") throw new Error(existing.status === "blocked" ? "CLOUD_RUN_OPERATION_BLOCKED" : "CLOUD_RUN_RECONCILIATION_PENDING");
      // Revalidate immediately before the sole external mutation; elapsed reconciliation never extends approval.
      const immediate = await authorize(raw, config, now());
      await input.port.deploy({ operationId: immediate.operationId, projectId: config.projectId, region: immediate.region, serviceName: config.serviceName, imageDigest: config.imageDigest, serviceAccountReference: config.serviceAccountReference, environmentReferenceSha256: config.environmentReferenceSha256, minimumInstances: 3, ingress: config.ingress, concurrency: config.concurrency, admissionRefusal: config.admissionRefusal });
      return Object.freeze({ status: "applied" as const, reused: false as const });
    },
    async observe(raw: CloudRunProviderInput) {
      const authorized = await authorize(raw, config, now());
      const observation = await observeAuthorized(authorized);
      if (observation.status !== "completed") return Object.freeze({ status: observation.status, operationId: authorized.operationId });
      return Object.freeze({ status: "completed" as const, operationId: authorized.operationId, revisionSha256: await sha256(observation.revisionName), resourceIdentitySha256: await sha256({ projectId: config.projectId, region: authorized.region, serviceName: config.serviceName, imageDigest: config.imageDigest, configSha256: await configSha256 }) });
    },
    async observeCleanup(raw: CloudRunProviderInput & Readonly<{ runOwnedServiceName: string }>) {
      const authorized = await authorize(raw, config, now(), true);
      if (ServiceNameSchema.safeParse(raw.runOwnedServiceName).data !== config.serviceName) throw new Error("CLOUD_RUN_CLEANUP_SCOPE_INVALID");
      return CleanupObservationSchema.parse(await input.port.observeCleanup({ operationId: `${authorized.operationId}:cleanup`, projectId: config.projectId, region: authorized.region, serviceName: config.serviceName }));
    },
    async cleanup(raw: CloudRunProviderInput & Readonly<{ runOwnedServiceName: string }>) {
      const authorized = await authorize(raw, config, now());
      if (ServiceNameSchema.safeParse(raw.runOwnedServiceName).data !== config.serviceName) throw new Error("CLOUD_RUN_CLEANUP_SCOPE_INVALID");
      const operationId = `${authorized.operationId}:cleanup`;
      await input.port.persist({ operationId, kind: "cleanup", authorizationRequestSha256: authorized.request.authorizationRequestSha256, authorizationReceiptSha256: authorized.receipt.authorizationReceiptSha256, projectScopeSha256: config.projectScopeSha256 });
      const existing = CleanupObservationSchema.parse(await input.port.observeCleanup({ operationId, projectId: config.projectId, region: authorized.region, serviceName: config.serviceName }));
      if (existing.status === "cleaned") return Object.freeze({ status: "cleaned" as const, operationId });
      if (existing.status !== "missing") throw new Error(existing.status === "blocked" ? "CLOUD_RUN_OPERATION_BLOCKED" : "CLOUD_RUN_RECONCILIATION_PENDING");
      const immediate = await authorize(raw, config, now());
      await input.port.deleteService({ operationId, projectId: config.projectId, region: immediate.region, serviceName: config.serviceName });
      return Object.freeze({ status: "cleaned" as const, operationId });
    },
  });
}
