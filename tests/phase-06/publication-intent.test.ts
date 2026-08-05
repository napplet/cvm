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
import { verifiedPhase06Artifact } from "./fakes.js";

const ownerPubkey = "1".repeat(64);
const createdAtMs = 1_700_000_000_000;
const expiresAtMs = createdAtMs + 300_000;

async function input(runtimeVariant = "napplet-host/v1") {
  const review = await canonicalCapabilityReview(verifiedPhase06Artifact, runtimeVariant);
  return {
    accountId: verifiedPhase06Artifact.accountId,
    sessionId: verifiedPhase06Artifact.sessionId,
    artifact: verifiedPhase06Artifact,
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
  const changed = { ...baseline, artifact: { ...baseline.artifact, aggregateSha256: "f".repeat(64) } };
  expect(publicationIntentFingerprint(baseline)).not.toBe(publicationIntentFingerprint(changed));
});
