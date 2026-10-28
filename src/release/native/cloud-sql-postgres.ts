import { z } from "zod";
import { canonicalJson } from "../../promotion/schema";
import {
  ReleaseAuthorizationReceiptSchema,
  validateAuthorizationReceipt,
  validateAuthorizationRequest,
  type ReleaseAuthorizationReceipt,
  type ReleaseAuthorizationRequest,
} from "../authorization";

const DigestSchema = z.string().regex(/^[a-f0-9]{64}$/iu).transform((value) => value.toLowerCase());
const OperationIdSchema = z.string().regex(/^[a-z][a-z0-9_-]{2,127}$/u);
const ProjectIdSchema = z.string().regex(/^[a-z][a-z0-9-]{4,28}[a-z0-9]$/u);
const RegionSchema = z.string().regex(/^[a-z]+-[a-z]+[0-9]$/u);
const InstanceIdSchema = z.string().regex(/^[a-z][a-z0-9-]{2,62}$/u);

const CloudSqlPostgresConfigSchema = z.object({
  candidateSha256: DigestSchema,
  topologySha256: DigestSchema,
  effectPlanSha256: DigestSchema,
  accountScopeSha256: DigestSchema,
  projectScopeSha256: DigestSchema,
  projectId: ProjectIdSchema,
  region: RegionSchema,
  instanceId: InstanceIdSchema,
  engineVersion: z.literal("POSTGRES_17"),
  availabilityType: z.literal("REGIONAL"),
  storageGb: z.number().int().min(10).max(65_536),
  backupEnabled: z.literal(true),
  privateNetworkReferenceSha256: DigestSchema,
  serviceAccountReferenceSha256: DigestSchema,
}).strict();
type CloudSqlPostgresConfig = z.infer<typeof CloudSqlPostgresConfigSchema>;

const InstanceObservationSchema = z.union([
  z.object({
    status: z.literal("completed"), operationId: OperationIdSchema, projectId: ProjectIdSchema, region: RegionSchema, instanceId: InstanceIdSchema,
    engineVersion: z.literal("POSTGRES_17"), availabilityType: z.literal("REGIONAL"), storageGb: z.number().int().min(10).max(65_536), backupEnabled: z.literal(true),
    privateNetworkReferenceSha256: DigestSchema, serviceAccountReferenceSha256: DigestSchema,
  }).strict(),
  z.object({ status: z.enum(["missing", "pending", "unknown", "blocked"]) }).strict(),
]);
type InstanceObservation = z.infer<typeof InstanceObservationSchema>;

const SerializableProbeSchema = z.union([
  z.object({ status: z.literal("completed"), operationId: OperationIdSchema, isolationLevel: z.literal("serializable"), duplicateEffectCount: z.literal(0) }).strict(),
  z.object({ status: z.enum(["pending", "unknown", "blocked"]) }).strict(),
]);
type SerializableProbe = z.infer<typeof SerializableProbeSchema>;

const CleanupObservationSchema = z.object({ status: z.enum(["cleaned", "missing", "pending", "unknown", "blocked"]) }).strict();

export type CloudSqlPostgresControlPlanePort = Readonly<{
  persist(input: Readonly<{ operationId: string; kind: "provision" | "cleanup"; authorizationRequestSha256: string; authorizationReceiptSha256: string; projectScopeSha256: string }>): Promise<void>;
  observeInstance(input: Readonly<{ operationId: string; projectId: string; region: string; instanceId: string }>): Promise<unknown>;
  createInstance(input: Readonly<{ operationId: string; projectId: string; region: string; instanceId: string; engineVersion: "POSTGRES_17"; availabilityType: "REGIONAL"; storageGb: number; backupEnabled: true; privateNetworkReferenceSha256: string; serviceAccountReferenceSha256: string }>): Promise<void>;
  probeSerializable(input: Readonly<{ operationId: string; instanceId: string }>): Promise<unknown>;
  observeCleanup(input: Readonly<{ operationId: string; projectId: string; region: string; instanceId: string }>): Promise<unknown>;
  deleteInstance(input: Readonly<{ operationId: string; projectId: string; region: string; instanceId: string }>): Promise<void>;
}>;

export type CloudSqlPostgresProviderInput = Readonly<{ request: unknown; receipt: unknown; operationId: string }>;
type Authorized = Readonly<{ request: ReleaseAuthorizationRequest; receipt: ReleaseAuthorizationReceipt; operationId: string }>;

async function sha256(value: unknown): Promise<string> {
  const hash = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(canonicalJson(value)));
  return Array.from(new Uint8Array(hash), (byte) => byte.toString(16).padStart(2, "0")).join("");
}

