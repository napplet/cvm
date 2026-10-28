import { createHash } from "node:crypto";
import { z } from "zod";
import { bindAccountingRealmPool, createAccountingRealm } from "../funding/accounting-realm";
import type { PostgresSqlPool } from "../persistence/postgres-sql-funding-store";

const Input = z.object({ accountId: z.string().regex(/^account:[a-f0-9]{64}$/u), admissionReference: z.string().regex(/^capacity:[a-f0-9]{64}$/u), intentReference: z.string().regex(/^capacity-intent:[a-f0-9]{64}$/u) }).strict();
const Result = z.object({ state: z.literal("released"), amount: z.string().regex(/^[1-9][0-9]*$/u), unit: z.literal("sat") }).strict();

/** Releases only an entirely unused admission. The serializable transaction
 * fences concurrent action reservations, preserves settled funds, and appends
 * its release receipt/outbox with the hold update. No synthetic credit occurs. */
export class ProductionUnusedAdmissionRelease {
  readonly #pool: PostgresSqlPool;
  constructor(pool: PostgresSqlPool) { this.#pool = bindAccountingRealmPool(pool, createAccountingRealm("production-real")); }
  /** Recovery proof only. It deliberately takes no locks and performs no
   * balance, hold, or capacity mutation. */
  async observe(value: z.infer<typeof Input>): Promise<z.infer<typeof Result> | undefined> {
    const input = Input.parse(value); const fingerprint = createHash("sha256").update(JSON.stringify(input)).digest("hex"); const id = `unused-admission:${fingerprint}`;
    const client = await this.#pool.connect();
    try {
      const command = (await client.query("SELECT fingerprint_sha256,result_json FROM production_real.funding_commands WHERE account_id=$1 AND command_kind='release_unused_admission' AND idempotency_key=$2", [input.accountId, id])).rows[0];
      if (!command) return undefined;
      if (command.fingerprint_sha256 !== fingerprint) throw new Error("ADMISSION_RELEASE_IDENTITY_CONFLICT");
      const fence = (await client.query("SELECT h.state AS hold_state,c.state AS capacity_state, EXISTS(SELECT 1 FROM production_real.action_budget_reservations b WHERE b.account_id=h.account_id AND b.admission_reference=h.reference) AS has_budget, EXISTS(SELECT 1 FROM production_real.metered_actions a WHERE a.account_id=h.account_id AND a.admission_reference=h.reference) AS has_action FROM production_real.session_cap_holds h JOIN production_real.admissions a ON a.account_id=h.account_id AND a.reference=h.reference JOIN production_real.capacity_intents c ON c.account_id=a.account_id AND c.capacity_reference=a.capacity_reference WHERE h.account_id=$1 AND h.reference=$2 AND c.intent_reference=$3", [input.accountId, input.admissionReference, input.intentReference])).rows[0];
      if (!fence || fence.hold_state !== "released" || fence.capacity_state !== "released" || fence.has_budget || fence.has_action) throw new Error("UNUSED_ADMISSION_RELEASE_PROOF_INVALID");
      return Result.parse(command.result_json);
    } finally { client.release(); }
  }
  async release(value: z.infer<typeof Input>): Promise<z.infer<typeof Result>> {
    const input = Input.parse(value);
    const fingerprint = createHash("sha256").update(JSON.stringify(input)).digest("hex");
    const id = `unused-admission:${fingerprint}`;
    for (let attempt = 0; attempt < 5; attempt++) {
      const client = await this.#pool.connect();
      try {
        await client.query("BEGIN ISOLATION LEVEL SERIALIZABLE");
        await client.query("SET LOCAL lock_timeout='1s'"); await client.query("SET LOCAL statement_timeout='5s'");
        const prior = (await client.query("SELECT fingerprint_sha256,result_json FROM production_real.funding_commands WHERE account_id=$1 AND command_kind='release_unused_admission' AND idempotency_key=$2", [input.accountId, id])).rows[0];
        if (prior) {
          if (prior.fingerprint_sha256 !== fingerprint) throw new Error("ADMISSION_RELEASE_IDENTITY_CONFLICT");
          const result = Result.parse(prior.result_json); await client.query("COMMIT"); return result;
        }
        const row = (await client.query("SELECT h.held_amount,b.settled_available,b.held FROM production_real.session_cap_holds h JOIN production_real.account_balance_projection b ON b.account_id=h.account_id JOIN production_real.admissions a ON a.account_id=h.account_id AND a.reference=h.reference JOIN production_real.capacity_intents c ON c.account_id=a.account_id AND c.capacity_reference=a.capacity_reference WHERE h.account_id=$1 AND h.reference=$2 AND c.intent_reference=$3 AND h.state='active' AND a.state='accepted' AND c.state='available' FOR UPDATE OF h,b,c", [input.accountId, input.admissionReference, input.intentReference])).rows[0];
        if (!row) throw new Error("UNUSED_ADMISSION_REQUIRED");
        const budgets = await client.query("SELECT 1 FROM production_real.action_budget_reservations WHERE account_id=$1 AND admission_reference=$2 LIMIT 1", [input.accountId, input.admissionReference]);
        const actions = await client.query("SELECT 1 FROM production_real.metered_actions WHERE account_id=$1 AND admission_reference=$2 LIMIT 1", [input.accountId, input.admissionReference]);
        if (budgets.rows.length || actions.rows.length) throw new Error("ADMISSION_ALREADY_USED");
        const amount = BigInt(String(row.held_amount)); const remainingHeld = BigInt(String(row.held)) - amount;
        if (amount <= 0n || remainingHeld < 0n) throw new Error("ADMISSION_RELEASE_BALANCE_INVALID");
        await client.query("UPDATE production_real.session_cap_holds SET held_amount=0,state='released' WHERE account_id=$1 AND reference=$2", [input.accountId, input.admissionReference]);
        await client.query("UPDATE production_real.account_balance_projection SET held=$2 WHERE account_id=$1", [input.accountId, remainingHeld.toString()]);
        await client.query("UPDATE production_real.capacity_intents SET state='released' WHERE account_id=$1 AND intent_reference=$2", [input.accountId, input.intentReference]);
        const result = Result.parse({ state: "released", amount: amount.toString(), unit: "sat" });
        await client.query("INSERT INTO production_real.billing_line_items(id,account_id,source_identity,kind,unit,amount_sat,settled_available_sat,held_sat,session_spend_sat) VALUES($1,$2,$1,'release','sat',$3,$4,$5,0)", [id, input.accountId, result.amount, String(row.settled_available), remainingHeld.toString()]);
        await client.query("INSERT INTO production_real.funding_commands(account_id,command_kind,idempotency_key,fingerprint_sha256,result_json) VALUES($1,'release_unused_admission',$2,$3,$4::jsonb)", [input.accountId, id, fingerprint, JSON.stringify(result)]);
        await client.query("INSERT INTO production_real.funding_outbox(outbox_id,aggregate_reference,event_kind,payload_json) VALUES($1,$2,'unused_admission_released',$3::jsonb)", [id, input.admissionReference, JSON.stringify({ ...input, ...result })]);
        await client.query("COMMIT"); return Object.freeze(result);
      } catch (error) {
        await client.query("ROLLBACK").catch(() => undefined);
        if (attempt === 4 || !["40001", "40P01", "23505"].includes(String((error as { code?: string }).code))) throw error;
      } finally { client.release(); }
    }
    throw new Error("ADMISSION_RELEASE_RETRY_EXHAUSTED");
  }
}
