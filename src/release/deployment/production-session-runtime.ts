import { DirectPublicationReferenceSchema } from "../../certification/live/direct-publication-contract";
import type { z } from "zod";
import type { ReleaseProviderId } from "../contracts";
import type { ReleaseProviderPort } from "../providers";
import { RELEASE_PRODUCTION_PROVIDER_IDS } from "../native-registry";
import { WorkerCandidateSchema, type WorkerCandidate } from "../../certification/contracts";
import {
  PRODUCTION_LIVE_PROTECTED_PORT_KEYS,
  type ProductionLiveProtectedCertificationPorts,
} from "../../certification/live/production-ports";
import { assertPostgresOperationJournal, type PostgresOperationJournal } from "./postgres-operation-journal";
import { createProductionEdgeSuiteAdapters, type ProductionEdgeSuiteAdapters } from "./production-edge-suite-adapters";
import { assertProductionCoreControlClient, type ProductionCoreControlClient } from "./production-core-control";
import type { createGoogleDeploymentClients } from "./google-clients";
import type { createWorkerDeploymentClients } from "./worker-clients";
import type { createContextVmDeploymentClient, ContextVmCertificationClient } from "./contextvm-client";
import type { createPaymentDeploymentClients } from "./payment-clients";
import type { createVertexDeploymentClient } from "./vertex-client";
import type { createCompatibleHostDeploymentClient } from "./compatible-host-client";
import type { createNip46DeploymentClient } from "./nip46-signer-client";
import type { createCliUploadDeploymentClients } from "./cli-upload-clients";
import type { createRelayDeploymentClients } from "./relay-clients";
import type { CompatibleHostBrowserObservationPort } from "../native/compatible-host";
import type { ExternalSignerBoundaryAdapter } from "../native/external-signer";
import type { NativeCep8LightningProvider } from "../native/cep8-lightning";
import type { NativeCashuProvider } from "../native/cashu";
import type { NativePromotedCliSource } from "../native/promoted-cli";
import type { NostrRelayPublicationAdapter } from "../native/nostr-relay";
import type { createOpenAiResponsesClient } from "./openai-responses-client";
import type { PublicationIntent, SealedArtifactIdentity } from "../../publication/contracts";
import type { PreSignedNamedDeployFile, StructuredSourceEffect } from "../../publication/napplet-cli-adapter";
import { ProductionDirectPublicationFactory } from "../../production/direct-publication-factory";
import {
  composeProductionProtectedPorts,
  type ProductionSessionRuntime,
} from "./production-session";
import { createProductionCoreSuiteAdapters } from "./production-core-suite-adapters";
import type { DeploymentExecutionConfig } from "./config";
import { PRODUCTION_FACTORY_SECRET_REFERENCE_NAMES } from "./production-factory";
import { observeUploadedCollectorRegistryImage, readPreparedCollectorOci } from "../collector-image";
import { validateAuthorizationReceipt, validateAuthorizationRequest, type ReleaseAuthorizationRequest } from "../authorization";

type ProviderDescriptor = Readonly<{
  origin: "project-owned";
  evidenceClass: "real";
  brokerReference: string;
  port: ReleaseProviderPort;
}>;

export type ProductionEffectCounters = Readonly<{
  discoverCapabilities: number;
  discoverAuthentication: number;
  plan: number;
  apply: number;
  observe: number;
  cleanup: number;
  suites: number;
}>;

/** A source-build verifier is a sealed deployment component, never shell text
 * supplied by a certification request. Plan 69's edge service owns its exact
 * command contract and validates it before use. */
export type ProductionSourceBuildVerifier = Readonly<{
  authority: "production-real";
  verify(input: unknown): Promise<unknown>;
}>;

/** Durable controller facts for a sealed artifact and exact owner intent.
 * Private control payloads carry hashes only; they cannot manufacture the
 * files, relay set, or signature intent that publication changes. */
export type ProductionPublicationContext = Readonly<{
  resolve(input: Readonly<{ candidateSha256: string; sealedArtifactSha256: string; aggregateSha256: string }>): Promise<Readonly<{
    artifact: SealedArtifactIdentity;
    intent: PublicationIntent;
    requiredSignerCapabilities: readonly string[];
    relaySet: readonly string[];
  }>>;
  /** Exact sealed bytes/target are read from the controller's durable artifact
   * record only after the hash-only private command has been bound above. */
  deploy(input: Readonly<{ candidateSha256: string; sealedArtifactSha256: string; aggregateSha256: string; operationId: string }>): Promise<Readonly<{
    target: Readonly<{ kind: 35129; dTag: string }>;
    files: readonly PreSignedNamedDeployFile[];
    servers: readonly string[];
    authorizeExactHashes(hashes: readonly string[]): Promise<unknown>;
  }>>;
}>;

