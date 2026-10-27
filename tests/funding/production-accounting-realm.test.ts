import { expect, test } from "bun:test";
import { createRequire } from "node:module";
import { createAccountingRealm, assertProductionAccountingConfiguration } from "../../src/funding/accounting-realm";
import { createFundedCore } from "../../src/phase-03/funded-core";
import { PostgresFundingDatabase } from "../../src/persistence/postgres-funding-database";

test("production realm rejects development-only funding adapters before construction", () => {
  const descriptor = { mode: "production-real", adapters: ["lightning", "cashu", "nwc"], catalog: { kind: "live" }, keyMode: "secret-broker" };
  expect(createAccountingRealm("production-real").schema).toBe("production_real");
  expect(() => assertProductionAccountingConfiguration({ ...descriptor, adapters: ["FakeWallet"] })).toThrow("PRODUCTION_ACCOUNTING_DESCRIPTOR_REQUIRED");
  expect(() => assertProductionAccountingConfiguration({ ...descriptor, priceCard: "synthetic-fixture" })).toThrow("PRODUCTION_ACCOUNTING_DEVELOPMENT_MARKER");
  expect(() => assertProductionAccountingConfiguration(descriptor)).not.toThrow();
  expect(() => assertProductionAccountingConfiguration({ ...descriptor, testOnly: true })).toThrow("PRODUCTION_ACCOUNTING_DEVELOPMENT_MARKER");
  expect(() => createFundedCore({ postgresPool: { connect: async () => { throw new Error("unused"); } }, lightningReceiver: {} as never, cashuProvider: {} as never, cashuPolicies: {} as never, protectedMaterialKey: new Uint8Array(32), productionAccountingConfiguration: { ...descriptor, faucetEnabled: true } })).toThrow("PRODUCTION_ACCOUNTING_DEVELOPMENT_MARKER");
});

test("production database exposes narrow encrypted-custody and original-operation repositories", () => {
  const database = new PostgresFundingDatabase({ connect: async () => { throw new Error("unused"); } }, { realm: "production-real" });
  expect(typeof (database as unknown as { custody?: { put?: unknown } }).custody?.put).toBe("function");
  expect(typeof (database as unknown as { uncertainRailOperations?: { createOrReplay?: unknown } }).uncertainRailOperations?.createOrReplay).toBe("function");
});

const postgresIsolation = process.env.NAPPLET_RUN_POSTGRES_ISOLATION === "1" ? test : test.skip;

