import { lstat, readFile } from "node:fs/promises";
import { createHash } from "node:crypto";
import { z } from "zod";

import { assertProductionDeploymentAllowed, loadProductionConfig, type ProductionConfig } from "./config";
import { loadMountedProductionSessionRecord, type MountedProductionSessionRecord } from "./mounted-session-record";
import { createMountedProductionHttpRuntime, openMountedProductionSession, type MountedProductionSessionAssembly } from "./runtime";
import { MountedProductionSecretMaterial } from "./secret-material";
import { ProductionTelemetryCertification } from "./telemetry-certification";
import { createGooglePrivateControlIdentity } from "../release/deployment/production-core-control";
import { createMountedGoogleControls, type MountedGoogleControlConfiguration } from "./mounted-google-controls";
import { ProductionMigrationControl, ProductionMigrationServerRegistry, ProductionMigrationSource, MigrationArchiveCipher } from "./migration-control";
import { createMountedFreshRestoreRuntime } from "./mounted-fresh-restore-runtime";
import { ProductionGoogleFreshRestoreProvisioner } from "./fresh-restore-provisioner";
import { ProductionRestoreCertification } from "./restore-certification";
import { ProductionCertificationCoreServices } from "./certification-services";
import { ProductionCertificationControl, type ProductionCertificationServices } from "./certification-control";
import type { MigrationSource } from "./migration";
import { ProductionChaosCertificationService } from "./chaos-certification";
import { ProductionCertificationEdgeService } from "./certification-edge";
import type { MountedProductionSessionReferences } from "./mounted-session-material";

/** The container image mounts exactly this immutable, reference-only document.
 * Startup intentionally has no CLI flag or environment fallback that could
 * select a different production candidate. */
export const PRODUCTION_CONFIG_MOUNT = "/etc/napplet-cvm/production-config.json";

async function readFixedJson(path = PRODUCTION_CONFIG_MOUNT): Promise<unknown> {
  const stat = await lstat(path).catch(() => { throw new Error("PRODUCTION_CONFIG_MOUNT_UNAVAILABLE"); });
  if (!stat.isFile() || stat.isSymbolicLink() || stat.size < 2 || stat.size > 65_536) throw new Error("PRODUCTION_CONFIG_MOUNT_INVALID");
  let raw: Uint8Array;
  try { raw = new Uint8Array(await readFile(path)); }
  catch { throw new Error("PRODUCTION_CONFIG_MOUNT_UNAVAILABLE"); }
  try { return JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(raw)); }
  catch { throw new Error("PRODUCTION_CONFIG_MOUNT_INVALID"); }
}

/** Read-only resolver exported for the container bootstrap and local mount
 * validation.  The optional path is package-private test support; production
 * startup always invokes this without an argument and therefore uses the
 * fixed image mount above. */
export async function loadMountedProductionBootstrapConfig(path?: string): Promise<ProductionConfig> {
  const config = loadProductionConfig(await readFixedJson(path));
  assertProductionDeploymentAllowed(config);
  return config;
}

/** Parses both pinned documents before opening PostgreSQL, a relay, wallet, or
 * worker transport.  This gives deployment a deterministic fail-closed boot
 * check while keeping all live authority construction in the normal runtime. */
export async function resolveMountedProductionBootstrap(input: Readonly<{
  config: ProductionConfig;
  secrets?: MountedProductionSecretMaterial;
}>): Promise<Readonly<{ config: ProductionConfig; secrets: MountedProductionSecretMaterial; record: MountedProductionSessionReferences }>> {
  const secrets = input.secrets ?? new MountedProductionSecretMaterial(input.config);
  const record = await loadMountedProductionSessionRecord({ config: input.config, secrets });
  return Object.freeze({ config: input.config, secrets, record });
}

/** Normal Cloud Run bootstrap.  No caller supplies material, record, callback
 * ports, or a deployment execution document; all of those derive from the
 * fixed production config and controller-installed immutable mount. */
export async function openMountedProductionBootstrap(): Promise<MountedProductionSessionAssembly> {
  const config = await loadMountedProductionBootstrapConfig();
  const resolved = await resolveMountedProductionBootstrap({ config });
  return openMountedProductionSession({ config: resolved.config, secrets: resolved.secrets, resolved: resolved.record });
}

