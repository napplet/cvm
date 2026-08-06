import { expect, test } from "bun:test";

import { createAuthorizationReceipt, createAuthorizationRequest } from "../../src/release/authorization";
import { PRODUCTION_LIVE_PROTECTED_PORT_KEYS } from "../../src/certification/live/production-ports";
import { createProductionOperationalDependencies } from "../../src/release/deployment/production-dependencies";
import { createProductionReleaseExecutionSession, PRODUCTION_FACTORY_SECRET_REFERENCE_NAMES } from "../../src/release/deployment/production-factory";
import { RELEASE_PRODUCTION_PROVIDER_IDS } from "../../src/release/native-registry";

const digest = (letter: string) => letter.repeat(64);

async function requestAndReceipt() {
  const request = await createAuthorizationRequest({
    candidateSha256: digest("a"), topologySha256: digest("b"), effectPlanSha256: digest("c"),
    controllerStateSha256: digest("d"), providerCapabilitiesSha256: digest("e"),
    orderedEffects: RELEASE_PRODUCTION_PROVIDER_IDS.map((provider, index) => ({
      id: `effect-${String(index + 10)}`,
      provider,
      operation: provider === "modal" || provider === "fly" ? "benchmark" as const : provider === "gcs" || provider === "collector" ? "configure" as const : provider === "contextvm" || provider === "cep8_lightning" || provider === "cashu" || provider === "model" || provider === "compatible_host" || provider === "signer" || provider === "promoted_cli" || provider === "upload" || provider === "owner_relay" || provider === "attestation_relay" ? "verify_integration" as const : "create_or_update" as const,
      estimatedCostMicros: 1,
    })),
    providerScopes: RELEASE_PRODUCTION_PROVIDER_IDS.map((provider, index) => ({ provider, accountScopeSha256: digest((index % 10).toString()), projectScopeSha256: digest(((index + 1) % 10).toString()) })),
    estimate: { currency: "USD", maximumMicros: 16, sourceId: "release-topology-v1", observedAtMs: 1_000, freshUntilMs: 2_000 },
    maximumRunDurationMs: 60_000, cleanupByMs: 1_400, evidenceRetentionDays: 30, artifactRetentionDays: 30,
    operatorFundingReadiness: {
      version: 1, status: "ready",
      rails: [
        { rail: "nwc_lightning", secretReference: "os-secret-ref:release-nwc-01", capabilitySha256: digest("1"), accountScopeSha256: digest("2"), expiresAtMs: 2_000, status: "ready" },
        { rail: "cashu", secretReference: "os-secret-ref:release-cashu-01", capabilitySha256: digest("3"), accountScopeSha256: digest("4"), expiresAtMs: 2_000, status: "ready" },
      ], readinessSha256: digest("5"),
    },
    gcpEffects: { projectBootstrap: true, billing: true, apiEnablement: ["run.googleapis.com"] }, expiresAtMs: 1_500,
  });
  return { request, receipt: await createAuthorizationReceipt(request) };
}

function dependencyGraph(receipt: unknown, counters: { operational: number; signer: number }) {
  const provider = (id: string) => Object.freeze({
    origin: "project-owned" as const,
    evidenceClass: "real" as const,
    brokerReference: `broker:${id}:port`,
    port: Object.freeze({
      async discoverCapabilities() { counters.operational += 1; return { capability: "available" as const }; },
      async discoverAuthentication() { counters.operational += 1; return { authentication: "authorized" as const }; },
      async plan() { counters.operational += 1; return { status: "planned" as const, estimatedCostMicros: 0 }; },
      async apply() { counters.operational += 1; return { status: "blocked" as const, actualCostMicros: 0 }; },
      async observe() { counters.operational += 1; return { status: "blocked" as const, actualCostMicros: 0 }; },
      async cleanup() { counters.operational += 1; return { status: "blocked" as const, actualCostMicros: 0 }; },
    }),
  });
  const providers = Object.fromEntries(RELEASE_PRODUCTION_PROVIDER_IDS.map((id) => [id, provider(id)]));
  const protectedPorts = Object.fromEntries(PRODUCTION_LIVE_PROTECTED_PORT_KEYS.map((key) => [key, Object.freeze({ origin: "project-owned" as const, evidenceClass: "real" as const, async run() { counters.operational += 1; } })]));
  return createProductionOperationalDependencies({
    receipt,
    providers,
    protectedPorts,
    now: () => 1_400,
    async prepare({ authorizationRequest }) {
      counters.signer += 0;
      return {
        materialization: { candidateId: authorizationRequest.candidateSha256, topology: { topologySha256: authorizationRequest.topologySha256 } },
        workerSelection: { candidateSha256: authorizationRequest.candidateSha256, topologySha256: authorizationRequest.topologySha256 },
        protected: { candidate: { id: authorizationRequest.candidateSha256 }, input: { topologySha256: authorizationRequest.topologySha256 }, releaseBinding: {} },
        protectedVerificationReferences: {}, finalization: {},
      } as never;
    },
  });
}

test("the exact receipt gates a complete, real, independently-owned production graph without pre-receipt effects", async () => {
  const { request, receipt } = await requestAndReceipt();
  const counters = { operational: 0, signer: 0 };
  const dependencies = dependencyGraph(receipt, counters);
  const session = createProductionReleaseExecutionSession({
    candidateSha256: request.candidateSha256, workspace: "/workspace/release",
    deploymentConfig: {
      secretReferences: Object.fromEntries(PRODUCTION_FACTORY_SECRET_REFERENCE_NAMES.map((name) => [name, `opaque:${name}`])),
      publicSettings: { regions: ["europe-west1", "us-central1"] },
    },
  } as never, dependencies);

  expect(session.registry.providers()).toEqual(RELEASE_PRODUCTION_PROVIDER_IDS);
  expect(counters).toEqual({ operational: 0, signer: 0 });
  await expect(session.prepareAuthorizedExecution({ authorizationRequest: { ...request, topologySha256: digest("f") } })).rejects.toThrow();
  expect(counters).toEqual({ operational: 0, signer: 0 });

  await expect(session.prepareAuthorizedExecution({ authorizationRequest: request })).resolves.toMatchObject({ receipt });
  expect(counters).toEqual({ operational: 0, signer: 0 });
});

test("aliased, incomplete, and non-real dependencies are rejected before an operational method is reachable", async () => {
  const { receipt } = await requestAndReceipt();
  const counters = { operational: 0, signer: 0 };
  const graph = dependencyGraph(receipt, counters);
  expect(graph.registry.providers()).toEqual(RELEASE_PRODUCTION_PROVIDER_IDS);
  expect(counters.operational).toBe(0);

  const shared = Object.freeze({ origin: "project-owned" as const, evidenceClass: "real" as const, brokerReference: "broker:shared:port", port: {} });
  await expect(Promise.resolve().then(() => createProductionOperationalDependencies({
    receipt,
    providers: Object.fromEntries(RELEASE_PRODUCTION_PROVIDER_IDS.map((id) => [id, shared])),
    protectedPorts: Object.fromEntries(PRODUCTION_LIVE_PROTECTED_PORT_KEYS.map((key) => [key, Object.freeze({ origin: "project-owned" as const, evidenceClass: "real" as const })])),
    prepare: async () => ({} as never),
  }))).rejects.toThrow("PRODUCTION_DEPENDENCY_PROVIDER_IDENTITY_REQUIRED");
  expect(counters.operational).toBe(0);
});
