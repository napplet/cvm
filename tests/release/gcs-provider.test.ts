import { expect, test } from "bun:test";
import { createAuthorizationReceipt, createAuthorizationRequest } from "../../src/release/authorization";
import { createNativeGcsProvider, type GcsControlPlanePort } from "../../src/release/native/gcs";

const digest = (letter: string) => letter.repeat(64);
const now = 1_000;
const bytes = new TextEncoder().encode("durable checkpoint archive");

async function authorized() {
  const config = {
    candidateSha256: digest("a"), topologySha256: digest("b"), effectPlanSha256: digest("c"),
    accountScopeSha256: digest("d"), projectScopeSha256: digest("e"), projectId: "napplet-cvm-gcs-1",
    bucket: "napplet-cvm-durable", dualRegion: "nam4", versioning: true, retentionDays: 30,
    namespace: "runs/gcs-run-1/",
  };
  const request = await createAuthorizationRequest({
    candidateSha256: config.candidateSha256, topologySha256: config.topologySha256, effectPlanSha256: config.effectPlanSha256,
    controllerStateSha256: digest("2"), providerCapabilitiesSha256: digest("3"),
    orderedEffects: [{ id: "gcs-retention", provider: "gcs", operation: "configure", estimatedCostMicros: 1 }],
    providerScopes: [{ provider: "gcs", accountScopeSha256: config.accountScopeSha256, projectScopeSha256: config.projectScopeSha256 }],
    estimate: { currency: "USD", maximumMicros: 1, sourceId: "gcp-catalog", observedAtMs: 1, freshUntilMs: 10_000 },
    maximumRunDurationMs: 1_000, cleanupByMs: 9_000, evidenceRetentionDays: 30, artifactRetentionDays: 30,
    gcpEffects: { projectBootstrap: true, billing: true, apiEnablement: ["storage.googleapis.com"] }, expiresAtMs: 9_000,
  });
  return { config, request, receipt: await createAuthorizationReceipt(request) };
}

function port(transcript: string[], objects = new Map<string, { generation: number; checksum: string; bytes: Uint8Array }>()): GcsControlPlanePort {
  let bucketReady = false;
  return {
    persist: async ({ operationId }) => { transcript.push(`persist:${operationId}`); },
    observeBucket: async () => bucketReady ? { status: "completed", projectId: "napplet-cvm-gcs-1", bucket: "napplet-cvm-durable", dualRegion: "nam4", versioning: true, retentionDays: 30 } : { status: "missing" },
    createBucket: async ({ operationId }) => { transcript.push(`bucket:${operationId}`); bucketReady = true; },
    createIfAbsent: async ({ key, bytes: objectBytes, checksum }) => {
      transcript.push(`create:${key}`);
      const existing = objects.get(key);
      if (existing) return { generation: existing.generation, checksum: existing.checksum };
      objects.set(key, { generation: 1, checksum, bytes: new Uint8Array(objectBytes) });
      return { generation: 1, checksum };
    },
    findExactByKey: async ({ key, checksum }) => { const object = objects.get(key); return object && object.checksum === checksum ? { generation: object.generation, checksum: object.checksum } : undefined; },
    readGeneration: async ({ key, generation, expectedChecksum }) => {
      transcript.push(`read:${key}:${generation}`);
      const object = objects.get(key);
      return object && object.generation === generation && object.checksum === expectedChecksum ? { ...object, bytes: new Uint8Array(object.bytes) } : undefined;
    },
    scheduleGenerationDeletion: async ({ key, generation, expectedChecksum }) => {
      transcript.push(`delete:${key}:${generation}`);
      const object = objects.get(key);
      if (!object || object.generation !== generation || object.checksum !== expectedChecksum) throw new Error("exact generation required");
      return { generation, checksum: expectedChecksum };
    },
  };
}

test("plans with zero effects, then writes content-addressed generation-pinned objects after exact receipt revalidation", async () => {
  const transcript: string[] = [];
  const { config, request, receipt } = await authorized();
  const provider = createNativeGcsProvider({ config, port: port(transcript), now: () => now });
  const input = { request, receipt, operationId: "gcs-run-1" };

  await expect(provider.plan(input)).resolves.toMatchObject({ status: "planned", dualRegion: "nam4", versioning: true, retentionDays: 30 });
  expect(transcript).toEqual([]);
  const object = await provider.createObject({ ...input, bytes });
  expect(object.generation).toBe(1);
  expect(object.checksum).toMatch(/^[a-f0-9]{64}$/);
  expect(object.key).toMatch(/^runs\/gcs-run-1\/[a-f0-9]{64}$/);
  expect(await provider.objectStore.readExact(object)).toEqual(bytes);
  expect(transcript).toEqual(expect.arrayContaining(["persist:gcs-run-1", "bucket:gcs-run-1", `create:${object.key}`, `read:${object.key}:1`]));
});

test("uses the original object operation on retry, rejects stale approval before object mutation, and scopes cleanup to the run namespace", async () => {
  const transcript: string[] = [];
  const { config, request, receipt } = await authorized();
  const provider = createNativeGcsProvider({ config, port: port(transcript), now: () => now });
  const input = { request, receipt, operationId: "gcs-run-1" };

  await expect(provider.createObject({ ...input, receipt: { ...receipt, authorizationReceiptSha256: digest("9") }, bytes })).rejects.toThrow("GCS_AUTHORIZATION_INVALID");
  expect(transcript).toEqual([]);
  const first = await provider.createObject({ ...input, bytes });
  const retry = await provider.createObject({ ...input, bytes });
  expect(retry).toEqual(first);
  expect(transcript.filter((entry) => entry.startsWith("create:")).length).toBe(2);
  await expect(provider.cleanup({ ...input, runOwnedNamespace: "runs/other/", objects: [first] })).rejects.toThrow("GCS_CLEANUP_SCOPE_INVALID");
  await provider.cleanup({ ...input, runOwnedNamespace: config.namespace, objects: [first] });
  expect(transcript.at(-1)).toBe(`delete:${first.key}:1`);
});

test("revalidates the exact receipt immediately before bucket creation after observation", async () => {
  let clock = now;
  const transcript: string[] = [];
  const { config, request, receipt } = await authorized();
  const base = port(transcript);
  const provider = createNativeGcsProvider({ config, port: { ...base, observeBucket: async () => { clock = 9_000; return { status: "missing" as const }; } }, now: () => clock });
  await expect(provider.createObject({ request, receipt, operationId: "gcs-run-1", bytes })).rejects.toThrow("GCS_AUTHORIZATION_INVALID");
  expect(transcript.some((entry) => entry.startsWith("bucket:") || entry.startsWith("create:"))).toBeFalse();
});
