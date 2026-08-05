import { expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { canonicalCapabilityReview } from "../../src/publication/capability-review.js";
import { PublicationService } from "../../src/publication/publication-service.js";
import { TransactionalMemoryPublicationStore } from "../../src/persistence/publication-store.js";
import { SqlitePublicationStore } from "../../src/persistence/sqlite-publication-store.js";
import { signedPhase06EventFixture, verifiedPhase06Artifact } from "./fakes.js";

async function createService(outcome: "completed" | "unknown" | "failed" = "completed") {
  const store = new TransactionalMemoryPublicationStore();
  const counts = { deploy: 0, owner: 0, attestation: 0, observeDeploy: 0, observeOwner: 0, observeAttestation: 0 };
  const service = new PublicationService({
    store,
    clock: { nowMs: () => 1_700_000_000_000 },
    verifier: { verify: async ({ event }) => ({ valid: true, eventId: event.id }) },
    deployment: {
      deployExact: async ({ operationId }) => { counts.deploy += 1; return { operationId, state: outcome, observationId: `deploy:${operationId}` }; },
      publishOwnerManifest: async ({ operationId }) => { counts.owner += 1; return { operationId, state: outcome, observationId: `owner:${operationId}` }; },
      observe: async ({ operationId }) => { counts.observeDeploy += 1; return { operationId, state: "completed" as const, observationId: `observed:${operationId}`, fullServerUploadId: `upload:${operationId}`, relayObservation: `relay:${operationId}` }; },
    },
    attestation: {
      publish: async ({ operationId }) => { counts.attestation += 1; return { operationId, state: outcome, observationId: `attestation:${operationId}`, attestationId: "attestation:phase-06" }; },
      observe: async ({ operationId }) => { counts.observeAttestation += 1; return { operationId, state: "completed" as const, observationId: `observed:${operationId}`, attestationId: "attestation:phase-06", relayObservation: `relay:${operationId}` }; },
    },
  });
  const review = await canonicalCapabilityReview(verifiedPhase06Artifact, "napplet-host/v1");
  const intent = await service.createIntent({ accountId: verifiedPhase06Artifact.accountId, sessionId: verifiedPhase06Artifact.sessionId, artifact: verifiedPhase06Artifact, review, ownerPubkey: signedPhase06EventFixture.pubkey, idempotencyKey: `publication:reconcile:${outcome}`, purpose: "Publish exact sealed bytes", consent: "approved", runtimeVariant: "napplet-host/v1" });
  const command = { commandId: "publication:command", intentId: intent.intentId, intentFingerprint: intent.fingerprint, operationIds: { deploy: `deploy:${intent.intentId}`, ownerManifest: `owner_manifest:${intent.intentId}`, attestation: `attestation:${intent.intentId}` } };
  return { service, counts, intent, command };
}

test("claims each effect once, persists ambiguous results, and reconciles only original operation identities", async () => {
  const { service, counts, intent, command } = await createService("unknown");
  const [first, replay] = await Promise.all([
    service.submitSignedManifest({ accountId: intent.accountId, intentId: intent.intentId, command, event: signedPhase06EventFixture }),
    service.submitSignedManifest({ accountId: intent.accountId, intentId: intent.intentId, command, event: signedPhase06EventFixture }),
  ]);
  expect(first.status).not.toBe("complete");
  expect(replay).toEqual(first);
  expect(counts).toMatchObject({ deploy: 1, owner: 1, attestation: 1 });

  const reconciled = await service.observeOriginalPublicationEffects({ accountId: intent.accountId, intentId: intent.intentId });
  expect(reconciled).toMatchObject({ state: "complete", intentId: intent.intentId, nextAction: "none" });
  expect(counts).toMatchObject({ deploy: 1, owner: 1, attestation: 1, observeDeploy: 2, observeAttestation: 1 });
});

test("keeps failed and partial effect states non-complete with a safe reconciliation action", async () => {
  const { service, intent, command } = await createService("failed");
  const result = await service.submitSignedManifest({ accountId: intent.accountId, intentId: intent.intentId, command, event: signedPhase06EventFixture });
  expect(result.state).toBe("partial");
  expect(await service.status({ accountId: intent.accountId, intentId: intent.intentId })).toMatchObject({ state: "partial", nextAction: "reconcile_publication" });
});

test("PublicationService runs its async transaction callbacks against SQLite", async () => {
  const directory = mkdtempSync(join(tmpdir(), "napplet-publication-service-"));
  const store = new SqlitePublicationStore(join(directory, "publication.sqlite"));
  try {
    const service = new PublicationService({
      store,
      clock: { nowMs: () => 1_700_000_000_000 },
      verifier: { verify: async ({ event }) => ({ valid: true, eventId: event.id }) },
      deployment: { deployExact: async ({ operationId }) => ({ operationId, state: "completed" as const, observationId: `deploy:${operationId}` }), publishOwnerManifest: async ({ operationId }) => ({ operationId, state: "completed" as const, observationId: `owner:${operationId}` }) },
      attestation: { publish: async ({ operationId }) => ({ operationId, state: "completed" as const, observationId: `attestation:${operationId}` }) },
    });
    const review = await canonicalCapabilityReview(verifiedPhase06Artifact, "napplet-host/v1");
    const intent = await service.createIntent({ accountId: verifiedPhase06Artifact.accountId, sessionId: verifiedPhase06Artifact.sessionId, artifact: verifiedPhase06Artifact, review, ownerPubkey: signedPhase06EventFixture.pubkey, idempotencyKey: "publication:sqlite-service", purpose: "Publish exact sealed bytes", consent: "approved", runtimeVariant: "napplet-host/v1" });
    const command = { commandId: "publication:sqlite-command", intentId: intent.intentId, intentFingerprint: intent.fingerprint, operationIds: { deploy: `deploy:${intent.intentId}`, ownerManifest: `owner_manifest:${intent.intentId}`, attestation: `attestation:${intent.intentId}` } };
    await expect(service.submitSignedManifest({ accountId: intent.accountId, intentId: intent.intentId, command, event: signedPhase06EventFixture })).resolves.toMatchObject({ state: "partial" });
    await expect(store.transact((transaction) => transaction.getSignedEvent(intent.intentId))).resolves.toEqual(signedPhase06EventFixture);
  } finally {
    store.close();
    rmSync(directory, { recursive: true, force: true });
  }
});
