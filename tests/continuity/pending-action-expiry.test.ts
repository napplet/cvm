import { expect, test } from "bun:test";
import { PendingActionEnvelopeService } from "../../src/continuity/checkpoint-envelope";
import { PreAdmissionSessionService } from "../../src/continuity/pre-admission-session-service";
import type { PendingActionRecord } from "../../src/continuity/contracts";
import { accountIdForPrincipal } from "../../src/domain/account-command";
import { PHASE_04_DETERMINISTIC_PRICE_CARD, PHASE_04_MODEL_PROFILES } from "../../src/model/price-card";

const DAY = 24 * 60 * 60 * 1000;

test("a saved insufficient-funds action resumes within 30 days and is denied after expiry, without spending", async () => {
  let now = Date.UTC(2026, 10, 1);
  const records = new Map<string, PendingActionRecord>();
  let generations = 0;
  const store = {
    status: async () => ({ available: "0", held: "0" }),
    findPendingAction: async (_account: string, key: string) => [...records.values()].find((record) => record.idempotencyKey === key),
    findPendingActionByCheckpoint: async (_account: string, id: string) => records.get(id),
    createOrReplayPendingAction: async (input: Omit<PendingActionRecord, "state">) => { const record = { ...input, state: "saved" } as PendingActionRecord; records.set(record.checkpointId, record); return record; },
  };
  const key = new Uint8Array(32).fill(9);
  const service = new PreAdmissionSessionService({
    store: store as never,
    envelope: new PendingActionEnvelopeService({ loadOrCreatePendingActionKey: async () => ({ keyId: "test-key", key }) }),
    generation: { startSessionAfterAdmission: async () => { generations++; throw new Error("MUST_NOT_RUN"); } } as never,
    pricing: { card: PHASE_04_DETERMINISTIC_PRICE_CARD, profile: PHASE_04_MODEL_PROFILES["code-proposal"] },
    pins: { policyVersion: "service-v1", profileId: "code-proposal", priceCardId: PHASE_04_DETERMINISTIC_PRICE_CARD.id, toolchainId: "sha256:test", rootManifestSha256: "a".repeat(64) },
    now: () => now,
  });
  const ownerId = "ab".repeat(32);
  const owner = { ownerId, accountId: await accountIdForPrincipal({ pubkey: ownerId }) };
  const saved = await service.saveStart({ owner, command: { idempotencyKey: "pending-1", maximum: "3750", idea: "A tally counter.", policyVersion: "service-v1" } });
  expect(saved.status).toBe("saved");
  if (saved.status !== "saved") return;
  expect(saved.expiresAtMs - now).toBe(30 * DAY);
  expect(saved.shortfall).toBe("3750");

  now += 29 * DAY;
  expect((await service.status({ owner, checkpointId: saved.checkpointId }))?.state).toBe("saved");

  now += 2 * DAY;
  const resume = { kind: "pending_action", checkpointId: saved.checkpointId, expectedCheckpointVersion: 1, expectedSessionVersion: 0, idempotencyKey: "resume-1", approvePendingAction: true, admissionReference: "admission:test", pendingAction: { reference: saved.reference, fingerprint: saved.fingerprint, kind: "start_session", maximum: "3750" } };
  await expect(service.resume({ owner, command: resume })).rejects.toThrow("PENDING_ACTION_NOT_FOUND_OR_DENIED");
  await expect(service.saveStart({ owner, command: { idempotencyKey: "pending-1", maximum: "3750", idea: "A tally counter.", policyVersion: "service-v1" } })).rejects.toThrow("PENDING_ACTION_EXPIRED");
  expect(generations).toBe(0);
});