/** The pending chaos authority is deliberately a branded server service, not
 * a request callback.  The bootstrap composes every other control from fixed
 * mounted facts now; the dedicated chaos implementation can be installed
 * without widening the HTTP or deployment authority surface. */
export type ProductionChaosCertification = Pick<ProductionCertificationServices, "injectFault" | "observeFault" | "reconcile">;

function sha(value: unknown): string {
  return createHash("sha256").update(JSON.stringify(value)).digest("hex");
}

/**
 * Constructs the server-side certification and migration controls from the
 * immutable mount record and the already opened real generation graph.  All
 * provider calls remain inside the concrete Google/GCS/SQL/worker classes;
 * this function accepts no endpoint, credential, or function selected by an
 * HTTP caller.
 */
export async function createMountedProductionControlServices(input: Readonly<{
  config: ProductionConfig;
  secrets: MountedProductionSecretMaterial;
  record: MountedProductionSessionRecord;
  assembly: MountedProductionSessionAssembly;
  chaos: ProductionChaosCertification;
}>): Promise<Readonly<{
  certification: ProductionCertificationControl;
  migration: ProductionMigrationControl;
  telemetry: ProductionTelemetryCertification;
}>> {
  const { config, record } = input;
  const generation = input.assembly.generation;
  const googleConfiguration = record.googleControls as MountedGoogleControlConfiguration;
  if (record.candidateSha256 !== config.candidateSha256 || record.topologySha256 !== config.topologySha256) {
    throw new Error("PRODUCTION_BOOTSTRAP_RECORD_BINDING_REQUIRED");
  }
  if (!input.chaos || typeof input.chaos.injectFault !== "function" || typeof input.chaos.observeFault !== "function") {
    throw new Error("PRODUCTION_CHAOS_CERTIFICATION_REQUIRED");
  }
  const telemetry = new ProductionTelemetryCertification({
    binding: {
      candidateId: config.candidateSha256,
      topologySha256: config.topologySha256,
      datasetSha256: record.execution.protected.input.datasetSha256,
      profileSha256: record.execution.protected.input.profileSha256,
      collectorDigest: record.execution.protected.collector.collectorDigest,
      configSha256: record.execution.protected.collector.configSha256,
    },
    deployment: record.serverControls.telemetry.deployment,
    authorization: generation.authorization,
    journal: generation.dependencies.journal,
    identity: createGooglePrivateControlIdentity(config.operator.serviceAccount),
    tokenSource: generation.dependencies.tokenSource,
  });
  const mountedGoogle = createMountedGoogleControls({
    config,
    generation,
    configuration: googleConfiguration,
    telemetry: Object.freeze({
      async emit(observation) { await telemetry.emitTelemetry({ operationId: `collector-emission-${sha(observation).slice(0, 48)}`, observation }); },
      queryWindow: binding => telemetry.telemetryWindow({ operationId: "collector-window", binding }),
    }),
  });
  const migrationSource = new ProductionMigrationSource({
    source: record.serverControls.migration.source as MigrationSource,
    pool: generation.dependencies.pool,
  });
  const cipher = new MigrationArchiveCipher(await input.secrets.bytes32("gcs.migrationBackupKeyReference"));
  const freshRuntime = createMountedFreshRestoreRuntime({
    config,
    secrets: input.secrets,
    google: mountedGoogle.google,
    artifactStore: generation.dependencies.artifactStore,
    observeTopology: async () => Object.freeze({ candidateSha256: config.candidateSha256, topologySha256: config.topologySha256 }),
  });
  const provisioner = new ProductionGoogleFreshRestoreProvisioner({
    google: mountedGoogle.google,
    projectId: config.projectId,
    region: googleConfiguration.cloudRun.region,
    cloudSql: googleConfiguration.cloudSql as never,
    cloudRun: {
      imageReference: googleConfiguration.cloudRun.imageReference,
      serviceAccountReference: config.operator.serviceAccount,
      environmentReferenceSha256: config.topologySha256,
      secretReferences: googleConfiguration.cloudRun.secretReferences as never,
      concurrency: googleConfiguration.cloudRun.concurrency,
    },
    runtime: freshRuntime,
  });
  const restore = new ProductionRestoreCertification({
    sourceInstanceId: record.serverControls.restore.sourceInstanceId,
    scope: record.serverControls.restore.scope,
    sourcePool: generation.dependencies.pool,
    migrationSource,
    migrationCipher: cipher,
    backupStore: generation.dependencies.artifactStore,
    retainedSubjects: generation.dependencies.retainedSubjects,
    journal: generation.dependencies.journal,
    provisioner,
    candidateSha256: config.candidateSha256,
    topologySha256: config.topologySha256,
  });
  const core = new ProductionCertificationCoreServices({
    candidates: { modal: config.candidateSha256, fly: config.candidateSha256 },
    certificationOwnerPubkey: generation.certificationClientPubkey,
    authorizationRequestSha256: generation.authorization.authorizationRequestSha256,
    requestedCap: "1",
    capacities: generation.dependencies.certificationCapacities,
    selectedProvider: config.worker.selectedProvider,
    journal: generation.dependencies.journal,
    pool: generation.dependencies.pool,
    restore,
  });
  const services: ProductionCertificationServices = Object.freeze({
    prepareCohort: core.prepareCohort.bind(core),
    observeCohort: core.observeCohort.bind(core),
    emitTelemetry: telemetry.emitTelemetry.bind(telemetry),
    telemetryWindow: telemetry.telemetryWindow.bind(telemetry),
    injectFault: input.chaos.injectFault.bind(input.chaos),
    observeFault: input.chaos.observeFault.bind(input.chaos),
    restore: core.restore.bind(core),
    async reconcile(value) {
      if (value.kind === "telemetry.emit") {
        const payload = z.object({ observation: z.unknown() }).strict().parse(value.payload);
        return telemetry.observeEmission({ operationId: value.operationId, observation: payload.observation });
      }
      if (value.kind === "telemetry.window") {
        const payload = z.object({ binding: z.unknown() }).strict().parse(value.payload);
        return telemetry.telemetryWindow({ operationId: value.operationId, binding: payload.binding });
      }
      if (value.kind === "fault.inject" || value.kind === "fault.observe") return input.chaos.reconcile(value);
      return core.reconcile(value);
    },
  });
  const certification = new ProductionCertificationControl({
    candidateSha256: config.candidateSha256,
    topologySha256: config.topologySha256,
    authorizationRequestSha256: generation.authorization.authorizationRequestSha256,
    authorizationRequest: generation.authorization.request,
    authorizationReceipt: generation.authorization.receipt,
    journal: generation.dependencies.journal,
    services,
    edge: new ProductionCertificationEdgeService({ broker: input.assembly.sealed.broker }),
  });
  const migration = new ProductionMigrationControl({
    registry: new ProductionMigrationServerRegistry({
      config,
      source: migrationSource,
      targetPool: generation.dependencies.pool,
      freshTargetIdentity: record.serverControls.migration.freshTargetIdentity,
      backupStore: generation.dependencies.artifactStore,
      archiveCipher: cipher,
    }),
    authorizationRequest: generation.authorization.request,
    authorizationReceipt: generation.authorization.receipt,
    journal: generation.dependencies.journal,
  });
  return Object.freeze({ certification, migration, telemetry });
}

/** Complete HTTP composition once the finite chaos service has been installed.
 * Everything else is resolved through the fixed mount before this server can
 * listen, and admission reads use the observer installed before SDK startup. */
export async function openMountedProductionHttpBootstrap(input: Readonly<{
}> = {}): Promise<ReturnType<typeof createMountedProductionHttpRuntime>> {
  const config = await loadMountedProductionBootstrapConfig();
  const resolved = await resolveMountedProductionBootstrap({ config });
  const assembly = await openMountedProductionSession({ config, secrets: resolved.secrets, resolved: resolved.record });
  const chaos = new ProductionChaosCertificationService({ config, generation: assembly.generation, contextvm: assembly.sealed.broker.clients.contextvmCertification });
  try {
    const controls = await createMountedProductionControlServices({
      config,
      secrets: resolved.secrets,
      record: resolved.record,
      assembly,
      chaos,
    });
    return createMountedProductionHttpRuntime({ assembly, certification: controls.certification, migration: controls.migration });
  } catch (error) {
    await assembly.generation.close().catch(() => undefined);
    throw error;
  }
}
