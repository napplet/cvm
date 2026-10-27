import { z } from "zod";

import { CertificationInputSchema, ReleaseObservationBindingSchema, WorkerCandidateSchema } from "../certification/contracts";
import { createDeploymentExecutionConfig, type DeploymentExecutionConfig } from "../release/deployment/config";
import type { ProductionConfig } from "./config";
import type { MountedProductionSecretMaterial } from "./secret-material";

const Digest = z.string().regex(/^[a-f0-9]{64}$/iu).transform(value => value.toLowerCase());
const Reference = z.string().regex(/^[a-z][a-z0-9:._/-]{2,255}$/iu);
const Url = z.string().url().refine(value => {
  const url = new URL(value);
  return url.protocol === "https:" || (url.protocol === "http:" && ["127.0.0.1", "localhost", "::1"].includes(url.hostname));
}, "MOUNTED_SESSION_URL_INVALID");
const Json = z.unknown().refine(value => {
  try { return JSON.stringify(value) !== undefined; } catch { return false; }
}, "MOUNTED_SESSION_JSON_REQUIRED");
const AbsolutePath = z.string().min(1).max(4_096).refine(value => value.startsWith("/"), "MOUNTED_SESSION_PATH_INVALID");
const Revision = z.string().regex(/^(?:[a-f0-9]{40}|[a-f0-9]{64})$/iu).transform(value => value.toLowerCase());

const ProviderIds = [
  "cloud_run", "cloud_sql_postgres", "gcs", "collector", "modal", "fly",
  "contextvm", "cep8_lightning", "cashu", "model", "compatible_host", "signer",
  "promoted_cli", "upload", "owner_relay", "attestation_relay",
] as const;

const Discovery = z.object({
  capability: z.enum(["available", "unavailable", "unsupported"]),
  authentication: z.enum(["authorized", "not_configured", "unavailable"]),
  accountScopeSha256: Digest,
  costEstimateSha256: Digest,
  resourceIdentitySha256: Digest,
  secretReferenceNames: z.array(Reference).max(32),
}).strict();

const WorkerSelection = z.object({
  provider: z.enum(["modal", "fly"]), status: z.literal("selected"), candidateSha256: Digest, topologySha256: Digest,
  selectionEvidenceSha256: Digest, observedAtMs: z.number().int().positive(), expiresAtMs: z.number().int().positive(),
}).strict();
const Source = z.object({ sourceRevision: Revision, sourceSha256: Digest }).strict();
const CleanupEffect = z.object({ provider: z.enum(ProviderIds), providerOperationId: z.string().min(1).max(256), resourceIdentitySha256: Digest }).strict();
const Execution = z.object({
  materialization: z.object({
    workspace: AbsolutePath, repositoryRoot: AbsolutePath, releaseManifest: Json, source: Source,
    /** These are measured during preapproval from the pinned factory and its
     * mounted runtime closure.  They are not supplied by a CLI invocation at
     * execution time. */
    factoryModuleSha256: Digest, runtimeClosureSha256: Digest,
    secretReferences: z.record(z.string().regex(/^[a-z][a-z0-9_.-]{0,127}$/u), z.string().regex(/^[a-z][a-z0-9+._:/-]{0,255}$/iu)),
  }).strict(),
  workerSelection: WorkerSelection,
  protected: z.object({
    input: CertificationInputSchema, topology: z.object({ candidateSha256: Digest, topologySha256: Digest }).passthrough(),
    collector: z.object({ collectorDigest: z.string().regex(/^sha256:[a-f0-9]{64}$/iu), configSha256: Digest }).strict(),
    releaseBinding: ReleaseObservationBindingSchema,
    protectedVerificationReferences: Json,
    sourceBuild: z.object({
      candidateSha256: Digest, topologySha256: Digest, image: z.string().min(1).max(1_024), sourceSha256: Digest,
      sealedArtifactSha256: Digest, manifestSha256: Digest, capabilitiesSha256: Digest, aggregateSha256: Digest,
    }).strict(),
  }).strict(),
  finalization: z.object({
    trust: z.object({
      repositoryRoot: AbsolutePath, releaseManifest: Json,
      sourceArchive: z.object({ root: AbsolutePath, relativePath: z.string().min(1).max(1_024), canonicalSourceReference: z.string().min(1).max(1_024), sourceRevision: Revision, sourceSha256: Digest }).strict(),
      reproducibilityRecord: Json, supplyChainRecord: Json,
    }).strict(),
    verificationRecords: Json, sourceMeasurement: Json,
    receipts: z.array(z.string().min(1).max(512)).max(256), attestations: z.array(z.string().min(1).max(512)).max(256),
    cleanupPlan: z.object({ cleanupByMs: z.number().int().positive(), retainedEvidenceDays: z.number().int().min(30), retainedArtifactDays: z.number().int().min(30), effects: z.array(CleanupEffect).max(64) }).strict(),
    expectedPreviousBundleSha256: Digest.nullable(),
  }).strict(),
}).strict();

