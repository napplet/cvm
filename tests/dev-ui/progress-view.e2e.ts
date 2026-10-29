import { chromium } from "playwright";
import { resolve } from "node:path";

const build = await Bun.build({ entrypoints: [resolve("src/dev-ui/browser/activity.ts")], target: "browser", format: "esm" });
if (!build.success) throw new Error("ACTIVITY_BUILD_FAILED");
const script = await build.outputs[0]!.text();
const browser = await chromium.launch({ headless: true });
const page = await browser.newPage();
const assert = (condition: unknown, message: string) => { if (!condition) throw new Error(message); };
try {
  await page.clock.install();
  await page.setContent('<section id="activity"></section>');
  await page.evaluate(async (source) => {
    const module = await import(URL.createObjectURL(new Blob([source], { type: "text/javascript" })));
    (window as any).activity = new module.ExecutionActivity(document.querySelector("#activity"));
    (window as any).activity.begin("Generate", "Deterministic fixture");
    (window as any).activity.receive({ kind: "sent", requestId: "current", tool: "start_session" });
  }, script);
  assert((await page.locator("#activity-provider").textContent())?.includes("no model request"), "FIXTURE_NOT_EXPLICIT");
  await page.clock.fastForward(16000);
  assert((await page.locator("#activity-connection").textContent())?.includes("No server update for 16s"), "STALE_REQUEST_NOT_VISIBLE");
  await page.evaluate(() => {
    const activity = (window as any).activity;
    const progress = { requestId: "current", sequence: 1, stage: "verify", state: "running", kind: "stage" };
    activity.receive({ kind: "progress", progress: { ...progress, requestId: "foreign", stage: "model" } });
    activity.receive({ kind: "progress", progress });
  });
  assert(!(await page.locator("#activity-events").textContent())?.includes("Model operation"), "FOREIGN_REQUEST_RENDERED");
  assert((await page.locator("#activity-connection").textContent())?.includes("Server update 0s ago"), "LIVENESS_NOT_RESTORED");
  await page.evaluate(() => {
    const activity = (window as any).activity;
    activity.receive({ kind: "progress", progress: { requestId: "current", sequence: 2, stage: "verify", state: "failed", kind: "stage", diagnostic: { file: "src/main.ts", line: 4, column: 1, code: "TS2554", arguments: { expected: 1, received: 0 } } } });
    activity.finish("Action stopped", "failed");
    activity.receive({ kind: "progress", progress: { requestId: "current", sequence: 3, stage: "preview", state: "completed", kind: "stage" } });
  });
  assert((await page.locator("#activity-current").textContent()) === "Action stopped · Check guidance and TypeScript", "FAILED_STAGE_LOST");
  assert((await page.locator("#activity-connection").textContent()) === "src/main.ts:4:1 · TS2554: Expected 1 arguments, received 0.", "COMPILER_DIAGNOSTIC_LOST");
  assert(await page.locator("#activity").getAttribute("data-state") === "failed", "LATE_EVENT_REOPENED_ACTION");
  await page.evaluate(() => { const activity = (window as any).activity; activity.begin("Revise", "ChatGPT plan"); activity.finish("Outcome unconfirmed", "uncertain"); });
  assert((await page.locator("#activity-connection").textContent())?.includes("may still be running"), "UNCERTAINTY_NOT_VISIBLE");
  assert(!(await page.locator("#activity-events").textContent())?.includes("TypeScript"), "OLD_ACTION_EVENTS_RETAINED");
  assert(!(await page.locator("#activity-connection").textContent())?.includes("TS2554"), "OLD_DIAGNOSTIC_RETAINED");
  await page.evaluate(() => {
    const activity = (window as any).activity;
    activity.begin("Generate", "ChatGPT plan");
    activity.receive({ kind: "sent", requestId: "finished", tool: "start_session" });
    activity.receive({ kind: "response", requestId: "finished", tool: "start_session" });
    activity.finish("Outcome unconfirmed", "uncertain");
    activity.explainFailure("ChatGPT plan or app usage limit reached.");
  });
  assert((await page.locator("#activity-current").textContent()) === "Generation stopped · provider outcome unconfirmed", "FINISHED_REQUEST_SHOWN_AS_RUNNING");
  assert((await page.locator("#activity-connection").textContent())?.includes("The server finished this request"), "FINISHED_REQUEST_DETAIL_MISSING");
  assert((await page.locator("#activity-connection").textContent())?.includes("usage limit reached"), "PROVIDER_ERROR_NOT_VISIBLE");
  console.log(JSON.stringify({ status: "passed", case: "progress-view", checks: ["fixture", "stale", "recovery", "isolation", "failed-stage", "late-events", "uncertain", "server-finished", "provider-error"] }));
} finally { await browser.close(); }
