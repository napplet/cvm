import { bindAccountingRealmPool, createAccountingRealm } from "../../funding/accounting-realm";
import type { PostgresSqlClient, PostgresSqlPool } from "../../persistence/postgres-sql-funding-store";

export type OperationRecord<T = unknown> = Readonly<{ operationId: string; identitySha256: string; revision: number; value: T }>;
const instances = new WeakSet<object>();
const digest = (value: string) => { if (!/^[a-f0-9]{64}$/u.test(value)) throw new Error("OPERATION_DIGEST_INVALID"); return value; };
const identifier = (value: string) => { if (!/^[A-Za-z0-9][A-Za-z0-9_.:/-]{0,255}$/u.test(value)) throw new Error("OPERATION_IDENTIFIER_INVALID"); return value; };
function encode(value: unknown): string {
  const seen = new Set<object>();
  function visit(item: unknown, depth: number): void {
    if (depth > 64) throw new Error("OPERATION_VALUE_INVALID");
    if (item === null || typeof item === "string" || typeof item === "boolean") return;
    if (typeof item === "number" && Number.isFinite(item)) return;
    if (!item || typeof item !== "object" || seen.has(item) || (!Array.isArray(item) && Object.getPrototypeOf(item) !== Object.prototype && Object.getPrototypeOf(item) !== null)) throw new Error("OPERATION_VALUE_INVALID");
    seen.add(item);
    for (const child of Object.values(item)) visit(child, depth + 1);
    seen.delete(item);
  }
  visit(value, 0);
  const encoded = JSON.stringify(value);
  if (Buffer.byteLength(encoded) > 1_048_576) throw new Error("OPERATION_VALUE_TOO_LARGE");
  return encoded;
}
function freeze<T>(value: T): T {
  if (value && typeof value === "object") { for (const child of Object.values(value)) freeze(child); Object.freeze(value); }
  return value;
}
function record<T>(row: Record<string, unknown>): OperationRecord<T> {
  const revision = Number(row.revision);
  if (!Number.isSafeInteger(revision) || revision < 1) throw new Error("OPERATION_REVISION_INVALID");
  return freeze({ operationId: identifier(String(row.operation_id)), identitySha256: digest(String(row.identity_sha256)), revision, value: JSON.parse(encode(row.value_json)) as T });
}

/** Production authority. Construction performs no I/O; every access selects the restricted realm.
 * Values are bounded JSON observations or encrypted envelopes, never credentials.
 * A false claim means query-only recovery; it never licenses another external dispatch.
 */
