import { createMountedReleaseCleanup } from "./release-cleanup";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import type { ReleaseProviderId } from "../release/contracts";
import type { AuthoritativeUsageRecoveryPort } from "../release/controller";
import { validateAuthorizationReceipt, validateAuthorizationReceiptIntegrity, validateAuthorizationRequest } from "../release/authorization";
import type { ReleaseProviderPort } from "../release/providers";
import { RELEASE_PRODUCTION_PROVIDER_IDS } from "../release/native-registry";
import { createNativeCloudRunProvider } from "../release/native/cloud-run";
import { createNativeCloudSqlPostgresProvider } from "../release/native/cloud-sql-postgres";
import { createNativeGcsProvider } from "../release/native/gcs";
import { createNativeCollectorProvider } from "../release/native/collector";
import { createProductionWorkerLifecycle, type ProductionWorkerLifecyclePort } from "./worker-lifecycle";
import { createNativeCep8LightningProvider } from "../release/native/cep8-lightning";
import { createNativeCashuProvider } from "../release/native/cashu";
import { CompatibleHostBrowserObservationPort } from "../release/native/compatible-host";
import { ExternalSignerBoundaryAdapter } from "../release/native/external-signer";
import { createProductionPublicationUpload } from "./publication-upload";
import { createProductionPublicationRelays } from "./publication-relays";
import { createNativePromotedNappletCliSource } from "../release/native/promoted-cli";
import { createContextVmDeploymentClient, openContextVmCertificationClient } from "../release/deployment/contextvm-client";
import { createPaymentDeploymentClients } from "../release/deployment/payment-clients";
import { createVertexDeploymentClient } from "../release/deployment/vertex-client";
import { createCompatibleHostDeploymentClient } from "../release/deployment/compatible-host-client";
import { createNip46DeploymentClient } from "../release/deployment/nip46-signer-client";
import { createCliUploadDeploymentClients } from "../release/deployment/cli-upload-clients";
import { createRelayDeploymentClients } from "../release/deployment/relay-clients";
import { createGooglePrivateControlIdentity, ProductionCoreControlClient } from "../release/deployment/production-core-control";
import { createProductionCoreSuiteAdapters } from "../release/deployment/production-core-suite-adapters";
import type { ProductionCertificationSessionMaterial, ProductionSessionAuthorizationMaterial } from "../release/deployment/production-session-material";
import type { ProductionConcreteClients } from "../release/deployment/production-session-runtime";
import type { ProductionGenerationRuntime } from "./generation-runtime";
import type { ProductionConfig } from "./config";
import { createMountedGoogleControls, type MountedGoogleControlConfiguration } from "./mounted-google-controls";
import { createMountedProductionEdgeMaterial } from "./mounted-edge-material";
import { createHash } from "node:crypto";
import { createMountedWorkerReadinessCommands } from "./mounted-worker-clients";
import { createPostgresWorkerOperationJournal } from "../release/deployment/postgres-provider-journals";
import type { MountedProductionSecretMaterial } from "./secret-material";
import { loadMountedProductionSessionRecord, type MountedProductionSessionRecord } from "./mounted-session-record";
import { ProductionChromiumCompatibleHost, ProductionCompatibleHostPackage } from "./chromium-host";
import { openProductionNip46Signer } from "./nip46-signer";
import { createProductionCliUploadPort } from "./cli-upload";
import { createProductionNostrRelayPort } from "./nostr-relay";
import { ProductionEdgeContexts } from "./edge-contexts";
import { ProductionPublicationContextMaterializer } from "./publication-context";
import { createProductionPublicationOperations } from "./publication-operations";
import { materializeProtectedCertifier } from "../release/materialize-certifier";
import { PostgresReleasePromotion } from "./release-promotion";
import { productionReleaseScope } from "./release-verification-authority";
import { canonicalJson } from "../promotion/schema";
import { createMountedProductionSourceBuildVerifier } from "./source-build-verifier";
import { assertMountedSourceBuildPlan } from "./source-build-plan";
import { ProductionDirectPublicationFactory } from "./direct-publication-factory";
import { createGoogleAdcTokenSource } from "../release/deployment/google-auth";
import { createProductionGcsObjectClient } from "./gcs-object-client";
import { GcsObjectStoreAdapter } from "../continuity/object-store";
import { PostgresOperationJournal } from "../release/deployment/postgres-operation-journal";
import { createPostgresGoogleOperationJournal } from "../release/deployment/postgres-provider-journals";
import { createMountedBigQueryUsageReporter } from "./mounted-authoritative-billing";
import { openProductionPostgresPool } from "./postgres";

/** Immutable JSON-only controller facts. Runtime ports are constructed below
 * from these facts and the already-opened production authorities. */
export type MountedProductionSessionReferences = MountedProductionSessionRecord & Readonly<{
  gcsProvisionObject: Uint8Array;
}>;

type ReceiptBoundNative = Readonly<{
  plan(input: Readonly<{ request: unknown; receipt: unknown; operationId: string; region?: string }>): Promise<unknown>;
  apply(input: Readonly<{ request: unknown; receipt: unknown; operationId: string; region?: string }>): Promise<unknown>;
  observe(input: Readonly<{ request: unknown; receipt: unknown; operationId: string; region?: string }>): Promise<unknown>;
  cleanup(input: Readonly<{ request: unknown; receipt: unknown; operationId: string; region?: string }>): Promise<unknown>;
}>;

function status(value: unknown, allowed: readonly string[], fallback: string): string {
  if (!value || typeof value !== "object") return fallback;
  const result = (value as Record<string, unknown>).status;
  return typeof result === "string" && allowed.includes(result) ? result : fallback;
}

/** Convert the four receipt-bound native control-plane implementations to the
 * provider-neutral release port. The native object remains the sole place
 * where authorization is revalidated immediately before a provider effect. */
