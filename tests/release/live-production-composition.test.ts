import { expect, test } from "bun:test";

import { createNativeReleaseProviderRegistry, createReleaseControllerProviderRegistry, RELEASE_PRODUCTION_PROVIDER_IDS } from "../../src/release/native-registry";
import { createProductionLiveProtectedCertificationPorts } from "../../src/certification/live/production-ports";

const digest = (letter: string) => letter.repeat(64);

const provider = (calls: string[]) => ({
  discoverCapabilities: async () => { calls.push("capability"); return { capability: "available" as const }; },
  discoverAuthentication: async () => { calls.push("authentication"); return { authentication: "authorized" as const }; },
  plan: async () => { calls.push("plan"); return { status: "planned" as const, estimatedCostMicros: 0 }; },
  apply: async () => { calls.push("apply"); return { status: "applied" as const, actualCostMicros: 0 }; },
  observe: async () => { calls.push("observe"); return { status: "missing" as const, actualCostMicros: 0 }; },
  cleanup: async () => { calls.push("cleanup"); return { status: "blocked" as const, actualCostMicros: 0 }; },
});

const real = <T extends Record<string, unknown>>(port: T) => Object.freeze({ ...port, evidenceClass: "real" as const });

test("production tracer constructs all controller providers and exact real ports without effects", async () => {
  const calls: string[] = [];
  const native = createNativeReleaseProviderRegistry({
    candidateSha256: digest("a"),
    providers: Object.fromEntries(RELEASE_PRODUCTION_PROVIDER_IDS.map((id) => [id, provider(calls)])),
  });
  const controller = createReleaseControllerProviderRegistry(native);
  const ports = createProductionLiveProtectedCertificationPorts({
    admission: real({ executeSample: async () => { calls.push("admission"); return {}; } }),
    telemetry: real({ emit: async () => { calls.push("telemetry"); }, queryWindow: async () => ({}) }),
    chaos: real({ executeFault: async () => { calls.push("chaos"); return {}; }, observeOriginal: async () => ({}), observeTopology: async () => ({}) }),
    durability: real({ inventory: async () => [], loseLocalState: async () => ({ status: "lost" }), createFreshInstance: async () => ({}) }),
    "security-host": real({ runSealedBuild: async () => ({}), runHostileMatrix: async () => ({}), runBrowser: async () => ({}), inspectSignerBoundary: async () => ({}) }),
    "supply-chain": real({ runBuild: async () => ({}), supplyChainInput: async () => ({}) }),
    "ContextVM-payment-model": real({ exerciseSignedTransport: async () => ({}), exerciseCep8Settlement: async () => ({}), reconcileOriginalModelOperation: async () => ({}) }),
    publication: real({ verifyPromotedSource: async () => ({}), submitOriginalPublication: async () => ({}), reconcileOriginalPublication: async () => ({}) }),
  });

  expect(native.providers()).toEqual([...RELEASE_PRODUCTION_PROVIDER_IDS]);
  expect(Object.keys(controller).sort()).toEqual([...RELEASE_PRODUCTION_PROVIDER_IDS].sort());
  expect(Object.keys(ports).sort()).toEqual(["ContextVM-payment-model", "admission", "chaos", "durability", "publication", "security-host", "supply-chain", "telemetry"]);
  expect(Object.values(ports).every((port) => port.evidenceClass === "real")).toBe(true);
  expect(calls).toEqual([]);
});

test("production tracer rejects a missing or wrong receipt before the provider adapter can apply", async () => {
  const calls: string[] = [];
  const registry = createNativeReleaseProviderRegistry({
    candidateSha256: digest("a"),
    providers: { cloud_run: provider(calls) },
  });

  await expect(registry.apply({ receipt: {}, operation: {}, approvedMaximumCostMicros: 1 })).rejects.toThrow("RELEASE_PROVIDER_AUTHORIZATION_INVALID");
  expect(calls).toEqual([]);
});

test("production composition rejects non-real protected ports before any suite can run", () => {
  expect(() => createProductionLiveProtectedCertificationPorts({
    admission: { evidenceClass: "deterministic", executeSample: async () => ({}) },
  } as never)).toThrow("PRODUCTION_LIVE_PORT_REAL_EVIDENCE_REQUIRED");
});
