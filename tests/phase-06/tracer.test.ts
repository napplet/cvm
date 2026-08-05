import { expect, test } from "bun:test";

import type {
  AttestationPort,
  NappletDeploymentPort,
  OwnerEventVerifierPort,
  PreviewHostPort,
  SealedArtifactPort,
} from "../../src/publication/contracts.js";
import { PreviewService } from "../../src/publication/preview-service.js";
import { PublicationService } from "../../src/publication/publication-service.js";
import { TransactionalMemoryPublicationStore } from "../../src/persistence/publication-store.js";

const artifact = Object.freeze({
  accountId: "account:owner",
  sessionId: "session:tracer",
  artifactId: "artifact:tracer",
  artifactVersion: 7,
  aggregateSha256: "a".repeat(64),
  manifestSha256: "b".repeat(64),
  verificationEvidenceSha256: "c".repeat(64),
  sealedObjectGeneration: "generation:7",
  sealedObjectSha256: "d".repeat(64),
  entrypoint: "/index.html",
  normalizedDTag: "tracer-napplet",
  requiredCapabilities: ["storage.read"],
  optionalCapabilities: ["notifications"],
  policyIdentity: "policy:phase-06",
  toolchainIdentity: "toolchain:promoted",
  runtimeCompatibilityIdentity: "runtime:tracer",
});
const review = Object.freeze({
  artifactId: artifact.artifactId,
  aggregateSha256: artifact.aggregateSha256,
  normalizedDTag: artifact.normalizedDTag,
  runtimeVariant: "napplet-host/v1",
  required: [{ capability: "storage.read", purpose: "Read the selected note", consent: "required", available: true }],
  optional: [{ capability: "notifications", purpose: "Show optional completion notifications", consent: "optional", available: false }],
  compatibility: "degraded",
  capabilityDigest: "e".repeat(64),
});
const completedEvent = Object.freeze({
  id: "f".repeat(64),
  pubkey: "1".repeat(64),
  created_at: 1_700_000_000,
  kind: 35129,
  tags: [["d", artifact.normalizedDTag]],
  content: "sealed manifest",
  sig: "2".repeat(128),
});

class TracerSealedArtifactPort implements SealedArtifactPort {
  calls = 0;
  async readVerified(input: { accountId: string; sessionId: string; artifactId: string }) {
    this.calls += 1;
    expect(input).toEqual({ accountId: artifact.accountId, sessionId: artifact.sessionId, artifactId: artifact.artifactId });
    return artifact;
  }
}
class TracerPreviewHostPort implements PreviewHostPort {
  calls = 0;
  async createDescriptor(input: { artifact: typeof artifact; review: typeof review; nowMs: number; expiresAtMs: number }) {
    this.calls += 1;
    return { ...input, previewGrantId: "grant:tracer", iframeSandbox: "allow-scripts" as const, authority: "preview_read_only" as const };
  }
}
class TracerOwnerEventVerifierPort implements OwnerEventVerifierPort {
  calls = 0;
  async verify(input: { event: typeof completedEvent; intent: { ownerPubkey: string; artifact: { aggregateSha256: string }; capabilityDigest: string } }) {
    this.calls += 1;
    expect(input.event).toEqual(completedEvent);
    expect(input.intent.ownerPubkey).toBe(completedEvent.pubkey);
    expect(input.intent.artifact.aggregateSha256).toBe(artifact.aggregateSha256);
    expect(input.intent.capabilityDigest).toBe(review.capabilityDigest);
    return { valid: true as const, eventId: completedEvent.id, relayObservation: "relay:owner-manifest" };
  }
}
class TracerNappletDeploymentPort implements NappletDeploymentPort {
  calls: string[] = [];
  async deployExact(input: { operationId: string; artifact: typeof artifact; signedOwnerManifest: typeof completedEvent }) {
    this.calls.push(input.operationId);
    expect(input.artifact.aggregateSha256).toBe(artifact.aggregateSha256);
    expect(input.signedOwnerManifest.id).toBe(completedEvent.id);
    return { state: "completed" as const, observationId: "observation:deploy", deploymentId: "deployment:tracer", fullServerUploadId: "upload:full" };
  }
  async publishOwnerManifest(input: { operationId: string; event: typeof completedEvent }) {
    this.calls.push(input.operationId);
    expect(input.event.id).toBe(completedEvent.id);
    return { state: "completed" as const, observationId: "observation:owner", relayObservation: "relay:owner-manifest" };
  }
}
class TracerAttestationPort implements AttestationPort {
  calls: string[] = [];
  async publish(input: { operationId: string; artifact: typeof artifact; ownerEventId: string }) {
    this.calls.push(input.operationId);
    expect(input.artifact.aggregateSha256).toBe(artifact.aggregateSha256);
    expect(input.ownerEventId).toBe(completedEvent.id);
    return { state: "completed" as const, observationId: "observation:attestation", attestationId: "attestation:tracer", relayObservation: "relay:attestation" };
  }
}
class TracerClock { nowMs = () => 1_700_000_000_000; }

