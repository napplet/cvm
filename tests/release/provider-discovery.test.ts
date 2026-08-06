import { expect, test } from "bun:test";
import {
  createReleaseProviderRegistry,
  type ReleaseAuthorizationReceipt,
} from "../../src/release/providers";

const digest = (letter: string) => letter.repeat(64);

function receipt(): ReleaseAuthorizationReceipt {
  return {
    version: 1,
    authorizationRequestSha256: digest("a"),
    authorizationReceiptSha256: digest("b"),
    candidateSha256: digest("c"),
    topologySha256: digest("d"),
    effectPlanSha256: digest("e"),
    maximumAuthorizedCostMicros: 100,
    expiresAtMs: 10_000,
  };
}

function operation() {
  return {
    version: 1 as const,
    operationId: "release-op-1",
    provider: "cloud_run" as const,
    effectId: "cloud-run-ingress",
    operation: "create_or_update" as const,
    region: "europe-west1",
    desiredDigest: digest("f"),
    candidateSha256: digest("c"),
    authorizationRequestSha256: digest("a"),
  };
}

test("registry owns every required provider and exposes only finite redacted discovery facts", async () => {
  let liveCalls = 0;
  const registry = createReleaseProviderRegistry({
    ports: {
      cloud_run: {
        discoverCapabilities: async () => ({ capability: "available", accountScopeSha256: digest("a") }),
        discoverAuthentication: async () => ({ authentication: "authorized", costEstimateSha256: digest("b"), secretReferenceNames: ["cloud-run-identity"] }),
        plan: async () => { liveCalls += 1; return { status: "planned", estimatedCostMicros: 10 }; },
        apply: async () => { liveCalls += 1; return { status: "applied", actualCostMicros: 10, resourceIdentity: "service/projects/example" }; },
        observe: async () => ({ status: "completed", actualCostMicros: 10, resourceIdentity: "service/projects/example" }),
        cleanup: async () => ({ status: "cleaned", actualCostMicros: 0 }),
      },
    },
    now: () => 1_000,
  });

  expect(registry.providers()).toHaveLength(16);
  const discovery = await registry.discover("cloud_run");
  expect(discovery).toEqual(expect.objectContaining({
    capability: "available",
    authentication: "authorized",
    accountScopeSha256: digest("a"),
    costEstimateSha256: digest("b"),
    secretReferenceNames: ["cloud-run-identity"],
  }));
  expect(JSON.stringify(discovery)).not.toContain("token=canary");

  const planned = await registry.plan({ receipt: receipt(), operation: operation() });
  expect(planned.status).toBe("planned");
  expect(liveCalls).toBe(1);
  const applied = await registry.apply({ receipt: receipt(), operation: operation(), approvedMaximumCostMicros: 100 });
  expect(applied).toEqual(expect.objectContaining({ status: "applied", actualCostMicros: 10 }));
  expect(applied.resourceIdentitySha256).not.toBe(digest("0"));
  expect(liveCalls).toBe(2);
});

test("mutation authorization, approved scope, operation identity, and cost are fail-closed", async () => {
  let applies = 0;
  const registry = createReleaseProviderRegistry({
    ports: {
      cloud_run: {
        discoverCapabilities: async () => ({ capability: "available" }),
        discoverAuthentication: async () => ({ authentication: "authorized" }),
        plan: async () => ({ status: "planned", estimatedCostMicros: 10 }),
        apply: async () => { applies += 1; return { status: "applied", actualCostMicros: 101, resourceIdentity: "secret-resource" }; },
        observe: async () => ({ status: "unknown" }),
        cleanup: async () => ({ status: "cleaned", actualCostMicros: 0 }),
      },
    },
    now: () => 1_000,
  });

  await expect(registry.apply({ receipt: { ...receipt(), expiresAtMs: 999 }, operation: operation(), approvedMaximumCostMicros: 100 })).rejects.toThrow("RELEASE_PROVIDER_AUTHORIZATION_INVALID");
  await expect(registry.apply({ receipt: receipt(), operation: { ...operation(), candidateSha256: digest("9") }, approvedMaximumCostMicros: 100 })).rejects.toThrow("RELEASE_PROVIDER_AUTHORIZATION_INVALID");
  await expect(registry.apply({ receipt: receipt(), operation: operation(), approvedMaximumCostMicros: 100 })).rejects.toThrow("RELEASE_PROVIDER_COST_EXCEEDED");
  expect(applies).toBe(1);
});

test("ambiguous provider outcomes are observed only through the original operation identity", async () => {
  const observed: string[] = [];
  const registry = createReleaseProviderRegistry({
    ports: {
      cloud_run: {
        discoverCapabilities: async () => ({ capability: "available" }),
        discoverAuthentication: async () => ({ authentication: "authorized" }),
        plan: async () => ({ status: "planned", estimatedCostMicros: 1 }),
        apply: async () => ({ status: "unknown" }),
        observe: async (input) => { observed.push(input.operationId); return { status: "completed", actualCostMicros: 1, resourceIdentity: "resource-1" }; },
        cleanup: async () => ({ status: "cleaned", actualCostMicros: 0 }),
      },
    },
    now: () => 1_000,
  });

  const result = await registry.observe({ receipt: receipt(), operation: operation(), approvedMaximumCostMicros: 100 });
  expect(result.status).toBe("completed");
  expect(observed).toEqual(["release-op-1"]);
});
