import { createHash } from "node:crypto";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { loadProductionConfig } from "../../../src/production/config";
import { materializeMountedProductionSessionRecord } from "../../../src/production/mounted-session-record";
import { createAuthorizationReceipt } from "../../../src/release/authorization";
import { ReleaseCertificationController } from "../../../src/release/controller";
import { observeUploadedCollectorRegistryImage } from "../../../src/release/collector-image";
import { createReleaseProviderRegistry, type ReleaseProviderPort } from "../../../src/release/providers";
import { RELEASE_PROVIDER_IDS } from "../../../src/release/topology";
import { googleAccountScopeSha256 } from "../../../src/release/deployment/google-auth";
import { canonicalJson } from "../../../src/promotion/schema";

export const recoveryFixtureDigest = (value: string) => createHash("sha256").update(value).digest("hex");
const contentDigest = (value: unknown) => recoveryFixtureDigest(canonicalJson(value));
const sourceRevision = "a".repeat(40);
export const recoveryFixtureProject = "napplet-cvm-01";
export const recoveryFixturePrincipal = "release-runner@napplet-cvm-01.iam.gserviceaccount.com";

/** Data-only, deny-effects mount. It creates no certification observations and
 * never substitutes the loader, mounted factory, controller, or reporter. */
export async function mountedBillingRecoveryFixture(workspace: string, nowMs: number) {
  const repositoryRoot = resolve(import.meta.dir, "../../..");
  const candidatePath = join(repositoryRoot, "toolchains/candidates/initial.json");
  const accountScopeSha256 = await googleAccountScopeSha256({ projectId: recoveryFixtureProject, quotaProjectId: recoveryFixtureProject, principal: recoveryFixturePrincipal });
  const report = {
    version: 1 as const, allowedReportOrigin: "https://bigquery.googleapis.com" as const,
    detailedExportTable: `${recoveryFixtureProject}.billing_export.gcp_billing_export_resource_v1`, location: "US",
    maximumBytesBilled: "1000000", reportQueryMaximumCostMicros: 10,
    reportQueryPriceSourceSha256: recoveryFixtureDigest("report-price"), reportQueryMicrosPerByteNumerator: "1", reportQueryMicrosPerByteDenominator: "1000000",
    collectorSha256: recoveryFixtureDigest("report-collector"), maximumIntervalMs: 60_000, expiresAtMs: nowMs + 4 * 60 * 60_000,
  };
  const { allowedReportOrigin: _origin, expiresAtMs: _expires, ...reportConfiguration } = report;
  const collectorImage = await observeUploadedCollectorRegistryImage({
    plannedRegistryReference: `registry.example/napplet-cvm/collector@sha256:${recoveryFixtureDigest("collector")}`,
    registryAvailability: "not_uploaded", localOciManifestDigest: `sha256:${recoveryFixtureDigest("collector")}`,
    localOciConfigDigest: `sha256:${recoveryFixtureDigest("collector-config")}`, platform: { os: "linux", architecture: "amd64" },
    baseImage: `otel/opentelemetry-collector@sha256:${recoveryFixtureDigest("base")}`,
    dockerfileSha256: recoveryFixtureDigest("dockerfile"), collectorConfigSha256: recoveryFixtureDigest("collector-config"), ociLayoutPath: "/tmp/recovery-collector.oci.tar", ociLayoutSha256: recoveryFixtureDigest("oci"),
  }, { async observeUploadedManifest(input) { return { ...input, observedAtMs: nowMs }; } });
  const controller = new ReleaseCertificationController({
    candidatePath, workspace, now: () => nowMs, collectorImage, billingObservation: report,
    providers: Object.fromEntries(RELEASE_PROVIDER_IDS.map(provider => [provider, {
      async discover() { return { capability: "available" as const, authentication: "authorized" as const, reasonCode: "AVAILABLE" as const, accountScopeSha256, costEstimateSha256: recoveryFixtureDigest(provider), secretReferenceNames: [] }; },
    }])),
  });
  const dry = await controller.dryRun();
  const receipt = await createAuthorizationReceipt(dry.authorizationRequest);
  await controller.validateStructuredReceipt(receipt);
  const nativePort: ReleaseProviderPort = {
    async discoverCapabilities() { return { capability: "available", accountScopeSha256 }; },
    async discoverAuthentication() { return { authentication: "authorized", accountScopeSha256 }; },
    async plan() { return { status: "planned", estimatedCostMicros: 0 }; },
    async apply(input) { return { status: "applied", resourceIdentitySha256: recoveryFixtureDigest(input.operationId) }; },
    async observe(input) { return { status: "completed", resourceIdentitySha256: recoveryFixtureDigest(input.operationId) }; },
    async cleanup() { throw new Error("RECOVERY_MUST_NOT_CLEAN_UP"); },
  };
  const provisioned = await controller.provision({ receipt, registry: createReleaseProviderRegistry({ now: () => nowMs, ports: Object.fromEntries(RELEASE_PROVIDER_IDS.map(provider => [provider, nativePort])) }) });
  // Seed only the held boundary of a production-shaped controller checkpoint.
  // Its preceding receipt/provisioning records come from the real producers;
  // this fixture never invents passed protected suites or a release bundle.
  const { stateSha256: priorSha, ...prior } = provisioned.state;
  const stateBase = { ...prior, version: 2 as const, status: "billing_observing" as const, priorStateSha256: priorSha };
  const state = { ...stateBase, stateSha256: contentDigest(stateBase) };
  await writeFile(join(workspace, "states", `${state.stateSha256}.json`), `${canonicalJson(state)}\n`, { mode: 0o600 });
  const pointerBase = { version: 1, stateSha256: state.stateSha256, candidateSha256: state.candidate.candidateSha256 };
  await writeFile(join(workspace, "current.json"), `${canonicalJson({ ...pointerBase, pointerSha256: contentDigest(pointerBase) })}\n`, { mode: 0o600 });
  if ((await controller.status())?.state.status !== "billing_observing") throw new Error("RECOVERY_STATE_FIXTURE_INVALID");

  const candidateSha256 = state.candidate.candidateSha256;
  const topologySha256 = dry.authorizationRequest.topologySha256;
  const digest = recoveryFixtureDigest;
  const image = `registry.example/napplet-cvm/control@sha256:${digest("control-image")}`;
  const config = loadProductionConfig({
    realm: "production-real", candidateSha256, topologySha256, projectId: recoveryFixtureProject, regions: ["us-central1", "europe-west1"],
    cloudSql: { instanceReference: "sql:release", database: "production_real", roleCredentialReference: "sql:runtime", restoreRecoveredRoleCredentialReference: "sql:recovered", restoreMigrationRoleCredentialReference: "sql:migration", migrationRevision: digest("migration") },
    gcs: { bucket: "recovery-evidence-bucket", location: "nam4", encryptionKeyReference: "gcs:key", migrationBackupKeyReference: "gcs:backup", retentionDays: 30 }, checkpoint: { kekReference: "checkpoint:kek" },
    contextvm: { relay: "wss://relay.example", serviceKeyReference: "contextvm:key" }, certification: { authorizationRequestReference: "cert:request", authorizationReceiptReference: "cert:receipt", clientKeyReference: "cert:client", sessionMaterialReference: "cert:session", serverPubkey: digest("server") },
    funding: { nwcConnectionReference: "funding:nwc", cashuConsentReference: "funding:cashu", protectedMaterialReference: "funding:protected", admissionReceiptReference: "funding:admission", statusCursorReference: "funding:cursor" },
    vertex: { projectReference: "vertex:project", credentialReference: "vertex:credential", model: "gemini-4-argon", priceSnapshotSha256: digest("vertex-price") },
    worker: { selectedProvider: "fly", evidenceReference: "worker:evidence", modalAccessReference: "worker:modal", flyAccessReference: "worker:fly", image, toolchainSha256: digest("toolchain"), policyVersion: "policy-v1" },
    compatibleHost: { targetUrl: "https://host.example", targetSha256: digest("host"), chromiumExecutable: "/usr/bin/chromium" },
    publication: { cliSourceReference: "publication:cli", signerBrokerReference: "publication:broker", signerSessionKeyReference: "publication:session", attestationKeyReference: "publication:attestation", ownerPubkey: digest("owner"), uploadServer: "https://upload.example", uploadTargetReference: "publication:target", relays: ["wss://relay.example"] },
    publicOrigins: { static: "https://static.example", preview: "https://preview.example", artifact: "https://artifact.example" }, policy: { artifactVersion: "policy-v1", retentionDays: 30, liveGraceMs: 600_000 },
    collector: { otlpEndpoint: "https://collector.example", serviceName: "napplet-cvm-production" }, operator: { serviceAccount: recoveryFixturePrincipal, privateControlAudience: "https://release-control.run.app" }, image: { controlPlane: image, toolchainSha256: digest("toolchain") },
  });
  const runtimeModulePath = join(repositoryRoot, "src/production/mounted-session-material.ts");
  const runtimeModuleSha256 = digest(await readFile(runtimeModulePath, "utf8"));
  const runtimeConfigPath = join(workspace, "production-config.json");
  const runtimeConfigBytes = JSON.stringify(config);
  await writeFile(runtimeConfigPath, runtimeConfigBytes);
  const runtimeClosureSha256 = digest(JSON.stringify({ configSha256: digest(runtimeConfigBytes), moduleSha256: runtimeModuleSha256 }));
  const modulePath = join(workspace, "ordinary-factory.mjs");
  const ordinarySource = 'throw new Error("ORDINARY_FACTORY_MUST_NOT_OPEN_DURING_RECOVERY");\n';
  await writeFile(modulePath, ordinarySource);
  const deployment = { version: 1, candidateSha256, sourceRevision, workspaceRoot: workspace, factoryModuleSha256: digest(ordinarySource), runtimeClosureSha256, publicSettings: { regions: [...config.regions] }, secretReferences: {} };
  const deploymentPath = join(workspace, "deployment.json");
  const deploymentBytes = JSON.stringify(deployment);
  await writeFile(deploymentPath, deploymentBytes);
  const releaseBinding = {
    releaseId: digest("release"), sourceRevision, sourceSha256: digest("source"),
    supplyChainPolicy: { cosign: { executableSha256: digest("cosign"), signerIdentity: "issuer:identity", issuer: "https://issuer.example", predicateType: "https://slsa.dev/provenance/v1" }, sbom: { bomFormat: "CycloneDX", specVersion: "1.5", generator: { vendor: "napplet", name: "generator", version: "1" } } },
    inputs: Object.fromEntries(["controlImageDigest", "workerImageDigest", "packageLockSha256", "toolchainSha256", "migrationSha256", "configSha256", "policySha256", "datasetSha256", "goldenSha256", "sbomSha256", "provenanceSha256"].map(key => [key, digest(key)])),
  };
  const collectorDigest = `sha256:${digest("collector")}`;
  const collectorReference = `registry.example/napplet-cvm/collector@${collectorDigest}`;
  const measured = materializeMountedProductionSessionRecord({ config, measured: {
    version: 1, candidateSha256, topologySha256,
    workerCandidate: { id: candidateSha256, provider: "fly", image, sourceSha256: digest("source") },
    discoveries: Object.fromEntries(RELEASE_PROVIDER_IDS.map(provider => [provider, { capability: "available", authentication: "authorized", accountScopeSha256, costEstimateSha256: digest(provider), resourceIdentitySha256: digest(provider), secretReferenceNames: [] }])),
    quotes: Object.fromEntries(RELEASE_PROVIDER_IDS.map(provider => [provider, { estimatedCostMicros: 1, actualCostMicros: 0 }])),
    cleanupScopes: { cloudRunRegion: "us-central1", cloudRunServiceName: "release", cloudSqlInstanceId: "release-sql", gcsRunOwnedNamespace: "release/evidence", collectorEndpointReference: "collector:endpoint" },
    gcsProvisionObjectBase64: Buffer.from("bounded-report-evidence").toString("base64"),
    providerConfigurations: Object.fromEntries(["cloud_run", "gcs", "collector", "cloud_sql_postgres", "modal", "fly", "contextvm", "cep8_lightning", "cashu", "model", "upload", "owner_relay", "attestation_relay"].map(provider => [provider, {}])),
    googleControls: { cloudRun: {}, cloudSql: {}, collector: { deployment: { imageReference: collectorReference } }, authoritativeUsage: reportConfiguration },
    edge: { compatibleHost: { hostUrl: config.compatibleHost.targetUrl, hostSha256: config.compatibleHost.targetSha256, chromiumExecutable: config.compatibleHost.chromiumExecutable }, uploadServer: config.publication.uploadServer, ownerPubkey: config.publication.ownerPubkey, relays: [...config.publication.relays] },
    execution: {
      materialization: { workspace, repositoryRoot, releaseManifest: {}, source: { sourceRevision, sourceSha256: digest("source") }, factoryModuleSha256: digest(ordinarySource), runtimeClosureSha256, secretReferences: {} },
      workerSelection: { provider: "fly", status: "selected", candidateSha256, topologySha256, selectionEvidenceSha256: digest("selection"), observedAtMs: nowMs, expiresAtMs: nowMs + 60_000 },
      protected: { input: { datasetSha256: digest("dataset"), profileSha256: digest("profile"), topologySha256, command: ["bun", "test"] }, topology: { candidateSha256, topologySha256 }, collector: { collectorDigest, configSha256: digest("collector-config") }, releaseBinding, protectedVerificationReferences: { root: workspace, reproducibility: { relativePath: "repro.json", evidenceSha256: digest("repro") }, supplyChain: { relativePath: "supply.json", evidenceSha256: digest("supply") } }, sourceBuild: { candidateSha256, topologySha256, image, sourceSha256: digest("source") } },
      finalization: { trust: { repositoryRoot, releaseManifest: {}, sourceArchive: { root: workspace, relativePath: "source.tar", canonicalSourceReference: "source:archive", sourceRevision, sourceSha256: digest("source") }, reproducibilityRecord: {}, supplyChainRecord: {} }, verificationRecords: { reproducibility: {}, supplyChain: {} }, sourceMeasurement: {}, receipts: [], attestations: [], cleanupPlan: { cleanupByMs: nowMs + 60_000, retainedEvidenceDays: 30, retainedArtifactDays: 30, effects: [] }, expectedPreviousBundleSha256: null },
    },
    serverControls: { telemetry: { deployment: { projectId: config.projectId, region: "us-central1", serviceName: "release-collector", revisionName: "release-collector-001", endpoint: config.collector.otlpEndpoint, imageReference: collectorReference, accountScopeSha256, projectScopeSha256: digest("project"), principal: config.operator.serviceAccount } }, restore: { sourceInstanceId: "release-source", scope: { checkpointId: "checkpoint", sessionId: "session", ownerId: "owner" } }, migration: { source: {}, freshTargetIdentity: "release-fresh-target" } },
    descriptorReferences: { contextvmRelaySetReference: "contextvm:relays", contextvmRelaySetSha256: digest("relays"), compatibleHostReference: "host:package", chromiumReference: "host:chromium", ownerKeyReference: "owner:reference", attestationKeyReference: "attestation:reference" },
  } });
  const certifierConfig = {
    version: 1, mode: "protected", credentials: "configured", releaseProfilePath: join(workspace, "release-profile.json"), evidenceDirectory: join(workspace, "evidence"),
    adapter: { root: workspace, modulePath, sha256: digest(ordinarySource) },
    releaseExecution: { root: workspace, modulePath, sha256: digest(ordinarySource), configPath: deploymentPath, configSha256: digest(deploymentBytes), runtime: { root: repositoryRoot, modulePath: runtimeModulePath, sha256: runtimeModuleSha256, configPath: runtimeConfigPath, configSha256: digest(runtimeConfigBytes) } },
    controller: { candidateId: candidateSha256, releaseId: releaseBinding.releaseId, topologySha256, authorizationReceiptSha256: receipt.authorizationReceiptSha256, sourceRevision, sourceSha256: digest("source") },
  };
  const certifierPath = join(workspace, "certifier.json");
  const certifierBytes = JSON.stringify(certifierConfig);
  await writeFile(certifierPath, certifierBytes);
  const secrets = new Map([
    ["cert_request", JSON.stringify(dry.authorizationRequest)], ["cert_receipt", JSON.stringify(receipt)], ["cert_session", JSON.stringify(measured)],
    ["sql_runtime", JSON.stringify({ host: "10.0.0.9", port: 5432, user: "napplet_cvm_runtime", password: "bounded-offline-database-password", servername: "release-sql.internal" })],
  ]);
  await mkdir(join(workspace, "fixture-mount"));
  for (const [key, value] of secrets) await writeFile(join(workspace, "fixture-mount", key), value, { mode: 0o600 });
  return { repositoryRoot, candidatePath, candidateSha256, topologySha256, config, measured, deployment, certifierPath, certifierSha256: digest(certifierBytes), runtimeConfigPath, request: dry.authorizationRequest, receipt, state, secrets, report, accountScopeSha256 };
}
