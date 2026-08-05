import { expect, test } from "bun:test";

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
import { verifiedPhase06Artifact } from "./fakes.js";

const ownerPubkey = "1".repeat(64);
const createdAtMs = 1_700_000_000_000;
const expiresAtMs = createdAtMs + 300_000;

async function input(runtimeVariant = "napplet-host/v1") {
  const artifact = {
    ...verifiedPhase06Artifact,
    manifestCapabilities: verifiedPhase06Artifact.manifestCapabilities.map((capability) => ({ ...capability, compatibleRuntimes: capability.requirement === "required" ? ["napplet-host/v1", "napplet-host/v2"] : [] })),
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
});

test("uses an exact millisecond expiry fence with no tolerance", async () => {
  const intent = createPublicationIntent(await input());
  expect(isPublicationIntentExpired(intent, expiresAtMs - 1)).toBeFalse();
  expect(isPublicationIntentExpired(intent, expiresAtMs)).toBeTrue();
  expect(isPublicationIntentExpired(intent, expiresAtMs + 1)).toBeTrue();
});

test("rejects malformed normalized d-tags and changed approved fences", async () => {
  expect(() => normalizePublicationDTag("root/site")).toThrow("PUBLICATION_D_TAG_INVALID");
  const baseline = await input();
  const changed = { ...baseline, purpose: "Publish a different approved purpose" };
  expect(publicationIntentFingerprint(baseline)).not.toBe(publicationIntentFingerprint(changed));
});

test("persists exact idempotent replay and closes changed-fence key reuse", async () => {
  const store = new TransactionalMemoryPublicationStore();
  const service = new PublicationService({
    store,
    clock: { nowMs: () => createdAtMs },
    verifier: { verify: async () => ({ accepted: true, eventId: "e".repeat(64) }) },
    deployment: { deployExact: async () => ({ state: "completed", observationId: "deploy" }), publishOwnerManifest: async () => ({ state: "completed", observationId: "owner" }) },
    attestation: { publish: async () => ({ state: "completed", observationId: "attestation" }) },
  });
  const request = await input();
  const first = await service.createIntent(request);
  const replay = await service.createIntent(request);
  expect(replay).toEqual(first);
  await expect(service.createIntent({ ...request, purpose: "Changed after approval" })).rejects.toThrow("PUBLICATION_IDEMPOTENCY_CONFLICT");
});
