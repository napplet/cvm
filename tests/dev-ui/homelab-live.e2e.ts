/** Bounded private generation or read-only restoration of the same smoke artifact. */
import { chromium } from "playwright";
import { mkdir, writeFile } from "node:fs/promises";
import { resolve } from "node:path";
const restoreOnly = process.argv.includes("--restore-only");
if (!restoreOnly && !process.argv.includes("--allow-chatgpt-usage")) throw new Error("CHATGPT_USAGE_OPT_IN_REQUIRED");
const origin = "https://cvm.lab.sandwich.farm";
const directory = resolve(import.meta.dir, "../../.local/homelab-evidence");
await mkdir(directory, { recursive: true, mode: 0o700 });
let activePage: import("playwright").Page | undefined;
const browser = await chromium.launch({ headless: true, args: ["--host-resolver-rules=MAP cvm.lab.sandwich.farm 192.168.151.196, MAP cvm-preview.lab.sandwich.farm 192.168.151.196, MAP cvm-blobs.lab.sandwich.farm 192.168.151.196"] });
try {
  const page = await browser.newPage(); activePage = page;
  if (restoreOnly) {
    const saved = await Bun.file(resolve(directory, 'browser-session.json')).json();
    await page.addInitScript(({ origin, saved }) => { if (location.origin === origin) for (const [key, value] of Object.entries(saved)) sessionStorage.setItem(key, String(value)); }, { origin, saved });
  }
  const productHttp: string[] = [];
  page.on("request", request => { const path = new URL(request.url()).pathname; if (/^\/(?:account|balance|top_up|generation|session)\b/.test(path)) productHttp.push(path); });
  await page.goto(origin + "/dev", { waitUntil: "networkidle" });
  await page.getByRole("button", { name: "Connect", exact: true }).click();
  await page.getByText(/^Connected:/).waitFor({ timeout: 45_000 });
  const maximum = await page.locator("#maximum").inputValue();
  if (!restoreOnly) {
  if (!/^\d+$/.test(maximum) || BigInt(maximum) > 10000n) throw new Error("SMOKE_TEST_BUDGET_EXCEEDED");
  await page.getByLabel("Cashu amount (sats)").fill(maximum);
  await page.getByRole("button", { name: "Fund with Cashu", exact: true }).click();
  await page.getByText("Cashu credited", { exact: true }).waitFor({ timeout: 45_000 });
  await page.getByLabel("Focused idea").fill("Build a minimal tap counter with the heading Homelab CVM verified, one button labeled Add, and a visible count starting at 0. Add increments the count. Use DOM creation and textContent.");
  await page.getByRole("button", { name: "Generate napplet", exact: true }).click();
  await page.waitForFunction(() => document.querySelector("#generation-status")?.textContent === "Verified preview ready" || !!document.querySelector("#generation-error")?.textContent?.trim(), undefined, { timeout: 420_000 });
  const error = await page.locator("#generation-error").textContent();
  if (error?.trim()) throw new Error(error);
  }
  await page.locator("#preview").waitFor({ state: "visible", timeout: 45_000 });
  const previewUrl = await page.locator("#preview").getAttribute("src");
  if (!previewUrl?.startsWith("https://cvm-preview.lab.sandwich.farm/cvm-preview/")) throw new Error("REMOTE_PREVIEW_ORIGIN_INVALID");
  const frame = page.frameLocator("#preview");
  if (await frame.locator("iframe").first().getAttribute("sandbox") !== "allow-scripts") throw new Error("SANDBOX_INVALID");
  const napplet = frame.frameLocator("iframe").first();
  await napplet.getByRole("button", { name: /^(?:\+\s*)?Add$/u }).click();
  await napplet.getByText("1", { exact: true }).waitFor();
  const isolation = await napplet.locator("body").evaluate(() => {
    let parentStorageBlocked = false; try { void window.parent.localStorage.length; } catch { parentStorageBlocked = true; }
    return { parentStorageBlocked, nostr: typeof (window as any).nostr };
  });
  if (!isolation.parentStorageBlocked || isolation.nostr !== "undefined" || productHttp.length) throw new Error("PREVIEW_AUTHORITY_INVALID");
  const facts = await page.locator("#generation-facts").textContent();
  if (!restoreOnly && (!facts?.includes("openai_chatgpt_development") || !facts.includes("input_tokens:"))) throw new Error("REAL_USAGE_RECEIPT_MISSING");
  if (restoreOnly) {
    const prior = await Bun.file(resolve(directory, 'generation.json')).json();
    const artifact = prior.facts.match(/artifact:sha256:[a-f0-9]{64}/)?.[0];
    if (!artifact || !facts?.includes(artifact)) throw new Error('RESTORED_ARTIFACT_CHANGED');
  }
  await page.screenshot({ path: resolve(directory, "verified-preview.png"), fullPage: true });
  const evidence = { status: "passed", origin, case: restoreOnly ? "restart-restored-same-artifact-no-generation" : "live-chatgpt-signed-contextvm-isolated-worker-interactive-remote-preview", maximum, facts, previewUrl, isolation, automaticRetries: 0 };
  await writeFile(resolve(directory, restoreOnly ? "restart.json" : "generation.json"), JSON.stringify(evidence, null, 2));
  console.log(JSON.stringify(evidence));
} finally {
  try {
    if (activePage) await writeFile(resolve(directory, 'browser-session.json'), JSON.stringify(await activePage.evaluate(() => Object.fromEntries(Object.entries(sessionStorage)))), { mode: 0o600 });
  } finally { await browser.close(); }
}
