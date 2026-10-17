/** Capture actual workspace components with disposable, offline presentation data.
 * This is illustration, not evidence of generation, verification or publication.
 * No live CVM, account, model, signer, relay or Blossom server is contacted.
 */
import assert from "node:assert/strict";
import { mkdir } from "node:fs/promises";
import { resolve } from "node:path";
import { chromium } from "../../tests/dev-ui/node_modules/playwright";
import { getPublicKey } from "nostr-tools/pure";
import { naddrEncode } from "nostr-tools/nip19";

const root = resolve(import.meta.dir, "../..");
const output = resolve(root, "docs/public/images/users");
const modules = ["product-workspace", "activity", "publication-workspace", "projects-workspace", "remix-workspace"];
const built = await Bun.build({
  entrypoints: modules.map(name => resolve(root, `src/dev-ui/browser/${name}.ts`)), target: "browser", format: "esm",
  plugins: [{ name: "offline-documentation", setup(builder) {
    builder.onLoad({ filter: /\/contextvm-client\.ts$/ }, () => ({ loader: "js", contents: `
      export const browserSignerKey = () => "1".repeat(64);
      export class DevelopmentContextVmClient {
        constructor(bootstrap, activity, signer) { this.account = !!signer; }
        async connect() { return {}; }
        async close() {}
        async callTool(name, input) {
          if (name !== "projects" || input.action !== "list") throw new Error("Unexpected CVM effect");
          return { status: "ok", projects: window.sampleProjects.filter(p => p.account === this.account) };
        }
      }` }));
    builder.onLoad({ filter: /\/relay-discovery\.ts$/ }, () => ({ loader: "js", contents: `
      export const discoverWriteRelays = async () => [];
      export const suggestRelays = async () => [];
    ` }));
    builder.onResolve({ filter: /^\.\/blossom-client$/ }, args => args.importer.endsWith("publication-workspace.ts")
      ? { path: "blossom", namespace: "docs-fixture" } : undefined);
    builder.onLoad({ filter: /.*/, namespace: "docs-fixture" }, () => ({ loader: "js", contents: `
      export { blossomServer } from ${JSON.stringify(resolve(root, "src/dev-ui/browser/blossom-client.ts"))};
      export const discoverBlossom = async () => [];
      export const propagateBlobs = async () => { throw new Error("Publication is disabled in screenshots"); };
    ` }));
    builder.onResolve({ filter: /^pino$/ }, () => ({ path: resolve(root, "src/dev-ui/browser/pino-browser-shim.ts") }));
  } }],
});
assert(built.success, built.logs.map(log => log.message).join("\n"));
const scripts = Object.fromEntries(await Promise.all(built.outputs.map(async file => [file.path.split("/").at(-1)!, await file.text()])));
const server = Bun.serve({ hostname: "127.0.0.1", port: 0, fetch: () => new Response(
  '<!doctype html><html lang="en"><head><meta name="viewport" content="width=device-width, initial-scale=1"><title>Documentation examples</title></head><body><main id="app"></main></body></html>',
  { headers: { "content-type": "text/html" } },
) });
const origin = `http://127.0.0.1:${server.port}`;
const browser = await chromium.launch({ headless: true });
const page = await browser.newPage({ viewport: { width: 1280, height: 960 }, deviceScaleFactor: 1, locale: "en-US", timezoneId: "UTC", reducedMotion: "reduce" });
page.setDefaultTimeout(15000);
const errors: string[] = [], screenshots: { file: string; width: number; height: number }[] = [];
page.on("pageerror", error => errors.push(error.message));
// Independent network fence, even if an imported component changes later.
await page.route("**/*", route => route.request().url().startsWith(origin + "/") ? route.continue() : route.abort());
await page.routeWebSocket(/.*/, socket => socket.close());
const pubkey = getPublicKey(new Uint8Array(32).fill(2));
const address = naddrEncode({ pubkey, kind: 35129, identifier: "reading-counter-demo" });
const timerAddress = naddrEncode({ pubkey, kind: 35129, identifier: "focus-timer-demo" });