/** Server-only control facts measured during preapproval.  They remain JSON
 * so the mount cannot carry executable callbacks, while the bootstrap below
 * turns them into the project's concrete control services. */
const ServerControls = z.object({
  telemetry: z.object({
    deployment: z.object({
      projectId: z.string().regex(/^[a-z][a-z0-9-]{4,28}[a-z0-9]$/u),
      region: z.string().regex(/^[a-z]+-[a-z]+[0-9]$/u),
      serviceName: z.string().regex(/^[a-z][a-z0-9-]{2,62}$/u),
      revisionName: z.string().regex(/^[a-z][a-z0-9-]{2,62}$/u),
      endpoint: z.string().url(),
      imageReference: z.string().regex(/^[a-z0-9.-]+(?:\/[a-z0-9._-]+)+@sha256:[a-f0-9]{64}$/iu),
      accountScopeSha256: Digest, projectScopeSha256: Digest, principal: z.string().min(3).max(255),
    }).strict(),
  }).strict(),
  restore: z.object({
    sourceInstanceId: z.string().regex(/^[a-z][a-z0-9-]{2,96}[a-z0-9]$/u),
    scope: z.object({ checkpointId: z.string().min(1).max(256), sessionId: z.string().min(1).max(256), ownerId: z.string().min(1).max(256) }).strict(),
  }).strict(),
  migration: z.object({
    source: Json,
    freshTargetIdentity: z.string().regex(/^[A-Za-z0-9][A-Za-z0-9_.:/-]{2,255}$/u),
  }).strict(),
}).strict();

const RecordSchema = z.object({
  version: z.literal(1),
  candidateSha256: Digest,
  topologySha256: Digest,
  workerCandidate: WorkerCandidateSchema,
  discoveries: z.object(Object.fromEntries(ProviderIds.map(id => [id, Discovery])) as Record<(typeof ProviderIds)[number], typeof Discovery>).strict(),
  quotes: z.object(Object.fromEntries(ProviderIds.map(id => [id, z.object({ estimatedCostMicros: z.number().int().nonnegative(), actualCostMicros: z.number().int().nonnegative() }).strict()])) as Record<(typeof ProviderIds)[number], z.ZodObject<{ estimatedCostMicros: z.ZodNumber; actualCostMicros: z.ZodNumber }>>).strict(),
  cleanupScopes: z.object({
    cloudRunRegion: z.string().min(1).max(128), cloudRunServiceName: z.string().min(1).max(256),
    cloudSqlInstanceId: z.string().min(1).max(256), gcsRunOwnedNamespace: z.string().min(1).max(512),
    collectorEndpointReference: z.string().min(1).max(512),
  }).strict(),
  gcsProvisionObjectBase64: z.string().regex(/^[A-Za-z0-9+/]*={0,2}$/).min(4).max(87_384),
  providerConfigurations: z.object({
    cloud_run: Json, gcs: Json, collector: Json, cloud_sql_postgres: Json, modal: Json, fly: Json,
    contextvm: Json, cep8_lightning: Json, cashu: Json, model: Json, upload: Json,
    owner_relay: Json, attestation_relay: Json,
  }).strict(),
  googleControls: z.object({ cloudRun: Json, cloudSql: Json, collector: Json }).strict(),
  edge: z.object({
    compatibleHost: z.object({ hostUrl: Url, hostSha256: Digest, chromiumExecutable: z.string().startsWith("/").max(4_096) }).strict(),
    uploadServer: Url,
    ownerPubkey: Digest,
    relays: z.array(z.string().url().refine(value => new URL(value).protocol === "wss:")).min(1).max(16),
  }).strict(),
  execution: Execution,
  serverControls: ServerControls,
  descriptorReferences: z.object({
    contextvmRelaySetReference: Reference, contextvmRelaySetSha256: Digest,
    compatibleHostReference: Reference, chromiumReference: Reference,
    ownerKeyReference: Reference, attestationKeyReference: Reference,
  }).strict(),
}).strict();

export type MountedProductionSessionRecord = Readonly<z.infer<typeof RecordSchema>>;

/** Validates the product-owned, measured record immediately before it is
 * written to (or read from) the allowlisted mounted secret.  This is the
 * preapproval materialization callsite: supplied facts must bind back to the
 * image-pinned production config, so a CLI/runtime caller cannot manufacture
 * a different server control graph after approval. */
