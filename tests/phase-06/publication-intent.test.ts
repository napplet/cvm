import { expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  canonicalOwnerManifestTemplate,
  canonicalPublicationIntentBytes,
  createPublicationIntent,
  isPublicationIntentExpired,
  normalizePublicationDTag,
  publicationIntentFingerprint,
} from "../../src/publication/publication-intent.js";
import { canonicalCapabilityReview } from "../../src/publication/capability-review.js";
import { PublicationService } from "../../src/publication/publication-service.js";
import { TransactionalMemoryPublicationStore } from "../../src/persistence/publication-store.js";
import { SqlitePublicationStore } from "../../src/persistence/sqlite-publication-store.js";
import { verifiedPhase06Artifact } from "./fakes.js";
import { reportPhase06Observation } from "./reference-observation.js";

const ownerPubkey = "1".repeat(64);
const createdAtMs = 1_700_000_000_000;
const expiresAtMs = createdAtMs + 300_000;

async function input(runtimeVariant = "napplet-host/v1") {
  const manifestCapabilities = verifiedPhase06Artifact.manifestCapabilities;
  if (!manifestCapabilities) throw new Error("PHASE06_MANIFEST_CAPABILITIES_MISSING");
  const artifact = {
    ...verifiedPhase06Artifact,
    manifestCapabilities: manifestCapabilities.map((capability) => ({ ...capability, compatibleRuntimes: capability.requirement === "required" ? ["napplet-host/v1", "napplet-host/v2"] : [] })),
  };
  const review = await canonicalCapabilityReview(artifact, runtimeVariant);
  return {
    accountId: artifact.accountId,
    sessionId: artifact.sessionId,
    artifact,
    review,
    ownerPubkey,
    idempotencyKey: "publication:phase-06:one",
    purpose: "Publish the verified napplet",
    consent: "approved" as const,
    runtimeVariant,
    createdAtMs,
    expiresAtMs,
  };
}

test("canonicalizes every approved fence into a stable normalized intent and unsigned named template", async () => {
  const first = await input();
  const second = await input();
  const intent = createPublicationIntent(first);
  const replay = createPublicationIntent(second);

  expect(normalizePublicationDTag("  Phase_06--Napplet  ")).toBe("phase-06-napplet");
  expect(Array.from(canonicalPublicationIntentBytes(first))).toEqual(Array.from(canonicalPublicationIntentBytes(second)));
  expect(publicationIntentFingerprint(first)).toBe(intent.fingerprint);
  expect(intent).toMatchObject({
    intentId: `intent:${intent.fingerprint}`,
    ownerPubkey,
    capabilityDigest: first.review.capabilityDigest,
    runtimeVariant: "napplet-host/v1",
    expiresAtMs,
  });
  expect(replay).toEqual(intent);
  expect(canonicalOwnerManifestTemplate(intent)).toMatchObject({
    kind: 35129,
    pubkey: ownerPubkey,
    tags: [
      ["d", "phase-06-napplet"],
      ["x", verifiedPhase06Artifact.aggregateSha256],
      ["manifest", verifiedPhase06Artifact.manifestSha256],
      ["capability", first.review.capabilityDigest],
      ["intent", intent.intentId],
      ["expires-at-ms", `${expiresAtMs}`],
    ],
  });
});

test("keeps runtime variation inside the capability approval while retaining exact intent fences", async () => {
  const primary = createPublicationIntent(await input("napplet-host/v1"));
  const alternate = createPublicationIntent(await input("napplet-host/v2"));

  expect(primary.artifact).toEqual(alternate.artifact);
  expect(primary.ownerPubkey).toBe(alternate.ownerPubkey);
  expect(primary.capabilityDigest).not.toBe(alternate.capabilityDigest);
  expect(primary.intentId).not.toBe(alternate.intentId);
  reportPhase06Observation({ id: "P06-RUNTIME-VARIANTS-01", status: "canonical", effects: "deploy=0", value: "fenced" });
});

