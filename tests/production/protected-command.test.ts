import { z } from "zod";
import { StartSessionCommandSchema } from "../../src/phase-04/metered-generation-service";
import { expect, test } from "bun:test";
import { ProtectedContinuationCommands } from "../../src/continuity/protected-command";
import { loadMountedCheckpointKek } from "../../src/production/checkpoint-crypto";
import { accountIdForPrincipal } from "../../src/domain/account-command";
import { canonicalJson } from "../../src/promotion/schema";
import { PendingActionIntentSchema, type PendingActionIntent } from "../../src/continuity/contracts";

const hash = (value: unknown) => new Bun.CryptoHasher("sha256").update(canonicalJson(value)).digest("hex");
const principal = { pubkey: "8".repeat(64) };
async function fixture() {
  let now = Date.now();
  const accountId = await accountIdForPrincipal(principal);
  const command = { principal, admissionReference: "admission:fixture", idempotencyKey: "start:fixture", expectedVersion: 0 as const, maximum: "10", policyVersion: "fixture", idea: "Private bounded timer instruction." };
  const intent: PendingActionIntent = { accountId, sessionId: `session:${hash({ accountId, key: command.idempotencyKey }).slice(0, 24)}`, idempotencyKey: command.idempotencyKey, fingerprint: "a".repeat(64), reference: "pending:fixture", actionKind: "start_session", boundedPayloadHash: hash({ idea: command.idea }), expectedSessionVersion: 0, expectedArtifactVersion: 0, policyVersion: command.policyVersion, priceCardId: "price:fixture", profileId: "model:fixture", toolchainId: "toolchain:fixture", actionMaximum: "10", admissionReference: command.admissionReference };
  const open = (key = 9) => new ProtectedContinuationCommands({ reference: "test:checkpoint-kek-v1", load: () => loadMountedCheckpointKek({ kekPath: "/test/kek", readFile: async () => Buffer.alloc(32, key).toString("base64") }) }, () => now);
  return { command, intent, open, now: () => now, advance: (value: number) => { now = value; } };
}

test("protected command is portable only with its original owner, lineage, pins, key and retention", async () => {
  const f = await fixture();
  const envelope = await f.open().seal({ command: f.command, intent: f.intent, retentionUntilMs: f.now() + 2_592_600_000 });
  expect(JSON.stringify(envelope)).not.toContain(f.command.idea);
  expect(await f.open().open({ ...f.intent, protectedCommand: envelope })).toEqual(f.command);
  for (const altered of [{ accountId: "account:other" }, { sessionId: "session:other" }, { priceCardId: "price:other" }, { toolchainId: "toolchain:other" }, { fingerprint: "b".repeat(64) }]) await expect(f.open().open({ ...f.intent, ...altered, protectedCommand: envelope })).rejects.toThrow("CONTINUATION_COMMAND_RESTORE_DENIED");
  await expect(f.open(8).open({ ...f.intent, protectedCommand: envelope })).rejects.toThrow("CONTINUATION_COMMAND_RESTORE_DENIED");
  await expect(f.open().open({ ...f.intent, protectedCommand: { ...envelope, ciphertextBase64: Buffer.from("forged ciphertext").toString("base64") } })).rejects.toThrow("CONTINUATION_COMMAND_RESTORE_DENIED");
  await expect(f.open().seal({ command: { ...f.command, idea: "changed command" }, intent: f.intent, retentionUntilMs: f.now() + 1000 })).rejects.toThrow("CONTINUATION_COMMAND_BINDING_INVALID");
  f.advance(envelope.retentionUntilMs);
  if (!envelope.plaintextSha256) throw new Error("EXACT_COMMAND_HASH_REQUIRED");
  const retained = { ...f.intent, commandSha256: envelope.plaintextSha256 };
  expect(await f.open().validateRetained(f.command, retained)).toEqual(f.command);
  for (const altered of [{ ...f.command, idea: "changed command" }, { ...f.command, maximum: "11" }, { ...f.command, principal: { pubkey: "9".repeat(64) } }]) await expect(f.open().validateRetained(altered, retained)).rejects.toThrow("CONTINUATION_RETAINED_COMMAND_BINDING_INVALID");
  await expect(f.open().open({ ...f.intent, protectedCommand: envelope })).rejects.toThrow("CONTINUATION_COMMAND_RESTORE_DENIED");
  await expect(f.open().open(f.intent)).rejects.toThrow("CONTINUATION_COMMAND_RESTORE_DENIED");
});

test("the expanded reader decrypts the original pre-hash envelope without rewriting its binding", async () => {
  const legacy = z.object({ sourceRevision: z.literal("eda4529a8024249430dca6802982b708d568a741"), nowMs: z.number().int().positive(), command: StartSessionCommandSchema, intent: PendingActionIntentSchema }).strict().parse(await Bun.file(new URL("../fixtures/continuity/legacy-pending-command.json", import.meta.url)).json());
  const intent = PendingActionIntentSchema.parse(legacy.intent);
  const before = JSON.stringify(intent);
  const protector = new ProtectedContinuationCommands({ reference: "test:checkpoint-kek-v1", load: () => loadMountedCheckpointKek({ kekPath: "/test/kek", readFile: async () => Buffer.alloc(32, 9).toString("base64") }) }, () => legacy.nowMs);
  expect(intent.commandSha256).toBeUndefined();
  expect(intent.protectedCommand?.plaintextSha256).toBeUndefined();
  expect(await protector.open(intent)).toEqual(legacy.command);
  expect(JSON.stringify(intent)).toBe(before);
  await expect(protector.validateRetained(legacy.command, intent)).rejects.toThrow("CONTINUATION_RETAINED_COMMAND_BINDING_INVALID");
});
