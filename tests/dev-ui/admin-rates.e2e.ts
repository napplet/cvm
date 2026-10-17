/** Actual admin rate component, isolated transport: never changes live rates. */
import assert from "node:assert/strict";
import { chromium } from "./node_modules/playwright";
import { chatGptDevelopmentPricing } from "../../src/dev/chatgpt-model-gateway";
const root = `${import.meta.dir}/../..`;
const pricing = chatGptDevelopmentPricing("fixture", "fixture-model");
const bundle = await Bun.build({ entrypoints: [`${root}/src/dev-ui/browser/admin-rates.ts`], target: "browser", format: "esm" });
assert(bundle.success);
const html = `<!doctype html><html><head><meta name="viewport" content="width=device-width, initial-scale=1"><link rel="stylesheet" href="/product.css"><link rel="stylesheet" href="/admin.css"></head><body><main id="app"><div class="admin-grid"><section id="rates"></section></div></main><script type="module">
import {ratesMarkup,mountAdminRates} from '/rates.js';
window.calls=[]; window.failSave=false;
const pricing=${JSON.stringify(pricing)};
window.savedPricing=structuredClone(pricing);
window.render=(next=pricing)=>{ document.querySelector('#rates').innerHTML=ratesMarkup; mountAdminRates(next,async rates=>{window.calls.push(structuredClone(rates)); if(window.failSave)throw Error('CONFIGURATION_BUSY'); window.savedPricing={...next,card:{...next.card,rates}};return window.savedPricing;}); };
window.render();
</script></body></html>`;
const server = Bun.serve({ hostname: "127.0.0.1", port: 0, fetch(request) {
  const path = new URL(request.url).pathname;
  if (path === "/") return new Response(html, { headers: { "content-type": "text/html" } });
  if (path === "/rates.js") return new Response(bundle.outputs[0], { headers: { "content-type": "text/javascript" } });
  if (["/product.css", "/admin.css"].includes(path)) return new Response(Bun.file(`${root}/src/dev-ui/browser${path}`));
  return new Response(null, { status: 404 });
} });
const browser = await chromium.launch(); const page = await browser.newPage(); const errors: string[] = [];
page.on("pageerror", error => errors.push(error.message));
try {
  await page.goto(`http://127.0.0.1:${server.port}`);
  const input = page.getByLabel("Input price (test sats per 1,000 tokens)", { exact: true });
  await input.waitFor();
  assert(await page.locator("#rate-fields input").count() === 2);
  assert(await page.locator("#rates-save").isDisabled());
  assert(await page.locator("#rates-example-cost").innerText() === "12 test sats");
  await input.fill("0.5");
  assert(await page.locator("#rates-example-cost").innerText() === "7 test sats");
  assert(await page.locator("#rates-dirty").isVisible());
  await page.locator("#rates-save").click(); await page.getByText("Rates saved for new actions.", { exact: true }).waitFor();
  assert(await input.inputValue() === "0.5" && await page.locator("#rates-save").isDisabled());
  let calls = await page.evaluate(() => (window as any).calls);
  assert.deepEqual(calls, [{ ...pricing.card.rates, input_tokens: { numerator: "1", denominator: "2000" } }]);
  for (const invalid of ["0", "-1", "1e3", ""]) {
    await input.fill(invalid);
    assert(await input.getAttribute("aria-invalid") === "true" && await page.locator("#rates-save").isDisabled());
  }
  assert(await page.evaluate(() => (window as any).calls.length) === 1);
  await input.fill("2"); await page.evaluate(() => { (window as any).failSave = true; });
  await page.locator("#rates-save").click(); await page.getByText(/A job is running/).waitFor();
  assert(await input.inputValue() === "2" && await page.locator("#rates-save").isEnabled());
  await page.evaluate(() => { (window as any).failSave = false; });
  await page.locator("#rates-save").click(); await page.getByText("Rates saved for new actions.", { exact: true }).waitFor();
  // A rounded display must not rewrite an untouched exact rational.
  await page.evaluate(() => { const p=(window as any).savedPricing; p.card.rates.input_tokens={numerator:'1',denominator:'3'}; (window as any).render(p); });
  assert(await input.inputValue() === "333.333334");
  await page.getByLabel("Output price (test sats per 1,000 tokens)", { exact: true }).fill("3");
  await page.locator("#rates-save").click(); await page.getByText("Rates saved for new actions.", { exact: true }).waitFor();
  calls = await page.evaluate(() => (window as any).calls);
  assert.deepEqual(calls.at(-1).input_tokens, { numerator: "1", denominator: "3" });
  for (const width of [320, 375, 768, 1280]) {
    await page.setViewportSize({ width, height: 1000 });
    assert(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), `Rate editor overflow at ${width}`);
  }
  await page.evaluate(() => { const p=(window as any).savedPricing; p.card.kind='source_attributed_provider'; p.card.supportedDimensions=['input_tokens','output_tokens','cached_tokens','reasoning_tokens']; (window as any).render(p); });
  assert(await page.locator("#rate-fields input").count() === 4);
  assert(await page.locator("#rate-fields input[readonly]").count() === 4 && await page.locator("#rates-save").isHidden());
  const before = calls.length;
  await page.locator("#rates-form").evaluate(el => el.dispatchEvent(new Event("submit", { bubbles: true, cancelable: true })));
  assert(await page.evaluate(() => (window as any).calls.length) === before);
  assert.deepEqual(errors, []);
  console.log("Admin rates passed: exact save payload, live example, validation, busy/retry, untouched precision, inactive dimensions, API read-only and four responsive layouts.");
} finally { await browser.close(); server.stop(true); }