test("uses an exact millisecond expiry fence with no tolerance", async () => {
  const intent = createPublicationIntent(await input());
  expect(isPublicationIntentExpired(intent, expiresAtMs - 1)).toBeFalse();
  expect(isPublicationIntentExpired(intent, expiresAtMs)).toBeTrue();
  expect(isPublicationIntentExpired(intent, expiresAtMs + 1)).toBeTrue();
  reportPhase06Observation({ id: "P06-EXPIRY-BEFORE-01", status: "eligible", effects: "deploy=0", value: "integer-ms" });
  reportPhase06Observation({ id: "P06-EXPIRY-EXACT-01", status: "denied", effects: "deploy=0", value: "integer-ms" });
  reportPhase06Observation({ id: "P06-EXPIRY-AFTER-01", status: "denied", effects: "deploy=0", value: "integer-ms" });
});

test("rejects malformed normalized d-tags and changed approved fences", async () => {
  expect(() => normalizePublicationDTag("root/site")).toThrow("PUBLICATION_D_TAG_INVALID");
  const baseline = await input();
  const changed = { ...baseline, purpose: "Publish a different approved purpose" };
  expect(publicationIntentFingerprint(baseline)).not.toBe(publicationIntentFingerprint(changed));
});

test("recomputes the capability approval from the sealed artifact instead of trusting caller review fields", async () => {
  const baseline = await input();
  const forged = {
    artifactId: baseline.artifact.artifactId,
    aggregateSha256: baseline.artifact.aggregateSha256,
    normalizedDTag: baseline.artifact.normalizedDTag,
    runtimeVariant: baseline.runtimeVariant,
    required: [],
    optional: [],
    compatibility: "compatible" as const,
    capabilityDigest: "f".repeat(64),
  };
  expect(() => createPublicationIntent({ ...baseline, review: forged })).toThrow("PUBLICATION_APPROVAL_BINDING_INVALID");
});

test("persists exact idempotent replay and closes changed-fence key reuse", async () => {
  const store = new TransactionalMemoryPublicationStore();
  const service = new PublicationService({
    store,
    clock: { nowMs: () => createdAtMs },
    verifier: { verify: async () => ({ accepted: true, eventId: "e".repeat(64) }) },
    deployment: { deployExact: async (input) => ({ operationId: input.operationId, state: "completed", observationId: "deploy" }), publishOwnerManifest: async (input) => ({ operationId: input.operationId, state: "completed", observationId: "owner" }) },
    attestation: { publish: async (input) => ({ operationId: input.operationId, state: "completed", observationId: "attestation" }) },
  });
  const request = await input();
  const first = await service.createIntent(request);
  const replay = await service.createIntent(request);
  expect(replay).toEqual(first);
  await expect(service.createIntent({ ...request, purpose: "Changed after approval" })).rejects.toThrow("PUBLICATION_IDEMPOTENCY_CONFLICT");
  reportPhase06Observation({ id: "P06-CONFLICT-01", status: "conflict", effects: "deploy=0", value: "closed" });
});

test("replays the same idempotency command after the coordinator clock advances on memory and SQLite", async () => {
  const directory = mkdtempSync(join(tmpdir(), "napplet-publication-idempotency-"));
  const sqlite = new SqlitePublicationStore(join(directory, "publication.sqlite"));
  try {
    for (const store of [new TransactionalMemoryPublicationStore(), sqlite]) {
      let now = createdAtMs;
      const service = new PublicationService({
        store,
        clock: { nowMs: () => now },
        verifier: { verify: async () => ({ valid: true, eventId: "e".repeat(64) }) },
        deployment: { deployExact: async (input) => ({ operationId: input.operationId, state: "completed" as const, observationId: "deploy" }), publishOwnerManifest: async (input) => ({ operationId: input.operationId, state: "completed" as const, observationId: "owner" }) },
        attestation: { publish: async (input) => ({ operationId: input.operationId, state: "completed" as const, observationId: "attestation" }) },
      });
      const request = await input();
      const first = await service.createIntent(request);
      now += 5_000;
      expect(await service.createIntent(request)).toEqual(first);
    }
  } finally {
    sqlite.close();
    rmSync(directory, { recursive: true, force: true });
  }
});
