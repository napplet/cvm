import { createHash } from "node:crypto";
import { z } from "zod";
import type { ImmutableObjectCreateRequest, ImmutableObjectReference, ObjectStorePort } from "./object-store";
import type { PostgresSqlClient, PostgresSqlPool } from "../persistence/postgres-sql-funding-store";

const Digest = z.string().regex(/^[a-f0-9]{64}$/u);
const Key = z.string().min(1).max(2048);
const MAX_SAFE_GENERATION = Number.MAX_SAFE_INTEGER;
const ObjectRole = "napplet_production_object";
const DEFAULT_CHUNK_BYTES = 384 * 1024;
const DELETE_BATCH_SIZE = 64;

type Header = Readonly<{
  generation: number;
  checksum: string;
  byteCount: number;
  chunkCount: number;
  state: "writing" | "sealed" | "deleting" | "tombstoned";
  retentionUntil: string;
}>;

function sha256(value: Uint8Array): string { return createHash("sha256").update(value).digest("hex"); }
function sqlErrorCode(error: unknown): string | undefined { return error && typeof error === "object" && "code" in error ? String(error.code) : undefined; }
function asSafeInteger(value: unknown, code: string): number {
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed) || parsed < 0 || parsed > MAX_SAFE_GENERATION) throw new Error(code);
  return parsed;
}
function parseHeader(row: Record<string, unknown>): Header {
  const generation = asSafeInteger(row.generation, "OBJECT_GENERATION_INVALID");
  if (generation < 1) throw new Error("OBJECT_GENERATION_INVALID");
  const byteCount = asSafeInteger(row.byte_count, "OBJECT_SIZE_INVALID");
  const chunkCount = asSafeInteger(row.chunk_count, "OBJECT_CHUNK_COUNT_INVALID");
  const state = z.enum(["writing", "sealed", "deleting", "tombstoned"]).parse(row.state);
  const retentionUntil = new Date(String(row.retention_until)).toISOString();
  return Object.freeze({ generation, checksum: Digest.parse(row.checksum), byteCount, chunkCount, state, retentionUntil });
}

/**
 * A PostgreSQL 17 candidate implementation of the unchanged generation-pinned
 * object port. It deliberately owns only the restricted object SQL role; it
 * cannot read or mutate the ledger, secret tables, or raw object tables.
 */
export class PostgresByteaObjectStoreAdapter implements ObjectStorePort {
  readonly #chunkBytes: number;
  readonly #now: () => number;
  readonly #retentionUntil: () => string;

