import { observeUploadedCollectorRegistryImage } from "../../src/release/collector-image";
import { expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { runReleaseCertification } from "../../src/release/controller";
import { loadReleaseExecutionReadiness, loadReleaseExecutionSession } from "../../src/release/production-execution";
import { createReleaseProviderRegistry } from "../../src/release/providers";
import { RELEASE_PRODUCTION_PROVIDER_IDS } from "../../src/release/native-registry";
import { RELEASE_PROVIDER_IDS } from "../../src/release/topology";

const digest = (value: string) => createHash("sha256").update(value).digest("hex");
const candidatePath = join(import.meta.dir, "..", "..", "toolchains/candidates/initial.json");

test("pinned release execution session construction makes no provider call", async () => {
  const root = await mkdtemp(join(tmpdir(), "napplet-cvm-release-execution-"));
  const modulePath = join(root, "release-execution.mjs");
  const deploymentConfigPath = join(root, "deployment.json");
  const source = `
    const providers = ${JSON.stringify([...RELEASE_PRODUCTION_PROVIDER_IDS])};
    export let factoryCalls = 0;
    export const releaseReadiness = { providerFamilies: providers, protectedSuites: ["admission", "telemetry", "chaos", "restore", "security-host", "supply-chain", "contextvm-payment-model", "publication"], materialization: true, workerSelection: true, protectedVerification: true, finalization: true, actualCost: true, cleanupOwnership: true };
    export function createReleaseExecutionSession() {
      factoryCalls += 1;
      globalThis.__nappletCvmFactoryCalls = (globalThis.__nappletCvmFactoryCalls ?? 0) + 1;
      return {
        registry: {
          providers() { return providers; },
          async discover() { return {}; },
          async plan() { return {}; },
          async apply() { return {}; },
          async observe() { return {}; },
          async cleanup() { return {}; },
        },
        async prepareAuthorizedExecution() { return {}; },
      };
    }
  `;
  try {
    await writeFile(modulePath, source);
    const deploymentConfig = JSON.stringify({
      version: 1,
      candidateSha256: "a".repeat(64),
      sourceRevision: "b".repeat(40),
      workspaceRoot: root,
      factoryModuleSha256: digest(source),
      publicSettings: { regions: ["europe-west1"] },
      secretReferences: { googleApplicationDefaultCredentials: "gcp:adc:release" },
    });
    await writeFile(deploymentConfigPath, deploymentConfig);
    const session = await loadReleaseExecutionSession({
      config: {
        version: 1,
        mode: "protected",
        releaseProfilePath: join(root, "release-profile.json"),
        evidenceDirectory: join(root, "evidence"),
        credentials: "configured",
        adapter: { root, modulePath, sha256: digest(source) },
        releaseExecution: { root, modulePath, sha256: digest(source), configPath: deploymentConfigPath, configSha256: digest(deploymentConfig) },
        controller: {
          candidateId: "a".repeat(64), releaseId: "c".repeat(64), topologySha256: "d".repeat(64),
          authorizationReceiptSha256: "e".repeat(64), sourceRevision: "b".repeat(40), sourceSha256: "f".repeat(64),
        },
      },
      candidateSha256: "a".repeat(64),
      workspace: root,
    });
    expect(Object.isFrozen(session)).toBeTrue();
    expect(Object.keys(session).sort()).toEqual(["prepareAuthorizedExecution", "registry"]);
    const readiness = await loadReleaseExecutionReadiness({
      config: {
        version: 1, mode: "protected", releaseProfilePath: join(root, "release-profile.json"), evidenceDirectory: join(root, "evidence"), credentials: "configured",
        adapter: { root, modulePath, sha256: digest(source) },
        releaseExecution: { root, modulePath, sha256: digest(source), configPath: deploymentConfigPath, configSha256: digest(deploymentConfig) },
        controller: { candidateId: "a".repeat(64), releaseId: "c".repeat(64), topologySha256: "d".repeat(64), authorizationReceiptSha256: "e".repeat(64), sourceRevision: "b".repeat(40), sourceSha256: "f".repeat(64) },
      }, candidateSha256: "a".repeat(64), workspace: root,
    });
    expect(readiness.providerFamilies).toEqual(RELEASE_PRODUCTION_PROVIDER_IDS);
    // Readiness verifies the same pinned bundle without constructing the
    // receipt-bound graph; only the explicit session load invokes its factory.
    expect((globalThis as Record<string, unknown>).__nappletCvmFactoryCalls).toBe(1);
    delete (globalThis as Record<string, unknown>).__nappletCvmFactoryCalls;
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("local certifier config cannot load a production execution session", async () => {
  await expect(loadReleaseExecutionSession({
    config: { version: 1, mode: "local", evidenceDirectory: join(tmpdir(), "local-evidence") },
    candidateSha256: "a".repeat(64),
    workspace: tmpdir(),
  })).rejects.toThrow("RELEASE_PRODUCTION_EXECUTION_CONFIG_REQUIRED");
});

test("protected configuration marked credential-unavailable cannot load a production execution session", async () => {
  const root = join(tmpdir(), "napplet-cvm-release-execution-unavailable");
  await expect(loadReleaseExecutionSession({
    config: {
      version: 1,
      mode: "protected",
      releaseProfilePath: join(root, "release-profile.json"),
      evidenceDirectory: join(root, "evidence"),
      credentials: "unavailable",
      adapter: { root, modulePath: join(root, "adapter.mjs"), sha256: "a".repeat(64) },
      releaseExecution: { root, modulePath: join(root, "release-execution.mjs"), sha256: "b".repeat(64), configPath: join(root, "deployment-config.json"), configSha256: "c".repeat(64) },
    },
    candidateSha256: "a".repeat(64),
    workspace: root,
  })).rejects.toThrow("RELEASE_PRODUCTION_EXECUTION_CONFIG_REQUIRED");
});

test("non-dry execution reaches the same-session approval boundary before any provider plan or mutation", async () => {
  const workspace = await mkdtemp(join(tmpdir(), "napplet-cvm-release-execution-"));
  let discoveryCalls = 0;
  let planCalls = 0;
  let mutationCalls = 0;
  let requestSha256: string | undefined;
  const registry = createReleaseProviderRegistry({
    now: () => 1_000,
    ports: Object.fromEntries(RELEASE_PROVIDER_IDS.map((provider) => [provider, {
      discoverCapabilities: async () => { discoveryCalls += 1; return { capability: "available" as const }; },
      discoverAuthentication: async () => { discoveryCalls += 1; return { authentication: "authorized" as const }; },
      plan: async () => { planCalls += 1; return { status: "planned" as const, estimatedCostMicros: 0 }; },
      apply: async () => { mutationCalls += 1; return { status: "applied" as const, actualCostMicros: 0, resourceIdentity: provider }; },
      observe: async () => { mutationCalls += 1; return { status: "completed" as const, actualCostMicros: 0, resourceIdentity: provider }; },
      cleanup: async () => { mutationCalls += 1; return { status: "cleaned" as const, actualCostMicros: 0 }; },
    }])) as never,
  });
  try {
    await expect(runReleaseCertification({
      candidatePath,
      workspace,
      dryRun: false,
      // Already-observed local contract fixture; no registry or release evidence.
      collectorImage: await observeUploadedCollectorRegistryImage({
        plannedRegistryReference: `registry.example/napplet-cvm/collector@sha256:${"c".repeat(64)}`,
        registryAvailability: "not_uploaded", localOciManifestDigest: `sha256:${"c".repeat(64)}`, localOciConfigDigest: `sha256:${"d".repeat(64)}`,
        platform: { os: "linux", architecture: "amd64" }, baseImage: `otel/opentelemetry-collector@sha256:${"e".repeat(64)}`,
        dockerfileSha256: "f".repeat(64), collectorConfigSha256: "a".repeat(64), ociLayoutPath: "/tmp/collector.oci.tar", ociLayoutSha256: "b".repeat(64),
      }, { async observeUploadedManifest(input) { return { ...input, observedAtMs: 1 }; } }),
      now: () => 1_000,
      session: {
        registry,
        async prepareAuthorizedExecution({ authorizationRequest }) {
          requestSha256 = authorizationRequest.authorizationRequestSha256;
          return { receipt: {} } as never;
        },
      },
    })).rejects.toThrow("RELEASE_CONTROLLER_AUTHORIZATION_INVALID");
    expect(requestSha256).toMatch(/^[a-f0-9]{64}$/u);
    expect(discoveryCalls).toBe(RELEASE_PROVIDER_IDS.length * 2);
    expect(planCalls).toBe(0);
    expect(mutationCalls).toBe(0);
  } finally {
    await rm(workspace, { recursive: true, force: true });
  }
});
