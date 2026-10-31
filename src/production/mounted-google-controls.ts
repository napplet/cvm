import type { LifecycleObservation } from "../telemetry/contracts";
import { z } from "zod";
import { canonicalJson } from "../promotion/schema";
import type { CloudRunControlPlanePort } from "../release/native/cloud-run";
import type { CloudSqlPostgresControlPlanePort } from "../release/native/cloud-sql-postgres";
import type { CollectorControlPlanePort } from "../release/native/collector";
import type { GcsControlPlanePort } from "../release/native/gcs";
import { createGoogleAdcTokenSource } from "../release/deployment/google-auth";
import { createGoogleDeploymentClients } from "../release/deployment/google-clients";
import { createPostgresGoogleOperationJournal } from "../release/deployment/postgres-provider-journals";
import type { ProductionConfig } from "./config";
import type { ProductionGenerationRuntime } from "./generation-runtime";
import { createProductionGcsObjectClient } from "./gcs-object-client";
import { probeCloudSqlSerializable } from "./cloud-sql-serializable-probe";
import { createMountedBigQueryUsageReporter, MountedBigQueryUsageReportConfigurationSchema, type MountedBigQueryUsageReportConfiguration } from "./mounted-authoritative-billing";
import type { AuthoritativeUsageReportPort } from "../release/controller";

type CloudRunDeployment = Readonly<{
  region: string;
  serviceName: string;
  imageReference: string;
  /** Controller-observed revision identity. It is never inferred from a name. */
  revisionName: string;
  secretReferences: readonly Readonly<{ name: string; secret: string; version: string }>[];
  concurrency: number;
}>;

/** Controller-resolved, non-secret deployment facts.  This is deliberately
 * separate from ProductionConfig because image references, secret versions,
 * network paths, and observed revision identities are deployment authority,
 * not operator-editable runtime configuration. */
export type MountedGoogleControlConfiguration = Readonly<{
  accountScopeSha256: string;
  cloudRun: CloudRunDeployment;
  cloudSql: Readonly<{
    tier: string;
    privateNetwork: string;
    storageGb: number;
    /** Bound to the actual database authority used for the probe below. */
    authorityInstanceId: string;
  }>;
  gcs: Readonly<{ encryptionKeyReference: string }>;
  collector: Readonly<{
    endpointReference: string;
    deployment: CloudRunDeployment;
  }>;
  /** Absent by default. Its presence is sealed preapproval material for the
   * query-only report route; it does not assert export completeness/finality. */
  authoritativeUsage?: MountedBigQueryUsageReportConfiguration;
}>;

export type MountedGoogleControls = Readonly<{
  google: ReturnType<typeof createGoogleDeploymentClients>;
  cloudRun: CloudRunControlPlanePort;
  cloudSql: CloudSqlPostgresControlPlanePort;
  gcs: GcsControlPlanePort;
  collector: CollectorControlPlanePort;
  billingReports?: AuthoritativeUsageReportPort;
}>;

const Digest = z.string().regex(/^[a-f0-9]{64}$/iu).transform(value => value.toLowerCase());
const Deployment = z.object({
  region: z.string().regex(/^[a-z]+-[a-z]+[0-9]$/u),
  serviceName: z.string().regex(/^[a-z][a-z0-9-]{2,48}[a-z0-9]$/u),
  imageReference: z.string().regex(/^[a-z0-9.-]+(?:\/[a-z0-9._-]+)+@sha256:[a-f0-9]{64}$/iu),
  revisionName: z.string().regex(/^[a-z][a-z0-9-]{2,62}-[a-z0-9-]{3,62}$/u),
  secretReferences: z.array(z.object({ name: z.string().regex(/^[A-Z][A-Z0-9_]{1,62}$/u), secret: z.string().min(3).max(255), version: z.string().regex(/^[1-9][0-9]*$/u) }).strict()).min(1),
  concurrency: z.number().int().min(1).max(1_000),
}).strict();
const Configuration = z.object({
  accountScopeSha256: Digest,
  cloudRun: Deployment,
  cloudSql: z.object({ tier: z.string().regex(/^db-custom-[1-9][0-9]*-[1-9][0-9]*$/u), privateNetwork: z.string().regex(/^projects\/[a-z][a-z0-9-]{4,28}[a-z0-9]\/global\/networks\/[a-z][a-z0-9-]{0,62}$/u), storageGb: z.number().int().min(10).max(65_536), authorityInstanceId: z.string().regex(/^[a-z][a-z0-9-]{2,62}$/u) }).strict(),
  gcs: z.object({ encryptionKeyReference: z.string().min(3).max(255) }).strict(),
  collector: z.object({ endpointReference: z.string().regex(/^collector\/[a-z0-9][a-z0-9._/-]{1,250}$/u), deployment: Deployment }).strict(),
  authoritativeUsage: MountedBigQueryUsageReportConfigurationSchema.optional(),
}).strict();

