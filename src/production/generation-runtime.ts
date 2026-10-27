import { MeteredGenerationService } from "../phase-04/metered-generation-service";
import { openContextVmRelayTransport } from "../release/deployment/contextvm-client";
import { openProductionFunding } from "../release/deployment/production-funding";
import { PostgresOperationJournal } from "../release/deployment/postgres-operation-journal";
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

async function digest(value: unknown): Promise<string> { const hash = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(JSON.stringify(value))); return Array.from(new Uint8Array(hash), byte => byte.toString(16).padStart(2, "0")).join(""); }
export type ProductionGenerationRuntime = Readonly<{
  config: ProductionConfig;
  certificationClientPubkey: string;
  authorization: Awaited<ReturnType<typeof createMountedProductionAuthorization>>;
  generation: MeteredGenerationService;
  continuation: ProductionContinuationCoordinator;
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
    const [dependencies, authorization] = await Promise.all([materializeProductionRuntimeDependencies({ config, pool: postgres.pool, secrets, now: input.now }), createMountedProductionAuthorization({ config, secrets, now: input.now })]);
    const materials = await createMountedProductionFundingMaterial({ config, secrets });
    const certificationClientPubkey = await loadProductionCertificationPubkey(secrets);
    const continuation = new ProductionContinuationCoordinator({ pool: postgres.pool, store: new PostgresSqlFundingStore(bindAccountingRealmPool(postgres.pool, createAccountingRealm("production-real"))), capacity: dependencies.capacity, worker: dependencies.workerBridge, checkpoint: dependencies.checkpointCoordinator, compatibility: { policyVersion: config.worker.policyVersion, profileId: dependencies.vertexMaterial.pricing.profile.id, priceCardId: dependencies.vertexMaterial.pricing.card.id, toolchainId: config.worker.toolchainSha256 }, now: input.now });
    const admissionObserver = new ProductionCertificationCoreServices({
      candidates: { modal: config.candidateSha256, fly: config.candidateSha256 },
      certificationOwnerPubkey: certificationClientPubkey,
      requestedCap: "1",
      capacities: dependencies.certificationCapacities,
      selectedProvider: config.worker.selectedProvider,
      journal: dependencies.journal,
      pool: postgres.pool,
    });
    relay = await openContextVmRelayTransport({ serviceKeyReference: config.contextvm.serviceKeyReference, relaySetSha256: await digest([config.contextvm.relay]), relays: [config.contextvm.relay], signerBroker: materials.contextvmSignerBroker, journal: new PostgresOperationJournal(postgres.pool, { namespace: "production-contextvm", scopeSha256: config.topologySha256 }), admissionObserver, certificationClientPubkey });
    const facade = new SealedProductionGenerationFacade();
    funding = await openProductionFunding({ postgresPool: postgres.pool, transport: relay.transport, cashuPolicies: materials.cashuPolicies, capacity: admissionObserver.capacityRouter(), protectedMaterialKey: await secrets.bytes32("funding.protectedMaterialReference"), admissionReceiptSecret: await secrets.bytes32("funding.admissionReceiptReference"), statusCursorSecret: await secrets.bytes32("funding.statusCursorReference"), accountingConfiguration: Object.freeze({ mode: "production-real", adapters: ["lightning", "cashu", "nwc"], catalog: { kind: "live" }, keyMode: "secret-broker" }), meteredService: facade, continuationService: continuation.service, nwcConnectionReference: config.funding.nwcConnectionReference, nwcCredentialBroker: materials.nwcCredentialBroker, nwcJournal: new PostgresOperationJournal(postgres.pool, { namespace: "production-nwc", scopeSha256: config.topologySha256 }) });
    const generation = new MeteredGenerationService({ fundedAdmission: funding.core.admissions, store: funding.database.meteredFunding, gateway: dependencies.gateway, worker: dependencies.workerBridge, artifactVerifier: dependencies.workerBridge, proposalStore: dependencies.proposals, pricing: { card: dependencies.vertexMaterial.pricing.card, profile: dependencies.vertexMaterial.pricing.profile }, settlement: dependencies.settlement, continuation: continuation.service, toolchainIdentity: config.worker.toolchainSha256, clock: { nowMs: input.now ?? Date.now } });
    facade.bind(generation); await relay.start();
    // This is a bounded reconciliation poll over already-paused SQL rows, not
    // an admission queue. Every candidate remains fenced by the transaction.
    const continuationTimer = setInterval(() => { void continuation.scan(); }, 30_000);
    continuationTimer.unref?.();
    const mountedClosers = new Set<() => Promise<void>>();
    return Object.freeze({
      config, certificationClientPubkey, authorization, generation, continuation, facade, funding, dependencies, admissionObserver,
      registerClose(close) {
        if (typeof close !== "function") throw new Error("PRODUCTION_RUNTIME_CLOSE_HANDLER_REQUIRED");
        mountedClosers.add(close);
      },
      close: async () => {
        clearInterval(continuationTimer);
        for (const close of mountedClosers) await close().catch(() => undefined);
        mountedClosers.clear();
        await relay!.close().catch(() => undefined);
        await funding!.close().catch(() => undefined);
        await postgres.close();
      },
    });
  } catch (error) { await relay?.close().catch(() => undefined); await funding?.close().catch(() => undefined); await postgres.close().catch(() => undefined); throw error; }
}
