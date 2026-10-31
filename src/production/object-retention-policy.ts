import { access, mkdir, readFile, unlink, writeFile } from "node:fs/promises";
import { createHash } from "node:crypto";
import { isAbsolute, join } from "node:path";
import { z } from "zod";
import type { CheckpointCryptoPort } from "../continuity/checkpoint-envelope";
import type { PostgresSqlClient, PostgresSqlPool } from "../persistence/postgres-sql-funding-store";
import { bindAccountingRealmPool, createAccountingRealm } from "../funding/accounting-realm";
import type { ProductionCheckpointCrypto } from "./checkpoint-crypto";
import { canonicalJson } from "../promotion/schema";

const DAY_MS = 86_400_000;
const Identifier = z.string().min(1).max(256).regex(/^[A-Za-z0-9][A-Za-z0-9_.:/-]*$/u);
const Digest = z.string().regex(/^[a-f0-9]{64}$/u);
const Binding = z.object({ accountId: z.string().min(1).max(256), sessionId: Identifier, actionId: Identifier, operationId: Identifier, retentionUntil: z.string().datetime() }).strict();
type Binding = z.infer<typeof Binding>;

export const ObjectProducerBudgetSchema = z.object({
  version: z.literal(1), producer: z.enum(["ordinary_checkpoint", "retained_subject", "workspace_artifact", "migration_archive"]),
  plaintextBytes: z.number().int().min(0), aesGcmTagBytes: z.literal(16), base64Expansion: z.literal("4/3-rounded"), chunkBytes: z.number().int().min(1), maxChunks: z.number().int().min(1).optional(),
}).strict();
export type ObjectProducerBudget = z.infer<typeof ObjectProducerBudgetSchema>;

/** Existing caller bounds, expressed per producer rather than as a global cap. */
export const ObjectProducerBudgets = Object.freeze({
  ordinary_checkpoint: ObjectProducerBudgetSchema.parse({ version: 1, producer: "ordinary_checkpoint", plaintextBytes: Number.MAX_SAFE_INTEGER, aesGcmTagBytes: 16, base64Expansion: "4/3-rounded", chunkBytes: 384 * 1024 }),
  retained_subject: ObjectProducerBudgetSchema.parse({ version: 1, producer: "retained_subject", plaintextBytes: 16 * 1024 * 1024, aesGcmTagBytes: 16, base64Expansion: "4/3-rounded", chunkBytes: 384 * 1024 }),
  workspace_artifact: ObjectProducerBudgetSchema.parse({ version: 1, producer: "workspace_artifact", plaintextBytes: 16 * 1024 * 1024, aesGcmTagBytes: 16, base64Expansion: "4/3-rounded", chunkBytes: 384 * 1024 }),
  migration_archive: ObjectProducerBudgetSchema.parse({ version: 1, producer: "migration_archive", plaintextBytes: 384 * 1024 * 512, aesGcmTagBytes: 16, base64Expansion: "4/3-rounded", chunkBytes: 384 * 1024, maxChunks: 513 }),
});

export function assertProducerWriteBudget(input: Readonly<{ budget: ObjectProducerBudget; plaintextBytes: number }>): void {
  const budget = ObjectProducerBudgetSchema.parse(input.budget);
  if (!Number.isSafeInteger(input.plaintextBytes) || input.plaintextBytes < 0 || input.plaintextBytes > budget.plaintextBytes) throw new Error("OBJECT_PRODUCER_BUDGET_EXCEEDED");
  const ciphertextBytes = input.plaintextBytes + budget.aesGcmTagBytes;
  const chunks = Math.ceil(ciphertextBytes / budget.chunkBytes);
  if (!Number.isSafeInteger(chunks) || (budget.maxChunks !== undefined && chunks > budget.maxChunks)) throw new Error("OBJECT_PRODUCER_CHUNK_BUDGET_EXCEEDED");
}

/** The bytea adapter receives encrypted object bytes, so it must enforce the
 * producer's post-AES-GCM allocation before claiming any SQL header. */
