import { createProductionRetainedPricing, registerProductionPricing } from "./pricing-catalog";
import { createMountedProductionWorkerJobRouter } from "./mounted-worker-profiles";
import { ProductionOwnedDirectArtifacts } from "./owned-direct-artifacts";
import { openProductionServiceJournals } from "./service-journals";
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
import { ProductionSourceProposalStore, assertProductionSourceProposalSchema } from "./source-proposal-store";
import { createProductionVertexGenerationSettlement } from "./vertex-generation-settlement";
import { ProductionVertexReceiptRecovery } from "./vertex-receipt-recovery";
import { ProductionVertexModelGateway } from "./vertex-model-gateway";
import { createProductionReadyCapacity } from "./worker-capacity";
import { ProductionWorkerBridge, ProductionWorkerOwnershipResolver } from "./worker-bridge";
import { ProductionCheckpointCoordinator } from "./checkpoint-coordinator";
import { assertProductionCheckpointSchema } from "./checkpoint-schema";
import { assertProductionPendingCheckpointSchema } from "./initial-pending-checkpoint";
import { assertProductionSessionCapSchema } from "./session-cap-schema";

/** Coordinator-only actual provider graph. It owns only durable project
 * transports; generated workers see the bounded bridge, never ADC or rails. */
export async function materializeProductionRuntimeDependencies(input: Readonly<{ config: ProductionConfig; servicePubkey: string; pool: PostgresSqlPool; secrets: MountedProductionSecretMaterial; now?: () => number }>) {
  if (input.servicePubkey !== input.config.certification.serverPubkey) throw new Error("PRODUCTION_SERVICE_SIGNER_IDENTITY_MISMATCH");
  await assertProductionCheckpointSchema(input.pool);
  await assertProductionPendingCheckpointSchema(input.pool);
  await assertProductionSourceProposalSchema(input.pool);
  await assertProductionSessionCapSchema(input.pool);
  const serviceJournals = await openProductionServiceJournals({ pool: input.pool, servicePubkey: input.servicePubkey, initialTopologySha256: input.config.topologySha256 });
  const scopeSha256 = input.config.topologySha256;
  const journal = new PostgresOperationJournal(input.pool, { namespace: "production-runtime", scopeSha256 });
  /* Google mutation records and native receipt intent records deliberately use
   * distinct namespaces.  A receipt-gated provider persists its original
   * operation before Google claims the provider dispatch; sharing an ID in one
   * journal would turn that safety fence into an identity collision. */
  const googleControlJournal = new PostgresOperationJournal(input.pool, { namespace: "production-google-control", scopeSha256 });
  const googleIntentJournal = new PostgresOperationJournal(input.pool, { namespace: "production-google-intent", scopeSha256 });
  const workerJournal = serviceJournals.worker;
  const jobJournal = serviceJournals.job;
  const requestJournal = serviceJournals.request;
  const vertexJournal = serviceJournals.vertex;
  const tokenSource = createGoogleAdcTokenSource({ projectId: input.config.projectId, quotaProjectId: input.config.projectId, principal: input.config.operator.serviceAccount, now: input.now });
  const gcs = createProductionGcsObjectClient({ bucket: input.config.gcs.bucket, tokenSource });
  const artifactStore = new GcsObjectStoreAdapter({ config: { bucket: input.config.gcs.bucket, projectId: input.config.projectId }, client: gcs });
  const checkpointJournal = serviceJournals.checkpoint;
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
  await registerProductionPricing({ pool: input.pool, profile: vertexMaterial.pricing.profile, card: vertexMaterial.pricing.card });
  const jobRouter = await createMountedProductionWorkerJobRouter({ config: input.config, secrets: input.secrets, workerJournal, jobJournal, current: worker });
  const makeCapacity = (provider: "modal" | "fly") => createProductionReadyCapacity({ provider, workers: worker.clients, journal: serviceJournals.capacity, workerJournal, image: input.config.worker.image, toolchainSha256: input.config.worker.toolchainSha256, ...(provider === "fly" ? { flyRegion: worker.flyRegion } : {}), now: input.now });
  const certificationCapacities = Object.freeze({ modal: makeCapacity("modal"), fly: makeCapacity("fly") });
  const capacity = certificationCapacities[input.config.worker.selectedProvider];
  const vertexInteractions = createVertexInteractionsHttpPort({ tokenSource, creationTimeoutMs: vertexMaterial.pricing.profile.deadlineMs });
  const retainedPricing = createProductionRetainedPricing(input.pool);
  const vertex = createVertexDeploymentClient({ candidateSha256: input.config.candidateSha256, projectId: input.config.projectId, location: "global", model: input.config.vertex.model, credentialReference: vertexMaterial.credentialReference, price: vertexMaterial.vertexPrice, journal: createPostgresVertexOperationJournal(vertexJournal), interactions: vertexInteractions, now: input.now });
  const proposals = new ProductionSourceProposalStore(input.pool);
  const recovery = new ProductionVertexReceiptRecovery({ pool: input.pool, journal: vertexJournal, interactions: vertexInteractions, current: vertex, now: input.now });
  const gateway = new ProductionVertexModelGateway({ vertex, proposals, recovery });
  const settlement = createProductionVertexGenerationSettlement({ gateway, conversion: vertexMaterial.pricing.conversion, journal: vertexJournal });
  const resolver = new ProductionWorkerOwnershipResolver({ pool: input.pool, policyVersion: input.config.worker.policyVersion, capacityJournal: serviceJournals.capacity });
  const workerBridge = new ProductionWorkerBridge({ resolver, workers: worker.clients, workerJournal, jobJournal, requestJournal, artifactStore, jobRouter, toolchainSha256: input.config.worker.toolchainSha256, publication: { server: input.config.publication.uploadServer } });
  const ownedDirectArtifacts = new ProductionOwnedDirectArtifacts({ pool: input.pool, requestJournal, objects: artifactStore,
    profiles: [input.config.worker, ...(input.config.worker.retainedProfiles ?? [])].map(profile => ({ toolchainSha256: profile.toolchainSha256, artifactContract: profile.artifactContract })),
    publication: { server: input.config.publication.uploadServer } });
  return Object.freeze({ pool: input.pool, journal, serviceJournals, googleControlJournal, googleIntentJournal, workerJournal, jobJournal, requestJournal, vertexJournal, checkpointJournal, checkpointCoordinator, tokenSource, gcs, artifactStore, workers: worker.clients, jobRouter, ownedDirectArtifacts, workerCertification: worker.certification, flyRegion: worker.flyRegion, capacity, certificationCapacities, vertexMaterial, vertex, proposals, gateway, settlement, retainedPricing, resolver, workerBridge });
}