export type ProductionPublicationOperations = ProductionPublicationContext & Readonly<{
  source(): Promise<Readonly<{ status: "passed"; candidateId: string; sealedArtifactSha256: string; aggregateSha256: string; promotedCliSourceVerified: true; promotedCliAssetVerified: true }>>;
  original(input: Parameters<ProductionPublicationContext["resolve"]>[0]): ReturnType<ProductionPublicationContext["resolve"]>;
  observeUpload(input: Readonly<{ intentId: string; operationId: string }>): Promise<StructuredSourceEffect>;
}>;

/** CEP-8/Cashu exercise data is similarly read by original operation from the
 * controller's durable ledger. This capability deliberately exposes neither
 * a wallet secret nor a free-form token/receipt input to the control route. */
export type ProductionPaymentScenarioContext = Readonly<{
  resolve(input: Readonly<{ candidateSha256: string; operationId: string }>): Promise<Readonly<{
    lightning: unknown;
    cashu: unknown;
  }>>;
}>;

export type ProductionConcreteClients = Readonly<{
  google: ReturnType<typeof createGoogleDeploymentClients>;
  workers: ReturnType<typeof createWorkerDeploymentClients>;
  contextvm: ReturnType<typeof createContextVmDeploymentClient>;
  contextvmCertification: ContextVmCertificationClient;
  vertex: ReturnType<typeof createVertexDeploymentClient>;
  /** Reference-only deployment descriptors remain available to release
   * planning, while edge effects use these native operational adapters. */
  descriptors: Readonly<{
    payments: ReturnType<typeof createPaymentDeploymentClients>;
    compatibleHost: ReturnType<typeof createCompatibleHostDeploymentClient>;
    signer: ReturnType<typeof createNip46DeploymentClient>;
    publication: ReturnType<typeof createCliUploadDeploymentClients>;
    relays: ReturnType<typeof createRelayDeploymentClients>;
  }>;
  edge: Readonly<{
    compatibleHost: CompatibleHostBrowserObservationPort;
    signer: ExternalSignerBoundaryAdapter;
    cep8: NativeCep8LightningProvider;
    cashu: NativeCashuProvider;
    promotedCli: NativePromotedCliSource;
    relays: NostrRelayPublicationAdapter;
    /** Successor-only native path. It is absent while the v4 controller
     * authority remains held; callers must never fall back to Vertex. */
    openAiResponses?: Readonly<{
      provenance: Readonly<{ module: "src/release/deployment/openai-responses-client.ts"; export: "createOpenAiResponsesClient"; purpose: "openai-responses"; journalNamespace: "openai:responses"; rateQuoteSha256: string }>;
      client: ReturnType<typeof createOpenAiResponsesClient>;
    }>;
  }>;
  publicationContext: ProductionPublicationOperations;
  /** Additive concrete direct graph; selection/promotion gates remain separate. */
  directPublication?: ProductionDirectPublicationFactory;
  directPublicationReference?: z.infer<typeof DirectPublicationReferenceSchema>;
  paymentScenarioContext: ProductionPaymentScenarioContext;
  sourceBuild: ProductionSourceBuildVerifier;
}>;

export type ProductionSessionBroker = Readonly<{
  realm: "production-real";
  candidateSha256: string;
  topologySha256: string;
  journal: PostgresOperationJournal;
  /** Named actual clients let protected edge handlers use only official
   * transport implementations and prevent a generic port bag from becoming
   * an alternate deployment API. */
  clients: ProductionConcreteClients;
  providers: Readonly<Record<ReleaseProviderId, ProviderDescriptor>>;
  /** Candidate selected from the measured identical Modal/Fly cohorts. Core
   * ports are constructed below from it and branded control clients; callers
   * never inject core observation callbacks. */
  workerCandidate: WorkerCandidate;
  control: ProductionCoreControlClient;
  prepare: ProductionSessionRuntime["prepare"];
  now?: () => number;
}>;

const brokers = new WeakSet<object>();
let installed: ProductionSessionBroker | undefined;

function hasExactKeys(value: unknown, keys: readonly string[]): value is Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const actual = Object.keys(value);
  return actual.length === keys.length && actual.every(key => keys.includes(key));
}

function digest(value: unknown): value is string {
  return typeof value === "string" && /^[a-f0-9]{64}$/u.test(value);
}

