/** Presentation edge cases with a controlled clock; service effects are covered separately. */
import { chromium } from "playwright";
import { resolve } from "node:path";
const built = await Bun.build({ entrypoints: [resolve("src/dev-ui/browser/product-workspace.ts"), resolve("src/dev-ui/browser/activity.ts")], target: "browser", format: "esm" });
if (!built.success) throw new Error("PRODUCT_VIEW_BUILD_FAILED");
const scripts = await Promise.all(built.outputs.map(async (file) => ({ name: file.path, content: await file.text() })));
const source = (name: string) => scripts.find((file) => file.name.endsWith(name))!.content;
const server = Bun.serve({ hostname: "127.0.0.1", port: 0, fetch: () => new Response('<!doctype html><html lang="en"><head><title>View test</title></head><body><main id="app"></main></body></html>', { headers: { "content-type": "text/html" } }) });
const browser = await chromium.launch(); const page = await browser.newPage();
const assert = (value: unknown, code: string) => { if (!value) throw new Error(code); };
try {
  await page.goto(`http://127.0.0.1:${server.port}/?chatgpt_error=CHATGPT_SIGN_IN_DECLINED`); await page.clock.install();
  await page.addStyleTag({ content: await Bun.file("src/dev-ui/browser/product.css").text() });
  await page.evaluate(async ({ product, activity }) => {
    const view = await import(URL.createObjectURL(new Blob([product], { type: "text/javascript" })));
    const events = await import(URL.createObjectURL(new Blob([activity], { type: "text/javascript" })));
    const workspace = new view.ProductWorkspace(document.querySelector("#app"), { servicePubkey: "a".repeat(64), providerLabel: "Deterministic fixture", actionCeilingSat: "3250" });
    const live = new events.ExecutionActivity(document.querySelector("#execution-activity"), "Deterministic fixture", (snapshot: unknown) => workspace.progress(snapshot));
    Object.assign(window, { workspace, live }); workspace.connected(true);
  }, { product: source("product-workspace.js"), activity: source("activity.js") });
  assert(await page.locator("#workspace-settings").isVisible(), "AUTH_ERROR_HIDDEN_IN_SETTINGS");
  await page.keyboard.press("Escape");
  await page.locator("#idea").fill('<img src=x onerror="alert(1)"> A focused counter');
  await page.getByRole("button", { name: "Shape my idea" }).click();
  assert(await page.locator("#idea-review img").count() === 0, "DRAFT_INTERPRETED_AS_HTML");
  await page.locator(".budget-details summary").click(); await page.locator("#maximum").fill("2");
  assert(await page.evaluate(() => (window as any).workspace.validate("generate")) === false, "INVALID_BUDGET_ACCEPTED");
  assert(await page.locator("#maximum").evaluate((el) => document.activeElement === el), "INVALID_BUDGET_NOT_FOCUSED");
  await page.locator("#maximum").fill("3250");
  await page.evaluate(() => { const w = window as any; w.workspace.begin("generate"); w.live.begin("Create", "Deterministic fixture"); w.live.receive({ kind: "sent", requestId: "a", tool: "start_session" }); });
  assert((await page.locator("#progress-provider").textContent())?.includes("no model request"), "FIXTURE_HIDDEN_IN_PRODUCT");
  await page.clock.fastForward(16000);
  assert((await page.locator("#progress-title").textContent())?.includes("Still waiting"), "STALE_NOT_VISIBLE_AT_TOP");
  assert(await page.locator("#build-progress").getAttribute("aria-valuenow") === "0", "CLOCK_FAKED_PROGRESS");
  await page.evaluate(() => { const w = window as any; w.live.receive({ kind: "progress", progress: { kind: "stage", requestId: "a", stage: "verify", state: "running", sequence: 1 } }); });
  assert((await page.locator("#progress-title").textContent())?.includes("Checking"), "HEARTBEAT_DID_NOT_RESTORE_STATUS");
  await page.evaluate(() => { const w = window as any; w.workspace.failed("TIMEOUT", true); w.live.finish("Outcome unconfirmed", "uncertain"); w.workspace.settled(); w.workspace.recovery(true); });
  assert(await page.locator("#new-applet").isDisabled(), "UNCERTAIN_RELOAD_CAN_CREATE_DUPLICATE");
  assert(await page.locator("#build-progress").getAttribute("aria-valuenow") === "0", "RECOVERY_SHOWS_PREVIOUS_SUCCESS");
  for (const width of [390, 768, 1440]) {
    await page.setViewportSize({ width, height: 900 });
    assert(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), `PRODUCT_OVERFLOW_${width}`);
    const tiny = await page.locator("button,a,summary,input,select,textarea").evaluateAll((elements) => elements.filter((el) => {
      const rect = el.getBoundingClientRect(); return rect.width > 0 && rect.height > 0 && getComputedStyle(el).visibility !== "hidden" && (rect.width < 44 || rect.height < 44);
    }).map((el) => el.id || el.textContent?.slice(0, 30)));
    assert(tiny.length === 0, `SMALL_TOUCH_TARGETS_${width}:${tiny.join(",")}`);
  }
  await page.emulateMedia({ reducedMotion: "reduce" });
  assert(await page.locator("#progress-fill").evaluate((el) => getComputedStyle(el).transitionDuration) === "0s", "REDUCED_MOTION_NOT_HONORED");
  await page.getByRole("button", { name: "Settings", exact: true }).click();
  await page.keyboard.press("Escape");
  assert(await page.locator("#open-settings").evaluate((el) => document.activeElement === el), "MODAL_FOCUS_LOST");
  console.log(JSON.stringify({ status: "passed", case: "product-view", checks: ["text-only rendering", "budget validation/focus", "fixture labeling", "stale clock", "real stage projection", "uncertain recovery fence", "responsive touch targets", "reduced motion", "dialog focus"] }));
} finally { await browser.close(); server.stop(true); }
