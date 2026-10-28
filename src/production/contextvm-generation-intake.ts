import { z } from "zod";
import { canonicalJson } from "../promotion/schema";
import { StartSessionArgumentsSchema, ReviseSessionArgumentsSchema } from "../contextvm/adapter";
import type { ContextVmInboundEnvelope, ContextVmWireResponse } from "../contextvm/sdk-bridge";
import { PostgresOperationJournal, assertPostgresOperationJournal, type OperationRecord } from "../release/deployment/postgres-operation-journal";
const version = "protected-contextvm-generation-intake-v1";
const Digest = z.string().regex(/^[a-f0-9]{64}$/u);
const Id = z.string().min(1).max(256);
const Header = z.object({ originalOperationId: Id, originalIdentitySha256: Digest, ownerPubkey: Digest, executionContextSha256: Digest, payloadSha256: Digest, keyReference: Id, retentionUntilMs: z.number().int().positive() }).strict();
const Envelope = z.object({ verifiedClientPubkey: Digest, requestEventId: Id, rawEvent: z.object({ id: Id, tags: z.array(z.array(z.string())) }).strict(), request: z.object({ id: z.union([z.string(),z.number(),z.null()]), method: z.literal("tools/call"), params: z.unknown() }).strict() }).strict();
const Pending = z.object({ schemaVersion:z.literal(version), state:z.literal("pending"), header:Header, nonceBase64:z.string(), wrapNonceBase64:z.string(), wrappedDekBase64:z.string(), ciphertextBase64:z.string(), claimToken:z.string().nullable(), claimUntilMs:z.number().int().nonnegative(), nextAttemptAtMs:z.number().int().positive() }).strict();
type PendingIntake = z.infer<typeof Pending>;
const Response = z.object({jsonrpc:z.literal("2.0"),id:z.union([z.string(),z.number(),z.null()]),result:z.unknown().optional(),error:z.object({code:z.number(),message:z.string()}).strict().optional()}).strict();
const OriginalSchema = z.discriminatedUnion("state",[z.object({state:z.literal("pending")}).strict(),z.object({state:z.literal("completed"),response:Response}).strict()]);
type Original = {state:"pending"}|{state:"completed";response:ContextVmWireResponse};
const canonicalBytes = (v:unknown)=>new TextEncoder().encode(canonicalJson(v));
const hash = async(v:unknown)=>Buffer.from(await crypto.subtle.digest("SHA-256",canonicalBytes(v))).toString("hex");
const bytes = (v:string)=>new Uint8Array(Buffer.from(v,"base64"));
const b64 = (v:ArrayBuffer|Uint8Array)=>Buffer.from(v instanceof Uint8Array?v:new Uint8Array(v)).toString("base64");
function eligible(envelope:ContextVmInboundEnvelope):boolean {
  if(envelope.request.method!=="tools/call")return false;
  const call=z.object({name:z.string(),arguments:z.unknown()}).passthrough().safeParse(envelope.request.params);
  if(!call.success)return false;
  if(call.data.name==="start_session") { const args=StartSessionArgumentsSchema.safeParse(call.data.arguments);return args.success&&"admissionReference" in args.data; }
  return call.data.name==="revise_session"&&ReviseSessionArgumentsSchema.safeParse(call.data.arguments).success;
}
const instances=new WeakSet<object>();
export function assertProductionContextVmGenerationIntakes(value:unknown,journal:PostgresOperationJournal):asserts value is ProductionContextVmGenerationIntakes {
  if(!value||typeof value!=="object"||!instances.has(value)||!(value instanceof ProductionContextVmGenerationIntakes)||!value.matchesJournal(journal))throw new Error("CONTEXTVM_INTAKE_JOURNAL_REQUIRED");
}
/** Protect only SDK-verified funded generation intake. Initial handling remains
 * immediate; discovery recovers interrupted originals under their exact context. */
