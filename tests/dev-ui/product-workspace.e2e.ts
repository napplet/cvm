/** Product UI → OAuth fixture → real relay, SQL, Docker worker and sandboxed Paja. */
import { chromium } from "playwright";
import { openFixtureAdmin } from "./operator-fixture";
import { mkdtemp, mkdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { developmentStack, createDevelopmentPool } from "../../scripts/dev-payments";
import { createDevelopmentContextVmServer } from "../../src/dev-ui/contextvm-server";
import { chatGptFixture } from "../fixtures/chatgpt";

const assert = (value: unknown, code: string) => { if (!value) throw new Error(code); };
const fixture = chatGptFixture(); fixture.setSparseCompletion(true);
let release!: () => void;
const gate = new Promise<void>((resolve) => { release = resolve; });
let first = true;
const fixtureFetch: typeof fixture.fetch = async (input, init) => {
  const response = await fixture.fetch(input, init);
  if (!String(input).endsWith("/responses") || !first) return response;
  first = false; const reader = response.body!.getReader();
  return new Response(new ReadableStream({ async start(controller) {
    try { const chunk = await reader.read(); if (chunk.value) controller.enqueue(chunk.value); await gate; for (;;) { const next = await reader.read(); if (next.done) break; controller.enqueue(next.value); } controller.close(); } catch (error) { controller.error(error); }
  } }), { headers: response.headers });
};
const stack = developmentStack(true); const config = await stack.up();
const stateRoot = await mkdtemp(join(tmpdir(), "applet-broker-e2e-"));
const server = await createDevelopmentContextVmServer({ config, stateRoot, chatGptFetch: fixtureFetch }).catch(async (error) => { await stack.down(true); await rm(stateRoot, { recursive: true, force: true }); throw error; });
const pool = createDevelopmentPool(config.databaseUrl);
const browser = await chromium.launch({ headless: true });
const page = await browser.newPage({ viewport: { width: 1440, height: 1100 } });
const errors: string[] = []; const requests: string[] = [];
page.on("pageerror", (error) => errors.push(error.message));
page.on("request", (request) => requests.push(new URL(request.url()).pathname));
const evidence = resolve(".local/development-gui-evidence"); await mkdir(evidence, { recursive: true });
async function ready(version: number) {
  await page.waitForFunction((n) => document.querySelector("#version-picker option:checked")?.textContent === `Version ${n} · latest` && document.querySelector("#build-progress")?.getAttribute("aria-valuenow") === "5", version, { timeout: 180_000 });
  assert(await page.locator("#product-notice").isHidden(), "SUCCESS_SHOWN_AS_FAILURE");
  await server.assertGenerationSettlement();
}
async function screenshot(name: string, width: number) {
  await page.setViewportSize({ width, height: 1000 });
  assert(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), `OVERFLOW_${name}_${width}`);
  await page.screenshot({ path: join(evidence, `applet-${name}-${width}.png`), fullPage: true });
}
try {
  const admin = await browser.newPage(); await openFixtureAdmin(admin, server.url, stateRoot, fixture);
  await page.goto(server.url); await page.getByText("Workspace connected", { exact: true }).waitFor();
  await page.getByRole("button", { name: "Shape my idea" }).click();
  assert(await page.locator("#idea-step").isVisible() && await page.locator("#idea-validation").textContent(), "EMPTY_IDEA_ADVANCED");
  for (const width of [390, 768, 1440]) await screenshot("idea", width);
  await page.locator("#idea").fill("A daily practice counter with a large add button");
  await page.locator("#idea").press("Control+Enter");
  await page.locator("#setup-step").waitFor();
  await page.reload(); await page.locator("#setup-step").waitFor();
  assert((await page.locator("#idea-review").textContent())?.includes("daily practice counter"), "DRAFT_LOST_ON_RELOAD");
  await page.locator("#model-summary").filter({ hasText: "ChatGPT subscription" }).waitFor();
  assert(await page.locator("#setup-step").isVisible(), "OAUTH_LOST_GUIDED_STEP");
  assert(fixture.counts().inferences === 0, "SIGN_IN_STARTED_GENERATION");
  for (const width of [390, 768, 1440]) await screenshot("setup", width);
  await page.getByRole("button", { name: "Create my applet" }).click();
  await page.locator('#activity-events [data-stage="model_stream"]').waitFor({ state: "attached", timeout: 30000 });
  assert((await page.locator("#progress-title").textContent()) === "Bringing your idea to life", "MODEL_PROGRESS_NOT_VISIBLE");
  assert(await page.locator("#build-progress").getAttribute("aria-valuenow") === "1", "PREMATURE_COMPLETE_PROGRESS");
  assert(await page.locator("#revise").isDisabled(), "REVISION_ENABLED_DURING_GENERATION");
  assert((await page.locator("#revision-blocked-reason").innerText()).includes("still running"), "RUNNING_REVISION_BLOCK_UNEXPLAINED");
  await screenshot("generating", 1440);
  // Close the page's connection while generation is still active, then recover the exact request.
  await page.reload(); await page.getByText("Workspace connected", { exact: true }).waitFor();
  await page.getByRole("button", { name: "Check original request", exact: true }).click();
  assert(await page.locator("#new-applet").isDisabled(), "NEW_ACTION_ALLOWED_DURING_RECOVERY");
  release(); await ready(1);
  assert(fixture.counts().inferences === 1, "RECOVERY_REDISPATCHED_INFERENCE");
  const frame = page.frameLocator("#preview").frameLocator("iframe").first();
  await frame.getByRole("button", { name: "Add", exact: true }).click(); await frame.getByText("1", { exact: true }).waitFor();
  const sandbox = await page.frameLocator("#preview").locator("iframe").first().getAttribute("sandbox");
  assert(sandbox === "allow-scripts", "PREVIEW_SANDBOX_CHANGED");
  assert(await page.frameLocator("#preview").locator("header.bar").isHidden() && await page.frameLocator("#preview").locator("footer.bar").isHidden(), "DEVELOPER_CHROME_IN_PRODUCT");
  await page.getByLabel("What would you like to change?", { exact: true }).fill("Make the counter title shorter");
  await page.locator("#revision").press("Control+Enter"); await ready(2);
  assert(await page.locator("#revision").inputValue() === "", "SUCCESSFUL_REVISION_DRAFT_NOT_CLEARED");
  assert((await page.locator("#conversation-messages").textContent())?.includes("Make the counter title shorter"), "REVISION_NOT_IN_CHAT");
  await page.getByLabel("Preview version", { exact: true }).selectOption({ label: "Version 1" });
  await page.locator("#old-version-note").waitFor(); assert(await page.locator("#revision").isDisabled(), "OLD_VERSION_CAN_REVISE");
  assert((await page.locator("#revision-blocked-reason").innerText()).includes("earlier version"), "OLD_VERSION_REVISION_BLOCK_UNEXPLAINED");
  await page.getByRole("button", { name: "Return to latest to make changes" }).click();
  await page.waitForFunction(() => (document.querySelector("#version-picker") as HTMLSelectElement).selectedOptions[0]?.textContent === "Version 2 · latest");
  await page.locator("#revision").fill("Try a softer green");
  await page.reload(); await page.getByText("Workspace connected", { exact: true }).waitFor(); await ready(2);
  assert(await page.locator("#revision").inputValue() === "Try a softer green", "REVISION_DRAFT_LOST");
  assert((await page.locator("#conversation-messages").textContent())?.includes("Make the counter title shorter"), "CONVERSATION_LOST");
  assert(fixture.counts().inferences === 2, "RELOAD_GENERATED_AGAIN");
  for (const width of [390, 768, 1440]) await screenshot("workspace", width);
  await page.getByRole("button", { name: "Expand preview", exact: true }).click();
  assert(await page.getByRole("button", { name: "Restore workspace" }).getAttribute("aria-pressed") === "true", "EXPAND_NOT_WORKING");
  await page.getByRole("button", { name: "Restore workspace" }).click();
  await page.emulateMedia({ reducedMotion: "reduce" });
  await page.getByRole("button", { name: "Settings", exact: true }).click();
  await page.keyboard.press("Escape");
  assert(await page.locator("#workspace-settings").isHidden(), "SETTINGS_ESCAPE_FAILED");
  assert(await page.locator("#open-settings").evaluate((el) => document.activeElement === el), "DIALOG_FOCUS_NOT_RESTORED");
  const priorPreview = await page.locator("#preview").getAttribute("src");
  fixture.setInferenceMode("invalid-typescript");
  await page.getByRole("button", { name: "Send revision", exact: true }).click();
  await page.waitForFunction(() => document.querySelector("#execution-activity")?.getAttribute("data-state") === "failed", undefined, { timeout: 180000 });
  assert(await page.locator("#product-notice").isVisible(), "FAILED_CHECK_NOT_EXPLAINED");
  assert(await page.locator("#preview").getAttribute("src") === priorPreview && await page.locator("#version-picker option").count() === 2, "FAILURE_REPLACED_GOOD_PREVIEW");
  assert(await page.locator("#revision").inputValue() === "Try a softer green", "FAILURE_LOST_DRAFT");
  assert(await page.locator("#build-progress").getAttribute("aria-valuenow") !== "5", "FAILURE_CLAIMED_COMPLETION");
  await page.locator("#execution-details summary").click();
  assert((await page.locator("#activity-connection").textContent())?.includes("TS2322"), "CHECK_DIAGNOSTIC_MISSING");
  await screenshot("failure", 1440);
  fixture.setInferenceMode("complete");
  await page.getByRole("button", { name: "Send revision", exact: true }).click(); await ready(3);
  assert(fixture.counts().inferences === 4, "FAILED_REVISION_COULD_NOT_CONTINUE_FROM_VERIFIED_BASE");
  const counts = (await pool.query("SELECT (SELECT count(*) FROM development_chatgpt_operations) AS requests, (SELECT count(*) FROM ledger_entries WHERE direction='debit' AND account_id=$1) AS debits", [(server.generationEvidence().result as any).accountId])).rows[0];
  assert(Number(counts.requests) === 4 && Number(counts.debits) === 4 && fixture.counts().inferences === 4, `DUPLICATE_CHARGE:${JSON.stringify(counts)}`);
  assert(!requests.some((path) => /^\/(account|balance|top_up|generation|session|api\/generate)(\/|$)/u.test(path)), "HTTP_GENERATION_ROUTE_USED");
  await page.locator("#revision").fill("Make the label clearer");
  fixture.setInferenceMode("cut");
  await page.getByRole("button", { name: "Send revision", exact: true }).click();
  await page.waitForFunction(() => document.querySelector("#execution-activity")?.getAttribute("data-state") === "failed");
  assert((await page.locator("#notice-copy").textContent())?.includes("You can send your change again"), "INTERRUPTION_NOT_ACTIONABLE");
  assert(await page.locator("#recovery").isHidden(), "ENDED_REQUEST_SHOWN_AS_RUNNING");
  assert(fixture.counts().inferences === 5, "INTERRUPTION_RETRIED");
  assert(await page.locator("#revise").isEnabled(), "INTERRUPTION_BLOCKS_REVISION");
  const interrupted = (await pool.query<{ state: string; receipt_charge: string; provider_receipt_reference: string; terminal_result: unknown; observation_json: { status: string } }>("SELECT a.state,a.receipt_charge,a.provider_receipt_reference,a.terminal_result,c.observation_json FROM metered_actions a JOIN development_chatgpt_operations c USING(operation_id) WHERE a.terminal_result->>'code'='MODEL_RESPONSE_INTERRUPTED'")).rows;
  assert(interrupted.length === 1 && interrupted[0].state === "failed" && interrupted[0].receipt_charge === "0" && interrupted[0].observation_json.status === "usage_unknown", "INTERRUPTION_POLICY_LOST_AUDIT_OR_CHARGED_USER");
  const draftBeforeReload = await page.locator("#revision").inputValue();
  await page.reload(); await page.getByText("Workspace connected", { exact: true }).waitFor();
  assert(await page.locator("#revise").isEnabled() && fixture.counts().inferences === 5, "RELOAD_BLOCKED_OR_RETRIED");
  assert(await page.locator("#revision").inputValue() === draftBeforeReload, "INTERRUPTION_LOST_DRAFT");
  for (const width of [390,1440]) await screenshot("revision-recovered",width);
  fixture.setInferenceMode("complete");
  await page.getByRole("button", { name: "Send revision", exact: true }).click(); await ready(4);
  assert(fixture.counts().inferences === 6, "NEXT_EXPLICIT_REVISION_NOT_WORKING");
  const finalCounts = (await pool.query("SELECT (SELECT count(*) FROM development_chatgpt_operations) AS requests,(SELECT count(*) FROM ledger_entries WHERE direction='debit' AND account_id=$1) AS debits,(SELECT count(*) FROM billing_line_items WHERE source_identity LIKE 'release:%') AS releases", [(server.generationEvidence().result as any).accountId])).rows[0];
  assert(Number(finalCounts.requests) === 6 && Number(finalCounts.debits) === 5 && Number(finalCounts.releases) === 6, `INTERRUPTION_DUPLICATE_CHARGE_OR_RELEASE:${JSON.stringify(finalCounts)}`);
  assert(errors.length === 0, `BROWSER_ERRORS:${errors.join(",")}`);
  const consolePage = await browser.newPage(); await consolePage.goto(`${server.url}/dev`);
  await consolePage.getByRole("heading", { name: "Development workspace", exact: true }).waitFor();
  console.log(JSON.stringify({ status: "passed", case: "product-workspace", evidence: "fixture OAuth/model; real relay + Cashu + SQL + Docker + Paja", inferences: fixture.counts().inferences, counts, checks: ["guided steps", "drafts across OAuth", "automatic local funding", "live progress", "in-flight reload recovery without duplicate inference", "interactive preview", "revision chat", "version selection", "last good preview on failure", "responsive", "keyboard", "console route", "visible revision-blocking reasons", "interrupted revision recovers without retry", "explicit next revision", "one waived local charge", "durable provider fence retained"] }));
} catch (error) {
  console.error(JSON.stringify({ error: error instanceof Error ? error.message : String(error), visible: await page.locator("#notice-copy").textContent().catch(() => ""), generation: await page.locator("#generation-error").textContent().catch(() => ""), activity: await page.locator("#activity-current").textContent().catch(() => ""), errors, counts: fixture.counts() }));
  await page.screenshot({ path: join(evidence, "applet-test-failure.png"), fullPage: true }).catch(() => undefined); throw error;
} finally {
  release(); await pool.end();
  try { await server.close(); } finally { await browser.close(); await stack.down(true); await rm(stateRoot, { recursive: true, force: true }); }
}
