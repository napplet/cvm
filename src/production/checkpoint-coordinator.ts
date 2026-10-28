import { bindAccountingRealmPool, createAccountingRealm } from "../funding/accounting-realm";
import { createHash } from "node:crypto";
import { z } from "zod";
import { CheckpointEnvelopeSchema, CheckpointEnvelopeService, CheckpointManifestSchema, type CheckpointEnvelope, type CheckpointManifest, type CheckpointSealRequest } from "../continuity/checkpoint-envelope";
import { ImmutableObjectReferenceSchema, type ObjectStorePort } from "../continuity/object-store";
import type { PostgresSqlPool } from "../persistence/postgres-sql-funding-store";
import { canonicalJson } from "../promotion/schema";
import { assertPostgresOperationJournal, type PostgresOperationJournal } from "../release/deployment/postgres-operation-journal";
import { ProtectedContinuationCommands } from "../continuity/protected-command";
import { MountedKekCheckpointCrypto, loadMountedCheckpointKek } from "./checkpoint-crypto";

const Identity = z.string().min(1).max(256).regex(/^[A-Za-z0-9][A-Za-z0-9_.:/-]*$/u);
const Digest = z.string().regex(/^[a-f0-9]{64}$/u);
const sha256 = (value: Uint8Array | string) => createHash("sha256").update(value).digest("hex");
const b64 = (value: Uint8Array) => Buffer.from(value).toString("base64");
const canonicalBytes = (value: unknown) => new TextEncoder().encode(canonicalJson(value));

type StoredEnvelope = Readonly<{
  manifest: CheckpointManifest;
  object: z.infer<typeof ImmutableObjectReferenceSchema>;
  keyReference: string;
  state: "retained" | "destroyed";
}>;
type CoordinatorIntent = Readonly<{ checkpointId: string; requestSha256: string; committedAt: string; formatVersion?: 2; objectWrite?: Readonly<{ key: string; checksum: string }> }>;
const coordinators = new WeakSet<object>();

function rowToStored(row: Record<string, unknown>): StoredEnvelope {
  const manifestValue = typeof row.manifest_json === "string" ? JSON.parse(row.manifest_json) : row.manifest_json;
  const manifest = CheckpointManifestSchema.parse(manifestValue);
  const object = ImmutableObjectReferenceSchema.parse({ key: row.object_key, generation: Number(row.object_generation), checksum: row.object_checksum });
  const keyReference = Identity.parse(row.key_reference);
  const state = z.enum(["retained", "destroyed"]).parse(row.state);
  if (manifest.checkpointId !== row.checkpoint_id || manifest.accountId !== row.account_id || manifest.sessionId !== row.session_id || manifest.action.actionId !== row.action_id || manifest.action.operationId !== row.operation_id || manifest.retentionUntil !== new Date(String(row.retention_until)).toISOString()) throw new Error("PRODUCTION_CHECKPOINT_BINDING_INVALID");
  return Object.freeze({ manifest, object, keyReference, state });
}

/**
 * Coordinates worker-independent durable checkpoint persistence. The journal
 * is written before any GCS attempt; the crypto port then persists original
 * nonce/ciphertext in restricted PostgreSQL before object creation. Retrying
 * an ambiguous object write can therefore only observe/create the identical
 * object, never generate a replacement ciphertext.
 */
export class ProductionCheckpointCoordinator {
  readonly #pool: PostgresSqlPool;
  readonly #crypto: MountedKekCheckpointCrypto;
  readonly pendingCommands: ProtectedContinuationCommands;
  constructor(private readonly input: Readonly<{
    pool: PostgresSqlPool;
    objectStore: ObjectStorePort;
    journal: PostgresOperationJournal;
    kekPath: string;
    readKekFile?: (path: string) => Promise<Uint8Array | string>;
    now?: () => number;
  }>) {
    assertPostgresOperationJournal(input.journal);
    this.#pool = bindAccountingRealmPool(input.pool, createAccountingRealm("production-real"));
    if (!input.objectStore || typeof input.objectStore.createImmutable !== "function") throw new Error("PRODUCTION_CHECKPOINT_OBJECT_STORE_REQUIRED");
    this.#crypto = new MountedKekCheckpointCrypto({ pool: input.pool, kekPath: input.kekPath, readFile: input.readKekFile, now: input.now });
    this.pendingCommands = new ProtectedContinuationCommands({ reference: "mounted-checkpoint-command-kek-v1", load: () => loadMountedCheckpointKek({ kekPath: input.kekPath, readFile: input.readKekFile }) }, input.now ?? Date.now);
    coordinators.add(this);
  }