function assertProviderDescriptor(value: unknown): asserts value is ProviderDescriptor {
  if (!value || typeof value !== "object") throw new Error("PRODUCTION_SESSION_BROKER_PROVIDER_REQUIRED");
  const descriptor = value as Partial<ProviderDescriptor>;
  if (descriptor.origin !== "project-owned" || descriptor.evidenceClass !== "real"
    || typeof descriptor.brokerReference !== "string" || !/^[a-z][a-z0-9:._/-]{2,255}$/iu.test(descriptor.brokerReference)
    || !descriptor.port || typeof descriptor.port !== "object") throw new Error("PRODUCTION_SESSION_BROKER_PROVIDER_REQUIRED");
  for (const method of ["discoverCapabilities", "discoverAuthentication", "plan", "apply", "observe", "cleanup"] as const) {
    if (typeof descriptor.port[method] !== "function") throw new Error("PRODUCTION_SESSION_BROKER_PROVIDER_REQUIRED");
  }
}

function assertConcreteClients(value: unknown): asserts value is ProductionConcreteClients {
  if (!value || typeof value !== "object") throw new Error("PRODUCTION_SESSION_BROKER_CLIENTS_REQUIRED");
  const clients = value as Partial<ProductionConcreteClients>;
  if (clients.directPublication !== undefined && !(clients.directPublication instanceof ProductionDirectPublicationFactory)) throw new Error("PRODUCTION_SESSION_DIRECT_PUBLICATION_FACTORY_REQUIRED");
  if (clients.directPublicationReference !== undefined) { DirectPublicationReferenceSchema.parse(clients.directPublicationReference); if (!clients.directPublication) throw new Error("PRODUCTION_SESSION_DIRECT_PUBLICATION_FACTORY_REQUIRED"); }
  for (const key of ["google", "workers", "contextvm", "vertex", "descriptors", "edge"] as const) {
    if (!clients[key] || typeof clients[key] !== "object") throw new Error("PRODUCTION_SESSION_BROKER_CLIENTS_REQUIRED");
  }
  for (const key of ["compatibleHost", "signer", "cep8", "cashu", "promotedCli", "relays"] as const) {
    if (!clients.edge![key] || typeof clients.edge![key] !== "object") throw new Error("PRODUCTION_SESSION_BROKER_CLIENTS_REQUIRED");
  }
  if (!clients.publicationContext || typeof clients.publicationContext.resolve !== "function" || typeof clients.publicationContext.deploy !== "function"
    || typeof clients.publicationContext.source !== "function" || typeof clients.publicationContext.original !== "function" || typeof clients.publicationContext.observeUpload !== "function"
    || !clients.paymentScenarioContext || typeof clients.paymentScenarioContext.resolve !== "function") {
    throw new Error("PRODUCTION_SESSION_BROKER_CLIENTS_REQUIRED");
  }
  if (!clients.contextvmCertification || typeof clients.contextvmCertification !== "object"
    || !clients.sourceBuild || clients.sourceBuild.authority !== "production-real" || typeof clients.sourceBuild.verify !== "function") {
    throw new Error("PRODUCTION_SESSION_BROKER_CLIENTS_REQUIRED");
  }
}

/** The deployment assembly, after it has constructed the official Google,
 * worker, ContextVM/NWC/Cashu, Vertex, host, signer, CLI, and relay adapters,
 * seals their exact provider ports here. Dynamic certifier code cannot forge
 * this capability from JSON, environment variables, or a lookalike object. */
export function sealProductionSessionBroker(input: ProductionSessionBroker): ProductionSessionBroker {
  if (!input || input.realm !== "production-real" || !digest(input.candidateSha256) || !digest(input.topologySha256)
    || !hasExactKeys(input.providers, RELEASE_PRODUCTION_PROVIDER_IDS)
    || typeof input.prepare !== "function") throw new Error("PRODUCTION_SESSION_BROKER_REQUIRED");
  assertPostgresOperationJournal(input.journal);
  assertConcreteClients(input.clients);
  const workerCandidate = WorkerCandidateSchema.parse(input.workerCandidate);
  if (workerCandidate.id !== input.candidateSha256) throw new Error("PRODUCTION_SESSION_BROKER_CANDIDATE_REQUIRED");
  assertProductionCoreControlClient(input.control);
  if (input.control.binding.candidateSha256 !== input.candidateSha256 || input.control.binding.topologySha256 !== input.topologySha256) {
    throw new Error("PRODUCTION_SESSION_BROKER_BINDING_REQUIRED");
  }
  for (const id of RELEASE_PRODUCTION_PROVIDER_IDS) assertProviderDescriptor(input.providers[id]);
  const sealed = Object.freeze({ ...input, workerCandidate, providers: Object.freeze({ ...input.providers }) });
  brokers.add(sealed);
  return sealed;
}

