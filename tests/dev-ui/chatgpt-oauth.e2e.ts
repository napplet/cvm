/** OAuth protocol fixture → signed ContextVM → SQL → real Docker build → Paja. */
import { chromium } from "playwright";
import { mkdtemp, readFile, rm, mkdir } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { developmentStack, createDevelopmentPool } from "../../scripts/dev-payments";
import { createDevelopmentContextVmServer } from "../../src/dev-ui/contextvm-server";
import { chatGptFixture } from "../fixtures/chatgpt";

const fixture = chatGptFixture();
fixture.setSparseCompletion(true);
let releaseInference!: () => void;
const inferenceGate = new Promise<void>((resolve) => { releaseInference = resolve; });
let delayFirstInference = true;
const fetchWithProgress: typeof fixture.fetch = async (input, init) => {
  if (String(input).endsWith("/v1/models")) return Response.json({ models: [
    { slug: "fixture-codex", display_name: "Fixture Codex", visibility: "list" },
    { slug: "fixture-alternative", display_name: "Fixture Alternative", visibility: "list" },
  ] });
  const fetched = await fixture.fetch(input, init);
  const response = String(input).endsWith("/responses") ? new Response(fetched.body) : fetched;
  if (!String(input).endsWith("/responses") || !delayFirstInference) return response;
  delayFirstInference = false;
  const reader = response.body!.getReader();
  return new Response(new ReadableStream({ async start(controller) {
    try {
      const first = await reader.read(); if (first.value) controller.enqueue(first.value);
      await inferenceGate;
      for (;;) { const chunk = await reader.read(); if (chunk.done) break; controller.enqueue(chunk.value); }
      controller.close();
    } catch (error) { controller.error(error); }
  } }), { headers: response.headers });
};
const stack = developmentStack(true); const config = await stack.up();
const stateRoot = await mkdtemp(join(tmpdir(), "napplet-chatgpt-e2e-"));
let server = await createDevelopmentContextVmServer({ config, stateRoot, chatGptFetch: fetchWithProgress });
const browser = await chromium.launch({ headless: true }); const page = await browser.newPage(); const pool = createDevelopmentPool(config.databaseUrl);
const browserTraffic: string[] = []; const browserLogs: string[] = [];
page.on("request", (request) => browserTraffic.push(request.url() + (request.postData() ?? ""))); page.on("console", (message) => browserLogs.push(message.text()));
page.on("pageerror", () => browserLogs.push("PAGE_ERROR"));
const requireThat = (condition: unknown, code: string) => { if (!condition) throw new Error(code); };
async function generated(version: number) {
  const deadline = Date.now() + 180_000;
  while (Date.now() < deadline) {
    const error = await page.locator("#generation-error").textContent(); if (error?.trim()) throw new Error(`GUI_GENERATION_FAILED:${error}:${server.generationEvidence().error ?? ""}`);
    if (await page.locator("#versions li").count() === version && (await page.locator("#generation-status").textContent()) === "Verified preview ready") return;
    await Bun.sleep(250);
  }
  throw new Error("GUI_GENERATION_TIMEOUT");
}
try {
  await page.route("https://auth.openai.com/api/accounts/authorize?*", async (route) => { await route.fulfill({ status: 302, headers: { location: fixture.authorize(route.request().url()).href } }); });
  await page.goto(server.url, { waitUntil: "networkidle" });
  await page.getByRole("button", { name: "Continue with ChatGPT" }).click();
  await page.getByRole("button", { name: "Got it", exact: true }).click();
  await page.getByText("Using ChatGPT plan · fixture-codex", { exact: true }).waitFor();
  requireThat(fixture.counts().inferences === 0, "SIGN_IN_TRIGGERED_INFERENCE");
  await page.getByLabel("ChatGPT model", { exact: true }).selectOption("fixture-alternative");
  await page.getByText("Using ChatGPT plan · fixture-alternative", { exact: true }).waitFor();
  await page.getByRole("button", { name: "Use default provider", exact: true }).click();
  await page.getByText("Active: Deterministic fixture", { exact: true }).waitFor();
  await page.reload({ waitUntil: "networkidle" });
  await page.getByText("Active: Deterministic fixture", { exact: true }).waitFor();
  requireThat(await page.getByLabel("ChatGPT model", { exact: true }).inputValue() === "", "DEFAULT_PROVIDER_WAS_NOT_RETAINED");
  await page.getByLabel("ChatGPT model", { exact: true }).selectOption("fixture-codex");
  await page.getByText("Using ChatGPT plan · fixture-codex", { exact: true }).waitFor();
  await page.getByRole("button", { name: "Connect", exact: true }).click(); await page.getByText("Connected:").waitFor();
  await page.getByLabel("Cashu amount (sats)").fill("4000"); await page.getByRole("button", { name: "Fund with Cashu", exact: true }).click(); await page.getByText("Cashu credited", { exact: true }).waitFor();
  await page.getByRole("button", { name: "Generate napplet", exact: true }).click();
  await page.locator('#activity-events [data-stage="model_stream"]').waitFor();
  requireThat(await page.locator("#versions li").count() === 0 && fixture.counts().inferences === 1, "PROGRESS_NOT_LIVE");
  requireThat((await page.locator("#activity-provider").textContent())?.includes("fixture-codex"), "PROGRESS_PROVIDER_MISSING");
  const sequence = await page.locator("#execution-activity").getAttribute("data-last-server-sequence");
  await page.waitForFunction((previous) => Number(document.querySelector<HTMLElement>("#execution-activity")?.dataset.lastServerSequence) > Number(previous), sequence, { timeout: 12000 });
  requireThat(await page.locator("#versions li").count() === 0, "HEARTBEAT_CLAIMED_COMPLETION");
  await page.getByLabel("ChatGPT model", { exact: true }).selectOption("fixture-alternative");
  await page.getByText("Wait for the current generation to finish before changing model settings.", { exact: true }).waitFor();
  requireThat(await page.getByLabel("ChatGPT model", { exact: true }).inputValue() === "fixture-codex", "BUSY_SELECTION_CHANGED_MODEL");
  releaseInference(); await generated(1);
  for (const stage of ["create", "init", "skills", "install", "build", "verify", "conformance", "dry-run", "artifact", "ledger", "preview"]) requireThat(await page.locator(`#activity-events [data-stage="${stage}"][data-state="completed"]`).count() > 0, `PROGRESS_STAGE_MISSING:${stage}`); await server.assertGenerationSettlement();
  const frame = page.frameLocator("#preview").frameLocator("iframe").first(); await frame.getByRole("button", { name: "Add" }).click(); await frame.getByText("1", { exact: true }).waitFor();
  requireThat(server.generationEvidence().result?.status === "completed", "OAUTH_COMPLETION_MISSING");
  requireThat((await page.locator("#generation-facts").textContent())?.includes("input_tokens:1200, output_tokens:800"), "OAUTH_USAGE_MISSING");
  await page.getByLabel("Revision", { exact: true }).fill("Make the counter title more concise"); await page.getByRole("button", { name: "Revise selected version" }).click(); await generated(2); await server.assertGenerationSettlement();
  await page.getByRole("button", { name: "Replay last revision request" }).click(); await generated(2);
  requireThat(fixture.counts().inferences === 2, "OAUTH_REVISION_REDISPATCHED");
  const calls = fixture.calls.filter((call) => call.url.endsWith("/responses")); requireThat(String(calls[1]?.init?.body).includes("authorizedPriorSource"), "OAUTH_REVISION_SOURCE_MISSING");
  const oldUrl = server.url; await server.close(); server = await createDevelopmentContextVmServer({ config, stateRoot, port: Number(new URL(oldUrl).port), chatGptFetch: fetchWithProgress });
  await page.goto(server.url, { waitUntil: "networkidle" }); await page.getByText("Using ChatGPT plan · fixture-codex", { exact: true }).waitFor();
  requireThat(!await page.locator("#chatgpt-welcome").isVisible(), "OAUTH_WELCOME_REPEATED");
  await page.getByRole("button", { name: "Connect", exact: true }).click(); await page.getByText("Connected:").waitFor(); await page.locator("#versions li").nth(1).getByRole("button").click();
  await page.getByLabel("Revision", { exact: true }).fill("Make the counter easier to read"); await page.getByRole("button", { name: "Revise selected version" }).click(); await generated(3); await server.assertGenerationSettlement();
  await frame.getByRole("heading", { name: "OAuth fixture 3", exact: true }).waitFor();
  await frame.getByRole("button", { name: "Add", exact: true }).click(); await frame.getByText("1", { exact: true }).waitFor();
  const counts = (await pool.query("SELECT (SELECT count(*) FROM development_chatgpt_operations) AS requests, (SELECT count(*) FROM provider_observations) AS observations, (SELECT count(*) FROM ledger_entries WHERE direction='debit' AND account_id=$1) AS debits", [(server.generationEvidence().result as any).accountId])).rows[0];
  requireThat(Number(counts.requests) === 3 && Number(counts.observations) === 3 && Number(counts.debits) === 3 && fixture.counts().inferences === 3, `OAUTH_SQL_REPLAY_COUNTS_INVALID:${JSON.stringify({ counts, inferences: fixture.counts().inferences })}`);
  const records = JSON.parse(await readFile(join(stateRoot, "development-chatgpt/accounts.json"), "utf8")); const tokens = records.accounts[0].tokens;
  const visible = [await page.content(), JSON.stringify(browserTraffic), JSON.stringify(browserLogs), await page.evaluate(() => JSON.stringify({ ...localStorage, ...sessionStorage }))].join("\n");
  for (const secret of [tokens.access, tokens.refresh, tokens.id]) requireThat(!visible.includes(secret), "OAUTH_SECRET_REACHED_BROWSER");
  requireThat(!browserLogs.includes("PAGE_ERROR"), "OAUTH_BROWSER_ERROR");
  await mkdir(resolve(".local/development-gui-evidence"), { recursive: true });
  for (const width of [375, 1280]) { await page.setViewportSize({ width, height: 1000 }); requireThat(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth), "OAUTH_LAYOUT_OVERFLOW"); await page.screenshot({ path: resolve(`.local/development-gui-evidence/chatgpt-${width}.png`), fullPage: true }); }
  fixture.setInferenceMode("invalid-typescript");
  await page.getByRole("button", { name: "Generate napplet", exact: true }).click();
  await page.waitForFunction(() => document.querySelector("#generation-error")?.textContent?.includes("WORKER_OR_ARTIFACT_FAILED"), undefined, { timeout: 180000 });
  requireThat((await page.locator("#activity-current").textContent())?.includes("Check guidance and TypeScript"), "FAILED_WORKER_STAGE_NOT_VISIBLE");
  requireThat(await page.locator('#activity-events [data-stage="verify"][data-state="failed"]').count() === 1, "FAILED_WORKER_EVENT_MISSING");
  requireThat(await page.locator("#generation-facts").textContent() === "", "FAILED_ACTION_SHOWS_STALE_ARTIFACT");
  requireThat(await page.locator("#generation-status").textContent() === "Action stopped; see error below", "FAILED_ACTION_STILL_SHOWS_RUNNING");
  await server.assertGenerationSettlement();
  const failedCounts = (await pool.query("SELECT count(*) AS requests FROM development_chatgpt_operations")).rows[0];
  requireThat(Number(failedCounts.requests) === 4 && fixture.counts().inferences === 4, "FAILED_ACTION_REDISPATCHED");
  await page.screenshot({ path: resolve(".local/development-gui-evidence/progress-failure.png"), fullPage: true });
  fixture.setInferenceMode("limit");
  await page.getByRole("button", { name: "Generate napplet", exact: true }).click();
  await page.getByText("Generation stopped · provider outcome unconfirmed", { exact: true }).waitFor();
  await page.locator("#chatgpt-status").filter({ hasText: "ChatGPT subscription request blocked by a usage limit" }).waitFor();
  requireThat((await page.locator("#activity-connection").textContent())?.includes("App limits"), "LIVE_PROVIDER_ERROR_MISSING");
  requireThat((await page.locator("#activity-connection").textContent())?.includes("The server finished this request"), "STOPPED_REQUEST_SHOWN_AS_RUNNING");
  requireThat(fixture.counts().inferences === 5, "LIMIT_ACTION_REDISPATCHED");
  await page.getByRole("button", { name: "Sign out of ChatGPT" }).click(); await page.getByText("Signed out of ChatGPT. Use the default provider or sign in again.", { exact: true }).waitFor();
  const cleared = JSON.parse(await readFile(join(stateRoot, "development-chatgpt/accounts.json"), "utf8")); requireThat(!cleared.accounts[0].tokens, "OAUTH_LOGOUT_RETAINED_TOKENS");
  await page.getByText("ChatGPT selected · sign in to generate", { exact: true }).waitFor();
  await page.getByRole("button", { name: "Generate napplet", exact: true }).click();
  await page.locator("#generation-error").filter({ hasText: "Sign in to ChatGPT before generating" }).waitFor();
  requireThat(await page.locator('#activity-events [data-stage="admission"]').count() === 0, "SIGNED_OUT_ACTION_RESERVED_FUNDS");
  requireThat(fixture.counts().inferences === 5, "SIGNED_OUT_ACTION_DISPATCHED");
  console.log(JSON.stringify({ status: "passed", case: "chatgpt-oauth", evidence: "fixture OAuth and inference; real relay, SQL, Docker worker and Paja", requests: fixture.counts().inferences, counts, failure: "TypeScript stage displayed; stale facts cleared; failed action settled" }));
} catch (error) {
  console.error(JSON.stringify({ code: error instanceof Error ? error.message : "OAUTH_E2E_FAILED", model: await page.locator("#chatgpt-status").textContent().catch(() => "unavailable"), generation: server.generationEvidence(), activity: await page.locator("#execution-activity").textContent(), error: await page.locator("#generation-error").textContent(), counts: fixture.counts() })); throw error;
} finally {
  releaseInference();
  await pool.end();
  try { await server.close(); } finally { try { await stack.down(true); await rm(stateRoot, { recursive: true, force: true }); } finally { await browser.close(); } }
}
