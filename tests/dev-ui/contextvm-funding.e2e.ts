/**
 * Real browser funding evidence. This package intentionally has its own
 * Playwright pin and lockfile so the immutable root package stays untouched.
 */
import { chromium } from "playwright";
import { createDevelopmentContextVmServer } from "../../src/dev-ui/contextvm-server";

const requestedCase = process.argv.find((arg) => arg.startsWith("--case="))?.slice("--case=".length) ?? "cashu-wire";

if (requestedCase !== "cashu-wire" && requestedCase !== "both-rails-restart-replay") {
  throw new Error(`Unknown dev UI case: ${requestedCase}`);
}

const server = await createDevelopmentContextVmServer({ testMode: true });
const browser = await chromium.launch({ headless: true });
let activePage: Awaited<ReturnType<typeof browser.newPage>> | undefined;
try {
  const page = await browser.newPage();
  activePage = page;
  const requests: string[] = [];
  page.on("request", (request) => requests.push(new URL(request.url()).pathname));
  await page.goto(`${server.url}/dev`, { waitUntil: "networkidle" });
  await page.getByRole("button", { name: "Connect" }).click();
  await page.getByText("Connected").waitFor();

  await page.getByLabel("Cashu amount (sats)").fill("64");
  await page.getByRole("button", { name: "Fund with Cashu" }).click();
  await page.getByText("Cashu credited").waitFor();
  // The Cashu request is gross; Nutshell applies its one-sat input fee and
  // the UI intentionally displays the verified net ledger credit.
  await page.getByText("63 sats").waitFor();
  await page.getByRole("button", { name: "Replay Cashu" }).click();
  await page.getByText("Cashu replay credited once").waitFor();
  await page.getByText("63 sats").waitFor();

  if (requestedCase === "both-rails-restart-replay") {
    server.stopReconciler();
    await page.getByLabel("NWC amount (sats)").fill("3750");
    await page.getByRole("button", { name: "Fund with NWC" }).click();
    await page.getByText(/^NWC settlement pending \(/).waitFor();
    await server.assertNwcPending();
    server.restartReconciler();
    await page.getByText("NWC credited").waitFor({ timeout: 90_000 });
    await page.getByText("3813 sats").waitFor();
  }

  if (requests.some((path) => /\/(?:account|balance|top_up|generation|session)\b/.test(path))) {
    throw new Error(`HTTP product command detected: ${requests.join(",")}`);
  }
  await server.assertFundingEvidence(requestedCase);
  console.log(JSON.stringify({ status: "passed", case: requestedCase, url: server.url, requests }));
} catch (error) {
  console.error(JSON.stringify({ case: requestedCase, balance: await activePage?.locator("#balance").textContent(), funding: await activePage?.locator("#funding-status").textContent() }));
  throw error;
} finally {
  try { await server.close(); }
  finally { await browser.close(); }
}