/** The mounted collector uses the receipt-bound private control protocol for
 * telemetry storage/query.  Keep only its two concrete operations here: a
 * generic injected callback bag cannot become a collector transport. */
type CollectorTelemetry = Readonly<{
  emit(observation: LifecycleObservation): Promise<void>;
  queryWindow(binding: unknown): Promise<unknown>;
}>;

async function digest(value: unknown): Promise<string> {
  const bytes = new TextEncoder().encode(canonicalJson(value));
  const hash = await crypto.subtle.digest("SHA-256", bytes);
  return Array.from(new Uint8Array(hash), byte => byte.toString(16).padStart(2, "0")).join("");
}

/** Google deployment clients reserve a short label-safe operation ID.  The
 * native providers retain their full receipt-bound ID in PostgreSQL while this
 * irreversible, canonical reduction makes the provider's own original-op key
 * safe for Cloud Run, Cloud SQL, and Storage labels. */
async function googleOperationId(operationId: string): Promise<string> {
  return `g-${(await digest(operationId)).slice(0, 52)}`;
}

/** Native providers append `:cleanup` for their receipt-intent journal.  The
 * Google client instead owns one original provision operation and derives its
 * provider cleanup record as `-cleanup`, so cleanup must reconcile that same
 * original identity rather than manufacture a second deployment identity. */
function provisionOperationId(operationId: string): string {
  return operationId.endsWith(":cleanup") ? operationId.slice(0, -":cleanup".length) : operationId;
}

function requireDispatch(status: Readonly<{ status: string }>, code: string): void {
  if (status.status === "completed" || status.status === "pending") return;
  throw new Error(`${code}_${status.status.toUpperCase()}`);
}

function releaseUnlessPending(status: Readonly<{ status: string }>, code: string): void {
  if (status.status === "completed") return;
  throw new Error(`${code}_${status.status.toUpperCase()}`);
}

/**
 * Builds the four Google-native control ports from mounted authority.  Every
 * mutation is independently journaled: the native receipt intent is written
 * to Postgres first, then the official Google client claims and reconciles its
 * provider operation.  No callback, synthetic readiness, price, or resource
 * identity enters this adapter.
 */
