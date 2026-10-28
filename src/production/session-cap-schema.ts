import { bindAccountingRealmPool, createAccountingRealm } from "../funding/accounting-realm";
import type { PostgresSqlPool } from "../persistence/postgres-sql-funding-store";

/** Read-only startup prerequisite; customer traffic cannot install/repair it. */
export async function assertProductionSessionCapSchema(pool: PostgresSqlPool): Promise<void> {
  const client = await bindAccountingRealmPool(pool, createAccountingRealm("production-real")).connect();
  try {
    await client.query("SELECT approved_cap,requested_cap,held_amount FROM session_cap_holds LIMIT 0");
    await client.query("SELECT approval_reference,account_id,session_id,admission_reference,idempotency_key,fingerprint_sha256,consent_reference,policy_version,protocol_version,previous_approved_cap,approved_cap,previous_held_amount,held_amount,previous_requested_cap,requested_cap,result_json FROM session_cap_approvals LIMIT 0");
    const privilege = (await client.query<{ ready: boolean }>("SELECT has_table_privilege(current_user,'production_real.session_cap_approvals','SELECT') AND has_table_privilege(current_user,'production_real.session_cap_approvals','INSERT') AND NOT has_table_privilege(current_user,'production_real.session_cap_approvals','UPDATE,DELETE,TRUNCATE,TRIGGER') AND has_column_privilege(current_user,'production_real.session_cap_holds','approved_cap','UPDATE') AS ready")).rows[0];
    if (!privilege?.ready) throw new Error("SESSION_CAP_RESTRICTED_SCHEMA_REQUIRED");
    for (const [table, name, type, fn] of [
      ["session_cap_holds", "initial_session_cap", 7, "guard_session_cap_approval"],
      ["session_cap_holds", "session_cap_approval", 19, "guard_session_cap_approval"],
      ["session_cap_approvals", "session_cap_history_immutable", 27, "guard_session_cap_history"],
    ] as const) {
      const guard = (await client.query<{ ready: boolean }>("SELECT EXISTS(SELECT 1 FROM pg_catalog.pg_trigger WHERE tgrelid=$1::regclass AND tgname=$2 AND tgtype=$3 AND NOT tgisinternal AND tgenabled IN ('O','A') AND tgfoid=$4::regprocedure) AS ready", [`production_real.${table}`, name, type, `production_real.${fn}()`])).rows[0];
      if (!guard?.ready) throw new Error("SESSION_CAP_GUARD_REQUIRED");
    }
    const column = (await client.query<{ ready: boolean }>("SELECT EXISTS(SELECT 1 FROM pg_catalog.pg_attribute WHERE attrelid='production_real.session_cap_holds'::regclass AND attname='approved_cap' AND attnotnull AND NOT attisdropped) AS ready")).rows[0];
    if (!column?.ready) throw new Error("SESSION_CAP_COLUMN_REQUIRED");
  } catch (cause) { throw new Error("PRODUCTION_SESSION_CAP_SCHEMA_REQUIRED", { cause }); }
  finally { client.release(); }
}
