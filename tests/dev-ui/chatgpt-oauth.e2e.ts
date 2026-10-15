/** OAuth protocol fixture → signed ContextVM → SQL → real Docker build → Paja. */
import { chromium } from "playwright";
import { mkdtemp, readFile, rm, mkdir } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { developmentStack, createDevelopmentPool } from "../../scripts/dev-payments";
import { createDevelopmentContextVmServer } from "../../src/dev-ui/contextvm-server";
import { chatGptFixture } from "../fixtures/chatgpt";

const fixture = chatGptFixture(); const stack = developmentStack(true); const config = await stack.up();
const stateRoot = await mkdtemp(join(tmpdir(), "napplet-chatgpt-e2e-"));
let server = await createDevelopmentContextVmServer({ config, stateRoot, chatGptFetch: fixture.fetch });
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
  await page.getByLabel("ChatGPT model", { exact: true }).selectOption("fixture-codex");
  await page.getByRole("button", { name: "Use ChatGPT plan", exact: true }).click();
  await page.getByText("Using ChatGPT plan · fixture-codex", { exact: true }).waitFor();
  await page.getByRole("button", { name: "Connect", exact: true }).click(); await page.getByText("Connected:").waitFor();
  await page.getByLabel("Cashu amount (sats)").fill("4000"); await page.getByRole("button", { name: "Fund with Cashu", exact: true }).click(); await page.getByText("Cashu credited", { exact: true }).waitFor();
  await page.getByRole("button", { name: "Generate napplet", exact: true }).click(); await generated(1); await server.assertGenerationSettlement();
  const frame = page.frameLocator("#preview").frameLocator("iframe").first(); await frame.getByRole("button", { name: "Add" }).click(); await frame.getByText("1", { exact: true }).waitFor();
  requireThat(server.generationEvidence().result?.status === "completed", "OAUTH_COMPLETION_MISSING");
  requireThat((await page.locator("#generation-facts").textContent())?.includes("input_tokens:1200, output_tokens:800"), "OAUTH_USAGE_MISSING");
  await page.getByLabel("Revision", { exact: true }).fill("Make the counter title more concise"); await page.getByRole("button", { name: "Revise selected version" }).click(); await generated(2); await server.assertGenerationSettlement();
  await page.getByRole("button", { name: "Replay last revision request" }).click(); await generated(2);
  requireThat(fixture.counts().inferences === 2, "OAUTH_REVISION_REDISPATCHED");
  const calls = fixture.calls.filter((call) => call.url.endsWith("/responses")); requireThat(String(calls[1]?.init?.body).includes("authorizedPriorSource"), "OAUTH_REVISION_SOURCE_MISSING");
  const oldUrl = server.url; await server.close(); server = await createDevelopmentContextVmServer({ config, stateRoot, port: Number(new URL(oldUrl).port), chatGptFetch: fixture.fetch });
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
  await page.getByRole("button", { name: "Sign out of ChatGPT" }).click(); await page.getByText("Signed out of ChatGPT. Use the default provider or sign in again.", { exact: true }).waitFor();
  const cleared = JSON.parse(await readFile(join(stateRoot, "development-chatgpt/accounts.json"), "utf8")); requireThat(!cleared.accounts[0].tokens, "OAUTH_LOGOUT_RETAINED_TOKENS");
  console.log(JSON.stringify({ status: "passed", case: "chatgpt-oauth", evidence: "fixture OAuth and inference; real relay, SQL, Docker worker and Paja", requests: fixture.counts().inferences, counts }));
} catch (error) {
  console.error(JSON.stringify({ code: error instanceof Error ? error.message : "OAUTH_E2E_FAILED", model: await page.locator("#chatgpt-status").textContent().catch(() => "unavailable"), generation: server.generationEvidence() })); throw error;
} finally {
  await pool.end();
  try { await server.close(); } finally { try { await stack.down(true); await rm(stateRoot, { recursive: true, force: true }); } finally { await browser.close(); } }
}
