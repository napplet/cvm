import { expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import type { PublicationIntent } from "../../src/publication/contracts.js";
import { TransactionalMemoryPublicationStore, type DurablePublicationStore } from "../../src/persistence/publication-store.js";
import { SqlitePublicationStore } from "../../src/persistence/sqlite-publication-store.js";
import { verifiedPhase06Artifact } from "./fakes.js";

const sha = (character: string) => character.repeat(64);

function intent(intentId = "intent:publication-store"): PublicationIntent {
  return Object.freeze({
    intentId,
    accountId: "account:owner",
    sessionId: "session:publication-store",
    ownerPubkey: "1".repeat(64),
    artifact: verifiedPhase06Artifact,
    artifactSha256: verifiedPhase06Artifact.sealedObjectSha256,
    manifestSha256: verifiedPhase06Artifact.manifestSha256,
    aggregateSha256: verifiedPhase06Artifact.aggregateSha256,
    dTag: verifiedPhase06Artifact.normalizedDTag,
    capabilityDigest: sha("e"),
    runtimeVariant: "napplet-host/v1",
    policyVersion: "policy:phase-06",
    toolchainIdentity: "toolchain:promoted",
    purpose: "Persist publication effects",
    consent: "approved" as const,
    idempotencyKey: `intent-key:${intentId}`,
    fingerprint: sha("f"),
    manifestTemplateDigest: sha("a"),
    createdAtMs: 1_700_000_000_000,
    expiresAtMs: 1_700_000_300_000,
    status: "intent_ready" as const,
  });
}

async function exercise(label: string, open: () => DurablePublicationStore, close?: () => void) {
  const store = open();
  const value = intent(`intent:${label}`);
  const command = { principalId: value.accountId, idempotencyKey: `command:${label}`, requestFingerprintSha256: sha("b"), intent: value };
  const first = await store.createOrReplayIntent(command);
  expect(first.replayed).toBeFalse();
  expect(first.intent).toEqual(value);
  expect(Object.isFrozen(first.intent)).toBeTrue();
  expect((await store.createOrReplayIntent(command)).replayed).toBeTrue();
  await expect(store.createOrReplayIntent({ ...command, requestFingerprintSha256: sha("c") })).rejects.toThrow("PUBLICATION_COMMAND_CONFLICT");

  const effect = { intentId: value.intentId, effectKind: "deploy" as const, operationId: `operation:${label}:deploy`, requestFingerprintSha256: sha("d") };
  const [left, right] = await Promise.all([store.claimPublicationEffect(effect), store.claimPublicationEffect(effect)]);
  expect([left.claimed, right.claimed].filter(Boolean)).toHaveLength(1);
  expect([left, right].map((entry) => entry.effect.operationId)).toEqual([effect.operationId, effect.operationId]);
  await store.recordPublicationObservation({ operationId: effect.operationId, effectKind: "deploy", state: "unknown", observationId: `observation:${label}:unknown` });
  const restarted = await store.readPublicationStatus(value.intentId);
  expect(restarted.status).toBe("publication_reconciliation_pending");
  expect(restarted.effects.deploy.operationId).toBe(effect.operationId);
  expect((await store.claimPublicationEffect(effect)).claimed).toBeFalse();

  for (const kind of ["deploy", "owner_manifest", "attestation"] as const) {
    const next = kind === "deploy" ? effect : { intentId: value.intentId, effectKind: kind, operationId: `operation:${label}:${kind}`, requestFingerprintSha256: sha(kind === "owner_manifest" ? "a" : "e") };
    if (kind !== "deploy") await store.claimPublicationEffect(next);
    await store.recordPublicationObservation({ operationId: next.operationId, effectKind: kind, state: "observed_complete", observationId: `observation:${label}:${kind}` });
  }
  const complete = await store.completePublicationRecord(value.intentId);
  expect(complete.status).toBe("complete");
  await expect(store.recordPublicationObservation({ operationId: effect.operationId, effectKind: "deploy", state: "observed_failed", observationId: "different" })).rejects.toThrow("PUBLICATION_OBSERVATION_IMMUTABLE");
  close?.();
}

test("memory publication authority is replay-safe, single-claim, and immutable", async () => {
  await exercise("memory", () => new TransactionalMemoryPublicationStore());
});

test("SQLite publication authority survives reopen with the same operation identity", async () => {
  const directory = mkdtempSync(join(tmpdir(), "napplet-publication-store-"));
  const path = join(directory, "publication.sqlite");
  try {
    await exercise("sqlite", () => new SqlitePublicationStore(path), () => undefined);
    const reopened = new SqlitePublicationStore(path);
    expect((await reopened.readPublicationStatus("intent:sqlite")).status).toBe("complete");
    reopened.close();
  } finally { rmSync(directory, { recursive: true, force: true }); }
});