function harness() {
  const store = new TransactionalMemoryPublicationStore();
  const sealed = new TracerSealedArtifactPort();
  const host = new TracerPreviewHostPort();
  const verifier = new TracerOwnerEventVerifierPort();
  const deployment = new TracerNappletDeploymentPort();
  const attestation = new TracerAttestationPort();
  const clock = new TracerClock();
  return {
    store, sealed, host, verifier, deployment, attestation,
    preview: new PreviewService({ sealedArtifacts: sealed, host, clock, capabilityReview: () => review }),
    publication: new PublicationService({ store, verifier, deployment, attestation, clock }),
  };
}

test("verified artifact becomes an exact preview and persisted intent before signing or deployment", async () => {
  const h = harness();
  const descriptor = await h.preview.previewVerifiedArtifact({ accountId: artifact.accountId, sessionId: artifact.sessionId, artifactId: artifact.artifactId, runtimeVariant: "napplet-host/v1" });
  expect(descriptor.artifact.aggregateSha256).toBe(artifact.aggregateSha256);
  expect(descriptor.iframeSandbox).toBe("allow-scripts");
  expect(descriptor.authority).toBe("preview_read_only");
  expect(descriptor.review.capabilityDigest).toBe(review.capabilityDigest);
  const intent = await h.publication.createIntent({ accountId: artifact.accountId, sessionId: artifact.sessionId, artifact, review, ownerPubkey: completedEvent.pubkey, idempotencyKey: "intent:tracer", fingerprint: "fingerprint:tracer", purpose: "Publish tracer", consent: "approved", runtimeVariant: "napplet-host/v1" });
  expect(intent.status).toBe("intent_ready");
  expect(h.verifier.calls).toBe(0);
  expect(h.deployment.calls).toEqual([]);
  expect(h.attestation.calls).toEqual([]);
});

test("verified owner event claims each persisted effect before its deterministic call", async () => {
  const h = harness();
  const intent = await h.publication.createIntent({ accountId: artifact.accountId, sessionId: artifact.sessionId, artifact, review, ownerPubkey: completedEvent.pubkey, idempotencyKey: "intent:tracer", fingerprint: "fingerprint:tracer", purpose: "Publish tracer", consent: "approved", runtimeVariant: "napplet-host/v1" });
  const result = await h.publication.submitSignedManifest({ accountId: artifact.accountId, intentId: intent.intentId, command: { commandId: "contextvm:tracer", intentId: intent.intentId, intentFingerprint: intent.fingerprint, operationIds: { deploy: `deploy:${intent.intentId}`, ownerManifest: `owner_manifest:${intent.intentId}`, attestation: `attestation:${intent.intentId}` } }, event: completedEvent });
  expect(h.verifier.calls).toBe(1);
  expect(h.deployment.calls).toEqual([`deploy:${intent.intentId}`, `owner_manifest:${intent.intentId}`]);
  expect(h.attestation.calls).toEqual([`attestation:${intent.intentId}`]);
  expect(result.status).toBe("complete");
});

test("terminal result links every exact identity and exact replay produces no effects", async () => {
  const h = harness();
  const intent = await h.publication.createIntent({ accountId: artifact.accountId, sessionId: artifact.sessionId, artifact, review, ownerPubkey: completedEvent.pubkey, idempotencyKey: "intent:tracer", fingerprint: "fingerprint:tracer", purpose: "Publish tracer", consent: "approved", runtimeVariant: "napplet-host/v1" });
  const command = { commandId: "contextvm:tracer", intentId: intent.intentId, intentFingerprint: intent.fingerprint, operationIds: { deploy: `deploy:${intent.intentId}`, ownerManifest: `owner_manifest:${intent.intentId}`, attestation: `attestation:${intent.intentId}` } };
  const first = await h.publication.submitSignedManifest({ accountId: artifact.accountId, intentId: intent.intentId, command, event: completedEvent });
  const replay = await h.publication.submitSignedManifest({ accountId: artifact.accountId, intentId: intent.intentId, command, event: completedEvent });
  expect(replay).toEqual(first);
  expect(first).toMatchObject({ status: "complete", artifact: { aggregateSha256: artifact.aggregateSha256, normalizedDTag: artifact.normalizedDTag }, intentId: intent.intentId, ownerEventId: completedEvent.id, capabilityDigest: review.capabilityDigest, deploymentId: "deployment:tracer", attestationId: "attestation:tracer", fullServerUploadId: "upload:full", ownerRelayObservation: "relay:owner-manifest", attestationRelayObservation: "relay:attestation", nextAction: "none" });
  expect(h.verifier.calls).toBe(1);
  expect(h.deployment.calls).toHaveLength(2);
  expect(h.attestation.calls).toHaveLength(1);
});
