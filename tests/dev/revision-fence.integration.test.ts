import { expect, test } from "bun:test";
import { createRequire } from "node:module";
import { createDevelopmentPool } from "../../scripts/dev-payments";
import { readDevelopmentPaymentConfig } from "./payment-config";
import { PostgresSqlFundingStore } from "../../src/persistence/postgres-sql-funding-store";

test("SQL fences concurrent revision versions and rolls back losing budgets", async () => {
  const config = await readDevelopmentPaymentConfig();
  const admin = createDevelopmentPool(config.databaseUrl);
  const schema = `revision_fence_${crypto.randomUUID().replaceAll("-", "")}`;
  await admin.query(`CREATE SCHEMA ${schema}`);
  const { Pool } = createRequire(import.meta.url)("pg") as { Pool: new (options: Record<string, unknown>) => ReturnType<typeof createDevelopmentPool> };
  const options = { connectionString: config.databaseUrl, options: `-csearch_path=${schema}`, max: 4 };
  const pool = new Pool(options), otherPool = new Pool(options);
  try {
    for (const file of ["phase-03/001_funding.sql", "phase-04/001_metered_generation.sql", "phase-04/002_action_budget_lifecycle.sql"]) await pool.query(await Bun.file(`${import.meta.dir}/../../migrations/${file}`).text());
    await pool.query("INSERT INTO funding_accounts(account_id,unit) VALUES ('owner','sat'),('foreign','sat'),('treasury:clearing','sat')");
    for (const account of ["owner", "foreign"]) {
      await pool.query("INSERT INTO account_balance_projection(account_id,unit,settled_available,held) VALUES ($1,'sat',1000,1000)", [account]);
      await pool.query("INSERT INTO admissions(admission_id,account_id,reference,capacity_reference,state) VALUES ($1,$2,$1,$1,'accepted')", [`admission:${account}`, account]);
      await pool.query("INSERT INTO session_cap_holds(hold_id,account_id,reference,requested_cap,held_amount,state) VALUES ($1,$2,$1,1000,1000,'active')", [`admission:${account}`, account]);
    }
    await pool.query("INSERT INTO metered_sessions(id,account_id,admission_reference,profile_id,price_card_id,version,state) VALUES ('session','owner','admission:owner','code-proposal','phase-04-deterministic-card-2026-08-04',1,'verified')");
    const stores = [pool, otherPool].map((connection) => new PostgresSqlFundingStore(connection, { deadlineMs: 5_000, maxAttempts: 5 }));
    const prepare = (store: PostgresSqlFundingStore, key: string, expectedVersion = 1, accountId = "owner") => store.transact(accountId, async (tx) => {
      const budget = await tx.reserveActionBudget({ accountId, admissionReference: `admission:${accountId}`, idempotencyKey: `budget:${key}`, fingerprint: key.padEnd(64, "a"), reference: `budget:${key}`, amount: 100n });
      return tx.prepareMeteredAction({ accountId, idempotencyKey: key, fingerprint: key.padEnd(64, "b"), sessionId: "session", actionId: `action:${key}`, expectedVersion, admissionReference: `admission:${accountId}`, actionBudgetReference: budget.reference, maximum: 100n, operationId: `operation:${key}`, profileId: "code-proposal", priceCardId: "phase-04-deterministic-card-2026-08-04" });
    });
    const results = await Promise.allSettled([prepare(stores[0]!, "a"), prepare(stores[1]!, "b")]);
    expect(results.filter((result) => result.status === "fulfilled")).toHaveLength(1);
    const rejection = results.find((result) => result.status === "rejected") as PromiseRejectedResult;
    expect(rejection.reason.message).toBe("SESSION_ACTION_ALREADY_ACTIVE");
    const winner = (results.find((result) => result.status === "fulfilled") as PromiseFulfilledResult<Awaited<ReturnType<typeof prepare>>>).value;
    for (const table of ["metered_actions", "provider_operations", "action_budget_reservations", "billing_line_items"]) expect((await pool.query(`SELECT count(*)::int AS count FROM ${table}`)).rows[0]?.count).toBe(1);
    expect((await prepare(stores[1]!, winner.idempotencyKey)).actionId).toBe(winner.actionId);
    await stores[0]!.transact("owner", (tx) => tx.claimProviderOperation(winner.operationId));
    await stores[0]!.transact("owner", (tx) => tx.finalizeMeteredAction({ idempotencyKey: winner.idempotencyKey, operationId: winner.operationId, receiptCharge: "5", providerReceiptReference: "receipt:revision-fence", status: "failed", sessionVersion: 2, artifactVersion: 0, result: { status: "failed", code: "WORKER_OR_ARTIFACT_FAILED", accountId: "owner", sessionId: "session", sessionVersion: 2, artifactVersion: 0, confirmedSpend: "5", remainingCap: "995", remainingBalance: "995", nextAction: "revise_session", operationId: winner.operationId } }));
    await expect(prepare(stores[1]!, "stale", 1)).rejects.toThrow("STALE_SESSION_VERSION");
    await expect(prepare(stores[1]!, "foreign", 2, "foreign")).rejects.toThrow("SESSION_LINEAGE_MISMATCH");
    expect((await pool.query("SELECT count(*)::int AS count FROM action_budget_reservations")).rows[0]?.count).toBe(1);
    expect((await pool.query("SELECT settled_available::text,held::text FROM account_balance_projection WHERE account_id='owner'")).rows[0]).toEqual({ settled_available: "995", held: "995" });
    expect((await prepare(stores[1]!, winner.idempotencyKey)).result).toBeDefined();
    expect((await prepare(stores[1]!, "next", 2)).expectedVersion).toBe(2);
    expect((await pool.query("SELECT count(*)::int AS count FROM provider_operations")).rows[0]?.count).toBe(2);
  } finally {
    await Promise.all([pool.end(), otherPool.end()]);
    await admin.query(`DROP SCHEMA ${schema} CASCADE`);
    await admin.end();
  }
}, 30_000);
