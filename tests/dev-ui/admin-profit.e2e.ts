import assert from "node:assert/strict";
import { chromium } from "./node_modules/playwright";
import { chatGptDevelopmentPricing } from "../../src/dev/chatgpt-model-gateway";
const root = `${import.meta.dir}/../..`, pricing = chatGptDevelopmentPricing("fixture", "fixture-model");
const bundle = await Bun.build({ entrypoints: [`${root}/src/dev-ui/browser/admin-profit.ts`], target: "browser", format: "esm" });
assert(bundle.success);
const html = `<!doctype html><html><head><meta name="viewport" content="width=device-width,initial-scale=1"><link rel="stylesheet" href="/product.css"><link rel="stylesheet" href="/admin.css"></head><body><main id="app"><div class="admin-grid"><section id="profit"></section></div></main><script type="module">
import {profitMarkup,mountAdminProfit} from '/profit.js';
const pricing=${JSON.stringify(pricing)}; window.calls=[];window.fail=false;window.quote={status:'fresh',quote:{source:'Kraken',usdPerBtc:'80000',fetchedAt:Date.now()}};
window.render=(policy)=>{document.querySelector('#profit').innerHTML=profitMarkup;window.view=mountAdminProfit(pricing,policy,async setting=>{window.calls.push(setting);if(window.fail)throw Error('CONFIGURATION_BUSY');const satsPerThousand=setting.mode==='sats'?{numerator:setting.value.replace('.',''),denominator:setting.value.includes('.')?'10':'1'}:setting.mode==='usd'?{numerator:'125',denominator:'10'}:undefined; window.render({setting,...(satsPerThousand?{satsPerThousand}:{}),...(setting.mode==='usd'?{conversion:window.quote.quote}:{})});},window.quote);};window.render();
</script></body></html>`;
const server = Bun.serve({ hostname: "127.0.0.1", port: 0, fetch(request) {
  const path = new URL(request.url).pathname;
  if (path === "/") return new Response(html, { headers: { "content-type": "text/html" } });
  if (path === "/profit.js") return new Response(bundle.outputs[0], { headers: { "content-type": "text/javascript" } });
  if (["/product.css", "/admin.css"].includes(path)) return new Response(Bun.file(`${root}/src/dev-ui/browser${path}`));
  return new Response(null, { status: 404 });
} });
const browser = await chromium.launch(), page = await browser.newPage(), errors: string[] = [];
page.on("pageerror", error => errors.push(error.message));
try {
  await page.goto(`http://127.0.0.1:${server.port}`);
  await page.locator("#profit-value").waitFor();
  const input = page.locator("#profit-value"), save = page.locator("#profit-save");
  assert(await save.isDisabled());
  await input.fill("20");
  assert(await page.locator("#profit-base").innerText() === "12 test sats");
  assert(await page.locator("#profit-fee").innerText() === "3 test sats");
  assert(await page.locator("#profit-total").innerText() === "15 test sats");
  await save.click(); await page.getByText("Margin saved for new requests.", { exact: true }).waitFor();
  assert(await save.isDisabled() && await input.isEnabled());
  await page.locator("#profit-mode").selectOption("sats"); await input.fill("3.5");
  assert(await page.locator("#profit-fee").innerText() === "42 test sats");
  await page.locator("#profit-mode").selectOption("usd"); await input.fill("0.01");
  assert(await page.locator("#profit-fee").innerText() === "150 test sats");
  await save.click(); await page.getByText("Margin saved for new requests.", { exact: true }).waitFor();
  assert((await page.locator("#profit-conversion").innerText()).includes("80,000"));
  await page.evaluate(() => { const w=window as any;w.quote={...w.quote,quote:{...w.quote.quote,usdPerBtc:'100000'}};w.view.setExchangeRate(w.quote); });
  assert(await save.isEnabled() && await page.locator("#profit-fee").innerText() === "120 test sats");
  assert((await page.locator("#profit-conversion").innerText()).includes("80,000"));
  await page.evaluate(() => { (window as any).view.setExchangeRate({status:'unavailable'}); });
  assert(await save.isDisabled());
  await page.locator("#profit-mode").selectOption("sats"); await input.fill("8");
  await page.evaluate(() => { (window as any).fail=true; }); await save.click(); await page.getByText(/A job is running/).waitFor();
  assert(await input.inputValue() === "8" && await save.isEnabled());
  for (const invalid of ["-1", "1e3", "0.1234567", ""]) { await input.fill(invalid); assert(await save.isDisabled()); }
  await input.fill("0"); assert(await page.locator("#profit-fee").innerText() === "0 test sats");
  for (const width of [320,375,768,1280]) { await page.setViewportSize({width,height:1000}); assert(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), `Profit editor overflow ${width}`); }
  assert.deepEqual(errors, []);
  assert.deepEqual((await page.evaluate(() => (window as any).calls)).slice(0,2), [{mode:'percentage',value:'20'},{mode:'usd',value:'0.01'}]);
  console.log("Profit admin passed: percentage/sats/USD, cost breakdown, exact save, pinned quote, fresh-quote guard, busy draft recovery, zero disable and responsive layouts.");
} finally { await browser.close(); server.stop(true); }
