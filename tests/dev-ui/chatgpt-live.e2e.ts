/** Opt-in smoke: one real generation using the locally selected ChatGPT account. */
import { chromium } from "playwright";
if (!process.argv.includes("--allow-chatgpt-usage")) throw new Error("CHATGPT_LIVE_USAGE_OPT_IN_REQUIRED");
const url = new URL(process.env.NAPPLET_CVM_DEV_URL ?? "http://invalid");
if (url.protocol !== "http:" || url.hostname !== "127.0.0.1" || url.username || url.password) throw new Error("CHATGPT_LOCAL_GUI_REQUIRED");
const bootstrap = await (await fetch(new URL("/bootstrap", url))).json() as any;
if (bootstrap.providerLabel !== "ChatGPT plan · test credits") throw new Error("CHATGPT_SIGN_IN_AND_SELECT_MODEL_IN_GUI_FIRST");
const browser = await chromium.launch({ headless: true });
try {
  const page = await browser.newPage(); await page.goto(url.href, { waitUntil: "networkidle" });
  await page.getByRole("button", { name: "Connect", exact: true }).click(); await page.getByText("Connected:").waitFor();
  await page.getByLabel("Cashu amount (sats)").fill("4000"); await page.getByRole("button", { name: "Fund with Cashu", exact: true }).click(); await page.getByText("Cashu credited", { exact: true }).waitFor();
  await page.getByLabel("Focused idea").fill("Build a single-purpose tap counter with one Add button and a visible count, using DOM creation and textContent.");
  await page.getByRole("button", { name: "Generate napplet", exact: true }).click();
  const deadline = Date.now() + 330_000;
  while (Date.now() < deadline) {
    if ((await page.locator("#generation-error").textContent())?.trim()) throw new Error("CHATGPT_LIVE_GENERATION_FAILED_CHECK_GUI");
    if ((await page.locator("#generation-status").textContent()) === "Verified preview ready") break;
    await Bun.sleep(250);
  }
  const facts = await page.locator("#generation-facts").textContent() ?? "";
  if (!facts.includes("openai_chatgpt_development") || !facts.includes("input_tokens:") || !await page.locator("#preview").isVisible()) throw new Error("CHATGPT_LIVE_VERIFIED_PREVIEW_MISSING");
  const sandbox = await page.frameLocator("#preview").locator("iframe").first().getAttribute("sandbox");
  if (sandbox !== "allow-scripts") throw new Error("CHATGPT_LIVE_SANDBOX_INVALID");
  console.log(JSON.stringify({ status: "passed", case: "chatgpt-live", evidence: "live ChatGPT generation and verified local preview", automaticRetries: 0 }));
} finally { await browser.close(); }
