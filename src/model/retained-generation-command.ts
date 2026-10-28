import { z } from "zod";
import { accountIdForPrincipal } from "../domain/account-command";
import { canonicalJson } from "../promotion/schema";
import { StartSessionCommandSchema, ReviseSessionCommandSchema, TriggerValidationRepairCommandSchema, type GenerationCommand } from "../phase-04/metered-generation-service";
const Id = z.string().min(1).max(256);
const Digest = z.string().regex(/^[a-f0-9]{64}$/u);
const Amount = z.string().regex(/^[1-9][0-9]*$/u);
export const GenerationRecoveryBindingSchema = z.object({
  accountId: Id, sessionId: Id, actionId: Id, operationId: Id, idempotencyKey: Id,
  fingerprint: Digest, admissionReference: Id, expectedVersion: z.number().int().nonnegative(),
  maximum: Amount, profileId: Id, priceCardId: Id, toolchainId: Id,
}).strict();
export type GenerationRecoveryBinding = z.infer<typeof GenerationRecoveryBindingSchema>;
const Base64 = z.string().min(1).max(100_000).regex(/^[A-Za-z0-9+/]+={0,2}$/u);
export const RetainedGenerationCommandSchema = z.object({
  binding: GenerationRecoveryBindingSchema,
  envelope: z.object({ schemaVersion: z.literal("protected-generation-command-v1"), keyReference: Id,
    retentionUntilMs: z.number().int().positive(), bindingSha256: Digest, commandSha256: Digest,
    nonceBase64: Base64, wrapNonceBase64: Base64, wrappedDekBase64: Base64, ciphertextBase64: Base64,
  }).strict(),
}).strict();
export type RetainedGenerationCommand = z.infer<typeof RetainedGenerationCommandSchema>;
export type GenerationCommandProtector = Readonly<{
  seal(input: Readonly<{ command: GenerationCommand; binding: GenerationRecoveryBinding }>): Promise<RetainedGenerationCommand>;
  open(record: RetainedGenerationCommand): Promise<GenerationCommand>;
}>;
const Command = z.union([StartSessionCommandSchema, ReviseSessionCommandSchema, TriggerValidationRepairCommandSchema.extend({ repair: z.literal(true) })]);
const canonicalBytes = (v: unknown) => new TextEncoder().encode(canonicalJson(v));
const digest = async (v: unknown) => Buffer.from(await crypto.subtle.digest("SHA-256", canonicalBytes(v))).toString("hex");
const bytes = (v: string) => new Uint8Array(Buffer.from(v, "base64"));
const b64 = (v: ArrayBuffer | Uint8Array) => Buffer.from(v instanceof Uint8Array ? v : new Uint8Array(v)).toString("base64");
export class ProtectedGenerationCommands implements GenerationCommandProtector {
  constructor(private readonly key: Readonly<{ reference: string; load(): Promise<CryptoKey> }>, private readonly now: () => number = Date.now) {}
  async #validate(command: GenerationCommand, binding: GenerationRecoveryBinding) {
    const accountId = await accountIdForPrincipal(command.principal);
    const sessionId = "sessionId" in command ? command.sessionId : `session:${(await digest({ accountId, key: command.idempotencyKey })).slice(0,24)}`;
    if (accountId !== binding.accountId || sessionId !== binding.sessionId || command.idempotencyKey !== binding.idempotencyKey || command.admissionReference !== binding.admissionReference || command.expectedVersion !== binding.expectedVersion || BigInt(command.maximum) < BigInt(binding.maximum) || await digest({ accountId, command }) !== binding.fingerprint) throw new Error("GENERATION_COMMAND_BINDING_DENIED");
  }
  async seal(input: Readonly<{ command: GenerationCommand; binding: GenerationRecoveryBinding }>): Promise<RetainedGenerationCommand> {
    const command = Command.parse(input.command), binding = GenerationRecoveryBindingSchema.parse(input.binding);
    await this.#validate(command, binding);
    const plaintext = canonicalBytes(command);
    if (plaintext.byteLength > 65_536) { plaintext.fill(0); throw new Error("GENERATION_COMMAND_TOO_LARGE"); }
    const header = { schemaVersion: "protected-generation-command-v1" as const, keyReference: this.key.reference, retentionUntilMs: this.now() + 30 * 86_400_000, bindingSha256: await digest(binding), commandSha256: await digest(command) };
    const aad = canonicalBytes(header), nonce = crypto.getRandomValues(new Uint8Array(12)), wrapNonce = crypto.getRandomValues(new Uint8Array(12)), rawDek = crypto.getRandomValues(new Uint8Array(32));
    try {
      const dek = await crypto.subtle.importKey("raw", rawDek, "AES-GCM", false, ["encrypt"]);
      const ciphertext = await crypto.subtle.encrypt({ name: "AES-GCM", iv: nonce, additionalData: aad }, dek, plaintext);
      const wrappedDek = await crypto.subtle.encrypt({ name: "AES-GCM", iv: wrapNonce, additionalData: aad }, await this.key.load(), rawDek);
      return RetainedGenerationCommandSchema.parse({ binding, envelope: { ...header, nonceBase64: b64(nonce), wrapNonceBase64: b64(wrapNonce), wrappedDekBase64: b64(wrappedDek), ciphertextBase64: b64(ciphertext) } });
    } finally { rawDek.fill(0); plaintext.fill(0); }
  }
  async open(raw: RetainedGenerationCommand): Promise<GenerationCommand> {
    try {
      const { binding, envelope } = RetainedGenerationCommandSchema.parse(raw);
      const { nonceBase64, wrapNonceBase64, wrappedDekBase64, ciphertextBase64, ...header } = envelope;
      if (header.keyReference !== this.key.reference || header.retentionUntilMs <= this.now() || header.bindingSha256 !== await digest(binding)) throw new Error();
      const aad = canonicalBytes(header), nonce = bytes(nonceBase64), wrapNonce = bytes(wrapNonceBase64);
      if (nonce.length !== 12 || wrapNonce.length !== 12) throw new Error();
      const rawDek = new Uint8Array(await crypto.subtle.decrypt({ name: "AES-GCM", iv: wrapNonce, additionalData: aad }, await this.key.load(), bytes(wrappedDekBase64)));
      try {
        if (rawDek.length !== 32) throw new Error();
        const dek = await crypto.subtle.importKey("raw", rawDek, "AES-GCM", false, ["decrypt"]);
        const plaintext = new Uint8Array(await crypto.subtle.decrypt({ name: "AES-GCM", iv: nonce, additionalData: aad }, dek, bytes(ciphertextBase64)));
        try {
          if (plaintext.length > 65_536) throw new Error();
          const command = Command.parse(JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(plaintext)));
          if (header.commandSha256 !== await digest(command)) throw new Error();
          await this.#validate(command, binding); return command;
        } finally { plaintext.fill(0); }
      } finally { rawDek.fill(0); }
    } catch { throw new Error("GENERATION_COMMAND_RESTORE_DENIED"); }
  }
}