async function capture(name: string, selector?: string) {
  const originalViewport = page.viewportSize()!;
  await page.evaluate(() => document.fonts.ready);
  await page.mouse.move(0, 0);
  if (selector) {
    const bounds = await page.locator(selector).boundingBox();
    assert(bounds, `Missing screenshot region: ${selector}`);
    // Fit tall panels between the real sticky header and footer before cropping.
    await page.setViewportSize({ width: originalViewport.width, height: Math.max(originalViewport.height, Math.ceil(bounds.height + 300)) });
    await page.locator(selector).scrollIntoViewIfNeeded();
  }
  // Native browser capture; do not restyle or retouch application controls.
  const bytes = selector
    ? await page.locator(selector).screenshot({ path: `${output}/${name}.png`, animations: "disabled" })
    : await page.screenshot({ path: `${output}/${name}.png`, animations: "disabled" });
  screenshots.push({ file: `${name}.png`, width: bytes.readUInt32BE(16), height: bytes.readUInt32BE(20) });
  await page.setViewportSize(originalViewport);
}

try {
  await mkdir(output, { recursive: true });
  await page.goto(origin);
  await page.clock.install({ time: new Date("2026-10-16T12:00:00Z") });
  await page.addStyleTag({ content: await Bun.file(resolve(root, "src/dev-ui/browser/product.css")).text() });
  await page.evaluate(async ({ scripts, pubkey, address, timerAddress }) => {
    const load = (name: string) => import(URL.createObjectURL(new Blob([scripts[`${name}.js`]], { type: "text/javascript" })));
    const [{ ProductWorkspace }, { ExecutionActivity }, { PublicationWorkspace }, { ProjectsWorkspace }, { RemixWorkspace }] = await Promise.all(
      ["product-workspace", "activity", "publication-workspace", "projects-workspace", "remix-workspace"].map(load),
    );
    const w = window as any;
    const bootstrap = { servicePubkey: "a".repeat(64), relayUrl: "ws://127.0.0.1:1", providerLabel: "Deterministic fixture", actionCeilingSat: "3250" };
    const workspace = new ProductWorkspace(document.getElementById("app"), bootstrap);
    const live = new ExecutionActivity(document.getElementById("execution-activity"), bootstrap.providerLabel, (snapshot: unknown) => workspace.progress(snapshot));
    const version = { sessionId: "session:docs", artifactId: "artifact:" + "a".repeat(64), version: 2 };
    const client = { callTool: async (name: string, input: any) => {
      if (name !== "development_publication") throw new Error("Unexpected CVM effect");
      if (input.action === "preview") return { address };
      if (input.action === "lookup") return { status: "ok", current: w.samplePublication ?? null, latestPublished: w.samplePublication ?? null };
      if (input.action === "metadata") return {status:"ok", ...version, title:"Reading-session counter", description:"Count your daily reading sessions with a simple, focused counter.", basis:"project", tags:[["requires","storage"]], files:[]};
      if (input.action !== "prepare") throw new Error("Publication is disabled in screenshots");
      return w.samplePrepared = { id: "publication:docs", status: "prepared", artifactId: version.artifactId, publisher: publication.identity.pubkey,
        title:input.title, description:input.description, template: { tags: [["title",input.title],["description",input.description],["requires","storage"]] }, servers: input.servers, relays: input.relays, files: [], version: 2, expiresAt: Date.now() + 60000 };
    } };
    const publication = new PublicationWorkspace(bootstrap, () => client, () => w.selectedVersion);
    w.sampleProjects = [
      { title: "Reading-session counter", stage: "verified", verifiedVersion: 2, account: true },
      { title: "Quiet focus timer", stage: "active", verifiedVersion: 0, account: true },
      { title: "Morning checklist", stage: "verified", verifiedVersion: 1, account: false },
    ].map((p, i) => ({ ...p, id: `project:docs-${i}`, createdAt: `2026-10-${16 - i}T10:00:00Z` }));
    new ProjectsWorkspace(bootstrap, publication.identity, () => live.running, async () => {});
    const manifest = { naddr: address, title: "Reading-session counter", description: "A quiet place to count a little daily reading.", event: { pubkey, created_at: 1792144800 }, artifactHash: "b".repeat(64), servers: [], schema: "artifact" };
    new RemixWorkspace({ resolve: async () => ({ manifest, html: "<p>Sample applet</p>" }), browse: async () => [manifest,
      { ...manifest, naddr: timerAddress, title: "A quiet focus timer", description: "One task. A little focus. Time for a break." },
    ] }, publication.identity, bootstrap.servicePubkey, () => live.running);
    Object.assign(w, { workspace, live, publication, version }); workspace.connected(true);
    workspace.estimates({ unit:"test_sat", windowDays:30,
      create:{samples:4,basis:"create",cost:{low:"120",high:"300"},seconds:{low:45,high:90}},
      revise:{samples:3,basis:"revise",cost:{low:"80",high:"180"},seconds:{low:90,high:180}},
    });
  }, { scripts, pubkey, address, timerAddress });

  await page.locator("#idea").fill("A reading-session counter with Add and Reset buttons. Show today’s total in large text and use a quiet green theme.");
  await capture("create");
  await page.locator("#idea-next").click();
  await page.locator(".budget-details summary").click();
  await capture("setup", "#setup-step");

  await page.evaluate(() => { const w = window as any; w.workspace.begin("generate"); w.live.begin("Create", "Deterministic fixture"); w.live.receive({ kind: "sent", requestId: "docs", tool: "start_session" }); });
  for (const [sequence, stage, state] of [[1, "admission", "completed"], [2, "model", "completed"], [3, "build", "running"], [4, "build", "completed"], [5, "verify", "running"]]) {
    await page.clock.fastForward(1000);
    await page.evaluate(event => (window as any).live.receive({ kind: "progress", progress: { kind: "stage", requestId: "docs", ...event } }), { sequence, stage, state });
  }
  await capture("build-progress", "#product-progress");
  await capture("preview-status", ".preview-panel");
  await page.locator("#execution-details summary").click();
  await capture("execution-details", "#execution-activity");
  await page.locator("#execution-details summary").click();

  await page.evaluate(async () => {
    const w = window as any; w.selectedVersion = w.version;
    w.workspace.actionCharge("160"); w.workspace.completed(w.version); w.workspace.versions([{ ...w.version, artifactId: "artifact:" + "b".repeat(64), version: 1 }, w.version], w.version, async () => {});
    w.workspace.settled(); w.live.finish("Preview ready", "completed"); await w.publication.version();
    // A sample applet inside the real preview frame, not a generated build claim.
    const frame = document.querySelector<HTMLIFrameElement>("#preview")!; frame.hidden = false;
    frame.srcdoc = `<!doctype html><html lang="en"><meta name="viewport" content="width=device-width"><title>Sample reading counter</title><style>body{margin:0;background:#f1f4ea;color:#264535;font:18px system-ui;display:grid;place-content:center;text-align:center;min-height:100vh}h1{font-size:26px;font-weight:500}output{font-size:100px;line-height:1.3}p{color:#526450}button{font:inherit;border:1px solid #82937d;border-radius:32px;padding:12px 28px;color:inherit;background:transparent}button:first-child{background:#264535;color:#fff}</style><h1>A little reading, every day.</h1><output>3</output><p>sessions today</p><div><button onclick="document.querySelector('output').textContent++">Add a session</button> <button onclick="document.querySelector('output').textContent=0">Reset</button></div></html>`;
  });
  await page.locator("#revision").fill("Ask for confirmation before resetting the counter.");
  await page.setViewportSize({ width: 1280, height: 1120 });
  await page.locator("#app-content").evaluate(el => el.scrollTop = 0);
  await page.frameLocator("#preview").getByRole("heading").waitFor();
  await capture("revise");
  await capture("revision-composer", ".conversation");
  await page.setViewportSize({ width: 1280, height: 960 });

  await page.locator("#nostr-sign-in").click();
  await page.locator("#nostr-qr svg").waitFor();
  // Crop above the QR: no connection URI, pairing secret or live account in docs.
  const dialog = await page.locator("#nostr-identity").boundingBox();
  const hint = await page.locator("#nostr-extension-hint").boundingBox();
  assert(dialog && hint);
  const clip = { x: dialog.x, y: dialog.y, width: dialog.width, height: hint.y + hint.height + 16 - dialog.y };
  const identityBytes = await page.screenshot({ path: `${output}/sign-in.png`, clip });
  screenshots.push({ file: "sign-in.png", width: identityBytes.readUInt32BE(16), height: identityBytes.readUInt32BE(20) });
  await page.evaluate(pubkey => {
    (window as any).nostr = { getPublicKey: async () => pubkey, signEvent: async () => { throw new Error("Signing disabled in screenshots"); },
      nip44: { encrypt: async () => { throw new Error("Encryption disabled"); }, decrypt: async () => { throw new Error("Decryption disabled"); } } };
    window.dispatchEvent(new Event("nostr:ready"));
  }, pubkey);
  await page.locator("#nostr-extension").click();
  await page.locator("#nostr-identity").waitFor({ state: "hidden" });
  await page.locator("#your-applets").click();
  await page.waitForFunction(() => document.querySelectorAll(".project-card").length === 3);
  await capture("projects");
  await page.locator("#browse-applets").click();
  await page.locator(".discovery-card").first().waitFor();
  await capture("explore");
  await page.locator("#workspace-home").click();
  await page.locator("#publish").click();
  await page.locator("#publication-discovery").filter({ hasText: "No server list" }).waitFor();
  await page.locator("#publication-title").fill("Reading-session counter");
  for (const [id, value] of [["publication-servers", "https://blossom.example.com"], ["publication-servers", "https://backup.example.com"], ["publication-servers", "https://unavailable.example.com"], ["publication-relays", "wss://relay.example.com"]]) {
    await page.locator(`#${id}`).fill(value); await page.locator(`#${id}`).press("Enter");
  }
  await capture("publish-destinations", "#publish-step");
  await page.locator("#publication-review").click();
  await page.locator("#publication-review-panel details").evaluate((el: HTMLDetailsElement) => el.open = true);
  await capture("publish-review", "#publish-step");
  await page.locator("#publication-advanced").evaluate((el:HTMLDetailsElement)=>el.open=true);
  await capture("publish-advanced", "#publish-step");
  await page.locator("#publication-advanced").evaluate((el:HTMLDetailsElement)=>el.open=false);
  await page.locator("#publication-close").click();
  await page.evaluate(({ address, origin }) => {
    const w = window as any;
    // Read-only presentation fixture for a completed publication; no signing,
    // file upload or relay publication is performed by this capture.
    w.samplePublication = { ...w.samplePrepared, status: "published", address, url: origin,
      publishedAt: "2026-10-16T12:00:00Z", files: [{ path: "index.html", sha256: "a".repeat(64), bytes: 2048, url: origin, type: "text/html" }],
      fileResults: [{ server: "https://blossom.example.com", file: "index.html", state: "verified" }, { server: "https://backup.example.com", file: "index.html", state: "verified" }, { server: "https://unavailable.example.com", file: "index.html", state: "failed", detail: "Server declined upload (401)" }],
      relays:["wss://relay.example.com","wss://unavailable.example.com"], relayResults: [{ relay: "wss://relay.example.com", state: "published" },{relay:"wss://unavailable.example.com",state:"failed",detail:"No confirmation received."}] };
  }, { address, origin });
  await page.locator("#publish").click(); await page.locator("#publication-result").waitFor();
  await capture("publish-confirmed", "#publish-step");
  await page.locator("#publication-close").click();
  await page.locator("#new-applet").click();
  await page.locator("#remix-mode").click();
  await page.locator("#remix-address").fill(address);
  await page.clock.fastForward(500);
  await page.locator("#remix-status").filter({ hasText: "File verified" }).waitFor();
  await page.locator("#idea").fill("Turn this into a daily sketching counter. Keep the large buttons and quiet colours.");
  await capture("remix", "#idea-step");
  assert.deepEqual(errors, []);
  await Bun.write(resolve(output, "capture.json"), JSON.stringify({
    source: "Current workspace components and CSS; offline sample data, simulated service states and sample iframe content.",
    regeneration: "bun docs/scripts/capture-user-screenshots.ts", screenshots,
  }, null, 2) + "\n");
  console.log(`Captured ${screenshots.length} user-guide screenshots without live services.`);
} finally { await browser.close(); server.stop(true); }
