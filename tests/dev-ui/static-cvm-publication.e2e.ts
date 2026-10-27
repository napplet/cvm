/** Separate static origin → encrypted CVM → real SQL/relay/worker, with browser
 * signing, real NIP-46 handshake, Blossom mirroring and private operator UI. */
import { chromium } from "playwright";
import { openFixtureAdmin } from "./operator-fixture";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { finalizeEvent, generateSecretKey, getPublicKey } from "nostr-tools/pure";
import { SimplePool } from "nostr-tools/pool";
import { nip44 } from "nostr-tools";
import { developmentStack, createDevelopmentPool } from "../../scripts/dev-payments";
import { createDevelopmentContextVmServer } from "../../src/dev-ui/contextvm-server";
import { buildStaticWorkspace } from "../../src/dev-ui/static-assets";
import { DevelopmentContextVmClient } from "../../src/dev-ui/browser/contextvm-client";
import { CvmBlossom } from "../../src/dev/cvm-blossom";
import { chatGptFixture } from "../fixtures/chatgpt";
const assert = (value: unknown, code: string) => { if (!value) throw new Error(code); };
let currentStage = "SETUP";
const stage = (name: string) => { currentStage = name; console.error(`PUBLICATION_E2E_STAGE:${name}`); };
const heartbeat = setInterval(() => console.error(`PUBLICATION_E2E_WAIT:${currentStage}`), 30_000); heartbeat.unref();
const fixture = chatGptFixture(); fixture.setSparseCompletion(true);
let release!: () => void; const gate = new Promise<void>(resolve => { release = resolve; });
const modelFetch: typeof fixture.fetch = async (url, init) => {
  const response = await fixture.fetch(url, init); if (!String(url).endsWith("/responses")) return response;
  const reader = response.body!.getReader();
  return new Response(new ReadableStream({ async start(controller) { try { const first = await reader.read(); if (first.value) controller.enqueue(first.value); await gate; for (;;) { const part = await reader.read(); if (part.done) break; controller.enqueue(part.value); } controller.close(); } catch (error) { controller.error(error); } } }), { headers: response.headers });
};
stage("PAYMENT_STACK_START");
const stack = developmentStack(true); const config = await stack.up(); stage("PAYMENT_STACK_READY"); const root = await mkdtemp(join(tmpdir(), "static-cvm-e2e-"));
let server = await createDevelopmentContextVmServer({ config, stateRoot: root, chatGptFetch: modelFetch });
stage("CVM_SERVER_READY");
const connection = await (await fetch(`${server.url}/cvm.json`)).json() as { relayUrl: string; servicePubkey: string };
const assets = await buildStaticWorkspace(connection);
const site = Bun.serve({ hostname: "127.0.0.1", port: 0, fetch(request) { const pathname = new URL(request.url).pathname; if (!pathname.startsWith("/hosted/")) return new Response("not found", { status: 404 }); const path = pathname.slice("/hosted/".length) || "index.html"; const body = assets.get(path); return body === undefined ? new Response("not found", { status: 404 }) : new Response(body, { headers: { "content-type": path.endsWith(".js") ? "text/javascript" : path.endsWith(".css") ? "text/css" : path.endsWith(".json") ? "application/json" : "text/html" } }); } });
const staticUrl = `http://127.0.0.1:${site.port}/hosted/`;
const browser = await chromium.launch(); const context = await browser.newContext({ permissions: ["clipboard-read", "clipboard-write"] }); const page = await context.newPage(); const admin = await context.newPage();
stage("BROWSER_READY");
const pool = createDevelopmentPool(config.databaseUrl); const relay = new SimplePool();
const userKey = generateSecretKey(); const signerKey = generateSecretKey();
let discoveredRelayList: ReturnType<typeof finalizeEvent> | undefined;
await context.routeWebSocket("wss://purplepag.es/", socket => { socket.onMessage(message => { const data = JSON.parse(String(message)); if (data[0] === "REQ") { if (discoveredRelayList && data.slice(2).some((filter: any) => filter.kinds?.includes(10002) && filter.authors?.includes(discoveredRelayList!.pubkey))) socket.send(JSON.stringify(["EVENT", data[1], discoveredRelayList])); socket.send(JSON.stringify(["EOSE",data[1]])); } }); });
await context.routeWebSocket("wss://relay.nostr.watch/", socket => { socket.onMessage(message => { const data = JSON.parse(String(message)); if (data[0] === "REQ") socket.send(JSON.stringify(["EOSE",data[1]])); }); });
const userPubkey = getPublicKey(userKey); const signerPubkey = getPublicKey(signerKey);
let userBlossom!: CvmBlossom; let rejectCopies = true; let mirrors = 0; let copyRequests = 0;
const destination = Bun.serve({ hostname: "127.0.0.1", port: 0, fetch(request) {
  copyRequests++;
  if (rejectCopies && request.method === "GET") return new Response(null, {status:503,headers:{"access-control-allow-origin":"*"}});
  if (request.method === "PUT") { if (rejectCopies) return new Response("test outage", { status: 503, headers: { "access-control-allow-origin": "*" } }); if (new URL(request.url).pathname === "/mirror") mirrors++; }
  return userBlossom.handle(request);
} });
const destinationUrl = `http://127.0.0.1:${destination.port}`; userBlossom = new CvmBlossom(join(root, "user-blossom"), userPubkey, () => destinationUrl);
let backupBlossom!: CvmBlossom;
const backup = Bun.serve({ hostname: "127.0.0.1", port: 0, fetch: request => {copyRequests++; return backupBlossom.handle(request);} });
const backupUrl = `http://127.0.0.1:${backup.port}`; backupBlossom = new CvmBlossom(join(root, "backup-blossom"), userPubkey, () => backupUrl);
const unavailable = Bun.serve({ hostname: "127.0.0.1", port: 0, fetch: request => {copyRequests++; return new Response(null, { status: request.method === "OPTIONS" ? 204 : 401, headers: { "access-control-allow-origin": "*", "access-control-allow-methods": "GET, PUT, OPTIONS", "access-control-allow-headers": "authorization, content-type, x-sha-256" } });} });
const unavailableUrl = `http://127.0.0.1:${unavailable.port}`;
const errors: string[] = []; const traffic: string[] = []; let signerRequests = 0; let appletSignatures = 0; let applicationSignatures = 0; let remoteSubscription: { close(): void } | undefined;
await page.addInitScript(() => {
  const Original = window.WebSocket; (window as any).listeningSigners = [];
  window.WebSocket = class extends Original {
    subscriptions = new Map<string, string>();
    constructor(url: string | URL, protocols?: string | string[]) { super(url, protocols); this.addEventListener("message", ({ data }) => { const message = JSON.parse(String(data)); if (message[0] === "EOSE" && this.subscriptions.has(message[1])) { (window as any).listeningSigners.push(this.subscriptions.get(message[1])); super.send(JSON.stringify(["CLOSE", message[1]])); } }); }
    send(data: string | ArrayBufferLike | Blob | ArrayBufferView) {
      super.send(data);
      if (typeof data === "string") {
        const message = JSON.parse(data);
        if (message[0] === "REQ" && message[2]?.kinds?.includes(24133) && message[2]?.["#p"]?.[0]) {
          // This relay omits EOSE for limit:0. A second read on the same socket
          // gives us an ordering barrier without changing the signer filter.
          const barrier = `ready-${message[1]}`; this.subscriptions.set(barrier, message[2]["#p"][0]);
          super.send(JSON.stringify(["REQ", barrier, { ...message[2], limit: 1 }]));
        }
      }
    }
  };
});
page.on("pageerror", error => errors.push(error.message)); admin.on("pageerror", error => errors.push(error.message));
page.on("request", request => traffic.push(request.url()));
const unauthorized = new DevelopmentContextVmClient({ ...connection, reserveSat: "0", actionCeilingSat: "0", providerLabel: "test" }, undefined, Buffer.from(generateSecretKey()).toString("hex"));
try {
  assert(Object.keys(connection).sort().join(",") === "relayUrl,servicePubkey", "PUBLIC_CONFIG_LEAK");
  for (const path of ["/bootstrap", "/dev/chatgpt/status", "/dev/faucet/cashu"]) assert((await fetch(`${server.url}${path}`)).status === 404, "HTTP_CONTROL_STILL_EXPOSED");
  stage("PRIVATE_ADMIN_BOUNDARY");
  await unauthorized.connect({ accountStatus: false });
  assert((await unauthorized.callTool("cvm_admin", { action: "status" })).status === "denied", "UNAUTHENTICATED_ADMIN");
  const operator = JSON.parse(await readFile(join(root, "cvm-operator/operator.json"), "utf8"));
  await openFixtureAdmin(admin, server.url, root, fixture); stage("ADMIN_OAUTH_READY");
  await admin.getByText("Using ChatGPT plan · fixture-codex", { exact: true }).waitFor();
  await admin.getByLabel("Input price (test sats per 1,000 tokens)", { exact: true }).fill("0.5"); assert(await admin.getByLabel("Input price (test sats per 1,000 tokens)", { exact: true }).inputValue() === "0.5", "RATE_EDIT_LOST"); await admin.getByRole("button", { name: "Save rates", exact: true }).click();
  await admin.getByText("New rates saved. Existing jobs retain their price versions.", { exact: true }).waitFor();
  stage("RATES_SAVED");
  await page.goto(staticUrl); await page.getByText("Workspace connected", { exact: true }).waitFor();
  await page.getByRole("button", { name: "Settings", exact: true }).click();
  assert(await page.locator("#chatgpt-account").count() === 0 && !(await page.content()).includes("fixture@example"), "PUBLIC_PROVIDER_CONTROLS");
  await page.getByRole("button", { name: "Close settings" }).click();
  assert(await page.locator("#publish").isDisabled(), "PUBLISH_BEFORE_AUTH");
  await page.locator("#idea").fill("A counter for daily practice"); await page.locator("#idea-next").click(); await page.locator("#generate").click();
  await page.locator('#activity-events [data-stage="model_stream"]').waitFor({ state: "attached", timeout: 30000 });
  const generationKey = await page.evaluate(() => Object.entries(sessionStorage).find(([key]) => key.includes("dev-contextvm-key"))?.[1]);
  await page.locator("#nostr-sign-in").click();
  assert(await page.locator("#nostr-extension").isDisabled(), "MISSING_EXTENSION_NOT_DISABLED");
  assert(await page.locator("#nostr-qr svg").count() === 1, "DEFAULT_QR_MISSING");
  await page.locator("#nostr-anonymous").click(); assert(await page.locator("#nostr-sign-in").textContent() !== "Sign in", "ANONYMOUS_SIGN_IN_FAILED");
  await page.exposeFunction("testPubkey", () => userPubkey); await page.exposeFunction("testSign", (template: any) => finalizeEvent(template, userKey));
  await page.evaluate(() => { (window as any).nostr = { getPublicKey: () => (window as any).testPubkey(), signEvent: (template: any) => (window as any).testSign(template) }; });
  await page.locator("#nostr-sign-in").click(); await page.locator("#nostr-extension").click(); await page.locator("#nostr-sign-in").filter({ hasText: "NIP-07" }).waitFor();
  await page.locator("#nostr-sign-in").click(); await page.locator("#nostr-remote").click(); await page.locator("#nostr-connect summary").click(); await page.locator("#nostr-relay").fill(config.relayUrl); await page.locator("#nostr-retry").click();
  const uri = new URL((await page.locator("#nostr-open").getAttribute("href"))!); const clientPubkey = uri.hostname; const conversation = nip44.v2.utils.getConversationKey(signerKey, clientPubkey);
  // NostrConnect subscribes with limit:0. Wait for EOSE so the handshake is
  // delivered live; publishing before REQ arrives is intentionally not replayed.
  await page.waitForFunction(pubkey => (window as any).listeningSigners.includes(pubkey), clientPubkey, { timeout: 10000 });
  remoteSubscription = relay.subscribeMany([config.relayUrl], { kinds: [24133], "#p": [signerPubkey] }, { onevent(event) { void (async () => {
    const request = JSON.parse(nip44.v2.decrypt(event.content, conversation)); let result: string;
    if (request.method === "get_public_key") result = userPubkey;
    else if (request.method === "switch_relays") result = JSON.stringify([config.relayUrl]);
    else if (request.method === "nip44_decrypt") result = nip44.v2.decrypt(request.params[1], nip44.v2.utils.getConversationKey(userKey,request.params[0]));
    else if (request.method === "nip44_encrypt") result = nip44.v2.encrypt(request.params[1], nip44.v2.utils.getConversationKey(userKey,request.params[0]));
    else if (request.method === "sign_event") { signerRequests++; const template = JSON.parse(request.params[0]); if (template.kind === 35129) appletSignatures++; if (template.kind === 32267) applicationSignatures++; result = JSON.stringify(finalizeEvent(template, userKey)); }
    else result = "ack";
    await Promise.all(relay.publish([config.relayUrl], finalizeEvent({ kind: 24133, created_at: Math.floor(Date.now() / 1000), tags: [["p", clientPubkey]], content: nip44.v2.encrypt(JSON.stringify({ id: request.id, result }), conversation) }, signerKey)));
  })().catch(error => errors.push(`Signer fixture: ${error.message}`)); } });
  await Promise.all(relay.publish([config.relayUrl], finalizeEvent({ kind: 24133, created_at: Math.floor(Date.now() / 1000), tags: [["p", clientPubkey]], content: nip44.v2.encrypt(JSON.stringify({ id: "connect", result: uri.searchParams.get("secret") }), conversation) }, signerKey)));
  await page.locator("#nostr-sign-in").filter({ hasText: "NIP-46" }).waitFor({ timeout: 15000 });
  assert((await page.evaluate(() => Object.entries(sessionStorage).find(([key]) => key.includes("dev-contextvm-key"))?.[1])) === generationKey, "SIGN_IN_CHANGED_GENERATION_OWNER");
  assert(await page.locator("#publish").isDisabled(), "PUBLISH_UNVERIFIED_ARTIFACT");
  await admin.getByRole("button", { name: "Active", exact: true }).click(); await admin.locator("#jobs button").first().waitFor(); await admin.locator("#jobs button").first().click(); await admin.locator("#job-detail").waitFor();
  await admin.locator("#job-facts .job-badge").filter({ hasText: "Running" }).waitFor();
  assert((await admin.locator("#job-facts").textContent())?.includes("Running"), "ACTIVE_JOB_DETAIL_MISSING"); await admin.locator("#job-close").click();
  stage("SIGNERS_CHECKED");
  release();
  await page.waitForFunction(() => document.querySelector("#build-progress")?.getAttribute("aria-valuenow") === "5", undefined, { timeout: 180000 });
  await page.waitForFunction(() => !(document.querySelector("#preview-copy-address") as HTMLButtonElement).disabled, undefined, { timeout: 30000 });
  assert(await page.locator("#publish").isEnabled(), "AUTHENTICATED_PUBLISH_DISABLED");
  await page.locator("#preview-copy-address").click(); const previewAddress = await page.evaluate(() => navigator.clipboard.readText()); assert(previewAddress.startsWith("naddr1"), "CVM_PREVIEW_NADDR_MISSING");
  const events = await relay.querySync([config.relayUrl], { kinds: [35129], authors: [connection.servicePubkey] }, { maxWait: 3000 }); assert(events.length === 1, "CVM_PREVIEW_EVENT_MISSING");
  const cvmBlob = events[0]!.tags.find(tag => tag[0] === "server")![1]!;
  assert((await fetch(`${cvmBlob}/upload`, { method: "PUT", body: "untrusted" })).status === 403, "CVM_BLOSSOM_ACCEPTED_PUBLIC_UPLOAD");
  stage("PREVIEW_SHARED");
  // Manual fallback first, then discover the standard kind-10063 list.
  await page.locator("#publish").click(); await page.locator("#publication-discovery").filter({ hasText: "No server list found" }).waitFor({ timeout: 20000 });
  assert(await page.locator("#workspace-nav-label").innerText() === "Publish" && await page.locator("#workspace-home").getAttribute("aria-current") === "page", "PUBLICATION_NAV_CONTEXT_MISSING");
  assert(await page.locator(".header-actions #publish").count() === 0 && await page.locator("dialog #publication-title").count() === 0, "PUBLISH_NOT_CONTEXTUAL_STEP");
  assert(await page.locator("#publication-server-editor textarea, #publication-relay-editor textarea").count() === 0, "DESTINATION_TEXTAREA_REMAINS");
  assert((await page.locator("#publication-title").inputValue()).includes("daily practice"), "CVM_TITLE_NOT_SUGGESTED");
  assert((await page.locator("#publication-description").inputValue()).includes("daily practice"), "CVM_DESCRIPTION_NOT_SUGGESTED");
  await page.locator("#publication-advanced").evaluate((el:HTMLDetailsElement)=>el.open=true);
  assert((await page.locator("#publication-optional").innerText()).includes("theme") && (await page.locator("#publication-required").innerText()).includes("storage"), "CAPABILITY_DECLARATIONS_MISSING");
  await page.locator("#publication-hashtags").fill("#Games"); await page.locator("#publication-hashtags").press("Enter");
  await page.locator("#publication-hashtags").fill("bad tag"); await page.locator("#publication-hashtags").press("Enter");
  assert(await page.locator("#publication-hashtags").getAttribute("aria-invalid")==="true", "INVALID_HASHTAG_ACCEPTED");
  await page.locator("#publication-hashtags").fill("");
  await page.locator("#publication-description").fill("Count daily practice, one step at a time.");
  await page.locator("#publication-servers").fill("javascript:alert(1)"); await page.locator("#publication-servers").press("Enter");
  assert(await page.locator("#publication-servers").getAttribute("aria-invalid") === "true", "INVALID_BLOSSOM_ACCEPTED");
  await page.locator("#publication-servers").fill(destinationUrl); await page.locator("#publication-servers").press("Enter");
  await page.getByRole("button", { name: `Remove ${destinationUrl}`, exact: true }).click();
  await page.locator("#publication-relays").fill(config.relayUrl); await page.locator("#publication-relays").press("Enter");
  assert(await page.locator("#publication-relay-editor .destination-chip").count() === 1, "MANUAL_RELAY_NOT_ADDED");
  await page.locator("#publication-close").click();
  discoveredRelayList = finalizeEvent({ kind: 10002, created_at: Math.floor(Date.now()/1000), tags: [["r",config.relayUrl,"write"],["r","wss://read-only.invalid","read"]], content: "" },userKey);
  await Promise.all(relay.publish([config.relayUrl], finalizeEvent({ kind: 10063, created_at: Math.floor(Date.now() / 1000), tags: [["server", backupUrl], ["server", destinationUrl], ["server", unavailableUrl]], content: "" }, userKey)));
  await page.locator("#publish").click(); await page.getByRole("button", { name: `Remove ${destinationUrl}`, exact: true }).waitFor({ timeout: 20000 });
  await page.getByRole("button", { name: `Remove ${config.relayUrl}`, exact: true }).waitFor();
  assert(await page.locator("#publication-relay-editor .destination-chip").count() === 1, "READ_ONLY_RELAY_USED");
  await page.locator("#publication-relays").fill("wss://unreachable.invalid"); await page.locator("#publication-relays").press("Enter");
  await page.locator("#publication-title").fill("My daily counter"); await page.locator("#publication-review").click(); await page.locator("#publication-review-description").filter({hasText:"Count daily practice, one step at a time."}).waitFor(); await page.locator("#publication-confirm").click();
  await page.locator("#publication-status").filter({ hasText: "copies ready. Retry or change destinations." }).waitFor({ timeout: 60000 });
  assert((await relay.querySync([config.relayUrl], { kinds: [35129], authors: [userPubkey] }, { maxWait: 3000 })).length === 0, "EVENT_PUBLISHED_WITH_MISSING_FILES");
  const failedCopy = (await pool.query<{ signed_event: { id: string }; file_results: { state: string }[]; state: string }>("SELECT signed_event,file_results,state FROM development_publications WHERE publisher=$1", [userPubkey])).rows[0]!;
  assert(failedCopy.signed_event && failedCopy.file_results.some((result: any) => result.state === "failed") && failedCopy.state === "prepared", "FAILED_COPY_NOT_DURABLE");
  assert(appletSignatures === 1, "APPLET_SIGNED_MORE_THAN_ONCE");
  assert(applicationSignatures===1, "APPLICATION_NOT_SIGNED_ONCE");
  assert(await page.locator("#publication-screenshot").evaluate((img:HTMLImageElement)=>img.complete&&img.naturalWidth===1200&&img.naturalHeight===750), "REAL_SCREENSHOT_NOT_SHOWN");
  assert(failedCopy.file_results.filter(result => result.state === "verified").length === 2, "ONE_COPY_FIXTURE_INVALID");
  const earlyOwner = new DevelopmentContextVmClient({ ...connection, reserveSat: "0", actionCeilingSat: "0", providerLabel: "test" }, undefined, generationKey);
  await earlyOwner.connect({ accountStatus: false });
  try {
    const savedRow = (await pool.query("SELECT id,signed_event FROM development_publications WHERE publisher=$1", [userPubkey])).rows[0];
    assert((await earlyOwner.callTool("development_publication", {action:"submit",id:savedRow.id,event:savedRow.signed_event})).code === "PUBLICATION_NEEDS_TWO_VERIFIED_SERVERS", "CVM_ACCEPTED_INSUFFICIENT_COPIES");
    assert((await earlyOwner.callTool("development_publication", {action:"republish",id:savedRow.id})).code === "PUBLICATION_NOT_PUBLISHED", "UNPUBLISHED_APPLET_REPUBLISHED");
  } finally { await earlyOwner.close(); }
  // Lose the browser publication journal. Restore the signature and failures
  // through the signed CVM owner request, then retry without a second event.
  await page.evaluate(() => { for (const key of Object.keys(sessionStorage)) if (key.startsWith("applet-broker/publication/")) sessionStorage.removeItem(key); });
  await page.reload(); await page.getByText("Workspace connected", { exact: true }).waitFor();
  await page.locator("#publish").filter({ hasText: "Continue publishing" }).waitFor({ timeout: 30000 });
  await page.locator("#publish").click(); await page.locator("#publication-status").filter({ hasText: "Signature saved" }).waitFor();
  assert(await page.locator('#publication-files [data-state="failed"]').count() > 0, "COPY_FAILURES_NOT_RESTORED");
  assert(fixture.counts().inferences === 1, "COPY_RETRY_REGENERATED");
  stage("COPY_RETRY");
  rejectCopies = false; await page.locator("#publication-confirm").click(); await page.locator("#publication-result").waitFor({ timeout: 60000 });
  assert(appletSignatures === 1, "COPY_RETRY_REQUESTED_NEW_APPLET_SIGNATURE");
  assert((await page.locator("#publication-completion").innerText()).includes("2 file copies"), "FAILED_SERVER_COUNTED_AS_VERIFIED");
  assert((await page.locator("#publication-completion").innerText()).includes("1 relay confirmed"), "PARTIAL_RELAY_SUCCESS_NOT_COUNTED");
  assert(await page.locator("#publication-heading").innerText()==="Published.", "PARTIAL_SUCCESS_HEADING");
  assert(!(await page.locator("#publication-stages").isVisible()) && !(await page.locator("#publication-copy-warning").isVisible()), "SUCCESS_CLUTTER_VISIBLE");
  assert(!(await page.locator("#publication-receipts").getAttribute("open")), "SUCCESS_DETAILS_NOT_COLLAPSED");
  await page.locator("#publication-delivery-summary").click();
  assert((await page.locator("#publication-files").innerText()).includes("401") && await page.locator('#publication-relay-results [data-state="failed"]').count()===1, "PARTIAL_FAILURE_DETAILS_MISSING");
  await page.locator("#publication-delivery-summary").click();
  assert(await page.locator("#publication-propagating").getAttribute("data-state") === "complete", "PARTIAL_SUCCESS_STAGE_FAILED");
  assert(await page.locator("#publish").textContent() === "View publication", "BUILDER_PUBLICATION_NOT_UPDATED");
  await page.screenshot({ path:"/tmp/cvm-publication-desktop.png", fullPage:true });
  await page.setViewportSize({width:390,height:844});
  assert(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth),"PUBLISH_MOBILE_OVERFLOW");
  await page.screenshot({ path:"/tmp/cvm-publication-mobile.png", fullPage:true });
  await page.setViewportSize({width:1280,height:900});
  assert(mirrors > 0 && signerRequests >= 2, "SIGNATURE_OR_MIRROR_MISSING");
  await page.locator("#publication-copy").click(); const address = await page.evaluate(() => navigator.clipboard.readText()); assert(address.startsWith("naddr1") && address !== previewAddress, "USER_NADDR_MISSING");
  const published = await relay.querySync([config.relayUrl], { kinds: [35129], authors: [userPubkey] }, { maxWait: 3000 }); assert(published.length === 1, "USER_EVENT_COUNT_INVALID");
  assert(!published[0]!.tags.some(tag=>["path","requires"].includes(tag[0]!)), "LEGACY_PUBLICATION_EMITTED");
  const digest = published[0]!.tags.find(tag=>tag[0]==="x")!;
  assert(digest.length===2, "CURRENT_HASH_INVALID");
  const artifactResponse = await fetch(`${destinationUrl}/${digest[1]}`);
  const artifactBytes = await artifactResponse.arrayBuffer();
  assert(new Bun.CryptoHasher("sha256").update(artifactBytes).digest("hex")===digest[1], "DESTINATION_BYTES_MISMATCH");
  const artifactHtml = new TextDecoder().decode(artifactBytes);
  assert(artifactHtml.includes('name="napplet-requires" content="storage"') && artifactHtml.includes('name="napplet-optional" content="theme"'), "HTML_CAPABILITIES_MISSING");
  assert(published[0]!.tags.some(tag=>tag[0]==="R"&&tag[1]==="storage")&&published[0]!.tags.some(tag=>tag[0]==="O"&&tag[1]==="theme"), "SIGNED_CAPABILITIES_MISSING");
  assert(published[0]!.tags.some(tag=>tag[0]==="t"&&tag[1]==="games"), "SIGNED_HASHTAG_MISSING");
  const applications = await relay.querySync([config.relayUrl], { kinds: [32267], authors: [userPubkey] }, { maxWait: 3000 });
  assert(applications[0]?.tags.some(tag=>tag[0]==="t"&&tag[1]==="games"), "LISTING_HASHTAG_MISSING");
  assert(applications.length===1 && applications[0].tags.some(tag=>tag[0]==="name"&&tag[1]==="My daily counter") && applications[0].content.includes(`nostr:${address}`), "APPLICATION_NOT_PUBLISHED");
  assert((await page.locator("#publication-listing").innerText()).includes("shared with screenshot"), "APPLICATION_RESULT_MISSING");
  for (const image of applications[0].tags.filter(tag=>tag[0]==="image"&&[destinationUrl,backupUrl].some(server=>tag[1].startsWith(server+"/")))) {
    const response = await fetch(image[1]); const png = new Uint8Array(await response.arrayBuffer());
    assert(response.ok && response.headers.get("content-type")?.includes("image/png") && new Bun.CryptoHasher("sha256").update(png).digest("hex")===new URL(image[1]).pathname.slice(1), "SCREENSHOT_NOT_MIRRORED");
  }
  const intent = (await pool.query("SELECT id FROM development_publications WHERE publisher=$1", [userPubkey])).rows[0].id;
  assert(published[0]!.content==="Count daily practice, one step at a time.", "DESCRIPTION_NOT_SIGNED");
  assert((await unauthorized.callTool("development_publication", {action:"republish",id:intent})).status==="denied", "CROSS_OWNER_REPUBLICATION");
  const beforeRepublish = {copies:copyRequests,signatures:signerRequests,inferences:fixture.counts().inferences};
  await page.locator("#publication-close").click(); await page.locator("#republish").click();
  await page.locator("#publication-share-feedback").filter({hasText:"Republished · 1 relay confirmed"}).waitFor({timeout:60000});
  assert(copyRequests===beforeRepublish.copies && signerRequests===beforeRepublish.signatures && fixture.counts().inferences===beforeRepublish.inferences, "REPUBLICATION_REBUILT_COPIED_OR_SIGNED");
  assert(await page.locator("#publication-address").inputValue()===address, "REPUBLICATION_CHANGED_ADDRESS");
  assert((await pool.query("SELECT count(*)::int AS count FROM development_publications WHERE publisher=$1",[userPubkey])).rows[0].count===1, "REPUBLICATION_CREATED_RECORD");
  await page.locator("#publication-republish").click();
  await page.waitForFunction(()=>!(document.querySelector("#publication-republish") as HTMLButtonElement).disabled);
  assert((await page.locator("#publication-share-feedback").innerText()).includes("Republished"), "RESULT_REPUBLICATION_FAILED");
  // Old all-relay policy records are repaired from existing receipts on lookup.
  const beforeRepair = {copies:copyRequests, signatures:signerRequests};
  await pool.query("UPDATE development_publications SET state='unconfirmed' WHERE id=$1", [intent]);
  await page.reload(); await page.getByText("Workspace connected", {exact:true}).waitFor();
  await page.locator("#publish").filter({hasText:"View publication"}).click(); await page.locator("#publication-result").waitFor();
  assert(copyRequests===beforeRepair.copies && signerRequests===beforeRepair.signatures, "SAVED_RECEIPT_REPAIR_REPEATED_EFFECTS");
  assert((await pool.query("SELECT state FROM development_publications WHERE id=$1",[intent])).rows[0].state==="published", "LEGACY_OUTCOME_NOT_PERSISTED");
  // No confirmation must remain retryable, never be presented as success.
  await pool.query("UPDATE development_publications SET state='unconfirmed',relay_results=$2 WHERE id=$1", [intent,JSON.stringify([{relay:config.relayUrl,state:"failed"},{relay:"wss://unreachable.invalid",state:"failed"}])]);
  await page.reload(); await page.getByText("Workspace connected", {exact:true}).waitFor();
  await page.locator("#publish").filter({hasText:"Continue publishing"}).click();
  await page.getByRole("button", {name:"Retry publication", exact:true}).waitFor();
  const copiesBeforeContinue = copyRequests; const signaturesBeforeContinue = signerRequests;
  await page.locator("#publication-confirm").click(); await page.locator("#publication-result").waitFor();
  assert(copyRequests===copiesBeforeContinue && signerRequests===signaturesBeforeContinue, "CONTINUE_REPEATED_COPY_OR_SIGNATURE");
  assert((await unauthorized.callTool("development_publication", { action: "status", id: intent })).status === "denied", "CROSS_OWNER_PUBLICATION_READ");
  const owner = new DevelopmentContextVmClient({ ...connection, reserveSat: "0", actionCeilingSat: "0", providerLabel: "test" }, undefined, generationKey);
  await owner.connect({ accountStatus: false });
  try {
    const mine = await owner.callTool("projects", { action: "list" });
    assert(mine.projects.length === 1 && mine.projects[0].verifiedVersion === 1, "PROJECT_REGISTRY_MISSING");
    assert(mine.projects[0].stage === "published" && mine.projects[0].publication.version === 1 && !mine.projects[0].unpublishedChanges, "CROSS_SIGNER_PUBLICATION_STAGE_MISSING");
    const projectId = mine.projects[0].id;
    assert((await unauthorized.callTool("development_publication", { action: "lookup", sessionId: projectId, artifactId: mine.projects[0].publication.id, publisher: userPubkey })).status === "denied", "CROSS_OWNER_PUBLICATION_LOOKUP");
    for (const args of [{ action: "get", id: projectId }, { action: "rename", id: projectId, title: "stolen" }, { action: "list", after: projectId }]) assert((await unauthorized.callTool("projects",args)).status === "not_found_or_denied", "CROSS_IDENTITY_PROJECT_ACCESS");
    let spoofRejected = false; try { await unauthorized.callTool("projects", { action: "list", pubkey: await owner.pubkey }); } catch { spoofRejected = true; }
    assert(spoofRejected, "CALLER_SUPPLIED_PROJECT_IDENTITY_ACCEPTED");
    assert((await owner.callTool("projects", { action: "rename", id: projectId, title: "Daily counter" })).project.title === "Daily counter", "OWNER_RENAME_FAILED");
    const saved = await owner.callTool("development_publication", { action: "status", id: intent });
    assert(saved.signedEvent.id === published[0]!.id && saved.publishedAt && saved.fileResults.filter((result: any) => result.state === "verified").length === 4 && saved.fileResults.some((result: any) => result.state === "failed"), "PUBLISHED_RECEIPTS_MISSING");
    const metadata = await owner.callTool("development_publication", {action:"metadata", sessionId:projectId, artifactId:saved.artifactId});
    assert(metadata.status==="ok" && metadata.title==="Daily counter" && metadata.description, "OWNER_METADATA_MISSING");
    assert((await unauthorized.callTool("development_publication", {action:"metadata",sessionId:projectId,artifactId:saved.artifactId})).status==="denied", "CROSS_OWNER_METADATA");
    assert((await owner.callTool("development_publication", {action:"metadata",sessionId:"wrong",artifactId:saved.artifactId})).status==="denied", "WRONG_SESSION_METADATA");
    assert(saved.application.signedEvent.id===applications[0].id && saved.application.relayResults.some((r:any)=>r.state==="published"), "APPLICATION_RECEIPTS_LOST");
    assert(saved.republication?.relayResults.some((receipt:any)=>receipt.state==="published"), "REPUBLICATION_NOT_SAVED");
    // A later resend with no responding destinations cannot revoke success.
    await pool.query("UPDATE development_publications SET prepared=jsonb_set(prepared,'{relays}',$2::jsonb) WHERE id=$1",[intent,JSON.stringify(["wss://unreachable.invalid"])]);
    const noReplies = await owner.callTool("development_publication", {action:"republish",id:intent});
    assert(noReplies.status==="published" && noReplies.eventId===saved.eventId && noReplies.publishedAt===saved.publishedAt && noReplies.republication.relayResults.every((receipt:any)=>receipt.state==="failed") && noReplies.relayResults.some((receipt:any)=>receipt.state==="published"), "RESEND_REVOKED_PUBLICATION");
    await pool.query("UPDATE development_publications SET prepared=jsonb_set(prepared,'{relays}',$2::jsonb) WHERE id=$1",[intent,JSON.stringify(saved.relays)]);
    const lookup = await owner.callTool("development_publication", { action: "lookup", sessionId: projectId, artifactId: saved.artifactId, publisher: userPubkey });
    assert(lookup.current.id === intent && lookup.latestPublished.address === address, "OWNER_PUBLICATION_LOOKUP_MISSING");
    const repeated = await owner.callTool("development_publication", { action: "prepare", sessionId: projectId, artifactId: saved.artifactId, publisher: userPubkey, requestKey: crypto.randomUUID(), title: "My daily counter", servers: saved.servers, relays: saved.relays });
    assert(repeated.id === intent && repeated.signedEvent.id === saved.signedEvent.id, "REPEATED_PREPARATION_CREATED_NEW_EVENT");
    const changed = finalizeEvent({ ...saved.template, tags: [...saved.template.tags, ["title", "tampered"]] }, userKey);
    assert((await owner.callTool("development_publication", { action: "submit", id: intent, event: changed })).status === "rejected", "SIGNED_TEMPLATE_TAMPER_ACCEPTED");
    assert((await owner.callTool("development_publication", { action: "submit", id: intent, event: published[0] })).status === "published", "EXACT_PUBLICATION_REPLAY_FAILED");
  } finally { await owner.close(); }
  const pending = await unauthorized.savePreAdmission({ maximum: "4000", idea: "A saved idea", idempotencyKey: crypto.randomUUID() });
  assert(pending.status === "saved", "PENDING_FIXTURE_MISSING");
  const ownPending = await unauthorized.callTool("projects", { action: "list" }); assert(ownPending.projects.length === 1 && ownPending.projects[0].checkpointId === pending.checkpointId && ownPending.projects[0].stage === "pending", "PENDING_PROJECT_NOT_OWNER_SCOPED");
  await admin.locator('[data-state="pending"]').click(); await admin.locator(`[data-job-id="${pending.checkpointId}"]`).click(); await admin.locator("#job-detail").waitFor();
  await admin.locator("#job-facts .job-badge").filter({ hasText: "Awaiting funds" }).waitFor();
  assert((await admin.locator("#job-facts").textContent())?.includes("Awaiting funds"), "PENDING_JOB_DETAIL_MISSING"); await admin.locator("#job-close").click();
  await admin.locator('[data-state="finished"]').click(); await admin.locator("#jobs button").first().waitFor(); await admin.locator("#jobs button").first().click(); await admin.locator("#job-detail").waitFor();
  await admin.locator("#job-facts .job-badge").filter({ hasText: "Ready" }).waitFor();
  assert((await admin.locator("#job-facts").textContent())?.includes("Ready"), "FINISHED_JOB_DETAIL_MISSING");
  const currentPricing: any = (await pool.query("SELECT normalized_card FROM price_card_versions WHERE id=(SELECT price_card_id FROM metered_actions LIMIT 1)")).rows[0].normalized_card;
  assert(currentPricing.rates.input_tokens.denominator === "2000", `ADMIN_RATES_NOT_USED:${JSON.stringify(currentPricing)}`);
  assert(!traffic.some(url => new URL(url).origin === server.url), "PUBLIC_SITE_CALLED_CVM_HTTP");
  assert(!(await page.content()).includes(operator.adminKey), "OPERATOR_KEY_IN_PRODUCT");
  assert(errors.length === 0, `BROWSER_ERRORS:${errors.join(";")}`);
  await pool.query("UPDATE development_publications SET state='unconfirmed' WHERE id=$1", [intent]);
  stage("CVM_RESTART_STOP");
  const old = server.url; await server.close(); stage("CVM_RESTART_START"); server = await createDevelopmentContextVmServer({ config, stateRoot: root, port: Number(new URL(old).port), chatGptFetch: modelFetch });
  await page.evaluate(() => { for (const key of Object.keys(sessionStorage)) if (key.startsWith("applet-broker/publication/")) sessionStorage.removeItem(key); });
  await page.locator("#publication-close").click(); await page.reload(); await page.getByText("Workspace connected", { exact: true }).waitFor();
  await page.waitForFunction(() => !(document.querySelector("#preview-copy-address") as HTMLButtonElement).disabled, undefined, { timeout: 30000 });
  stage("CVM_RESTART_RESTORED");
  assert(fixture.counts().inferences === 1, "RESTART_REGENERATED");
  assert((await page.locator("#nostr-sign-in").innerText()).includes("NIP-46"), "REMOTE_SIGNIN_NOT_RESTORED");
  assert(await page.locator("#publish").isEnabled(), "RESTORED_REMOTE_PUBLISH_DISABLED");
  await page.locator("#publish").filter({ hasText: "View publication" }).waitFor();
  assert((await page.locator("#publish-hint").innerText()).includes("Published · Version 1"), "PUBLISHED_BUILDER_NOT_RESTORED");
  await page.locator("#your-applets").click(); await page.locator(".project-card").filter({ hasText: "Daily counter" }).waitFor();
  assert((await page.locator(".project-card").filter({ hasText: "Daily counter" }).innerText()).includes("Published · Version 1"), "PUBLISHED_PROJECT_BADGE_MISSING");
  await page.locator(".project-card").filter({ hasText: "Daily counter" }).click();
  await page.locator("#publish").filter({ hasText: "View publication" }).click(); await page.locator("#publication-result").waitFor();
  assert(await page.locator("#publication-address").inputValue() === address, "REOPENED_PUBLICATION_ADDRESS_CHANGED");
  assert((await page.locator("#publication-delivery-summary").innerText()).includes("unavailable") && (await page.locator("#publication-completion").innerText()).includes("2 file copies"), "PARTIAL_SUCCESS_NOT_RESTORED");
  assert(appletSignatures === 1 && fixture.counts().inferences === 1, "REOPEN_REPEATED_GENERATION_OR_SIGNING");
  const copiesBefore = mirrors;
  await page.locator("#publication-close").click();
  await page.locator("#revision").fill("Add a reset button to the daily counter."); await page.locator("#revise").click();
  await page.waitForFunction(() => document.querySelector("#publish-hint")?.textContent?.includes("Version 2 is ready") || document.querySelector("#execution-activity")?.textContent?.includes("Action stopped"), undefined, {timeout:180000});
  assert((await page.locator("#publish-hint").innerText()).includes("Version 2 is ready"), "REVISION_FAILED:"+await page.locator("#execution-activity").innerText());
  assert(await page.locator("#publish").textContent() === "Publish", "NEW_VERSION_WRONGLY_PUBLISHED");
  await page.locator("#your-applets").click();
  await page.locator(".project-card").filter({ hasText: "Version 2 ready to publish" }).waitFor();
  assert((await page.locator(".project-card").filter({ hasText: "Daily counter" }).innerText()).includes("Unpublished changes"), "NEW_REVISION_PUBLICATION_BADGE_MISSING");
  assert(mirrors === copiesBefore && appletSignatures === 1 && fixture.counts().inferences === 2, "REVISION_PUBLISHED_AUTOMATICALLY");
  assert((await pool.query("SELECT count(*)::int AS count FROM development_publications WHERE publisher=$1", [userPubkey])).rows[0].count === 1, "RESTORE_CREATED_DUPLICATE_PUBLICATION");
  stage("REVISION_VERIFIED");
  // Edit a signed, unfinished version: retain history and require a new signature.
  await page.locator(".project-card").filter({hasText:"Daily counter"}).click();
  rejectCopies = true;
  await page.locator("#publish").click(); await page.getByRole("button", {name:`Remove ${unavailableUrl}`,exact:true}).waitFor();
  await page.locator("#publication-review").click(); await page.locator("#publication-confirm").click();
  await page.locator("#publication-status").filter({hasText:"copies ready. Retry or change destinations."}).waitFor({timeout:60000});
  const prior = (await pool.query<{id:string; artifact_id:string; session_id:string; signed_event:ReturnType<typeof finalizeEvent>}>("SELECT * FROM development_publications WHERE publisher=$1 AND (prepared->>'version')::int=2 ORDER BY created_at DESC LIMIT 1",[userPubkey])).rows[0];
  assert(prior.signed_event && appletSignatures===2, "SECOND_VERSION_NOT_SIGNED");
  await page.locator("#publication-edit").click();
  assert((await page.locator("#publication-metadata-note").innerText()).includes("fresh signature"), "REPLACEMENT_SIGNATURE_NOT_EXPLAINED");
  await page.getByRole("button",{name:`Remove ${unavailableUrl}`,exact:true}).click();
  await page.locator("#publication-title").fill("Daily counter, refreshed");
  await page.locator("#publication-description").fill("Track practice with a reset button.");
  await page.locator("#publication-review").click();
  await page.locator("#publication-review-title").filter({hasText:"Daily counter, refreshed"}).waitFor();
  assert(await page.locator("#publication-confirm").innerText()==="Sign and publish", "REPLACEMENT_REUSED_SIGNATURE");
  const replaced = (await pool.query<{prepared:{supersededBy:string};signed_event:ReturnType<typeof finalizeEvent>}>("SELECT * FROM development_publications WHERE id=$1",[prior.id])).rows[0];
  assert(replaced.prepared.supersededBy && replaced.signed_event.id===prior.signed_event.id, "SIGNED_HISTORY_LOST");
  const editor = new DevelopmentContextVmClient({...connection,reserveSat:"0",actionCeilingSat:"0",providerLabel:"test"}, undefined, generationKey);
  await editor.connect({accountStatus:false});
  try {
    assert((await editor.callTool("development_publication",{action:"submit",id:prior.id,event:prior.signed_event})).code==="PUBLICATION_SUPERSEDED", "STALE_SIGNED_DRAFT_SUBMITTED");
    const replacement = await editor.callTool("development_publication",{action:"status",id:replaced.prepared.supersededBy});
    const signedApplet = finalizeEvent(replacement.template,userKey);
    const badListing = finalizeEvent({...replacement.application.template,content:"tampered"},userKey);
    assert((await editor.callTool("development_publication",{action:"save",id:replacement.id,event:signedApplet,applicationEvent:badListing})).code==="PUBLICATION_APPLICATION_SIGNATURE_MISMATCH", "TAMPERED_APPLICATION_ACCEPTED");
    assert((await editor.callTool("development_publication",{action:"submit",id:replacement.id,event:signedApplet})).code==="PUBLICATION_APPLICATION_SIGNATURE_REQUIRED", "UNSIGNED_APPLICATION_ACCEPTED");
    assert(replacement.servers.length===2 && replacement.fileResults.some((item:any)=>item.state==="verified"), "REPLACEMENT_LOST_VERIFIED_RECEIPTS");
    assert((await unauthorized.callTool("development_publication",{action:"prepare",artifactId:prior.artifact_id,sessionId:prior.session_id,publisher:userPubkey,requestKey:crypto.randomUUID(),title:"stolen",servers:replacement.servers,relays:replacement.relays,replaces:replacement.id})).status==="denied", "CROSS_OWNER_REPLACEMENT");
  } finally {await editor.close();}
  stage("COPY_RETRY");
  rejectCopies = false; await page.locator("#publication-confirm").click(); await page.locator("#publication-result").waitFor({timeout:60000});
  assert(appletSignatures===3 && fixture.counts().inferences===2, "REPLACEMENT_SIGNATURE_OR_GENERATION_COUNT");
  assert(!(await page.locator("#publication-copy-warning").isVisible()), "REMOVED_SERVER_STILL_BLOCKS");
  assert((await fetch(`${cvmBlob}/`)).ok, "BLOSSOM_ORIGIN_CHANGED_ON_RESTART");
  const addressBeforeEdit = await page.locator("#publication-address").inputValue();
  const generationsBeforeEdit = fixture.counts().inferences;
  await page.locator("#publication-edit-published").click();
  await page.locator("#publication-title").fill("Daily counter, shared");
  await page.locator("#publication-description").fill("An updated public description.");
  await page.locator("#publication-hashtags").fill("#Practice"); // Pending input is committed by Review.
  await page.locator("#publication-review").click();
  await page.locator("#publication-review-title").filter({hasText:"Daily counter, shared"}).waitFor();
  assert((await page.locator("#publication-review-hashtags").innerText()).includes("#practice"), "EDIT_HASHTAG_NOT_REVIEWED");
  await page.locator("#publication-confirm").click(); await page.locator("#publication-result").waitFor({timeout:60000});
  assert(await page.locator("#publication-address").inputValue()===addressBeforeEdit, "EDIT_CHANGED_NADDR");
  assert(fixture.counts().inferences===generationsBeforeEdit && appletSignatures===4 && applicationSignatures===4, "EDIT_REGENERATED_OR_DID_NOT_RESIGN");
  const edited = (await pool.query<{signed_event:ReturnType<typeof finalizeEvent>;prepared:unknown}>("SELECT signed_event,prepared FROM development_publications WHERE publisher=$1 AND prepared->>'supersededBy' IS NULL AND (prepared->>'version')::int=2",[userPubkey])).rows[0];
  assert(edited.signed_event.content==="An updated public description." && edited.signed_event.tags.some((tag:string[])=>tag[0]==="t"&&tag[1]==="practice"), "EDIT_METADATA_NOT_SAVED");
  const deliveredEdit = await relay.get([config.relayUrl], { ids:[edited.signed_event.id] }, {maxWait:3000});
  assert(deliveredEdit?.id===edited.signed_event.id, "EDIT_NOT_DELIVERED");
  await page.reload(); await page.getByText("Workspace connected", {exact:true}).waitFor();
  await page.locator("#publish").filter({hasText:"View publication"}).click(); await page.locator("#publication-result").waitFor();
  await page.locator("#publication-edit-published").click();
  assert(await page.locator("#publication-title").inputValue()==="Daily counter, shared" && await page.getByRole("button",{name:"Remove practice",exact:true}).count()===1, "EDIT_NOT_RESTORED");
  stage("METADATA_EDIT_VERIFIED");
  // A restored older build can become the latest publication without new generation.
  await page.locator("#publication-close").click();
  const firstArtifact = await page.locator("#version-picker option").filter({hasText:"Version 1"}).getAttribute("value");
  await page.locator("#version-picker").selectOption(firstArtifact!);
  await page.locator("#restore-version").click(); await page.locator("#restore-status").filter({hasText:"is current"}).waitFor();
  await page.locator("#publish").click(); await page.locator("#publication-result").waitFor();
  await page.locator("#publication-edit-published").click();
  await page.locator("#publication-title").fill("Restored daily counter");
  await page.locator("#publication-review").click(); await page.locator("#publication-confirm").click();
  await page.locator("#publication-result").waitFor({timeout:60000});
  assert(fixture.counts().inferences===generationsBeforeEdit,"RESTORED_PUBLICATION_REGENERATED");
  const restoredOwner = new DevelopmentContextVmClient({...connection,reserveSat:"0",actionCeilingSat:"0",providerLabel:"test"},undefined,generationKey);
  await restoredOwner.connect({accountStatus:false});
  try {
    const project=(await restoredOwner.callTool("projects",{action:"list"})).projects[0];
    assert(project.stage==="published" && project.verifiedVersion===1 && project.publication.version===1 && !project.unpublishedChanges,"RESTORED_PUBLICATION_ORDER_INCORRECT");
    const publication=await restoredOwner.callTool("development_publication",{action:"lookup",sessionId:project.id,artifactId:firstArtifact,publisher:userPubkey});
    assert(publication.latestPublished.version===1 && publication.latestPublished.title==="Restored daily counter","RESTORED_VERSION_NOT_LATEST_PUBLICATION");
  } finally { await restoredOwner.close(); }
  console.log(JSON.stringify({ status: "passed", case: "static-cvm-publication", checks: ["required and optional domains preserved from generated source into signed current-format events", "normalized hashtag chips and both event kinds", "published metadata editing keeps address, uses fresh signatures and no model calls", "edits survive reload", "offline CLI screenshot and kind-32267 application publication", "screenshot hash verified on two destinations", "both signatures persist and republish without model or copy work", "tampered and missing application signatures rejected", "separate static origin and subdirectory", "private operator OAuth", "rate version used", "job views", "all sign-in choices during generation", "real NIP46", "CVM naddr", "CVM-only Blossom writes", "manual and discovered servers", "one complete copy blocks publication in browser and CVM", "two complete copies publish despite third server HTTP 401", "warnings and verified count survive reopen", "saved signature and failures restored without browser journal", "copy retry uses one signature", "verified mirrors and user naddr", "owner-scoped publication lookup", "signed template tamper rejected", "exact event replay and repeated preparation", "pending job details", "published builder and project after CVM restart", "reopen retains address without generation", "revision shows unpublished changes", "CVM metadata ownership and editable signed description", "continue with saved two copies skips uploads and signing", "signed draft destination editing preserves history and rejects stale submission", "one relay confirms despite extra relay failure", "legacy partial success repairs on lookup and startup without republishing", "zero confirmations remain retryable", "compact success with collapsed failure details", "explicit republish from builder and result reuses event, address and files", "republish ownership and last-attempt persistence", "failed resend retains earlier publication", "restored older build becomes latest publication without model work"] }));
} catch (error) { console.error("TEST_STAGE", error, await admin.locator("body").innerText({ timeout: 2000 }).catch(() => "admin page unavailable"), await page.locator("body").innerText({ timeout: 2000 }).catch(() => "workspace unavailable"), errors); throw error; } finally {
  stage("CLEANUP_CLIENT");
  release(); remoteSubscription?.close(); relay.close([config.relayUrl]); relay.destroy(); await unauthorized.close();
  stage("CLEANUP_BROWSER");
  await browser.close(); site.stop(true); destination.stop(true); backup.stop(true); unavailable.stop(true); stage("CLEANUP_POOL"); await pool.end();
  stage("CLEANUP_CVM");
  try { await server.close(); } finally { stage("CLEANUP_STACK"); await stack.down(true); await rm(root, { recursive: true, force: true }); clearInterval(heartbeat); }
}
