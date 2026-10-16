/**
 * Browser-only development boundary gate.  It deliberately starts the server
 * in test mode: each execution owns an isolated Docker/Postgres/payment stack
 * and never resets a developer's default local state.
 */
import { chromium, type Page } from "playwright";
import { createDevelopmentContextVmServer } from "../../src/dev-ui/contextvm-server";

const requestedCase = process.argv.find((arg) => arg.startsWith("--case="))?.slice("--case=".length) ?? "security-accessibility";
if (requestedCase !== "security-accessibility") throw new Error(`Unknown security/accessibility case: ${requestedCase}`);

function requireThat(condition: unknown, code: string): asserts condition {
  if (!condition) throw new Error(code);
}

async function connectAndGenerate(page: Page): Promise<void> {
  await page.getByRole("button", { name: "Connect" }).click();
  await page.getByText("Connected").waitFor();
  await page.getByLabel("Cashu amount (sats)").fill("4000");
  await page.getByRole("button", { name: "Fund with Cashu" }).click();
  await page.getByText("Cashu credited").waitFor();
  await page.getByLabel("Focused idea").fill("A focused counter used only for browser boundary evidence");
  await page.getByRole("button", { name: "Generate napplet" }).click();
  await page.getByText("Verified preview ready", { exact: true }).waitFor({ timeout: 120_000 });
}

async function assertResponsiveWorkspace(page: Page, width: number): Promise<void> {
  await page.setViewportSize({ width, height: 900 });
  await page.goto((await page.evaluate(() => location.href)), { waitUntil: "networkidle" });
  const layout = await page.evaluate(() => ({ scrollWidth: document.documentElement.scrollWidth, viewportWidth: window.innerWidth }));
  requireThat(layout.scrollWidth <= layout.viewportWidth, `PAGE_HORIZONTAL_OVERFLOW:${width}:${layout.scrollWidth}:${layout.viewportWidth}`);
  const controls = await page.locator("button, input").evaluateAll((elements) => elements.map((element) => {
    const box = element.getBoundingClientRect();
    const style = getComputedStyle(element);
    return { hidden: (element as HTMLElement).hidden, disabled: (element as HTMLButtonElement).disabled, width: box.width, height: box.height, outline: style.outlineStyle, tag: element.tagName };
  }));
  for (const control of controls) {
    // A continuation control may be structurally present under a hidden
    // section until a pending action exists; only rendered controls have a
    // pointer/keyboard target to measure.
    if (control.hidden || control.width === 0 || control.height === 0) continue;
    requireThat(control.width >= 44 && control.height >= 44, `TARGET_TOO_SMALL:${width}:${control.tag}:${control.width}x${control.height}`);
  }
  const labelled = await page.locator("input").evaluateAll((inputs) => inputs.map((input) => ({ id: input.id, labels: [...input.labels ?? []].map((label) => label.textContent?.trim() ?? "") })));
  requireThat(labelled.length > 0 && labelled.every((input) => input.labels.some(Boolean)), `INPUT_ACCESSIBLE_NAME_MISSING:${width}`);
  await page.keyboard.press("Tab");
  const focused = await page.evaluate(() => {
    const active = document.activeElement as HTMLElement | null;
    return active ? { tag: active.tagName, outline: getComputedStyle(active).outlineStyle, outlineWidth: getComputedStyle(active).outlineWidth } : undefined;
  });
  requireThat(focused && ["BUTTON", "INPUT"].includes(focused.tag) && focused.outline !== "none" && focused.outlineWidth !== "0px", `KEYBOARD_FOCUS_NOT_VISIBLE:${width}`);
}

const server = await createDevelopmentContextVmServer({ testMode: true });
const browser = await chromium.launch({ headless: true });
const canaryRequests: string[] = [];
const canary = Bun.serve({ hostname: "127.0.0.1", port: 0, fetch(request) { canaryRequests.push(new URL(request.url).pathname); return new Response("unexpected", { headers: { "access-control-allow-origin": "*" } }); } });
let page: Page | undefined;
const consoleMessages: string[] = [];
const requestUrls: string[] = [];
const relayFrames: string[] = [];

