import { z } from "zod";
import { accountIdForPrincipal } from "../domain/account-command";
import { bindAccountingRealmPool,createAccountingRealm } from "../funding/accounting-realm";
import { PostgresSqlFundingStore,type PostgresSqlPool } from "../persistence/postgres-sql-funding-store";
import { assertProductionReadyCapacity,type ProductionReadyCapacityPort } from "./worker-capacity";
const instances=new WeakSet<object>();
const Command=z.object({principal:z.object({pubkey:z.string().regex(/^[a-f0-9]{64}$/u)}),admissionReference:z.string().min(1),idempotencyKey:z.string().min(1)});
export function assertProductionFundedReplayAuthority(value:unknown):asserts value is ProductionFundedReplayAuthority {
 if(!value||typeof value!=="object"||!instances.has(value))throw new Error("PRODUCTION_FUNDED_REPLAY_AUTHORITY_REQUIRED");
}
/** A cap hold is financial authority, not proof that its isolated execution
 * lease is still usable. Observe only the original resource; never allocate. */
export class ProductionFundedReplayAuthority {
 readonly #pool:PostgresSqlPool;
 constructor(private readonly input:Readonly<{pool:PostgresSqlPool;capacity:ProductionReadyCapacityPort;now?:()=>number}>){
  assertProductionReadyCapacity(input.capacity);this.#pool=bindAccountingRealmPool(input.pool,createAccountingRealm("production-real"));instances.add(this);
 }
 async allow(raw:unknown):Promise<boolean>{
  const command=Command.parse(raw),accountId=await accountIdForPrincipal(command.principal),now=(this.input.now??Date.now)();
  // Only an existing real account may acquire its own legacy association.
  // The protected command has already been authenticated by the intake/archive.
  // Enrollment changes metadata only; it does not supply a cap or capacity.
  const ownerClient=await this.#pool.connect();let enroll=false;
  try{
   const owner=(await ownerClient.query("SELECT trim(nostr_pubkey) AS pubkey FROM production_real.funding_accounts WHERE account_id=$1 AND accounting_realm='production-real'",[accountId])).rows[0];
   if(!owner)return false;
   if(owner.pubkey!==null&&owner.pubkey!==command.principal.pubkey)return false;
   enroll=owner.pubkey===null;
  }finally{ownerClient.release();}
  if(enroll)await new PostgresSqlFundingStore(this.#pool).bindPrincipal(command.principal);
  const client=await this.#pool.connect();
  let intentReference:string|undefined,reference:string|undefined;
  try{
   const action=await client.query("SELECT m.state,m.terminal_result FROM production_real.metered_actions m JOIN production_real.funding_accounts f ON f.account_id=m.account_id WHERE m.account_id=$1 AND m.idempotency_key=$2 AND f.accounting_realm='production-real' AND trim(f.nostr_pubkey)=$3 LIMIT 1",[accountId,command.idempotencyKey,command.principal.pubkey]);
   // Reading an already committed result requires no live worker or new cap.
   if(action.rows[0]?.terminal_result)return true;
   // Once the provider claim is durable, the shared core can only look up
   // that original. Worker loss must not prevent receipt reconciliation.
   if(action.rows[0]?.state==="active"||action.rows[0]?.state==="usage_unknown")return true;
   const rows=await client.query("SELECT c.intent_reference,c.capacity_reference,c.expires_at FROM production_real.admissions a JOIN production_real.funding_accounts f ON f.account_id=a.account_id AND f.accounting_realm='production-real' AND trim(f.nostr_pubkey)=$4 JOIN production_real.session_cap_holds h ON h.account_id=a.account_id AND h.reference=a.reference LEFT JOIN production_real.metered_actions m ON m.account_id=a.account_id AND m.idempotency_key=$3 LEFT JOIN production_real.continuation_worker_allocations r ON r.account_id=m.account_id AND r.session_id=m.session_id AND r.action_id=m.id AND r.state='available' JOIN production_real.capacity_intents c ON c.account_id=a.account_id AND c.capacity_reference=COALESCE(r.capacity_reference,a.capacity_reference) WHERE a.account_id=$1 AND a.reference=$2 AND a.state='accepted' AND h.state='active' AND c.state='available' LIMIT 2",[accountId,command.admissionReference,command.idempotencyKey,command.principal.pubkey]);
   if(rows.rows.length!==1)return false;
   const row=rows.rows[0];if(!row||new Date(String(row.expires_at)).getTime()<=now||!Number.isFinite(new Date(String(row.expires_at)).getTime()))return false;
   intentReference=z.string().regex(/^capacity-intent:[a-f0-9]{64}$/u).parse(row.intent_reference);reference=z.string().regex(/^capacity:[a-f0-9]{64}$/u).parse(row.capacity_reference);
  }finally{client.release();}
  const parsed=z.object({intentReference:z.string().regex(/^capacity-intent:[a-f0-9]{64}$/u),reference:z.string().regex(/^capacity:[a-f0-9]{64}$/u),expectedSessionBindingDigest:z.string().regex(/^sha256:[a-f0-9]{64}$/u),deadlineEpochMs:z.number().int().positive()}).passthrough().safeParse(await this.input.capacity.inspect({intentReference}));
  if(!parsed.success)return false;
  const original=parsed.data;
  if(original.intentReference!==intentReference||original.reference!==reference||original.deadlineEpochMs<=now)return false;
  const observed=await this.input.capacity.observe({intentReference,expectedSessionBindingDigest:original.expectedSessionBindingDigest,reference});
  return observed.status==="available"&&observed.reference===reference&&observed.ready.intentReference===intentReference&&observed.ready.sessionBindingDigest===original.expectedSessionBindingDigest&&new Date(observed.expiresAt).getTime()>now;
 }
}
