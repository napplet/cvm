import { bindAccountingRealmPool, createAccountingRealm } from "../funding/accounting-realm";
import { readFile as nativeReadFile } from "node:fs/promises";
import { isAbsolute } from "node:path";
import { createHash } from "node:crypto";
import { z } from "zod";
import type { CheckpointCryptoPort } from "../continuity/checkpoint-envelope";
import type { PostgresSqlClient, PostgresSqlPool } from "../persistence/postgres-sql-funding-store";
import { canonicalJson } from "../promotion/schema";

const Digest = z.string().regex(/^[a-f0-9]{64}$/u);
const Identifier = z.string().min(1).max(256).regex(/^[A-Za-z0-9][A-Za-z0-9_.:/-]*$/u);
const Binding = z.object({
  accountId: z.string().min(1).max(256),
  sessionId: Identifier,
  actionId: Identifier,
  operationId: Identifier,
  retentionUntil: z.string().datetime(),
}).strict();

type CryptoBinding = z.infer<typeof Binding>;
type StoredRecord = Readonly<{
  checkpointId: string;
  keyReference: string;
  bindingSha256: string;
  retentionUntil: string;
  plaintextSha256: string;
  aadSha256: string;
  ciphertextSha256: string;
  nonce: Uint8Array;
  wrapNonce: Uint8Array;
  wrappedDek?: Uint8Array;
  ciphertext: Uint8Array;
  state: "active" | "destroyed";
}>;

/** Extended server-only surface used by the checkpoint coordinator. The public
 * envelope still sees only CheckpointCryptoPort; this adds no key export. */
export interface ProductionCheckpointCrypto extends CheckpointCryptoPort {
  readSealed(checkpointId: string): Promise<Readonly<{ keyReference: string; nonce: Uint8Array; ciphertext: Uint8Array; ciphertextSha256: string; aadSha256: string; retentionUntil: string }> | undefined>;
  isDestroyed(keyReference: string): Promise<boolean>;
}

const sha256 = (value: Uint8Array | string) => createHash("sha256").update(value).digest("hex");
const bytes = (value: unknown): Uint8Array | undefined => {
  if (value instanceof Uint8Array) return new Uint8Array(value);
  if (Buffer.isBuffer(value)) return new Uint8Array(value);
  return undefined;
};
function exactBytes(left: Uint8Array, right: Uint8Array): boolean {
  if (left.byteLength !== right.byteLength) return false;
  let result = 0;
  for (let index = 0; index < left.byteLength; index++) result |= left[index]! ^ right[index]!;
  return result === 0;
}
function random(length: number): Uint8Array { return crypto.getRandomValues(new Uint8Array(length)); }
function canonicalBytes(value: unknown): Uint8Array { return new TextEncoder().encode(canonicalJson(value)); }
function parseRecord(row: Record<string, unknown>): StoredRecord {
  const nonce = bytes(row.nonce), wrapNonce = bytes(row.wrap_nonce), ciphertext = bytes(row.ciphertext), wrappedDek = row.wrapped_dek === null || row.wrapped_dek === undefined ? undefined : bytes(row.wrapped_dek);
  if (!nonce || !wrapNonce || !ciphertext || nonce.byteLength !== 12 || wrapNonce.byteLength !== 12 || (wrappedDek !== undefined && wrappedDek.byteLength < 17)) throw new Error("PRODUCTION_CHECKPOINT_CRYPTO_RECORD_INVALID");
  const state = row.state === "active" || row.state === "destroyed" ? row.state : undefined;
  return Object.freeze({
    checkpointId: Identifier.parse(row.checkpoint_id), keyReference: Identifier.parse(row.key_reference), bindingSha256: Digest.parse(row.binding_sha256),
    retentionUntil: new Date(String(row.retention_until)).toISOString(), plaintextSha256: Digest.parse(row.plaintext_sha256),
    aadSha256: Digest.parse(row.aad_sha256), ciphertextSha256: Digest.parse(row.ciphertext_sha256), nonce, wrapNonce,
    ...(wrappedDek ? { wrappedDek } : {}), ciphertext, state: z.enum(["active", "destroyed"]).parse(state),
  });
}

