import type { ProductionMigrationControl } from "./migration-control";
import {
  createGooglePrivateOperatorIdentity,
  createProductionRuntime,
  sealProductionRuntimeAuthority,
  type PrivateCertificationControl,
  type ProductionRuntime,
} from "./composition";
import { openProductionGenerationRuntime, type ProductionGenerationRuntime } from "./generation-runtime";
import {
  createProductionSessionDependencies,
  type ProductionSessionRuntime,
} from "../release/deployment/production-session";
import {
  installSealedProductionSessionMaterial,
  sealProductionSessionMaterial,
  type ProductionCertificationSessionMaterial,
  type SealedProductionSessionMaterial,
} from "../release/deployment/production-session-material";
import {
  createProductionCertificationSessionMaterial,
  type MountedProductionSessionReferences,
} from "./mounted-session-material";
import { assembleInstalledProductionSessionRuntime } from "../release/deployment/production-session-runtime";
import type { MountedProductionSecretMaterial } from "./secret-material";
import { MountedProductionSecretMaterial as MountedSecrets } from "./secret-material";
import { assertProductionCheckpointCoordinator } from "./checkpoint-coordinator";
import { loadProductionConfig } from "./config";
import { ProductionDirectArtifactDelivery } from "./direct-artifact-delivery";
import { createMountedDeploymentExecutionConfig, loadMountedProductionSessionRecord } from "./mounted-session-record";

/**
 * Deployment-only session join. `sessionMaterial` contains actual branded
 * clients (including the edge's Chromium/NIP-46/relay adapters), a PostgreSQL
 * journal, and the checkpoint coordinator's bound preparation function. It
 * deliberately has no request, credential, or callback fields supplied by an
 * HTTP or CLI caller.
 */
export type MountedProductionSessionAssembly = Readonly<{
  generation: ProductionGenerationRuntime;
  sealed: SealedProductionSessionMaterial;
  session: ProductionSessionRuntime;
  effects: ReturnType<typeof assembleInstalledProductionSessionRuntime>["effects"];
}>;

function assertMountedSessionBinding(input: Readonly<{
  generation: ProductionGenerationRuntime;
  material: ProductionCertificationSessionMaterial;
}>): void {
  const { config, authorization } = input.generation;
  if (input.material.realm !== "production-real"
    || input.material.deploymentConfig.candidateSha256 !== config.candidateSha256
    || input.material.workerCandidate.id !== config.candidateSha256) {
    throw new Error("PRODUCTION_RUNTIME_SESSION_CANDIDATE_BINDING_REQUIRED");
  }
  try {
    assertProductionCheckpointCoordinator(input.material.checkpointCoordinator);
    assertProductionCheckpointCoordinator(input.generation.dependencies.checkpointCoordinator);
  } catch {
    throw new Error("PRODUCTION_RUNTIME_SESSION_CHECKPOINT_REQUIRED");
  }
  if (input.material.checkpointCoordinator !== input.generation.dependencies.checkpointCoordinator) {
    throw new Error("PRODUCTION_RUNTIME_SESSION_CHECKPOINT_BINDING_REQUIRED");
  }
  const request = authorization.request as Partial<Readonly<{
    candidateSha256: unknown;
    topologySha256: unknown;
  }>>;
  const receipt = authorization.receipt as Partial<Readonly<{
    candidateSha256: unknown;
    topologySha256: unknown;
  }>>;
  if (request.candidateSha256 !== config.candidateSha256
    || request.topologySha256 !== config.topologySha256
    || receipt.candidateSha256 !== config.candidateSha256
    || receipt.topologySha256 !== config.topologySha256) {
    throw new Error("PRODUCTION_RUNTIME_SESSION_AUTHORIZATION_BINDING_REQUIRED");
  }
}

/**
 * Seals and installs the sole certification broker from mounted runtime
 * authority. This is deliberately separate from opening the generation graph
 * so tests and deployment bootstrap can verify the exact receipt boundary
 * without starting an HTTP listener or accepting an effect-capable CLI port.
 */
