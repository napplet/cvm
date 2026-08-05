import { expect, test } from "bun:test";
import { createHash } from "node:crypto";
import {
  DURABILITY_SUBJECT_KINDS,
  runRestoreDrill,
  validateTopologyClaim,
  type RestoreDrillInput,
} from "../../src/resilience/fault-harness";
import {
  GcsObjectStoreAdapter,
  GcsObjectStoreConfigSchema,
  type VersionedObjectClientPort,
} from "../../src/continuity/object-store";

const checksum = (bytes: Uint8Array) => createHash("sha256").update(bytes).digest("hex");
const encoded = new TextEncoder();
const ciphertext = encoded.encode("encrypted checkpoint bytes");
const archive = encoded.encode("restored workspace archive");

function restoreInput(overrides: Partial<RestoreDrillInput> = {}): RestoreDrillInput {
  const reference = { key: "checkpoints/checkpoint-1/object", generation: 17, checksum: checksum(ciphertext) };
  return {
    objectStore: {
      async createImmutable() { return reference; },
      async readExact(value) {
        return value.key === reference.key && value.generation === reference.generation && value.checksum === reference.checksum
          ? new Uint8Array(ciphertext)
          : undefined;
      },
      async scheduleExactDeletion() {},
    },
    subject: {
      kind: "checkpoint",
      sourceIdentity: "checkpoint-1",
      object: reference,
      payloadSha256: checksum(archive),
      ownerId: "owner-1",
      retentionUntil: "2030-01-01T00:00:00.000Z",
      deletionState: "retained",
    },
    expected: {
      ownerId: "owner-1",
      sessionId: "session-1",
      pendingActionReference: "action-1",
      sessionVersion: 4,
      artifactVersion: 3,
      leaseToken: "lease-1",
      compatibility: { policyVersion: "policy-1", modelIdentity: "model-1", nappletSdkIdentity: "sdk-1", toolchainIdentity: "toolchain-1" },
    },
    nowMs: Date.parse("2029-12-01T00:00:00.000Z"),
    async decryptAndVerify(bytes) {
      expect(bytes).toEqual(ciphertext);
      return {
        archive: new Uint8Array(archive),
        ownerId: "owner-1",
        sessionId: "session-1",
        pendingActionReference: "action-1",
        sessionVersion: 4,
        artifactVersion: 3,
        leaseToken: "lease-1",
        compatibility: { policyVersion: "policy-1", modelIdentity: "model-1", nappletSdkIdentity: "sdk-1", toolchainIdentity: "toolchain-1" },
      };
    },
    async reattach(input) {
      expect(input.archive).toEqual(archive);
      expect(input.sourceIdentity).toBe("checkpoint-1");
      return { status: "reattached", workerId: "existing-worker-1" };
    },
    ...overrides,
  };
}

test("fresh-instance drill reads an exact generation, verifies bytes and fences, then reattaches the existing claim", async () => {
  const result = await runRestoreDrill(restoreInput());
  expect(result).toEqual(expect.objectContaining({ status: "restored", code: "RESTORE_REATTACHED", reattachments: 1, effects: 0 }));
});

