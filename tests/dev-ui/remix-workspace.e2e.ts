/** Static browser -> applesauce outboxes -> signed CVM -> real worker/Paja. Model transport is a fixture. */
import { chromium } from "playwright";
import { openFixtureAdmin } from "./operator-fixture";
import { mkdtemp,rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { finalizeEvent,generateSecretKey,getPublicKey } from "nostr-tools/pure";
import { nip44 } from "nostr-tools";
import { SimplePool } from "nostr-tools/pool";
import { matchFilters } from "nostr-tools/filter";
import { developmentStack,createDevelopmentPool } from "../../scripts/dev-payments";
import { createDevelopmentContextVmServer } from "../../src/dev-ui/contextvm-server";
import { remixManifest } from "../../src/remix/manifest";
import { chatGptFixture } from "../fixtures/chatgpt";
const assert=(x:unknown,c:string)=>{if(!x)throw new Error(c);};
const stack=developmentStack(true);const config=await stack.up();const stateRoot=await mkdtemp(join(tmpdir(),"remix-workspace-"));const fixture=chatGptFixture();
const server=await createDevelopmentContextVmServer({config,stateRoot,chatGptFetch:fixture.fetch});const pool=createDevelopmentPool(config.databaseUrl);
const browser=await chromium.launch();const page=await browser.newPage({viewport:{width:1280,height:900}});const relay=new SimplePool();
const key=generateSecretKey(),other=generateSecretKey();const pubkey=getPublicKey(key);const now=Math.floor(Date.now()/1000);const errors:string[]=[];page.on("pageerror",error=>errors.push(error.message));
const html="<!doctype html><title>Remix origin</title><p>A starting counter</p>"+" ".repeat(20000);const hash=new Bun.CryptoHasher("sha256").update(html).digest("hex");
const blob=Bun.serve({hostname:"127.0.0.1",port:0,fetch:()=>new Response(html,{headers:{"access-control-allow-origin":"*"}})});
const sign=(kind:number,tags:string[][],secret=key,content="")=>finalizeEvent({kind,tags,content,created_at:now},secret);
const event=sign(35129,[["d","remix-origin"],["title","Original counter"],["x",hash],["server",`http://127.0.0.1:${blob.port}`],["source","https://unsupported.example/repository"]],key,"A starting counter");
const friend=sign(35129,[["d","friend"],["title","Friend’s applet"],["x",hash]],other,"A friend’s public applet");
const directories=[sign(10002,[["r",config.relayUrl,"write"]]),sign(10002,[["r",config.relayUrl,"write"]],other)];
async function ready(version:number){
 try{await page.waitForFunction(n=>document.querySelector("#version-picker option:checked")?.textContent===`Version ${n} · current`,version,{timeout:180000});}
 catch(error){
  const state=await page.evaluate(()=>Object.fromEntries(["version-picker","progress-title","progress-detail","notice-copy"].map(id=>[id,document.getElementById(id)?.textContent?.slice(0,240)??""])));
  console.error(JSON.stringify({test:"remix-workspace",expectedVersion:version,state,inferences:fixture.counts().inferences}));
  throw error;
 }
}
try{
 await Promise.all([event,friend,sign(3,[["p",getPublicKey(other)]])].map(e=>Promise.all(relay.publish([config.relayUrl],e))));
 // Only purplepag.es directory is controlled; author events use the real relay.
 await page.routeWebSocket("wss://purplepag.es/",ws=>{ws.onMessage(message=>{const [type,id,...filters]=JSON.parse(String(message));if(type!=="REQ")return;for(const e of directories.filter(e=>matchFilters(filters,e)))ws.send(JSON.stringify(["EVENT",id,e]));ws.send(JSON.stringify(["EOSE",id]));});});
 await page.exposeFunction("remixPubkey",()=>pubkey);await page.exposeFunction("remixSign",(template:any)=>finalizeEvent(template,key));
 await page.exposeFunction("remixEncrypt",(peer:string,text:string)=>nip44.v2.encrypt(text,nip44.v2.utils.getConversationKey(key,peer)));
 await page.exposeFunction("remixDecrypt",(peer:string,text:string)=>nip44.v2.decrypt(text,nip44.v2.utils.getConversationKey(key,peer)));
 await page.addInitScript(()=>{const w=window as any;w.nostr={getPublicKey:w.remixPubkey,signEvent:w.remixSign,nip44:{encrypt:w.remixEncrypt,decrypt:w.remixDecrypt}};});
 const admin=await browser.newPage();await openFixtureAdmin(admin,server.url,stateRoot,fixture);
 await page.goto(server.url);await page.getByText("Workspace connected",{exact:true}).waitFor();
 await page.locator("#remix-mode").click();await page.locator("#remix-address").fill("npub-invalid");await page.locator("#idea").fill("Add a reset button to this counter");await page.locator("#idea-next").click();
 assert(await page.locator("#idea-step").isVisible()&&await page.locator("#remix-address").getAttribute("aria-invalid")==="true","INVALID_ADDRESS_ADVANCED");
 await page.locator("#remix-address").fill(remixManifest(event).naddr);
 await page.waitForFunction(()=>document.querySelector("#remix-status")?.textContent?.includes("File verified"),undefined,{timeout:30000});
 assert(fixture.counts().inferences===0,"RESOLUTION_STARTED_GENERATION");
 for(const width of [280,320,390,768,1280]){await page.setViewportSize({width,height:740});assert(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth),`REMIX_OVERFLOW_${width}`);}
 await page.locator("#nostr-sign-in").click();await page.locator("#nostr-extension").click();await page.locator("#nostr-identity").waitFor({state:"hidden"});
 await page.locator("#browse-applets").click();await page.getByRole("heading",{name:"Original counter",exact:true}).waitFor({timeout:30000});
 await page.locator("#explore-network").click();await page.getByRole("heading",{name:"Friend’s applet",exact:true}).waitFor({timeout:30000});
 assert(await page.getByRole("heading",{name:"Original counter",exact:true}).count()===0,"NETWORK_INCLUDES_UNFOLLOWED_SELF");
 for(const width of [280,320,768,1280]){await page.setViewportSize({width,height:740});assert(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth),`EXPLORE_OVERFLOW_${width}`);}
 await page.locator("#workspace-home").click();await page.locator("#idea-next").click();await page.locator("#setup-step").waitFor();await page.locator("#generate").click();
 await ready(1);
 assert(fixture.counts().inferences===1,"REMIX_DUPLICATED_INFERENCE");
 const request=JSON.parse(String(fixture.calls.find(call=>call.url.endsWith("/responses"))!.init!.body));const context=JSON.parse(request.input[1].content).remixReferenceData;
 assert(context?.basis.kind==="html"&&context.basis.html===html&&context.origin.eventId===event.id,"REMIX_NOT_SENT_TO_MODEL");
 const imports=(await pool.query("SELECT count(*) AS count FROM development_remix_imports")).rows[0];assert(imports.count==="1","IMPORT_NOT_DURABLE");
 await server.assertGenerationSettlement();
 await page.locator("#revision").fill("Use a quieter heading");await page.locator("#revise").click();await ready(2);
 assert(fixture.counts().inferences===2,"REVISION_DID_NOT_RUN_ONCE");
 const next=JSON.parse(String(fixture.calls.filter(call=>call.url.endsWith("/responses"))[1]!.init!.body));assert(JSON.parse(next.input[1].content).authorizedPriorSource&&!JSON.parse(next.input[1].content).remixReferenceData,"REVISION_DID_NOT_USE_VERIFIED_SOURCE");
 assert(errors.length===0,`BROWSER_ERRORS:${errors.join("|")}`);
 console.log(JSON.stringify({status:"passed",checks:["live naddr validation","signed outbox discovery","direct-follow browsing","responsive 280–1280","encrypted multipart CVM import","fixture model receives verified origin","real Docker build and Paja preview","revision uses verified prior source"],inferences:fixture.counts().inferences}));
}finally{await browser.close();relay.destroy();blob.stop(true);await pool.end();await server.close();await stack.down(true);await rm(stateRoot,{recursive:true,force:true});}
