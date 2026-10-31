import { ProductionFundedReplayAuthority } from "./funded-replay-authority";
import { ProductionAdmissionCapacityRecovery } from "./admission-capacity-recovery";
import { ProductionContextVmGenerationIntakes } from "./contextvm-generation-intake";
import { ProtectedGenerationCommands } from "../model/retained-generation-command";
import { loadMountedCheckpointKek } from "./checkpoint-crypto";
import { ProductionGenerationRecovery } from "./generation-recovery";
import { MeteredGenerationService } from "../phase-04/metered-generation-service";
import { openContextVmRelayTransport } from "../release/deployment/contextvm-client";
import { openProductionFunding } from "../release/deployment/production-funding";
import { loadProductionConfig, type ProductionConfig } from "./config";
import { SealedProductionGenerationFacade } from "./generation-facade";
import { createMountedProductionFundingMaterial } from "./mounted-funding-material";
import { createMountedProductionAuthorization } from "./mounted-authorization";
import { openProductionPostgresPool } from "./postgres";
import { materializeProductionRuntimeDependencies } from "./runtime-dependencies";
import { MountedProductionSecretMaterial } from "./secret-material";
import { PostgresSqlFundingStore } from "../persistence/postgres-sql-funding-store";
import { bindAccountingRealmPool, createAccountingRealm } from "../funding/accounting-realm";
import { ProductionContinuationCoordinator } from "./continuation-coordinator";
import { ProductionCertificationCoreServices } from "./certification-services";
import { loadProductionCertificationPubkey } from "./certification-identity";
import { ProductionPricedContinuationService, SealedProductionPricedContinuationFacade } from "./priced-continuation-service";

async function digest(value: unknown): Promise<string> { const hash = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(JSON.stringify(value))); return Array.from(new Uint8Array(hash), byte => byte.toString(16).padStart(2, "0")).join(""); }
export type ProductionGenerationRuntime = Readonly<{
  config: ProductionConfig;
  certificationClientPubkey: string;
  authorization: Awaited<ReturnType<typeof createMountedProductionAuthorization>>;
  generation: MeteredGenerationService;
  continuation: ProductionContinuationCoordinator;
  pricedContinuation: ProductionPricedContinuationService;
  facade: SealedProductionGenerationFacade;
  funding: Awaited<ReturnType<typeof openProductionFunding>>;
  dependencies: Awaited<ReturnType<typeof materializeProductionRuntimeDependencies>>;
  /** Installed around the SDK source before the relay is started, so every
   * inbound admission is observed against the real SQL/capacity authority. */
  admissionObserver: ProductionCertificationCoreServices;
  /** Mounted certification transports are created after the base graph. They
   * register their deterministic teardown here so a failed assembly cannot
   * strand a relay connection. */
  registerClose(close: () => Promise<void>): void;
  close(): Promise<void>;
}>;

/** Concrete paid graph: mounted material, restricted SQL, original-operation
 * journals, then authenticated relay startup. There are no user callbacks. */
