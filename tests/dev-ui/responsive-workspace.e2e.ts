/** Real public view components with read-only transport fixtures. Full service effects
 * are exercised by the product, returning-projects and publication journeys. */
import { chromium } from "playwright";
import { resolve } from "node:path";
import { mkdir } from "node:fs/promises";

const modules = ["product-workspace", "activity", "publication-workspace", "projects-workspace"];
const built = await Bun.build({ entrypoints: modules.map(name => resolve(`src/dev-ui/browser/${name}.ts`)), target: "browser", format: "esm", plugins: [{ name: "responsive-read-only-fixture", setup(builder) {
  builder.onLoad({ filter: /\/contextvm-client\.ts$/ }, () => ({ loader: "js", contents: `
    export const browserSignerKey = () => "1".repeat(64);
    export class DevelopmentContextVmClient {
      async connect() { return {}; }
      async close() {}
      async callTool(name, input) {
        if (name !== "projects" || input.action !== "list") throw new Error("Unexpected transport effect");
        if (window.fixtureProjectsError) throw new Error(window.fixtureProjectsError);
        return { status: "ok", projects: window.fixtureProjects ?? [] };
      }
    }` }));
  builder.onResolve({ filter: /^pino$/ }, () => ({ path: resolve("src/dev-ui/browser/pino-browser-shim.ts") }));
} }] });
if (!built.success) throw new Error(built.logs.map(log => log.message).join(";"));
const scripts = Object.fromEntries(await Promise.all(built.outputs.map(async output => [output.path.split("/").at(-1)!, await output.text()])));
const server = Bun.serve({ hostname: "127.0.0.1", port: 0, fetch: () => new Response('<!doctype html><html lang="en"><head><meta name="viewport" content="width=device-width, initial-scale=1"><title>Responsive workspace</title></head><body><main id="app"></main></body></html>', { headers: { "content-type": "text/html" } }) });
const browser = await chromium.launch();
const page = await browser.newPage();
const errors: string[] = []; page.on("pageerror", error => errors.push(error.message));
await page.routeWebSocket(/.*/, socket => socket.close()); // Never contact external signers or discovery relays.
const evidence = resolve(".local/development-gui-evidence/responsive"); await mkdir(evidence, { recursive: true });
const sizes = [ [280,560], [320,568], [360,640], [390,844], [540,720], [600,800], [768,1024], [850,740], [1000,768], [1001,768], [1024,768], [1100,768], [1280,800], [1440,900], [1920,1080], [2560,1440], [844,390], [568,320], [320,320] ] as const;
let checks = 0;
const assert = (value: unknown, code: string) => { if (!value) throw new Error(code); };