function cloudSqlScopeIsBound(request: ReleaseAuthorizationRequest, config: CloudSqlPostgresConfig): boolean {
  const effects = request.orderedEffects.filter((effect) => effect.provider === "cloud_sql_postgres");
  const scopes = request.providerScopes.filter((scope) => scope.provider === "cloud_sql_postgres");
  return effects.length === 1 && effects[0]?.id === "database" && effects[0]?.operation === "create_or_update"
    && scopes.length === 1 && scopes[0]?.accountScopeSha256 === config.accountScopeSha256 && scopes[0]?.projectScopeSha256 === config.projectScopeSha256;
}

async function authorize(input: CloudSqlPostgresProviderInput, config: CloudSqlPostgresConfig, nowMs: number, readOnly = false): Promise<Authorized> {
  try {
    const request = await validateAuthorizationRequest(input.request);
    const originalReceipt = ReleaseAuthorizationReceiptSchema.parse(input.receipt);
    const receipt = await validateAuthorizationReceipt({ request, receipt: originalReceipt, nowMs: readOnly ? Math.min(nowMs, originalReceipt.expiresAtMs - 1) : nowMs });
    const operationId = OperationIdSchema.parse(input.operationId);
    if (request.candidateSha256 !== config.candidateSha256 || request.topologySha256 !== config.topologySha256 || request.effectPlanSha256 !== config.effectPlanSha256
      || receipt.candidateSha256 !== config.candidateSha256 || receipt.topologySha256 !== config.topologySha256 || receipt.effectPlanSha256 !== config.effectPlanSha256
      || !cloudSqlScopeIsBound(request, config)) throw new Error("scope");
    return Object.freeze({ request, receipt, operationId });
  } catch {
    throw new Error("CLOUD_SQL_POSTGRES_AUTHORIZATION_INVALID");
  }
}

function instanceMatches(observation: InstanceObservation, authorized: Authorized, config: CloudSqlPostgresConfig): observation is Extract<InstanceObservation, { status: "completed" }> {
  return observation.status === "completed" && observation.operationId === authorized.operationId && observation.projectId === config.projectId
    && observation.region === config.region && observation.instanceId === config.instanceId && observation.engineVersion === config.engineVersion
    && observation.availabilityType === config.availabilityType && observation.storageGb === config.storageGb && observation.backupEnabled === config.backupEnabled
    && observation.privateNetworkReferenceSha256 === config.privateNetworkReferenceSha256 && observation.serviceAccountReferenceSha256 === config.serviceAccountReferenceSha256;
}

/**
 * Cloud SQL for PostgreSQL is the sole current database authority (D-130).
 * The protected runner injects all Google and PostgreSQL clients; this adapter
 * owns only request binding, exact observation, and original-operation fencing.
 */