  constructor(private readonly input: Readonly<{
    pool: PostgresSqlPool;
    chunkBytes?: number;
    now?: () => number;
    /** A producer/version-bound retention deadline supplied by later composition. */
    retentionUntil?: () => string;
  }>) {
    if (!input.pool || typeof input.pool.connect !== "function") throw new Error("OBJECT_POOL_REQUIRED");
    this.#chunkBytes = input.chunkBytes ?? DEFAULT_CHUNK_BYTES;
    if (!Number.isSafeInteger(this.#chunkBytes) || this.#chunkBytes < 1 || this.#chunkBytes > DEFAULT_CHUNK_BYTES) throw new Error("OBJECT_CHUNK_SIZE_INVALID");
    this.#now = input.now ?? Date.now;
    this.#retentionUntil = input.retentionUntil ?? (() => new Date(this.#now() + 30 * 86_400_000).toISOString());
  }

  async createImmutable(request: ImmutableObjectCreateRequest): Promise<ImmutableObjectReference> {
    const key = Key.parse(request.key);
    if (!(request.bytes instanceof Uint8Array)) throw new Error("OBJECT_INVALID");
    // The caller may mutate its buffer after initiating storage. Own every byte
    // before the digest or first await, then zero this temporary on all exits.
    const owned = new Uint8Array(request.bytes);
    try {
      const checksum = sha256(owned);
      const originalOperationIdentity = request.originalOperationIdentity === undefined
        ? sha256(new TextEncoder().encode(`legacy-object:${key}:${checksum}`))
        : Digest.parse(request.originalOperationIdentity);
      const chunkCount = Math.ceil(owned.byteLength / this.#chunkBytes);
      if (!Number.isSafeInteger(chunkCount)) throw new Error("OBJECT_CHUNK_COUNT_INVALID");
      const deadline = new Date(this.#retentionUntil()).toISOString();
      if (Date.parse(deadline) <= this.#now()) throw new Error("OBJECT_RETENTION_INVALID");
      const header = await this.#claim(key, checksum, originalOperationIdentity, owned.byteLength, chunkCount, deadline);
      if (header.checksum !== checksum || header.byteCount !== owned.byteLength || header.chunkCount !== chunkCount) throw new Error("OBJECT_IMMUTABLE_CONFLICT");
      if (header.state === "sealed") return Object.freeze({ key, generation: header.generation, checksum });
      if (header.state !== "writing") throw new Error("OBJECT_WRITE_HELD");
      for (let ordinal = 0; ordinal < chunkCount; ordinal += 1) {
        const start = ordinal * this.#chunkBytes;
        const chunk = owned.slice(start, Math.min(owned.byteLength, start + this.#chunkBytes));
        try { await this.#writeChunk(key, header.generation, ordinal, chunk); }
        finally { chunk.fill(0); }
      }
      const actual = await this.#hashStaged(key, header.generation, chunkCount);
      if (actual !== checksum) throw new Error("OBJECT_CHUNK_DIGEST_INVALID");
      const sealed = await this.#seal(key, header.generation, checksum, owned.byteLength, chunkCount);
      if (!sealed) throw new Error("OBJECT_PARTIAL_WRITE");
      return Object.freeze({ key, generation: header.generation, checksum });
    } finally { owned.fill(0); }
  }

  async observeExactByKey(input: Readonly<{ key: string; checksum: string; originalOperationIdentity?: string }>): Promise<ImmutableObjectReference | undefined> {
    const key = Key.safeParse(input.key), checksum = Digest.safeParse(input.checksum);
    if (!key.success || !checksum.success) return undefined;
    const client = await this.#connect();
    try {
      const identity = Digest.safeParse(input.originalOperationIdentity);
      const row = (await client.query<Record<string, unknown>>(identity.success
        ? "SELECT * FROM production_real.observe_immutable_object($1,$2::char(64),$3::char(64))"
        : "SELECT * FROM production_real.observe_immutable_object($1,$2::char(64))", identity.success ? [key.data, checksum.data, identity.data] : [key.data, checksum.data])).rows[0];
      if (!row) return undefined;
      const generation = asSafeInteger(row.generation, "OBJECT_GENERATION_INVALID");
      if (generation < 1 || Digest.parse(row.checksum) !== checksum.data) throw new Error("OBJECT_EXACT_GENERATION_REQUIRED");
      return Object.freeze({ key: key.data, generation, checksum: checksum.data });
    } finally { client.release(); }
  }

  async readExact(reference: ImmutableObjectReference): Promise<Uint8Array | undefined> {
    const parsed = z.object({ key: Key, generation: z.number().int().min(1).max(MAX_SAFE_GENERATION), checksum: Digest }).strict().safeParse(reference);
    if (!parsed.success) return undefined;
    const summary = await this.#summary(parsed.data.key, parsed.data.generation);
    if (!summary || summary.state !== "sealed" || summary.checksum !== parsed.data.checksum || summary.retentionUntil <= new Date(this.#now()).toISOString()) return undefined;
    const bytes = new Uint8Array(summary.byteCount);
    let offset = 0;
    const hash = createHash("sha256");
    for (let ordinal = 0; ordinal < summary.chunkCount; ordinal += 1) {
      const chunk = await this.#readChunk(parsed.data.key, parsed.data.generation, ordinal, false);
      if (!chunk || offset + chunk.byteLength > bytes.byteLength) throw new Error("OBJECT_EXACT_GENERATION_REQUIRED");
      bytes.set(chunk, offset); offset += chunk.byteLength; hash.update(chunk); chunk.fill(0);
    }
    if (offset !== bytes.byteLength || hash.digest("hex") !== parsed.data.checksum) { bytes.fill(0); throw new Error("OBJECT_EXACT_GENERATION_REQUIRED"); }
    return bytes;
  }

  async scheduleExactDeletion(reference: ImmutableObjectReference, deleteAfter: string): Promise<void> {
    const parsed = z.object({ key: Key, generation: z.number().int().min(1).max(MAX_SAFE_GENERATION), checksum: Digest }).strict().parse(reference);
    const deadline = new Date(deleteAfter);
    if (Number.isNaN(deadline.getTime())) throw new Error("OBJECT_DELETE_INVALID");
    const client = await this.#connect();
    try {
      const claimed = (await client.query<Record<string, unknown>>("SELECT production_real.claim_immutable_object_deletion($1,$2,$3::char(64),$4::timestamptz) AS complete", [parsed.key, parsed.generation, parsed.checksum, deadline.toISOString()])).rows[0];
      if (claimed?.complete === true || deadline.getTime() > this.#now()) return;
    } finally { client.release(); }
    for (;;) {
      const batch = await this.#deleteBatch(parsed.key, parsed.generation);
      if (batch === 0) break;
    }
    const finalizer = await this.#connect();
    try {
      const result = (await finalizer.query<Record<string, unknown>>("SELECT production_real.finish_immutable_object_deletion($1,$2,$3::char(64)) AS complete", [parsed.key, parsed.generation, parsed.checksum])).rows[0];
      if (result?.complete !== true) throw new Error("OBJECT_DELETE_PARTIAL");
    } finally { finalizer.release(); }
  }

  async #claim(key: string, checksum: string, originalOperationIdentity: string, byteCount: number, chunkCount: number, retentionUntil: string): Promise<Header> {
    return this.#serializable(async client => {
      const row = (await client.query<Record<string, unknown>>("SELECT * FROM production_real.claim_immutable_object($1,$2::char(64),$3::char(64),$4,$5,$6::timestamptz)", [key, checksum, originalOperationIdentity, byteCount, chunkCount, retentionUntil])).rows[0];
      if (!row) throw new Error("OBJECT_CLAIM_REQUIRED");
      return parseHeader({ ...row, retention_until: retentionUntil });
    });
  }

  async #writeChunk(key: string, generation: number, ordinal: number, bytes: Uint8Array): Promise<void> {
    await this.#serializable(async client => {
      await client.query("SELECT production_real.write_immutable_object_chunk($1,$2,$3,$4::bytea)", [key, generation, ordinal, Buffer.from(bytes)]);
    });
  }

  async #hashStaged(key: string, generation: number, chunkCount: number): Promise<string> {
    const hash = createHash("sha256");
    for (let ordinal = 0; ordinal < chunkCount; ordinal += 1) {
      const chunk = await this.#readChunk(key, generation, ordinal, true);
      if (!chunk) throw new Error("OBJECT_PARTIAL_WRITE");
      hash.update(chunk); chunk.fill(0);
    }
    return hash.digest("hex");
  }

  async #seal(key: string, generation: number, checksum: string, byteCount: number, chunkCount: number): Promise<boolean> {
    return this.#serializable(async client => {
      const row = (await client.query<Record<string, unknown>>("SELECT production_real.seal_immutable_object($1,$2,$3::char(64),$4,$5) AS sealed", [key, generation, checksum, byteCount, chunkCount])).rows[0];
      return row?.sealed === true;
    });
  }

  async #summary(key: string, generation: number): Promise<Header | undefined> {
    const client = await this.#connect();
    try {
      const row = (await client.query<Record<string, unknown>>("SELECT * FROM production_real.immutable_object_summary($1,$2)", [key, generation])).rows[0];
      if (!row) return undefined;
      const header = parseHeader(row);
      const storedChunks = asSafeInteger(row.stored_chunks, "OBJECT_CHUNK_COUNT_INVALID");
      const storedBytes = asSafeInteger(row.stored_bytes, "OBJECT_SIZE_INVALID");
      if ((header.state === "sealed" || header.state === "deleting") && (storedChunks !== header.chunkCount || storedBytes !== header.byteCount)) throw new Error("OBJECT_PARTIAL_WRITE");
      return header;
    } finally { client.release(); }
  }