export function createReceiptBoundReleaseProviderPort(input: Readonly<{
  native: ReceiptBoundNative;
  authorization: ProductionSessionAuthorizationMaterial;
  discovery: MountedProductionSessionReferences["discoveries"][ReleaseProviderId];
  quote: MountedProductionSessionReferences["quotes"][ReleaseProviderId];
  /** Native cleanup mandates a controller-bound resource name. The bridge
   * supplies it from parsed configuration; a registry command never can. */
  cleanup?: (input: Readonly<{ operationId: string; region?: string }>) => Promise<unknown>;
  observeCleanup?: (input: Readonly<{ operationId: string }>) => Promise<unknown>;
}>): ReleaseProviderPort {
  const exactCost = (value: unknown, code: string) => {
    if (!Number.isSafeInteger(value) || (value as number) < 0) throw new Error(code);
    return value as number;
  };
  /** Quotes bound authorization ceilings; they are never provider usage
   * receipts.  These control planes expose no invoice/usage observation at
   * this layer, so progression stays explicitly unknown until the controller
   * records one.  Returning a quote as `actualCostMicros` would falsely settle
   * money and permit a later cleanup to erase the evidence gap. */
  /* A mutation/LRO acknowledgement is not service readiness.  The next
   * controller attempt queries this same original operation and may advance
   * only from that authoritative completed observation. */
  const awaitingOriginalObservation = () => ({ status: "unknown" as const });
  const exactDiscovery = () => {
    const value = input.discovery;
    if (!value || !/^[a-f0-9]{64}$/iu.test(value.accountScopeSha256) || !/^[a-f0-9]{64}$/iu.test(value.costEstimateSha256)
      || !Array.isArray(value.secretReferenceNames)) throw new Error("PRODUCTION_PROVIDER_DISCOVERY_REQUIRED");
    return value;
  };
  const identity = (value: unknown): string | undefined => {
    if (!value || typeof value !== "object") return undefined;
    const record = value as Record<string, unknown>;
    for (const key of ["resourceIdentitySha256", "revisionSha256", "endpointReferenceSha256"] as const) {
      if (typeof record[key] === "string" && /^[a-f0-9]{64}$/iu.test(record[key])) return record[key];
    }
    return undefined;
  };
  const call = (method: keyof ReceiptBoundNative, operationId: string, region?: string) => input.native[method]({ request: input.authorization.request, receipt: input.authorization.receipt, operationId, ...(region ? { region } : {}) });
  return Object.freeze({
    async discoverCapabilities() { const value = exactDiscovery(); return { capability: value.capability, accountScopeSha256: value.accountScopeSha256, costEstimateSha256: value.costEstimateSha256, secretReferenceNames: [...value.secretReferenceNames] }; },
    async discoverAuthentication() { const value = exactDiscovery(); return { authentication: value.authentication, accountScopeSha256: value.accountScopeSha256, costEstimateSha256: value.costEstimateSha256, secretReferenceNames: [...value.secretReferenceNames] }; },
    async plan(value) {
      const result = await call("plan", value.operationId, value.region);
      if (status(result, ["planned"], "invalid") !== "planned") throw new Error("PRODUCTION_NATIVE_PLAN_INVALID");
      return { status: "planned" as const, estimatedCostMicros: exactCost(input.quote.estimatedCostMicros, "PRODUCTION_PROVIDER_ESTIMATE_REQUIRED") };
    },
    async apply(value) {
      const result = await call("apply", value.operationId, value.region);
      const state = status(result, ["applied", "completed", "unknown", "blocked"], "invalid");
      if (state === "invalid") throw new Error("PRODUCTION_NATIVE_APPLY_INVALID");
      if (state === "blocked") return { status: "blocked" as const };
      return { ...awaitingOriginalObservation(), ...(identity(result) ? { resourceIdentitySha256: identity(result) } : {}) };
    },
    async observe(value) {
      const result = await call("observe", value.operationId);
      const state = status(result, ["completed", "pending", "unknown", "missing", "blocked"], "invalid");
      if (state === "invalid") throw new Error("PRODUCTION_NATIVE_OBSERVATION_INVALID");
      if (state === "blocked") return { status: "blocked" as const };
      if (state === "completed") return { status: "completed" as const, ...(identity(result) ? { resourceIdentitySha256: identity(result) } : {}) };
      return { status: state as "pending" | "unknown" | "missing", ...(identity(result) ? { resourceIdentitySha256: identity(result) } : {}) };
    },
    async observeCleanup(value) {
      if (!input.observeCleanup) return { status: "unknown" as const };
      const result = await input.observeCleanup({ operationId: value.operationId });
      const state = status(result, ["cleaned", "missing", "pending", "unknown", "blocked"], "invalid");
      if (state === "invalid") throw new Error("PRODUCTION_NATIVE_CLEANUP_OBSERVATION_INVALID");
      return { status: state as "cleaned" | "missing" | "pending" | "unknown" | "blocked" };
    },
    async cleanup(value) {
      const result = input.cleanup
        ? await input.cleanup({ operationId: value.operationId })
        : await call("cleanup", value.operationId);
      const state = status(result, ["cleaned", "pending", "blocked"], "invalid");
      if (state === "invalid") throw new Error("PRODUCTION_NATIVE_CLEANUP_INVALID");
      return { status: state as "cleaned" | "pending" | "blocked" };
    },
  });
}

function bridgeGcs(input: Readonly<{
  native: Readonly<{
    plan(input: Readonly<{ request: unknown; receipt: unknown; operationId: string }>): Promise<unknown>;
    createObject(input: Readonly<{ request: unknown; receipt: unknown; operationId: string; bytes: Uint8Array }>): Promise<Readonly<{ key: string; generation: number; checksum: string }>>;
    observe(input: Readonly<{ request: unknown; receipt: unknown; operationId: string }>): Promise<unknown>;
    cleanup(input: Readonly<{ request: unknown; receipt: unknown; operationId: string; runOwnedNamespace: string; objects: readonly Readonly<{ key: string; generation: number; checksum: string }>[] }>): Promise<unknown>;
    objectStore: Readonly<{ observeExactByKey(input: Readonly<{ key: string; checksum: string }>): Promise<Readonly<{ key: string; generation: number; checksum: string }> | undefined> }>;
  }>;
  authorization: ProductionSessionAuthorizationMaterial;
  discovery: MountedProductionSessionReferences["discoveries"]["gcs"];
  quote: MountedProductionSessionReferences["quotes"]["gcs"];
  object: Uint8Array;
  runOwnedNamespace: string;
}>): ReleaseProviderPort {
  const discovery = () => {
    const value = input.discovery;
    if (!value || !/^[a-f0-9]{64}$/iu.test(value.accountScopeSha256) || !/^[a-f0-9]{64}$/iu.test(value.costEstimateSha256)) throw new Error("PRODUCTION_PROVIDER_DISCOVERY_REQUIRED");
    return value;
  };
  const original = (operationId: string) => ({ request: input.authorization.request, receipt: input.authorization.receipt, operationId });
  return Object.freeze({
    async discoverCapabilities() { const value = discovery(); return { capability: value.capability, accountScopeSha256: value.accountScopeSha256, costEstimateSha256: value.costEstimateSha256, secretReferenceNames: [...value.secretReferenceNames] }; },
    async discoverAuthentication() { const value = discovery(); return { authentication: value.authentication, accountScopeSha256: value.accountScopeSha256, costEstimateSha256: value.costEstimateSha256, secretReferenceNames: [...value.secretReferenceNames] }; },
    async plan(value) {
      const result = await input.native.plan(original(value.operationId));
      if (status(result, ["planned"], "invalid") !== "planned") throw new Error("PRODUCTION_NATIVE_PLAN_INVALID");
      if (!Number.isSafeInteger(input.quote.estimatedCostMicros) || input.quote.estimatedCostMicros < 0) throw new Error("PRODUCTION_PROVIDER_ESTIMATE_REQUIRED");
      return { status: "planned" as const, estimatedCostMicros: input.quote.estimatedCostMicros };
    },
    async apply(value) {
      const object = await input.native.createObject({ ...original(value.operationId), bytes: new Uint8Array(input.object) });
      /* An object-create acknowledgement is not the separate exact-object
       * observation required to advance the release state. */
      return { status: "unknown" as const, resourceIdentitySha256: object.checksum };
    },
    async observe(value) {
      const result = await input.native.observe(original(value.operationId));
      const state = status(result, ["completed", "pending", "unknown", "missing", "blocked"], "invalid");
      if (state === "invalid") throw new Error("PRODUCTION_NATIVE_OBSERVATION_INVALID");
      const checksum = Array.from(new Uint8Array(await crypto.subtle.digest("SHA-256", input.object as BufferSource)), byte => byte.toString(16).padStart(2, "0")).join("");
      const object = await input.native.objectStore.observeExactByKey({ key: `${input.runOwnedNamespace}${checksum}`, checksum });
      if (state === "blocked") return { status: "blocked" as const, ...(object ? { resourceIdentitySha256: object.checksum } : {}) };
      if (!object) return { status: "missing" as const };
      return { status: state as "completed" | "pending" | "unknown" | "missing", resourceIdentitySha256: object.checksum };
    },
    async cleanup(value) {
      const checksum = Array.from(new Uint8Array(await crypto.subtle.digest("SHA-256", input.object as BufferSource)), byte => byte.toString(16).padStart(2, "0")).join("");
      const object = await input.native.objectStore.observeExactByKey({ key: `${input.runOwnedNamespace}${checksum}`, checksum });
      if (!object) throw new Error("PRODUCTION_GCS_ORIGINAL_OBJECT_REQUIRED");
      const result = await input.native.cleanup({ ...original(value.operationId), runOwnedNamespace: input.runOwnedNamespace, objects: [object] });
      const state = status(result, ["cleaned", "pending", "blocked"], "invalid");
      if (state === "invalid") throw new Error("PRODUCTION_NATIVE_CLEANUP_INVALID");
      return { status: state as "cleaned" | "pending" | "blocked" };
    },
  });
}