export function materializeMountedProductionSessionRecord(input: Readonly<{
  config: ProductionConfig;
  measured: unknown;
}>): MountedProductionSessionRecord {
  const record = RecordSchema.parse(input.measured);
  if (record.candidateSha256 !== input.config.candidateSha256
    || record.topologySha256 !== input.config.topologySha256
    || record.workerCandidate.id !== input.config.candidateSha256
    || record.workerCandidate.image !== input.config.worker.image
    || record.execution.materialization.source.sourceSha256 !== record.workerCandidate.sourceSha256
    || record.execution.protected.sourceBuild.candidateSha256 !== input.config.candidateSha256
    || record.execution.protected.sourceBuild.topologySha256 !== input.config.topologySha256
    || record.execution.protected.sourceBuild.image !== input.config.worker.image
    || record.execution.protected.sourceBuild.sourceSha256 !== record.workerCandidate.sourceSha256
    || record.edge.compatibleHost.hostUrl !== input.config.compatibleHost.targetUrl
    || record.edge.compatibleHost.hostSha256 !== input.config.compatibleHost.targetSha256
    || record.edge.compatibleHost.chromiumExecutable !== input.config.compatibleHost.chromiumExecutable
    || record.edge.uploadServer !== input.config.publication.uploadServer
    || record.edge.ownerPubkey !== input.config.publication.ownerPubkey
    || record.serverControls.telemetry.deployment.projectId !== input.config.projectId
    || record.serverControls.telemetry.deployment.endpoint !== input.config.collector.otlpEndpoint
    || record.serverControls.telemetry.deployment.principal !== input.config.operator.serviceAccount
    || record.serverControls.telemetry.deployment.imageReference !== (record.googleControls.collector as { deployment?: { imageReference?: unknown } }).deployment?.imageReference
    || !record.serverControls.telemetry.deployment.imageReference.endsWith(`@${record.execution.protected.collector.collectorDigest}`)) {
    throw new Error("PRODUCTION_MOUNTED_PREAPPROVAL_BINDING_REQUIRED");
  }
  return Object.freeze(record);
}

/**
 * Produces the one execution document consumed by the receipt-bound session
 * factory from the already measured, immutable mount record.  This is a
 * project-owned preapproval materialization boundary: normal boot never
 * accepts a hand-authored deployment JSON document or an environment value.
 */
export function createMountedDeploymentExecutionConfig(input: Readonly<{
  config: ProductionConfig;
  record: MountedProductionSessionRecord;
}>): DeploymentExecutionConfig {
  if (input.record.candidateSha256 !== input.config.candidateSha256
    || input.record.topologySha256 !== input.config.topologySha256
    || input.record.execution.materialization.source.sourceSha256 !== input.record.workerCandidate.sourceSha256) {
    throw new Error("PRODUCTION_MOUNTED_EXECUTION_CONFIG_BINDING_REQUIRED");
  }
  const materialization = input.record.execution.materialization;
  return createDeploymentExecutionConfig({
    version: 1,
    candidateSha256: input.record.candidateSha256,
    sourceRevision: materialization.source.sourceRevision,
    workspaceRoot: materialization.workspace,
    factoryModuleSha256: materialization.factoryModuleSha256,
    runtimeClosureSha256: materialization.runtimeClosureSha256,
    publicSettings: {
      regions: input.config.regions,
      maximumRunDurationMs: 15 * 60 * 1_000,
      retentionDays: input.config.policy.retentionDays,
    },
    secretReferences: materialization.secretReferences,
  });
}

function decodeObject(value: string): Uint8Array {
  const bytes = new Uint8Array(Buffer.from(value, "base64"));
  if (bytes.byteLength === 0 || Buffer.from(bytes).toString("base64") !== value) throw new Error("PRODUCTION_MOUNTED_SESSION_RECORD_INVALID");
  return bytes;
}

/** Reads the one allowlisted immutable controller record. JSON is deliberately
 * parsed before validation, so a mounted value cannot smuggle ports, methods,
 * or request-selected resolver callbacks into production composition. */
export async function loadMountedProductionSessionRecord(input: Readonly<{
  config: ProductionConfig;
  secrets: MountedProductionSecretMaterial;
}>): Promise<MountedProductionSessionRecord & Readonly<{ gcsProvisionObject: Uint8Array }>> {
  let raw: unknown;
  try { raw = JSON.parse(await input.secrets.text("certification.sessionMaterialReference", 65_536)); }
  catch { throw new Error("PRODUCTION_MOUNTED_SESSION_RECORD_INVALID"); }
  let record: MountedProductionSessionRecord;
  try { record = materializeMountedProductionSessionRecord({ config: input.config, measured: raw }); }
  catch { throw new Error("PRODUCTION_MOUNTED_SESSION_BINDING_REQUIRED"); }
  return Object.freeze({ ...record, gcsProvisionObject: decodeObject(record.gcsProvisionObjectBase64) });
}
