import { expect, test } from "bun:test";
import { createAuthorizationReceipt, createAuthorizationRequest } from "../../src/release/authorization";
import { createNativeCloudRunProvider, type CloudRunControlPlanePort } from "../../src/release/native/cloud-run";

const digest = (letter: string) => letter.repeat(64);
const now = 1_000;

async function authorized() {
  const config = {
    candidateSha256: digest("a"), topologySha256: digest("b"), effectPlanSha256: digest("c"),
    accountScopeSha256: digest("d"), projectScopeSha256: digest("e"), projectId: "napplet-cvm-run-1",
    serviceName: "napplet-control", serviceAccountReference: "serviceAccounts/control@napplet-cvm-run-1.iam.gserviceaccount.com",
    imageDigest: `sha256:${digest("f")}`, environmentReferenceSha256: digest("1"), minimumInstances: 3,
    ingress: "internal-and-cloud-load-balancing" as const, concurrency: 80, admissionRefusal: "capacity_unavailable" as const,
  };
  const request = await createAuthorizationRequest({
    candidateSha256: config.candidateSha256, topologySha256: config.topologySha256, effectPlanSha256: config.effectPlanSha256,
    controllerStateSha256: digest("2"), providerCapabilitiesSha256: digest("3"),
    orderedEffects: [{ id: "cloud-run-ingress", provider: "cloud_run", operation: "create_or_update", estimatedCostMicros: 1 }],
    providerScopes: [{ provider: "cloud_run", accountScopeSha256: config.accountScopeSha256, projectScopeSha256: config.projectScopeSha256 }],
    estimate: { currency: "USD", maximumMicros: 1, sourceId: "gcp-catalog", observedAtMs: 1, freshUntilMs: 10_000 },
    maximumRunDurationMs: 1_000, cleanupByMs: 9_000, evidenceRetentionDays: 30, artifactRetentionDays: 30,
    gcpEffects: { projectBootstrap: true, billing: true, apiEnablement: ["run.googleapis.com"] }, expiresAtMs: 9_000,
  });
  return { config, request, receipt: await createAuthorizationReceipt(request) };
}

function port(transcript: string[], deployed = new Set<string>()): CloudRunControlPlanePort {
  return {
    persist: async ({ operationId }) => { transcript.push(`persist:${operationId}`); },
    observe: async ({ operationId, projectId, region, serviceName }) => {
      transcript.push(`observe:${operationId}:${projectId}:${region}:${serviceName}`);
      if (!deployed.has(operationId)) return { status: "missing" };
      return { status: "completed", operationId, projectId, region, serviceName, revisionName: "napplet-control-00001-abc", imageDigest: `sha256:${digest("f")}`, serviceAccountReference: "serviceAccounts/control@napplet-cvm-run-1.iam.gserviceaccount.com", environmentReferenceSha256: digest("1"), minimumInstances: 3, ingress: "internal-and-cloud-load-balancing", concurrency: 80, admissionRefusal: "capacity_unavailable", generationQueueResourceCount: 0 };
    },
    deploy: async ({ operationId, projectId, region, serviceName }) => { transcript.push(`deploy:${operationId}:${projectId}:${region}:${serviceName}`); deployed.add(operationId); },
    deleteService: async ({ operationId, projectId, region, serviceName }) => { transcript.push(`delete:${operationId}:${projectId}:${region}:${serviceName}`); deployed.delete(operationId); },
  };
}

test("plans read-only, deploys only after exact receipt revalidation, and observes the exact candidate-bound revision without a queue", async () => {
  const transcript: string[] = [];
  const { config, request, receipt } = await authorized();
  const provider = createNativeCloudRunProvider({ config, port: port(transcript), now: () => now });
  const input = { request, receipt, operationId: "cloud-run-1", region: "europe-west1" };

  await expect(provider.plan(input)).resolves.toMatchObject({ status: "planned", minimumInstances: 3, generationQueue: "absent" });
  expect(transcript).toEqual([]);
  await provider.apply(input);
  await expect(provider.observe(input)).resolves.toMatchObject({ status: "completed", revisionSha256: expect.stringMatching(/^[a-f0-9]{64}$/) });
  expect(transcript).toEqual([
    "persist:cloud-run-1", "observe:cloud-run-1:napplet-cvm-run-1:europe-west1:napplet-control", "deploy:cloud-run-1:napplet-cvm-run-1:europe-west1:napplet-control",
    "observe:cloud-run-1:napplet-cvm-run-1:europe-west1:napplet-control",
  ]);
});

test("reuses the original operation on retry, rejects invalid receipts before effects, and only cleans the run-owned service", async () => {
  const transcript: string[] = [];
  const deployed = new Set(["cloud-run-1"]);
  const { config, request, receipt } = await authorized();
  const provider = createNativeCloudRunProvider({ config, port: port(transcript, deployed), now: () => now });
  const input = { request, receipt, operationId: "cloud-run-1", region: "europe-west1" };

  await expect(provider.apply({ ...input, receipt: { ...receipt, authorizationReceiptSha256: digest("9") } })).rejects.toThrow("CLOUD_RUN_AUTHORIZATION_INVALID");
  expect(transcript).toEqual([]);
  await expect(provider.apply(input)).resolves.toMatchObject({ status: "completed", reused: true });
  expect(transcript.some((entry) => entry.startsWith("deploy:"))).toBeFalse();
  await expect(provider.cleanup({ ...input, runOwnedServiceName: "another-service" })).rejects.toThrow("CLOUD_RUN_CLEANUP_SCOPE_INVALID");
  await provider.cleanup({ ...input, runOwnedServiceName: config.serviceName });
  expect(transcript.at(-1)).toBe("delete:cloud-run-1:cleanup:napplet-cvm-run-1:europe-west1:napplet-control");
});

test("revalidates the exact receipt immediately before deployment after reconciliation", async () => {
  let clock = now;
  const transcript: string[] = [];
  const { config, request, receipt } = await authorized();
  const base = port(transcript);
  const provider = createNativeCloudRunProvider({ config, port: { ...base, observe: async (input) => { clock = 9_000; return base.observe(input); } }, now: () => clock });
  await expect(provider.apply({ request, receipt, operationId: "cloud-run-1", region: "europe-west1" })).rejects.toThrow("CLOUD_RUN_AUTHORIZATION_INVALID");
  expect(transcript.some((entry) => entry.startsWith("deploy:"))).toBeFalse();
});