/** Normal deployment composition entrypoint. The materialized deployment
 * config contributes only its candidate-bound, opaque locator set; the
 * concrete clients must already have been made by the project-owned broker.
 * This makes a user-authored JSON object incapable of supplying a runtime,
 * while keeping setup I/O out of construction. */
export function createProductionSessionBroker(input: Readonly<{
  deploymentConfig: DeploymentExecutionConfig;
  topologySha256: string;
  journal: PostgresOperationJournal;
  clients: ProductionConcreteClients;
  providers: Readonly<Record<ReleaseProviderId, ProviderDescriptor>>;
  workerCandidate: WorkerCandidate;
  control: ProductionCoreControlClient;
  prepare: ProductionSessionRuntime["prepare"];
  now?: () => number;
}>): ProductionSessionBroker {
  const actualReferences = Object.keys(input.deploymentConfig.secretReferences).sort();
  const requiredReferences = [...PRODUCTION_FACTORY_SECRET_REFERENCE_NAMES].sort();
  if (actualReferences.length !== requiredReferences.length || actualReferences.some((name, index) => name !== requiredReferences[index])) {
    throw new Error("PRODUCTION_SESSION_SECRET_REFERENCE_SET_REQUIRED");
  }
  const candidate = WorkerCandidateSchema.parse(input.workerCandidate);
  if (candidate.id !== input.deploymentConfig.candidateSha256 || !digest(input.topologySha256)) {
    throw new Error("PRODUCTION_SESSION_DEPLOYMENT_BINDING_REQUIRED");
  }
  return sealProductionSessionBroker({
    realm: "production-real",
    candidateSha256: input.deploymentConfig.candidateSha256,
    topologySha256: input.topologySha256.toLowerCase(),
    journal: input.journal,
    clients: input.clients,
    providers: input.providers,
    workerCandidate: candidate,
    control: input.control,
    prepare: input.prepare,
    now: input.now,
  });
}

export function assertProductionSessionBroker(value: unknown): asserts value is ProductionSessionBroker {
  if (!value || typeof value !== "object" || !brokers.has(value)) throw new Error("PRODUCTION_SESSION_BROKER_REQUIRED");
}

function instrument(port: ReleaseProviderPort, counters: { -readonly [K in keyof ProductionEffectCounters]: number }): ReleaseProviderPort {
  const wrapped = Object.fromEntries(([
    "discoverCapabilities", "discoverAuthentication", "plan", "apply", "observe", "cleanup",
  ] as const).map(method => [method, async (...args: unknown[]) => {
    counters[method] += 1;
    return (port[method] as (...values: unknown[]) => unknown)(...args);
  }]));
  return Object.freeze(wrapped) as ReleaseProviderPort;
}

function instrumentSuite<T extends object>(port: T, counters: { -readonly [K in keyof ProductionEffectCounters]: number }): T {
  return new Proxy(port, {
    get(target, property, receiver) {
      const value = Reflect.get(target, property, receiver);
      if (typeof value !== "function") return value;
      return (...args: unknown[]) => {
        counters.suites += 1;
        return value.apply(target, args);
      };
    },
  });
}

/** Assembles the exact sixteen-provider/eight-suite execution graph without
 * discovery or provider calls. Counters are live instrumentation, not a
 * static readiness claim, and begin at zero until an operational method runs. */
