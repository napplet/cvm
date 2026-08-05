import { describe, expect, test } from "bun:test";
import {
  AesGcmCheckpointCrypto,
  CheckpointEnvelopeService,
  type CheckpointSealRequest,
} from "../../src/continuity/checkpoint-envelope";
import { DeterministicObjectStore } from "../../src/continuity/object-store";

const encoder = new TextEncoder();

function completeRequest(overrides: Partial<CheckpointSealRequest> = {}): CheckpointSealRequest {
  const archive = encoder.encode("portable paid-session checkpoint");
  return {
    checkpointId: "checkpoint-1",
    accountId: "account-1",
    sessionId: "session-1",
    pauseGeneration: 3,
    sessionVersion: 7,
    actionVersion: 11,
    artifactVersion: 5,
    workspaceVersion: 9,
    workspaceLineage: "workspace-lineage-9",
    action: {
      actionId: "action-1",
      operationId: "operation-1",
      ledgerReference: "ledger-1",
      pendingActionReference: "pending-1",
      idempotencyKey: "idempotency-1",
    },
    archive,
    inventory: [
      "harness_state",
      "workspace",
      "artifact_lineage",
      "validation_evidence",
      "financial_action",
      "pending_action",
      "compatibility_metadata",
    ],
    evidenceSha256: "a".repeat(64),
    compatibility: {
      policyVersion: "policy-1",
      modelIdentity: "model-1",
      nappletSdkIdentity: "@napplet/sdk@0.27.2",
      toolchainIdentity: "toolchain-1",
    },
    retentionUntil: "2026-09-05T00:00:00.000Z",
    ...overrides,
  };
}

function setupEnvelopeService() {
  const store = new DeterministicObjectStore();
  const crypto = new AesGcmCheckpointCrypto({
    randomValues: (bytes) => bytes.fill(7),
  });
  return { store, crypto, service: new CheckpointEnvelopeService({ crypto, objectStore: store, now: () => "2026-08-05T00:00:00.000Z" }) };
}

describe("checkpoint envelope", () => {
  test("seals complete coordinator facts into an encrypted immutable object and restores exact bytes", async () => {
    const { service, store } = setupEnvelopeService();
    const request = completeRequest();

    const sealed = await service.seal(request);
    expect(sealed.manifest.accountId).toBe(request.accountId);
    expect(sealed.manifest.action).toEqual(request.action);
    expect(sealed.manifest.compatibility).toEqual(request.compatibility);
    expect(sealed.envelope.crypto.nonceBase64).toHaveLength(16);
    expect(sealed.envelope.object.generation).toBe(1);
    expect(await service.restore(sealed.envelope, sealed.manifest)).toEqual(request.archive);
    expect(await store.readExact(sealed.envelope.object)).toBeDefined();
  });

  test("denies every archive, envelope, manifest, object, and key tamper with one generic result", async () => {
    const { service } = setupEnvelopeService();
    const sealed = await service.seal(completeRequest());
    const tampered = [
      { envelope: { ...sealed.envelope, ciphertextBase64: "AA" }, manifest: sealed.manifest },
      { envelope: { ...sealed.envelope, crypto: { ...sealed.envelope.crypto, nonceBase64: "AAAAAAAAAAAAAAAA" } }, manifest: sealed.manifest },
      { envelope: { ...sealed.envelope, object: { ...sealed.envelope.object, checksum: "b".repeat(64) } }, manifest: sealed.manifest },
      { envelope: sealed.envelope, manifest: { ...sealed.manifest, accountId: "account-other" } },
    ];

    for (const item of tampered) {
      await expect(service.restore(item.envelope, item.manifest)).rejects.toThrow("CHECKPOINT_RESTORE_DENIED");
    }
  });

  test("rejects incomplete or secret-bearing archives before key creation or object write", async () => {
    const { service, crypto, store } = setupEnvelopeService();
    await expect(service.seal(completeRequest({ inventory: ["workspace"] }))).rejects.toThrow("CHECKPOINT_INCOMPLETE");
    await expect(service.seal(completeRequest({ inventory: [...completeRequest().inventory, "nostr_private_key"] }))).rejects.toThrow("CHECKPOINT_FORBIDDEN_CONTENT");
    expect(crypto.keyReferences()).toEqual([]);
    expect(store.entries()).toEqual([]);
  });

  test("reuses an identical immutable object and rejects a conflicting write without overwrite", async () => {
    const { store } = setupEnvelopeService();
    const key = "checkpoints/checkpoint-immutable";
    const first = await store.createImmutable({ key, bytes: encoder.encode("one") });
    const duplicate = await store.createImmutable({ key, bytes: encoder.encode("one") });
    expect(duplicate).toEqual(first);
    await expect(store.createImmutable({ key, bytes: encoder.encode("two") })).rejects.toThrow("OBJECT_IMMUTABLE_CONFLICT");
    expect(await store.readExact(first)).toEqual(encoder.encode("one"));
  });
});
