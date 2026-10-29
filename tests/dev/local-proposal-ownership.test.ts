import {expect,test} from "bun:test";
import {LocalProposalWorkerPort} from "../../src/dev/local-generation-adapters";
import {LocalNappletWorker,type WorkerOutput} from "../../src/dev/local-napplet-worker";
import {DurableWorkerResultStore} from "../../src/dev/durable-worker-result-store";
import {WorkerRunRequestSchema,type WorkerRunRequest} from "../../src/phase-02/contracts";

test("local proposal materialization retains its exact owned request across a deferred result claim",async()=>{
 let release!:()=>void,entered!:()=>void;
 const gate=new Promise<void>(resolve=>{release=resolve;}),waiting=new Promise<void>(resolve=>{entered=resolve;});
 class DeferredResults extends DurableWorkerResultStore {
  constructor(){super({pool:{async query(){throw new Error("FIXTURE_SQL_MUST_NOT_RUN");}},toolchainSha256:"d".repeat(64)});}
  override async materialize(_request:WorkerRunRequest,run:()=>Promise<WorkerOutput>,signal?:AbortSignal):Promise<WorkerOutput>{entered();await gate;signal?.throwIfAborted();return run();}
 }
 class FixtureWorker extends LocalNappletWorker {
  observed:Parameters<LocalNappletWorker["materialize"]>[0]|undefined;
  override async materialize(proposal:Parameters<LocalNappletWorker["materialize"]>[0]):Promise<WorkerOutput>{this.observed=structuredClone(proposal);return {distRoot:"/fixture/unverified-output",toolchainSha256:"d".repeat(64),commandEvidence:[],async cleanup(){}};}
 }
 const worker=new FixtureWorker(),port=new LocalProposalWorkerPort(worker,{results:new DeferredResults()});
 const request=WorkerRunRequestSchema.parse({sessionId:"session:original",actionId:"action:original",expectedVersion:0,policyVersion:"fixture-policy",capabilityGrant:"fixture-grant",workspaceId:"workspace:original",sourceProposalReference:`proposal:sha256:${"a".repeat(64)}`,sourceProposalSha256:"a".repeat(64),sourceProposalFiles:[{path:"src/main.ts",content:"export const original = true;"}]});
 const original=structuredClone(request);
 const {sourceProposalReference,sourceProposalSha256,sourceProposalFiles}=original;
 if(!sourceProposalReference||!sourceProposalSha256||!sourceProposalFiles)throw new Error("FIXTURE_SOURCE_REQUIRED");
 const pending=port.run(request,new AbortController().signal);
 try{
  await waiting;
  request.sessionId="session:changed";request.workspaceId="workspace:changed";request.sourceProposalReference=`proposal:sha256:${"b".repeat(64)}`;request.sourceProposalSha256="b".repeat(64);
  if(!request.sourceProposalFiles?.[0])throw new Error("FIXTURE_SOURCE_REQUIRED");request.sourceProposalFiles[0].content="export const changed = true;";
  release();
  expect(await pending).toMatchObject({status:"completed",artifact:{sessionId:original.sessionId,workspaceId:original.workspaceId}});
  expect(worker.observed).toEqual({proposalSha256:sourceProposalSha256,proposal:{reference:sourceProposalReference,sha256:sourceProposalSha256,files:sourceProposalFiles}});
  expect(port.take(original)?.request).toEqual(original);
  expect(port.take(request)).toBeUndefined();
  await expect(port.run({...original,sourceProposalFiles:[{path:"src/main.ts",content:"changed replay"}]},new AbortController().signal)).rejects.toThrow("WORKER_ACTION_PROPOSAL_MISMATCH");
 }finally{release();await pending.catch(()=>undefined);}
});
