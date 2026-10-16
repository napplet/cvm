/** Opt-in smoke: one real generation using the locally selected ChatGPT account. */
import { chromium } from "playwright";
if (!process.argv.includes("--allow-chatgpt-usage")) throw new Error("CHATGPT_LIVE_USAGE_OPT_IN_REQUIRED");
const blink = process.argv.includes("--blink");
const url = new URL(process.env.NAPPLET_CVM_DEV_URL ?? "http://invalid");
if (url.protocol !== "http:" || url.hostname !== "127.0.0.1" || url.username || url.password) throw new Error("CHATGPT_LOCAL_GUI_REQUIRED");
const controlUrl = (path: string) => { const target = new URL(path, url); target.searchParams.set("inspect", String(Date.now())); return target; };
const bootstrap = await (await fetch(controlUrl("/bootstrap"), { cache: "no-store" })).json() as any;
if (bootstrap.providerLabel !== "ChatGPT subscription · local test sats") throw new Error("CHATGPT_SIGN_IN_AND_SELECT_MODEL_IN_GUI_FIRST");
const authStatus = await (await fetch(controlUrl("/dev/chatgpt/status"), { cache: "no-store", headers: { "x-dev-model-token": bootstrap.modelControlToken } })).json();
if (!authStatus.accounts.some((account: any) => account.id === authStatus.settings.accountId && account.signedIn && account.planEnabled)) throw new Error("CHATGPT_SIGN_IN_REQUIRED_BEFORE_LIVE_TEST");
const browser = await chromium.launch({ headless: true });
try {
  const page = await browser.newPage(); await page.goto(url.href, { waitUntil: "networkidle" });
  await page.getByRole("button", { name: "Connect", exact: true }).click(); await page.getByText("Connected:").waitFor();
  await page.getByLabel("Cashu amount (sats)").fill("4000"); await page.getByRole("button", { name: "Fund with Cashu", exact: true }).click(); await page.getByText("Cashu credited", { exact: true }).waitFor();
  await page.getByLabel("Focused idea").fill(blink ? "Show only the word test blinking in the center of the screen using CSS animation. Respect reduced motion." : "Build a single-purpose tap counter with one Add button and a visible count, using DOM creation and textContent.");
  await page.getByRole("button", { name: "Generate napplet", exact: true }).click();
  const deadline = Date.now() + 330_000;
  while (Date.now() < deadline) {
    if ((await page.locator("#generation-error").textContent())?.trim()) {
      const status = await (await fetch(controlUrl("/dev/chatgpt/status"), { cache: "no-store", headers: { "x-dev-model-token": bootstrap.modelControlToken } })).json();
      throw new Error(typeof status.diagnostic === "string" && /^CHATGPT_[A-Z0-9_]+$/u.test(status.diagnostic) ? status.diagnostic : "CHATGPT_LIVE_GENERATION_FAILED_CHECK_GUI");
    }
    if ((await page.locator("#generation-status").textContent()) === "Verified preview ready") break;
    await Bun.sleep(250);
  }
  const facts = await page.locator("#generation-facts").textContent() ?? "";
  if (!facts.includes("openai_chatgpt_development") || !facts.includes("input_tokens:") || !await page.locator("#preview").isVisible()) throw new Error("CHATGPT_LIVE_VERIFIED_PREVIEW_MISSING");
  const sandbox = await page.frameLocator("#preview").locator("iframe").first().getAttribute("sandbox");
  if (sandbox !== "allow-scripts") throw new Error("CHATGPT_LIVE_SANDBOX_INVALID");
  const napplet = page.frameLocator("#preview").frameLocator("iframe").first();
  if (blink) {
    const word = napplet.getByText("test", { exact: true }); await word.waitFor({ state: "attached" });
    if (!await word.evaluate((node) => node.getAnimations().some((animation) => animation.playState === "running"))) throw new Error("CHATGPT_LIVE_BLINK_ANIMATION_MISSING");
    await page.emulateMedia({ reducedMotion: "reduce" });
    await page.waitForTimeout(100);
    if (await word.evaluate((node) => node.getAnimations().some((animation) => animation.playState === "running"))) throw new Error("CHATGPT_LIVE_REDUCED_MOTION_IGNORED");
  } else {
    await napplet.getByRole("button", { name: "Add", exact: true }).click();
    await napplet.getByText("1", { exact: true }).waitFor();
  }
  console.log(JSON.stringify({ status: "passed", case: "chatgpt-live", evidence: blink ? "live generated blinking text, verified preview, animation and reduced-motion behavior" : "live ChatGPT generation, verified local preview, and Add increments count to 1", automaticRetries: 0 }));
} finally { await browser.close(); }
