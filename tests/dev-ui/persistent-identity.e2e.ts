/** Browser reloads + cryptographic NIP-46 traffic over a local relay fixture. */
import { chromium, type Page } from "playwright";
import { resolve } from "node:path";
import { finalizeEvent, generateSecretKey, getPublicKey, verifyEvent, type Event } from "nostr-tools/pure";
import { matchFilters } from "nostr-tools/filter";
import { nip44 } from "nostr-tools";
import { decodeNbunksec } from "applesauce-signers/helpers/nbunksec";

const assert = (value: unknown, code: string) => { if (!value) throw new Error(code); };
const service = "a".repeat(64), storageKey = `applet-broker/identity/v1/${service}`;
const userKey = generateSecretKey(), userPubkey = getPublicKey(userKey);
const remoteKey = generateSecretKey(), remotePubkey = getPublicKey(remoteKey);
const errors: string[] = [], requests: { method: string; client: string }[] = [];
const sockets = new Set<any>();
let offline = false, publicKeyReads = 0, extensionSigns = 0;
let extensionFailure = false, remoteIdentity = userPubkey;
let publicKeyGate: Promise<void> | undefined, releaseKey: (() => void) | undefined;
const bundle = await Bun.build({ entrypoints: ["src/dev-ui/browser/nostr-identity.ts"], target: "browser", format: "esm", plugins: [{ name: "browser-logger", setup(builder) { builder.onResolve({ filter: /^pino$/ }, () => ({ path: resolve("src/dev-ui/browser/pino-browser-shim.ts") })); } }] });
if (!bundle.success) throw new Error("BROWSER_BUILD_FAILED");
const script = await bundle.outputs[0]!.text();
function broadcast(event: Event) {
  for (const socket of sockets) for (const [id, filters] of socket.data.subscriptions) if (matchFilters(filters, event)) socket.send(JSON.stringify(["EVENT", id, event]));
}
async function respond(event: Event) {
  if (offline || event.kind !== 24133 || !event.tags.some(tag => tag[0] === "p" && tag[1] === remotePubkey)) return;
  const conversation = nip44.v2.utils.getConversationKey(remoteKey, event.pubkey);
  const request = JSON.parse(nip44.v2.decrypt(event.content, conversation));
  requests.push({ method: request.method, client: event.pubkey });
  let result: string;
  if (request.method === "get_public_key") result = remoteIdentity;
  else if (request.method === "sign_event") result = JSON.stringify(finalizeEvent(JSON.parse(request.params[0]), userKey));
  else if (request.method === "nip44_encrypt") result = nip44.v2.encrypt(request.params[1], nip44.v2.utils.getConversationKey(userKey, request.params[0]));
  else if (request.method === "nip44_decrypt") result = nip44.v2.decrypt(request.params[1], nip44.v2.utils.getConversationKey(userKey, request.params[0]));
  else throw new Error("Unexpected remote method");
  broadcast(finalizeEvent({ kind: 24133, created_at: Math.floor(Date.now()/1000), tags: [["p",event.pubkey]], content: nip44.v2.encrypt(JSON.stringify({ id: request.id, result }), conversation) }, remoteKey));
}
const server = Bun.serve<{ subscriptions: Map<string, any[]> }>({ hostname: "127.0.0.1", port: 0,
  fetch(request, server) {
    if (request.headers.get("upgrade") === "websocket" && server.upgrade(request, { data: { subscriptions: new Map() } })) return;
    if (new URL(request.url).pathname === "/identity.js") return new Response(script, { headers: { "content-type":"text/javascript" } });
    return new Response(`<!doctype html><html><body><div class="header-actions"></div><script type="module">import { PublishingIdentity } from '/identity.js'; window.identity = new PublishingIdentity('${service}', () => {});</script></body></html>`, { headers: { "content-type":"text/html" } });
  }, websocket: {
    open(socket) { sockets.add(socket); }, close(socket) { sockets.delete(socket); },
    message(socket, raw) {
      const [type, id, ...rest] = JSON.parse(String(raw));
      if (type === "REQ") { socket.data.subscriptions.set(id, rest); socket.send(JSON.stringify(["EOSE",id])); }
      else if (type === "CLOSE") socket.data.subscriptions.delete(id);
      else if (type === "EVENT") {
        if (!verifyEvent(id)) { errors.push("INVALID_RELAY_EVENT"); return; }
        socket.send(JSON.stringify(["OK",id.id,true,""])); broadcast(id);
        void respond(id).catch(() => errors.push("REMOTE_FIXTURE_FAILED"));
      }
    }
  }
});
const origin = `http://127.0.0.1:${server.port}`, relay = `ws://127.0.0.1:${server.port}`;
const browser = await chromium.launch(); const context = await browser.newContext();
async function setup(page: Page, extension = true) {
  page.on("pageerror", error => errors.push(error.stack || error.message));
  // Do not open the default public relay while choosing a sign-in method.
  await page.routeWebSocket(/^wss:/, socket => socket.close());
  await page.exposeFunction("readKey", async () => { publicKeyReads++; await publicKeyGate; if (extensionFailure) throw new Error("Extension locked"); return userPubkey; });
  await page.exposeFunction("signNostr", (template: any) => { extensionSigns++; return finalizeEvent(template,userKey); });
  if (extension) await page.addInitScript(() => { const w=window as any; w.nostr={ getPublicKey:()=>w.readKey(),signEvent:(event:unknown)=>w.signNostr(event) }; });
}
const ready = async (page: Page) => { await page.waitForFunction(() => !!(window as any).identity); await page.evaluate(() => (window as any).identity.ready); };
const selected = async (page: Page) => page.evaluate(() => (window as any).identity.pubkey);
const saved = async (page: Page) => page.evaluate(key => localStorage.getItem(key),storageKey);
const signOut = async (page: Page) => { await page.locator("#nostr-sign-in").click(); await page.locator("#nostr-sign-out").click(); await page.locator("#nostr-close").click(); };
const page=await context.newPage(); await setup(page);
try {
  await page.goto(origin); await ready(page);
  await page.locator("#nostr-sign-in").click(); await page.locator("#nostr-extension").click();
  await page.locator("#nostr-sign-in").filter({hasText:"NIP-07"}).waitFor();
  assert(publicKeyReads===1 && extensionSigns===0,"EXTENSION_LOGIN_MADE_UNEXPECTED_SIGNATURE");
  await page.reload(); await ready(page);
  assert(await selected(page)===userPubkey && publicKeyReads===2 && extensionSigns===0,"EXTENSION_RELOAD_NOT_PUBLICKEY_ONLY");
  const tab=await context.newPage(); await setup(tab); await tab.goto(origin); await ready(tab);
  assert(await selected(tab)===userPubkey,"NEW_TAB_NOT_AUTHENTICATED");
  await signOut(page); await tab.waitForFunction(()=>!(window as any).identity.pubkey);
  assert(await saved(tab)===null,"SIGN_OUT_NOT_SHARED_WITH_TAB"); await tab.close();
  await page.reload(); await ready(page); assert(!(await selected(page)),"LOGOUT_DID_NOT_PERSIST");

  await page.evaluate(key=>localStorage.setItem(key,JSON.stringify({version:1,mode:"nip07"})),storageKey);
  extensionFailure=true; await page.reload(); await ready(page);
  assert(!(await selected(page)) && !!(await saved(page)),"LOCKED_EXTENSION_FORGOT_SESSION_OR_TRUSTED_CACHE");
  extensionFailure=false; await page.locator("#nostr-sign-in").click();
  await page.locator("#nostr-restore").click(); await page.locator("#nostr-sign-in").filter({hasText:"NIP-07"}).waitFor();
  const missing=await context.newPage(); await setup(missing,false); await missing.goto(origin); await ready(missing);
  assert(!(await selected(missing)) && !!(await saved(missing)),"ABSENT_EXTENSION_FORGOT_SESSION");
  await missing.evaluate(()=>{const w=window as any; w.nostr={getPublicKey:()=>w.readKey(),signEvent:(e:unknown)=>w.signNostr(e)}; window.dispatchEvent(new Event("nostr:ready"));});
  await missing.locator("#nostr-sign-in").filter({hasText:"NIP-07"}).waitFor(); await missing.close();

  publicKeyGate=new Promise<void>(resolve=>{releaseKey=resolve;});
  await page.reload(); await page.locator("#nostr-sign-in").filter({hasText:"Reconnecting"}).waitFor();
  await signOut(page); releaseKey!(); publicKeyGate=undefined; await ready(page);
  assert(!(await selected(page)) && await saved(page)===null,"LATE_PUBLICKEY_UNDID_SIGN_OUT");
  await page.evaluate(key=>localStorage.setItem(key,JSON.stringify({version:1,mode:"nip46",nbunksec:"nbunksec1invalid",pubkey:"a".repeat(64)})),storageKey);
  await page.reload(); await ready(page); assert(await saved(page)===null,"MALFORMED_SESSION_NOT_REMOVED");

  await page.locator("#nostr-sign-in").click(); await page.locator("#nostr-connect summary").click();
  await page.locator("#nostr-relay").fill(relay); await page.locator("#nostr-retry").click();
  const uri=new URL((await page.locator("#nostr-open").getAttribute("href"))!);
  const clientPubkey=uri.hostname;
  for(let i=0;i<100 && ![...sockets].some(s=>[...s.data.subscriptions.values()].some((filters:any)=>filters.some((f:any)=>f["#p"]?.includes(clientPubkey))));i++) await Bun.sleep(10);
  broadcast(finalizeEvent({kind:24133,created_at:Math.floor(Date.now()/1000),tags:[["p",clientPubkey]],content:nip44.v2.encrypt(JSON.stringify({id:"connect",result:uri.searchParams.get("secret")}),nip44.v2.utils.getConversationKey(remoteKey,clientPubkey))},remoteKey));
  await page.locator("#nostr-sign-in").filter({hasText:"NIP-46"}).waitFor();
  const record=JSON.parse((await saved(page))!); const decoded=decodeNbunksec(record.nbunksec);
  assert(record.nbunksec.startsWith("nbunksec1") && decoded.pubkey===remotePubkey && record.pubkey===userPubkey,"NBUNKSEC_WRONG_REMOTE_OR_USER_KEY");
  assert(getPublicKey(Uint8Array.from(Buffer.from(decoded.local_key,"hex")))===clientPubkey,"NBUNKSEC_WRONG_CLIENT_KEY");
  assert(!(await page.content()).includes(record.nbunksec),"NBUNKSEC_EXPOSED_IN_MARKUP");
  const signedTemplate={kind:35129,created_at:Math.floor(Date.now()/1000),tags:[["d","session-test"]],content:""};
  await page.reload(); await ready(page);
  assert(await selected(page)===userPubkey && await saved(page)===JSON.stringify(record),"REMOTE_RELOAD_LOST_SESSION");
  const signed=await page.evaluate(template=>(window as any).identity.sign(template),signedTemplate);
  assert(verifyEvent(signed) && signed.pubkey===userPubkey,"RESTORED_REMOTE_CANNOT_SIGN");
  assert(requests.every(r=>r.client===clientPubkey),"RESTORE_ROTATED_REMOTE_CLIENT_KEY");

  // Offline restore is bounded and retains credentials for a user-triggered retry.
  offline=true; await page.clock.install(); await page.reload();
  await page.locator("#nostr-sign-in").filter({hasText:"Reconnecting"}).waitFor(); await page.clock.fastForward(16000); await ready(page);
  assert(!(await selected(page)) && !!(await saved(page)),"OFFLINE_REMOTE_TRUSTED_CACHE_OR_FORGOT_SESSION");
  offline=false; await page.locator("#nostr-sign-in").click(); await page.locator("#nostr-restore").click();
  await page.locator("#nostr-sign-in").filter({hasText:"NIP-46"}).waitFor();
  remoteIdentity=getPublicKey(generateSecretKey()); await page.reload(); await ready(page);
  assert(!(await selected(page)) && !!(await saved(page)),"REMOTE_CHANGED_USER_SILENTLY");
  remoteIdentity=userPubkey; await page.locator("#nostr-sign-in").click(); await page.locator("#nostr-restore").click();
  await page.locator("#nostr-sign-in").filter({hasText:"NIP-46"}).waitFor();
  await page.evaluate(()=>{(window as any).leased=(window as any).identity.captureSigner();});
  await signOut(page);
  const leased=await page.evaluate(template=>(window as any).leased.signEvent(template),signedTemplate);
  assert(verifyEvent(leased),"SIGN_OUT_INTERRUPTED_IN_FLIGHT_SIGNER_LEASE");
  await page.evaluate(()=>(window as any).leased.release());
  await page.reload(); await ready(page);
  assert(!(await selected(page)) && await saved(page)===null,"REMOTE_LOGOUT_DID_NOT_CLEAR_NBUNKSEC");
  assert(errors.length===0,`BROWSER_OR_RELAY_ERRORS:${errors.join(";")}`);
  console.log(JSON.stringify({status:"passed",case:"persistent-identity",checks:["NIP07 public-key-only reload","new tab and cross-tab signout","locked and delayed extension","late restore after logout","malformed record","NIP46 QR pairing and nbunksec","same-client restore and signing","offline reconnect without pairing","remote identity mismatch","in-flight signer lease","persistent logout"]}));
} finally { releaseKey?.(); await browser.close(); server.stop(true); }
