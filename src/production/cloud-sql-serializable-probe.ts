import { canonicalJson } from "../promotion/schema";
import { PostgresOperationJournal } from "../release/deployment/postgres-operation-journal";
import { bindAccountingRealmPool, createAccountingRealm } from "../funding/accounting-realm";
import type { PostgresSqlClient, PostgresSqlPool } from "../persistence/postgres-sql-funding-store";

type ProbeState = Readonly<{ version: 1; state: "started" | "completed"; operationId: string; instanceId: string; effectOperationId: string }>;
const digest = async (value: unknown) => Array.from(new Uint8Array(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(canonicalJson(value)))), byte => byte.toString(16).padStart(2, "0")).join("");
const valid = (value: string) => /^[a-z][a-z0-9_-]{2,127}$/u.test(value);

/** A bounded proof that two concurrent, serializable writers carrying the
 * same original idempotency key commit exactly one run-owned journal effect.
 * It never reads or mutates balances, admissions, or wallet material. */
export async function probeCloudSqlSerializable(input: Readonly<{ pool: PostgresSqlPool; journal: PostgresOperationJournal; operationId: string; instanceId: string }>) {
  if (!valid(input.operationId) || !valid(input.instanceId)) return Object.freeze({ status: "blocked" as const });
  const probeOperationId = `sql-probe:${input.operationId}`;
  const effectOperationId = `effect:${input.operationId}`;
  const identitySha256 = await digest({ version: 1, operationId: input.operationId, instanceId: input.instanceId });
  const state: ProbeState = Object.freeze({ version: 1, state: "started", operationId: input.operationId, instanceId: input.instanceId, effectOperationId });
  const pool = bindAccountingRealmPool(input.pool, createAccountingRealm("production-real"));
  const proveExisting = async (): Promise<boolean> => {
    const client = await pool.connect();
    try {
      const rows = await client.query<{ count?: unknown }>("SELECT count(*)::text AS count FROM production_real.release_operation_journal WHERE namespace=$1 AND scope_sha256=$2 AND operation_id=$3 AND identity_sha256=$4", ["production-cloud-sql-probe-effect", identitySha256, effectOperationId, identitySha256]);
      return Number(rows.rows[0]?.count) === 1;
    } finally { client.release(); }
  };
  const recover = async (record: Readonly<{ identitySha256: string; value: unknown }>) => {
    if (record.identitySha256 !== identitySha256) return Object.freeze({ status: "blocked" as const });
    const prior = record.value as Partial<ProbeState>;
    if (prior.state === "completed" && prior.operationId === input.operationId && prior.instanceId === input.instanceId) return Object.freeze({ status: "completed" as const, operationId: input.operationId, isolationLevel: "serializable" as const, duplicateEffectCount: 0 as const });
    /* Recovery is query-only: an uncertain first execution may be reported
     * complete only when its original immutable effect is present. */
    return await proveExisting()
      ? Object.freeze({ status: "completed" as const, operationId: input.operationId, isolationLevel: "serializable" as const, duplicateEffectCount: 0 as const })
      : Object.freeze({ status: "unknown" as const });
  };
  /* An already-recorded original is recovered read-only.  Do not claim, retry,
   * or redispatch a probe whose first SQL write may have committed. */
  const existing = await input.journal.read<ProbeState>(probeOperationId);
  if (existing) return recover(existing);
  const claimed = await input.journal.claim(probeOperationId, identitySha256, state);
  if (!claimed.claimed) {
    return recover(claimed.record);
  }
  const writeOnce = async (): Promise<void> => {
    for (let attempt = 0; attempt < 3; attempt += 1) {
      const client = await pool.connect();
      try {
        await client.query("BEGIN ISOLATION LEVEL SERIALIZABLE");
        await client.query("SET LOCAL lock_timeout = '1s'");
        await client.query("SET LOCAL statement_timeout = '5s'");
        const isolation = (await client.query<{ transaction_isolation?: unknown }>("SHOW transaction_isolation")).rows[0]?.transaction_isolation;
        if (String(isolation).toLowerCase() !== "serializable") throw new Error("CLOUD_SQL_PROBE_ISOLATION_INVALID");
        await client.query("INSERT INTO production_real.release_operation_journal(namespace,scope_sha256,operation_id,identity_sha256,value_json) VALUES($1,$2,$3,$4,$5::jsonb) ON CONFLICT(namespace,scope_sha256,operation_id) DO NOTHING", ["production-cloud-sql-probe-effect", identitySha256, effectOperationId, identitySha256, JSON.stringify({ version: 1, operationId: input.operationId, instanceId: input.instanceId, effect: "idempotent-probe" })]);
        await client.query("COMMIT");
        return;
      } catch (error) {
        await client.query("ROLLBACK").catch(() => undefined);
        if (attempt === 2 || !["40001", "40P01", "23505"].includes(String((error as { code?: string }).code))) throw error;
      } finally { client.release(); }
    }
  };
  try {
    await Promise.all([writeOnce(), writeOnce()]);
    if (!await proveExisting()) return Object.freeze({ status: "unknown" as const });
    const completed: ProbeState = Object.freeze({ ...state, state: "completed" });
    await input.journal.compareAndSet(probeOperationId, identitySha256, claimed.record.revision, completed);
    return Object.freeze({ status: "completed" as const, operationId: input.operationId, isolationLevel: "serializable" as const, duplicateEffectCount: 0 as const });
  } catch { return Object.freeze({ status: "unknown" as const }); }
}