export async function loadMountedCheckpointKek(input: Readonly<{ kekPath: string; readFile?: (path: string) => Promise<Uint8Array | string> }>): Promise<CryptoKey> {
  if (!isAbsolute(input.kekPath)) throw new Error("PRODUCTION_CHECKPOINT_KEK_MOUNT_REQUIRED");
  const raw = await (input.readFile ?? nativeReadFile)(input.kekPath);
  const encoded = typeof raw === "string" ? raw.trim() : new TextDecoder().decode(raw).trim();
  if (!/^[A-Za-z0-9+/]{43}=$/u.test(encoded)) throw new Error("PRODUCTION_CHECKPOINT_KEK_INVALID");
  const keyBytes = new Uint8Array(Buffer.from(encoded, "base64"));
  try {
    if (keyBytes.byteLength !== 32) throw new Error("PRODUCTION_CHECKPOINT_KEK_INVALID");
    return await crypto.subtle.importKey("raw", keyBytes, "AES-GCM", false, ["encrypt", "decrypt"]);
  } finally { keyBytes.fill(0); }
}

/**
 * Concrete production crypto port. The KEK is read from one dedicated secret
 * mount and immediately imported as a non-extractable CryptoKey. PostgreSQL
 * receives only a random per-checkpoint DEK wrapped under that KEK, never the
 * KEK itself. The encrypted archive is retained with the key record so an
 * ambiguous GCS create can be reconciled using its original nonce/ciphertext.
 */
export class MountedKekCheckpointCrypto implements ProductionCheckpointCrypto {
  readonly #pool: PostgresSqlPool;
  readonly #kek: Promise<CryptoKey>;
  readonly #now: () => number;
  constructor(input: Readonly<{
    pool: PostgresSqlPool;
    kekPath: string;
    readFile?: (path: string) => Promise<Uint8Array | string>;
    now?: () => number;
  }>) {
    if (!input.pool || typeof input.pool.connect !== "function" || !isAbsolute(input.kekPath)) throw new Error("PRODUCTION_CHECKPOINT_KEK_MOUNT_REQUIRED");
    this.#pool = bindAccountingRealmPool(input.pool, createAccountingRealm("production-real"));
    this.#now = input.now ?? Date.now;
    this.#kek = loadMountedCheckpointKek(input);
  }

  async seal(input: Readonly<{ checkpointId: string; plaintext: Uint8Array; additionalData: Uint8Array; binding?: CryptoBinding }>): Promise<Readonly<{ keyReference: string; nonce: Uint8Array; ciphertext: Uint8Array }>> {
    const checkpointId = Identifier.parse(input.checkpointId);
    const binding = Binding.parse(input.binding);
    if (!(input.plaintext instanceof Uint8Array) || !(input.additionalData instanceof Uint8Array) || input.plaintext.byteLength === 0) throw new Error("CHECKPOINT_SEAL_INVALID");
    const bindingSha256 = sha256(canonicalBytes({ checkpointId, ...binding }));
    const plaintextSha256 = sha256(input.plaintext), aadSha256 = sha256(input.additionalData);
    const existing = await this.#findByCheckpoint(checkpointId);
    if (existing) return this.#replay(existing, bindingSha256, plaintextSha256, aadSha256);

    const dekBytes = random(32), nonce = random(12), wrapNonce = random(12);
    try {
      const dek = await crypto.subtle.importKey("raw", dekBytes as BufferSource, "AES-GCM", false, ["encrypt", "decrypt"]);
      const ciphertext = new Uint8Array(await crypto.subtle.encrypt({ name: "AES-GCM", iv: nonce as BufferSource, additionalData: input.additionalData as BufferSource }, dek, input.plaintext as BufferSource));
      const kek = await this.#kek;
      const wrappedDek = new Uint8Array(await crypto.subtle.encrypt({ name: "AES-GCM", iv: wrapNonce as BufferSource, additionalData: canonicalBytes({ checkpointId, bindingSha256 }) as BufferSource }, kek, dekBytes as BufferSource));
      const ciphertextSha256 = sha256(ciphertext);
      const keyReference = `checkpoint-key:${checkpointId}:${sha256(wrappedDek).slice(0, 24)}`;
      this.#assertRetainedArchiveFuture(binding);
      try {
        const stored = await this.#insert({ checkpointId, keyReference, binding, bindingSha256, plaintextSha256, aadSha256, ciphertextSha256, nonce, wrapNonce, wrappedDek, ciphertext });
        return this.#replay(stored, bindingSha256, plaintextSha256, aadSha256);
      } finally {
        // PostgreSQL received copies. Keep no locally generated retained DEK
        // wrapping material after either a refusal or successful readback.
        nonce.fill(0); wrapNonce.fill(0); wrappedDek.fill(0); ciphertext.fill(0);
      }
    } finally { dekBytes.fill(0); }
  }

