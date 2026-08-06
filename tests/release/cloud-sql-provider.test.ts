import { expect, test } from "bun:test";
import { createAuthorizationReceipt, createAuthorizationRequest } from "../../src/release/authorization";
import { createNativeCloudSqlPostgresProvider, type CloudSqlPostgresControlPlanePort } from "../../src/release/native/cloud-sql-postgres";

const digest = (letter: string) => letter.repeat(64);
const now = 1_000;

async function authorized() {
  const config = {
    candidateSha256: digest("a"), topologySha256: digest("b"), effectPlanSha256: digest("c"),
    accountScopeSha256: digest("d"), projectScopeSha256: digest("e"), projectId: "napplet-cvm-sql-1",
    region: "europe-west1", instanceId: "napplet-authority", engineVersion: "POSTGRES_17",
    availabilityType: "REGIONAL" as const, storageGb: 100, backupEnabled: true,
    privateNetworkReferenceSha256: digest("f"), serviceAccountReferenceSha256: digest("1"),
  };
  const request = await createAuthorizationRequest({
    candidateSha256: config.candidateSha256, topologySha256: config.topologySha256, effectPlanSha256: config.effectPlanSha256,
    controllerStateSha256: digest("2"), providerCapabilitiesSha256: digest("3"),
    orderedEffects: [{ id: "database", provider: "cloud_sql_postgres", operation: "create_or_update", estimatedCostMicros: 1 }],
    providerScopes: [{ provider: "cloud_sql_postgres", accountScopeSha256: config.accountScopeSha256, projectScopeSha256: config.projectScopeSha256 }],
    estimate: { currency: "USD", maximumMicros: 1, sourceId: "gcp-catalog", observedAtMs: 1, freshUntilMs: 10_000 },
    maximumRunDurationMs: 1_000, cleanupByMs: 9_000, evidenceRetentionDays: 30, artifactRetentionDays: 30,
    gcpEffects: { projectBootstrap: true, billing: true, apiEnablement: ["sqladmin.googleapis.com"] }, expiresAtMs: 9_000,
  });
  return { config, request, receipt: await createAuthorizationReceipt(request) };
}

function port(transcript: string[], provisioned = new Set<string>()): CloudSqlPostgresControlPlanePort {
  return {
    persist: async ({ operationId }) => { transcript.push(`persist:${operationId}`); },
    observeInstance: async ({ operationId, projectId, region, instanceId }) => {
      transcript.push(`observe:${operationId}:${projectId}:${region}:${instanceId}`);
      if (!provisioned.has(operationId)) return { status: "missing" };
      return { status: "completed", operationId, projectId, region, instanceId, engineVersion: "POSTGRES_17", availabilityType: "REGIONAL", storageGb: 100, backupEnabled: true, privateNetworkReferenceSha256: digest("f"), serviceAccountReferenceSha256: digest("1") };
    },
    createInstance: async ({ operationId, projectId, region, instanceId }) => { transcript.push(`create:${operationId}:${projectId}:${region}:${instanceId}`); provisioned.add(operationId); },
    probeSerializable: async ({ operationId, instanceId }) => { transcript.push(`probe:${operationId}:${instanceId}`); return { status: "completed", operationId, isolationLevel: "serializable", duplicateEffectCount: 0 }; },
    deleteInstance: async ({ operationId, projectId, region, instanceId }) => { transcript.push(`delete:${operationId}:${projectId}:${region}:${instanceId}`); provisioned.delete(operationId); },
  };
}

test("plans with zero effects, then observes exact HA topology and a serializable duplicate-effect probe after receipt revalidation", async () => {
  const transcript: string[] = [];
  const { config, request, receipt } = await authorized();
  const provider = createNativeCloudSqlPostgresProvider({ config, port: port(transcript), now: () => now });
  const input = { request, receipt, operationId: "cloud-sql-1" };

  await expect(provider.plan(input)).resolves.toMatchObject({ status: "planned", authority: "cloud_sql_postgres", engineVersion: "POSTGRES_17", availabilityType: "REGIONAL" });
  expect(transcript).toEqual([]);
  await provider.apply(input);
  await expect(provider.observe(input)).resolves.toMatchObject({ status: "completed", serializable: true, duplicateEffectCount: 0, resourceIdentitySha256: expect.stringMatching(/^[a-f0-9]{64}$/) });
  expect(transcript).toEqual(expect.arrayContaining(["persist:cloud-sql-1", "create:cloud-sql-1:napplet-cvm-sql-1:europe-west1:napplet-authority", "probe:cloud-sql-1:napplet-authority"]));
});

test("reconciles the original authority operation, rejects invalid approval before effects, and limits cleanup to the selected instance", async () => {
  const transcript: string[] = [];
  const { config, request, receipt } = await authorized();
  const provider = createNativeCloudSqlPostgresProvider({ config, port: port(transcript, new Set(["cloud-sql-1"])), now: () => now });
  const input = { request, receipt, operationId: "cloud-sql-1" };

  await expect(provider.apply({ ...input, receipt: { ...receipt, authorizationReceiptSha256: digest("9") } })).rejects.toThrow("CLOUD_SQL_POSTGRES_AUTHORIZATION_INVALID");
  expect(transcript).toEqual([]);
  await expect(provider.apply(input)).resolves.toMatchObject({ status: "completed", reused: true });
  expect(transcript.some((entry) => entry.startsWith("create:"))).toBeFalse();
  await expect(provider.cleanup({ ...input, runOwnedInstanceId: "another-instance" })).rejects.toThrow("CLOUD_SQL_POSTGRES_CLEANUP_SCOPE_INVALID");
  await provider.cleanup({ ...input, runOwnedInstanceId: config.instanceId });
  expect(transcript.at(-1)).toBe("delete:cloud-sql-1:cleanup:napplet-cvm-sql-1:europe-west1:napplet-authority");
});

test("revalidates the exact receipt immediately before provisioning after reconciliation", async () => {
  let clock = now;
  const transcript: string[] = [];
  const { config, request, receipt } = await authorized();
  const base = port(transcript);
  const provider = createNativeCloudSqlPostgresProvider({ config, port: { ...base, observeInstance: async () => { clock = 9_000; return { status: "missing" as const }; } }, now: () => clock });
  await expect(provider.apply({ request, receipt, operationId: "cloud-sql-1" })).rejects.toThrow("CLOUD_SQL_POSTGRES_AUTHORIZATION_INVALID");
  expect(transcript.some((entry) => entry.startsWith("create:"))).toBeFalse();
});