postgresIsolation("real PostgreSQL keeps development history read-only and production money isolated", async () => {
  const name = `napplet-cvm-accounting-${crypto.randomUUID().replaceAll("-", "")}`;
  const run = async (args: string[]) => {
    const child = Bun.spawn(["docker", ...args], { stdout: "pipe", stderr: "pipe", stdin: "ignore" });
    const [stdout, stderr, code] = await Promise.all([new Response(child.stdout).text(), new Response(child.stderr).text(), child.exited]);
    if (code !== 0) throw new Error(`DOCKER_FAILED:${args[0]}:${stderr.slice(0, 300)}`);
    return stdout.trim();
  };
  let pool: { query(text: string, values?: readonly unknown[]): Promise<{ rows: Record<string, unknown>[] }>; end(): Promise<void> } | undefined;
  let appPool: { connect(): Promise<any>; end(): Promise<void> } | undefined;
  try {
    await run(["run", "--detach", "--rm", "--name", name, "--network", "bridge", "--publish", "127.0.0.1::5432", "-e", "POSTGRES_HOST_AUTH_METHOD=trust", "postgres:17-alpine"]);
    const port = (await run(["port", name, "5432/tcp"])).match(/127\.0\.0\.1:(\d+)/u)?.[1];
    if (!port) throw new Error("POSTGRES_PORT_UNAVAILABLE");
    const { Pool } = createRequire(import.meta.url)("pg") as { Pool: new (options: Record<string, unknown>) => typeof pool };
    pool = new Pool({ connectionString: `postgresql://postgres@127.0.0.1:${port}/postgres`, connectionTimeoutMillis: 2_000 });
    for (let attempt = 0; attempt < 90; attempt += 1) {
      try { await pool.query("SELECT 1"); break; } catch (error) { if (attempt === 89) throw error; await Bun.sleep(250); }
    }
    await pool.query(await Bun.file("migrations/phase-03/001_funding.sql").text());
    await pool.query("INSERT INTO funding_accounts(account_id,unit) VALUES('same-principal','sat')");
    await pool.query("INSERT INTO account_balance_projection(account_id,unit,settled_available,held) VALUES('same-principal','sat',41,0)");
    for (const file of ["phase-04/001_metered_generation.sql", "phase-04/002_action_budget_lifecycle.sql", "phase-05/001_continuation.sql", "phase-06/001_publication.sql"]) await pool.query(await Bun.file(`migrations/${file}`).text());
    await pool.query(await Bun.file("migrations/phase-03/002_production_accounting.sql").text());
    await pool.query("CREATE ROLE napplet_production_test LOGIN");
    await pool.query("GRANT napplet_production_real TO napplet_production_test");

    expect((await pool.query("SELECT settled_available::text FROM public.account_balance_projection WHERE account_id='same-principal'")).rows[0]).toEqual({ settled_available: "41" });
    expect((await pool.query("SELECT count(*)::int AS count FROM production_real.funding_accounts")).rows[0]).toEqual({ count: 0 });
    await pool.query("INSERT INTO production_real.funding_accounts(account_id,unit) VALUES('same-principal','sat')");
    await pool.query("INSERT INTO production_real.account_balance_projection(account_id,unit) VALUES('same-principal','sat')");
    await pool.query("INSERT INTO public.funding_commands(account_id,command_kind,idempotency_key,fingerprint_sha256,result_json) VALUES('same-principal','credit','same-key',$1,'{}')", ["a".repeat(64)]);
    await pool.query("INSERT INTO production_real.funding_commands(account_id,command_kind,idempotency_key,fingerprint_sha256,result_json) VALUES('same-principal','credit','same-key',$1,'{}')", ["b".repeat(64)]);
    appPool = new Pool({ connectionString: `postgresql://napplet_production_test@127.0.0.1:${port}/postgres`, connectionTimeoutMillis: 2_000 }) as never;
    const database = new PostgresFundingDatabase(appPool as never, { realm: "production-real" });
    expect(await database.uncertainRailOperations.createOrReplay({ operationId: "op:one", accountId: "same-principal", rail: "lightning", providerLocator: "locator:one", stableLabel: "label:one", state: "created" })).toMatchObject({ created: true });
    expect(await database.uncertainRailOperations.createOrReplay({ operationId: "op:one", accountId: "same-principal", rail: "lightning", providerLocator: "locator:one", stableLabel: "label:one", state: "created" })).toMatchObject({ created: false });
    await expect(database.uncertainRailOperations.createOrReplay({ operationId: "op:one", accountId: "same-principal", rail: "lightning", providerLocator: "locator:other", stableLabel: "label:one", state: "created" })).rejects.toThrow("PRODUCTION_OPERATION_IDENTITY_CONFLICT");
    expect(await database.uncertainRailOperations.transition("op:one", "unknown")).toMatchObject({ state: "unknown" });
    await expect(pool.query("UPDATE production_real.uncertain_rail_operations SET state='created' WHERE operation_id='op:one'")).rejects.toThrow("PRODUCTION_OPERATION_STATE_TRANSITION_INVALID");
    await database.uncertainRailOperations.createOrReplay({ operationId: "op:two", accountId: "same-principal", rail: "cashu", providerLocator: "locator:two", stableLabel: "label:two", state: "created" });
    const custody = { custodyId: "custody:one", operationId: "op:two", accountId: "same-principal", rail: "cashu" as const, materialKind: "cashu_input" as const, keyReference: "secret://broker/key", payloadDigest: "c".repeat(64), canonicalProofIdentity: "d".repeat(64), mintUrl: "https://mint.example", keysetId: "keyset", unit: "sat" as const, nonce: new Uint8Array(12).fill(1), ciphertext: new Uint8Array([4, 5, 6]) };
    await database.custody.put(custody);
    await database.custody.put(custody);
    await expect(database.custody.put({ ...custody, custodyId: "custody:foreign", materialKind: "cashu_output", payloadDigest: "e".repeat(64) })).rejects.toThrow();
    expect(await database.custody.get("custody:one")).toMatchObject({ operationId: "op:two", keyReference: "secret://broker/key", payloadDigest: "c".repeat(64) });
    await expect(pool.query("UPDATE production_real.rail_custody_material SET key_reference='secret://replacement' WHERE custody_id='custody:one'")).rejects.toThrow("PRODUCTION_CUSTODY_IMMUTABLE");

    const productionClient = await appPool.connect();
    expect((await productionClient.query("SELECT count(*)::int AS count FROM production_real.funding_accounts")).rows[0]).toEqual({ count: 1 });
    await expect(productionClient.query("SELECT * FROM public.funding_accounts")).rejects.toThrow();
    await expect(productionClient.query("UPDATE production_real.ledger_entries SET amount=2")).rejects.toThrow();
    await expect(productionClient.query("UPDATE production_real.uncertain_rail_operation_audit SET next_state='unknown'")).rejects.toThrow();
    productionClient.release();
    await pool.query("SET ROLE napplet_development_history");
    expect((await pool.query("SELECT count(*)::int AS count FROM public.funding_accounts")).rows[0]).toEqual({ count: 1 });
    await expect(pool.query("SELECT * FROM production_real.funding_accounts")).rejects.toThrow();
    await pool.query("RESET ROLE");
  } finally {
    await appPool?.end();
    await pool?.end();
    await run(["rm", "--force", name]).catch(() => undefined);
  }
}, 120_000);
