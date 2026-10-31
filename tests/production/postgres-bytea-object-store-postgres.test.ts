import { expect, test } from "bun:test";
import { Pool } from "pg";
import { PostgresByteaObjectStoreAdapter } from "../../src/continuity/postgres-bytea-object-store";
import type { PostgresSqlPool } from "../../src/persistence/postgres-sql-funding-store";

const connectionString = process.env.NAPPLET_TEST_POSTGRES_URL;
const integration = connectionString ? test : test.skip;

function sqlPool(native: Pool): PostgresSqlPool {
  return Object.freeze({
    async connect() {
      const client = await native.connect();
      return Object.freeze({
        async query<Row extends Record<string, unknown>>(text: string, values?: readonly unknown[]) {
          return Object.freeze({ rows: (await client.query<Row>(text, values ? [...values] : undefined)).rows });
        },
        release(error?: Error) { client.release(error); },
      });
    },
  });
}

integration("immutable SQL objects use a restricted role, exact generations, and permanent tombstones", async () => {
  const admin = new Pool({ connectionString });
  const suffix = crypto.randomUUID().replaceAll("-", "").slice(0, 16);
  const role = `object_runtime_${suffix}`;
  let runtime: Pool | undefined;
  try {
    await admin.query("CREATE SCHEMA IF NOT EXISTS production_real");
    await admin.query("CREATE ROLE napplet_production_real NOLOGIN").catch(() => undefined);
    await admin.query("CREATE TABLE IF NOT EXISTS production_real.ledger_probe(id text PRIMARY KEY)");
    await admin.query("REVOKE ALL ON production_real.ledger_probe FROM PUBLIC,napplet_production_real");
    await admin.query(await Bun.file("migrations/phase-07/019_postgres_bytea_objects.sql").text());
    await admin.query(`CREATE ROLE ${role} LOGIN`);
    await admin.query(`GRANT napplet_production_object TO ${role}`);
    runtime = new Pool({ connectionString: connectionString!.replace(/\/\/[^@]+@/u, `//${role}@`) });
    const store = new PostgresByteaObjectStoreAdapter({ pool: sqlPool(runtime), now: () => Date.parse("2030-01-01T00:00:00.000Z") });
    const firstBytes = new TextEncoder().encode("ciphertext-one");
    const first = await store.createImmutable({ key: "checkpoint/object", bytes: firstBytes });
    expect(first.generation).toBe(1);
    expect(await store.readExact(first)).toEqual(firstBytes);
    await expect(store.createImmutable({ key: "checkpoint/object", bytes: new TextEncoder().encode("different") })).rejects.toThrow("OBJECT_IMMUTABLE_CONFLICT");
    const same = await Promise.all(Array.from({ length: 4 }, () => store.createImmutable({ key: "checkpoint/object", bytes: firstBytes })));
    expect(new Set(same.map(value => `${value.generation}:${value.checksum}`)).size).toBe(1);
    await store.scheduleExactDeletion(first, "2029-12-31T23:59:59.000Z");
    expect(await store.readExact(first)).toBeUndefined();
    const replacement = await store.createImmutable({ key: "checkpoint/object", bytes: new TextEncoder().encode("ciphertext-two") });
    expect(replacement.generation).toBe(2);
    expect(await store.readExact(first)).toBeUndefined();
    await expect(store.scheduleExactDeletion(first, "2029-12-31T23:59:59.000Z")).rejects.toThrow("OBJECT_EXACT_GENERATION_REQUIRED");
    const client = await runtime.connect();
    try {
      await client.query("SET ROLE napplet_production_object");
      await expect(client.query("SELECT * FROM production_real.ledger_probe")).rejects.toThrow();
      await expect(client.query("UPDATE production_real.immutable_object_generations SET checksum='0' WHERE object_key='checkpoint/object'")).rejects.toThrow();
    } finally { client.release(); }
  } finally {
    await runtime?.end();
    await admin.query(`REVOKE napplet_production_object FROM ${role}`).catch(() => undefined);
    await admin.query(`DROP ROLE IF EXISTS ${role}`).catch(() => undefined);
    await admin.end();
  }
}, 30_000);

test("hosted PostgreSQL is mandatory in CI for immutable-object proof", () => {
  if (process.env.CI && !connectionString) throw new Error("NAPPLET_TEST_POSTGRES_URL_REQUIRED");
});