async function layout(name: string, action: string, dialog?: string) {
  for (const [width,height] of sizes) {
    await page.setViewportSize({width,height});
    const issues = await page.evaluate(dialog => {
      const content = document.getElementById("app-content")!;
      const roots = [document.documentElement, document.body, document.getElementById("app")!, content, ...(dialog ? [document.querySelector<HTMLElement>(dialog)!] : [])];
      const result = roots.filter(el => el.scrollWidth > el.clientWidth + 1).map(el => `overflow:${el.id || el.tagName}:${el.scrollWidth}/${el.clientWidth}`);
      if (document.documentElement.scrollHeight > innerHeight + 1) result.push(`document-scrolls-vertically:${document.documentElement.scrollHeight}/${innerHeight}:body=${document.body.scrollHeight}:app=${document.getElementById("app")!.scrollHeight}:offset=${scrollY}`);
      const scope = document.querySelector<HTMLElement>(dialog ?? "#app-content")!;
      const box = scope.getBoundingClientRect();
      for (const el of scope.querySelectorAll<HTMLElement>("button,a,input,textarea,select,summary")) {
        const r = el.getBoundingClientRect(); const style = getComputedStyle(el);
        if (!r.width || !r.height || style.visibility === "hidden" || el.classList.contains("sr-only")) continue;
        if (r.left < box.left - 1 || r.right > box.right + 1) result.push(`offscreen:${el.id || el.tagName}`);
        if (r.width < 43 || r.height < 43) result.push(`small-target:${el.id || el.textContent?.slice(0,20)}:${r.width}x${r.height}`);
      }
      if (!dialog) {
        const header = document.querySelector(".app-header")!.getBoundingClientRect();
        const footer = document.querySelector(".app-status")!.getBoundingClientRect();
        if (header.top < 0 || footer.bottom > innerHeight + 1 || content.clientHeight < 120) result.push("chrome-consumes-viewport");
      }
      return result;
    }, dialog);
    assert(!issues.length, `${name}:${width}x${height}:${issues.join(",")}`);
    const target = page.locator(action);
    await target.scrollIntoViewIfNeeded();
    const reachable = await target.evaluate(el => {
      const rect = el.getBoundingClientRect();
      const x=rect.left+rect.width/2, y=rect.top+rect.height/2;
      return x >= 0 && x < innerWidth && y >= 0 && y < innerHeight && el.contains(document.elementFromPoint(x,y));
    });
    assert(reachable, `${name}:${width}x${height}:action-covered:${action}`);
    assert(await page.evaluate(()=>scrollX===0 && scrollY===0),`${name}:${width}x${height}:outer-frame-moved`);
    checks++;
    if ([320,1440].includes(width) && height>400) {
      await page.screenshot({path:resolve(evidence,`${name}-action-${width}.png`)});
      await page.locator(dialog??"#app-content").evaluate(el=>el.scrollTop=0);
      await page.screenshot({path:resolve(evidence,`${name}-${width}.png`)});
    }
  }
}
try {
  await page.goto(`http://127.0.0.1:${server.port}`);
  await page.addStyleTag({content:await Bun.file("src/dev-ui/browser/product.css").text()});
  await page.evaluate(async scripts => {
    const module = async (name: string) => import(URL.createObjectURL(new Blob([scripts[`${name}.js`]],{type:"text/javascript"})));
    const [{ProductWorkspace},{ExecutionActivity},{PublicationWorkspace},{ProjectsWorkspace}] = await Promise.all(["product-workspace","activity","publication-workspace","projects-workspace"].map(module));
    const bootstrap = {servicePubkey:"a".repeat(64),relayUrl:"ws://127.0.0.1:1",providerLabel:"CVM generation service",actionCeilingSat:"3750"};
    const w=window as any;
    const workspace = new ProductWorkspace(document.getElementById("app"),bootstrap);
    const live = new ExecutionActivity(document.getElementById("execution-activity"),bootstrap.providerLabel,(value:unknown)=>workspace.progress(value));
    const v={sessionId:"session:view",artifactId:"artifact:"+"a".repeat(64),version:1};
    const publication = new PublicationWorkspace(bootstrap,()=>({callTool:async(name:string,input:any)=>{
      if(name!=="development_publication"||input.action!=="prepare")throw new Error("Unexpected publication effect");
      return {id:"publication:view",status:"prepared",artifactId:v.artifactId,publisher:publication.identity.pubkey,template:{tags:[]},servers:input.servers,relays:input.relays,files:[],version:1,expiresAt:Date.now()+60000};
    }}),()=>v);
    w.fixtureProjects = ["active","verified","published","unconfirmed","pending"].map((stage,i)=>({id:`project:${i}`,title:i===0?"A".repeat(512):`My ${stage} applet`,stage,verifiedVersion:i,createdAt:new Date().toISOString()}));
    new ProjectsWorkspace(bootstrap,publication.identity,()=>live.running,async()=>{});
    Object.assign(w,{workspace,live,publication,v}); workspace.connected(true);
  },scripts);
  await layout("idea","#idea-next");
  await page.locator("#idea").fill("A".repeat(512)); await page.getByRole("button",{name:"Shape my idea"}).click();
  await layout("setup","#generate");
  await page.evaluate(()=>{const w=window as any;w.workspace.begin("generate");w.live.begin("Create","CVM generation service");w.live.receive({kind:"sent",requestId:"view",tool:"start_session"});});
  await layout("generating","#preview-expand");
  await page.evaluate(()=>{
    const w=window as any; w.workspace.completed(w.v);w.workspace.versions([w.v],w.v,async()=>{});w.workspace.settled();w.live.finish("Preview ready","completed");
    const frame=document.querySelector<HTMLIFrameElement>("#preview")!;frame.hidden=false;frame.srcdoc='<button onclick="this.textContent=Number(this.textContent)+1">0</button><div style="width:1800px">Oversized preview remains inside its frame</div>';
  });
  await page.frameLocator("#preview").getByRole("button").click();
  await page.locator("#revision").fill("Keep this draft across resize and navigation");
  await layout("builder","#revise");
  await page.locator("#preview-expand").click(); await layout("expanded","#preview-expand"); await page.locator("#preview-expand").click();
  await page.evaluate(()=>{const w=window as any;w.workspace.sessionState("usage_unknown");w.workspace.onSessionStatusCheck(async()=>{});document.getElementById("generation-error")!.textContent="REQUEST_"+"X".repeat(512);document.getElementById("generation-facts")!.innerHTML='<dt>remainingMaximum</dt><dd>'+"a".repeat(128)+'</dd>';document.querySelector<HTMLDetailsElement>("#execution-details")!.open=true;});
  await layout("blocked","#revision-help");
  await page.locator("#open-settings").click();
  await page.locator("#workspace-settings details").evaluate((el:HTMLDetailsElement)=>el.open=true);
  await page.locator("#connection-status").evaluate(el=>el.textContent="Connected: "+"b".repeat(128));
  await layout("settings","#connect","#workspace-settings"); await page.keyboard.press("Escape");
  await page.locator("#nostr-sign-in").click(); await page.locator("#nostr-qr svg").waitFor();
  await layout("sign-in","#nostr-copy","#nostr-identity");
  await page.locator("#nostr-anonymous").click(); await page.locator("#nostr-identity").waitFor({state:"hidden"});
  await page.locator("#your-applets").click(); await page.locator(".project-card").first().waitFor();
  await layout("collection","#projects-refresh");
  await page.evaluate(()=>{(window as any).fixtureProjects=[];});await page.locator("#projects-refresh").click();await page.locator("#projects-empty").waitFor();
  await layout("collection-empty","#projects-new");
  await page.evaluate(()=>{(window as any).fixtureProjectsError="Could not load "+"x".repeat(512);});await page.locator("#projects-refresh").click();await page.locator("#projects-error").filter({hasText:"Could not load"}).waitFor();
  await layout("collection-error","#projects-refresh");
  await page.locator("#workspace-home").click();
  assert(await page.locator("#revision").inputValue()==="Keep this draft across resize and navigation","DRAFT_LOST");
  assert(await page.frameLocator("#preview").getByRole("button").innerText()==="1","PREVIEW_REMOUNTED");
  await page.evaluate(()=>document.dispatchEvent(new CustomEvent("applet:step",{detail:4})));
  for(const [id,scheme] of [["publication-servers","https"],["publication-relays","wss"]]){
    await page.locator(`#${id}`).fill(`${scheme}://${"a".repeat(60)}.${"b".repeat(60)}.example.test`); await page.locator(`#${id}`).press("Enter");
  }
  await layout("publish","#publication-review");
  await page.locator("#publication-review").click(); await page.locator("#publication-review-panel").waitFor();
  await page.locator("#publication-review-panel details").evaluate((el:HTMLDetailsElement)=>el.open=true);
  await layout("publish-review","#publication-confirm");
  await page.evaluate(()=>{
    document.getElementById("publication-status")!.textContent="Some files could not be copied. "+"a".repeat(256);
    document.getElementById("publication-files")!.innerHTML='<li data-state="failed">'+"f".repeat(512)+'</li>';
    document.getElementById("publication-relay-results")!.innerHTML='<li>'+"wss://"+"r".repeat(256)+'</li>';
  });
  await layout("publish-failure","#publication-confirm");
  assert(errors.length===0,errors.join(";"));
  console.log(JSON.stringify({status:"passed",case:"responsive-workspace",viewports:sizes,checks,evidence,coverage:["bounded application frame","no parent/content horizontal overflow","readable reachable controls","short landscape","long titles/errors/addresses","identity QR and settings dialogs","expanded sandbox preview","resize/route draft and preview continuity","publication prepare/review/failure"]}));
} catch(error) {await page.screenshot({path:resolve(evidence,"failure.png")});throw error;}
finally {await browser.close();server.stop(true);}
