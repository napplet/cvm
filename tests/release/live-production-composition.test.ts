import { expect, test } from "bun:test";
import { unexecutedProtectedPorts } from "../fixtures/unexecuted-protected-ports";

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

const references = Object.fromEntries(RELEASE_PRODUCTION_PROVIDER_IDS.map((id) => [id, {
  reference: `provider:${id}:candidate`,
  referenceSha256: digest("b"),
}]));

test("production tracer constructs all controller providers and exact real ports without effects", async () => {
  const calls: string[] = [];
  const native = createNativeReleaseProviderRegistry({
    candidateSha256: digest("a"),
    providerReferences: references,
    providers: Object.fromEntries(RELEASE_PRODUCTION_PROVIDER_IDS.map((id) => [id, provider(calls)])),
  });
  const controller = createReleaseControllerProviderRegistry(native);
  const ports = createProductionLiveProtectedCertificationPorts(unexecutedProtectedPorts(() => calls.push("unexpected-protected-suite")));

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
    providerReferences: references,
    providers: { cloud_run: provider(calls) },
  });

  await expect(registry.apply({ receipt: {}, operation: {}, approvedMaximumCostMicros: 1 })).rejects.toThrow("RELEASE_PROVIDER_AUTHORIZATION_INVALID");
  expect(calls).toEqual([]);
});

test("production registry has a blocked family for absent injected capability, never an unimplemented-family fallback", async () => {
  const registry = createNativeReleaseProviderRegistry({ candidateSha256: digest("a"), providerReferences: references });
  await expect(registry.discover("model")).resolves.toMatchObject({
    provider: "model", capability: "unavailable", authentication: "unavailable", reasonCode: "AUTHORIZATION_REQUIRED",
  });
});

test("production composition rejects non-real protected ports before any suite can run", () => {
  expect(() => createProductionLiveProtectedCertificationPorts({
    admission: { evidenceClass: "deterministic", executeSample: async () => ({}) },
  } as never)).toThrow("PRODUCTION_LIVE_PORT_REAL_EVIDENCE_REQUIRED");
});