/** Modal/Fly already implement the generic readiness lifecycle. Replace only
 * their fixture-era discovery/cost projection with controller observations and
 * measured quotes; native status and resource identity remain authoritative. */
function createMeasuredWorkerProviderPort(input: Readonly<{
  native: ProductionWorkerLifecyclePort;
  discovery: MountedProductionSessionReferences["discoveries"][ReleaseProviderId];
  quote: MountedProductionSessionReferences["quotes"][ReleaseProviderId];
}>): ReleaseProviderPort {
  const observed = () => {
    const value = input.discovery;
    if (!value || !/^[a-f0-9]{64}$/iu.test(value.accountScopeSha256) || !/^[a-f0-9]{64}$/iu.test(value.costEstimateSha256)
      || !Array.isArray(value.secretReferenceNames)) throw new Error("PRODUCTION_PROVIDER_DISCOVERY_REQUIRED");
    return value;
  };
  const exactCost = (value: unknown, code: string) => {
    if (!Number.isSafeInteger(value) || (value as number) < 0) throw new Error(code);
    return value as number;
  };
  return Object.freeze({
    async discoverCapabilities() { const value = observed(); return { capability: value.capability, accountScopeSha256: value.accountScopeSha256, costEstimateSha256: value.costEstimateSha256, secretReferenceNames: [...value.secretReferenceNames] }; },
    async discoverAuthentication() { const value = observed(); return { authentication: value.authentication, accountScopeSha256: value.accountScopeSha256, costEstimateSha256: value.costEstimateSha256, secretReferenceNames: [...value.secretReferenceNames] }; },
    async plan(value) {
      const result = await input.native.plan(value);
      if (result.status !== "planned") throw new Error("PRODUCTION_NATIVE_PLAN_INVALID");
      return { status: "planned" as const, estimatedCostMicros: exactCost(input.quote.estimatedCostMicros, "PRODUCTION_PROVIDER_ESTIMATE_REQUIRED") };
    },
    async apply(value) {
      const result = await input.native.apply(value);
      if (result.status === "blocked") return { status: "blocked" as const };
      return { status: "unknown" as const, ...(result.resourceIdentitySha256 ? { resourceIdentitySha256: result.resourceIdentitySha256 } : result.resourceIdentity ? { resourceIdentity: result.resourceIdentity } : {}) };
    },
    async observe(value) {
      const result = await input.native.observe(value);
      return { status: result.status, ...(result.resourceIdentitySha256 ? { resourceIdentitySha256: result.resourceIdentitySha256 } : result.resourceIdentity ? { resourceIdentity: result.resourceIdentity } : {}) };
    },
    async cleanup(value) {
      const result = await input.native.cleanup(value);
      if (!(["cleaned", "pending", "blocked"] as const).includes(result.status)) throw new Error("PRODUCTION_NATIVE_CLEANUP_INVALID");
      return { status: result.status };
    },
  });
}

/**
 * Several provider families are exercised only through one of the exact
 * protected suites (payment, signing, host, publication, or source supply).
 * They cannot safely be coerced into a generic create/update operation: those
 * calls require a persisted original operation with a suite-specific payload.
 * This is still a concrete port in the sixteen-provider inventory: discovery
 * is from the controller's observation record. Its generic lifecycle tracks
 * that already-existing capability/readiness resource; it never substitutes
 * a create/update request for a suite-specific signed/published/payment call.
 */
export function createProtectedSuiteProviderPort(input: Readonly<{
  provider: ReleaseProviderId;
  discovery: MountedProductionSessionReferences["discoveries"][ReleaseProviderId];
  quote: MountedProductionSessionReferences["quotes"][ReleaseProviderId];
}>): ReleaseProviderPort {
  const observed = () => {
    const value = input.discovery;
    if (!value || !/^[a-f0-9]{64}$/iu.test(value.accountScopeSha256) || !/^[a-f0-9]{64}$/iu.test(value.costEstimateSha256)
      || !/^[a-f0-9]{64}$/iu.test(value.resourceIdentitySha256) || !Array.isArray(value.secretReferenceNames)) throw new Error("PRODUCTION_PROVIDER_DISCOVERY_REQUIRED");
    return value;
  };
  const exactCost = (value: unknown, code: string) => {
    if (!Number.isSafeInteger(value) || (value as number) < 0) throw new Error(code);
    return value as number;
  };
  const readiness = () => {
    const value = observed();
    if (value.capability === "available" && value.authentication === "authorized") return "completed" as const;
    if (value.capability === "unsupported" || value.authentication === "not_configured") return "blocked" as const;
    return "unknown" as const;
  };
  return Object.freeze({
    async discoverCapabilities() { const value = observed(); return { capability: value.capability, accountScopeSha256: value.accountScopeSha256, costEstimateSha256: value.costEstimateSha256, secretReferenceNames: [...value.secretReferenceNames] }; },
    async discoverAuthentication() { const value = observed(); return { authentication: value.authentication, accountScopeSha256: value.accountScopeSha256, costEstimateSha256: value.costEstimateSha256, secretReferenceNames: [...value.secretReferenceNames] }; },
    async plan() { observed(); return { status: "planned" as const, estimatedCostMicros: exactCost(input.quote.estimatedCostMicros, "PRODUCTION_PROVIDER_ESTIMATE_REQUIRED") }; },
    async apply() {
      const value = observed(); const state = readiness();
      return { status: state === "blocked" ? "blocked" as const : "unknown" as const, resourceIdentitySha256: value.resourceIdentitySha256 };
    },
    async observe() {
      const value = observed();
      return { status: readiness() === "blocked" ? "blocked" as const : "unknown" as const, resourceIdentitySha256: value.resourceIdentitySha256 };
    },
    async cleanup() {
      /* These are configured/readiness resources, not resources created by
       * this generic port. The protected suite owns any compensating effect. */
      observed();
      throw new Error("PRODUCTION_PROVIDER_ACTUAL_COST_UNOBSERVED");
    },
  });
}

