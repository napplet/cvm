import { bindAccountingRealmPool, createAccountingRealm } from "../funding/accounting-realm";
import type { PostgresSqlPool } from "../persistence/postgres-sql-funding-store";

const tables = [
  { name: "checkpoint_crypto_records", trigger: "checkpoint_crypto_immutable", guard: "guard_checkpoint_transition", columns: "checkpoint_id,key_reference,binding_sha256,account_id,session_id,action_id,operation_id,retention_until,plaintext_sha256,aad_sha256,ciphertext_sha256,nonce,wrap_nonce,wrapped_dek,ciphertext,state,created_at,destroyed_at", updates: ["wrapped_dek", "ciphertext", "state", "destroyed_at"] },
  { name: "checkpoint_crypto_audit", trigger: "checkpoint_audit_immutable", guard: "guard_checkpoint_transition", columns: "sequence,checkpoint_id,key_reference,event,details_sha256,recorded_at", updates: [] },
  { name: "checkpoint_envelopes", trigger: "checkpoint_envelope_immutable", guard: "guard_checkpoint_transition", columns: "checkpoint_id,account_id,session_id,action_id,operation_id,manifest_json,object_key,object_generation,object_checksum,key_reference,retention_until,state,created_at,destroyed_at", updates: ["state", "destroyed_at"] },
  { name: "continuation_worker_allocations", trigger: "checkpoint_allocation_immutable", guard: "guard_checkpoint_transition", columns: "checkpoint_id,account_id,session_id,action_id,allocation_intent_reference,capacity_intent_reference,capacity_reference,state,created_at", updates: [] },
  /* Phase 07/014 is a production-only expansion.  Its presence is checked
   * before retained-subject preparation or clone provisioning; legacy history
   * import deliberately continues to use its older compatible reader. */
  { name: "durability_subjects", trigger: "durability_subject_immutable", guard: "guard_durability_subject", columns: "checkpoint_id,kind,source_identity,object_key,object_generation,object_checksum,payload_sha256,owner_id,session_id,action_id,retention_until,deletion_state,created_at,updated_at", updates: ["deletion_state", "updated_at"] },
] as const;

/** Read-only startup prerequisite. Schema installation belongs to the bounded
 * migration operator, never the service role or a customer request. */
export async function assertProductionCheckpointSchema(rawPool: PostgresSqlPool): Promise<void> {
  const client = await bindAccountingRealmPool(rawPool, createAccountingRealm("production-real")).connect();
  try {
    for (const table of tables) {
      // Identifiers above are fixed source constants; no request input is SQL.
      await client.query(`SELECT ${table.columns} FROM production_real.${table.name} LIMIT 0`);
      const relation = `production_real.${table.name}`;
      const guard = (await client.query<{ ready: boolean }>(
        "SELECT has_table_privilege(current_user,$1,'SELECT') AND has_table_privilege(current_user,$1,'INSERT') AND NOT has_table_privilege(current_user,$1,'DELETE,TRUNCATE,TRIGGER') AND EXISTS(SELECT 1 FROM pg_catalog.pg_trigger WHERE tgrelid=$1::regclass AND tgname=$2 AND NOT tgisinternal AND tgenabled IN ('O','A') AND tgtype=27 AND tgfoid=to_regprocedure($3)) AS ready", [relation, table.trigger, `production_real.${table.guard}()`],
      )).rows[0];
      if (!guard?.ready) throw new Error("PRODUCTION_CHECKPOINT_RESTRICTED_SCHEMA_REQUIRED");
      for (const column of table.updates) {
        const privilege = (await client.query<{ writable: boolean }>("SELECT has_column_privilege(current_user,$1,$2,'UPDATE') AS writable", [relation, column])).rows[0];
        if (!privilege?.writable) throw new Error("PRODUCTION_CHECKPOINT_RESTRICTED_SCHEMA_REQUIRED");
      }
    }
    const sequence = (await client.query<{ ready: boolean }>("SELECT has_sequence_privilege(current_user,'production_real.checkpoint_crypto_audit_sequence_seq','USAGE') AS ready")).rows[0];
    if (!sequence?.ready) throw new Error("PRODUCTION_CHECKPOINT_RESTRICTED_SCHEMA_REQUIRED");
  } catch (cause) {
    throw new Error("PRODUCTION_CHECKPOINT_SCHEMA_REQUIRED", { cause });
  } finally { client.release(); }
}