export async function openProductionGenerationRuntime(input: Readonly<{ config: unknown; secrets?: MountedProductionSecretMaterial; now?: () => number }>): Promise<ProductionGenerationRuntime> {
  const config = loadProductionConfig(input.config); const secrets = input.secrets ?? new MountedProductionSecretMaterial(config); const postgres = await openProductionPostgresPool(config, secrets);
  let relay: Awaited<ReturnType<typeof openContextVmRelayTransport>> | undefined; let funding: Awaited<ReturnType<typeof openProductionFunding>> | undefined;
  try {
    const materials = await createMountedProductionFundingMaterial({ config, secrets });
    const serviceSigner = await materials.contextvmSignerBroker.resolveContextVmSigner({ reference: config.contextvm.serviceKeyReference, purpose: "contextvm_service" });
    const servicePubkey = await serviceSigner.getPublicKey();
    if (servicePubkey !== config.certification.serverPubkey) throw new Error("PRODUCTION_SERVICE_SIGNER_IDENTITY_MISMATCH");
    const [dependencies, authorization] = await Promise.all([materializeProductionRuntimeDependencies({ config, servicePubkey, pool: postgres.pool, secrets, now: input.now }), createMountedProductionAuthorization({ config, secrets, now: input.now })]);
    const certificationClientPubkey = await loadProductionCertificationPubkey(secrets);
    const continuation = new ProductionContinuationCoordinator({ pool: postgres.pool, store: new PostgresSqlFundingStore(bindAccountingRealmPool(postgres.pool, createAccountingRealm("production-real"))), capacity: dependencies.capacity, worker: dependencies.workerBridge, checkpoint: dependencies.checkpointCoordinator, compatibility: { policyVersion: config.worker.policyVersion, profileId: dependencies.vertexMaterial.pricing.profile.id, priceCardId: dependencies.vertexMaterial.pricing.card.id, toolchainId: config.worker.toolchainSha256 }, now: input.now });
    const admissionObserver = new ProductionCertificationCoreServices({
      candidates: { modal: config.candidateSha256, fly: config.candidateSha256 },
      certificationOwnerPubkey: certificationClientPubkey,
      authorizationRequestSha256: authorization.authorizationRequestSha256,
      requestedCap: "1",
      capacities: dependencies.certificationCapacities,
      selectedProvider: config.worker.selectedProvider,
      journal: dependencies.journal,
      pool: postgres.pool,
    });
    const replayAuthority = new ProductionFundedReplayAuthority({ pool: postgres.pool, capacity: dependencies.capacity, now: input.now });
    const generationIntakes = new ProductionContextVmGenerationIntakes({ journal: dependencies.serviceJournals.contextvm, replayAuthority,
      executionContextSha256: await digest({ processor: "contextvm-funded-generation-v1", policyVersion: "funding-policy-v1", protocolVersion: "funding-contract-v1", candidateSha256: config.candidateSha256, servicePubkey, config, pricing: dependencies.vertexMaterial.pricing }),
      key: { reference: config.checkpoint.kekReference, load: () => loadMountedCheckpointKek({ kekPath: secrets.path("checkpoint.kekReference") }) }, now: input.now });
    relay = await openContextVmRelayTransport({ serviceKeyReference: config.contextvm.serviceKeyReference, relaySetSha256: await digest([config.contextvm.relay]), relays: [config.contextvm.relay], signerBroker: materials.contextvmSignerBroker, journal: dependencies.serviceJournals.contextvm, admissionObserver, certificationClientPubkey, generationIntakes });
    const facade = new SealedProductionGenerationFacade();
    const pricedContinuationFacade = new SealedProductionPricedContinuationFacade();
    funding = await openProductionFunding({ postgresPool: postgres.pool, transport: relay.transport, cashuPolicies: materials.cashuPolicies, capacity: admissionObserver.capacityRouter(), protectedMaterialKey: await secrets.bytes32("funding.protectedMaterialReference"), admissionReceiptSecret: await secrets.bytes32("funding.admissionReceiptReference"), statusCursorSecret: await secrets.bytes32("funding.statusCursorReference"), accountingConfiguration: Object.freeze({ mode: "production-real", adapters: ["lightning", "cashu", "nwc"], catalog: { kind: "live" }, keyMode: "secret-broker" }), meteredService: facade, continuationService: continuation.service, pricedContinuation: pricedContinuationFacade, nwcConnectionReference: config.funding.nwcConnectionReference, nwcCredentialBroker: materials.nwcCredentialBroker, nwcJournal: dependencies.serviceJournals.nwc });
    const recoveryCommands = new ProtectedGenerationCommands({ reference: config.checkpoint.kekReference, load: () => loadMountedCheckpointKek({ kekPath: secrets.path("checkpoint.kekReference") }) }, input.now);
    const generation = new MeteredGenerationService({ fundedAdmission: funding.core.admissions, store: funding.database.meteredFunding, gateway: dependencies.gateway, worker: dependencies.workerBridge, artifactVerifier: dependencies.workerBridge, proposalStore: dependencies.proposals, pricing: { card: dependencies.vertexMaterial.pricing.card, profile: dependencies.vertexMaterial.pricing.profile }, settlement: dependencies.settlement, retainedPricing: dependencies.retainedPricing, recoveryCommands, continuation: continuation.service, toolchainIdentity: config.worker.toolchainSha256, clock: { nowMs: input.now ?? Date.now } });
    const pricedContinuation = await ProductionPricedContinuationService.create({ pool: postgres.pool, config, generation, capacity: dependencies.capacity,
      checkpoint: dependencies.checkpointCoordinator, vertexJournal: dependencies.vertexJournal, workerJournal: dependencies.workerJournal,
      jobJournal: dependencies.jobJournal, requestJournal: dependencies.requestJournal, capacityJournal: dependencies.serviceJournals.capacity,
      artifactStore: dependencies.artifactStore, workers: dependencies.workers, jobRouter: dependencies.jobRouter, gateway: dependencies.gateway,
      pricing: dependencies.vertexMaterial.pricing, now: input.now });
    const generationRecovery = new ProductionGenerationRecovery({ pool: postgres.pool, commands: recoveryCommands, replayAuthority, acceptedToolchains: dependencies.jobRouter.toolchainSha256s, generation });
    await generationRecovery.assertReady();
    const admissionCapacityRecovery = new ProductionAdmissionCapacityRecovery({ pool: postgres.pool, capacity: dependencies.capacity,
      router: dependencies.jobRouter, workerJournal: dependencies.workerJournal, journal: dependencies.serviceJournals.capacity, now: input.now });
    await admissionCapacityRecovery.assertReady();
    facade.bind(generation); pricedContinuationFacade.bind(pricedContinuation); await relay.start();
    // This is a bounded reconciliation poll over already-paused SQL rows, not
    // an admission queue. Every candidate remains fenced by the transaction.
    const continuationTimer = setInterval(() => { void continuation.scan(); }, 30_000);
    continuationTimer.unref?.();
    const recoveryTimer = setInterval(() => { void generationRecovery.scan().catch(() => undefined); }, 30_000);
    recoveryTimer.unref?.();
    const intakeTimer = setInterval(() => { void relay!.transport.recoverPendingGenerations().catch(() => undefined); },30_000);
    intakeTimer.unref?.();
    const capacityRecoveryTimer = setInterval(() => { void admissionCapacityRecovery.scan().catch(() => undefined); },30_000);
    capacityRecoveryTimer.unref?.();
    const mountedClosers = new Set<() => Promise<void>>();
    return Object.freeze({
      config, certificationClientPubkey, authorization, generation, continuation, pricedContinuation, facade, funding, dependencies, admissionObserver,
      registerClose(close) {
        if (typeof close !== "function") throw new Error("PRODUCTION_RUNTIME_CLOSE_HANDLER_REQUIRED");
        mountedClosers.add(close);
      },
      close: async () => {
        clearInterval(continuationTimer);
        clearInterval(recoveryTimer);
        clearInterval(intakeTimer);
        clearInterval(capacityRecoveryTimer);
        await generationIntakes.close().catch(() => undefined);
        await generationRecovery.close().catch(() => undefined);
        await admissionCapacityRecovery.close().catch(() => undefined);
        for (const close of mountedClosers) await close().catch(() => undefined);
        mountedClosers.clear();
        await relay!.close().catch(() => undefined);
        await funding!.close().catch(() => undefined);
        await postgres.close();
      },
    });
  } catch (error) { await relay?.close().catch(() => undefined); await funding?.close().catch(() => undefined); await postgres.close().catch(() => undefined); throw error; }
}
