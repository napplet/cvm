import { expect, test } from "bun:test";
import { unexecutedProtectedPorts } from "../fixtures/unexecuted-protected-ports";

import { createAuthorizationReceipt, createAuthorizationRequest } from "../../src/release/authorization";
import { PRODUCTION_LIVE_PROTECTED_PORT_KEYS } from "../../src/certification/live/production-ports";
import { createProductionOperationalDependencies } from "../../src/release/deployment/production-dependencies";
import { createProductionReleaseExecutionSession, PRODUCTION_FACTORY_SECRET_REFERENCE_NAMES } from "../../src/release/deployment/production-factory";
import { RELEASE_PRODUCTION_PROVIDER_IDS } from "../../src/release/native-registry";

function providerRecords<T>(make: (id: typeof RELEASE_PRODUCTION_PROVIDER_IDS[number]) => T): Readonly<Record<typeof RELEASE_PRODUCTION_PROVIDER_IDS[number], T>> {
  return {
    cloud_run: make("cloud_run"),
    gcs: make("gcs"),
    collector: make("collector"),
    cloud_sql_postgres: make("cloud_sql_postgres"),
    modal: make("modal"),
    fly: make("fly"),
    contextvm: make("contextvm"),
    cep8_lightning: make("cep8_lightning"),
    cashu: make("cashu"),
    model: make("model"),
    compatible_host: make("compatible_host"),
    signer: make("signer"),
    promoted_cli: make("promoted_cli"),
    upload: make("upload"),
    owner_relay: make("owner_relay"),
    attestation_relay: make("attestation_relay"),
  };
}

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

function dependencyGraph(receipt: unknown, counters: { operational: number; signer: number; prepared: number }, now = 1_400) {
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
  const providers = providerRecords(provider);
  const protectedPorts = unexecutedProtectedPorts(() => { counters.operational += 1; });
  return createProductionOperationalDependencies({
    receipt,
    providers,
    protectedPorts,
    now: () => now,
    async prepare({ authorizationRequest }) {
      counters.prepared += 1;
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
  const counters = { operational: 0, signer: 0, prepared: 0 };
  const dependencies = dependencyGraph(receipt, counters);
  const session = createProductionReleaseExecutionSession({
    candidateSha256: request.candidateSha256, workspace: "/workspace/release",
    deploymentConfig: {
      secretReferences: Object.fromEntries(PRODUCTION_FACTORY_SECRET_REFERENCE_NAMES.map((name) => [name, `opaque:${name}`])),
      publicSettings: { regions: ["europe-west1", "us-central1"] },
    },
  } as never, dependencies);

  expect(session.registry.providers()).toEqual(RELEASE_PRODUCTION_PROVIDER_IDS);
  expect(counters).toEqual({ operational: 0, signer: 0, prepared: 0 });
  await expect(session.prepareAuthorizedExecution({ authorizationRequest: { ...request, topologySha256: digest("f") } })).rejects.toThrow();
  expect(counters).toEqual({ operational: 0, signer: 0, prepared: 0 });

  await expect(session.prepareAuthorizedExecution({ authorizationRequest: request })).resolves.toMatchObject({ receipt });
  expect(counters).toEqual({ operational: 0, signer: 0, prepared: 1 });
});

test("aliased, incomplete, and non-real dependencies are rejected before an operational method is reachable", async () => {
  const { receipt } = await requestAndReceipt();
  const counters = { operational: 0, signer: 0, prepared: 0 };
  const graph = dependencyGraph(receipt, counters);
  expect(graph.registry.providers()).toEqual([...RELEASE_PRODUCTION_PROVIDER_IDS]);
  expect(counters.operational).toBe(0);

  const unexpected = async () => { throw new Error("UNEXPECTED_PROVIDER_EXECUTION"); };
  const shared = Object.freeze({ origin: "project-owned" as const, evidenceClass: "real" as const, brokerReference: "broker:shared:port", port: { discoverCapabilities: unexpected, discoverAuthentication: unexpected, plan: unexpected, apply: unexpected, observe: unexpected, cleanup: unexpected } });
  await expect(Promise.resolve().then(() => createProductionOperationalDependencies({
    receipt,
    providers: providerRecords(() => shared),
    protectedPorts: unexecutedProtectedPorts(),
    prepare: async () => ({} as never),
  }))).rejects.toThrow("PRODUCTION_DEPENDENCY_PROVIDER_IDENTITY_REQUIRED");
  expect(counters.operational).toBe(0);

  const nonRealProviders = Object.fromEntries(RELEASE_PRODUCTION_PROVIDER_IDS.map((id, index) => [id, Object.freeze({
    origin: "project-owned" as const,
    evidenceClass: index === 0 ? "fixture" : "real",
    brokerReference: `broker:${id}:port`,
    port: Object.freeze({ discoverCapabilities: async () => ({ capability: "available" as const }), discoverAuthentication: async () => ({ authentication: "authorized" as const }), plan: async () => ({ status: "planned" as const, estimatedCostMicros: 0 }), apply: async () => ({ status: "blocked" as const, actualCostMicros: 0 }), observe: async () => ({ status: "blocked" as const, actualCostMicros: 0 }), cleanup: async () => ({ status: "blocked" as const, actualCostMicros: 0 }) }),
  })]));
  await expect(Promise.resolve().then(() => createProductionOperationalDependencies({
    receipt, providers: nonRealProviders as never,
    protectedPorts: Object.fromEntries(PRODUCTION_LIVE_PROTECTED_PORT_KEYS.map((key) => [key, Object.freeze({ origin: "project-owned" as const, evidenceClass: "real" as const })])) as never,
    prepare: async () => ({} as never),
  }))).rejects.toThrow("PRODUCTION_DEPENDENCY_PROVIDER_ORIGIN_REQUIRED");
  expect(counters).toEqual({ operational: 0, signer: 0, prepared: 0 });
});

test("a stale receipt does not invoke preparation or any provider, including the dormant signer family", async () => {
  const { request, receipt } = await requestAndReceipt();
  const counters = { operational: 0, signer: 0, prepared: 0 };
  const session = createProductionReleaseExecutionSession({
    candidateSha256: request.candidateSha256, workspace: "/workspace/release",
    deploymentConfig: { secretReferences: Object.fromEntries(PRODUCTION_FACTORY_SECRET_REFERENCE_NAMES.map((name) => [name, `opaque:${name}`])), publicSettings: { regions: ["europe-west1", "us-central1"] } },
  } as never, dependencyGraph(receipt, counters, 1_500));

  await expect(session.prepareAuthorizedExecution({ authorizationRequest: request })).rejects.toThrow("RELEASE_AUTHORIZATION_RECEIPT_EXPIRED");
  expect(counters).toEqual({ operational: 0, signer: 0, prepared: 0 });
});
