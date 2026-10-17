/** Real private-admin UI, offline synthetic responses. Never opens a live admin. */
import assert from "node:assert/strict";
import { mkdir } from "node:fs/promises";
import { resolve } from "node:path";
import { chromium } from "../../tests/dev-ui/node_modules/playwright";
import { chatGptDevelopmentPricing } from "../../src/dev/chatgpt-model-gateway";

const root = resolve(import.meta.dir, "../..");
const output = resolve(root, "docs/public/images/operators");
const pricing = chatGptDevelopmentPricing("documentation-account", "gpt-6.1-sol");
const fixtures = {
  status: { status: "ok", pricing, apiAccounts: [], busy: false },
  chatgpt: {
    settings: { mode: "chatgpt", accountId: "demo-account", model: "gpt-6.1-sol" },
    accounts: [{ id: "demo-account", label: "operator@example.com", signedIn: true, planEnabled: true, welcomed: true }],
  },
  models: { models: [{ slug: "gpt-6.1-sol", displayName: "GPT-6.1-Sol" }] },
  jobs: {
    pending: [{ id: "checkpoint:demo-waiting-for-funds", kind: "pending", state: "saved", created_at: "2026-10-16T09:15:00Z" }],
    active: [
      { id: "action:demo-building", kind: "action", state: "active", created_at: "2026-10-16T10:05:00Z" },
      { id: "action:demo-needs-checking", kind: "action", state: "usage_unknown", created_at: "2026-10-16T10:00:00Z" },
    ],
    finished: [{ id: "action:demo-completed", kind: "action", state: "verified", created_at: "2026-10-16T09:00:00Z" }],
  },
  job: {
    id: "action:demo-completed", account_id: "b".repeat(64), session_id: "session:demo-reading-counter", state: "verified",
    created_at: "2026-10-16T09:00:00Z", settled_at: "2026-10-16T09:00:30Z", expected_session_version: 1,
    profile_id: pricing.profile.id, price_card_id: pricing.card.id, operation_id: "operation:demo-reading-counter",
    reservation_sat: "3250", receipt_charge: "5", remaining_cap_sat: "3245", remaining_balance_sat: "9995",
    artifact_id: "artifact:sha256:" + "c".repeat(64), model: pricing.profile.model, provider: pricing.profile.provider, diagnostic_json: null,
    billing: [
      { kind: "receipt", amount_sat: "0", committed_at: "2026-10-16T09:00:30Z" },
      { kind: "debit", amount_sat: "-5", committed_at: "2026-10-16T09:00:30Z" },
      { kind: "release", amount_sat: "3245", committed_at: "2026-10-16T09:00:30Z" },
    ],
    worker: [{ state: "completed", completed_at: "2026-10-16T09:00:29Z" }],
    artifacts: [{ artifact_id: "artifact:sha256:" + "c".repeat(64), version: 2, aggregate_sha256: "c".repeat(64), created_at: "2026-10-16T09:00:29Z" }],
  },
};
// Enrich examples with the current job projection; these are not live customer records.
Object.assign(fixtures.job, { title: "Reading counter", action_label: "Revision", category: "finished", price_kind: "development_test", held_sat: "0", billing_status: "settled", request_text: "Make the count easier to read.", usage_receipt: { usage: [{ dimension: "input_tokens", units: "2400" }, { dimension: "output_tokens", units: "1800" }] } });
const examples: any = fixtures.jobs;
examples.review = [examples.active.pop()];
for (const [category, rows] of Object.entries(examples) as [string, any[]][]) for (const row of rows) Object.assign(row, {
  category, title: { active: "Focus timer", pending: "Saved applet", review: "Daily notes", finished: "Reading counter" }[category],
  action_label: row.kind === "pending" ? "Saved request" : "Revision", request_text: category === "finished" ? "Make the count easier to read." : "A small, focused applet.",
  price_kind: "development_test", reservation_sat: "395", held_sat: ["active", "review"].includes(category) ? "395" : "0",
  receipt_charge: category === "finished" ? "5" : null, billing_status: category === "review" ? "unresolved" : category === "finished" ? "settled" : "pending",
});
const built = await Bun.build({ entrypoints: [resolve(root, "src/dev-ui/browser/admin.ts")], target: "browser", format: "esm", plugins: [{
  name: "read-only-admin-documentation", setup(builder) {
    builder.onLoad({ filter: /\/contextvm-client\.ts$/ }, () => ({ loader: "js", contents: `
      export class DevelopmentContextVmClient {
        async connect() { return {}; }
        async close() {}
        async callTool(name, input) {
          window.documentationCalls.push(input);
          if (name !== "cvm_admin") throw new Error("Unexpected tool in documentation capture");
          const samples = window.documentationFixtures;
          if (input.action === "status") return samples.status;
          if (input.action === "exchange_rate") return { status: "ok", exchangeRate: { status: "fresh", quote: { source: "Kraken", usdPerBtc: "80000.00000", fetchedAt: Date.now() } } };
          if (input.action === "jobs") {
            if (window.failJobRefresh) throw new Error("Fixture disconnected");
            const all = Object.values(samples.jobs).flat().filter(row => !input.search || (row.title + row.request_text + row.id).toLowerCase().includes(input.search.toLowerCase()));
            const matching = all.filter(row => input.status === "all" || row.category === input.status);
            return { status: "ok", jobs: matching.slice(input.offset, input.offset + 50), offset: input.offset,
              counts: Object.fromEntries(["pending","active","review","finished"].map(category => [category, all.filter(row => row.category === category).length])), total: matching.length,
              totals: [{ price_kind: "development_test", charged_sat: "5", review_held_sat: "395" }] };
          }
          if (input.action === "job" && input.id === samples.job.id) return { status: "ok", job: samples.job };
          if (input.action === "chatgpt" && input.operation === "status") return samples.chatgpt;
          if (input.action === "chatgpt" && input.operation === "models") return samples.models;
          throw new Error("Admin mutations and external sign-in are disabled in documentation capture");
        }
      }` }));
  },
}] });
assert(built.success, built.logs.map(log => log.message).join("\n"));
const assets = new Map<string, { body: string; type: string }>([
  ["/admin", { body: await Bun.file(resolve(root, "src/dev-ui/browser/admin.html")).text(), type: "text/html" }],
  ["/admin.js", { body: await built.outputs[0]!.text(), type: "text/javascript" }],
  ["/cvm.json", { body: JSON.stringify({ servicePubkey: "a".repeat(64), relayUrl: "ws://127.0.0.1:1" }), type: "application/json" }],
]);
for (const name of ["product.css", "admin.css"]) assets.set(`/${name}`, { body: await Bun.file(resolve(root, `src/dev-ui/browser/${name}`)).text(), type: "text/css" });
const server = Bun.serve({ hostname: "127.0.0.1", port: 0, fetch(request) {
  const asset = assets.get(new URL(request.url).pathname);
  return asset ? new Response(asset.body, { headers: { "content-type": asset.type } }) : new Response("Not found", { status: 404 });
} });
const origin = `http://127.0.0.1:${server.port}`;
const browser = await chromium.launch({ headless: true });
const page = await browser.newPage({ viewport: { width: 1280, height: 1450 }, deviceScaleFactor: 1, locale: "en-US", timezoneId: "UTC", reducedMotion: "reduce" });
page.setDefaultTimeout(15000);
const errors: string[] = [], screenshots: { file: string; width: number; height: number }[] = [];
page.on("pageerror", error => errors.push(error.message));
await page.route("**/*", route => route.request().url().startsWith(origin + "/") ? route.continue() : route.abort());
await page.routeWebSocket(/.*/, socket => socket.close());
await page.addInitScript(fixtures => { Object.assign(window, { documentationFixtures: fixtures, documentationCalls: [] }); }, fixtures);