  async open(input: Readonly<{ keyReference: string; nonce: Uint8Array; ciphertext: Uint8Array; additionalData: Uint8Array }>): Promise<Uint8Array> {
    try {
      const keyReference = Identifier.parse(input.keyReference);
      if (!(input.nonce instanceof Uint8Array) || !(input.ciphertext instanceof Uint8Array) || !(input.additionalData instanceof Uint8Array)) throw new Error();
      const record = await this.#findByKeyReference(keyReference);
      if (!record || record.state !== "active" || !record.wrappedDek || Date.parse(record.retentionUntil) <= this.#now()
        || !exactBytes(record.nonce, input.nonce) || !exactBytes(record.ciphertext, input.ciphertext)
        || record.aadSha256 !== sha256(input.additionalData) || record.ciphertextSha256 !== sha256(input.ciphertext)) throw new Error();
      const kek = await this.#kek;
      const dekBytes = new Uint8Array(await crypto.subtle.decrypt({ name: "AES-GCM", iv: record.wrapNonce as BufferSource, additionalData: canonicalBytes({ checkpointId: record.checkpointId, bindingSha256: record.bindingSha256 }) as BufferSource }, kek, record.wrappedDek as BufferSource));
      try {
        if (dekBytes.byteLength !== 32) throw new Error();
        const dek = await crypto.subtle.importKey("raw", dekBytes as BufferSource, "AES-GCM", false, ["decrypt"]);
        const plaintext = new Uint8Array(await crypto.subtle.decrypt({ name: "AES-GCM", iv: record.nonce as BufferSource, additionalData: input.additionalData as BufferSource }, dek, record.ciphertext as BufferSource));
        if (sha256(plaintext) !== record.plaintextSha256) throw new Error();
        await this.#audit(record, "opened", sha256(input.additionalData));
        return plaintext;
      } finally { dekBytes.fill(0); }
    } catch { throw new Error("CHECKPOINT_RESTORE_DENIED"); }
  }

  async destroy(keyReference: string): Promise<void> {
    const record = await this.#findByKeyReference(Identifier.parse(keyReference));
    if (!record) throw new Error("CHECKPOINT_DELETE_BINDING_REQUIRED");
    if (record.state === "destroyed") return;
    const client = await this.#pool.connect();
    try {
      await client.query("BEGIN ISOLATION LEVEL SERIALIZABLE");
      const result = await client.query<Record<string, unknown>>("UPDATE production_real.checkpoint_crypto_records SET wrapped_dek=NULL,ciphertext=''::bytea,state='destroyed',destroyed_at=clock_timestamp() WHERE key_reference=$1 AND state='active' RETURNING checkpoint_id,key_reference,binding_sha256,retention_until::text AS retention_until,plaintext_sha256,aad_sha256,ciphertext_sha256,nonce,wrap_nonce,ciphertext,state", [record.keyReference]);
      if (result.rows.length !== 1) throw new Error("CHECKPOINT_DELETE_BINDING_REQUIRED");
      await this.#audit(record, "destroyed", record.ciphertextSha256, client);
      await client.query("COMMIT");
    } catch (error) { await client.query("ROLLBACK").catch(() => undefined); throw error; }
    finally { client.release(); }
  }