export function createMountedGoogleControls(input: Readonly<{
  config: ProductionConfig;
  generation: ProductionGenerationRuntime;
  configuration: MountedGoogleControlConfiguration;
  telemetry: CollectorTelemetry;
  now?: () => number;
}>): MountedGoogleControls {
  const { config, generation } = input;
  const configuration = Object.freeze(Configuration.parse(input.configuration));
  const tokenSource = createGoogleAdcTokenSource({
    projectId: config.projectId,
    quotaProjectId: config.projectId,
    principal: config.operator.serviceAccount,
    accountScopeSha256: configuration.accountScopeSha256,
    now: input.now,
  });
  /* The GCS native provider writes immutable run evidence through the same
   * scope-bound ADC source as the control-plane client.  The runtime's
   * checkpoint object client has a different responsibility and must not
   * silently widen this provider's authority. */
  const gcsObjects = createProductionGcsObjectClient({ bucket: config.gcs.bucket, tokenSource });
  const googleJournal = createPostgresGoogleOperationJournal(generation.dependencies.googleControlJournal);
  const google = createGoogleDeploymentClients({
    projectId: config.projectId,
    quotaProjectId: config.projectId,
    principal: config.operator.serviceAccount,
    accountScopeSha256: configuration.accountScopeSha256,
    tokenSource,
    journal: googleJournal,
    now: input.now,
  });
  const billingReports = configuration.authoritativeUsage
    ? createMountedBigQueryUsageReporter({
      configuration: configuration.authoritativeUsage,
      projectId: config.projectId, quotaProjectId: config.projectId, principal: config.operator.serviceAccount,
      accountScopeSha256: configuration.accountScopeSha256, tokenSource, googleJournal,
      billingJournal: generation.dependencies.authoritativeUsageJournal,
      pool: generation.dependencies.pool,
      objects: generation.dependencies.artifactStore, bucket: config.gcs.bucket, now: input.now,
    })
    : undefined;
  const persist = async (kind: string, value: Readonly<{ operationId: string; authorizationRequestSha256: string; authorizationReceiptSha256: string; projectScopeSha256: string }>) => {
    await generation.dependencies.googleIntentJournal.claim(
      `${kind}:${value.operationId}`,
      await digest({ kind, ...value }),
      { kind, ...value },
    );
  };
  const cloudRun: CloudRunControlPlanePort = Object.freeze({
    persist: value => persist(`cloud-run-${value.kind}`, value),
    async observe(value) {
      if (value.projectId !== config.projectId || value.region !== configuration.cloudRun.region || value.serviceName !== configuration.cloudRun.serviceName) throw new Error("CLOUD_RUN_MOUNTED_CONFIGURATION_MISMATCH");
      const operationId = await googleOperationId(value.operationId);
      if (!await googleJournal.read(operationId)) return Object.freeze({ status: "missing" as const });
      const state = await google.cloudRun.observe({
        operationId, projectId: value.projectId, region: value.region, serviceName: value.serviceName,
        imageReference: configuration.cloudRun.imageReference,
        serviceAccountReference: config.operator.serviceAccount,
        environmentReferenceSha256: config.topologySha256,
        secretReferences: configuration.cloudRun.secretReferences,
        concurrency: configuration.cloudRun.concurrency,
      });
      if (state.status !== "completed") return state;
      return Object.freeze({ status: "completed" as const, operationId: value.operationId, projectId: value.projectId, region: value.region, serviceName: value.serviceName,
        revisionName: configuration.cloudRun.revisionName, imageDigest: configuration.cloudRun.imageReference.slice(-71), serviceAccountReference: config.operator.serviceAccount,
        environmentReferenceSha256: config.topologySha256, minimumInstances: 3 as const, ingress: "internal-and-cloud-load-balancing" as const,
        concurrency: configuration.cloudRun.concurrency, admissionRefusal: "capacity_unavailable" as const, generationQueueResourceCount: 0 as const });
    },
    async observeCleanup(value) {
      if (value.projectId !== config.projectId || value.region !== configuration.cloudRun.region || value.serviceName !== configuration.cloudRun.serviceName) throw new Error("CLOUD_RUN_MOUNTED_CONFIGURATION_MISMATCH");
      const originalOperationId = await googleOperationId(provisionOperationId(value.operationId));
      /* Cleanup is owned by the original Google operation.  A missing original
       * is not permission to delete a same-name service. */
      const original = await googleJournal.read(originalOperationId);
      if (!original?.owned || !original.resourceUid || !original.createTime) return Object.freeze({ status: "blocked" as const });
      const state = await google.cloudRun.observeCleanup({ operationId: originalOperationId, projectId: value.projectId, region: value.region, serviceName: value.serviceName });
      return state.status === "completed" ? Object.freeze({ status: "cleaned" as const }) : state;
    },
    async deploy(value) {
      if (value.projectId !== config.projectId || value.region !== configuration.cloudRun.region || value.serviceName !== configuration.cloudRun.serviceName
        || value.imageDigest !== configuration.cloudRun.imageReference.slice(-71) || value.serviceAccountReference !== config.operator.serviceAccount
        || value.environmentReferenceSha256 !== config.topologySha256 || value.concurrency !== configuration.cloudRun.concurrency) throw new Error("CLOUD_RUN_MOUNTED_CONFIGURATION_MISMATCH");
      const state = await google.cloudRun.deploy({ operationId: await googleOperationId(value.operationId), projectId: value.projectId, region: value.region, serviceName: value.serviceName,
        imageReference: configuration.cloudRun.imageReference, serviceAccountReference: value.serviceAccountReference,
        environmentReferenceSha256: value.environmentReferenceSha256, secretReferences: configuration.cloudRun.secretReferences,
        minimumInstances: value.minimumInstances, ingress: value.ingress, concurrency: value.concurrency, admissionRefusal: value.admissionRefusal });
      requireDispatch(state, "CLOUD_RUN_DISPATCH");
    },
    async deleteService(value) { releaseUnlessPending(await google.cloudRun.cleanup({ operationId: await googleOperationId(provisionOperationId(value.operationId)), projectId: value.projectId, region: value.region, serviceName: value.serviceName }), "CLOUD_RUN_CLEANUP"); },
  });
  const cloudSql: CloudSqlPostgresControlPlanePort = Object.freeze({
    persist: value => persist(`cloud-sql-${value.kind}`, value),
    async observeInstance(value) {
      if (value.projectId !== config.projectId) throw new Error("CLOUD_SQL_MOUNTED_CONFIGURATION_MISMATCH");
      const operationId = await googleOperationId(value.operationId);
      if (!await googleJournal.read(operationId)) return Object.freeze({ status: "missing" as const });
      const state = await google.cloudSqlPostgres.observe({ operationId, instanceId: value.instanceId, region: value.region, tier: configuration.cloudSql.tier, privateNetwork: configuration.cloudSql.privateNetwork, storageGb: configuration.cloudSql.storageGb });
      if (state.status !== "completed") return state;
      return Object.freeze({ status: "completed" as const, operationId: value.operationId, projectId: value.projectId, region: value.region, instanceId: value.instanceId,
        engineVersion: "POSTGRES_17" as const, availabilityType: "REGIONAL" as const, storageGb: configuration.cloudSql.storageGb, backupEnabled: true as const,
        privateNetworkReferenceSha256: await digest(configuration.cloudSql.privateNetwork), serviceAccountReferenceSha256: await digest(config.operator.serviceAccount) });
    },
    async createInstance(value) {
      if (value.projectId !== config.projectId || value.storageGb !== configuration.cloudSql.storageGb || value.backupEnabled !== true || value.engineVersion !== "POSTGRES_17" || value.availabilityType !== "REGIONAL" || value.privateNetworkReferenceSha256 !== await digest(configuration.cloudSql.privateNetwork) || value.serviceAccountReferenceSha256 !== await digest(config.operator.serviceAccount)) throw new Error("CLOUD_SQL_MOUNTED_CONFIGURATION_MISMATCH");
      requireDispatch(await google.cloudSqlPostgres.provision({ operationId: await googleOperationId(value.operationId), instanceId: value.instanceId, region: value.region, databaseVersion: value.engineVersion, availabilityType: value.availabilityType, tier: configuration.cloudSql.tier, privateNetwork: configuration.cloudSql.privateNetwork, storageGb: value.storageGb, requireSsl: true, serializablePolicy: true }), "CLOUD_SQL_DISPATCH");
    },
    async probeSerializable(value) {
      if (value.instanceId !== configuration.cloudSql.authorityInstanceId) return Object.freeze({ status: "unknown" as const });
      return probeCloudSqlSerializable({ pool: generation.dependencies.pool, journal: generation.dependencies.googleIntentJournal, operationId: value.operationId, instanceId: value.instanceId });
    },
    async observeCleanup(value) {
      if (value.projectId !== config.projectId) throw new Error("CLOUD_SQL_MOUNTED_CONFIGURATION_MISMATCH");
      const state = await google.cloudSqlPostgres.observeCleanup({ operationId: await googleOperationId(provisionOperationId(value.operationId)), instanceId: value.instanceId });
      return state.status === "completed" ? Object.freeze({ status: "cleaned" as const }) : state;
    },
    async deleteInstance(value) { releaseUnlessPending(await google.cloudSqlPostgres.cleanup({ operationId: await googleOperationId(provisionOperationId(value.operationId)), instanceId: value.instanceId }), "CLOUD_SQL_CLEANUP"); },
  });
  const gcs: GcsControlPlanePort = Object.freeze({
    persist: (value: Parameters<GcsControlPlanePort["persist"]>[0]) => persist(`gcs-${value.kind}`, value),
    async observeBucket(value: Parameters<GcsControlPlanePort["observeBucket"]>[0]) {
      if (value.projectId !== config.projectId || value.bucket !== config.gcs.bucket) throw new Error("GCS_MOUNTED_CONFIGURATION_MISMATCH");
      const state = await google.gcs.observeBucketPolicy({ bucket: value.bucket, encryptionKeyReference: configuration.gcs.encryptionKeyReference });
      return state.status === "completed" ? Object.freeze({ status: "completed" as const, projectId: value.projectId, bucket: value.bucket, dualRegion: "nam4" as const, versioning: true as const, retentionDays: 30 }) : state;
    },
    async createBucket(value: Parameters<GcsControlPlanePort["createBucket"]>[0]) { if (value.projectId !== config.projectId || value.bucket !== config.gcs.bucket) throw new Error("GCS_MOUNTED_CONFIGURATION_MISMATCH"); requireDispatch(await google.gcs.provisionBucket({ operationId: await googleOperationId(value.operationId), bucket: value.bucket, encryptionKeyReference: configuration.gcs.encryptionKeyReference }), "GCS_DISPATCH"); },
    createIfAbsent: (value: Parameters<GcsControlPlanePort["createIfAbsent"]>[0]) => gcsObjects.createIfAbsent(value),
    findExactByKey: (value: Parameters<GcsControlPlanePort["findExactByKey"]>[0]) => gcsObjects.findExactByKey(value),
    readGeneration: (value: Parameters<GcsControlPlanePort["readGeneration"]>[0]) => gcsObjects.readGeneration(value),
    scheduleGenerationDeletion: (value: Parameters<GcsControlPlanePort["scheduleGenerationDeletion"]>[0]) => gcsObjects.scheduleGenerationDeletion(value),
  });
  const collector: CollectorControlPlanePort = Object.freeze({
    persist: value => persist(`collector-${value.kind}`, value),
    async observe(value) {
      if (value.projectId !== config.projectId) throw new Error("COLLECTOR_MOUNTED_CONFIGURATION_MISMATCH");
      if (value.endpointReferenceSha256 !== await digest(configuration.collector.endpointReference)) return Object.freeze({ status: "blocked" as const });
      const deployment = configuration.collector.deployment;
      const operationId = await googleOperationId(value.operationId);
      if (!await googleJournal.read(operationId)) return Object.freeze({ status: "missing" as const });
      const state = await google.cloudRun.observe({ operationId, projectId: value.projectId, region: deployment.region, serviceName: deployment.serviceName, imageReference: deployment.imageReference, serviceAccountReference: config.operator.serviceAccount, environmentReferenceSha256: config.topologySha256, secretReferences: deployment.secretReferences, concurrency: deployment.concurrency, containerPort: 4318 });
      return state.status === "completed" ? Object.freeze({ status: "completed" as const, endpointReferenceSha256: value.endpointReferenceSha256 }) : state;
    },
    async observeCleanup(value) {
      if (value.projectId !== config.projectId) throw new Error("COLLECTOR_MOUNTED_CONFIGURATION_MISMATCH");
      if (value.endpointReferenceSha256 !== await digest(configuration.collector.endpointReference)) return Object.freeze({ status: "blocked" as const });
      const deployment = configuration.collector.deployment;
      const originalOperationId = await googleOperationId(provisionOperationId(value.operationId));
      const original = await googleJournal.read(originalOperationId);
      if (!original?.owned || !original.resourceUid || !original.createTime) return Object.freeze({ status: "blocked" as const });
      const state = await google.cloudRun.observeCleanup({ operationId: originalOperationId, projectId: value.projectId, region: deployment.region, serviceName: deployment.serviceName });
      return state.status === "completed" ? Object.freeze({ status: "cleaned" as const }) : state;
    },
    async configure(value) {
      if (value.projectId !== config.projectId || value.endpointReference !== configuration.collector.endpointReference || value.endpointReferenceSha256 !== await digest(value.endpointReference)) throw new Error("COLLECTOR_MOUNTED_CONFIGURATION_MISMATCH");
      const deployment = configuration.collector.deployment;
      requireDispatch(await google.collector.deploy({ operationId: await googleOperationId(value.operationId), projectId: value.projectId, region: deployment.region, serviceName: deployment.serviceName, imageReference: deployment.imageReference, serviceAccountReference: config.operator.serviceAccount, environmentReferenceSha256: config.topologySha256, secretReferences: deployment.secretReferences, minimumInstances: 3, ingress: "internal-and-cloud-load-balancing", concurrency: deployment.concurrency, admissionRefusal: "capacity_unavailable", containerPort: 4318 }), "COLLECTOR_DISPATCH");
    },
    async deleteCollector(value) {
      if (value.endpointReference !== configuration.collector.endpointReference || value.endpointReferenceSha256 !== await digest(value.endpointReference)) throw new Error("COLLECTOR_MOUNTED_CONFIGURATION_MISMATCH");
      releaseUnlessPending(await google.cloudRun.cleanup({ operationId: await googleOperationId(provisionOperationId(value.operationId)), projectId: value.projectId, region: configuration.collector.deployment.region, serviceName: configuration.collector.deployment.serviceName }), "COLLECTOR_CLEANUP");
    },
    emit: value => input.telemetry.emit(value.observation),
    queryWindow: value => input.telemetry.queryWindow(value.binding),
  });
  return Object.freeze({ google, cloudRun, cloudSql, gcs, collector, ...(billingReports ? { billingReports } : {}) });
}
