import { getDecodedToken } from "@cashu/cashu-ts";
import { canonicalCashuMintUrl } from "./cashu-mint-policy";

type BlindedMessage = Readonly<{ B_: string; amount: string; id: string }>;
type RecoveredOutput = Readonly<BlindedMessage & { proof: string }>;
type PreparedCustody = Readonly<{
  operationId: string; accountId: string; mintUrl: string; keysetId: string; unit: "sat"; amount: string;
  inputToken: Uint8Array; semanticProofIdentity: string; blindedMessages: readonly BlindedMessage[];
}>;
export type CashuCustodyRecord = Readonly<{
  operationId: string; accountId: string; mintUrl: string; keysetId: string; unit: "sat"; amount: string; semanticProofIdentity: string;
  state: "prepared" | "owned_outputs"; inputCiphertext: Uint8Array; blindedCiphertext: Uint8Array; outputCiphertext?: Uint8Array;
}>;

function hex(bytes: Uint8Array): string { return Array.from(bytes, (byte) => byte.toString(16).padStart(2, "0")).join(""); }
function utf8(value: string): Uint8Array { return new TextEncoder().encode(value); }
function arrayBuffer(bytes: Uint8Array): ArrayBuffer { return bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength) as ArrayBuffer; }
async function sha256(bytes: Uint8Array): Promise<string> { return hex(new Uint8Array(await crypto.subtle.digest("SHA-256", arrayBuffer(bytes)))); }
function freeze<T>(value: T): T { return Object.freeze(structuredClone(value)); }
function canonical(value: unknown): string { return JSON.stringify(value); }

/**
 * The bearer-token wire format is deliberately not a replay identity. Each
 * parsed proof is committed individually with the exact UTF-8 secret bytes;
 * ordering and token re-encoding therefore cannot manufacture a new claim.
 * Signature/DLEQ policy validation is performed by the adapter before this
 * identity becomes eligible for a credit.
 */
export async function canonicalCashuTokenIdentity(token: Uint8Array, allowedKeysetIds: readonly string[]): Promise<string> {
  return sha256(utf8(canonical(await canonicalCashuProofIdentities(token, allowedKeysetIds))));
}

/** Canonical individual proof commitments are the replay authority. */
export async function canonicalCashuProofIdentities(token: Uint8Array, allowedKeysetIds: readonly string[]): Promise<readonly string[]> {
  if (!Array.isArray(allowedKeysetIds) || allowedKeysetIds.length === 0) throw new Error("CASHU_PROOF_KEYSET_REQUIRED");
  const decoded = getDecodedToken(new TextDecoder().decode(token), [...allowedKeysetIds]);
  const mintUrl = canonicalCashuMintUrl(decoded.mint);
  const proofs = await Promise.all(decoded.proofs.map(async (proof) => {
    // The Cashu nullifier is the exact UTF-8 secret, scoped to a canonical
    // mint/unit. Signature points, DLEQ, denomination, and keyset encodings
    // are validation inputs, not replay identity material: including them
    // would let alternate encodings of an already-spent bearer evade the
    // durable claim fence.
    const identity = { mintUrl, unit: decoded.unit, secretSha256: await sha256(utf8(proof.secret)) };
    return sha256(utf8(canonical(identity)));
  }));
  if (new Set(proofs).size !== proofs.length) throw new Error("CASHU_PROOF_IDENTITY_DUPLICATE");
  return Object.freeze([...proofs].sort());
}

/**
 * Test/durable-port reference custody implementation. The payloads are
 * AES-GCM ciphertexts, never bearer material; callers can replace the backing
 * map with a production envelope repository without changing the state rules.
 */
export class InMemoryCashuTreasuryCustody {
  readonly #key: Uint8Array;
  readonly #records = new Map<string, CashuCustodyRecord>();

  constructor(key = crypto.getRandomValues(new Uint8Array(32))) {
    if (!(key instanceof Uint8Array) || key.byteLength !== 32) throw new Error("CASHU_CUSTODY_KEY_INVALID");
    this.#key = new Uint8Array(key);
  }