  /** Implements the neutral seal contract but carries its own original-operation journal. */
  async seal(request: CheckpointSealRequest): Promise<Readonly<{ manifest: CheckpointManifest; envelope: CheckpointEnvelope }>> {
    if (request.payloadKind === "pending_command") throw new Error("PENDING_CHECKPOINT_FIXED_RETENTION_REQUIRED");
    return this.#seal(request);
  }

  async sealPending(request: Omit<CheckpointSealRequest, "retentionUntil"> & Readonly<{ payloadKind: "pending_command" }>): Promise<Readonly<{ manifest: CheckpointManifest; envelope: CheckpointEnvelope }>> {
    return this.#seal(request);
  }

  async #seal(originalRequest: CheckpointSealRequest | (Omit<CheckpointSealRequest, "retentionUntil"> & Readonly<{ payloadKind: "pending_command" }>)): Promise<Readonly<{ manifest: CheckpointManifest; envelope: CheckpointEnvelope }>> {
    const checkpointId = Identity.parse(originalRequest.checkpointId);
    const requestSha256 = sha256(canonicalBytes({ ...originalRequest, archive: undefined, archiveSha256: sha256(originalRequest.archive) }));
    const operationId = `checkpoint-seal:${checkpointId}`;
    const claimed = await this.input.journal.claim<CoordinatorIntent>(operationId, requestSha256, Object.freeze({ formatVersion: 2, checkpointId, requestSha256, committedAt: new Date((this.input.now ?? Date.now)()).toISOString() }));
    const intent = claimed.record.value;
    if (intent.checkpointId !== checkpointId || intent.requestSha256 !== requestSha256 || Number.isNaN(Date.parse(intent.committedAt))) throw new Error("CHECKPOINT_IDENTITY_CONFLICT");
    const request: CheckpointSealRequest = { ...originalRequest, retentionUntil: "retentionUntil" in originalRequest ? originalRequest.retentionUntil : new Date(Date.parse(intent.committedAt) + 2_592_000_000).toISOString() };
    const existing = await this.#find(checkpointId);
    if (existing) return this.#readback(existing, request);
    // A legacy unresolved operation has no trustworthy upload-dispatch fence.
    // Without its original crypto record, even a new nonce would invent lineage.
    if (intent.formatVersion !== 2 && !await this.#crypto.readSealed(checkpointId)) throw new Error("CHECKPOINT_OBJECT_RECONCILIATION_REQUIRED");

    const objectStore: ObjectStorePort = {
      createImmutable: value => this.#createOriginalObject(operationId, requestSha256, value),
      readExact: value => this.input.objectStore.readExact(value),
      observeExactByKey: value => this.input.objectStore.observeExactByKey(value),
      scheduleExactDeletion: (value, deadline) => this.input.objectStore.scheduleExactDeletion(value, deadline),
    };
    const envelopeService = new CheckpointEnvelopeService({ crypto: this.#crypto, objectStore, now: () => intent.committedAt });
    const sealed = await envelopeService.seal(request);
    if (sealed.manifest.checkpointId !== checkpointId || sealed.manifest.committedAt !== intent.committedAt) throw new Error("CHECKPOINT_IDENTITY_CONFLICT");
    await this.#persist(sealed);
    return sealed;
  }

  /** Server-owned exact material loader for ContinuationService; callers never supply envelopes. */
  async loadExact(input: Readonly<{ checkpointId: string; accountId: string; sessionId: string }>): Promise<Readonly<{ manifest: CheckpointManifest; envelope: CheckpointEnvelope }>> {
    const checkpointId = Identity.parse(input.checkpointId);
    const stored = await this.#find(checkpointId);
    if (!stored || stored.state !== "retained" || stored.manifest.accountId !== input.accountId || stored.manifest.sessionId !== input.sessionId || Date.parse(stored.manifest.retentionUntil) <= (this.input.now ?? Date.now)()) throw new Error("CHECKPOINT_RESTORE_DENIED");
    const sealed = await this.#crypto.readSealed(checkpointId);
    if (!sealed || sealed.keyReference !== stored.keyReference || sealed.ciphertextSha256 !== stored.object.checksum) throw new Error("CHECKPOINT_RESTORE_DENIED");
    return Object.freeze({ manifest: stored.manifest, envelope: CheckpointEnvelopeSchema.parse({ schemaVersion: "checkpoint-envelope-v1", manifestSha256: sha256(canonicalBytes(stored.manifest)), ciphertextBase64: b64(sealed.ciphertext), ciphertextSha256: sealed.ciphertextSha256, object: stored.object, crypto: { algorithm: "AES-GCM", keyReference: sealed.keyReference, nonceBase64: b64(sealed.nonce), aadSha256: sealed.aadSha256 } }) });
  }

  async restore(input: Readonly<{ checkpointId: string; accountId: string; sessionId: string }>): Promise<Uint8Array> {
    const material = await this.loadExact(input);
    const service = new CheckpointEnvelopeService({ crypto: this.#crypto, objectStore: this.input.objectStore });
    return service.restore(material.envelope, material.manifest);
  }

  /** Retention reaper; it only destroys the original key and exact GCS generation. */
  async destroyExpired(input: Readonly<{ checkpointId: string; accountId: string; sessionId: string }>): Promise<void> {
    const stored = await this.#find(Identity.parse(input.checkpointId));
    if (!stored || stored.manifest.accountId !== input.accountId || stored.manifest.sessionId !== input.sessionId || Date.parse(stored.manifest.retentionUntil) > (this.input.now ?? Date.now)()) throw new Error("CHECKPOINT_DELETE_BINDING_REQUIRED");
    if (stored.state === "destroyed") {
      if (!await this.observeDestroyed(input)) throw new Error("CHECKPOINT_DELETE_RECONCILIATION_REQUIRED");
      return;
    }
    const identity = sha256(canonicalBytes({ checkpointId: stored.manifest.checkpointId, accountId: input.accountId, sessionId: input.sessionId, object: stored.object, keyReference: stored.keyReference }));
    const operation = `checkpoint-delete:${stored.manifest.checkpointId}`;
    type Deletion = Readonly<{ bindingSha256: string; objectClaimed?: true }>;
    await this.input.journal.claim<Deletion>(operation, identity, { bindingSha256: identity });
    // Key erasure and its audit commit together. A failed local transaction
    // leaves object dispatch unclaimed and can safely be retried.
    await this.#crypto.destroy(stored.keyReference);
    const original = await this.input.objectStore.readExact(stored.object);
    if (original !== undefined) {
      const prior = await this.input.journal.read<Deletion>(operation);
      if (!prior || prior.identitySha256 !== identity || prior.value.bindingSha256 !== identity) throw new Error("CHECKPOINT_DELETE_BINDING_REQUIRED");
      if (prior.value.objectClaimed || !await this.input.journal.compareAndSet<Deletion>(operation, identity, prior.revision, { ...prior.value, objectClaimed: true })) throw new Error("CHECKPOINT_DELETE_RECONCILIATION_REQUIRED");
      await this.input.objectStore.scheduleExactDeletion(stored.object, stored.manifest.retentionUntil);
      if (await this.input.objectStore.readExact(stored.object) !== undefined) throw new Error("CHECKPOINT_DELETE_RECONCILIATION_REQUIRED");
    }
    const client = await this.#pool.connect();
    try {
      const updated = await client.query("UPDATE production_real.checkpoint_envelopes SET state='destroyed',destroyed_at=clock_timestamp() WHERE checkpoint_id=$1 AND account_id=$2 AND session_id=$3 AND state='retained' RETURNING checkpoint_id", [stored.manifest.checkpointId, input.accountId, input.sessionId]);
      if (updated.rows.length !== 1 && !await this.observeDestroyed(input)) throw new Error("CHECKPOINT_DELETE_BINDING_REQUIRED");
    } finally { client.release(); }
  }

  /** Query every retained component after expiry deletion.  A SQL state change
   * alone is not deletion proof: the exact GCS generation and wrapped DEK
   * must both be gone before a restore drill may report success. */
  async observeDestroyed(input: Readonly<{ checkpointId: string; accountId: string; sessionId: string }>): Promise<boolean> {
    const stored = await this.#find(Identity.parse(input.checkpointId));
    if (!stored || stored.manifest.accountId !== input.accountId || stored.manifest.sessionId !== input.sessionId || stored.state !== "destroyed") return false;
    const [object, keyDestroyed] = await Promise.all([
      this.input.objectStore.readExact(stored.object),
      this.#crypto.isDestroyed(stored.keyReference),
    ]);
    return object === undefined && keyDestroyed;
  }

  /** The first durable object-write CAS owns upload. Every later process
   * observes the original key/checksum, including an acknowledgement loss.
   * Old intents without this dispatch fence stay query-only when unresolved. */
  async #createOriginalObject(operationId: string, requestSha256: string, value: Parameters<ObjectStorePort["createImmutable"]>[0]) {
    const expected = { key: value.key, checksum: sha256(value.bytes) };
    const prior = await this.input.journal.read<CoordinatorIntent>(operationId);
    if (!prior || prior.identitySha256 !== requestSha256 || prior.value.requestSha256 !== requestSha256) throw new Error("CHECKPOINT_IDENTITY_CONFLICT");
    if (prior.value.objectWrite && (prior.value.objectWrite.key !== expected.key || prior.value.objectWrite.checksum !== expected.checksum)) throw new Error("CHECKPOINT_IDENTITY_CONFLICT");
    const observe = async () => {
      const found = await this.input.objectStore.observeExactByKey(expected);
      if (!found) return undefined;
      const exact = ImmutableObjectReferenceSchema.parse(found);
      if (exact.key !== expected.key || exact.checksum !== expected.checksum) throw new Error("CHECKPOINT_IDENTITY_CONFLICT");
      return exact;
    };
    const existing = await observe();
    if (existing) return existing;
    if (prior.value.formatVersion !== 2 || prior.value.objectWrite) throw new Error("CHECKPOINT_OBJECT_RECONCILIATION_REQUIRED");
    const claimed = await this.input.journal.compareAndSet(operationId, requestSha256, prior.revision, { ...prior.value, objectWrite: expected });
    if (!claimed) {
      const original = await observe();
      if (original) return original;
      throw new Error("CHECKPOINT_OBJECT_RECONCILIATION_REQUIRED");
    }
    return this.input.objectStore.createImmutable(value);
  }

  async #find(checkpointId: string): Promise<StoredEnvelope | undefined> {
    const client = await this.#pool.connect();
    try { const row = (await client.query<Record<string, unknown>>("SELECT checkpoint_id,account_id,session_id,action_id,operation_id,manifest_json,object_key,object_generation,object_checksum,key_reference,retention_until::text AS retention_until,state FROM production_real.checkpoint_envelopes WHERE checkpoint_id=$1", [checkpointId])).rows[0]; return row ? rowToStored(row) : undefined; }
    finally { client.release(); }
  }
  async #persist(sealed: Readonly<{ manifest: CheckpointManifest; envelope: CheckpointEnvelope }>): Promise<void> {
    const client = await this.#pool.connect();
    try {
      const m = sealed.manifest, e = sealed.envelope;
      const inserted = await client.query<Record<string, unknown>>("INSERT INTO production_real.checkpoint_envelopes(checkpoint_id,account_id,session_id,action_id,operation_id,manifest_json,object_key,object_generation,object_checksum,key_reference,retention_until,state) VALUES($1,$2,$3,$4,$5,$6::jsonb,$7,$8,$9,$10,$11,'retained') ON CONFLICT DO NOTHING RETURNING checkpoint_id,account_id,session_id,action_id,operation_id,manifest_json,object_key,object_generation,object_checksum,key_reference,retention_until::text AS retention_until,state", [m.checkpointId, m.accountId, m.sessionId, m.action.actionId, m.action.operationId, JSON.stringify(m), e.object.key, e.object.generation, e.object.checksum, e.crypto.keyReference, m.retentionUntil]);
      const row = inserted.rows[0] ?? (await client.query<Record<string, unknown>>("SELECT checkpoint_id,account_id,session_id,action_id,operation_id,manifest_json,object_key,object_generation,object_checksum,key_reference,retention_until::text AS retention_until,state FROM production_real.checkpoint_envelopes WHERE checkpoint_id=$1", [m.checkpointId])).rows[0];
      if (!row) throw new Error("PRODUCTION_CHECKPOINT_RECORD_MISSING");
      const existing = rowToStored(row);
      if (canonicalJson(existing.manifest) !== canonicalJson(m) || existing.object.key !== e.object.key || existing.object.generation !== e.object.generation || existing.object.checksum !== e.object.checksum || existing.keyReference !== e.crypto.keyReference) throw new Error("CHECKPOINT_IDENTITY_CONFLICT");
    } finally { client.release(); }
  }
  async #readback(stored: StoredEnvelope, request: CheckpointSealRequest): Promise<Readonly<{ manifest: CheckpointManifest; envelope: CheckpointEnvelope }>> {
    if (stored.manifest.accountId !== request.accountId || stored.manifest.sessionId !== request.sessionId || stored.manifest.action.actionId !== request.action.actionId || stored.manifest.action.operationId !== request.action.operationId || stored.manifest.archiveSha256 !== sha256(request.archive) || stored.manifest.retentionUntil !== request.retentionUntil) throw new Error("CHECKPOINT_IDENTITY_CONFLICT");
    return this.loadExact({ checkpointId: stored.manifest.checkpointId, accountId: request.accountId, sessionId: request.sessionId });
  }
}

/** Reject lookalikes so release assembly can require the real mounted-KEK,
 * restricted-Postgres coordinator rather than an injected test callback. */
export function assertProductionCheckpointCoordinator(value: unknown): asserts value is ProductionCheckpointCoordinator {
  if (!value || typeof value !== "object" || !coordinators.has(value)) throw new Error("PRODUCTION_CHECKPOINT_COORDINATOR_REQUIRED");
}
