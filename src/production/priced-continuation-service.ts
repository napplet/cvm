import type { ObjectStorePort } from "../continuity/object-store";
import type { PostgresSqlPool } from "../persistence/postgres-sql-funding-store";
import type { PostgresOperationJournal } from "../release/deployment/postgres-operation-journal";
import type { createWorkerDeploymentClients } from "../release/deployment/worker-clients";
import { MeteredGenerationService } from "../phase-04/metered-generation-service";
import { ProductionCheckpointCoordinator } from "./checkpoint-coordinator";
import type { ProductionConfig } from "./config";
import { ProductionPricedContinuationCleanup } from "./priced-continuation-cleanup";
import { ProductionPricedContinuationFinalizer } from "./priced-continuation-finalizer";
import { ProductionPricedContinuationRestores } from "./priced-continuation-restores";
import { ProductionPricedContinuationRunner } from "./priced-continuation-runner";
import { ProductionPricedContinuationWorkers } from "./priced-continuation-workers";
import { ProductionResumeAcceptance } from "./resume-acceptance";
import { ProductionResumePricingPreparer } from "./resume-pricing-preparer";
import { ProductionResumePricingQuotes } from "./resume-pricing-quotes";
import type { ProductionVertexModelGateway } from "./vertex-model-gateway";
import { createVertexGeminiProductionPricing } from "../model/price-card";
import type { ProductionWorkerJobRouter } from "./worker-job-router";
import { ProductionWorkerBridge, ProductionWorkerOwnershipResolver } from "./worker-bridge";
import type { ProductionReadyCapacityPort } from "./worker-capacity";
import { PostgresSqlFundingStore } from "../persistence/postgres-sql-funding-store";

type PricedContinuationSurface = Readonly<{
  prepare(input: unknown): Promise<unknown>;
  resume(input: unknown): Promise<unknown>;
}>;

/** The ContextVM adapter is assembled before generation can be constructed.
 * This one-time facade preserves that order without making a caller-supplied
 * resume handler a production authority. */
export class SealedProductionPricedContinuationFacade implements PricedContinuationSurface {
  #service: PricedContinuationSurface | undefined;

  bind(service: PricedContinuationSurface): void {
    if (this.#service || !service || typeof service.prepare !== "function" || typeof service.resume !== "function") {
      throw new Error("PRODUCTION_PRICED_CONTINUATION_BINDING_REQUIRED");
    }
    this.#service = service;
  }

  #get(): PricedContinuationSurface {
    if (!this.#service) throw new Error("PRODUCTION_PRICED_CONTINUATION_NOT_BOUND");
    return this.#service;
  }

  prepare(input: unknown): Promise<unknown> { return this.#get().prepare(input); }
  resume(input: unknown): Promise<unknown> { return this.#get().resume(input); }
}

/** Private mounted composition for the accepted V2 lifecycle. Its public
 * surface accepts only principal-bound prepare/resume commands; every quote,
 * claim, worker and archive authority stays in existing production classes. */
export class ProductionPricedContinuationService {
  readonly quotes: ProductionResumePricingQuotes;
  readonly preparer: ProductionResumePricingPreparer;
  readonly acceptance: ProductionResumeAcceptance;
  readonly workers: ProductionPricedContinuationWorkers;
  readonly worker: ProductionWorkerBridge;
  readonly restores: ProductionPricedContinuationRestores;
  readonly finalizer: ProductionPricedContinuationFinalizer;
  readonly cleanup: ProductionPricedContinuationCleanup;
  readonly runner: ProductionPricedContinuationRunner;

  private constructor(input: Readonly<{
    quotes: ProductionResumePricingQuotes; preparer: ProductionResumePricingPreparer; acceptance: ProductionResumeAcceptance;
    workers: ProductionPricedContinuationWorkers; worker: ProductionWorkerBridge; restores: ProductionPricedContinuationRestores;
    finalizer: ProductionPricedContinuationFinalizer; cleanup: ProductionPricedContinuationCleanup; runner: ProductionPricedContinuationRunner;
  }>) {
    this.quotes = input.quotes; this.preparer = input.preparer; this.acceptance = input.acceptance; this.workers = input.workers;
    this.worker = input.worker; this.restores = input.restores; this.finalizer = input.finalizer; this.cleanup = input.cleanup; this.runner = input.runner;
  }

  static async create(input: Readonly<{
    pool: PostgresSqlPool; config: ProductionConfig; generation: MeteredGenerationService; capacity: ProductionReadyCapacityPort;
    checkpoint: ProductionCheckpointCoordinator; vertexJournal: PostgresOperationJournal; workerJournal: PostgresOperationJournal;
    jobJournal: PostgresOperationJournal; requestJournal: PostgresOperationJournal; capacityJournal: PostgresOperationJournal;
    artifactStore: ObjectStorePort; workers: ReturnType<typeof createWorkerDeploymentClients>; jobRouter: ProductionWorkerJobRouter;
    gateway: ProductionVertexModelGateway; pricing: Awaited<ReturnType<typeof createVertexGeminiProductionPricing>>; now?: () => number;
  }>): Promise<ProductionPricedContinuationService> {
    const store = new PostgresSqlFundingStore(input.pool, { deadlineMs: 5000, maxAttempts: 4 });
    const quotes = new ProductionResumePricingQuotes(input.pool);
    const preparer = new ProductionResumePricingPreparer({ pool: input.pool, store, checkpoint: input.checkpoint, quotes,
      vertexJournal: input.vertexJournal, currentPricing: input.pricing,
      compatibility: { policyVersion: input.config.worker.policyVersion, acceptedToolchains: input.jobRouter.toolchainSha256s }, now: input.now });
    const acceptance = new ProductionResumeAcceptance({ pool: input.pool, quotes, preparer, now: input.now });
    const workers = new ProductionPricedContinuationWorkers({ pool: input.pool, acceptance, capacity: input.capacity, now: input.now });
    const resolver = new ProductionWorkerOwnershipResolver({ pool: input.pool, policyVersion: input.config.worker.policyVersion,
      capacityJournal: input.capacityJournal, pricedContinuations: workers });
    const worker = new ProductionWorkerBridge({ resolver, workers: input.workers, workerJournal: input.workerJournal,
      jobJournal: input.jobJournal, requestJournal: input.requestJournal, artifactStore: input.artifactStore, jobRouter: input.jobRouter,
      toolchainSha256: input.config.worker.toolchainSha256, publication: { server: input.config.publication.uploadServer } });
    const restores = new ProductionPricedContinuationRestores({ pool: input.pool, acceptance, preparer, workers,
      checkpoint: input.checkpoint, jobJournal: input.jobJournal, worker });
    const finalizer = new ProductionPricedContinuationFinalizer({ pool: input.pool, acceptance, restores, gateway: input.gateway,
      journal: input.vertexJournal, worker });
    const cleanup = new ProductionPricedContinuationCleanup({ pool: input.pool, acceptance, capacity: input.capacity,
      workerJournal: input.workerJournal, journal: input.jobJournal });
    const runner = new ProductionPricedContinuationRunner({ pool: input.pool, acceptance, preparer, workers, restores,
      generation: input.generation, finalizer, cleanup });
    await runner.assertReady();
    return new ProductionPricedContinuationService({ quotes, preparer, acceptance, workers, worker, restores, finalizer, cleanup, runner });
  }

  prepare(input: unknown) { return this.preparer.prepare(input); }
  resume(input: unknown) { return this.runner.run(input); }
}
