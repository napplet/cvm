import { z } from "zod";
import { accountIdForPrincipal } from "../domain/account-command";
import { canonicalJson } from "../promotion/schema";
import { StartSessionCommandSchema, ReviseSessionCommandSchema, TriggerValidationRepairCommandSchema, type GenerationCommand } from "../phase-04/metered-generation-service";
import { ProtectedContinuationCommandSchema, type ProtectedContinuationCommand, type PendingActionIntent } from "./contracts";

const Command = z.union([StartSessionCommandSchema, ReviseSessionCommandSchema, TriggerValidationRepairCommandSchema.extend({ repair: z.literal(true) })]);
const canonicalBytes = (value: unknown) => new TextEncoder().encode(canonicalJson(value));
const digest = async (value: unknown) => Buffer.from(await crypto.subtle.digest("SHA-256", canonicalBytes(value))).toString("hex");
const bytes = (value: string) => new Uint8Array(Buffer.from(value, "base64"));
const base64 = (value: ArrayBuffer | Uint8Array) => Buffer.from(value instanceof Uint8Array ? value : new Uint8Array(value)).toString("base64");

export type PendingCommandPort = Readonly<{
  seal(input: Readonly<{ command: unknown; intent: PendingActionIntent; retentionUntilMs: number }>): Promise<ProtectedContinuationCommand>;
  open(intent: PendingActionIntent): Promise<GenerationCommand>;
}>;

/** Pure encryption: the returned envelope is stored in the pause transaction,
 * with no secondary SQL/object write that can be stranded by a crash. A random
 * DEK per command permits erasing its live wrapped key independently of others. */
export class ProtectedContinuationCommands implements PendingCommandPort {
  constructor(private readonly key: Readonly<{ reference: string; load(): Promise<CryptoKey> }>, private readonly now: () => number = Date.now) {}

  async seal(input: Readonly<{ command: unknown; intent: PendingActionIntent; retentionUntilMs: number }>): Promise<ProtectedContinuationCommand> {
    const command = Command.parse(input.command);
    await this.#validate(command, input.intent);
    const plaintext = canonicalBytes(command);
    if (plaintext.byteLength > 65_536 || input.retentionUntilMs <= this.now()) throw new Error("CONTINUATION_COMMAND_INVALID");
    const header = { schemaVersion: "protected-continuation-command-v1" as const, keyReference: this.key.reference, retentionUntilMs: input.retentionUntilMs, bindingSha256: await this.#binding(input.intent) };
    const aad = canonicalBytes(header), nonce = crypto.getRandomValues(new Uint8Array(12)), wrapNonce = crypto.getRandomValues(new Uint8Array(12)), rawDek = crypto.getRandomValues(new Uint8Array(32));
    try {
      const dek = await crypto.subtle.importKey("raw", rawDek, "AES-GCM", false, ["encrypt"]);
      const ciphertext = await crypto.subtle.encrypt({ name: "AES-GCM", iv: nonce, additionalData: aad }, dek, plaintext);
      const wrappedDek = await crypto.subtle.encrypt({ name: "AES-GCM", iv: wrapNonce, additionalData: aad }, await this.key.load(), rawDek);
      return ProtectedContinuationCommandSchema.parse({ ...header, nonceBase64: base64(nonce), wrapNonceBase64: base64(wrapNonce), wrappedDekBase64: base64(wrappedDek), ciphertextBase64: base64(ciphertext) });
    } finally { rawDek.fill(0); plaintext.fill(0); }
  }

  async open(intent: PendingActionIntent): Promise<GenerationCommand> {
    try {
      const envelope = ProtectedContinuationCommandSchema.parse(intent.protectedCommand);
      const { nonceBase64, wrapNonceBase64, wrappedDekBase64, ciphertextBase64, ...header } = envelope;
      if (header.keyReference !== this.key.reference || header.retentionUntilMs <= this.now() || header.bindingSha256 !== await this.#binding(intent)) throw new Error();
      const aad = canonicalBytes(header), nonce = bytes(nonceBase64), wrapNonce = bytes(wrapNonceBase64);
      if (nonce.byteLength !== 12 || wrapNonce.byteLength !== 12) throw new Error();
      const rawDek = new Uint8Array(await crypto.subtle.decrypt({ name: "AES-GCM", iv: wrapNonce, additionalData: aad }, await this.key.load(), bytes(wrappedDekBase64)));
      try {
        if (rawDek.byteLength !== 32) throw new Error();
        const dek = await crypto.subtle.importKey("raw", rawDek, "AES-GCM", false, ["decrypt"]);
        const plaintext = new Uint8Array(await crypto.subtle.decrypt({ name: "AES-GCM", iv: nonce, additionalData: aad }, dek, bytes(ciphertextBase64)));
        try {
          if (plaintext.byteLength > 65_536) throw new Error();
          const command = Command.parse(JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(plaintext)));
          await this.#validate(command, intent);
          return command;
        } finally { plaintext.fill(0); }
      } finally { rawDek.fill(0); }
    } catch { throw new Error("CONTINUATION_COMMAND_RESTORE_DENIED"); }
  }

  #binding(intent: PendingActionIntent) { return digest({ ...intent, protectedCommand: undefined }); }
  async #validate(command: GenerationCommand, intent: PendingActionIntent): Promise<void> {
    const accountId = await accountIdForPrincipal(command.principal);
    const kind = "repair" in command ? "repair" : "revision" in command ? "revise_session" : "start_session";
    const payload = "repair" in command ? { repair: command.originatingActionId } : "revision" in command ? { revision: command.revision } : { idea: command.idea, ...(command.remixReference ? { remixReference: command.remixReference } : {}) };
    const sessionId = "sessionId" in command ? command.sessionId : `session:${(await digest({ accountId, key: command.idempotencyKey })).slice(0, 24)}`;
    if (accountId !== intent.accountId || sessionId !== intent.sessionId || command.idempotencyKey !== intent.idempotencyKey || command.admissionReference !== intent.admissionReference || command.policyVersion !== intent.policyVersion || command.expectedVersion !== intent.expectedSessionVersion || kind !== intent.actionKind || await digest(payload) !== intent.boundedPayloadHash || BigInt(command.maximum) < BigInt(intent.actionMaximum)) throw new Error("CONTINUATION_COMMAND_BINDING_INVALID");
  }
}
