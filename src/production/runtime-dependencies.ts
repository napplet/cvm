import { GcsObjectStoreAdapter } from "../continuity/object-store";
import { createGoogleAdcTokenSource } from "../release/deployment/google-auth";
import { PostgresOperationJournal } from "../release/deployment/postgres-operation-journal";
import { createPostgresVertexOperationJournal, createPostgresWorkerOperationJournal } from "../release/deployment/postgres-provider-journals";
import { createVertexDeploymentClient, createVertexInteractionsHttpPort } from "../release/deployment/vertex-client";
import type { PostgresSqlPool } from "../persistence/postgres-sql-funding-store";
import type { ProductionConfig } from "./config";
import { createProductionGcsObjectClient } from "./gcs-object-client";
import { createMountedProductionWorkerClients } from "./mounted-worker-clients";
import { createMountedVertexMaterial } from "./mounted-vertex-material";
import type { MountedProductionSecretMaterial } from "./secret-material";
import { ProductionSourceProposalStore } from "./source-proposal-store";
import { createProductionVertexGenerationSettlement } from "./vertex-generation-settlement";
import { ProductionVertexModelGateway } from "./vertex-model-gateway";
import { createProductionReadyCapacity } from "./worker-capacity";
import { ProductionWorkerBridge, ProductionWorkerOwnershipResolver } from "./worker-bridge";
import { ProductionCheckpointCoordinator } from "./checkpoint-coordinator";

/** Coordinator-only actual provider graph. It owns only durable project
 * transports; generated workers see the bounded bridge, never ADC or rails. */
export async function materializeProductionRuntimeDependencies(input: Readonly<{ config: ProductionConfig; pool: PostgresSqlPool; secrets: MountedProductionSecretMaterial; now?: () => number }>) {
  const scopeSha256 = input.config.topologySha256;
  const journal = new PostgresOperationJournal(input.pool, { namespace: "production-runtime", scopeSha256 });
  /* Google mutation records and native receipt intent records deliberately use
   * distinct namespaces.  A receipt-gated provider persists its original
   * operation before Google claims the provider dispatch; sharing an ID in one
   * journal would turn that safety fence into an identity collision. */
  const googleControlJournal = new PostgresOperationJournal(input.pool, { namespace: "production-google-control", scopeSha256 });
  const googleIntentJournal = new PostgresOperationJournal(input.pool, { namespace: "production-google-intent", scopeSha256 });
  const workerJournal = new PostgresOperationJournal(input.pool, { namespace: "production-worker", scopeSha256 });
  const jobJournal = new PostgresOperationJournal(input.pool, { namespace: "production-worker-job", scopeSha256 });
  const requestJournal = new PostgresOperationJournal(input.pool, { namespace: "production-worker-request", scopeSha256 });
  const vertexJournal = new PostgresOperationJournal(input.pool, { namespace: "production-vertex", scopeSha256 });
  const tokenSource = createGoogleAdcTokenSource({ projectId: input.config.projectId, quotaProjectId: input.config.projectId, principal: input.config.operator.serviceAccount, now: input.now });
  const gcs = createProductionGcsObjectClient({ bucket: input.config.gcs.bucket, tokenSource });
  const artifactStore = new GcsObjectStoreAdapter({ config: { bucket: input.config.gcs.bucket, projectId: input.config.projectId }, client: gcs });
  const checkpointJournal = new PostgresOperationJournal(input.pool, { namespace: "production-checkpoint", scopeSha256 });
  const checkpointCoordinator = new ProductionCheckpointCoordinator({
    pool: input.pool,
    objectStore: artifactStore,
    journal: checkpointJournal,
    kekPath: input.secrets.path("checkpoint.kekReference"),
    now: input.now,
  });
  const [worker, vertexMaterial] = await Promise.all([
    createMountedProductionWorkerClients({ config: input.config, secrets: input.secrets, journal: createPostgresWorkerOperationJournal(workerJournal) }),
    createMountedVertexMaterial({ config: input.config, secrets: input.secrets, now: input.now }),
  ]);
  const makeCapacity = (provider: "modal" | "fly") => createProductionReadyCapacity({ provider, workers: worker.clients, journal, image: input.config.worker.image, toolchainSha256: input.config.worker.toolchainSha256, ...(provider === "fly" ? { flyRegion: worker.flyRegion } : {}), now: input.now });
  const certificationCapacities = Object.freeze({ modal: makeCapacity("modal"), fly: makeCapacity("fly") });
  const capacity = certificationCapacities[input.config.worker.selectedProvider];
  const vertex = createVertexDeploymentClient({ candidateSha256: input.config.candidateSha256, projectId: input.config.projectId, location: "global", model: input.config.vertex.model, credentialReference: vertexMaterial.credentialReference, price: vertexMaterial.vertexPrice, journal: createPostgresVertexOperationJournal(vertexJournal), interactions: createVertexInteractionsHttpPort({ tokenSource }), now: input.now });
  const proposals = new ProductionSourceProposalStore(input.pool);
  const gateway = new ProductionVertexModelGateway({ vertex, proposals });
  const settlement = createProductionVertexGenerationSettlement({ gateway, conversion: vertexMaterial.pricing.conversion, journal: vertexJournal });
  const resolver = new ProductionWorkerOwnershipResolver({ pool: input.pool, policyVersion: input.config.worker.policyVersion, capacityJournal: journal });
  const workerBridge = new ProductionWorkerBridge({ resolver, workers: worker.clients, workerJournal, jobJournal, requestJournal, artifactStore, toolchainSha256: input.config.worker.toolchainSha256 });
  return Object.freeze({ pool: input.pool, journal, googleControlJournal, googleIntentJournal, workerJournal, jobJournal, requestJournal, vertexJournal, checkpointJournal, checkpointCoordinator, tokenSource, gcs, artifactStore, workers: worker.clients, workerCertification: worker.certification, flyRegion: worker.flyRegion, capacity, certificationCapacities, vertexMaterial, vertex, proposals, gateway, settlement, resolver, workerBridge });
}