  /** Coordinator-only original-material reader. It cannot reveal a DEK/KEK. */
  async readSealed(checkpointId: string): Promise<Readonly<{ keyReference: string; nonce: Uint8Array; ciphertext: Uint8Array; ciphertextSha256: string; aadSha256: string; retentionUntil: string }> | undefined> {
    const record = await this.#findByCheckpoint(Identifier.parse(checkpointId));
    if (!record) return undefined;
    return Object.freeze({ keyReference: record.keyReference, nonce: new Uint8Array(record.nonce), ciphertext: new Uint8Array(record.ciphertext), ciphertextSha256: record.ciphertextSha256, aadSha256: record.aadSha256, retentionUntil: record.retentionUntil });
  }

  /** Query-only destruction proof used by the independent restore authority.
   * It intentionally exposes neither ciphertext nor key material. */
  async isDestroyed(keyReference: string): Promise<boolean> {
    const record = await this.#findByKeyReference(Identifier.parse(keyReference));
    return record?.state === "destroyed" && record.wrappedDek === undefined && record.ciphertext.byteLength === 0;
  }

  async #findByCheckpoint(checkpointId: string): Promise<StoredRecord | undefined> { return this.#one("SELECT checkpoint_id,key_reference,binding_sha256,retention_until::text AS retention_until,plaintext_sha256,aad_sha256,ciphertext_sha256,nonce,wrap_nonce,wrapped_dek,ciphertext,state FROM production_real.checkpoint_crypto_records WHERE checkpoint_id=$1", [checkpointId]); }
  async #findByKeyReference(keyReference: string): Promise<StoredRecord | undefined> { return this.#one("SELECT checkpoint_id,key_reference,binding_sha256,retention_until::text AS retention_until,plaintext_sha256,aad_sha256,ciphertext_sha256,nonce,wrap_nonce,wrapped_dek,ciphertext,state FROM production_real.checkpoint_crypto_records WHERE key_reference=$1", [keyReference]); }
  async #one(text: string, values: readonly unknown[]): Promise<StoredRecord | undefined> {
    const client = await this.#pool.connect();
    try { const row = (await client.query<Record<string, unknown>>(text, values)).rows[0]; return row ? parseRecord(row) : undefined; }
    finally { client.release(); }
  }
  #isRetainedArchive(binding: CryptoBinding): boolean { return binding.operationId.startsWith("durability-archive:"); }
  #assertRetainedArchiveFuture(binding: CryptoBinding): void {
    if (!this.#isRetainedArchive(binding)) return;
    const retentionAtMs = Date.parse(binding.retentionUntil), now = this.#now();
    if (!Number.isFinite(retentionAtMs) || !Number.isFinite(now) || retentionAtMs <= now) {
      throw new Error("RETAINED_SUBJECT_RETENTION_EXPIRED");
    }
  }
  async #insert(input: Readonly<{ checkpointId: string; keyReference: string; binding: CryptoBinding; bindingSha256: string; plaintextSha256: string; aadSha256: string; ciphertextSha256: string; nonce: Uint8Array; wrapNonce: Uint8Array; wrappedDek: Uint8Array; ciphertext: Uint8Array }>): Promise<StoredRecord> {
    for (let attempt = 0; attempt < 4; attempt++) {
      const client = await this.#pool.connect();
      try {
        // The connection wait can cross the retained deadline. Check it again
        // before beginning work, and once more after BEGIN immediately before
        // the only new-custody statement below.
        this.#assertRetainedArchiveFuture(input.binding);
        await client.query("BEGIN ISOLATION LEVEL SERIALIZABLE");
        this.#assertRetainedArchiveFuture(input.binding);
        const values = [input.checkpointId, input.keyReference, input.bindingSha256, input.binding.accountId, input.binding.sessionId, input.binding.actionId, input.binding.operationId, input.binding.retentionUntil, input.plaintextSha256, input.aadSha256, input.ciphertextSha256, Buffer.from(input.nonce), Buffer.from(input.wrapNonce), Buffer.from(input.wrappedDek), Buffer.from(input.ciphertext)];
        const inserted = await client.query<Record<string, unknown>>(this.#isRetainedArchive(input.binding)
          ? "INSERT INTO production_real.checkpoint_crypto_records(checkpoint_id,key_reference,binding_sha256,account_id,session_id,action_id,operation_id,retention_until,plaintext_sha256,aad_sha256,ciphertext_sha256,nonce,wrap_nonce,wrapped_dek,ciphertext,state) SELECT $1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,'active' WHERE clock_timestamp() < $8::timestamptz ON CONFLICT(checkpoint_id) DO NOTHING RETURNING checkpoint_id,key_reference,binding_sha256,retention_until::text AS retention_until,plaintext_sha256,aad_sha256,ciphertext_sha256,nonce,wrap_nonce,wrapped_dek,ciphertext,state"
          : "INSERT INTO production_real.checkpoint_crypto_records(checkpoint_id,key_reference,binding_sha256,account_id,session_id,action_id,operation_id,retention_until,plaintext_sha256,aad_sha256,ciphertext_sha256,nonce,wrap_nonce,wrapped_dek,ciphertext,state) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,'active') ON CONFLICT(checkpoint_id) DO NOTHING RETURNING checkpoint_id,key_reference,binding_sha256,retention_until::text AS retention_until,plaintext_sha256,aad_sha256,ciphertext_sha256,nonce,wrap_nonce,wrapped_dek,ciphertext,state", values);
        const row = inserted.rows[0] ?? (await client.query<Record<string, unknown>>("SELECT checkpoint_id,key_reference,binding_sha256,retention_until::text AS retention_until,plaintext_sha256,aad_sha256,ciphertext_sha256,nonce,wrap_nonce,wrapped_dek,ciphertext,state FROM production_real.checkpoint_crypto_records WHERE checkpoint_id=$1 FOR UPDATE", [input.checkpointId])).rows[0];
        if (!row) throw new Error(this.#isRetainedArchive(input.binding) ? "RETAINED_SUBJECT_RETENTION_EXPIRED" : "PRODUCTION_CHECKPOINT_CRYPTO_RECORD_MISSING");
        const record = parseRecord(row);
        if (inserted.rows.length) await this.#audit(record, "sealed", record.ciphertextSha256, client);
        await client.query("COMMIT");
        return record;
      } catch (error) {
        await client.query("ROLLBACK").catch(() => undefined);
        const code = error && typeof error === "object" && "code" in error ? String(error.code) : "";
        if (attempt === 3 || !["40001", "40P01", "23505"].includes(code)) throw error;
      }
      finally { client.release(); }
    }
    throw new Error("PRODUCTION_CHECKPOINT_CRYPTO_RETRY_EXHAUSTED");
  }

  #replay(record: StoredRecord, bindingSha256: string, plaintextSha256: string, aadSha256: string) {
    if (record.state !== "active" || !record.wrappedDek || record.bindingSha256 !== bindingSha256 || record.plaintextSha256 !== plaintextSha256 || record.aadSha256 !== aadSha256 || record.ciphertextSha256 !== sha256(record.ciphertext)) throw new Error("CHECKPOINT_IDENTITY_CONFLICT");
    return Object.freeze({ keyReference: record.keyReference, nonce: new Uint8Array(record.nonce), ciphertext: new Uint8Array(record.ciphertext) });
  }
  async #audit(record: StoredRecord, event: "sealed" | "opened" | "destroyed", detailsSha256: string, supplied?: PostgresSqlClient): Promise<void> {
    const client = supplied ?? await this.#pool.connect();
    try { await client.query("INSERT INTO production_real.checkpoint_crypto_audit(checkpoint_id,key_reference,event,details_sha256) VALUES($1,$2,$3,$4)", [record.checkpointId, record.keyReference, event, Digest.parse(detailsSha256)]); }
    finally { if (!supplied) client.release(); }
  }
}
