import { afterAll, beforeAll, expect, test } from "bun:test";
import { createRequire } from "node:module";
import { SERVICE_MIGRATIONS, applyCanonicalMigrations, assertCanonicalSchema, assertServiceRealm, canonicalMigrations, initializeServiceRealm } from "../../src/service/migrations";

type Pool = { query<T = any>(sql: string, values?: unknown[]): Promise<{ rows: T[] }>; connect(): Promise<any>; end(): Promise<void> };
const { Pool: PgPool } = createRequire(import.meta.url)("pg") as { Pool: new (options: Record<string, unknown>) => Pool };
const integration = process.env.NAPPLET_RUN_POSTGRES_ISOLATION === "1" ? test : test.skip;
const name = `napplet-cvm-service-migrations-${crypto.randomUUID().slice(0, 8)}`;
let port = "";

async function docker(args: string[]) {
  const child = Bun.spawn(["docker", ...args], { stdout: "pipe", stderr: "pipe", stdin: "ignore" });
  const [stdout, stderr, code] = await Promise.all([new Response(child.stdout).text(), new Response(child.stderr).text(), child.exited]);
  if (code !== 0) throw new Error(`DOCKER_FAILED:${args[0]}:${stderr.slice(0, 300)}`);
  return stdout.trim();
}
async function database(db: string): Promise<Pool> {
  const admin = new PgPool({ connectionString: `postgresql://postgres@127.0.0.1:${port}/postgres`, connectionTimeoutMillis: 2000 });
  try { await admin.query(`CREATE DATABASE ${db}`); } finally { await admin.end(); }
  return new PgPool({ connectionString: `postgresql://postgres@127.0.0.1:${port}/${db}`, connectionTimeoutMillis: 2000 });
}

beforeAll(async () => {
  if (process.env.NAPPLET_RUN_POSTGRES_ISOLATION !== "1") return;
  await docker(["run", "--detach", "--rm", "--name", name, "--publish", "127.0.0.1::5432", "-e", "POSTGRES_HOST_AUTH_METHOD=trust", "postgres:17.11-alpine3.24"]);
  port = (await docker(["port", name, "5432/tcp"])).match(/127\.0\.0\.1:(\d+)/u)![1]!;
  const probe = new PgPool({ connectionString: `postgresql://postgres@127.0.0.1:${port}/postgres`, connectionTimeoutMillis: 2000 });
  for (let attempt = 0; ; attempt++) { try { await probe.query("SELECT 1"); break; } catch (error) { if (attempt > 120) throw error; await Bun.sleep(250); } }
  await probe.end();
}, 60_000);
afterAll(async () => { if (port) await docker(["rm", "--force", name]).catch(() => undefined); });

integration("clean install applies the canonical sequence once and is idempotent", async () => {
  const pool = await database("clean_install");
  try {
    await expect(assertCanonicalSchema(pool)).rejects.toThrow("SERVICE_SCHEMA_UNINITIALIZED");
    expect((await applyCanonicalMigrations(pool)).applied).toEqual([...SERVICE_MIGRATIONS]);
    expect((await applyCanonicalMigrations(pool)).applied).toEqual([]);
    await assertCanonicalSchema(pool);
    await expect(assertServiceRealm(pool, "test")).rejects.toThrow("SERVICE_REALM_UNINITIALIZED");
    expect(await initializeServiceRealm(pool, "real")).toBe("real");
    await assertServiceRealm(pool, "real");
    await expect(assertServiceRealm(pool, "test")).rejects.toThrow("SERVICE_REALM_MISMATCH:real");
    await expect(initializeServiceRealm(pool, "test")).rejects.toThrow("SERVICE_REALM_MISMATCH:real");
    await expect(pool.query("UPDATE service_realm SET realm='test'")).rejects.toThrow("SERVICE_REALM_IMMUTABLE");
    await expect(pool.query("DELETE FROM service_realm")).rejects.toThrow("SERVICE_REALM_IMMUTABLE");
  } finally { await pool.end(); }
}, 60_000);

integration("upgrade from an earlier revision preserves rows, and test activity can never become real money", async () => {
  const pool = await database("upgrade_path");
  try {
    const all = await canonicalMigrations();
    // An earlier deployed revision: the sequence before the realm marker.
    await applyCanonicalMigrations(pool, all.slice(0, all.findIndex(migration => migration.name === "service/001_service_realm.sql")));
    await pool.query("INSERT INTO funding_accounts(account_id,unit) VALUES('acct-test','sat')");
    await pool.query("INSERT INTO account_balance_projection(account_id,unit,settled_available,held) VALUES('acct-test','sat',63,0)");
    await pool.query("INSERT INTO ledger_transactions(transaction_id,reference,unit) VALUES('tx-1','test-top-up','sat')");
    await pool.query("INSERT INTO ledger_entries(entry_id,transaction_id,account_id,direction,amount,unit,entry_reference) VALUES('e-1','tx-1','acct-test','credit',63,'sat','test-top-up:credit')");
    await expect(assertCanonicalSchema(pool)).rejects.toThrow("SERVICE_MIGRATION_PENDING:service/001_service_realm.sql");
    expect((await applyCanonicalMigrations(pool)).applied).toEqual(["service/001_service_realm.sql", "development/017_validation_failures.sql"]);
    expect((await pool.query("SELECT settled_available::text AS value FROM account_balance_projection WHERE account_id='acct-test'")).rows[0].value).toBe("63");
    // Existing ledger activity is test history: it can never be adopted as real money.
    await expect(initializeServiceRealm(pool, "real")).rejects.toThrow("SERVICE_REAL_REALM_REQUIRES_EMPTY_LEDGER");
    expect(await initializeServiceRealm(pool, "test")).toBe("test");
    await expect(initializeServiceRealm(pool, "real")).rejects.toThrow("SERVICE_REALM_MISMATCH:test");
  } finally { await pool.end(); }
}, 60_000);

integration("a revision never serves a database migrated by a newer revision or with altered history", async () => {
  const pool = await database("drift_guard");
  try {
    await applyCanonicalMigrations(pool);
    await pool.query("INSERT INTO development_migrations(name,sha256) VALUES('service/999_future.sql','x')");
    await expect(applyCanonicalMigrations(pool)).rejects.toThrow("SERVICE_MIGRATION_UNKNOWN:service/999_future.sql");
    await expect(assertCanonicalSchema(pool)).rejects.toThrow("SERVICE_MIGRATION_UNKNOWN");
    await pool.query("DELETE FROM development_migrations WHERE name='service/999_future.sql'");
    await pool.query("UPDATE development_migrations SET sha256='changed' WHERE name='phase-03/001_funding.sql'");
    await expect(assertCanonicalSchema(pool)).rejects.toThrow("SERVICE_MIGRATION_CHANGED:phase-03/001_funding.sql");
  } finally { await pool.end(); }
}, 60_000);