function descriptor(port: ReleaseProviderPort, brokerReference: string) {
  return Object.freeze({ origin: "project-owned" as const, evidenceClass: "real" as const, brokerReference, port });
}

/** Assemble the controller's receipt-bound execution inputs from the measured
 * immutable record. All byte-bearing evidence and source data is revalidated
 * by the existing materializer/finalizer; this code supplies neither an
 * observation nor a success result. */
async function prepareMountedOperationalExecution(input: Readonly<{
  config: ProductionConfig;
  deploymentConfig: ProductionCertificationSessionMaterial["deploymentConfig"];
  resolved: MountedProductionSessionReferences;
  authorization: ProductionSessionAuthorizationMaterial;
  dependencies: ProductionGenerationRuntime["dependencies"];
  providers: ProductionCertificationSessionMaterial["providers"];
  workerLifecycles: Readonly<Record<"modal" | "fly", ProductionWorkerLifecyclePort>>;
  billingReports?: import("../release/controller").AuthoritativeUsageReportPort;
  now?: () => number;
}>) {
  const execution = input.resolved.execution;
  const request = await validateAuthorizationRequest(input.authorization.request);
  const receipt = await validateAuthorizationReceipt({ request, receipt: input.authorization.receipt, nowMs: (input.now ?? Date.now)() });
  if (request.candidateSha256 !== input.config.candidateSha256 || request.topologySha256 !== input.config.topologySha256
    || receipt.candidateSha256 !== input.config.candidateSha256 || receipt.topologySha256 !== input.config.topologySha256
    || input.deploymentConfig.sourceRevision !== execution.materialization.source.sourceRevision
    || execution.workerSelection.candidateSha256 !== input.config.candidateSha256 || execution.workerSelection.topologySha256 !== input.config.topologySha256
    || execution.workerSelection.provider !== input.resolved.workerCandidate.provider
    || execution.workerSelection.expiresAtMs <= (input.now ?? Date.now)()
    || execution.protected.input.topologySha256 !== input.config.topologySha256
    || execution.protected.topology.candidateSha256 !== input.config.candidateSha256 || execution.protected.topology.topologySha256 !== input.config.topologySha256
    || execution.protected.sourceBuild.candidateSha256 !== input.config.candidateSha256 || execution.protected.sourceBuild.topologySha256 !== input.config.topologySha256
    || execution.protected.sourceBuild.image !== input.resolved.workerCandidate.image || execution.protected.sourceBuild.sourceSha256 !== input.resolved.workerCandidate.sourceSha256
    || canonicalJson(execution.materialization.releaseManifest) !== canonicalJson(execution.finalization.trust.releaseManifest)
    || execution.finalization.trust.repositoryRoot !== execution.materialization.repositoryRoot
    || execution.finalization.trust.sourceArchive.sourceRevision !== execution.materialization.source.sourceRevision
    || execution.finalization.trust.sourceArchive.sourceSha256 !== execution.materialization.source.sourceSha256) {
    throw new Error("PRODUCTION_MOUNTED_PREPARATION_BINDING_REQUIRED");
  }
  const topology = Object.freeze({ candidateSha256: input.config.candidateSha256, topologySha256: input.config.topologySha256 });
  const collectorConfig = await readFile(join(execution.materialization.repositoryRoot, "infra/otel/collector.yaml"));
  const collectorConfigSha256 = new Bun.CryptoHasher("sha256").update(collectorConfig).digest("hex");
  if (collectorConfigSha256 !== execution.protected.collector.configSha256.toLowerCase()) {
    throw new Error("PRODUCTION_MOUNTED_COLLECTOR_CONFIG_DRIFT");
  }
  const materialization = Object.freeze({
    workspace: execution.materialization.workspace,
    repositoryRoot: execution.materialization.repositoryRoot,
    candidateId: input.config.candidateSha256,
    releaseManifest: execution.materialization.releaseManifest,
    topology,
    authorization: Object.freeze({ authorizationReceiptSha256: receipt.authorizationReceiptSha256, authorizationRequestSha256: request.authorizationRequestSha256 }),
    source: execution.materialization.source,
    secretReferences: execution.materialization.secretReferences,
  });
  /* This is local content-addressed construction, not provider work. It
   * produces the exact material the controller will independently verify/use
   * before it invokes a protected suite. */
  const materialized = await materializeProtectedCertifier({ ...materialization, workerSelection: execution.workerSelection, nowMs: input.now?.() });
  const promotion = new PostgresReleasePromotion({
    pool: input.dependencies.pool,
    deploymentScopeSha256: productionReleaseScope(input.config),
    binding: Object.freeze({ candidateId: input.config.candidateSha256, topologySha256: input.config.topologySha256, authorizationReceiptSha256: receipt.authorizationReceiptSha256 }),
    expectedPreviousBundleSha256: execution.finalization.expectedPreviousBundleSha256,
    authorization: input.authorization,
    now: input.now,
  });
  return Object.freeze({
    materialization,
    workerSelection: execution.workerSelection,
    protected: Object.freeze({
      candidate: input.resolved.workerCandidate,
      input: execution.protected.input,
      topology: execution.protected.topology,
      collector: Object.freeze({ ...execution.protected.collector, imageReference: input.resolved.serverControls.telemetry.deployment.imageReference }),
      releaseBinding: execution.protected.releaseBinding,
    }),
    protectedVerificationReferences: execution.protected.protectedVerificationReferences,
    ...(input.billingReports ? { billingReports: input.billingReports } : {}),
    finalization: Object.freeze({
      trust: Object.freeze({ materialized, workspace: execution.materialization.workspace, repositoryRoot: execution.finalization.trust.repositoryRoot, releaseManifest: execution.finalization.trust.releaseManifest, sourceArchive: execution.finalization.trust.sourceArchive, reproducibilityRecord: execution.finalization.trust.reproducibilityRecord, supplyChainRecord: execution.finalization.trust.supplyChainRecord }),
      verificationRecords: execution.finalization.verificationRecords,
      sourceMeasurement: execution.finalization.sourceMeasurement,
      selectedWorker: Object.freeze({ provider: execution.workerSelection.provider, selectionEvidenceSha256: execution.workerSelection.selectionEvidenceSha256 }),
      receipts: execution.finalization.receipts,
      attestations: execution.finalization.attestations,
      cleanupPlan: Object.freeze({ ...execution.finalization.cleanupPlan, effects: execution.finalization.cleanupPlan.effects.map(({ provider: _provider, ...effect }) => Object.freeze(effect)) }),
      promotion,
      cleanup: createMountedReleaseCleanup({ effects: execution.finalization.cleanupPlan.effects, providers: input.providers, workers: input.workerLifecycles }),
    }),
  });
}

