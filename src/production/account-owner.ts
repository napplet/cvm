import { bindAccountingRealmPool,createAccountingRealm } from "../funding/accounting-realm";
import type { PostgresSqlPool } from "../persistence/postgres-sql-funding-store";
/** Gate real funding ingress on the installed immutable owner contract. Existing
 * conflicting metadata is evidence to reconcile, never silently overwrite. */
export async function assertProductionAccountOwnerSchema(input:PostgresSqlPool):Promise<void>{
 const pool=bindAccountingRealmPool(input,createAccountingRealm("production-real")),client=await pool.connect();
 try{
  const guards=await client.query("SELECT count(*)::int AS count FROM pg_catalog.pg_trigger WHERE NOT tgisinternal AND tgenabled='O' AND ((tgrelid='production_real.funding_accounts'::regclass AND tgname IN ('immutable_account_owner','record_account_owner')) OR (tgrelid='production_real.account_owner_bindings'::regclass AND tgname='immutable_owner_binding_audit'))");
  if(Number(guards.rows[0]?.count)!==3)throw new Error("PRODUCTION_ACCOUNT_OWNER_SCHEMA_REQUIRED");
  await client.query("SELECT account_id,nostr_pubkey,bound_at FROM production_real.account_owner_bindings LIMIT 0");
  const conflicts=await client.query("SELECT 1 FROM production_real.funding_accounts WHERE nostr_pubkey IS NOT NULL AND (nostr_pubkey::text !~ '^[a-f0-9]{64}$' OR account_id<>'account:'||encode(sha256(convert_to(nostr_pubkey::text,'UTF8')),'hex')) LIMIT 1");
  if(conflicts.rows.length)throw new Error("PRODUCTION_ACCOUNT_OWNER_CONFLICT");
 }catch(error){
  if(error instanceof Error&&error.message==="PRODUCTION_ACCOUNT_OWNER_CONFLICT")throw error;
  throw new Error("PRODUCTION_ACCOUNT_OWNER_SCHEMA_REQUIRED");
 }finally{client.release();}
}
