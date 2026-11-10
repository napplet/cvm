import { expect, test } from "bun:test";
import { chromium } from "playwright";
import { resolve } from "node:path";

const integration = process.env.NAPPLET_RUN_SERVICE_E2E === "1" ? test : test.skip;
integration("browser payment selection handles multiple methods, direct fees, cancellation and untrusted labels", async () => {
  const bundle = await Bun.build({ entrypoints: [resolve(import.meta.dir, "../../src/dev-ui/browser/payment-selection.ts")], target: "browser" });
  expect(bundle.success).toBe(true);
  const script = await bundle.outputs[0]!.text();
  const server = Bun.serve({ hostname: "127.0.0.1", port: 0, fetch(request) {
    return new URL(request.url).pathname === "/selection.js" ? new Response(script, { headers: { "content-type": "text/javascript" } })
      : new Response('<!doctype html><script type="module">import { selectPaymentMethod } from "/selection.js"; window.selectPaymentMethod = selectPaymentMethod;</script>', { headers: { "content-type": "text/html" } });
  } });
  const browser = await chromium.launch({ headless: true });
  try {
    const page = await browser.newPage(); page.setDefaultTimeout(15_000);
    page.on("pageerror", error => console.error(error.message));
    await page.goto(server.url.href);
    await page.waitForFunction(() => typeof (window as any).selectPaymentMethod === "function");
    const begin = (methods: unknown[]) => page.evaluate(methods => {
      (window as any).selection = undefined;
      void (window as any).selectPaymentMethod(methods).then((result: unknown) => (window as any).selection = result, (error: Error) => (window as any).selection = { error: error.message });
    }, methods);
    const result = async () => { await page.waitForFunction(() => (window as any).selection !== undefined); return page.evaluate(() => (window as any).selection); };
    const external = { id: "membership", label: "Membership", input: "external" };
    const direct = { id: "voucher", label: "<img src=x onerror=alert(1)>", description: "<script>private()</script>", input: "direct" };
    await begin([external, direct]);
    await page.locator("dialog select").selectOption("voucher");
    expect(await page.locator("dialog img, dialog script").count()).toBe(0);
    await page.getByRole("button", { name: "Continue", exact: true }).click();
    expect(await page.locator("dialog").isVisible()).toBe(true);
    await page.locator("dialog textarea").fill("private-voucher");
    await page.locator("dialog input").fill("2");
    await page.getByRole("button", { name: "Continue", exact: true }).click();
    expect(await result()).toEqual({ method: direct, token: "private-voucher", maxFee: "2" });
    expect(await page.locator("dialog, textarea").count()).toBe(0);
    await begin([external, direct]); await page.getByRole("button", { name: "Cancel", exact: true }).click();
    expect(await result()).toEqual({ error: "PAYMENT_SELECTION_CANCELLED" });
    await begin([external]); expect(await result()).toEqual({ method: external });
    expect(await page.locator("dialog").count()).toBe(0);
    await begin([]); expect(await result()).toEqual({ error: "PAYMENT_METHOD_UNAVAILABLE" });
  } finally { await browser.close(); server.stop(true); }
}, 30_000);