export class PostgresOperationJournal {
  readonly #pool: PostgresSqlPool;
  readonly #namespace: string;
  readonly #scope: string;
  constructor(pool: PostgresSqlPool, options: Readonly<{ namespace: string; scopeSha256: string }>) {
    this.#namespace = identifier(options.namespace);
    this.#scope = digest(options.scopeSha256);
    this.#pool = bindAccountingRealmPool(pool, createAccountingRealm("production-real"));
    instances.add(this);
    Object.freeze(this);
  }
  async #transaction<T>(action: (client: PostgresSqlClient) => Promise<T>): Promise<T> {
    for (let attempt = 0; attempt < 3; attempt++) {
      const client = await this.#pool.connect();
      try {
        await client.query("BEGIN ISOLATION LEVEL SERIALIZABLE");
        await client.query("SET LOCAL lock_timeout = '1s'");
        await client.query("SET LOCAL statement_timeout = '5s'");
        const result = await action(client);
        await client.query("COMMIT");
        return result;
      } catch (error) {
        await client.query("ROLLBACK").catch(() => undefined);
        if (attempt === 2 || !["40001", "40P01", "23505"].includes(String((error as { code?: string }).code))) throw error;
      } finally { client.release(); }
    }
    throw new Error("OPERATION_JOURNAL_RETRY_EXHAUSTED");
  }
  async claim<T>(operationId: string, identitySha256: string, value: T): Promise<Readonly<{ claimed: boolean; record: OperationRecord<T> }>> {
    return this.#claim(operationId, identitySha256, value);
  }
  /** Bound new operations in the same serializable transaction as their claim.
   * Existing originals remain readable at the cap; parallel callers cannot
   * each spend the same final inventory slot. */
  async claimBounded<T>(operationId: string, identitySha256: string, value: T, maximumOperations: number): Promise<Readonly<{ claimed: boolean; record: OperationRecord<T> }>> {
    if (!Number.isSafeInteger(maximumOperations) || maximumOperations < 1 || maximumOperations > 1_000_000) throw new Error("OPERATION_LIMIT_INVALID");
    return this.#claim(operationId, identitySha256, value, maximumOperations);
  }
  async #claim<T>(operationId: string, identitySha256: string, value: T, maximumOperations?: number): Promise<Readonly<{ claimed: boolean; record: OperationRecord<T> }>> {
    identifier(operationId); digest(identitySha256); const encoded = encode(value);
    return this.#transaction(async client => {
      if (maximumOperations !== undefined) {
        await client.query("SELECT pg_advisory_xact_lock(hashtextextended($1, 0))", [`${this.#namespace}:${this.#scope}`]);
        const prior = (await client.query("SELECT * FROM production_real.release_operation_journal WHERE namespace=$1 AND scope_sha256=$2 AND operation_id=$3", [this.#namespace, this.#scope, operationId])).rows[0];
        if (prior) {
          if (prior.identity_sha256 !== identitySha256) throw new Error("OPERATION_IDENTITY_CONFLICT");
          return Object.freeze({ claimed: false, record: record<T>(prior) });
        }
        const count = Number((await client.query("SELECT count(*)::text AS count FROM production_real.release_operation_journal WHERE namespace=$1 AND scope_sha256=$2", [this.#namespace, this.#scope])).rows[0]?.count);
        if (!Number.isSafeInteger(count) || count < 0) throw new Error("OPERATION_JOURNAL_COUNT_INVALID");
        if (count >= maximumOperations) throw new Error("PRODUCTION_CONTROL_OPERATION_LIMIT_REACHED");
      }
      const inserted = await client.query("INSERT INTO production_real.release_operation_journal(namespace,scope_sha256,operation_id,identity_sha256,value_json) VALUES($1,$2,$3,$4,$5::jsonb) ON CONFLICT(namespace,scope_sha256,operation_id) DO NOTHING RETURNING *", [this.#namespace, this.#scope, operationId, identitySha256, encoded]);
      const row = inserted.rows[0] ?? (await client.query("SELECT * FROM production_real.release_operation_journal WHERE namespace=$1 AND scope_sha256=$2 AND operation_id=$3", [this.#namespace, this.#scope, operationId])).rows[0];
      if (!row) throw new Error("OPERATION_JOURNAL_RECORD_MISSING");
      if (row.identity_sha256 !== identitySha256) throw new Error("OPERATION_IDENTITY_CONFLICT");
      return Object.freeze({ claimed: inserted.rows.length === 1, record: record<T>(row) });
    });
  }
  async read<T = unknown>(operationId: string): Promise<OperationRecord<T> | undefined> {
    identifier(operationId);
    return this.#transaction(async client => {
      const row = (await client.query("SELECT * FROM production_real.release_operation_journal WHERE namespace=$1 AND scope_sha256=$2 AND operation_id=$3", [this.#namespace, this.#scope, operationId])).rows[0];
      return row ? record<T>(row) : undefined;
    });
  }
  /**
   * Finds one persisted resource binding without exposing a journal scan to a
   * control-plane caller.  This is intentionally limited to a top-level,
   * scalar JSON field and fails closed on ambiguity: a fresh-process restore
   * may reattach only the one original resource tuple that was journaled by
   * the create operation.
   */
  async readUniqueByValueField<T = unknown>(field: string, value: string): Promise<OperationRecord<T> | undefined> {
    if (!/^[A-Za-z][A-Za-z0-9_]{0,63}$/u.test(field) || !/^[A-Za-z0-9][A-Za-z0-9_.:/-]{0,255}$/u.test(value)) throw new Error("OPERATION_JOURNAL_LOOKUP_INVALID");
    return this.#transaction(async client => {
      const rows = await client.query<Record<string, unknown>>("SELECT * FROM production_real.release_operation_journal WHERE namespace=$1 AND scope_sha256=$2 AND value_json ->> $3 = $4 ORDER BY operation_id LIMIT 2", [this.#namespace, this.#scope, field, value]);
      if (rows.rows.length > 1) throw new Error("OPERATION_JOURNAL_LOOKUP_AMBIGUOUS");
      return rows.rows[0] ? record<T>(rows.rows[0]) : undefined;
    });
  }
  /** Bounded compatibility lookup for a retained nested request. Extra request
   * fields are allowed; multiple matching originals never select a winner. */
  async readUniqueByObjectFields<T = unknown>(field: string, fields: Readonly<Record<string, string | number>>): Promise<OperationRecord<T> | undefined> {
    const entries = Object.entries(fields);
    if (!/^[A-Za-z][A-Za-z0-9_]{0,63}$/u.test(field) || entries.length < 1 || entries.length > 8 || entries.some(([key, value]) => !/^[A-Za-z][A-Za-z0-9_]{0,63}$/u.test(key) || !(typeof value === "string" && value.length > 0 && value.length <= 512 || typeof value === "number" && Number.isSafeInteger(value) && value >= 0))) throw new Error("OPERATION_JOURNAL_LOOKUP_INVALID");
    return this.#transaction(async client => {
      const rows = await client.query<Record<string, unknown>>("SELECT * FROM production_real.release_operation_journal WHERE namespace=$1 AND scope_sha256=$2 AND value_json -> $3 @> $4::jsonb ORDER BY operation_id LIMIT 2", [this.#namespace, this.#scope, field, JSON.stringify(fields)]);
      if (rows.rows.length > 1) throw new Error("OPERATION_JOURNAL_LOOKUP_AMBIGUOUS");
      return rows.rows[0] ? record<T>(rows.rows[0]) : undefined;
    });
  }
  /** Bounded private-control admission guard scoped to this journal binding. */
  async countOperations(): Promise<number> {
    return this.#transaction(async client => {
      const row = (await client.query("SELECT count(*)::text AS count FROM production_real.release_operation_journal WHERE namespace=$1 AND scope_sha256=$2", [this.#namespace, this.#scope])).rows[0];
      const count = Number(row?.count);
      if (!Number.isSafeInteger(count) || count < 0) throw new Error("OPERATION_JOURNAL_COUNT_INVALID");
      return count;
    });
  }
  async compareAndSet<T>(operationId: string, identitySha256: string, expectedRevision: number, value: T): Promise<OperationRecord<T> | undefined> {
    identifier(operationId); digest(identitySha256);
    if (!Number.isSafeInteger(expectedRevision) || expectedRevision < 1) throw new Error("OPERATION_REVISION_INVALID");
    const encoded = encode(value);
    return this.#transaction(async client => {
      const row = (await client.query("UPDATE production_real.release_operation_journal SET value_json=$6::jsonb,revision=revision+1,updated_at=clock_timestamp() WHERE namespace=$1 AND scope_sha256=$2 AND operation_id=$3 AND identity_sha256=$4 AND revision=$5 RETURNING *", [this.#namespace, this.#scope, operationId, identitySha256, expectedRevision, encoded])).rows[0];
      return row ? record<T>(row) : undefined;
    });
  }
}

export function assertPostgresOperationJournal(value: unknown): asserts value is PostgresOperationJournal {
  if (!value || typeof value !== "object" || !instances.has(value)) throw new Error("PRODUCTION_POSTGRES_OPERATION_JOURNAL_REQUIRED");
}