/**
 * The sole materializer for the normal mounted path. It creates every native
 * provider family from validated production config, the already-opened real
 * runtime, and controller-resolved references. Missing live observations are
 * explicit construction failures or blocked ports; this factory never makes
 * up endpoint names, hashes, costs, or authority records.
 */
export async function createMountedProductionSessionMaterial(input: Readonly<{
  config: ProductionConfig;
  deploymentConfig?: ProductionCertificationSessionMaterial["deploymentConfig"];
  generation: ProductionGenerationRuntime;
  resolved: MountedProductionSessionReferences;
  /** Secret-mounted signer material is transformed into narrow, branded
   * brokers here.  No certification client, worker SDK, or callback is
   * accepted from the session record. */
  secrets: MountedProductionSecretMaterial;
  now?: () => number;
}>): Promise<ProductionCertificationSessionMaterial> {
  if (input.config.realm !== "production-real"
    || input.generation.config.realm !== "production-real"
    || input.generation.config.candidateSha256 !== input.config.candidateSha256
    || input.generation.config.topologySha256 !== input.config.topologySha256
    || input.resolved.workerCandidate.id !== input.config.candidateSha256) throw new Error("PRODUCTION_MOUNTED_SESSION_BINDING_REQUIRED");
  const { dependencies } = input.generation;
  const now = input.now;
  const authorization = input.generation.authorization;
  const edgeMaterial = await createMountedProductionEdgeMaterial({ config: input.config, secrets: input.secrets });
  // Persist the mounted service attestation identity before any relay signing.
  // Recovery trusts this controller-derived authority, never a pubkey claimed
  // by an archived attestation observation.
  const attestationAuthority = Object.freeze({ schemaVersion: "mounted-attestation-signer-v1" as const, publicKey: edgeMaterial.attestationSigner.publicKey });
  await dependencies.requestJournal.claim("attestation-signer-authority", createHash("sha256").update(canonicalJson(attestationAuthority)).digest("hex"), attestationAuthority);
  input.generation.registerClose(async () => edgeMaterial.attestationSigner.close());
  /* The certification client is opened from the fixed relay, mounted
   * disposable signer, canonical authorization pair, and durable runtime
   * journal.  A serialized session record cannot substitute a callback bag
   * for this signed ContextVM boundary. */
  const contextvmCertification = await openContextVmCertificationClient({
    certificationKeyReference: input.config.certification.clientKeyReference,
    serverPubkey: input.config.certification.serverPubkey,
    relays: [input.config.contextvm.relay],
    signerBroker: edgeMaterial.certificationSignerBroker,
    journal: dependencies.journal,
    candidateSha256: input.config.candidateSha256,
    topologySha256: input.config.topologySha256,
    authorizationRequest: authorization.request,
    authorizationReceipt: authorization.receipt,
    now,
  });
  input.generation.registerClose(() => contextvmCertification.close());
  const control = new ProductionCoreControlClient({ serviceUrl: input.config.operator.privateControlAudience, candidateSha256: input.config.candidateSha256, topologySha256: input.config.topologySha256, request: authorization.request, receipt: authorization.receipt, journal: dependencies.journal, identity: createGooglePrivateControlIdentity(input.config.operator.serviceAccount) });
  const coreSuites = createProductionCoreSuiteAdapters({ candidate: input.resolved.workerCandidate, control, contextvm: contextvmCertification });
  /* The mount-record parser guarantees JSON-only data; the Google factory
   * re-parses this exact controller shape before it creates ADC clients. */
  const mountedGoogle = createMountedGoogleControls({ config: input.config, generation: input.generation, configuration: input.resolved.googleControls as MountedGoogleControlConfiguration, telemetry: coreSuites.telemetry, now });
  const { google } = mountedGoogle;
  const cloudRun = createNativeCloudRunProvider({ config: input.resolved.providerConfigurations.cloud_run, port: mountedGoogle.cloudRun, now });
  const cloudSql = createNativeCloudSqlPostgresProvider({ config: input.resolved.providerConfigurations.cloud_sql_postgres, port: mountedGoogle.cloudSql, now });
  const gcs = createNativeGcsProvider({ config: input.resolved.providerConfigurations.gcs, port: mountedGoogle.gcs, now });
  const collector = createNativeCollectorProvider({ config: input.resolved.providerConfigurations.collector, port: mountedGoogle.collector, now });
  const modal = createProductionWorkerLifecycle({ provider: "modal", capacity: dependencies.certificationCapacities.modal, journal: dependencies.journal, authorization, estimatedCostMicros: input.resolved.quotes.modal.estimatedCostMicros, now });
  const fly = createProductionWorkerLifecycle({ provider: "fly", capacity: dependencies.certificationCapacities.fly, journal: dependencies.journal, authorization, estimatedCostMicros: input.resolved.quotes.fly.estimatedCostMicros, now });
  const rails = input.generation.funding.core.rails;
  if (!rails) throw new Error("PRODUCTION_MOUNTED_PAYMENT_RAILS_REQUIRED");
  const sourceBuild = createMountedProductionSourceBuildVerifier({
    config: input.config,
    record: input.resolved,
    authorization: input.generation.authorization,
    dependencies,
    now,
  });
  const sourcePlan = assertMountedSourceBuildPlan(input.resolved.execution.protected.sourceBuild.plan, {
    candidateSha256: input.config.candidateSha256,
    topologySha256: input.config.topologySha256,
    provider: input.resolved.workerCandidate.provider,
    publication: { server: input.config.publication.uploadServer },
  });
  const publicationMaterializer = new ProductionPublicationContextMaterializer({
    candidateSha256: input.config.candidateSha256,
    topologySha256: input.config.topologySha256,
    ownerPubkey: input.resolved.edge.ownerPubkey,
    policyVersion: input.config.worker.policyVersion,
    toolchainIdentity: input.config.worker.toolchainSha256,
    compatibleHostReference: input.resolved.descriptorReferences.compatibleHostReference,
    compatibleHostSha256: input.resolved.edge.compatibleHost.hostSha256,
    sourcePlan,
    authorization: input.generation.authorization,
    journal: dependencies.journal,
    sourceJournal: dependencies.jobJournal,
    artifactStore: dependencies.artifactStore,
    relaySet: input.resolved.edge.relays,
    uploadServers: [input.resolved.edge.uploadServer],
    now,
  });
  const edgeContexts = new ProductionEdgeContexts({ journal: dependencies.journal, artifactStore: dependencies.artifactStore, candidateSha256: input.config.candidateSha256, topologySha256: input.config.topologySha256, authorizationRequestSha256: authorization.authorizationRequestSha256 });
  const host = {
    packageHost: new ProductionCompatibleHostPackage(input.resolved.edge.compatibleHost),
    browser: new ProductionChromiumCompatibleHost(input.resolved.edge.compatibleHost),
  };
  const signerPort = await openProductionNip46Signer({
    bunkerUri: edgeMaterial.bunkerUri,
    sessionKeyReference: input.config.publication.signerSessionKeyReference,
    sessionKeyBroker: edgeMaterial.nip46SessionKeyBroker,
    context: edgeContexts.signer,
    originalOperationContext: edgeContexts.signer,
    journal: dependencies.journal,
    authorization,
    now,
  });
  input.generation.registerClose(() => signerPort.close());
  const uploadPort = await createProductionCliUploadPort({
    server: input.resolved.edge.uploadServer,
    targetReference: input.config.publication.uploadTargetReference,
    ownerPubkey: input.resolved.edge.ownerPubkey,
    journal: dependencies.journal,
  });
  const relayPort = createProductionNostrRelayPort({ relays: input.resolved.edge.relays, journal: dependencies.journal });
  const cep8 = createNativeCep8LightningProvider({ config: input.resolved.providerConfigurations.cep8_lightning, ...rails.lightning });
  const cashu = createNativeCashuProvider({ config: input.resolved.providerConfigurations.cashu, ...rails.cashu });
  const compatibleHost = new CompatibleHostBrowserObservationPort(host);
  const ownerEventVerifier = publicationMaterializer.ownerEventVerifier;
  const signer = new ExternalSignerBoundaryAdapter({ signer: signerPort, ownerEventVerifier });
  const upload = createProductionPublicationUpload({ materializer: publicationMaterializer, authorization, targetReference: input.config.publication.uploadTargetReference, port: uploadPort, now });
  const relays = createProductionPublicationRelays({ materializer: publicationMaterializer, attestationSigner: edgeMaterial.attestationSigner, authorization,
    journal: dependencies.journal, port: relayPort, relaySetReference: input.resolved.descriptorReferences.contextvmRelaySetReference,
    relaySetSha256: input.resolved.descriptorReferences.contextvmRelaySetSha256, now });
  const promotedCli = createNativePromotedNappletCliSource({ snapshot: edgeMaterial.promotedCliSnapshot, upload, relay: relays.asPromotedCliSource() });
  void cep8; void cashu; void compatibleHost; void signer; void promotedCli;

  const publicationContext = createProductionPublicationOperations({ materializer: publicationMaterializer, context: edgeContexts.publicationWithSigner(signerPort), source: promotedCli, upload });
  const directPublication = input.config.worker.artifactContract === "nip5d-direct-v1" ? new ProductionDirectPublicationFactory({
    settings: { artifactContract: "nip5d-direct-v1", candidateSha256: input.config.candidateSha256, topologySha256: input.config.topologySha256,
      ownerPubkey: input.config.publication.ownerPubkey, toolchainSha256: input.config.worker.toolchainSha256, policyVersion: input.config.worker.policyVersion,
      server: input.config.publication.uploadServer, relays: input.config.publication.relays, targetReference: input.config.publication.uploadTargetReference,
      sessionKeyReference: input.config.publication.signerSessionKeyReference },
    intents: dependencies.directPublicationIntents, artifacts: dependencies.ownedDirectArtifacts,
    // Ordinary original publication records must survive topology/receipt
    // changes. Never substitute the current-topology certification journal.
    journals: { signer: dependencies.requestJournal, upload: dependencies.requestJournal, relay: dependencies.requestJournal },
    material: edgeMaterial, authorization, now,
  }) : undefined;
  if (directPublication) input.generation.registerClose(() => directPublication.close());
  const clients: ProductionConcreteClients = Object.freeze({
    google,
    workers: dependencies.workers,
    contextvm: createContextVmDeploymentClient({ serviceKeyReference: input.config.contextvm.serviceKeyReference, relaySetReference: input.resolved.descriptorReferences.contextvmRelaySetReference, relaySetSha256: input.resolved.descriptorReferences.contextvmRelaySetSha256 }),
    contextvmCertification,
    vertex: dependencies.vertex,
    descriptors: Object.freeze({
      payments: createPaymentDeploymentClients({ nwcConnectionReference: input.config.funding.nwcConnectionReference, cashuWalletReference: input.config.funding.cashuConsentReference }),
      compatibleHost: createCompatibleHostDeploymentClient({ referenceHostReference: input.resolved.descriptorReferences.compatibleHostReference, chromiumReference: input.resolved.descriptorReferences.chromiumReference, packageHost: host.packageHost, browser: host.browser }),
      signer: createNip46DeploymentClient({ disposableClientKeyReference: input.config.publication.signerSessionKeyReference, signer: signerPort, ownerEventVerifier }),
      publication: createCliUploadDeploymentClients({ promotedCliSourceReference: input.config.publication.cliSourceReference, promotedCliSourceSha256: input.config.worker.toolchainSha256, uploadTargetReference: input.config.publication.uploadTargetReference }),
      relays: createRelayDeploymentClients({ ownerKeyReference: input.resolved.descriptorReferences.ownerKeyReference, attestationKeyReference: input.resolved.descriptorReferences.attestationKeyReference, relaySetReference: input.resolved.descriptorReferences.contextvmRelaySetReference, relaySetSha256: input.resolved.descriptorReferences.contextvmRelaySetSha256 }),
    }),
    edge: Object.freeze({ compatibleHost, signer, cep8, cashu, promotedCli, relays }),
    publicationContext,
    ...(directPublication ? { directPublication, ...(input.resolved.edge.directPublicationReference ? { directPublicationReference: input.resolved.edge.directPublicationReference } : {}) } : {}),
    paymentScenarioContext: edgeContexts.payments,
    sourceBuild,
  });
  const providerPorts: Partial<Record<ReleaseProviderId, ReleaseProviderPort>> = {
    cloud_run: createReceiptBoundReleaseProviderPort({ native: cloudRun as ReceiptBoundNative, authorization, discovery: input.resolved.discoveries.cloud_run, quote: input.resolved.quotes.cloud_run, observeCleanup: ({ operationId }) => cloudRun.observeCleanup({ request: authorization.request, receipt: authorization.receipt, operationId, region: input.resolved.cleanupScopes.cloudRunRegion, runOwnedServiceName: input.resolved.cleanupScopes.cloudRunServiceName }), cleanup: ({ operationId }) => cloudRun.cleanup({ request: authorization.request, receipt: authorization.receipt, operationId, region: input.resolved.cleanupScopes.cloudRunRegion, runOwnedServiceName: input.resolved.cleanupScopes.cloudRunServiceName }) }),
    cloud_sql_postgres: createReceiptBoundReleaseProviderPort({ native: cloudSql as ReceiptBoundNative, authorization, discovery: input.resolved.discoveries.cloud_sql_postgres, quote: input.resolved.quotes.cloud_sql_postgres, observeCleanup: ({ operationId }) => cloudSql.observeCleanup({ request: authorization.request, receipt: authorization.receipt, operationId, runOwnedInstanceId: input.resolved.cleanupScopes.cloudSqlInstanceId }), cleanup: ({ operationId }) => cloudSql.cleanup({ request: authorization.request, receipt: authorization.receipt, operationId, runOwnedInstanceId: input.resolved.cleanupScopes.cloudSqlInstanceId }) }),
    gcs: bridgeGcs({ native: gcs, authorization, discovery: input.resolved.discoveries.gcs, quote: input.resolved.quotes.gcs, object: input.resolved.gcsProvisionObject, runOwnedNamespace: input.resolved.cleanupScopes.gcsRunOwnedNamespace }),
    collector: createReceiptBoundReleaseProviderPort({ native: collector as ReceiptBoundNative, authorization, discovery: input.resolved.discoveries.collector, quote: input.resolved.quotes.collector, observeCleanup: ({ operationId }) => collector.observeCleanup({ request: authorization.request, receipt: authorization.receipt, operationId, runOwnedEndpointReference: input.resolved.cleanupScopes.collectorEndpointReference }), cleanup: ({ operationId }) => collector.cleanup({ request: authorization.request, receipt: authorization.receipt, operationId, runOwnedEndpointReference: input.resolved.cleanupScopes.collectorEndpointReference }) }),
    modal: createMeasuredWorkerProviderPort({ native: modal, discovery: input.resolved.discoveries.modal, quote: input.resolved.quotes.modal }),
    fly: createMeasuredWorkerProviderPort({ native: fly, discovery: input.resolved.discoveries.fly, quote: input.resolved.quotes.fly }),
    contextvm: createProtectedSuiteProviderPort({ provider: "contextvm", discovery: input.resolved.discoveries.contextvm, quote: input.resolved.quotes.contextvm }),
    cep8_lightning: createProtectedSuiteProviderPort({ provider: "cep8_lightning", discovery: input.resolved.discoveries.cep8_lightning, quote: input.resolved.quotes.cep8_lightning }),
    cashu: createProtectedSuiteProviderPort({ provider: "cashu", discovery: input.resolved.discoveries.cashu, quote: input.resolved.quotes.cashu }),
    model: createProtectedSuiteProviderPort({ provider: "model", discovery: input.resolved.discoveries.model, quote: input.resolved.quotes.model }),
    compatible_host: createProtectedSuiteProviderPort({ provider: "compatible_host", discovery: input.resolved.discoveries.compatible_host, quote: input.resolved.quotes.compatible_host }),
    signer: createProtectedSuiteProviderPort({ provider: "signer", discovery: input.resolved.discoveries.signer, quote: input.resolved.quotes.signer }),
    promoted_cli: createProtectedSuiteProviderPort({ provider: "promoted_cli", discovery: input.resolved.discoveries.promoted_cli, quote: input.resolved.quotes.promoted_cli }),
    upload: createProtectedSuiteProviderPort({ provider: "upload", discovery: input.resolved.discoveries.upload, quote: input.resolved.quotes.upload }),
    owner_relay: createProtectedSuiteProviderPort({ provider: "owner_relay", discovery: input.resolved.discoveries.owner_relay, quote: input.resolved.quotes.owner_relay }),
    attestation_relay: createProtectedSuiteProviderPort({ provider: "attestation_relay", discovery: input.resolved.discoveries.attestation_relay, quote: input.resolved.quotes.attestation_relay }),
  };
  const missingPorts = RELEASE_PRODUCTION_PROVIDER_IDS.filter(id => !providerPorts[id]);
  if (missingPorts.length > 0) throw new Error(`PRODUCTION_NATIVE_PROVIDER_BRIDGE_REQUIRED:${missingPorts.join(",")}`);
  const providers = Object.freeze(Object.fromEntries(RELEASE_PRODUCTION_PROVIDER_IDS.map(id => [id, descriptor(providerPorts[id]!, `native:${id}:${input.config.topologySha256}`)])) as ProductionCertificationSessionMaterial["providers"]);
  if (!input.deploymentConfig || input.deploymentConfig.candidateSha256 !== input.config.candidateSha256) throw new Error("PRODUCTION_MOUNTED_SESSION_DEPLOYMENT_CONFIG_REQUIRED");
  const deploymentConfig = input.deploymentConfig;
  return Object.freeze({
    realm: "production-real", deploymentConfig, journal: dependencies.journal, clients, providers,
    workerCandidate: input.resolved.workerCandidate, control, checkpointCoordinator: dependencies.checkpointCoordinator,
    prepare: async ({ authorizationRequest, receipt }) => {
      const [requested, supplied] = await Promise.all([
        validateAuthorizationRequest(authorizationRequest),
        validateAuthorizationRequest(authorization.request),
      ]);
      const [requestedReceipt, suppliedReceipt] = await Promise.all([
        validateAuthorizationReceipt({ request: requested, receipt, nowMs: now?.() ?? Date.now() }),
        validateAuthorizationReceipt({ request: supplied, receipt: authorization.receipt, nowMs: now?.() ?? Date.now() }),
      ]);
      if (requested.authorizationRequestSha256 !== supplied.authorizationRequestSha256
        || requestedReceipt.authorizationReceiptSha256 !== suppliedReceipt.authorizationReceiptSha256) {
        throw new Error("PRODUCTION_MOUNTED_PREPARATION_AUTHORIZATION_REQUIRED");
      }
      return prepareMountedOperationalExecution({ config: input.config, deploymentConfig, resolved: input.resolved, authorization, dependencies, providers, workerLifecycles: { modal, fly }, ...(mountedGoogle.billingReports ? { billingReports: mountedGoogle.billingReports } : {}), now });
    },
  });
}

