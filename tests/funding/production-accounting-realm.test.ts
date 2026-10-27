import { expect, test } from "bun:test";
import { createRequire } from "node:module";
import { createAccountingRealm, assertProductionAccountingConfiguration } from "../../src/funding/accounting-realm";
import { accountIdForPrincipal } from "../../src/domain/account-command";
import { createFundedCore } from "../../src/phase-03/funded-core";
import { PostgresFundingDatabase } from "../../src/persistence/postgres-funding-database";
import { FundingService } from "../../src/funding/funding-service";

test("production realm rejects development-only funding adapters before construction", () => {
  const descriptor = { mode: "production-real", adapters: ["lightning", "cashu", "nwc"], catalog: { kind: "live" }, keyMode: "secret-broker" };
  expect(createAccountingRealm("production-real").schema).toBe("production_real");
  expect(() => assertProductionAccountingConfiguration({ ...descriptor, adapters: ["FakeWallet"] })).toThrow("PRODUCTION_ACCOUNTING_DESCRIPTOR_REQUIRED");
  expect(() => assertProductionAccountingConfiguration({ ...descriptor, priceCard: "synthetic-fixture" })).toThrow("PRODUCTION_ACCOUNTING_DEVELOPMENT_MARKER");
  expect(() => assertProductionAccountingConfiguration(descriptor)).not.toThrow();
  expect(() => assertProductionAccountingConfiguration({ ...descriptor, testOnly: true })).toThrow("PRODUCTION_ACCOUNTING_DEVELOPMENT_MARKER");
  expect(() => assertProductionAccountingConfiguration({ ...descriptor, fakeWalletEnabled: true })).toThrow("PRODUCTION_ACCOUNTING_DEVELOPMENT_MARKER");
  expect(() => createFundedCore({ postgresExecutor: {} as never })).toThrow("PRODUCTION_POSTGRES_DATABASE_ADAPTER_REQUIRED");
  const productionDatabase = new PostgresFundingDatabase({ connect: async () => { throw new Error("unused"); } }, { realm: "production-real" });
  expect(() => createFundedCore({ testOnly: true, accountingRealm: "production-real" })).toThrow("TEST_ACCOUNTING_REALM_DENIED");
  expect(() => createFundedCore({ testOnly: true, database: productionDatabase })).toThrow("TEST_ACCOUNTING_REALM_DENIED");
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
  let productionClient: { query(text: string, values?: readonly unknown[]): Promise<{ rows: Record<string, unknown>[] }>; release(): void } | undefined;
  try {
    await run(["run", "--detach", "--rm", "--name", name, "--network", "bridge", "--publish", "127.0.0.1::5432", "-e", "POSTGRES_HOST_AUTH_METHOD=trust", "postgres:17-alpine"]);
    const port = (await run(["port", name, "5432/tcp"])).match(/127\.0\.0\.1:(\d+)/u)?.[1];
    if (!port) throw new Error("POSTGRES_PORT_UNAVAILABLE");
    const { Pool } = createRequire(import.meta.url)("pg") as { Pool: new (options: Record<string, unknown>) => typeof pool };
    pool = new Pool({ connectionString: `postgresql://postgres@127.0.0.1:${port}/postgres`, connectionTimeoutMillis: 2_000 });
    for (let attempt = 0; attempt < 90; attempt += 1) {
      try { await pool.query("SELECT 1"); break; } catch (error) { if (attempt === 89) throw error; await Bun.sleep(250); }
    }
    const principal = { pubkey: "a".repeat(64) };
    const productionAccountId = await accountIdForPrincipal(principal);
    await pool.query(await Bun.file("migrations/phase-03/001_funding.sql").text());
    for (const file of ["phase-04/001_metered_generation.sql", "phase-04/002_action_budget_lifecycle.sql", "phase-05/001_continuation.sql", "phase-06/001_publication.sql"]) await pool.query(await Bun.file(`migrations/${file}`).text());
    await pool.query("INSERT INTO funding_accounts(account_id,unit) VALUES($1,'sat')", [productionAccountId]);
    await pool.query("INSERT INTO account_balance_projection(account_id,unit,settled_available,held) VALUES($1,'sat',41000,0)", [productionAccountId]);
    // Ordinary development migrations do not install the production roles.
    // The active private dev login stays writable and remains pinned to public.
    const developmentDatabase = new PostgresFundingDatabase(pool as never, { deadlineMs: 1_000 });
    const developmentFunding = new FundingService(developmentDatabase.funding);
    expect(await developmentFunding.execute({ principal, kind: "credit_settlement", idempotencyKey: "development-credit", policyVersion: "development-local", protocolVersion: "development-local", payload: { settlement: { topUpId: "development-topup", rail: "lightning", unit: "sat", amount: "9", externalReference: "development-external", settlementReference: "development-settlement", verifiedAt: "2026-10-27T00:00:00.000Z" } } })).toMatchObject({ status: "credited", creditedAmount: "9" });
    expect((await developmentFunding.status(principal)).available).toBe("41009");
    await pool.query(await Bun.file("migrations/phase-03/002_production_accounting.sql").text());
    const superuserProductionDatabase = new PostgresFundingDatabase(pool as never, { realm: "production-real", deadlineMs: 1_000 });
    await expect(new FundingService(superuserProductionDatabase.funding).status(principal)).rejects.toThrow("ACCOUNTING_REALM_SUPERUSER_DENIED");
    expect((await pool.query(`SELECT source_table.relname AS source_table, target_schema.nspname AS target_schema
      FROM pg_constraint constraint_row
      JOIN pg_class source_table ON source_table.oid=constraint_row.conrelid
      JOIN pg_namespace source_schema ON source_schema.oid=source_table.relnamespace
      JOIN pg_class target_table ON target_table.oid=constraint_row.confrelid
      JOIN pg_namespace target_schema ON target_schema.oid=target_table.relnamespace
      WHERE source_schema.nspname='production_real' AND constraint_row.contype='f' AND target_schema.nspname='public'`)).rows).toEqual([]);
    expect((await pool.query(`SELECT table_row.relname AS table_name
      FROM pg_attrdef default_row
      JOIN pg_class table_row ON table_row.oid=default_row.adrelid
      JOIN pg_namespace table_schema ON table_schema.oid=table_row.relnamespace
      WHERE table_schema.nspname='production_real' AND pg_get_expr(default_row.adbin, default_row.adrelid) LIKE '%public.%'`)).rows).toEqual([]);
    expect((await pool.query(`SELECT table_row.relname AS table_name, function_schema.nspname AS function_schema
      FROM pg_trigger trigger_row
      JOIN pg_class table_row ON table_row.oid=trigger_row.tgrelid
      JOIN pg_namespace table_schema ON table_schema.oid=table_row.relnamespace
      JOIN pg_proc function_row ON function_row.oid=trigger_row.tgfoid
      JOIN pg_namespace function_schema ON function_schema.oid=function_row.pronamespace
      WHERE table_schema.nspname='production_real' AND NOT trigger_row.tgisinternal AND function_schema.nspname='public'`)).rows).toEqual([]);
    await pool.query("CREATE ROLE napplet_production_test LOGIN");
    await pool.query("GRANT napplet_production_real TO napplet_production_test");
    expect((await pool.query("SELECT has_table_privilege('napplet_production_real', 'production_real.rail_custody_material', 'INSERT') AS insert_allowed")).rows[0]).toEqual({ insert_allowed: true });

    expect((await pool.query("SELECT settled_available::text FROM public.account_balance_projection WHERE account_id=$1", [productionAccountId])).rows[0]).toEqual({ settled_available: "41009" });
    expect((await pool.query("SELECT count(*)::int AS count FROM production_real.funding_accounts")).rows[0]).toEqual({ count: 0 });
    appPool = new Pool({ connectionString: `postgresql://napplet_production_test@127.0.0.1:${port}/postgres`, connectionTimeoutMillis: 2_000 }) as never;
    const database = new PostgresFundingDatabase(appPool as never, { realm: "production-real", deadlineMs: 1_000 });
    const funding = new FundingService(database.funding);
    expect((await funding.status(principal)).available).toBe("0");
    await expect(funding.execute({ principal, kind: "funded_admission", idempotencyKey: "test-balance-refusal", policyVersion: "live-policy", protocolVersion: "live-protocol", payload: { requestedCap: "1", unit: "sat", capacity: { reference: "capacity:test-balance", usable: true } } })).rejects.toThrow("INSUFFICIENT_SETTLED_BALANCE");
    const settlement = { principal, kind: "credit_settlement" as const, idempotencyKey: "real-credit", policyVersion: "live-policy", protocolVersion: "live-protocol", payload: { settlement: { topUpId: "real-topup", rail: "lightning" as const, unit: "sat" as const, amount: "50", externalReference: "real-external", settlementReference: "real-settlement", verifiedAt: "2026-10-27T00:00:00.000Z" } } };
    const credited = [await funding.execute(settlement), await funding.execute(settlement)];
    expect(credited[0]).toMatchObject({ status: "credited", creditedAmount: "50" });
    expect(await funding.execute({ principal, kind: "funded_admission", idempotencyKey: "real-admission", policyVersion: "live-policy", protocolVersion: "live-protocol", payload: { requestedCap: "20", unit: "sat", capacity: { reference: "capacity:real", usable: true } } })).toMatchObject({ status: "accepted", approvedCap: "20" });
    await pool.query("INSERT INTO production_real.model_profile_versions(id,profile_hash,provider,model,normalized_profile) VALUES('real-profile',$1,'real-provider','real-model','{}')", ["1".repeat(64)]);
    await pool.query("INSERT INTO production_real.price_card_versions(id,card_hash,profile_id,unit,normalized_card) VALUES('real-card',$1,'real-profile','sat','{}')", ["2".repeat(64)]);
    await database.funding.transact(productionAccountId, (transaction) => transaction.reserveActionBudget({ accountId: productionAccountId, admissionReference: "capacity:real", idempotencyKey: "real-budget", fingerprint: "3".repeat(64), reference: "budget:real", amount: 10n }));
    await database.funding.transact(productionAccountId, (transaction) => transaction.prepareMeteredAction({ accountId: productionAccountId, idempotencyKey: "real-action", fingerprint: "4".repeat(64), sessionId: "session:real", actionId: "action:real", expectedVersion: 0, admissionReference: "capacity:real", actionBudgetReference: "budget:real", maximum: 10n, operationId: "operation:real", profileId: "real-profile", priceCardId: "real-card" }));
    expect(await database.funding.transact(productionAccountId, (transaction) => transaction.claimProviderOperation("operation:real"))).toMatchObject({ claimed: true });
    await database.funding.transact(productionAccountId, (transaction) => transaction.recordUsageReceipt({ operationId: "operation:real", protectedEvidenceReference: "receipt:real" }));
    const finalization = { idempotencyKey: "real-action", operationId: "operation:real", receiptCharge: "4", providerReceiptReference: "receipt:real", status: "completed" as const, result: { status: "completed" }, sessionVersion: 1, artifactVersion: 1, artifact: { artifactId: "artifact:real", workspaceLineage: "workspace:real", checkpointReference: "checkpoint:real", snapshotReference: "snapshot:real", validationEvidenceReference: "validation:real" } };
    expect(await database.funding.transact(productionAccountId, (transaction) => transaction.finalizeMeteredAction(finalization))).toMatchObject({ status: "completed", receiptCharge: "4" });
    expect(await database.funding.transact(productionAccountId, (transaction) => transaction.finalizeMeteredAction(finalization))).toMatchObject({ status: "completed", receiptCharge: "4" });
    expect((await pool.query("SELECT count(*)::int AS count FROM production_real.usage_receipts WHERE operation_id='operation:real'")).rows[0]).toEqual({ count: 1 });
    expect((await pool.query("SELECT count(*)::int AS count FROM production_real.billing_line_items WHERE operation_id='operation:real'")).rows[0]).toEqual({ count: 3 });
    await expect(pool.query("UPDATE production_real.usage_receipts SET provider_receipt_id='replacement' WHERE operation_id='operation:real'")).rejects.toThrow("PHASE04_APPEND_ONLY");
    expect((await funding.status(principal)).available).toBe("30");
    const competingAdmissions = await Promise.all([
      funding.execute({ principal, kind: "funded_admission", idempotencyKey: "cap-one", policyVersion: "live-policy", protocolVersion: "live-protocol", payload: { requestedCap: "25", unit: "sat", capacity: { reference: "capacity:one", usable: true } } }),
      funding.execute({ principal, kind: "funded_admission", idempotencyKey: "cap-two", policyVersion: "live-policy", protocolVersion: "live-protocol", payload: { requestedCap: "25", unit: "sat", capacity: { reference: "capacity:two", usable: true } } }),
    ]);
    expect(competingAdmissions.map((result) => Number(result.approvedCap)).reduce((total, amount) => total + amount, 0)).toBe(30);
    expect((await funding.status(principal)).available).toBe("0");
    expect(await database.uncertainRailOperations.createOrReplay({ operationId: "op:one", accountId: productionAccountId, rail: "lightning", providerLocator: "locator:one", stableLabel: "label:one", state: "created" })).toMatchObject({ created: true });
    expect(await database.uncertainRailOperations.createOrReplay({ operationId: "op:one", accountId: productionAccountId, rail: "lightning", providerLocator: "locator:one", stableLabel: "label:one", state: "created" })).toMatchObject({ created: false });
    await expect(database.uncertainRailOperations.createOrReplay({ operationId: "op:one", accountId: productionAccountId, rail: "lightning", providerLocator: "locator:other", stableLabel: "label:one", state: "created" })).rejects.toThrow("PRODUCTION_OPERATION_IDENTITY_CONFLICT");
    expect(await database.uncertainRailOperations.transition("op:one", "unknown")).toMatchObject({ state: "unknown" });
    expect(await database.uncertainRailOperations.createOrReplay({ operationId: "op:one", accountId: productionAccountId, rail: "lightning", providerLocator: "locator:one", stableLabel: "label:one", state: "created" })).toMatchObject({ created: false, operation: { state: "unknown" } });
    const concurrentOperation = { operationId: "op:concurrent", accountId: productionAccountId, rail: "lightning" as const, providerLocator: "locator:concurrent", stableLabel: "label:concurrent", state: "created" as const };
    const concurrentReplays = await Promise.all([database.uncertainRailOperations.createOrReplay(concurrentOperation), database.uncertainRailOperations.createOrReplay(concurrentOperation)]);
    expect(concurrentReplays.filter((result) => result.created).length).toBe(1);
    await expect(pool.query("UPDATE production_real.uncertain_rail_operations SET state='created' WHERE operation_id='op:one'")).rejects.toThrow("PRODUCTION_OPERATION_STATE_TRANSITION_INVALID");
    await database.uncertainRailOperations.createOrReplay({ operationId: "op:two", accountId: productionAccountId, rail: "cashu", providerLocator: "locator:two", stableLabel: "label:two", state: "created" });
    const custody = { custodyId: "custody:one", operationId: "op:two", accountId: productionAccountId, rail: "cashu" as const, materialKind: "cashu_input" as const, keyReference: "secret://broker/key", payloadDigest: "c".repeat(64), canonicalProofIdentity: "d".repeat(64), mintUrl: "https://mint.example", keysetId: "keyset", unit: "sat" as const, nonce: new Uint8Array(12).fill(1), ciphertext: new Uint8Array([4, 5, 6]) };
    await database.custody.put(custody);
    await database.custody.put(custody);
    await expect(database.custody.put({ ...custody, custodyId: "custody:foreign", materialKind: "cashu_output", payloadDigest: "e".repeat(64) })).rejects.toThrow();
    await pool.query("INSERT INTO production_real.funding_accounts(account_id,unit) VALUES('other-principal','sat')");
    await database.uncertainRailOperations.createOrReplay({ operationId: "op:other", accountId: "other-principal", rail: "cashu", providerLocator: "locator:other-account", stableLabel: "label:other-account", state: "created" });
    await expect(database.custody.put({ ...custody, custodyId: "custody:cross-account", operationId: "op:other", accountId: "other-principal", materialKind: "cashu_output", payloadDigest: "e".repeat(64) })).rejects.toThrow();
    expect(await database.custody.get("custody:one")).toMatchObject({ operationId: "op:two", keyReference: "secret://broker/key", payloadDigest: "c".repeat(64) });
    await expect(pool.query("UPDATE production_real.rail_custody_material SET key_reference='secret://replacement' WHERE custody_id='custody:one'")).rejects.toThrow("PRODUCTION_CUSTODY_IMMUTABLE");

    productionClient = await appPool.connect();
    try {
      expect((await productionClient.query("SELECT count(*)::int AS count FROM production_real.funding_accounts")).rows[0]).toEqual({ count: 3 });
      await expect(productionClient.query("SELECT * FROM public.funding_accounts")).rejects.toThrow();
      await expect(productionClient.query("UPDATE production_real.ledger_entries SET amount=2 WHERE account_id=$1", [productionAccountId])).rejects.toThrow();
      await expect(productionClient.query("UPDATE production_real.uncertain_rail_operation_audit SET next_state='unknown'")).rejects.toThrow();
    } finally {
      productionClient.release();
      productionClient = undefined;
    }
    await pool.query("SET ROLE napplet_development_history");
    expect((await pool.query("SELECT count(*)::int AS count FROM public.funding_accounts")).rows[0]).toEqual({ count: 2 });
    await expect(pool.query("SELECT * FROM production_real.funding_accounts")).rejects.toThrow();
    await pool.query("RESET ROLE");
  } finally {
    productionClient?.release();
    await appPool?.end();
    await pool?.end();
    await run(["rm", "--force", name]).catch(() => undefined);
  }
}, 120_000);
