import { expect, test } from "bun:test";
import { createRequire } from "node:module";
import { createDevelopmentPool, type DevPayments } from "../../scripts/dev-payments";
import { PostgresSqlFundingStore } from "../../src/persistence/postgres-sql-funding-store";
import type { MeteredFinalizeInput } from "../../src/persistence/funding-store";

for (const charge of ["0", "10"]) {
  test(`actual SQL finalizes charge ${charge}, preserves action identity and replays once`, async () => {
    const config = await Bun.file(`${import.meta.dir}/../../.local/napplet-cvm-dev-payments/payments.json`).json() as DevPayments;
    const admin = createDevelopmentPool(config.databaseUrl);
    const schema = `metered_test_${crypto.randomUUID().replaceAll("-", "")}`;
    await admin.query(`CREATE SCHEMA ${schema}`);
    const { Pool } = createRequire(import.meta.url)("pg") as { Pool: new (options: Record<string, unknown>) => ReturnType<typeof createDevelopmentPool> };
    const pool = new Pool({ connectionString: config.databaseUrl, options: `-csearch_path=${schema}`, max: 4 });
    try {
      for (const file of ["phase-03/001_funding.sql", "phase-04/001_metered_generation.sql", "phase-04/002_action_budget_lifecycle.sql"]) await pool.query(await Bun.file(`${import.meta.dir}/../../migrations/${file}`).text());
      await pool.query("INSERT INTO funding_accounts(account_id,unit) VALUES ('owner','sat'),('treasury:clearing','sat')");
      await pool.query("INSERT INTO account_balance_projection(account_id,unit,settled_available,held) VALUES ('owner','sat',10,10)");
      await pool.query("INSERT INTO admissions(admission_id,account_id,reference,capacity_reference,state) VALUES ('admission','owner','admission','capacity','accepted')");
      await pool.query("INSERT INTO session_cap_holds(hold_id,account_id,reference,requested_cap,held_amount,state) VALUES ('hold','owner','admission',10,10,'active')");
      const store = new PostgresSqlFundingStore(pool, { deadlineMs: 5_000 });
      await store.transact("owner", (tx) => tx.reserveActionBudget({ accountId: "owner", admissionReference: "admission", idempotencyKey: "budget-key", fingerprint: "a".repeat(64), reference: "budget", amount: 10n }));
      await store.transact("owner", (tx) => tx.prepareMeteredAction({ accountId: "owner", idempotencyKey: "action-key", fingerprint: "b".repeat(64), sessionId: "session", actionId: "actual-action", expectedVersion: 0, admissionReference: "admission", actionBudgetReference: "budget", maximum: 10n, operationId: "different-provider-operation", profileId: "code-proposal", priceCardId: "phase-04-deterministic-card-2026-08-04" }));
      const claim = await store.transact("owner", (tx) => tx.claimProviderOperation("different-provider-operation"));
      expect(claim.claimed).toBe(true); expect(claim.action.actionId).toBe("actual-action");
      const observed = await store.transact("owner", (tx) => tx.recordUsageReceipt({ operationId: "different-provider-operation", protectedEvidenceReference: "receipt:test" }));
      expect(observed.actionId).toBe("actual-action");
      const input: MeteredFinalizeInput = { idempotencyKey: "action-key", operationId: "different-provider-operation", receiptCharge: charge, providerReceiptReference: "receipt:test", status: "failed", sessionVersion: 1, artifactVersion: 0, result: { status: "failed", code: "WORKER_OR_ARTIFACT_FAILED", accountId: "owner", sessionId: "session", sessionVersion: 1, artifactVersion: 0, confirmedSpend: charge, remainingCap: String(10 - Number(charge)), remainingBalance: String(10 - Number(charge)), nextAction: "revise_session", operationId: "different-provider-operation" } };
      const finalized = await store.transact("owner", (tx) => tx.finalizeMeteredAction(input));
      expect(finalized.receiptCharge).toBe(charge);
      expect((await store.transact("owner", (tx) => tx.finalizeMeteredAction(input))).result).toEqual(finalized.result);
      const money = (await pool.query("SELECT settled_available::text,held::text FROM account_balance_projection WHERE account_id='owner'")).rows[0];
      expect(money).toEqual({ settled_available: String(10 - Number(charge)), held: String(10 - Number(charge)) });
      expect((await pool.query("SELECT state FROM action_budget_reservations WHERE reservation_reference='budget'")).rows[0]?.state).toBe("released");
      expect((await pool.query("SELECT count(*)::int AS count FROM ledger_entries WHERE direction='debit' AND account_id='owner'")).rows[0]?.count).toBe(charge === "0" ? 0 : 1);
      expect((await pool.query("SELECT count(*)::int AS count FROM usage_receipts")).rows[0]?.count).toBe(1);
      expect((await pool.query("SELECT count(*)::int AS count FROM session_artifacts")).rows[0]?.count).toBe(0);
    } finally { await pool.end(); await admin.query(`DROP SCHEMA ${schema} CASCADE`); await admin.end(); }
  }, 30_000);
}
