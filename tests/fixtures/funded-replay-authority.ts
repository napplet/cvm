import { createHash } from "node:crypto";
import { z } from "zod";
import { accountIdForPrincipal } from "../../src/domain/account-command";
import { FundingService } from "../../src/funding/funding-service";
import { FundedAdmissionService } from "../../src/funding/funded-admission";
import { PostgresFundingDatabase } from "../../src/persistence/postgres-funding-database";
import type { PostgresSqlPool } from "../../src/persistence/postgres-sql-funding-store";
import { ProductionFundedReplayAuthority } from "../../src/production/funded-replay-authority";
import { createProductionReadyCapacity } from "../../src/production/worker-capacity";
import { PostgresOperationJournal } from "../../src/release/deployment/postgres-operation-journal";
import { PRODUCTION_WORKER_POLICY,LOCKED_WORKER_SCHEDULE,WORKER_RUNNER_DEFINITION,type createWorkerDeploymentClients,type WorkerOperationRecord } from "../../src/release/deployment/worker-clients";
import { exactReadyReservation,trustedAdmissionReceipt,trustedAdmissionReceiptAuthority } from "./admission-ready";
const sha=(v:string)=>createHash("sha256").update(v).digest("hex");
/** Actual restricted SQL/production capacity/authority, explicit worker protocol
 * fixture. Every allocation/termination/exec path throws; observe only. */
export async function fundedReplayAuthorityFixture(input:Readonly<{pool:PostgresSqlPool;principal:Readonly<{pubkey:string}>;admissionReference?:string;now?:()=>number}>){
 const now=input.now??Date.now,accountId=await accountIdForPrincipal(input.principal);
 let admissionReference=input.admissionReference;
 if(!admissionReference){
  const database=new PostgresFundingDatabase(input.pool,{realm:"production-real"}),funding=new FundingService(database.funding);
  await funding.execute({principal:input.principal,kind:"credit_settlement",idempotencyKey:"replay-credit",policyVersion:"funding-policy-v1",protocolVersion:"funding-contract-v1",payload:{settlement:{topUpId:"replay-topup",rail:"lightning",unit:"sat",amount:"1000",externalReference:"replay-external",settlementReference:"replay-settlement",verifiedAt:new Date(now()).toISOString()}}});
  const ready={async reserveNow(value:{intentReference:string}){return exactReadyReservation(value.intentReference,`capacity:${value.intentReference.split(":")[1]}`,new Date(now()+1_200_000).toISOString());},async observe(value:{intentReference:string}){return this.reserveNow(value);},async release(){}};
  const service=new FundedAdmissionService({funding,store:database.funding,capacity:ready,receiptAuthority:trustedAdmissionReceiptAuthority,now});
  const command={principal:input.principal,idempotencyKey:"replay-admit",policyVersion:"funding-policy-v1",protocolVersion:"funding-contract-v1",payload:{requestedCap:"1000",unit:"sat"}};
  const admitted=await service.admit(command,await trustedAdmissionReceipt(command));if(admitted.status!=="accepted")throw new Error("FIXTURE_ADMISSION_REQUIRED");admissionReference=admitted.reference;
 }
 const client=await input.pool.connect();let raw:unknown;
 try{raw=(await client.query("SELECT intent_reference,capacity_reference,expires_at FROM production_real.capacity_intents WHERE account_id=$1 AND capacity_reference=$2 AND state='available'",[accountId,admissionReference])).rows[0];}finally{client.release();}
 const row=z.object({intent_reference:z.string(),capacity_reference:z.string(),expires_at:z.union([z.date(),z.string()])}).parse(raw);
 const deadline=new Date(row.expires_at).getTime(),binding=`sha256:${"a".repeat(64)}`,image=`registry.example/worker@sha256:${"b".repeat(64)}`,toolchain="b".repeat(64),operationId=`capacity-${sha(row.intent_reference).slice(0,40)}`;
 const journal=new PostgresOperationJournal(input.pool,{namespace:"replay-capacity-fixture",scopeSha256:"a".repeat(64)}),workerJournal=new PostgresOperationJournal(input.pool,{namespace:"replay-worker-fixture",scopeSha256:"a".repeat(64)});
 const worker:WorkerOperationRecord={operationId,provider:"modal",appName:"fixture-app",requestSha256:"c".repeat(64),state:"dispatched",resourceName:operationId,resourceId:operationId,image,policyVersion:PRODUCTION_WORKER_POLICY.version,sessionLeaseSha256:"a".repeat(64),toolchainSha256:toolchain,providerDeadlineEpochMs:deadline,createdAtMs:now()};
 await workerJournal.claim(operationId,"c".repeat(64),worker);
 await journal.claim(`capacity-intent:${sha(row.intent_reference)}`,sha(JSON.stringify({intentReference:row.intent_reference,expectedSessionBindingDigest:binding,provider:"modal"})),{intentReference:row.intent_reference,expectedSessionBindingDigest:binding,reference:row.capacity_reference,workerOperationId:operationId,provider:"modal",deadlineEpochMs:deadline,execution:{image,toolchainSha256:toolchain,policyVersion:PRODUCTION_WORKER_POLICY.version},readiness:{readyMonotonicMs:2,readinessProbeDigest:`sha256:${"c".repeat(64)}`}});
 let missing=false;
 const forbidden=async()=>{throw new Error("FIXTURE_WORKER_MUTATION_OR_EXEC_FORBIDDEN");};
 const port={definition:WORKER_RUNNER_DEFINITION,schedules:LOCKED_WORKER_SCHEDULE,config:{image,workspaceRoot:PRODUCTION_WORKER_POLICY.workspaceRoot,policyVersion:PRODUCTION_WORKER_POLICY.version},create:forbidden,terminate:forbidden,observeTermination:forbidden,exec:forbidden,async observe(value:{operationId:string}){const original=(await workerJournal.read<WorkerOperationRecord>(value.operationId))?.value;if(missing||!original?.resourceId)return {status:"unknown" as const};return {status:"completed" as const,resourceId:original.resourceId,readiness:{readyMonotonicMs:2,readinessProbeDigest:`sha256:${"c".repeat(64)}`}};}};
 const workers:ReturnType<typeof createWorkerDeploymentClients>={selection:{status:"unselected",reasonCode:"FRESH_PROTECTED_EVIDENCE_REQUIRED"},modal:port,fly:port};
 const capacity=createProductionReadyCapacity({provider:"modal",workers,journal,workerJournal,image,toolchainSha256:toolchain,now});
 return {authority:new ProductionFundedReplayAuthority({pool:input.pool,capacity,now}),admissionReference,setMissing(value:boolean){missing=value;}};
}