async function capture(name: string, selector: string, bottomSelector?: string) {
  await page.evaluate(() => document.fonts.ready);
  await page.mouse.move(0, 0);
  const target = page.locator(selector);
  await target.scrollIntoViewIfNeeded();
  let bytes: Buffer;
  if (bottomSelector) {
    const top = await target.boundingBox(), bottom = await page.locator(bottomSelector).boundingBox();
    assert(top && bottom && top.y >= 0 && bottom.y + bottom.height < page.viewportSize()!.height, "Capture region must fit the viewport");
    bytes = await page.screenshot({ path: `${output}/${name}.png`, clip: { x: top.x, y: top.y, width: top.width, height: bottom.y + bottom.height + 12 - top.y } });
  } else bytes = await target.screenshot({ path: `${output}/${name}.png`, animations: "disabled" });
  screenshots.push({ file: `${name}.png`, width: bytes.readUInt32BE(16), height: bytes.readUInt32BE(20) });
}

try {
  await mkdir(output, { recursive: true });
  await page.goto(`${origin}/admin`, { waitUntil: "networkidle" });
  await page.setViewportSize({ width: 780, height: 800 });
  await capture("access", "#admin-login");
  // This disposable key has no authority; the capture transport has no network implementation.
  await page.locator("#operator-key").fill("1".repeat(64));
  await page.getByRole("button", { name: "Connect to CVM", exact: true }).click();
  await page.locator("[data-state=all][aria-pressed=true]").waitFor();
  await page.locator("#jobs tr").first().waitFor();
  await page.waitForFunction(() => document.querySelector("#jobs-exchange")?.textContent?.includes("Kraken"));
  assert((await page.locator("#jobs-overview").innerText()).includes("$0.004 USD"));
  assert((await page.locator("#jobs").innerText()).includes("$0.316 USD"));
  await page.locator("#provider-navigation").click();
  await page.locator("#chatgpt-model").waitFor();
  await page.waitForFunction(() => document.querySelector<HTMLSelectElement>("#chatgpt-model")?.value === "gpt-6.1-sol");
  assert(await page.locator("#operator-key").inputValue() === "");
  await page.setViewportSize({ width: 1280, height: 1800 });
  await capture("subscription", ".workspace-controls", "#chatgpt-status");
  await capture("rates", "#rates-panel");
  assert((await page.locator("#rates-example-usd").innerText()).includes("$0.0096 USD"));
  await page.locator("#profit-value").fill("20");
  await capture("profit", ".profit-panel");
  await page.locator("#profit-value").fill("0");
  await page.getByText("Add an API account", { exact: true }).click();
  await page.locator("#api-label").fill("Development API account");
  await capture("api-account", "#api-form");
  await page.getByText("Add an API account", { exact: true }).click();
  for (const state of ["all", "active", "review", "pending", "finished"]) {
    await page.locator(`[data-state="${state}"]`).click();
    const first = (state === "all" ? Object.values(examples).flat() : examples[state])[0];
    await page.locator('[data-job-id="' + first.id + '"]').waitFor();
    await capture(`jobs-${state}`, ".admin-jobs");
  }
  await page.locator('[data-job-id="action:demo-completed"]').click();
  await page.locator("#job-detail").waitFor();
  assert((await page.locator("#job-detail").innerText()).includes("$0.004 USD"));
  await capture("job-details", "#job-detail");
  await page.getByRole("button", { name: "Close job details" }).click();
  await page.locator('[data-state="all"]').click();
  await page.getByLabel("Search jobs", { exact: true }).fill("reading");
  await page.waitForFunction(() => document.querySelector("#jobs-range")?.textContent === "1–1 of 1 jobs");
  await page.getByLabel("Search jobs", { exact: true }).fill("no matching applet");
  await page.getByText("No jobs match your search.", { exact: true }).waitFor();
  await page.getByLabel("Search jobs", { exact: true }).fill("");
  await page.waitForFunction(() => document.querySelectorAll("#jobs button").length === 4);
  await page.evaluate(() => { (window as any).failJobRefresh = true; });
  await page.locator("#jobs-refresh").click();
  await page.getByText("Could not refresh jobs. Your last results are still shown. Try Refresh.", { exact: true }).waitFor();
  assert(await page.locator("#jobs button:not([disabled])").count() === 4, "Refresh failure must leave old rows usable");
  await page.evaluate(() => { (window as any).failJobRefresh = false; });
  await page.locator("#jobs-refresh").click();
  for (const width of [320, 375, 768, 1280]) {
    await page.setViewportSize({ width, height: 1050 });
    await page.locator(".admin-jobs").scrollIntoViewIfNeeded();
    assert(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), "Admin overflow at " + width);
    await page.locator('[data-job-id="action:demo-completed"]').click();
    assert(await page.locator("#job-detail").evaluate(el => el.scrollWidth <= el.clientWidth), "Job details overflow at " + width);
    await page.getByRole("button", { name: "Close job details" }).click();
    if (width === 375) await capture("jobs-mobile", ".admin-jobs");
  }
  await page.evaluate(() => {
    const fixture = (window as any).documentationFixtures;
    fixture.jobs.finished = Array.from({ length: 55 }, (_, i) => ({ ...fixture.jobs.finished[0], id: "page-job-" + i }));
  });
  await page.locator('[data-state="finished"]').click();
  await page.waitForFunction(() => document.querySelector("#jobs-range")?.textContent === "1–50 of 55 jobs");
  await page.locator("#jobs-next").click();
  await page.waitForFunction(() => document.querySelector("#jobs-range")?.textContent === "51–55 of 55 jobs");
  assert(await page.locator("#jobs-next").isDisabled());
  await page.locator("#jobs-prev").click();
  await page.waitForFunction(() => document.querySelector("#jobs-range")?.textContent === "1–50 of 55 jobs");
  // Every recorded command must remain read-only, including component startup calls.
  const calls = await page.evaluate(() => (window as any).documentationCalls as { action: string; operation?: string }[]);
  assert(calls.every(call => ["status", "exchange_rate", "jobs", "job"].includes(call.action) || call.action === "chatgpt" && ["status", "models"].includes(call.operation!)));
  assert.deepEqual(errors, []);
  await page.getByRole("button", { name: "Lock admin" }).click();
  await page.locator("#admin-login").waitFor();
  assert(await page.evaluate(() => sessionStorage.length === 0));
  await Bun.write(`${output}/capture.json`, JSON.stringify({ source: "Current admin HTML, CSS and browser code; offline read-only sample responses, demo account and jobs.", regeneration: "bun docs/scripts/capture-operator-screenshots.ts", screenshots }, null, 2) + "\n");
  console.log(`Captured ${screenshots.length} operator screenshots; only read-only fixture calls, no live services.`);
} finally { await browser.close(); server.stop(true); }
