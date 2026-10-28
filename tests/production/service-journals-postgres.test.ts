import { createRequire } from "node:module";
import { expect, test } from "bun:test";
import type { PostgresSqlPool } from "../../src/persistence/postgres-sql-funding-store";
import { PostgresOperationJournal } from "../../src/release/deployment/postgres-operation-journal";
import { openProductionServiceJournals } from "../../src/production/service-journals";

const postgres = process.env.NAPPLET_RUN_POSTGRES_ISOLATION === "1" ? test : test.skip;
async function docker(args: string[], input?: string) {
  const child = Bun.spawn(["docker", ...args], { stdin: input === undefined ? "ignore" : "pipe", stdout: "pipe", stderr: "pipe" });
  if (input !== undefined && child.stdin) { child.stdin.write(input); child.stdin.end(); }
  const [out, err, code] = await Promise.all([new Response(child.stdout).text(), new Response(child.stderr).text(), child.exited]);
  if (code !== 0) throw new Error(`DOCKER_FAILED:${args[0]}:${err.slice(0, 300)}`);
  return out.trim();
}

type NativePool = PostgresSqlPool & { query(sql: string, values?: readonly unknown[]): Promise<{ rows: Record<string, unknown>[] }>; end(): Promise<void> };
postgres("service journals retain original scope across topology changes, restore and rollback without widening certification", async () => {
  const name = `napplet-cvm-service-journals-${crypto.randomUUID().replaceAll("-", "")}`;
  let admin: NativePool | undefined, application: NativePool | undefined, recovered: NativePool | undefined;
  try {
    await docker(["run", "--detach", "--rm", "--name", name, "--publish", "127.0.0.1::5432", "-e", "POSTGRES_HOST_AUTH_METHOD=trust", "postgres:17-alpine"]);
    const port = (await docker(["port", name, "5432/tcp"])).match(/127\.0\.0\.1:(\d+)/u)?.[1];
    if (!port) throw new Error("POSTGRES_PORT_MISSING");
    const { Pool } = createRequire(import.meta.url)("pg") as { Pool: new(options: Record<string, unknown>) => NativePool };
    admin = new Pool({ connectionString: `postgresql://postgres@127.0.0.1:${port}/postgres`, connectionTimeoutMillis: 2000 });
    for (let attempt = 0; attempt < 90; attempt++) {
      try { await admin.query("SELECT 1"); break; } catch (error) { if (attempt === 89) throw error; await Bun.sleep(250); }
    }
    for (const file of ["phase-03/001_funding.sql", "phase-04/001_metered_generation.sql", "phase-04/002_action_budget_lifecycle.sql", "phase-03/002_production_accounting.sql", "phase-07/001_production_operation_journal.sql"]) await admin.query(await Bun.file(`migrations/${file}`).text());
    await admin.query("CREATE ROLE service_journal_test LOGIN");
    await admin.query("GRANT napplet_production_real TO service_journal_test");
    application = new Pool({ connectionString: `postgresql://service_journal_test@127.0.0.1:${port}/postgres`, connectionTimeoutMillis: 2000 });
    const pool = application;
    const servicePubkey = "1".repeat(64), originalScope = "a".repeat(64), upgradedScope = "b".repeat(64);
    const existing = new PostgresOperationJournal(pool, { namespace: "production-nwc", scopeSha256: originalScope });
    const original = await existing.claim("lost-invoice-create", "2".repeat(64), { state: "unknown", originalRequestEventId: "3".repeat(64) });
    await expect(openProductionServiceJournals({ pool, servicePubkey, initialTopologySha256: originalScope, requireExisting: true })).rejects.toThrow("PRODUCTION_SERVICE_JOURNAL_AUTHORITY_REQUIRED");
    // An upgrade cannot guess/adopt an unanchored historical topology.
    await expect(openProductionServiceJournals({ pool, servicePubkey, initialTopologySha256: upgradedScope })).rejects.toThrow("PRODUCTION_SERVICE_JOURNAL_LEGACY_SCOPE_REQUIRED");
    expect((await admin.query("SELECT count(*)::int AS count FROM production_real.release_operation_journal WHERE namespace='production-service-continuity'")).rows[0]!.count).toBe(0);
    const concurrent = await Promise.all(Array.from({ length: 12 }, () => openProductionServiceJournals({ pool, servicePubkey, initialTopologySha256: originalScope })));
    for (const item of concurrent) expect(item.scopeSha256).toBe(originalScope);
    const first = concurrent[0]!;
    expect(await first.nwc.read("lost-invoice-create")).toEqual(original.record);
    const journalNames = ["capacity", "worker", "job", "request", "vertex", "checkpoint", "contextvm", "nwc"] as const;
    for (const key of journalNames) await first[key].claim(`original-${key}`, "4".repeat(64), { kind: key, state: "unknown", originalId: `provider-${key}` });
    const before = await admin.query("SELECT namespace,scope_sha256,operation_id,identity_sha256,revision,value_json FROM production_real.release_operation_journal ORDER BY namespace,scope_sha256,operation_id");
    const upgraded = await openProductionServiceJournals({ pool, servicePubkey, initialTopologySha256: upgradedScope });
    expect(upgraded.scopeSha256).toBe(originalScope);
    for (const key of journalNames) {
      const retained = await upgraded[key].claim<unknown>(`original-${key}`, "4".repeat(64), { state: "replacement-would-be-unsafe" });
      expect(retained.claimed).toBe(false);
      expect(retained.record.value).toEqual({ kind: key, state: "unknown", originalId: `provider-${key}` });
      expect(await new PostgresOperationJournal(pool, { namespace: `production-${key === "capacity" ? "runtime" : key === "job" ? "worker-job" : key === "request" ? "worker-request" : key}`, scopeSha256: upgradedScope }).read(`original-${key}`)).toBeUndefined();
    }
    expect((await upgraded.nwc.claim("lost-invoice-create", "2".repeat(64), { state: "replacement" })).claimed).toBe(false);
    // Reopening and querying neither copies nor modifies existing history.
    expect((await admin.query("SELECT namespace,scope_sha256,operation_id,identity_sha256,revision,value_json FROM production_real.release_operation_journal ORDER BY namespace,scope_sha256,operation_id")).rows).toEqual(before.rows);
    await new PostgresOperationJournal(pool, { namespace: "production-runtime", scopeSha256: upgradedScope }).claim("cohort-operation:new-cert", "5".repeat(64), { authorization: "new-receipt" });
    expect((await openProductionServiceJournals({ pool, servicePubkey, initialTopologySha256: upgradedScope })).scopeSha256).toBe(originalScope);
    const certOriginal = new PostgresOperationJournal(pool, { namespace: "production-google-control", scopeSha256: originalScope });
    await certOriginal.claim("cert-original", "5".repeat(64), { authorization: "old-receipt" });
    expect(await new PostgresOperationJournal(pool, { namespace: "production-google-control", scopeSha256: upgradedScope }).read("cert-original")).toBeUndefined();
    await expect(openProductionServiceJournals({ pool, servicePubkey: "6".repeat(64), initialTopologySha256: originalScope })).rejects.toThrow("PRODUCTION_SERVICE_JOURNAL_IDENTITY_CHANGED");
    expect((await openProductionServiceJournals({ pool, servicePubkey, initialTopologySha256: originalScope })).scopeSha256).toBe(originalScope);
    // A new database from an actual SQL dump retains the service authority and
    // original operation identities. This is local database restore proof only.
    const dump = await docker(["exec", name, "pg_dump", "-U", "postgres", "--schema=production_real", "--no-owner", "--no-privileges", "postgres"]);
    await admin.query("CREATE DATABASE recovered_service");
    recovered = new Pool({ connectionString: `postgresql://postgres@127.0.0.1:${port}/recovered_service` });
    await docker(["exec", "-i", name, "psql", "-U", "postgres", "--set", "ON_ERROR_STOP=1", "--dbname", "recovered_service"], `${dump}\n`);
    await recovered.query("GRANT USAGE ON SCHEMA production_real TO napplet_production_real");
    await recovered.query("GRANT SELECT,INSERT ON production_real.release_operation_journal TO napplet_production_real");
    const restoredPool = new Pool({ connectionString: `postgresql://service_journal_test@127.0.0.1:${port}/recovered_service` });
    try {
      const restored = await openProductionServiceJournals({ pool: restoredPool, servicePubkey, initialTopologySha256: upgradedScope, requireExisting: true });
      expect(restored.scopeSha256).toBe(originalScope);
      expect(await restored.nwc.read("lost-invoice-create")).toEqual(original.record);
    } finally { await restoredPool.end(); }
    await new PostgresOperationJournal(pool, { namespace: "production-worker", scopeSha256: upgradedScope }).claim("orphaned-original", "7".repeat(64), { state: "unknown" });
    await expect(openProductionServiceJournals({ pool, servicePubkey, initialTopologySha256: upgradedScope })).rejects.toThrow("PRODUCTION_SERVICE_JOURNAL_SCOPE_CONFLICT");
    // Even a privileged rewrite with a valid journal revision is rejected;
    // an ordinary role cannot rewrite identity columns or delete the anchor.
    await admin.query("UPDATE production_real.release_operation_journal SET value_json=jsonb_set(value_json,'{scopeSha256}',to_jsonb($1::text)),revision=revision+1 WHERE namespace='production-service-continuity'", [upgradedScope]);
    await expect(openProductionServiceJournals({ pool, servicePubkey, initialTopologySha256: upgradedScope })).rejects.toThrow("PRODUCTION_SERVICE_JOURNAL_AUTHORITY_CHANGED");
  } finally {
    await application?.end(); await recovered?.end(); await admin?.end();
    await docker(["rm", "--force", name]).catch(() => undefined);
  }
}, 120_000);