try {
  for (const route of ["/account", "/balance", "/top_up", "/generation", "/session", "/api/generate", "/api/account"]) {
    const response = await fetch(`${server.url}${route}`);
    requireThat(response.status === 404, `HTTP_APPLICATION_ROUTE_EXPOSED:${route}:${response.status}`);
  }
  requireThat((await fetch(`${server.url}/bootstrap`)).status === 200, "BOOTSTRAP_UNAVAILABLE");

  page = await browser.newPage({ viewport: { width: 1280, height: 900 } });
  page.on("console", (message) => consoleMessages.push(message.text()));
  page.on("request", (request) => requestUrls.push(request.url()));
  page.on("websocket", (socket: any) => {
    socket.on("framesent", (event: { payload: string | Buffer }) => relayFrames.push(String(event.payload)));
    socket.on("framereceived", (event: { payload: string | Buffer }) => relayFrames.push(String(event.payload)));
  });
  await page.goto(`${server.url}/dev`, { waitUntil: "networkidle" });

  for (const selector of ["#connection-status[aria-live='polite']", "#funding-status[aria-live='polite']", "#generation-status[aria-live='polite']", "#generation-error[role='alert']"]) {
    requireThat(await page.locator(selector).count() === 1, `STATUS_A11Y_CONTRACT_MISSING:${selector}`);
  }

  await connectAndGenerate(page);
  await server.assertGenerationSettlement();
  const mode = (await page.locator("#provider-mode").textContent())?.trim() ?? "";
  requireThat(/^(Deterministic fixture|Provider:\s+.+|Configured\s+.+)$/u.test(mode), `MODEL_MODE_NOT_HONEST:${mode}`);
  const privateKey = await page.evaluate(() => Object.entries(sessionStorage).find(([key, value]) => key.includes("napplet-cvm/dev-contextvm-key/") && /^[a-f0-9]{64}$/u.test(value))?.[1]);
  requireThat(privateKey, "BROWSER_IDENTITY_NOT_SESSION_SCOPED");
  const documentText = await page.locator("html").textContent() ?? "";
  const storageOrDom = await page.evaluate(() => ({ bodyHtml: document.body.innerHTML, urls: performance.getEntriesByType("resource").map((entry) => entry.name) }));
  for (const value of [privateKey]) {
    requireThat(!documentText.includes(value) && !storageOrDom.bodyHtml.includes(value), "BROWSER_PRIVATE_KEY_IN_DOM");
    requireThat(!requestUrls.some((url) => url.includes(value)) && !storageOrDom.urls.some((url) => url.includes(value)), "BROWSER_PRIVATE_KEY_IN_HTTP");
    requireThat(!consoleMessages.some((message) => message.includes(value)), "BROWSER_PRIVATE_KEY_IN_CONSOLE");
    requireThat(!relayFrames.some((frame) => frame.includes(value)), "BROWSER_PRIVATE_KEY_IN_RELAY_FRAME");
  }
  requireThat(!requestUrls.some((url) => /\/(?:account|balance|top_up|generation|session)\b/u.test(new URL(url).pathname)), `HTTP_PRODUCT_COMMAND_DETECTED:${requestUrls.join(",")}`);

  const preview = page.frameLocator("#preview");
  const nestedPreview = preview.frameLocator("iframe").first();
  requireThat(await preview.locator("iframe").first().getAttribute("sandbox") === "allow-scripts", "PREVIEW_SANDBOX_POLICY_INVALID");
  const frameBoundary = await nestedPreview.locator("body").evaluate(async (canaryUrl) => {
    let storageDenied = false;
    try { void localStorage.length; } catch { storageDenied = true; }
    let parentStorageDenied = false;
    try { void window.parent.localStorage.length; } catch { parentStorageDenied = true; }
    let fetchDenied = false;
    try { await fetch(canaryUrl); } catch { fetchDenied = true; }
    return { origin: location.origin, storageDenied, parentStorageDenied, fetchDenied, nostr: typeof (window as any).nostr };
  }, `http://127.0.0.1:${canary.port}/LISTENING`);
  requireThat(frameBoundary.origin === "null" && frameBoundary.storageDenied && frameBoundary.parentStorageDenied && frameBoundary.fetchDenied && frameBoundary.nostr === "undefined" && canaryRequests.length === 0, `OPAQUE_PREVIEW_BOUNDARY_FAILED:${JSON.stringify(frameBoundary)}`);

  // Re-open fresh pages to ensure each breakpoint measures the static workspace
  // rather than a post-generation iframe's internal scrolling surface.
  for (const width of [375, 768, 1280]) await assertResponsiveWorkspace(page, width);
  await page.emulateMedia({ reducedMotion: "reduce" });
  const reducedMotion = await page.evaluate(() => [...document.querySelectorAll<HTMLElement>("*")].every((element) => {
    const style = getComputedStyle(element);
    return style.animationDuration === "0s" && (style.transitionDuration === "0s" || style.transitionDuration === "0.1s");
  }));
  requireThat(reducedMotion, "REDUCED_MOTION_NOT_HONORED");
  console.log(JSON.stringify({ status: "passed", case: requestedCase, url: server.url, mode, requests: requestUrls.map((url) => new URL(url).pathname), canaryRequests }));
} catch (error) {
  console.error(JSON.stringify({ case: requestedCase, connection: await page?.locator("#connection-status").textContent(), funding: await page?.locator("#funding-status").textContent(), generation: await page?.locator("#generation-status").textContent(), error: error instanceof Error ? error.message : String(error) }));
  throw error;
} finally {
  try { await server.close(); }
  finally { await browser.close(); canary.stop(true); }
}