test("presence, corruption, owner/version/lease mutation, expiry, tombstone, and deletion races stop before decrypt or reattachment", async () => {
  for (const mutate of [
    (input: RestoreDrillInput) => ({ ...input, subject: { ...input.subject, object: { ...input.subject.object, checksum: "0".repeat(64) } } }),
    (input: RestoreDrillInput) => ({ ...input, subject: { ...input.subject, ownerId: "wrong-owner" } }),
    (input: RestoreDrillInput) => ({ ...input, expected: { ...input.expected, sessionVersion: 99 } }),
    (input: RestoreDrillInput) => ({ ...input, expected: { ...input.expected, leaseToken: "stale-lease" } }),
    (input: RestoreDrillInput) => ({ ...input, subject: { ...input.subject, retentionUntil: "2020-01-01T00:00:00.000Z" } }),
    (input: RestoreDrillInput) => ({ ...input, subject: { ...input.subject, deletionState: "tombstoned" as const } }),
    (input: RestoreDrillInput) => ({ ...input, objectStore: { ...input.objectStore, async readExact() { return undefined; } } }),
  ]) {
    let decrypts = 0;
    let reattachments = 0;
    const input = restoreInput();
    const result = await runRestoreDrill(mutate({
      ...input,
      decryptAndVerify: async (bytes) => { decrypts += 1; return input.decryptAndVerify(bytes); },
      reattach: async (value) => { reattachments += 1; return input.reattach(value); },
    }));
    expect(result.status).toBe("blocked");
    expect(result.reattachments).toBe(0);
    expect(reattachments).toBe(0);
    if (result.code === "RESTORE_OBJECT_CHECKSUM_MISMATCH" || result.code === "RESTORE_OBJECT_NOT_FOUND" || result.code === "RESTORE_EXPIRED_OR_DELETED") expect(decrypts).toBe(0);
  }
});

test("concurrent exact restore commands preserve one durable reattachment and replay the original result", async () => {
  let claimed = false;
  let calls = 0;
  const input = restoreInput({
    async reattach() {
      calls += 1;
      if (claimed) return { status: "replayed", workerId: "existing-worker-1" };
      claimed = true;
      return { status: "reattached", workerId: "existing-worker-1" };
    },
  });
  const [first, second] = await Promise.all([runRestoreDrill(input), runRestoreDrill(input)]);
  expect(calls).toBe(2);
  expect([first.status, second.status]).toContain("restored");
  expect([first.status, second.status]).toContain("replayed");
  expect(first.effects + second.effects).toBe(0);
});

test("every retained subject requires an exact object identity and blocked live topology remains non-pass", () => {
  expect(DURABILITY_SUBJECT_KINDS).toEqual([
    "checkpoint", "sealed_artifact", "validation_evidence", "usage_receipt", "promotion_evidence", "owner_event", "attestation",
  ]);
  expect(validateTopologyClaim({
    claimed: { ingressRegions: ["us-east1", "us-west1"], databaseRegions: ["us-east1"], objectRegions: ["us-east1"], workerRegions: ["us-east1"], relayRegions: ["us-east1"], activeStandby: "active-active", failureDomain: "region", rtoMs: 10, rpoMs: 0, limitations: [] },
    observation: { status: "blocked", reason: "PROTECTED_INFRASTRUCTURE_UNAVAILABLE" },
  })).toEqual(expect.objectContaining({ status: "blocked", code: "TOPOLOGY_NOT_OBSERVED" }));
});

test("the GCS-shaped adapter only permits exact generation/checksum client operations", async () => {
  const calls: string[] = [];
  const client: VersionedObjectClientPort = {
    async createIfAbsent(input) { calls.push(`create:${input.key}`); return { generation: 2, checksum: input.checksum }; },
    async readGeneration(input) { calls.push(`read:${input.key}:${input.generation}`); return { generation: input.generation, checksum: input.expectedChecksum, bytes: new Uint8Array(ciphertext) }; },
    async scheduleGenerationDeletion(input) { calls.push(`delete:${input.key}:${input.generation}`); return { generation: input.generation, checksum: input.expectedChecksum }; },
  };
  expect(GcsObjectStoreConfigSchema.safeParse({ bucket: "checkpoint-bucket", projectId: "project-1", credentials: "never" }).success).toBe(false);
  const store = new GcsObjectStoreAdapter({ config: { bucket: "checkpoint-bucket", projectId: "project-1" }, client });
  const reference = await store.createImmutable({ key: "checkpoints/a", bytes: ciphertext });
  await expect(store.readExact(reference)).resolves.toEqual(ciphertext);
  await store.scheduleExactDeletion(reference, "2030-01-01T00:00:00.000Z");
  expect(calls).toEqual(["create:checkpoints/a", "read:checkpoints/a:2", "delete:checkpoints/a:2"]);
});