export function assertProducerCiphertextBudget(input: Readonly<{ budget: ObjectProducerBudget; ciphertextBytes: number }>): void {
  const budget = ObjectProducerBudgetSchema.parse(input.budget);
  if (!Number.isSafeInteger(input.ciphertextBytes) || input.ciphertextBytes < 0) throw new Error("OBJECT_PRODUCER_BUDGET_EXCEEDED");
  if (budget.plaintextBytes !== Number.MAX_SAFE_INTEGER && input.ciphertextBytes > budget.plaintextBytes + budget.aesGcmTagBytes) throw new Error("OBJECT_PRODUCER_BUDGET_EXCEEDED");
  const chunks = Math.ceil(input.ciphertextBytes / budget.chunkBytes);
  if (!Number.isSafeInteger(chunks) || (budget.maxChunks !== undefined && chunks > budget.maxChunks)) throw new Error("OBJECT_PRODUCER_CHUNK_BUDGET_EXCEEDED");
}

const sha256 = (value: Uint8Array | string) => createHash("sha256").update(value).digest("hex");
const canonicalBytes = (value: unknown) => new TextEncoder().encode(canonicalJson(value));
const random = (size: number) => crypto.getRandomValues(new Uint8Array(size));
const exactBytes = (left: Uint8Array, right: Uint8Array) => left.byteLength === right.byteLength && left.every((value, index) => value === right[index]);
const bytes = (value: unknown) => value instanceof Uint8Array || Buffer.isBuffer(value) ? new Uint8Array(value) : undefined;

type StoredRecord = Readonly<{ checkpointId: string; keyReference: string; bindingSha256: string; retentionUntil: string; plaintextSha256: string; aadSha256: string; ciphertextSha256: string; nonce: Uint8Array; wrapNonce: Uint8Array; wrappedDek?: Uint8Array; ciphertext: Uint8Array; state: "active" | "destroyed" }>;
function parseRecord(row: Record<string, unknown>): StoredRecord {
  const nonce = bytes(row.nonce), wrapNonce = bytes(row.wrap_nonce), ciphertext = bytes(row.ciphertext), wrappedDek = row.wrapped_dek === null || row.wrapped_dek === undefined ? undefined : bytes(row.wrapped_dek);
  if (!nonce || !wrapNonce || !ciphertext || nonce.byteLength !== 12 || wrapNonce.byteLength !== 12 || (wrappedDek && wrappedDek.byteLength !== 48)) throw new Error("OBJECT_CUSTODY_RECORD_INVALID");
  return Object.freeze({ checkpointId: Identifier.parse(row.checkpoint_id), keyReference: Identifier.parse(row.key_reference), bindingSha256: Digest.parse(row.binding_sha256), retentionUntil: new Date(String(row.retention_until)).toISOString(), plaintextSha256: Digest.parse(row.plaintext_sha256), aadSha256: Digest.parse(row.aad_sha256), ciphertextSha256: Digest.parse(row.ciphertext_sha256), nonce, wrapNonce, ...(wrappedDek ? { wrappedDek } : {}), ciphertext, state: z.enum(["active", "destroyed"]).parse(row.state) });
}

/**
 * Concrete, declared-scope filesystem custody for an unselected candidate.
 * Every configured root is an independently recoverable key copy and is
 * enumerated/erased on expiry. It makes no HSM or forensic-erasure claim;
 * unknown archive copies make selection fail closed instead of becoming proof.
 */