export class ProductionContextVmGenerationIntakes {
  readonly #owner=crypto.randomUUID();
  #stopped=false;
  #scan:Promise<number>|undefined;
  readonly #running=new Set<Promise<void>>();
  constructor(private readonly input:Readonly<{journal:PostgresOperationJournal;executionContextSha256:string;key:Readonly<{reference:string;load():Promise<CryptoKey>}>;now?:()=>number}>) { assertPostgresOperationJournal(input.journal);Digest.parse(input.executionContextSha256);instances.add(this); }
  matchesJournal(journal:PostgresOperationJournal){return journal===this.input.journal;}
  #now(){return (this.input.now??Date.now)();}
  async claim(envelope:ContextVmInboundEnvelope,identitySha256:string):Promise<Readonly<{claimed:boolean;record:OperationRecord<Original>;companion?:OperationRecord<PendingIntake>}>> {
    if(!eligible(envelope))return this.input.journal.claim<Original>(envelope.requestEventId,identitySha256,{state:"pending"});
    if(this.#stopped)throw new Error("CONTEXTVM_INTAKE_STOPPED");
    const original=await this.input.journal.read<Original>(envelope.requestEventId);
    if(original){OriginalSchema.parse(original.value);if(original.identitySha256!==identitySha256)throw new Error("OPERATION_IDENTITY_CONFLICT");return {claimed:false,record:original};}
    const value=await this.#protect(envelope,identitySha256);
    return this.input.journal.claimWithCompanion<Original,PendingIntake>({operationId:envelope.requestEventId,identitySha256,value:{state:"pending"},companion:{operationId:`contextvm-intake:${envelope.requestEventId}`,identitySha256:await this.#identity(value),value}});
  }
  async run(record:OperationRecord<unknown>,process:(envelope:ContextVmInboundEnvelope,original:OperationRecord<Original>)=>Promise<void>):Promise<void> {
    const run=this.#run(record,process).finally(()=>this.#running.delete(run));this.#running.add(run);return run;
  }
  async #run(record:OperationRecord<unknown>,process:(envelope:ContextVmInboundEnvelope,original:OperationRecord<Original>)=>Promise<void>) {
    const value=Pending.parse(record.value);
    if(record.operationId!==`contextvm-intake:${value.header.originalOperationId}`||record.identitySha256!==await this.#identity(value)||value.claimToken!==this.#owner)throw new Error("CONTEXTVM_INTAKE_LEASE_DENIED");
    let renewal:Promise<void>|undefined;
    const timer=setInterval(()=>{if(renewal)return;renewal=this.#renew(record.operationId).catch(()=>undefined).finally(()=>{renewal=undefined;});},20_000);timer.unref?.();
    try {
      const original=await this.input.journal.read<Original>(value.header.originalOperationId);
      if(!original||original.identitySha256!==value.header.originalIdentitySha256)throw new Error("CONTEXTVM_INTAKE_ORIGINAL_DENIED");
      OriginalSchema.parse(original.value);
      if(original.value.state==="completed")return;
      if(this.#stopped) return;
      const envelope=await this.#open(value);
      await process(envelope,original);
    } finally {
      clearInterval(timer);await renewal;
      await this.#release(record.operationId);
    }
  }
  scan(process:(envelope:ContextVmInboundEnvelope,original:OperationRecord<Original>)=>Promise<void>):Promise<number> {
    if(this.#stopped)return Promise.resolve(0);
    if(this.#scan)return this.#scan;
    const run=this.#scanOnce(process).finally(()=>{this.#scan=undefined;});this.#scan=run;return run;
  }
  async #scanOnce(process:(envelope:ContextVmInboundEnvelope,original:OperationRecord<Original>)=>Promise<void>) {
    const records=await this.input.journal.listDueCompanions<unknown>({schemaVersion:version,nowMs:this.#now()});let attempted=0;
    for(const record of records){
      if(this.#stopped)break;
      const parsed=Pending.safeParse(record.value);if(!parsed.success)continue;
      const v=parsed.data;
      if(record.operationId!==`contextvm-intake:${v.header.originalOperationId}`||record.identitySha256!==await this.#identity(v))continue;
      if(v.header.retentionUntilMs<=this.#now()){await this.#erase(record,v);continue;}
      if(v.claimUntilMs>this.#now())continue;
      const until=this.#now()+60_000;
      const claimed=await this.input.journal.compareAndSet(record.operationId,record.identitySha256,record.revision,{...v,claimToken:this.#owner,claimUntilMs:until,nextAttemptAtMs:Math.min(until,v.header.retentionUntilMs)});
      if(!claimed)continue;
      attempted++;
      try{await this.run(claimed,process);}catch{/* Preserve unresolved originals; never synthesize policy or provider results. */}
    }
    return attempted;
  }
  async #renew(operationId:string){
    const record=await this.input.journal.read<unknown>(operationId);if(!record)return;
    const value=Pending.parse(record.value);if(value.claimToken!==this.#owner)return;
    const until=this.#now()+60_000;
    await this.input.journal.compareAndSet(operationId,record.identitySha256,record.revision,{...value,claimUntilMs:until,nextAttemptAtMs:Math.min(until,value.header.retentionUntilMs)});
  }
  async #release(operationId:string){
    const record=await this.input.journal.read<unknown>(operationId);if(!record)return;
    const parsed=Pending.safeParse(record.value);if(!parsed.success)return;const v=parsed.data;
    const original=await this.input.journal.read<Original>(v.header.originalOperationId);
    if(original?.identitySha256!==v.header.originalIdentitySha256)throw new Error("CONTEXTVM_INTAKE_ORIGINAL_DENIED");
    OriginalSchema.parse(original.value);
    if(original.value.state==="completed"||v.header.retentionUntilMs<=this.#now()){await this.#erase(record,v);return;}
    if(v.claimToken!==this.#owner)return;
    await this.input.journal.compareAndSet(operationId,record.identitySha256,record.revision,{...v,claimToken:null,claimUntilMs:0,nextAttemptAtMs:this.#now()+30_000});
  }
  async #erase(record:OperationRecord<unknown>,value:PendingIntake){
    await this.input.journal.compareAndSet(record.operationId,record.identitySha256,record.revision,{schemaVersion:version,state:"erased",header:value.header,erasedAtMs:this.#now()});
  }
  #identity(value:PendingIntake){return hash({schemaVersion:version,originalOperationId:value.header.originalOperationId,originalIdentitySha256:value.header.originalIdentitySha256});}
  async #protect(raw:ContextVmInboundEnvelope,identitySha256:string):Promise<PendingIntake>{
    const envelope=Envelope.parse(raw);
    if(envelope.rawEvent.id!==envelope.requestEventId)throw new Error("CONTEXTVM_INTAKE_EVENT_DENIED");
    const plaintext=canonicalBytes(envelope);
    if(plaintext.length>131072){plaintext.fill(0);throw new Error("CONTEXTVM_INTAKE_TOO_LARGE");}
    const header=Header.parse({originalOperationId:envelope.requestEventId,originalIdentitySha256:identitySha256,ownerPubkey:envelope.verifiedClientPubkey,executionContextSha256:this.input.executionContextSha256,payloadSha256:await hash(envelope),keyReference:this.input.key.reference,retentionUntilMs:this.#now()+30*86_400_000});
    const aad=canonicalBytes({schemaVersion:version,header}),nonce=crypto.getRandomValues(new Uint8Array(12)),wrapNonce=crypto.getRandomValues(new Uint8Array(12)),rawDek=crypto.getRandomValues(new Uint8Array(32));
    try{
      const dek=await crypto.subtle.importKey("raw",rawDek,"AES-GCM",false,["encrypt"]);
      const ciphertext=await crypto.subtle.encrypt({name:"AES-GCM",iv:nonce,additionalData:aad},dek,plaintext);
      const wrapped=await crypto.subtle.encrypt({name:"AES-GCM",iv:wrapNonce,additionalData:aad},await this.input.key.load(),rawDek);
      const until=this.#now()+60_000;
      return Pending.parse({schemaVersion:version,state:"pending",header,nonceBase64:b64(nonce),wrapNonceBase64:b64(wrapNonce),wrappedDekBase64:b64(wrapped),ciphertextBase64:b64(ciphertext),claimToken:this.#owner,claimUntilMs:until,nextAttemptAtMs:until});
    }finally{rawDek.fill(0);plaintext.fill(0);}
  }
  async #open(value:PendingIntake):Promise<ContextVmInboundEnvelope>{
    try{
      const h=value.header;
      if(h.retentionUntilMs<=this.#now()||h.executionContextSha256!==this.input.executionContextSha256||h.keyReference!==this.input.key.reference)throw new Error();
      const aad=canonicalBytes({schemaVersion:version,header:h}),nonce=bytes(value.nonceBase64),wrapNonce=bytes(value.wrapNonceBase64);
      if(nonce.length!==12||wrapNonce.length!==12)throw new Error();
      const rawDek=new Uint8Array(await crypto.subtle.decrypt({name:"AES-GCM",iv:wrapNonce,additionalData:aad},await this.input.key.load(),bytes(value.wrappedDekBase64)));
      try{
        if(rawDek.length!==32)throw new Error();
        const dek=await crypto.subtle.importKey("raw",rawDek,"AES-GCM",false,["decrypt"]);
        const plaintext=new Uint8Array(await crypto.subtle.decrypt({name:"AES-GCM",iv:nonce,additionalData:aad},dek,bytes(value.ciphertextBase64)));
        try{
          if(plaintext.length>131072)throw new Error();
          const envelope=Envelope.parse(JSON.parse(new TextDecoder("utf-8",{fatal:true}).decode(plaintext)));
          if(envelope.requestEventId!==h.originalOperationId||envelope.rawEvent.id!==h.originalOperationId||envelope.verifiedClientPubkey!==h.ownerPubkey||await hash(envelope)!==h.payloadSha256||!eligible(envelope))throw new Error();
          return envelope;
        }finally{plaintext.fill(0);}
      }finally{rawDek.fill(0);}
    }catch{throw new Error("CONTEXTVM_INTAKE_RESTORE_DENIED");}
  }
  async close(){this.#stopped=true;await this.#scan;await Promise.allSettled([...this.#running]);}
}
