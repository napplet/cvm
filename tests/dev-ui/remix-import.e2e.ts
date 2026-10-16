/** Real SQL and offline Docker import; no model or public network requests. */
import { developmentStack,createDevelopmentPool } from "../../scripts/dev-payments";
import { LocalDevelopmentRuntimeReadiness } from "../../src/dev/development-runtime-readiness";
import { LocalRemixSourceImporter } from "../../src/dev/remix-source-import";
import { DevelopmentRemixImports } from "../../src/dev/remix-imports";
import { accountIdForPrincipal } from "../../src/domain/account-command";
import { finalizeEvent,generateSecretKey } from "nostr-tools/pure";
import { remixManifest } from "../../src/remix/manifest";
const assert=(value:unknown,code:string)=>{if(!value)throw new Error(code);};
async function archive(files:{name:string;content?:string;link?:string}[]){
 const p=Bun.spawn(["python3","-c",`import io,json,tarfile,sys
out=io.BytesIO()
with tarfile.open(fileobj=out,mode='w:gz') as t:
 for f in json.load(sys.stdin):
  member=tarfile.TarInfo(f['name'])
  if 'link' in f:
   member.type=tarfile.SYMTYPE; member.linkname=f['link']; t.addfile(member)
  else:
   data=f.get('content','').encode(); member.size=len(data); t.addfile(member,io.BytesIO(data))
sys.stdout.buffer.write(out.getvalue())`],{stdin:new Blob([JSON.stringify(files)]),stdout:"pipe",stderr:"pipe"});
 const bytes=new Uint8Array(await new Response(p.stdout).arrayBuffer()); if(await p.exited)throw new Error("ARCHIVE_FIXTURE_FAILED");return bytes;
}
const stack=developmentStack(true);const config=await stack.up();const pool=createDevelopmentPool(config.databaseUrl);
try{
 const ready=await new LocalDevelopmentRuntimeReadiness().assertReady();const worker=new LocalRemixSourceImporter(ready.imageDigest);
 const snapshot=await archive([{name:"repo/src/main.ts",content:"// harmless source\nexport const count=1;"},{name:"repo/package.json",content:'{"scripts":{"postinstall":"touch /host/pwned"}}'},{name:"repo/src/private.ts",link:"/etc/passwd"},{name:"repo/node_modules/hidden.ts",content:"hidden"}]);
 const imported=await worker.readArchive(snapshot);assert(imported.files.length===1&&imported.files[0]!.path==="src/main.ts","UNSAFE_SOURCE_FILES_IMPORTED");
 let rejected=false;try{await worker.readArchive(await archive([{name:"repo/../../escape.ts",content:"escape"}]))}catch{rejected=true;}assert(rejected,"TRAVERSAL_NOT_REJECTED");
 const key=generateSecretKey();const html="<!doctype html><title>Starting counter</title>";const hash=new Bun.CryptoHasher("sha256").update(html).digest("hex");
 const make=(source?:string)=>finalizeEvent({kind:35129,created_at:Math.floor(Date.now()/1000),content:"Starting counter",tags:[["d",crypto.randomUUID()],["x",hash],...(source?[["source",source]]:[])]},key);
 const service=new DevelopmentRemixImports(pool,{import:async source=>source.includes("supported")?{...imported,commit:"c".repeat(40),archiveSha256:"d".repeat(64)}:undefined});
 const event=make(); const owner=event.pubkey;const account=await accountIdForPrincipal({pubkey:owner});
 await service.prepare({action:"asset_part",eventId:event.id,artifactHash:hash,index:0,total:1,data:Buffer.from(html).toString("base64")},owner);
 const input={naddr:remixManifest(event).naddr,event,assetUploaded:true};const result=await service.prepare(input,owner) as any;
 assert(result.basis==="html"&&result.status==="ready","HTML_FALLBACK_MISSING");assert((await service.prepare(input,owner) as any).reference===result.reference,"IMPORT_REPLAY_CHANGED");
 assert((await service.load(account,result.reference))?.basis.kind==="html","OWNER_SOURCE_MISSING");assert(await service.load("foreign-account",result.reference)===undefined,"FOREIGN_REFERENCE_LEAKED");
 let foreignRejected=false;try{await service.prepare(input,"f".repeat(64))}catch{foreignRejected=true;}assert(foreignRejected,"FOREIGN_PARTS_ACCEPTED");
 const sourceEvent=make("https://github.com/example/supported");const sourceResult=await service.prepare({event:sourceEvent,naddr:remixManifest(sourceEvent).naddr},owner) as any;
 assert(sourceResult.basis==="source"&&sourceResult.commit==="c".repeat(40),"SOURCE_NOT_PREFERRED");
 const bad=make();await service.prepare({action:"asset_part",eventId:bad.id,artifactHash:hash,index:0,total:1,data:Buffer.from("tampered").toString("base64")},owner);
 let invalid=false;try{await service.prepare({event:bad,naddr:remixManifest(bad).naddr,assetUploaded:true},owner)}catch{invalid=true;}assert(invalid,"UNVERIFIED_HTML_ACCEPTED");
 console.log(JSON.stringify({status:"passed",checks:["real offline Docker source import","traversal rejection","symlink and dependency exclusion","SQL owner isolation","immutable replay","source preference","verified HTML fallback","tampered blob rejection"]}));
}finally{await pool.end();await stack.down(true);}