  async #readChunk(key: string, generation: number, ordinal: number, staged: boolean): Promise<Uint8Array | undefined> {
    const client = await this.#connect();
    try {
      const functionName = staged ? "read_immutable_object_staged_chunk" : "read_immutable_object_chunk";
      const row = (await client.query<Record<string, unknown>>(`SELECT production_real.${functionName}($1,$2,$3) AS bytes`, [key, generation, ordinal])).rows[0];
      const value = row?.bytes;
      if (value === null || value === undefined) return undefined;
      if (!(value instanceof Uint8Array) && !Buffer.isBuffer(value)) throw new Error("OBJECT_CHUNK_INVALID");
      return new Uint8Array(value);
    } finally { client.release(); }
  }

  async #deleteBatch(key: string, generation: number): Promise<number> {
    return this.#serializable(async client => {
      const row = (await client.query<Record<string, unknown>>("SELECT production_real.delete_immutable_object_chunk_batch($1,$2,$3) AS deleted", [key, generation, DELETE_BATCH_SIZE])).rows[0];
      return asSafeInteger(row?.deleted, "OBJECT_DELETE_PARTIAL");
    });
  }

  async #serializable<T>(operation: (client: PostgresSqlClient) => Promise<T>): Promise<T> {
    for (let attempt = 0; attempt < 3; attempt += 1) {
      const client = await this.#connect();
      try {
        await client.query("BEGIN ISOLATION LEVEL SERIALIZABLE");
        const result = await operation(client);
        await client.query("COMMIT");
        return result;
      } catch (error) {
        await client.query("ROLLBACK").catch(() => undefined);
        if (attempt < 2 && ["40001", "40P01"].includes(sqlErrorCode(error) ?? "")) continue;
        throw error;
      } finally { client.release(); }
    }
    throw new Error("OBJECT_SERIALIZATION_RETRY_EXHAUSTED");
  }

  async #connect(): Promise<PostgresSqlClient> {
    const client = await this.input.pool.connect();
    try {
      const identity = (await client.query<{ current_user: string; session_user: string; current_is_superuser: boolean; session_is_superuser: boolean }>("SELECT current_user::text AS current_user,session_user::text AS session_user,(SELECT rolsuper FROM pg_roles WHERE rolname=current_user) AS current_is_superuser,(SELECT rolsuper FROM pg_roles WHERE rolname=session_user) AS session_is_superuser")).rows[0];
      if (!identity || identity.current_is_superuser || identity.session_is_superuser || identity.current_user === "postgres" || identity.session_user === "postgres") throw new Error("OBJECT_POOL_SUPERUSER_DENIED");
      await client.query(`SET ROLE ${ObjectRole}`);
      const selected = (await client.query<{ current_user: string }>("SELECT current_user::text AS current_user")).rows[0];
      if (!selected || selected.current_user !== ObjectRole) throw new Error("OBJECT_POOL_ROLE_DENIED");
      await client.query("SET search_path TO production_real,pg_catalog");
      return client;
    } catch (error) { client.release(error instanceof Error ? error : undefined); throw error; }
  }
}
