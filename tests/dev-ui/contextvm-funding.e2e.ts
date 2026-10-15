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
try {
  const page = await browser.newPage();
  const requests: string[] = [];
  page.on("request", (request) => requests.push(new URL(request.url()).pathname));
  await page.goto(server.url, { waitUntil: "networkidle" });
  await page.getByRole("button", { name: "Connect" }).click();
  await page.getByText("Connected").waitFor();

  await page.getByLabel("Cashu amount (sats)").fill("64");
  await page.getByRole("button", { name: "Fund with Cashu" }).click();
  await page.getByText("Cashu credited").waitFor();
  await page.getByText("64 sats").waitFor();
  await page.getByRole("button", { name: "Replay Cashu" }).click();
  await page.getByText("Cashu replay credited once").waitFor();
  await page.getByText("64 sats").waitFor();

  if (requestedCase === "both-rails-restart-replay") {
    server.stopReconciler();
    await page.getByLabel("NWC amount (sats)").fill("3750");
    await page.getByRole("button", { name: "Fund with NWC" }).click();
    server.restartReconciler();
    await page.getByText("NWC credited").waitFor({ timeout: 90_000 });
    await page.getByText("3814 sats").waitFor();
  }

  if (requests.some((path) => /\/(?:account|balance|top_up|generation|session)\b/.test(path))) {
    throw new Error(`HTTP product command detected: ${requests.join(",")}`);
  }
  await server.assertFundingEvidence(requestedCase);
  console.log(JSON.stringify({ case: requestedCase, url: server.url, requests }));
} finally {
  await browser.close();
  await server.close();
}