export async function assembleMountedProductionSession(input: Readonly<{
  generation: ProductionGenerationRuntime;
  material: ProductionCertificationSessionMaterial;
}>): Promise<MountedProductionSessionAssembly> {
  assertMountedSessionBinding(input);
  const sealed = installSealedProductionSessionMaterial(await sealProductionSessionMaterial({
    authorization: input.generation.authorization,
    material: input.material,
  }));
  const assembled = assembleInstalledProductionSessionRuntime(sealed.authorization.receipt);
  const session = Object.freeze({
    ...assembled.runtime,
    // The receipt returned by the mounted secret reader was canonicalized by
    // sealProductionSessionMaterial; keep this exact immutable value through
    // every later factory and protected-operation validation.
    receipt: sealed.authorization.receipt,
  });
  createProductionSessionDependencies(session);
  return Object.freeze({ generation: input.generation, sealed, session, effects: assembled.effects });
}

/** Opens the normal mounted production graph and immediately joins it to the
 * complete receipt-bound session broker. No environment-selected dev graph,
 * user JSON, or callback bag can replace the mounted authorization pair. */
export async function openMountedProductionSession(input: Readonly<{
  config: unknown;
  /** Bootstrap may supply already-materialized session authority for a
   * recovery process. Normal startup supplies controller-resolved references
   * and always uses the mounted materializer below. */
  material?: ProductionCertificationSessionMaterial;
  resolved?: MountedProductionSessionReferences;
  secrets?: MountedProductionSecretMaterial;
  now?: () => number;
}>): Promise<MountedProductionSessionAssembly> {
  const config = loadProductionConfig(input.config);
  const secrets = input.secrets ?? new MountedSecrets(config);
  /* Resolve the immutable controller record before opening SQL, relays, or a
   * payment transport.  Normal boot has no injection requirement; recovery
   * callers may still supply the already parsed record or sealed material. */
  const resolved = input.resolved ?? (input.material ? undefined : await loadMountedProductionSessionRecord({ config, secrets }));
  const deploymentConfig = resolved ? createMountedDeploymentExecutionConfig({ config, record: resolved }) : undefined;
  const generation = await openProductionGenerationRuntime({
    config,
    secrets,
    ...(input.now ? { now: input.now } : {}),
  });
  try {
    const material = input.material ?? (resolved && deploymentConfig
      ? await createProductionCertificationSessionMaterial({
        config: generation.config,
        deploymentConfig,
        generation,
        authorization: generation.authorization,
        secrets,
        resolved,
      })
      : undefined);
    if (!material) throw new Error("PRODUCTION_RUNTIME_SESSION_MATERIAL_REQUIRED");
    return await assembleMountedProductionSession({ generation, material });
  } catch (error) {
    await generation.close().catch(() => undefined);
    throw error;
  }
}

/**
 * HTTP authority is made only after the session above is installed. Core
 * certification/migration controls are concrete project-owned services; the
 * public entry point has no generation route and no way to replace provider
 * ports. The admission observer remains a narrow read-only operation lookup.
 */
export function createMountedProductionHttpRuntime(input: Readonly<{
  assembly: MountedProductionSessionAssembly;
  certification: PrivateCertificationControl;
  migration: ProductionMigrationControl;
}>): ProductionRuntime {
  const delivery = new ProductionDirectArtifactDelivery({ artifacts: input.assembly.generation.dependencies.ownedDirectArtifacts,
    previewOrigin: input.assembly.generation.config.publicOrigins.preview, artifactOrigin: input.assembly.generation.config.publicOrigins.artifact });
  const authority = sealProductionRuntimeAuthority({
    authority: "production-real",
    funded: input.assembly.generation.funding.core,
    generation: input.assembly.generation.generation,
    journal: input.assembly.session.journal,
    session: input.assembly.session,
    certification: input.certification,
    migration: input.migration,
    observeAdmissionOperation: input.assembly.generation.admissionObserver.observeAdmissionOperation.bind(input.assembly.generation.admissionObserver),
    close: input.assembly.generation.close,
  });
  return createProductionRuntime({
    config: input.assembly.generation.config,
    authority,
    previewHandler: delivery.preview,
    artifactHandler: delivery.artifact,
    operatorIdentity: createGooglePrivateOperatorIdentity({
      serviceAccount: input.assembly.generation.config.operator.serviceAccount,
    }),
  });
}
