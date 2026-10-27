import { expect, test } from "bun:test";
import { createDevelopmentPool } from "../../scripts/dev-payments";
import { readDevelopmentPaymentConfig } from "./payment-config";

test("SQL budget lifecycle permits release and exhausted holds while rejecting negative money", async () => {
  const config = await readDevelopmentPaymentConfig();
  const pool = createDevelopmentPool(config.databaseUrl); const client = await pool.connect(); const id = `schema-test:${crypto.randomUUID()}`;
  try {
    await client.query("BEGIN");
    await client.query("INSERT INTO funding_accounts(account_id,unit) VALUES ($1,'sat')", [id]);
    await client.query("INSERT INTO admissions(admission_id,account_id,reference,capacity_reference,state) VALUES ($1,$1,$1,$1,'accepted')", [id]);
    await client.query("INSERT INTO session_cap_holds(hold_id,account_id,reference,requested_cap,held_amount,state) VALUES ($1,$1,$1,1,1,'active')", [id]);
    await client.query("INSERT INTO action_budget_reservations(reservation_id,account_id,admission_reference,idempotency_key,fingerprint_sha256,reservation_reference,amount,unit,state) VALUES ($1,$1,$1,$1,$2,$1,1,'sat','authorized')", [id, "a".repeat(64)]);
    await client.query("UPDATE action_budget_reservations SET state='released' WHERE reservation_id=$1", [id]);
    await client.query("UPDATE session_cap_holds SET held_amount=0,state='consumed' WHERE hold_id=$1", [id]);
    expect((await client.query("SELECT state FROM action_budget_reservations WHERE reservation_id=$1", [id])).rows[0]?.state).toBe("released");
    expect(String((await client.query("SELECT held_amount FROM session_cap_holds WHERE hold_id=$1", [id])).rows[0]?.held_amount)).toBe("0");
    for (const sql of ["UPDATE session_cap_holds SET held_amount=-1 WHERE hold_id=$1", "UPDATE action_budget_reservations SET state='invented' WHERE reservation_id=$1", "UPDATE action_budget_reservations SET amount=0 WHERE reservation_id=$1"]) {
      await client.query("SAVEPOINT invalid_change");
      await expect(client.query(sql, [id])).rejects.toMatchObject({ code: "23514" });
      await client.query("ROLLBACK TO SAVEPOINT invalid_change");
    }
  } finally { await client.query("ROLLBACK"); client.release(); await pool.end(); }
});
