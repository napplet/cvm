import { expect, test } from "bun:test";
import { readFile } from "node:fs/promises";
import {
  createProductionCertificationSessionMaterial,
  createProtectedSuiteProviderPort,
  createReceiptBoundReleaseProviderPort,
} from "../../src/production/mounted-session-material";
import { openMountedProductionSession } from "../../src/production/runtime";

const source = new URL("../../src/production/mounted-session-material.ts", import.meta.url);
const runtime = new URL("../../src/production/runtime.ts", import.meta.url);
const googleControls = new URL("../../src/production/mounted-google-controls.ts", import.meta.url);
const pinnedExecution = new URL("../../src/release/production-execution.ts", import.meta.url);
const bootstrap = new URL("../../src/production/bootstrap.ts", import.meta.url);
const sourceBuild = new URL("../../src/production/source-build-verifier.ts", import.meta.url);
const mountedRecord = new URL("../../src/production/mounted-session-record.ts", import.meta.url);
const productionScript = new URL("../../scripts/production.ts", import.meta.url);

test("mounted production session material constructs the complete native provider inventory", async () => {
  const text = await readFile(source, "utf8");
  for (const constructor of [
    "createNativeCloudRunProvider", "createNativeCloudSqlPostgresProvider", "createNativeGcsProvider", "createNativeCollectorProvider",
    "createProductionWorkerLifecycle", "createNativeCep8LightningProvider",
    "createNativeCashuProvider", "CompatibleHostBrowserObservationPort", "ExternalSignerBoundaryAdapter",
    "createProductionPublicationUpload", "createProductionPublicationRelays", "createNativePromotedNappletCliSource",
  ]) expect(text).toContain(constructor);
  for (const runtimeConstructor of [
    "createMountedProductionEdgeMaterial", "openContextVmCertificationClient",
    "dependencies.certificationCapacities.modal", "dependencies.certificationCapacities.fly", "loadMountedProductionSessionRecord",
    "ProductionEdgeContexts", "openProductionNip46Signer", "createProductionCliUploadPort",
    "createProductionNostrRelayPort", "ProductionCompatibleHostPackage",
    "prepareMountedOperationalExecution", "materializeProtectedCertifier",
    "PostgresReleasePromotion", "productionReleaseScope",
    "createMountedProductionSourceBuildVerifier",
  ]) expect(text).toContain(runtimeConstructor);
  for (const injectedField of ["contextvmCertification:", "modalSdk:", "modalJournal:", "flyClient:"]) {
    expect(text).not.toContain(injectedField);
  }
  expect((text.match(/createProductionPublicationRelays\(/g) ?? []).length).toBe(1);
  expect(text).toContain("attestationSigner: edgeMaterial.attestationSigner");
  expect(text).not.toContain("unavailableNativePort");
  expect(text).not.toContain("actualCostMicros: exactCost(input.quote.actualCostMicros");
  expect(text).not.toContain("const records = new Map");
  expect(text).not.toContain("FakeWallet");
  expect(text).not.toContain("deterministic");
  expect(text).not.toContain("PRODUCTION_FINALIZATION_PREPARATION_UNAVAILABLE");
  expect(text).toContain("PRODUCTION_MOUNTED_PREPARATION_BINDING_REQUIRED");
});

test("sealed source-build verifier materializes only a receipt-bound worker result", async () => {
  const [material, verifier] = await Promise.all([readFile(source, "utf8"), readFile(sourceBuild, "utf8")]);
  expect(material).not.toContain('runSealedBuild({ candidateId: input.config.candidateSha256, image: input.config.worker.image })');
  expect(verifier).toContain("ProductionWorkerJobClient");
  expect(verifier).toContain("capacity.reserveNow");
  expect(verifier).toContain("ProductionArtifactVerifier");
  expect(verifier).toContain("createImmutable");
  expect(verifier).toContain("PRODUCTION_SOURCE_BUILD_ORIGINAL_UNKNOWN");
  expect(verifier).toContain("PRODUCTION_SOURCE_BUILD_PERSISTENCE_UNKNOWN");
  expect(verifier).toContain("capacity.observeRelease");
  expect(verifier).toContain("capacity.release");
  expect(verifier).toContain("PRODUCTION_EDGE_ORIGINAL_VERIFIER_REQUIRED");
  expect(verifier).toContain("validateAuthorizationReceipt");
  expect(verifier).toContain("request.providerScopes.some");
  expect(verifier).toContain("request.orderedEffects.some");
  expect(verifier).toContain("PRODUCTION_SOURCE_BUILD_WORKER_LIFETIME_REQUIRED");
  expect(verifier).toContain('command.kind !== "edge.security.build"');
  expect(verifier).not.toContain("ProductionCoreControlClient");
  expect(verifier).not.toContain("createProductionEdgeSuiteAdapters");
});

test("normal mounted record materialization owns source preapproval and discards placeholder artifact hashes", async () => {
  const text = await readFile(mountedRecord, "utf8");
  expect(text).toContain("materializeMountedSourceBuildPreapproval({ candidateSha256:");
  expect(text).toContain("sourceBuild.plan === undefined");
  expect(text).toContain("sealedArtifactSha256: _sealed");
  expect(text).not.toContain("sealedArtifactSha256: Digest, manifestSha256: Digest, capabilitiesSha256: Digest, aggregateSha256: Digest");
});

test("normal mounted startup resolves fixed controller material without an injected callback graph", async () => {
  const text = await readFile(runtime, "utf8");
  expect(text).toContain("createProductionCertificationSessionMaterial");
  expect(text).toContain("loadMountedProductionSessionRecord");
  expect(text).toContain("createMountedDeploymentExecutionConfig");
  expect(text).toContain("createProductionCertificationSessionMaterial({");
  expect(text).not.toContain("src/dev");
});

test("bootstrap is fixed-mount only and assembles concrete server controls from measured facts", async () => {
  const text = await readFile(bootstrap, "utf8");
  expect(text).toContain('PRODUCTION_CONFIG_MOUNT = "/etc/napplet-cvm/production-config.json"');
  expect(text).toContain("openMountedProductionSession({ config: resolved.config, secrets: resolved.secrets, resolved: resolved.record })");
  for (const constructor of [
    "ProductionTelemetryCertification", "createMountedGoogleControls", "ProductionMigrationSource",
    "createMountedFreshRestoreRuntime", "ProductionGoogleFreshRestoreProvisioner",
    "ProductionRestoreCertification", "ProductionCertificationControl", "ProductionMigrationControl",
  ]) expect(text).toContain(constructor);
  expect(text).not.toContain("process.env");
  expect(text).not.toContain("Bun.argv");
});

test("production entrypoint starts the fixed bootstrap rather than accepting authority injection", async () => {
  const text = await readFile(productionScript, "utf8");
  expect(text).toContain("openMountedProductionHttpBootstrap()");
  expect(text).toContain("if (import.meta.main) await startProductionServer()");
  expect(text).not.toContain("ProductionRuntimeAuthority");
  expect(text).not.toContain("observeAdmissionOperation:");
});

test("normal mounted boot rejects an invalid fixed config before opening any provider authority", async () => {
  await expect(openMountedProductionSession({ config: {} })).rejects.toThrow();
});

test("pinned execution forwards the fixed secret mount, while workers and ContextVM are built from runtime authority", async () => {
  const [material, execution] = await Promise.all([readFile(source, "utf8"), readFile(pinnedExecution, "utf8")]);
  expect(execution).toContain("generation, authorization, secrets");
  expect(material).toContain("createMountedProductionEdgeMaterial({ config: input.config, secrets: input.secrets })");
  expect(material).toContain("openContextVmCertificationClient({");
  expect(material).toContain("createProductionWorkerLifecycle({ provider: \"modal\", capacity: dependencies.certificationCapacities.modal");
  expect(material).toContain("createProductionWorkerLifecycle({ provider: \"fly\", capacity: dependencies.certificationCapacities.fly");
  expect(material).not.toContain("input.resolved.contextvmCertification");
  expect(material).not.toContain("input.resolved.modalSdk");
  expect(material).not.toContain("input.resolved.flyClient");
});

test("Google-native ports are constructed from scope-bound ADC and durable original-operation journals", async () => {
  const text = await readFile(googleControls, "utf8");
  expect(text).toContain("createGoogleAdcTokenSource");
  expect(text).toContain("createGoogleDeploymentClients");
  expect(text).toContain("createPostgresGoogleOperationJournal");
  expect(text).toContain("googleIntentJournal");
  expect(text).toContain("provisionOperationId(value.operationId)");
  expect(text).toContain("if (!await googleJournal.read(operationId)) return Object.freeze({ status: \"missing\" as const })");
  expect(text).toContain("probeCloudSqlSerializable");
  expect(text).toContain("containerPort: 4318");
  expect(text).not.toContain("unavailableNativePort");
});

test("hash-pinned runtime factory requires the fixed immutable mount record rather than an injected graph", async () => {
  await expect(createProductionCertificationSessionMaterial({
    config: {} as never,
    deploymentConfig: {} as never,
    generation: {} as never,
    authorization: {} as never,
    secrets: {} as never,
  })).rejects.toThrow("PRODUCTION_MOUNTED_SESSION_RECORD_INVALID");
});

test("receipt-bound provider bridge refuses to mislabel a preapproval quote as incurred provider cost", async () => {
  const observed: string[] = [];
  const port = createReceiptBoundReleaseProviderPort({
    native: {
      async plan() { observed.push("plan"); return { status: "pending" }; },
      async apply() { observed.push("apply"); return { status: "completed", resourceIdentitySha256: "a".repeat(64) }; },
      async observe() { observed.push("observe"); return { status: "completed", resourceIdentitySha256: "a".repeat(64) }; },
      async cleanup() { observed.push("cleanup"); return { status: "cleaned" }; },
    },
    authorization: { request: { request: "mounted" }, receipt: { receipt: "mounted" } },
    discovery: { capability: "available", authentication: "authorized", accountScopeSha256: "b".repeat(64), costEstimateSha256: "c".repeat(64), resourceIdentitySha256: "d".repeat(64), secretReferenceNames: ["broker:cloud-run"] },
    quote: { estimatedCostMicros: 47, actualCostMicros: 53 },
  });
  await expect(port.plan({ operationId: "operation-1", effectId: "cloud-run-ingress", region: "europe-west1", desiredDigest: "d".repeat(64) })).rejects.toThrow("PRODUCTION_NATIVE_PLAN_INVALID");
  await expect(port.apply({ operationId: "operation-1", effectId: "cloud-run-ingress", region: "europe-west1", desiredDigest: "d".repeat(64) })).resolves.toEqual({ status: "unknown", resourceIdentitySha256: "a".repeat(64) });
  await expect(port.observe({ operationId: "operation-1" })).resolves.toEqual({ status: "completed", resourceIdentitySha256: "a".repeat(64) });
  expect(observed).toEqual(["plan", "apply", "observe"]);
});

test("protected provider readiness remains unknown until an actual cost observation exists", async () => {
  const port = createProtectedSuiteProviderPort({
    provider: "signer",
    discovery: { capability: "available", authentication: "authorized", accountScopeSha256: "a".repeat(64), costEstimateSha256: "b".repeat(64), resourceIdentitySha256: "c".repeat(64), secretReferenceNames: ["nostr:broker"] },
    quote: { estimatedCostMicros: 71, actualCostMicros: 89 },
  });
  await expect(port.plan({ operationId: "operation-1", effectId: "signer", region: "global", desiredDigest: "d".repeat(64) })).resolves.toEqual({ status: "planned", estimatedCostMicros: 71 });
  await expect(port.apply({ operationId: "operation-1", effectId: "signer", region: "global", desiredDigest: "d".repeat(64) })).resolves.toEqual({ status: "unknown", resourceIdentitySha256: "c".repeat(64) });
  await expect(port.observe({ operationId: "operation-1" })).resolves.toEqual({ status: "unknown", resourceIdentitySha256: "c".repeat(64) });
  await expect(port.cleanup({ operationId: "operation-1" })).rejects.toThrow("PRODUCTION_PROVIDER_ACTUAL_COST_UNOBSERVED");
});


test("receipt-bound bridge validates dedicated cleanup observations separately from unsettled cost", async () => {
  for (const status of ["cleaned", "pending", "missing", "unknown", "blocked", "completed", "retained"] as const) {
    const calls: unknown[] = [];
    const port = createReceiptBoundReleaseProviderPort({
      native: { async plan() { throw new Error("UNEXPECTED"); }, async apply() { throw new Error("UNEXPECTED"); }, async observe() { throw new Error("UNEXPECTED"); }, async cleanup() { throw new Error("UNEXPECTED"); } },
      authorization: { request: {}, receipt: {} },
      discovery: { capability: "available", authentication: "authorized", accountScopeSha256: "b".repeat(64), costEstimateSha256: "c".repeat(64), resourceIdentitySha256: "d".repeat(64), secretReferenceNames: [] },
      quote: { estimatedCostMicros: 47, actualCostMicros: 53 },
      async observeCleanup(value) { calls.push(value); return { status }; },
    });
    const result = port.observeCleanup!({ operationId: "original-cleanup" });
    if (status === "completed" || status === "retained") await expect(result).rejects.toThrow("PRODUCTION_NATIVE_CLEANUP_OBSERVATION_INVALID");
    else expect(await result).toEqual({ status });
    expect(calls).toEqual([{ operationId: "original-cleanup" }]);
  }
});