export function createNativeCloudSqlPostgresProvider(input: Readonly<{ config: unknown; port: CloudSqlPostgresControlPlanePort; now?: () => number }>) {
  const config = Object.freeze(CloudSqlPostgresConfigSchema.parse(input.config));
  const now = input.now ?? Date.now;
  const configSha256 = sha256(config);

  async function observeInstance(authorized: Authorized): Promise<InstanceObservation> {
    const observation = InstanceObservationSchema.parse(await input.port.observeInstance({ operationId: authorized.operationId, projectId: config.projectId, region: config.region, instanceId: config.instanceId }));
    if (observation.status === "completed" && !instanceMatches(observation, authorized, config)) throw new Error("CLOUD_SQL_POSTGRES_OBSERVATION_MISMATCH");
    return observation;
  }

  async function observeSerializable(authorized: Authorized): Promise<SerializableProbe> {
    const probe = SerializableProbeSchema.parse(await input.port.probeSerializable({ operationId: authorized.operationId, instanceId: config.instanceId }));
    if (probe.status === "completed" && (probe.operationId !== authorized.operationId || probe.isolationLevel !== "serializable" || probe.duplicateEffectCount !== 0)) throw new Error("CLOUD_SQL_POSTGRES_TRANSACTION_PROBE_INVALID");
    return probe;
  }

  return Object.freeze({
    async plan(raw: CloudSqlPostgresProviderInput) {
      const authorized = await authorize(raw, config, now());
      return Object.freeze({ status: "planned" as const, operationId: authorized.operationId, authority: "cloud_sql_postgres" as const, candidateSha256: config.candidateSha256, topologySha256: config.topologySha256, configSha256: await configSha256, projectId: config.projectId, region: config.region, instanceId: config.instanceId, engineVersion: config.engineVersion, availabilityType: config.availabilityType, storageGb: config.storageGb, backupEnabled: config.backupEnabled, privateNetworkReferenceSha256: config.privateNetworkReferenceSha256, serviceAccountReferenceSha256: config.serviceAccountReferenceSha256 });
    },
    async apply(raw: CloudSqlPostgresProviderInput) {
      const authorized = await authorize(raw, config, now());
      await input.port.persist({ operationId: authorized.operationId, kind: "provision", authorizationRequestSha256: authorized.request.authorizationRequestSha256, authorizationReceiptSha256: authorized.receipt.authorizationReceiptSha256, projectScopeSha256: config.projectScopeSha256 });
      const existing = await observeInstance(authorized);
      if (existing.status === "completed") return Object.freeze({ status: "completed" as const, reused: true as const, authority: "cloud_sql_postgres" as const });
      if (existing.status !== "missing") throw new Error(existing.status === "blocked" ? "CLOUD_SQL_POSTGRES_OPERATION_BLOCKED" : "CLOUD_SQL_POSTGRES_RECONCILIATION_PENDING");
      // Revalidate the exact v2 receipt immediately before the sole authority mutation.
      const immediate = await authorize(raw, config, now());
      await input.port.createInstance({ operationId: immediate.operationId, projectId: config.projectId, region: config.region, instanceId: config.instanceId, engineVersion: config.engineVersion, availabilityType: config.availabilityType, storageGb: config.storageGb, backupEnabled: config.backupEnabled, privateNetworkReferenceSha256: config.privateNetworkReferenceSha256, serviceAccountReferenceSha256: config.serviceAccountReferenceSha256 });
      return Object.freeze({ status: "applied" as const, reused: false as const, authority: "cloud_sql_postgres" as const });
    },
    async observe(raw: CloudSqlPostgresProviderInput) {
      const authorized = await authorize(raw, config, now());
      const observation = await observeInstance(authorized);
      if (observation.status !== "completed") return Object.freeze({ status: observation.status, operationId: authorized.operationId });
      // Revalidate immediately before the bounded probe's only run-owned SQL writes.
      const immediate = await authorize(raw, config, now());
      const probe = await observeSerializable(immediate);
      if (probe.status !== "completed") return Object.freeze({ status: probe.status, operationId: authorized.operationId });
      return Object.freeze({ status: "completed" as const, operationId: authorized.operationId, authority: "cloud_sql_postgres" as const, serializable: true as const, duplicateEffectCount: 0 as const, resourceIdentitySha256: await sha256({ projectId: config.projectId, region: config.region, instanceId: config.instanceId, engineVersion: config.engineVersion, availabilityType: config.availabilityType, storageGb: config.storageGb, backupEnabled: config.backupEnabled, privateNetworkReferenceSha256: config.privateNetworkReferenceSha256, serviceAccountReferenceSha256: config.serviceAccountReferenceSha256, configSha256: await configSha256 }) });
    },
    async observeCleanup(raw: CloudSqlPostgresProviderInput & Readonly<{ runOwnedInstanceId: string }>) {
      const authorized = await authorize(raw, config, now(), true);
      if (InstanceIdSchema.safeParse(raw.runOwnedInstanceId).data !== config.instanceId) throw new Error("CLOUD_SQL_POSTGRES_CLEANUP_SCOPE_INVALID");
      return CleanupObservationSchema.parse(await input.port.observeCleanup({ operationId: `${authorized.operationId}:cleanup`, projectId: config.projectId, region: config.region, instanceId: config.instanceId }));
    },
    async cleanup(raw: CloudSqlPostgresProviderInput & Readonly<{ runOwnedInstanceId: string }>) {
      const authorized = await authorize(raw, config, now());
      if (InstanceIdSchema.safeParse(raw.runOwnedInstanceId).data !== config.instanceId) throw new Error("CLOUD_SQL_POSTGRES_CLEANUP_SCOPE_INVALID");
      const operationId = `${authorized.operationId}:cleanup`;
      await input.port.persist({ operationId, kind: "cleanup", authorizationRequestSha256: authorized.request.authorizationRequestSha256, authorizationReceiptSha256: authorized.receipt.authorizationReceiptSha256, projectScopeSha256: config.projectScopeSha256 });
      const existing = CleanupObservationSchema.parse(await input.port.observeCleanup({ operationId, projectId: config.projectId, region: config.region, instanceId: config.instanceId }));
      if (existing.status === "cleaned") return Object.freeze({ status: "cleaned" as const, operationId });
      if (existing.status !== "missing") throw new Error(existing.status === "blocked" ? "CLOUD_SQL_POSTGRES_OPERATION_BLOCKED" : "CLOUD_SQL_POSTGRES_RECONCILIATION_PENDING");
      const immediate = await authorize(raw, config, now());
      await input.port.deleteInstance({ operationId, projectId: config.projectId, region: config.region, instanceId: config.instanceId });
      return Object.freeze({ status: "cleaned" as const, operationId, authority: "cloud_sql_postgres" as const, resourceIdentitySha256: await sha256({ projectId: config.projectId, region: config.region, instanceId: config.instanceId }) });
    },
  });
}
