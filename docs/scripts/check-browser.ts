import assert from "node:assert/strict";
import { mkdir } from "node:fs/promises";
import { chromium } from "../../tests/dev-ui/node_modules/playwright";
const base = process.env.DOCS_URL ?? "http://127.0.0.1:4173/docs/";
const evidence = new URL("../../.local/docs-evidence/", import.meta.url).pathname;
await mkdir(evidence, { recursive: true });
const browser = await chromium.launch({ headless: true });
const failures: string[] = []; let layouts = 0;
try {
  const page = await browser.newPage({ viewport: { width: 1280, height: 900 } });
  page.on("pageerror", error => failures.push(error.message));
  page.on("response", response => { if (response.url().startsWith(base) && response.status() >= 400) failures.push(`${response.status()} ${response.url()}`); });
  for (const width of [280, 320, 390, 768, 1280]) {
    await page.setViewportSize({ width, height: 900 });
    for (const route of ["", "users/quick-start", "operators/providers", "operators/static-hosting", "implementers/mcp", "implementers/schemas", "developers/schema-changes"]) {
      await page.goto(base + route, { waitUntil: "networkidle" });
      const size = await page.evaluate(() => ({ body: document.documentElement.scrollWidth, viewport: innerWidth }));
      assert.deepEqual(failures, []);
      assert(size.body <= size.viewport + 1, `Horizontal overflow at ${width}: ${route} (${size.body})`);
      assert(await page.locator("h1").count(), `No heading: ${route}`);
      layouts++;
    }
  }
  await page.goto(base, { waitUntil: "networkidle" });
  await page.screenshot({ path: `${evidence}/home-desktop.png`, fullPage: true });
  await page.getByRole("button", { name: "Search" }).click();
  await page.locator("#localsearch-input").fill("MCP");
  await page.locator(".VPLocalSearchBox .result").first().waitFor();
  assert((await page.locator(".VPLocalSearchBox").innerText()).includes("MCP"));
  await page.locator(".VPLocalSearchBox .result").first().click();
  await page.waitForURL(url => url.pathname.startsWith("/docs/") && url.pathname !== "/docs/");
  await page.reload({ waitUntil: "networkidle" });
  assert(await page.locator("h1").count());
  await page.setViewportSize({ width: 320, height: 700 });
  await page.goto(base + "users/quick-start", { waitUntil: "networkidle" });
  await page.getByRole("button", { name: "mobile navigation" }).click();
  assert(await page.locator(".VPNavScreen").isVisible());
  await page.locator(".VPNavScreen").getByRole("link", { name: "Integrate", exact: true }).click();
  await page.waitForURL("**/docs/implementers/");
  await page.locator(".VPNavScreen").waitFor({ state: "hidden" });
  await page.waitForTimeout(250);
  await page.screenshot({ path: `${evidence}/integrate-mobile.png`, fullPage: true });
  await page.getByRole("button", { name: "Menu", exact: true }).click();
  assert(await page.locator(".VPSidebar.open").isVisible());
  await page.locator(".VPSidebar.open").getByRole("link", { name: "Use from an MCP client", exact: true }).click();
  await page.waitForURL("**/docs/implementers/mcp");
  await page.locator(".VPSidebar.open").waitFor({ state: "hidden" });
  await page.waitForTimeout(250);
  await page.emulateMedia({ colorScheme: "dark", reducedMotion: "reduce" });
  await page.screenshot({ path: `${evidence}/mcp-mobile.png`, fullPage: true });
  assert.deepEqual(failures, []);
  await Bun.write(`${evidence}/checks.json`, JSON.stringify({ layouts, search: true, mobileNavigation: true, sidebar: true, deepReload: true, browserErrors: failures }, null, 2));
  console.log(`Docs browser check passed: ${layouts} layouts, search, navigation, sidebar and deep reload.`);
} finally { await browser.close(); }