export class FileObjectKeyCustody {
  readonly #roots: readonly string[];
  readonly #confirmAbsent: (path: string) => Promise<void>;
  constructor(input: Readonly<{ roots: readonly string[]; confirmAbsent?: (path: string) => Promise<void> }>) {
    const roots = [...new Set(input.roots)];
    if (roots.length === 0 || roots.some(root => !isAbsolute(root))) throw new Error("OBJECT_KEY_CUSTODY_ROOT_REQUIRED");
    this.#roots = Object.freeze(roots);
    this.#confirmAbsent = input.confirmAbsent ?? access;
  }
  async provision(reference: string, key: Uint8Array): Promise<Readonly<{ keyReference: string; copies: readonly Readonly<{ rootId: string; keySha256: string }>[]}>> {
    const safeReference = Identifier.parse(reference), material = new Uint8Array(key);
    if (material.byteLength !== 32) throw new Error("OBJECT_KEY_CUSTODY_KEY_INVALID");
    const filename = sha256(safeReference), copies: { rootId: string; keySha256: string }[] = []; let selected: Uint8Array | undefined;
    try {
      for (const root of this.#roots) {
        await mkdir(root, { recursive: true, mode: 0o700 });
        const target = join(root, filename);
        try { await writeFile(target, selected ?? material, { flag: "wx", mode: 0o600 }); selected ??= material; }
        catch (error) {
          if (!(error && typeof error === "object" && "code" in error && error.code === "EEXIST")) throw error;
          const existing = new Uint8Array(await readFile(target));
          if (existing.byteLength !== 32 || (selected && !exactBytes(existing, selected))) { existing.fill(0); throw new Error("OBJECT_KEY_CUSTODY_COPY_MISMATCH"); }
          selected = existing;
        }
        copies.push({ rootId: sha256(root), keySha256: sha256(selected ?? material) });
      }
      return Object.freeze({ keyReference: safeReference, copies: Object.freeze(copies.map(copy => Object.freeze(copy))) });
    // Never erase on provisioning failure: another concurrent caller or an
    // unknown-commit retry may own a durable copy. A later fenced operation can
    // repair a partial declared scope; deleting here would destroy live custody.
    } finally { if (selected && selected !== material) selected.fill(0); material.fill(0); }
  }
  async load(reference: string): Promise<Uint8Array> {
    const safeReference = Identifier.parse(reference), filename = sha256(safeReference); let expected: Uint8Array | undefined;
    for (const root of this.#roots) {
      const value = new Uint8Array(await readFile(join(root, filename)));
      if (value.byteLength !== 32 || (expected && !exactBytes(expected, value))) { value.fill(0); expected?.fill(0); throw new Error("OBJECT_KEY_CUSTODY_COPY_MISMATCH"); }
      expected?.fill(0); expected = value;
    }
    if (!expected) throw new Error("OBJECT_KEY_CUSTODY_MISSING");
    return expected;
  }
  async erase(reference: string): Promise<void> {
    const safeReference = Identifier.parse(reference), filename = sha256(safeReference);
    for (const root of this.#roots) {
      const target = join(root, filename);
      await unlink(target).catch(error => { if (!(error && typeof error === "object" && "code" in error && error.code === "ENOENT")) throw error; });
      try { await this.#confirmAbsent(target); }
      catch (error) {
        if (error && typeof error === "object" && "code" in error && error.code === "ENOENT") continue;
        throw error;
      }
      throw new Error("OBJECT_KEY_CUSTODY_ERASE_UNCONFIRMED");
    }
  }
  inventory(reference: string): readonly Readonly<{ rootId: string; fileId: string }>[] {
    const filename = sha256(Identifier.parse(reference));
    return Object.freeze(this.#roots.map(root => Object.freeze({ rootId: sha256(root), fileId: sha256(`${root}:${filename}`) })));
  }
}

type CustodyRecord = Readonly<{ checkpointId: string; keyReference: string; bindingSha256: string; state: "provisioning" | "active" | "erasing" | "destroyed" }>;
function parseCustody(row: Record<string, unknown>): CustodyRecord {
  return Object.freeze({ checkpointId: Identifier.parse(row.checkpoint_id), keyReference: Identifier.parse(row.key_reference), bindingSha256: Digest.parse(row.binding_sha256), state: z.enum(["provisioning", "active", "erasing", "destroyed"]).parse(row.state) });
}
function sqlErrorCode(error: unknown): string | undefined { return error && typeof error === "object" && "code" in error ? String(error.code) : undefined; }

/** Per-object KEK implementation retaining the unchanged v1 SQL record/AAD format. */
export class PerObjectFileCheckpointCrypto implements CheckpointCryptoPort, ProductionCheckpointCrypto {
  readonly #pool: PostgresSqlPool;
  readonly #now: () => number;
  constructor(input: Readonly<{ pool: PostgresSqlPool; custody: FileObjectKeyCustody; now?: () => number }>) {
    if (!input.pool || !input.custody) throw new Error("OBJECT_KEY_CUSTODY_CONFIGURATION_INVALID");
    this.#pool = bindAccountingRealmPool(input.pool, createAccountingRealm("production-real")); this.custody = input.custody; this.#now = input.now ?? Date.now;
  }
  readonly custody: FileObjectKeyCustody;
  async seal(input: Readonly<{ checkpointId: string; plaintext: Uint8Array; additionalData: Uint8Array; binding?: Binding }>): Promise<Readonly<{ keyReference: string; nonce: Uint8Array; ciphertext: Uint8Array }>> {
    const checkpointId = Identifier.parse(input.checkpointId), binding = Binding.parse(input.binding);
    if (!(input.plaintext instanceof Uint8Array) || !(input.additionalData instanceof Uint8Array) || input.plaintext.byteLength === 0) throw new Error("CHECKPOINT_SEAL_INVALID");
    const bindingSha256 = sha256(canonicalBytes({ checkpointId, ...binding })), plaintextSha256 = sha256(input.plaintext), aadSha256 = sha256(input.additionalData);
    const existing = await this.#findByCheckpoint(checkpointId); if (existing) return this.#replay(existing, bindingSha256, plaintextSha256, aadSha256);
    const keyReference = `object-key:${checkpointId}:${sha256(canonicalBytes({ bindingSha256, checkpointId })).slice(0, 24)}`;
    const custody = await this.#claimCustody(checkpointId, keyReference, bindingSha256);
    if (custody.state === "active") {
      const active = await this.#findByCheckpoint(checkpointId);
      if (!active) throw new Error("OBJECT_CUSTODY_RECORD_MISSING");
      return this.#replay(active, bindingSha256, plaintextSha256, aadSha256);
    }
    if (custody.state !== "provisioning") throw new Error("CHECKPOINT_CUSTODY_ERASURE_HELD");
    const dekBytes = random(32), nonce = random(12), wrapNonce = random(12), candidateKek = random(32);
    let objectKek: Uint8Array | undefined;
    try {
      // The fenced filesystem operation is deliberately outside retrying SQL.
      // A lost COMMIT acknowledgement leaves files intact; a retry loads them.
      objectKek = await this.#prepareCustody(custody, candidateKek);
      if (!objectKek) {
        const active = await this.#findByCheckpoint(checkpointId);
        if (!active) throw new Error("OBJECT_CUSTODY_RECORD_MISSING");
        return this.#replay(active, bindingSha256, plaintextSha256, aadSha256);
      }
      const dek = await crypto.subtle.importKey("raw", dekBytes as BufferSource, "AES-GCM", false, ["encrypt", "decrypt"]);
      const ciphertext = new Uint8Array(await crypto.subtle.encrypt({ name: "AES-GCM", iv: nonce as BufferSource, additionalData: input.additionalData as BufferSource }, dek, input.plaintext as BufferSource));
      const kek = await crypto.subtle.importKey("raw", objectKek as BufferSource, "AES-GCM", false, ["encrypt", "decrypt"]);
      const wrappedDek = new Uint8Array(await crypto.subtle.encrypt({ name: "AES-GCM", iv: wrapNonce as BufferSource, additionalData: canonicalBytes({ checkpointId, bindingSha256 }) as BufferSource }, kek, dekBytes as BufferSource));
      try { const stored = await this.#activateAndInsert({ checkpointId, keyReference, binding, bindingSha256, plaintextSha256, aadSha256, ciphertextSha256: sha256(ciphertext), nonce, wrapNonce, wrappedDek, ciphertext }); return this.#replay(stored, bindingSha256, plaintextSha256, aadSha256); }
      finally { ciphertext.fill(0); wrappedDek.fill(0); nonce.fill(0); wrapNonce.fill(0); }
    } finally { dekBytes.fill(0); candidateKek.fill(0); objectKek?.fill(0); }
  }
  async open(input: Readonly<{ keyReference: string; nonce: Uint8Array; ciphertext: Uint8Array; additionalData: Uint8Array }>): Promise<Uint8Array> {
    try {
      const record = await this.#findByKeyReference(Identifier.parse(input.keyReference)), custody = record ? await this.#findCustody(record.checkpointId) : undefined;
      if (!record || !custody || custody.state !== "active" || custody.keyReference !== record.keyReference || custody.bindingSha256 !== record.bindingSha256 || record.state !== "active" || !record.wrappedDek || Date.parse(record.retentionUntil) <= this.#now() || !exactBytes(record.nonce, input.nonce) || !exactBytes(record.ciphertext, input.ciphertext) || record.aadSha256 !== sha256(input.additionalData) || record.ciphertextSha256 !== sha256(input.ciphertext)) throw new Error();
      const keyBytes = await this.custody.load(record.keyReference);
      try {
        const kek = await crypto.subtle.importKey("raw", keyBytes as BufferSource, "AES-GCM", false, ["decrypt"]);
        const dekBytes = new Uint8Array(await crypto.subtle.decrypt({ name: "AES-GCM", iv: record.wrapNonce as BufferSource, additionalData: canonicalBytes({ checkpointId: record.checkpointId, bindingSha256: record.bindingSha256 }) as BufferSource }, kek, record.wrappedDek as BufferSource));
        try { const dek = await crypto.subtle.importKey("raw", dekBytes as BufferSource, "AES-GCM", false, ["decrypt"]); const plaintext = new Uint8Array(await crypto.subtle.decrypt({ name: "AES-GCM", iv: record.nonce as BufferSource, additionalData: input.additionalData as BufferSource }, dek, record.ciphertext as BufferSource)); if (sha256(plaintext) !== record.plaintextSha256) throw new Error(); return plaintext; } finally { dekBytes.fill(0); }
      } finally { keyBytes.fill(0); }
    } catch { throw new Error("CHECKPOINT_RESTORE_DENIED"); }
  }
  async destroy(keyReference: string): Promise<void> {
    const record = await this.#findByKeyReference(Identifier.parse(keyReference)); if (!record) return;
    const custody = await this.#beginErasure(record);
    if (custody.state === "destroyed" && record.state === "destroyed") return;
    // The durable erasing state is committed before this filesystem operation.
    await this.custody.erase(record.keyReference);
    await this.#finalizeErasure(record);
  }
  async readSealed(checkpointId: string): Promise<Readonly<{ keyReference: string; nonce: Uint8Array; ciphertext: Uint8Array; ciphertextSha256: string; aadSha256: string; retentionUntil: string }> | undefined> { const record = await this.#findByCheckpoint(Identifier.parse(checkpointId)); return record && Object.freeze({ keyReference: record.keyReference, nonce: new Uint8Array(record.nonce), ciphertext: new Uint8Array(record.ciphertext), ciphertextSha256: record.ciphertextSha256, aadSha256: record.aadSha256, retentionUntil: record.retentionUntil }); }
  async isDestroyed(keyReference: string): Promise<boolean> { const record = await this.#findByKeyReference(Identifier.parse(keyReference)); const custody = record ? await this.#findCustody(record.checkpointId) : undefined; return record?.state === "destroyed" && !record.wrappedDek && record.ciphertext.byteLength === 0 && custody?.state === "destroyed"; }
  async #findByCheckpoint(checkpointId: string) { return this.#one("SELECT checkpoint_id,key_reference,binding_sha256,retention_until::text AS retention_until,plaintext_sha256,aad_sha256,ciphertext_sha256,nonce,wrap_nonce,wrapped_dek,ciphertext,state FROM production_real.checkpoint_crypto_records WHERE checkpoint_id=$1", [checkpointId]); }
  async #findByKeyReference(keyReference: string) { return this.#one("SELECT checkpoint_id,key_reference,binding_sha256,retention_until::text AS retention_until,plaintext_sha256,aad_sha256,ciphertext_sha256,nonce,wrap_nonce,wrapped_dek,ciphertext,state FROM production_real.checkpoint_crypto_records WHERE key_reference=$1", [keyReference]); }
  async #findCustody(checkpointId: string): Promise<CustodyRecord | undefined> { const client = await this.#pool.connect(); try { const row = (await client.query<Record<string, unknown>>("SELECT checkpoint_id,key_reference,binding_sha256,state FROM production_real.checkpoint_object_key_custody WHERE checkpoint_id=$1", [checkpointId])).rows[0]; return row ? parseCustody(row) : undefined; } finally { client.release(); } }
  async #one(text: string, values: readonly unknown[]) { const client = await this.#pool.connect(); try { const row = (await client.query<Record<string, unknown>>(text, values)).rows[0]; return row ? parseRecord(row) : undefined; } finally { client.release(); } }
  async #claimCustody(checkpointId: string, keyReference: string, bindingSha256: string): Promise<CustodyRecord> {
    return this.#pureSql(async client => {
      await client.query("INSERT INTO production_real.checkpoint_object_key_custody(checkpoint_id,key_reference,binding_sha256,state) VALUES($1,$2,$3,'provisioning') ON CONFLICT(checkpoint_id) DO NOTHING", [checkpointId,keyReference,bindingSha256]);
      const row = (await client.query<Record<string, unknown>>("SELECT checkpoint_id,key_reference,binding_sha256,state FROM production_real.checkpoint_object_key_custody WHERE checkpoint_id=$1 FOR UPDATE", [checkpointId])).rows[0];
      if (!row) throw new Error("OBJECT_CUSTODY_RECORD_MISSING"); const custody = parseCustody(row);
      if (custody.keyReference !== keyReference || custody.bindingSha256 !== bindingSha256) throw new Error("CHECKPOINT_IDENTITY_CONFLICT");
      return custody;
    });
  }
  async #prepareCustody(custody: CustodyRecord, candidate: Uint8Array): Promise<Uint8Array | undefined> {
    const client = await this.#pool.connect();
    try {
      await client.query("BEGIN");
      const row = (await client.query<Record<string, unknown>>("SELECT checkpoint_id,key_reference,binding_sha256,state FROM production_real.checkpoint_object_key_custody WHERE checkpoint_id=$1 FOR UPDATE", [custody.checkpointId])).rows[0];
      if (!row) throw new Error("OBJECT_CUSTODY_RECORD_MISSING"); const current = parseCustody(row);
      if (current.keyReference !== custody.keyReference || current.bindingSha256 !== custody.bindingSha256) throw new Error("CHECKPOINT_IDENTITY_CONFLICT");
      if (current.state === "active") { await client.query("COMMIT"); return undefined; }
      if (current.state !== "provisioning") throw new Error("CHECKPOINT_CUSTODY_ERASURE_HELD");
      await this.custody.provision(current.keyReference, candidate);
      const material = await this.custody.load(current.keyReference);
      await client.query("COMMIT");
      return material;
    } catch (error) { await client.query("ROLLBACK").catch(() => undefined); throw error; } finally { client.release(); }
  }
  async #activateAndInsert(input: Readonly<{ checkpointId: string; keyReference: string; binding: Binding; bindingSha256: string; plaintextSha256: string; aadSha256: string; ciphertextSha256: string; nonce: Uint8Array; wrapNonce: Uint8Array; wrappedDek: Uint8Array; ciphertext: Uint8Array }>): Promise<StoredRecord> {
    return this.#pureSql(async client => {
      const custodyRow = (await client.query<Record<string, unknown>>("SELECT checkpoint_id,key_reference,binding_sha256,state FROM production_real.checkpoint_object_key_custody WHERE checkpoint_id=$1 FOR UPDATE", [input.checkpointId])).rows[0];
      if (!custodyRow) throw new Error("OBJECT_CUSTODY_RECORD_MISSING"); const custody = parseCustody(custodyRow);
      if (custody.keyReference !== input.keyReference || custody.bindingSha256 !== input.bindingSha256) throw new Error("CHECKPOINT_IDENTITY_CONFLICT");
      if (custody.state === "active") {
        const active = (await client.query<Record<string, unknown>>("SELECT checkpoint_id,key_reference,binding_sha256,retention_until::text AS retention_until,plaintext_sha256,aad_sha256,ciphertext_sha256,nonce,wrap_nonce,wrapped_dek,ciphertext,state FROM production_real.checkpoint_crypto_records WHERE checkpoint_id=$1 FOR UPDATE", [input.checkpointId])).rows[0];
        if (!active) throw new Error("OBJECT_CUSTODY_RECORD_MISSING");
        return parseRecord(active);
      }
      if (custody.state !== "provisioning") throw new Error("CHECKPOINT_CUSTODY_ERASURE_HELD");
      const values = [input.checkpointId,input.keyReference,input.bindingSha256,input.binding.accountId,input.binding.sessionId,input.binding.actionId,input.binding.operationId,input.binding.retentionUntil,input.plaintextSha256,input.aadSha256,input.ciphertextSha256,Buffer.from(input.nonce),Buffer.from(input.wrapNonce),Buffer.from(input.wrappedDek),Buffer.from(input.ciphertext)];
      const inserted = await client.query<Record<string, unknown>>("INSERT INTO production_real.checkpoint_crypto_records(checkpoint_id,key_reference,binding_sha256,account_id,session_id,action_id,operation_id,retention_until,plaintext_sha256,aad_sha256,ciphertext_sha256,nonce,wrap_nonce,wrapped_dek,ciphertext,state) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,'active') ON CONFLICT(checkpoint_id) DO NOTHING RETURNING checkpoint_id,key_reference,binding_sha256,retention_until::text AS retention_until,plaintext_sha256,aad_sha256,ciphertext_sha256,nonce,wrap_nonce,wrapped_dek,ciphertext,state", values);
      const row = inserted.rows[0] ?? (await client.query<Record<string, unknown>>("SELECT checkpoint_id,key_reference,binding_sha256,retention_until::text AS retention_until,plaintext_sha256,aad_sha256,ciphertext_sha256,nonce,wrap_nonce,wrapped_dek,ciphertext,state FROM production_real.checkpoint_crypto_records WHERE checkpoint_id=$1 FOR UPDATE", [input.checkpointId])).rows[0];
      if (!row) throw new Error("OBJECT_CUSTODY_RECORD_MISSING"); const record = parseRecord(row);
      if (record.keyReference !== input.keyReference || record.bindingSha256 !== input.bindingSha256) throw new Error("CHECKPOINT_IDENTITY_CONFLICT");
      await client.query("UPDATE production_real.checkpoint_object_key_custody SET state='active',activated_at=clock_timestamp() WHERE checkpoint_id=$1 AND state='provisioning'", [input.checkpointId]);
      if (inserted.rows.length) await client.query("INSERT INTO production_real.checkpoint_crypto_audit(checkpoint_id,key_reference,event,details_sha256) VALUES($1,$2,'sealed',$3)", [record.checkpointId,record.keyReference,record.ciphertextSha256]);
      return record;
    });
  }
  async #beginErasure(record: StoredRecord): Promise<CustodyRecord> {
    return this.#pureSql(async client => {
      const row = (await client.query<Record<string, unknown>>("SELECT checkpoint_id,key_reference,binding_sha256,state FROM production_real.checkpoint_object_key_custody WHERE checkpoint_id=$1 FOR UPDATE", [record.checkpointId])).rows[0];
      if (!row) throw new Error("OBJECT_CUSTODY_RECORD_MISSING"); const custody = parseCustody(row);
      if (custody.keyReference !== record.keyReference || custody.bindingSha256 !== record.bindingSha256) throw new Error("CHECKPOINT_DELETE_BINDING_REQUIRED");
      if (custody.state === "active") await client.query("UPDATE production_real.checkpoint_object_key_custody SET state='erasing',erase_requested_at=clock_timestamp() WHERE checkpoint_id=$1 AND state='active'", [record.checkpointId]);
      return custody.state === "active" ? Object.freeze({ ...custody, state: "erasing" }) : custody;
    });
  }
  async #finalizeErasure(record: StoredRecord): Promise<void> {
    await this.#pureSql(async client => {
      const custodyRow = (await client.query<Record<string, unknown>>("SELECT checkpoint_id,key_reference,binding_sha256,state FROM production_real.checkpoint_object_key_custody WHERE checkpoint_id=$1 FOR UPDATE", [record.checkpointId])).rows[0];
      if (!custodyRow) throw new Error("OBJECT_CUSTODY_RECORD_MISSING"); const custody = parseCustody(custodyRow);
      if (custody.keyReference !== record.keyReference || custody.bindingSha256 !== record.bindingSha256 || custody.state !== "erasing") throw new Error("CHECKPOINT_DELETE_BINDING_REQUIRED");
      const changed = await client.query("UPDATE production_real.checkpoint_crypto_records SET wrapped_dek=NULL,ciphertext=''::bytea,state='destroyed',destroyed_at=clock_timestamp() WHERE key_reference=$1 AND state='active' RETURNING checkpoint_id", [record.keyReference]);
      if (changed.rows.length !== 1) throw new Error("CHECKPOINT_DELETE_BINDING_REQUIRED");
      await client.query("INSERT INTO production_real.checkpoint_crypto_audit(checkpoint_id,key_reference,event,details_sha256) VALUES($1,$2,'destroyed',$3)", [record.checkpointId, record.keyReference, record.ciphertextSha256]);
      await client.query("UPDATE production_real.checkpoint_object_key_custody SET state='destroyed',destroyed_at=clock_timestamp() WHERE checkpoint_id=$1 AND state='erasing'", [record.checkpointId]);
    });
  }
  async #pureSql<T>(operation: (client: PostgresSqlClient) => Promise<T>): Promise<T> {
    for (let attempt = 0; attempt < 3; attempt += 1) {
      const client = await this.#pool.connect();
      try { await client.query("BEGIN ISOLATION LEVEL SERIALIZABLE"); const result = await operation(client); await client.query("COMMIT"); return result; }
      catch (error) { await client.query("ROLLBACK").catch(() => undefined); const code = sqlErrorCode(error); if (attempt < 2 && (code === "40001" || code === "40P01")) continue; throw error; }
      finally { client.release(); }
    }
    throw new Error("OBJECT_CUSTODY_SERIALIZATION_RETRY_EXHAUSTED");
  }
  #replay(record: StoredRecord, bindingSha256: string, plaintextSha256: string, aadSha256: string) { if (record.state !== "active" || !record.wrappedDek || record.bindingSha256 !== bindingSha256 || record.plaintextSha256 !== plaintextSha256 || record.aadSha256 !== aadSha256 || record.ciphertextSha256 !== sha256(record.ciphertext)) throw new Error("CHECKPOINT_IDENTITY_CONFLICT"); return Object.freeze({ keyReference: record.keyReference, nonce: new Uint8Array(record.nonce), ciphertext: new Uint8Array(record.ciphertext) }); }
}

export const THIRTY_DAY_RETENTION_MS = 30 * DAY_MS;