/** Named export consumed by the hash-pinned production-execution loader. It
 * can only use controller-installed material and independently compares the
 * canonical mounted receipt pair before opening the broker graph. */
export async function createProductionCertificationSessionMaterial(input: Readonly<{
  config: ProductionConfig;
  deploymentConfig: ProductionCertificationSessionMaterial["deploymentConfig"];
  generation: ProductionGenerationRuntime;
  authorization: ProductionSessionAuthorizationMaterial;
  secrets: MountedProductionSecretMaterial;
  /** Constructed by the mounted controller bootstrap, never process-global
   * mutable state. It contains branded project clients and original-operation
   * ports; a JSON deployment file cannot manufacture this graph. */
  resolved?: MountedProductionSessionReferences;
}>): Promise<ProductionCertificationSessionMaterial> {
  const resolved = input.resolved ?? await loadMountedProductionSessionRecord({ config: input.config, secrets: input.secrets });
  let mountedRequest: Awaited<ReturnType<typeof validateAuthorizationRequest>>;
  let suppliedRequest: Awaited<ReturnType<typeof validateAuthorizationRequest>>;
  let mountedReceipt: Awaited<ReturnType<typeof validateAuthorizationReceipt>>;
  let suppliedReceipt: Awaited<ReturnType<typeof validateAuthorizationReceipt>>;
  try {
    [mountedRequest, suppliedRequest] = await Promise.all([
      validateAuthorizationRequest(input.generation.authorization.request),
      validateAuthorizationRequest(input.authorization.request),
    ]);
    [mountedReceipt, suppliedReceipt] = await Promise.all([
      validateAuthorizationReceipt({ request: mountedRequest, receipt: input.generation.authorization.receipt, nowMs: Date.now() }),
      validateAuthorizationReceipt({ request: suppliedRequest, receipt: input.authorization.receipt, nowMs: Date.now() }),
    ]);
  } catch {
    throw new Error("PRODUCTION_MOUNTED_SESSION_AUTHORIZATION_BINDING_REQUIRED");
  }
  if (mountedRequest.authorizationRequestSha256 !== suppliedRequest.authorizationRequestSha256
    || mountedReceipt.authorizationReceiptSha256 !== suppliedReceipt.authorizationReceiptSha256
    || input.deploymentConfig.candidateSha256 !== input.config.candidateSha256) {
    throw new Error("PRODUCTION_MOUNTED_SESSION_AUTHORIZATION_BINDING_REQUIRED");
  }
  return createMountedProductionSessionMaterial({ config: input.config, deploymentConfig: input.deploymentConfig, generation: input.generation, resolved, secrets: input.secrets });
}

