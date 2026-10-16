/** Signed NIP-07 requests → real CVM/SQL/worker → fresh browser and service restart. */
import { chromium, type Page } from "playwright";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { finalizeEvent, generateSecretKey, getPublicKey } from "nostr-tools/pure";
import { nip44 } from "nostr-tools";
import { developmentStack, createDevelopmentPool } from "../../scripts/dev-payments";
import { createDevelopmentContextVmServer } from "../../src/dev-ui/contextvm-server";
import { DevelopmentContextVmClient } from "../../src/dev-ui/browser/contextvm-client";
import { openFixtureAdmin } from "./operator-fixture";
import { chatGptFixture } from "../fixtures/chatgpt";
const assert = (value: unknown, code: string) => { if (!value) throw new Error(code); };
const fixture = chatGptFixture(); fixture.setSparseCompletion(true);
let release!: () => void; const gate = new Promise<void>(resolve => { release = resolve; });
const modelFetch: typeof fixture.fetch = async (url, init) => {
  const response = await fixture.fetch(url, init); if (!String(url).endsWith("/responses")) return response;
  const reader = response.body!.getReader();
  return new Response(new ReadableStream({ async start(controller) { try { const first = await reader.read(); if (first.value) controller.enqueue(first.value); await gate; for (;;) { const part = await reader.read(); if (part.done) break; controller.enqueue(part.value); } controller.close(); } catch (error) { controller.error(error); } } }), { headers: response.headers });
};
const stack = developmentStack(true); const config = await stack.up(); const root = await mkdtemp(join(tmpdir(),"returning-projects-"));
let server = await createDevelopmentContextVmServer({ config, stateRoot:root, chatGptFetch:modelFetch });
const bootstrap = { ...await (await fetch(`${server.url}/cvm.json`)).json(), reserveSat:"3750",actionCeilingSat:"3750",providerLabel:"test" };
const key = generateSecretKey(); const pubkey = getPublicKey(key); const otherKey = generateSecretKey();
const owner = new DevelopmentContextVmClient(bootstrap,undefined,Buffer.from(key).toString("hex"));
const other = new DevelopmentContextVmClient(bootstrap,undefined,Buffer.from(otherKey).toString("hex"));
const browser = await chromium.launch(); const context = await browser.newContext(); const page = await context.newPage(); const admin = await context.newPage();
const pool = createDevelopmentPool(config.databaseUrl); const errors: string[] = [];
async function signer(page: Page, signingKey: Uint8Array) {
  await page.exposeFunction("projectPublicKey",()=>getPublicKey(signingKey));
  await page.exposeFunction("projectSign",(template:any)=>finalizeEvent(template,signingKey));
  await page.exposeFunction("projectDecrypt",(peer:string, ciphertext:string)=>nip44.v2.decrypt(ciphertext,nip44.v2.utils.getConversationKey(signingKey,peer)));
  await page.exposeFunction("projectEncrypt",(peer:string, plaintext:string)=>nip44.v2.encrypt(plaintext,nip44.v2.utils.getConversationKey(signingKey,peer)));
  await page.addInitScript(() => { (window as any).nostr = { getPublicKey:()=> (window as any).projectPublicKey(),signEvent:(event:any)=>(window as any).projectSign(event),nip44:{ decrypt:(peer:string,text:string)=>(window as any).projectDecrypt(peer,text),encrypt:(peer:string,text:string)=>(window as any).projectEncrypt(peer,text) } }; });
  page.on("pageerror", error => errors.push(error.message));
}
async function signIn(page: Page) { await page.locator("#nostr-sign-in").click(); await page.locator("#nostr-extension").click(); await page.locator("#nostr-sign-in").filter({ hasText:"NIP-07" }).waitFor(); }
try {
  await openFixtureAdmin(admin,server.url,root,fixture);
  await signer(page,key); await page.goto(server.url); await page.getByText("Workspace connected",{exact:true}).waitFor(); await signIn(page);
  await page.locator("#idea").fill("A simple counter for reading sessions"); await page.locator("#idea-next").click(); await page.locator("#generate").click();
  await page.locator('#activity-events [data-stage="model_stream"]').waitFor({ state:"attached",timeout:30000 });
  await owner.connect({accountStatus:false}); await other.connect({accountStatus:false});
  const active = await owner.callTool("projects",{action:"list",stage:"active"});
  assert(active.projects.length === 1,"SIGNED_USER_ACTIVE_PROJECT_MISSING"); const id=active.projects[0].id;
  assert((await other.callTool("projects",{action:"list"})).projects.length===0,"OTHER_USER_LIST_LEAK");
  assert((await other.sessionStatus(id)).status==="not_found_or_denied","OTHER_USER_SESSION_LEAK");
  const pending = await other.savePreAdmission({ maximum:"4000",idea:"An unrelated private idea",idempotencyKey:crypto.randomUUID() });
  assert((await other.callTool("projects",{action:"list"})).projects[0].checkpointId===pending.checkpointId,"OTHER_PENDING_MISSING");
  assert((await owner.callTool("projects",{action:"get",id:pending.checkpointId})).status==="not_found_or_denied","OTHER_PENDING_LEAK");
  release(); await page.waitForFunction(()=>document.querySelector("#build-progress")?.getAttribute("aria-valuenow")==="5",undefined,{timeout:180000});
  const ready=await owner.callTool("projects",{action:"get",id}); assert(ready.project.stage==="verified" && ready.project.verifiedVersion===1,"VERIFIED_STAGE_MISSING");
  await owner.callTool("projects",{action:"rename",id,title:"Reading counter"});
  const row=(await pool.query("SELECT owner_pubkey FROM development_projects WHERE id=$1",[id])).rows[0]; assert(row.owner_pubkey===pubkey,"PROJECT_OWNER_NOT_REQUEST_SIGNER");
  const artifact=(await owner.sessionStatus(id)).session.latestVerifiedArtifact.id;
  assert((await other.preview({sessionId:id,artifactId:artifact})).status!=="ready","CROSS_OWNER_PREVIEW");
  await owner.close(); await other.close(); await context.close();
  const port=Number(new URL(server.url).port); await server.close(); server=await createDevelopmentContextVmServer({config,stateRoot:root,port,chatGptFetch:modelFetch});
  const fresh=await browser.newContext(); const returning=await fresh.newPage(); await signer(returning,key); await returning.goto(server.url); await returning.getByText("Workspace connected",{exact:true}).waitFor();
  assert(await returning.locator("#your-applets").isDisabled(),"LIST_BEFORE_IDENTITY");
  await signIn(returning); await returning.locator("#your-applets").click(); await returning.getByRole("button",{name:/Reading counter/}).waitFor();
  assert(await returning.locator("#projects-list li").count()===1,"RETURNING_LIST_LEAK");
  await returning.getByRole("button",{name:/Reading counter/}).click(); await returning.locator("#preview").waitFor({state:"visible",timeout:30000});
  assert(await returning.locator("#publish").isEnabled(),"RETURNING_PUBLISH_UNAVAILABLE");
  assert(fixture.counts().inferences===1,"LIST_OR_OPEN_STARTED_GENERATION");
  await returning.locator("#nostr-sign-in").click(); await returning.locator("#nostr-sign-out").click(); await returning.locator("#nostr-close").click();
  assert(await returning.locator("#your-applets").isDisabled() && await returning.locator("#projects-list li").count()===0,"SIGN_OUT_LEFT_PROJECT_LIST");
  assert(errors.length===0,`BROWSER_ERRORS:${errors.join(";")}`);
  console.log(JSON.stringify({status:"passed",case:"returning-projects",checks:["actual selected identity signs generation","active/pending/verified stages","cross-owner list/get/preview denial","same npub from fresh browser after CVM restart","open without inference","signout clears list"]}));
} catch(error) { console.error(error, await page.locator("body").innerText({timeout:1000}).catch(()=>"original page closed")); throw error; }
finally { release(); await owner.close(); await other.close(); await browser.close(); await pool.end(); await server.close(); await stack.down(true); await rm(root,{recursive:true,force:true}); }
