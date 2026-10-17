import type { Page } from "playwright";
import { readFile } from "node:fs/promises";
import { join } from "node:path";

/** Exercise the private one-use ticket and real callback. Playwright does not
 * intercept a URL reached in the middle of an HTTP redirect chain. */
export async function openFixtureAdmin(page: Page, origin: string, root: string, fixture: { authorize(url: string): URL }) {
  await page.route(`${origin}/admin/oauth/start?*`, async route => {
    const start = await fetch(route.request().url(), { redirect: "manual" });
    if (start.status !== 303) return route.fulfill({ status: start.status, body: await start.text() });
    await route.fulfill({ status: 303, headers: { location: fixture.authorize(start.headers.get("location")!).href, "set-cookie": start.headers.get("set-cookie")! }, body: "" });
  });
  const operator = JSON.parse(await readFile(join(root, "cvm-operator/operator.json"), "utf8"));
  await page.goto(`${origin}/admin#key=${operator.adminKey}`);
  await page.locator("#provider-navigation").click();
  await page.getByRole("button", { name: "Continue with ChatGPT", exact: true }).click();
  await page.getByRole("button", { name: "Got it", exact: true }).click();
  await page.locator("#chatgpt-welcome").waitFor({ state: "hidden" });
}