  async prepare(input: PreparedCustody): Promise<CashuCustodyRecord> {
    if (!input.operationId || !input.accountId || input.unit !== "sat" || !/^[1-9][0-9]*$/u.test(input.amount) || !/^[a-f0-9]{64}$/iu.test(input.semanticProofIdentity) || input.inputToken.byteLength === 0 || input.blindedMessages.length === 0) throw new Error("CASHU_CUSTODY_INVALID");
    const mintUrl = canonicalCashuMintUrl(input.mintUrl);
    if (!input.blindedMessages.every((message) => message.B_ && /^[1-9][0-9]*$/u.test(message.amount) && message.id === input.keysetId) || new Set(input.blindedMessages.map((message) => message.B_)).size !== input.blindedMessages.length) throw new Error("CASHU_CUSTODY_INVALID");
    const existing = this.#records.get(input.operationId);
    if (existing) {
      if (existing.accountId !== input.accountId || existing.mintUrl !== mintUrl || existing.keysetId !== input.keysetId || existing.unit !== input.unit || existing.amount !== input.amount || existing.semanticProofIdentity !== input.semanticProofIdentity) throw new Error("CASHU_CUSTODY_OPERATION_CONFLICT");
      return freeze(existing);
    }
    const inputCiphertext = await this.#encrypt(input.operationId, "input", input.inputToken);
    const blindedCiphertext = await this.#encrypt(input.operationId, "blinded", utf8(canonical(input.blindedMessages)));
    const record = freeze({ operationId: input.operationId, accountId: input.accountId, mintUrl, keysetId: input.keysetId, unit: input.unit, amount: input.amount, semanticProofIdentity: input.semanticProofIdentity.toLowerCase(), state: "prepared" as const, inputCiphertext, blindedCiphertext });
    this.#records.set(record.operationId, record);
    return freeze(record);
  }

  async restoreRequest(operationId: string): Promise<readonly BlindedMessage[]> {
    const record = this.#records.get(operationId); if (!record) throw new Error("CASHU_CUSTODY_UNKNOWN");
    const decrypted = await this.#decrypt(operationId, "blinded", record.blindedCiphertext);
    try {
      const parsed: unknown = JSON.parse(new TextDecoder().decode(decrypted));
      if (!Array.isArray(parsed) || !parsed.every((message) => message && typeof message === "object" && typeof message.B_ === "string" && typeof message.amount === "string" && typeof message.id === "string")) throw new Error("CASHU_RECOVERY_OUTPUT_BINDING_INVALID");
      return freeze(parsed.map((message) => ({ B_: message.B_, amount: message.amount, id: message.id })));
    } finally { decrypted.fill(0); }
  }

  async recordRecoveredOutputs(operationId: string, outputs: readonly RecoveredOutput[]): Promise<CashuCustodyRecord> {
    const record = this.#records.get(operationId); if (!record) throw new Error("CASHU_CUSTODY_UNKNOWN");
    const expected = await this.restoreRequest(operationId);
    const valid = outputs.length === expected.length && new Set(outputs.map((output) => output.B_)).size === outputs.length && outputs.every((output) => typeof output.proof === "string" && output.proof.length > 0 && expected.some((message) => message.B_ === output.B_ && message.amount === output.amount && message.id === output.id));
    if (!valid) throw new Error("CASHU_RECOVERY_OUTPUT_BINDING_INVALID");
    const outputCiphertext = await this.#encrypt(operationId, "output", utf8(canonical(outputs)));
    const updated = freeze({ ...record, state: "owned_outputs" as const, outputCiphertext });
    this.#records.set(operationId, updated);
    return freeze(updated);
  }

  get(operationId: string): CashuCustodyRecord | undefined { const record = this.#records.get(operationId); return record && freeze(record); }

  async #encrypt(operationId: string, kind: string, plaintext: Uint8Array): Promise<Uint8Array> {
    const copy = new Uint8Array(plaintext);
    try {
      const key = await crypto.subtle.importKey("raw", arrayBuffer(this.#key), { name: "AES-GCM" }, false, ["encrypt"]);
      const nonce = crypto.getRandomValues(new Uint8Array(12));
      const ciphertext = new Uint8Array(await crypto.subtle.encrypt({ name: "AES-GCM", iv: arrayBuffer(nonce), additionalData: arrayBuffer(utf8(`${operationId}:${kind}`)) }, key, arrayBuffer(copy)));
      const result = new Uint8Array(nonce.byteLength + ciphertext.byteLength); result.set(nonce); result.set(ciphertext, nonce.byteLength); return result;
    } finally { copy.fill(0); }
  }

  async #decrypt(operationId: string, kind: string, encrypted: Uint8Array): Promise<Uint8Array> {
    if (encrypted.byteLength <= 12) throw new Error("CASHU_CUSTODY_CIPHERTEXT_INVALID");
    const key = await crypto.subtle.importKey("raw", arrayBuffer(this.#key), { name: "AES-GCM" }, false, ["decrypt"]);
    try { return new Uint8Array(await crypto.subtle.decrypt({ name: "AES-GCM", iv: arrayBuffer(encrypted.slice(0, 12)), additionalData: arrayBuffer(utf8(`${operationId}:${kind}`)) }, key, arrayBuffer(encrypted.slice(12)))); }
    catch { throw new Error("CASHU_CUSTODY_CIPHERTEXT_INVALID"); }
  }
}