export function assembleProductionSessionRuntime(input: Readonly<{
  broker: unknown;
  receipt: unknown;
}>): Readonly<{ runtime: ProductionSessionRuntime; effects: ProductionEffectCounters; edge: ProductionEdgeSuiteAdapters }> {
  assertProductionSessionBroker(input.broker);
  if (input.receipt === undefined || input.receipt === null) throw new Error("PRODUCTION_SESSION_RECEIPT_REQUIRED");
  const broker = input.broker;
  /* This factory is also called directly by deployment composition, so do not
   * rely solely on its caller's receipt validation. An installed broker from
   * another candidate or topology is never a valid operational authority. */
  const receipt = input.receipt as Partial<Readonly<{ candidateSha256: unknown; topologySha256: unknown }>>;
  if (receipt.candidateSha256 !== broker.candidateSha256 || receipt.topologySha256 !== broker.topologySha256) {
    throw new Error("PRODUCTION_SESSION_RECEIPT_BINDING_REQUIRED");
  }
  const counters: { -readonly [K in keyof ProductionEffectCounters]: number } = {
    discoverCapabilities: 0, discoverAuthentication: 0, plan: 0, apply: 0, observe: 0, cleanup: 0, suites: 0,
  };
  const core = createProductionCoreSuiteAdapters({ candidate: broker.workerCandidate, control: broker.control, contextvm: broker.clients.contextvmCertification });
  const edge = createProductionEdgeSuiteAdapters({ candidateId: broker.candidateSha256, control: broker.control, ...(broker.clients.directPublication ? { artifactContract: "nip5d-direct-v1", directPublicationReference: broker.clients.directPublicationReference } : {}) });
  const rawProtectedPorts = composeProductionProtectedPorts({ core, edge });
  if (!hasExactKeys(rawProtectedPorts, PRODUCTION_LIVE_PROTECTED_PORT_KEYS)) throw new Error("PRODUCTION_SESSION_PROTECTED_PORT_SET_REQUIRED");
  const protectedPorts = Object.freeze(Object.fromEntries(PRODUCTION_LIVE_PROTECTED_PORT_KEYS.map(key => [
    key,
    instrumentSuite(rawProtectedPorts[key], counters),
  ])) as ProductionLiveProtectedCertificationPorts);
  const providers = Object.freeze(Object.fromEntries(RELEASE_PRODUCTION_PROVIDER_IDS.map(id => {
    const descriptor = broker.providers[id];
    return [id, Object.freeze({ ...descriptor, port: instrument(descriptor.port, counters) })];
  })) as Record<ReleaseProviderId, ProviderDescriptor>);
  const collectorImage = Object.freeze({
    async uploadAndObserve(value: Readonly<{ authorizationRequest: ReleaseAuthorizationRequest; collector: Parameters<typeof readPreparedCollectorOci>[0] }>) {
      const request = await validateAuthorizationRequest(value.authorizationRequest);
      const nowMs = (broker.now ?? Date.now)();
      const receipt = await validateAuthorizationReceipt({ request, receipt: input.receipt, nowMs });
      if (!request.providerScopes.some(scope => scope.provider === "collector") || !request.orderedEffects.some(effect => effect.provider === "collector" && effect.operation === "configure")) throw new Error("COLLECTOR_UPLOAD_EFFECT_SCOPE_REQUIRED");
      if (receipt.authorizationRequestSha256 !== request.authorizationRequestSha256) throw new Error("COLLECTOR_UPLOAD_AUTHORIZATION_BINDING_REQUIRED");
      const operationId = `collector-${new Bun.CryptoHasher("sha256").update(request.authorizationRequestSha256).digest("hex").slice(0, 40)}`;
      const uploaded = await broker.clients.google.collector.uploadOciImage({ operationId, image: await readPreparedCollectorOci(value.collector), expiresAtMs: receipt.expiresAtMs });
      if (uploaded.status !== "completed") throw new Error("COLLECTOR_UPLOAD_RECONCILIATION_REQUIRED");
      return observeUploadedCollectorRegistryImage(value.collector, broker.clients.google.collector);
    },
  });
  const runtime = Object.freeze({ receipt: input.receipt, journal: broker.journal, providers, protectedPorts, collectorImage, prepare: broker.prepare, now: broker.now });
  /* Freeze the public snapshot, not its private backing store. The getters
   * expose measured invocation counts throughout the session without giving a
   * caller a writable counter or a way to reset evidence. */
  const effects: ProductionEffectCounters = Object.freeze({
    get discoverCapabilities() { return counters.discoverCapabilities; },
    get discoverAuthentication() { return counters.discoverAuthentication; },
    get plan() { return counters.plan; },
    get apply() { return counters.apply; },
    get observe() { return counters.observe; },
    get cleanup() { return counters.cleanup; },
    get suites() { return counters.suites; },
  });
  return Object.freeze({ runtime, effects, edge });
}

/** Bootstrap-only installation. It accepts a runtime capability only after
 * production deployment assembly sealed it; ordinary CLI callers cannot pass
 * user-authored config, credentials, or provider callbacks into the factory. */
export function installProductionSessionBroker(value: unknown): void {
  assertProductionSessionBroker(value);
  if (installed && installed !== value) throw new Error("PRODUCTION_SESSION_BROKER_ALREADY_INSTALLED");
  installed = value;
}

export function assembleInstalledProductionSessionRuntime(receipt: unknown): Readonly<{ runtime: ProductionSessionRuntime; effects: ProductionEffectCounters; edge: ProductionEdgeSuiteAdapters }> {
  if (!installed) throw new Error("PRODUCTION_SESSION_BROKER_UNAVAILABLE");
  return assembleProductionSessionRuntime({ broker: installed, receipt });
}
