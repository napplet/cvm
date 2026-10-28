import { expect,test } from "bun:test";
import { Pool } from "pg";
import { z } from "zod";
import { canonicalJson } from "../../src/promotion/schema";
import { ProductionContextVmGenerationIntakes, assertProductionContextVmGenerationIntakes } from "../../src/production/contextvm-generation-intake";
import { loadMountedCheckpointKek } from "../../src/production/checkpoint-crypto";
import { PostgresOperationJournal } from "../../src/release/deployment/postgres-operation-journal";
import { createDurableContextVmTransport } from "../../src/release/deployment/contextvm-client";
import type { PostgresSqlPool } from "../../src/persistence/postgres-sql-funding-store";
import type { ContextVmTransportPort,ContextVmInboundEnvelope,ContextVmWireResponse } from "../../src/contextvm/sdk-bridge";
const integration=process.env.NAPPLET_RUN_POSTGRES_ISOLATION==="1"?test:test.skip;
const hash=(v:unknown)=>new Bun.CryptoHasher("sha256").update(canonicalJson(v)).digest("hex");
async function docker(args:string[]){const p=Bun.spawn(["docker",...args],{stdout:"pipe",stderr:"pipe"});const [out,err,code]=await Promise.all([new Response(p.stdout).text(),new Response(p.stderr).text(),p.exited]);if(code)throw new Error(`DOCKER_FAILED:${err.slice(0,300)}`);return out.trim();}
integration("protected generation intake couples SQL claims, preserves old originals and recovers bounded exact-context requests without replaying payment tools",async()=>{
 const name=`cvm-intake-${crypto.randomUUID().replaceAll("-","")}`;let admin:Pool|undefined,native:Pool|undefined;
 try{
  await docker(["run","-d","--rm","--name",name,"-p","127.0.0.1::5432","-e","POSTGRES_HOST_AUTH_METHOD=trust","postgres:17-alpine"]);
  const port=(await docker(["port",name,"5432/tcp"])).match(/127\.0\.0\.1:(\d+)/u)?.[1];if(!port)throw new Error("PORT_REQUIRED");
  admin=new Pool({connectionString:`postgresql://postgres@127.0.0.1:${port}/postgres`});
  for(let i=0;i<90;i++){try{await admin.query("SELECT 1");break;}catch(e){if(i===89)throw e;await Bun.sleep(250);}}
  for(const file of ["phase-03/001_funding.sql","phase-04/001_metered_generation.sql","phase-04/002_action_budget_lifecycle.sql","phase-05/001_continuation.sql","phase-06/001_publication.sql","phase-03/002_production_accounting.sql","phase-07/001_production_operation_journal.sql"])await admin.query(await Bun.file(`migrations/${file}`).text());
  await admin.query("CREATE ROLE intake_test LOGIN");await admin.query("GRANT napplet_production_real TO intake_test");
  native=new Pool({connectionString:`postgresql://intake_test@127.0.0.1:${port}/postgres`});
  const nativePool=native;
  let pairFault:"before"|"after"|undefined,responseAckLost=false;
  const pool:PostgresSqlPool={async connect(){const c=await nativePool.connect();let pair=false,response=false;return {async query<Row extends Record<string,unknown>>(sql:string,values?:readonly unknown[]){
    if(sql.startsWith("INSERT INTO production_real.release_operation_journal")&&String(values?.[2]).startsWith("contextvm-intake:"))pair=true;
    if(sql.startsWith("UPDATE production_real.release_operation_journal")&&values?.[2]==="response-ack"&&String(values?.[5]).includes('"state":"completed"'))response=true;
    const fault=sql==="COMMIT"&&pair?pairFault:undefined;if(fault)pairFault=undefined;
    if(fault==="before")throw new Error("FIXTURE_PAIR_ROLLBACK");
    const r=await c.query<Row>(sql,values?[...values]:undefined);
    if(fault==="after")throw new Error("FIXTURE_PAIR_ACK_LOST");
    if(sql==="COMMIT"&&response&&!responseAckLost){responseAckLost=true;throw new Error("FIXTURE_RESPONSE_ACK_LOST");}
    return {rows:r.rows};},release(){c.release();}};}};
  let now=Date.now();const calls=new Map<string,number>(),responses=new Map<string,ContextVmWireResponse[]>();
  const openJournal=(namespace="intake-test")=>new PostgresOperationJournal(pool,{namespace,scopeSha256:"a".repeat(64)});
  const envelope=(id:string):ContextVmInboundEnvelope=>({verifiedClientPubkey:"b".repeat(64),requestEventId:id,rawEvent:{id,tags:[]},request:{id:1,method:"tools/call",params:{name:"start_session",arguments:{admissionReference:"admission:fixture",idempotencyKey:id,maximum:"50",idea:"Private original timer."}}}});
  function controller(options:{crash?:boolean;context?:string;namespace?:string;hold?:Promise<void>}={}){
    const journal=openJournal(options.namespace);let inbound:((v:ContextVmInboundEnvelope)=>Promise<void>)|undefined;
    const source:ContextVmTransportPort={onInbound(h){inbound=h;},configureAnnouncement(){},async sendResponse(_owner,r,id){responses.set(id,[...(responses.get(id)??[]),r]);},async sendNotification(){},canonicalInvocation(clientPubkey,method,params){return {clientPubkey,invocationHash:hash({method,params})};}};
    const intakes=new ProductionContextVmGenerationIntakes({journal,executionContextSha256:options.context??"c".repeat(64),key:{reference:"test:checkpoint-kek",load:()=>loadMountedCheckpointKek({kekPath:"/test/kek",readFile:async()=>Buffer.alloc(32,9).toString("base64")})},now:()=>now});
    const transport=createDurableContextVmTransport({source,journal,generationIntakes:intakes});
    transport.onInbound(async e=>{calls.set(e.requestEventId,(calls.get(e.requestEventId)??0)+1);if(options.crash)throw new Error("FIXTURE_HANDLER_LOSS");await options.hold;await transport.sendResponse(e.verifiedClientPubkey,{jsonrpc:"2.0",id:e.request.id,result:{status:"completed"}},e.requestEventId);});
    return {journal,transport,intakes,source,async deliver(e:ContextVmInboundEnvelope){if(!inbound)throw new Error("HANDLER_REQUIRED");await inbound(e);}};
  }
  const journal=openJournal();
  expect(()=>assertProductionContextVmGenerationIntakes({},journal)).toThrow("CONTEXTVM_INTAKE_JOURNAL_REQUIRED");
  const miswired=controller();expect(()=>createDurableContextVmTransport({source:miswired.source,journal:openJournal("foreign-journal"),generationIntakes:miswired.intakes})).toThrow("CONTEXTVM_INTAKE_JOURNAL_REQUIRED");
  pairFault="before";await expect(controller().deliver(envelope("rollback"))).rejects.toThrow("FIXTURE_PAIR_ROLLBACK");
  expect(await journal.read("rollback")).toBeUndefined();expect(await journal.read("contextvm-intake:rollback")).toBeUndefined();expect(calls.get("rollback")).toBeUndefined();
  pairFault="after";await expect(controller().deliver(envelope("lost-ack"))).rejects.toThrow("FIXTURE_PAIR_ACK_LOST");
  expect((await journal.read("lost-ack"))?.value).toEqual({state:"pending"});
  expect(JSON.stringify((await journal.read("contextvm-intake:lost-ack"))?.value)).not.toContain("Private original timer.");
  expect(calls.get("lost-ack")).toBeUndefined();
  now+=61_000;
  const outcomes=await Promise.all([controller().transport.recoverPendingGenerations(),controller().transport.recoverPendingGenerations()]);
  expect(outcomes.reduce((a,b)=>a+b,0)).toBe(1);expect(calls.get("lost-ack")).toBe(1);
  expect((await journal.read("contextvm-intake:lost-ack"))?.value).toMatchObject({state:"erased"});
  await controller().deliver(envelope("lost-ack"));expect(calls.get("lost-ack")).toBe(1);
  const ack=controller();await ack.deliver(envelope("response-ack"));expect(responseAckLost).toBe(true);expect(calls.get("response-ack")).toBe(1);expect(responses.get("response-ack")?.at(-1)?.result).toEqual({status:"completed"});
  await expect(controller({crash:true}).deliver(envelope("context"))).rejects.toThrow("FIXTURE_HANDLER_LOSS");now+=31_000;
  expect(await controller({context:"d".repeat(64)}).transport.recoverPendingGenerations()).toBe(1);expect(calls.get("context")).toBe(1);
  now+=31_000;await controller().transport.recoverPendingGenerations();expect(calls.get("context")).toBe(2);
  await expect(controller({crash:true}).deliver(envelope("tampered"))).rejects.toThrow("FIXTURE_HANDLER_LOSS");
  const altered=await journal.read("contextvm-intake:tampered");if(!altered)throw new Error("ARCHIVE_REQUIRED");
  const value=z.record(z.string(),z.unknown()).parse(altered.value),header=z.record(z.string(),z.unknown()).parse(value.header);
  await journal.compareAndSet(altered.operationId,altered.identitySha256,altered.revision,{...value,header:{...header,ownerPubkey:"e".repeat(64)}});
  now+=31_000;await controller().transport.recoverPendingGenerations();expect(calls.get("tampered")).toBe(1);
  const foreign=envelope("lost-ack");await expect(controller().deliver({...foreign,verifiedClientPubkey:"e".repeat(64)})).rejects.toThrow("OPERATION_IDENTITY_CONFLICT");
  const legacy=envelope("legacy"),identity=new Bun.CryptoHasher("sha256").update(JSON.stringify({requestEventId:legacy.requestEventId,clientPubkey:legacy.verifiedClientPubkey,invocationSha256:hash({method:legacy.request.method,params:legacy.request.params})})).digest("hex");
  await journal.claim(legacy.requestEventId,identity,{state:"pending"});await controller().deliver(legacy);expect(await journal.read("contextvm-intake:legacy")).toBeUndefined();expect(calls.get("legacy")).toBeUndefined();
  const legacyComplete=envelope("legacy-completed");
  const completedIdentity=new Bun.CryptoHasher("sha256").update(JSON.stringify({requestEventId:legacyComplete.requestEventId,clientPubkey:legacyComplete.verifiedClientPubkey,invocationSha256:hash({method:legacyComplete.request.method,params:legacyComplete.request.params})})).digest("hex");
  const legacyResponse={jsonrpc:"2.0" as const,id:1,result:{status:"original-completed"}};
  await journal.claim(legacyComplete.requestEventId,completedIdentity,{state:"completed",response:legacyResponse});const before=JSON.stringify(await journal.read(legacyComplete.requestEventId));
  await controller().deliver(legacyComplete);expect(responses.get(legacyComplete.requestEventId)?.at(-1)).toEqual(legacyResponse);expect(JSON.stringify(await journal.read(legacyComplete.requestEventId))).toBe(before);expect(await journal.read(`contextvm-intake:${legacyComplete.requestEventId}`)).toBeUndefined();
  const payment=envelope("payment");await controller().deliver({...payment,request:{...payment.request,params:{name:"top_up",arguments:{amount:"50"}}}});expect(await journal.read("contextvm-intake:payment")).toBeUndefined();expect(calls.get("payment")).toBe(1);
  const paymentLost=envelope("payment-lost");await expect(controller({crash:true}).deliver({...paymentLost,request:{...paymentLost.request,params:{name:"top_up",arguments:{amount:"50"}}}})).rejects.toThrow("FIXTURE_HANDLER_LOSS");now+=61_000;await controller().transport.recoverPendingGenerations();expect(calls.get("payment-lost")).toBe(1);expect(await journal.read("contextvm-intake:payment-lost")).toBeUndefined();
  await expect(controller({crash:true}).deliver(envelope("expired"))).rejects.toThrow("FIXTURE_HANDLER_LOSS");now+=30*86_400_000+1;
  await controller().transport.recoverPendingGenerations();expect(calls.get("expired")).toBe(1);const expired=await journal.read("contextvm-intake:expired");expect(expired?.value).toMatchObject({state:"erased"});expect(JSON.stringify(expired?.value)).not.toContain("wrappedDekBase64");expect((await journal.read("expired"))?.value).toEqual({state:"pending"});
  //101 valid protected companions:100 mismatched contexts cannot starve the last original.
  for(let i=0;i<101;i++)await expect(controller({namespace:"intake-fairness",context:i===100?"c".repeat(64):"d".repeat(64),crash:true}).deliver(envelope(`fair-${String(i).padStart(3,"0")}`))).rejects.toThrow("FIXTURE_HANDLER_LOSS");
  now+=31_000;const fair=controller({namespace:"intake-fairness"});expect(await fair.transport.recoverPendingGenerations()).toBe(100);expect(calls.get("fair-100")).toBe(1);expect(await fair.transport.recoverPendingGenerations()).toBe(1);expect(calls.get("fair-100")).toBe(2);
  await fair.intakes.close();expect(await fair.transport.recoverPendingGenerations()).toBe(0);
 }finally{await native?.end();await admin?.end();await docker(["rm","-f",name]).catch(()=>undefined);}
},120_000);