/**
 * Build only the report-only recovery capability from immutable mounted facts.
 * Unlike the normal session materializer this must not open relay, worker,
 * funding, signer, model, publication, or mutation clients. The normal
 * receipt's expiry is deliberately irrelevant here: the receipt is verified
 * for cryptographic integrity while the separately signed billing-observation
 * interval remains the sole clock-bound permission.
 */
export async function createProductionAuthoritativeUsageRecovery(input: Readonly<{
  config: ProductionConfig;
  deploymentConfig: ProductionCertificationSessionMaterial["deploymentConfig"];
  authorizationRequest: unknown;
  secrets: MountedProductionSecretMaterial;
}>): Promise<Readonly<{ receipt: unknown; reporter: import("../release/controller").AuthoritativeUsageRecoveryPort; close: () => Promise<void> }>> {
  const [resolved, suppliedRequest, mountedRequestRaw, mountedReceiptRaw] = await Promise.all([
    loadMountedProductionSessionRecord({ config: input.config, secrets: input.secrets }),
    validateAuthorizationRequest(input.authorizationRequest),
    input.secrets.text("certification.authorizationRequestReference", 1_000_000),
    input.secrets.text("certification.authorizationReceiptReference", 1_000_000),
  ]);
  let mountedRequest: unknown;
  let mountedReceipt: unknown;
  try {
    mountedRequest = JSON.parse(mountedRequestRaw);
    mountedReceipt = JSON.parse(mountedReceiptRaw);
  } catch { throw new Error("PRODUCTION_USAGE_RECOVERY_AUTHORIZATION_INVALID"); }
  let integrity: Awaited<ReturnType<typeof validateAuthorizationReceiptIntegrity>>;
  try { integrity = await validateAuthorizationReceiptIntegrity({ request: mountedRequest, receipt: mountedReceipt }); }
  catch { throw new Error("PRODUCTION_USAGE_RECOVERY_AUTHORIZATION_INVALID"); }
  if (integrity.request.authorizationRequestSha256 !== suppliedRequest.authorizationRequestSha256
    || integrity.request.candidateSha256 !== input.config.candidateSha256
    || integrity.request.topologySha256 !== input.config.topologySha256
    || input.deploymentConfig.candidateSha256 !== input.config.candidateSha256
    || !integrity.request.billingObservation
    || Date.now() >= integrity.request.billingObservation.expiresAtMs) {
    throw new Error("PRODUCTION_USAGE_RECOVERY_AUTHORIZATION_INVALID");
  }
  const accountScopeSha256 = resolved.discoveries.cloud_run.accountScopeSha256;
  if (resolved.discoveries.cloud_sql_postgres.accountScopeSha256 !== accountScopeSha256) {
    throw new Error("PRODUCTION_USAGE_RECOVERY_ACCOUNT_SCOPE_REQUIRED");
  }
  const google: MountedGoogleControlConfiguration = Object.freeze({
    ...(resolved.googleControls as Omit<MountedGoogleControlConfiguration, "accountScopeSha256">),
    accountScopeSha256,
  });
  if (!google.authoritativeUsage) throw new Error("PRODUCTION_USAGE_RECOVERY_REPORTER_REQUIRED");
  /* Preparing the narrowly-scoped capability is deliberately no-effect.  In
   * particular, a controller must be able to load its already-pinned mounted
   * material without opening Cloud SQL before it has selected a completed
   * original operation.  The reporter opens its authority lazily on the one
   * sealed `recover` operation below; that operation still reads the original
   * journal before it can obtain ADC or contact BigQuery/GCS. */
  let postgres: Awaited<ReturnType<typeof openProductionPostgresPool>> | undefined;
  let reporter: AuthoritativeUsageRecoveryPort | undefined;
  let reporterPromise: Promise<AuthoritativeUsageRecoveryPort> | undefined;
  const recoveryReporter = () => {
    if (reporter) return reporter;
    if (reporterPromise) return reporterPromise;
    reporterPromise = (async () => {
    postgres = await openProductionPostgresPool(input.config, input.secrets);
    try {
    const tokenSource = createGoogleAdcTokenSource({
      projectId: input.config.projectId,
      quotaProjectId: input.config.projectId,
      principal: input.config.operator.serviceAccount,
      accountScopeSha256: google.accountScopeSha256,
    });
    const objects = new GcsObjectStoreAdapter({
      config: { bucket: input.config.gcs.bucket, projectId: input.config.projectId },
      client: createProductionGcsObjectClient({ bucket: input.config.gcs.bucket, tokenSource }),
    });
    const dispatchReporter = createMountedBigQueryUsageReporter({
      configuration: google.authoritativeUsage,
      projectId: input.config.projectId,
      quotaProjectId: input.config.projectId,
      principal: input.config.operator.serviceAccount,
      accountScopeSha256: google.accountScopeSha256,
      tokenSource,
      googleJournal: createPostgresGoogleOperationJournal(new PostgresOperationJournal(postgres.pool, { namespace: "production-google-control", scopeSha256: input.config.topologySha256 })),
      billingJournal: new PostgresOperationJournal(postgres.pool, { namespace: "production-authoritative-usage", scopeSha256: input.config.topologySha256 }),
      pool: postgres.pool,
      objects,
      bucket: input.config.gcs.bucket,
    });
    /* Do not return the dispatch-capable reporter. This sealed wrapper omits
     * `capture` entirely and fixes recovery mode internally, so no caller that
     * receives this factory result can create a grant or issue jobs.insert. */
    reporter = Object.freeze({
      recover: async (value: Parameters<AuthoritativeUsageRecoveryPort["recover"]>[0]) => dispatchReporter.capture({ ...value, mode: "recovery" }),
      readArtifact: dispatchReporter.readArtifact,
    });
    return reporter;
    } catch (error) {
      await postgres.close().catch(() => undefined);
      postgres = undefined;
      reporterPromise = undefined;
      throw error;
    }
    })();
    return reporterPromise;
  };
  return Object.freeze({
    receipt: mountedReceipt,
    reporter: Object.freeze({
      recover: async (value: Parameters<AuthoritativeUsageRecoveryPort["recover"]>[0]) => (await recoveryReporter()).recover(value),
      readArtifact: async (value: Parameters<AuthoritativeUsageRecoveryPort["readArtifact"]>[0]) => (await recoveryReporter()).readArtifact(value),
    }),
    close: async () => {
      const current = postgres;
      postgres = undefined;
      reporter = undefined;
      await current?.close();
    },
  });
}
