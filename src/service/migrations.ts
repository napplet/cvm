import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import type { PostgresSqlClient, PostgresSqlPool } from "../persistence/postgres-sql-funding-store";

const root = resolve(import.meta.dir, "../..");

/**
 * The canonical, append-only migration sequence used by every deployment of
 * the service: operator deployments and local development.
 * Existing entries never change; checksums detect drift. The withdrawn
 * `phase-07/*` production_real schema is not part of this sequence.
 */
export const SERVICE_MIGRATIONS = Object.freeze([
  "phase-03/001_funding.sql", "phase-03/003_cashu_custody_and_identities.sql", "phase-04/001_metered_generation.sql", "phase-04/002_action_budget_lifecycle.sql",
  "phase-05/001_continuation.sql", "phase-06/001_publication.sql", "development/001_generation.sql", "development/002_provider_observations.sql",
  "development/003_artifact_preview.sql", "development/004_source_proposal_bindings.sql", "development/005_pending_actions.sql", "development/006_worker_results.sql",
  "development/007_chatgpt_operations.sql", "development/008_chatgpt_diagnostics.sql", "development/009_operator_publication.sql", "development/010_projects.sql",
  "development/011_publication_relays.sql", "development/012_remix_imports.sql", "development/013_publication_tracking.sql", "development/014_request_cost_history.sql",
  "development/015_revision_restore.sql", "development/016_usage_evidence.sql", "service/001_service_realm.sql", "development/017_validation_failures.sql",
] as const);

/** Historical ledger name, retained so existing databases upgrade in place. */
const LEDGER = "development_migrations";
const LOCK = 7351051;

export type Migration = Readonly<{ name: string; sha256: string; sql: string }>;

export async function canonicalMigrations(): Promise<readonly Migration[]> {
  return Promise.all(SERVICE_MIGRATIONS.map(async (name) => {
    const sql = await readFile(resolve(root, "migrations", name), "utf8");
    return Object.freeze({ name, sha256: new Bun.CryptoHasher("sha256").update(sql).digest("hex"), sql });
  }));
}

type Pool = PostgresSqlPool & Pick<PostgresSqlClient, "query">;

/** Applies pending canonical migrations in order, each in its own transaction. */
export async function applyCanonicalMigrations(pool: Pool, migrations?: readonly Migration[]): Promise<Readonly<{ applied: string[]; current: number }>> {
  const list = migrations ?? await canonicalMigrations();
  const client = await pool.connect();
  const applied: string[] = [];
  try {
    await client.query(`SELECT pg_advisory_lock(${LOCK})`);
    await client.query(`CREATE TABLE IF NOT EXISTS ${LEDGER} (name text PRIMARY KEY, sha256 text NOT NULL)`);
    const recorded = new Map((await client.query<{ name: string; sha256: string }>(`SELECT name, sha256 FROM ${LEDGER}`)).rows.map((row) => [row.name, row.sha256]));
    const known = new Set(list.map((migration) => migration.name));
    const unknown = [...recorded.keys()].filter((name) => !known.has(name));
    // A database migrated by a newer revision must not be served by an older one.
    if (unknown.length) throw new Error(`SERVICE_MIGRATION_UNKNOWN:${unknown.sort().join(",")}`);
    for (const migration of list) {
      const prior = recorded.get(migration.name);
      if (prior !== undefined) {
        if (prior !== migration.sha256) throw new Error(`SERVICE_MIGRATION_CHANGED:${migration.name}`);
        continue;
      }
      await client.query("BEGIN");
      try {
        await client.query(migration.sql.replace(/^(?:BEGIN|COMMIT);\s*$/gmu, ""));
        await client.query(`INSERT INTO ${LEDGER}(name, sha256) VALUES ($1, $2)`, [migration.name, migration.sha256]);
        await client.query("COMMIT");
        applied.push(migration.name);
      } catch (error) { await client.query("ROLLBACK"); throw error; }
    }
    return Object.freeze({ applied, current: list.length });
  } finally {
    await client.query(`SELECT pg_advisory_unlock(${LOCK})`).catch(() => undefined);
    client.release();
  }
}

/** Read-only startup check: the schema must exactly match this revision. */
export async function assertCanonicalSchema(pool: Pick<PostgresSqlClient, "query">, migrations?: readonly Migration[]): Promise<void> {
  const list = migrations ?? await canonicalMigrations();
  const rows = (await pool.query<{ name: string; sha256: string }>(`SELECT name, sha256 FROM ${LEDGER}`).catch(() => { throw new Error("SERVICE_SCHEMA_UNINITIALIZED"); })).rows;
  const recorded = new Map(rows.map((row) => [row.name, row.sha256]));
  for (const migration of list) {
    const prior = recorded.get(migration.name);
    if (prior === undefined) throw new Error(`SERVICE_MIGRATION_PENDING:${migration.name}`);
    if (prior !== migration.sha256) throw new Error(`SERVICE_MIGRATION_CHANGED:${migration.name}`);
  }
  if (recorded.size !== list.length) throw new Error("SERVICE_MIGRATION_UNKNOWN");
}

export type ServiceRealm = "test" | "real";

/**
 * Records the database's realm once. A database that already contains ledger
 * activity cannot be initialized as real money: existing balances are test credits.
 */
export async function initializeServiceRealm(pool: Pick<PostgresSqlClient, "query">, realm: ServiceRealm): Promise<ServiceRealm> {
  const current = (await pool.query<{ realm: ServiceRealm }>("SELECT realm FROM service_realm")).rows[0]?.realm;
  if (current) { if (current !== realm) throw new Error(`SERVICE_REALM_MISMATCH:${current}`); return current; }
  if (realm === "real") {
    const activity = (await pool.query<{ count: string }>("SELECT (SELECT count(*) FROM ledger_entries) + (SELECT count(*) FROM metered_actions) AS count")).rows[0];
    if (BigInt(activity?.count ?? "0") !== 0n) throw new Error("SERVICE_REAL_REALM_REQUIRES_EMPTY_LEDGER");
  }
  await pool.query("INSERT INTO service_realm(realm) VALUES ($1) ON CONFLICT (singleton) DO NOTHING", [realm]);
  const stored = (await pool.query<{ realm: ServiceRealm }>("SELECT realm FROM service_realm")).rows[0]?.realm;
  if (stored !== realm) throw new Error(`SERVICE_REALM_MISMATCH:${stored}`);
  return stored;
}

export async function assertServiceRealm(pool: Pick<PostgresSqlClient, "query">, realm: ServiceRealm): Promise<void> {
  const stored = (await pool.query<{ realm: ServiceRealm }>("SELECT realm FROM service_realm")).rows[0]?.realm;
  if (!stored) throw new Error("SERVICE_REALM_UNINITIALIZED");
  if (stored !== realm) throw new Error(`SERVICE_REALM_MISMATCH:${stored}`);
}
