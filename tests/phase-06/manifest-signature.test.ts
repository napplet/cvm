import { expect, test } from "bun:test";
import { finalizeEvent, getPublicKey } from "nostr-tools/pure";

import { buildCvmAttestation } from "../../src/publication/attestation-event.js";
import { NostrToolsOwnerEventVerifier, verifyOwnerManifestEvent } from "../../src/publication/manifest-event.js";
import { canonicalCapabilityReview } from "../../src/publication/capability-review.js";
import { canonicalOwnerManifestTemplate, createPublicationIntent } from "../../src/publication/publication-intent.js";
import { verifiedPhase06Artifact } from "./fakes.js";

const secret = Uint8Array.from({ length: 32 }, (_, index) => index + 1);
const ownerPubkey = getPublicKey(secret);
const nowMs = 1_700_000_000_001;

async function intent() {
  const review = await canonicalCapabilityReview(verifiedPhase06Artifact, "napplet-host/v1");
  return createPublicationIntent({
    accountId: verifiedPhase06Artifact.accountId,
    sessionId: verifiedPhase06Artifact.sessionId,
    artifact: verifiedPhase06Artifact,
    review,
    ownerPubkey,
    idempotencyKey: "publication:owner-event",
    purpose: "Publish the verified napplet",
    consent: "approved",
    runtimeVariant: "napplet-host/v1",
    createdAtMs: 1_700_000_000_000,
    expiresAtMs: 1_700_000_300_000,
  });
}

function signed(template: ReturnType<typeof canonicalOwnerManifestTemplate>) {
  return finalizeEvent({ kind: template.kind, pubkey: template.pubkey, created_at: template.created_at, tags: template.tags.map((tag) => [...tag]), content: template.content }, secret);
}

async function validEvent() {
  const publicationIntent = await intent();
  return { publicationIntent, event: signed(canonicalOwnerManifestTemplate(publicationIntent)) };
}

test("independently accepts only the exact completed public owner event", async () => {
  const { publicationIntent, event } = await validEvent();
  const result = await verifyOwnerManifestEvent({ event, intent: publicationIntent, nowMs });
  expect(result).toEqual({ valid: true, eventId: event.id });
  expect(await new NostrToolsOwnerEventVerifier({ nowMs: () => nowMs }).verify({ event, intent: publicationIntent })).toEqual(result);
});

test("collapses id, signature, owner, kind, tag, content, expiry, and semantic-binding failures to one public result", async () => {
  const { publicationIntent, event } = await validEvent();
  const template = canonicalOwnerManifestTemplate(publicationIntent);
  const wrongArtifact = finalizeEvent({ ...template, tags: template.tags.map((tag) => tag[0] === "x" ? ["x", "f".repeat(64)] : [...tag]) }, secret);
  const wrongDTag = finalizeEvent({ ...template, tags: template.tags.map((tag) => tag[0] === "d" ? ["d", "other-napplet"] : [...tag]) }, secret);
  const wrongContent = finalizeEvent({ ...template, content: "{}" }, secret);
  const wrongExpiry = finalizeEvent({ ...template, tags: template.tags.map((tag) => tag[0] === "expires-at-ms" ? ["expires-at-ms", `${publicationIntent.expiresAtMs + 1}`] : [...tag]) }, secret);
  const invalids: unknown[] = [
    { ...event, id: "0".repeat(64) },
    { ...event, sig: "0".repeat(128) },
    { ...event, pubkey: "2".repeat(64) },
    { ...event, kind: 35130 },
    { ...event, tags: [["d", publicationIntent.dTag]] },
    { ...event, content: "{}" },
    wrongArtifact,
    wrongDTag,
    wrongContent,
    wrongExpiry,
  ];
  for (const candidate of invalids) {
    expect(await verifyOwnerManifestEvent({ event: candidate, intent: publicationIntent, nowMs })).toEqual({ valid: false, safeReasonCode: "INVALID_OWNER_MANIFEST" });
  }
  expect(await verifyOwnerManifestEvent({ event, intent: publicationIntent, nowMs: publicationIntent.expiresAtMs })).toEqual({ valid: false, safeReasonCode: "INVALID_OWNER_MANIFEST" });
});

test("builds a separately typed, ownership-neutral CVM attestation from verified evidence", async () => {
  const { publicationIntent, event } = await validEvent();
  const attestation = buildCvmAttestation({
    ownerEventId: event.id,
    ownerPubkey: publicationIntent.ownerPubkey,
    artifact: publicationIntent.artifact,
    sessionVersion: 9,
    policyVersion: publicationIntent.policyVersion,
    toolchainIdentity: publicationIntent.toolchainIdentity,
    verificationEvidenceReference: "evidence:phase-06:verified",
    createdAtMs: nowMs,
  });
  expect(attestation).toMatchObject({
    type: "cvm_build_attestation",
    ownerEventId: event.id,
    ownerPubkey,
    artifactId: publicationIntent.artifact.artifactId,
    artifactSha256: publicationIntent.artifactSha256,
    sessionId: publicationIntent.sessionId,
    policyVersion: publicationIntent.policyVersion,
    verificationEvidenceSha256: publicationIntent.artifact.verificationEvidenceSha256,
  });
  expect(attestation.attestationId).not.toBe(event.id);
  expect(JSON.stringify(attestation)).not.toContain("secret");
});
