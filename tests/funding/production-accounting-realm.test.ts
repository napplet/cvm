import { expect, test } from "bun:test";
import { createRequire } from "node:module";
import { createAccountingRealm, assertProductionAccountingConfiguration } from "../../src/funding/accounting-realm";
import { createFundedCore } from "../../src/phase-03/funded-core";

test("production realm rejects development-only funding adapters before construction", () => {
  expect(createAccountingRealm("production-real").schema).toBe("production_real");
  expect(() => assertProductionAccountingConfiguration({ adapters: ["FakeWallet"] })).toThrow("PRODUCTION_ACCOUNTING_DEVELOPMENT_MARKER");
  expect(() => assertProductionAccountingConfiguration({ priceCard: "synthetic-fixture" })).toThrow("PRODUCTION_ACCOUNTING_DEVELOPMENT_MARKER");
  expect(() => assertProductionAccountingConfiguration({ adapters: ["nwc", "cashu"] })).not.toThrow();
  expect(() => createFundedCore({ postgresPool: { connect: async () => { throw new Error("unused"); } }, productionAccountingConfiguration: { wallet: "FakeWallet" } })).toThrow("PRODUCTION_ACCOUNTING_DEVELOPMENT_MARKER");
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
    await pool.query(await Bun.file("migrations/phase-03/002_production_accounting.sql").text());

    expect((await pool.query("SELECT settled_available::text FROM public.account_balance_projection WHERE account_id='same-principal'")).rows[0]).toEqual({ settled_available: "41" });
    expect((await pool.query("SELECT count(*)::int AS count FROM production_real.funding_accounts")).rows[0]).toEqual({ count: 0 });
    await pool.query("INSERT INTO production_real.funding_accounts(account_id,unit) VALUES('same-principal','sat')");
    await pool.query("INSERT INTO production_real.account_balance_projection(account_id,unit) VALUES('same-principal','sat')");
    await pool.query("INSERT INTO public.funding_commands(account_id,command_kind,idempotency_key,fingerprint_sha256,result_json) VALUES('same-principal','credit','same-key',$1,'{}')", ["a".repeat(64)]);
    await pool.query("INSERT INTO production_real.funding_commands(account_id,command_kind,idempotency_key,fingerprint_sha256,result_json) VALUES('same-principal','credit','same-key',$1,'{}')", ["b".repeat(64)]);

    await pool.query("SET ROLE napplet_production_real");
    expect((await pool.query("SELECT count(*)::int AS count FROM production_real.funding_accounts")).rows[0]).toEqual({ count: 1 });
    await expect(pool.query("SELECT * FROM public.funding_accounts")).rejects.toThrow();
    await pool.query("RESET ROLE");
    await pool.query("SET ROLE napplet_development_history");
    expect((await pool.query("SELECT count(*)::int AS count FROM public.funding_accounts")).rows[0]).toEqual({ count: 1 });
    await expect(pool.query("SELECT * FROM production_real.funding_accounts")).rejects.toThrow();
    await pool.query("RESET ROLE");
  } finally {
    await pool?.end();
    await run(["rm", "--force", name]).catch(() => undefined);
  }
}, 120_000);
