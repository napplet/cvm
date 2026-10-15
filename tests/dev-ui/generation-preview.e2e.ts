/** Full ContextVM → SQL → worker → Paja browser tracer. */
import { chromium } from "playwright";
import { createDevelopmentContextVmServer } from "../../src/dev-ui/contextvm-server";

const requestedCase = process.argv.find((arg) => arg.startsWith("--case="))?.slice("--case=".length) ?? "deterministic-real-worker-compatible-host";
if (requestedCase !== "deterministic-real-worker-compatible-host" && requestedCase !== "boundaries-platform-provider-recovery") throw new Error(`Unknown generation preview case: ${requestedCase}`);
const server = await createDevelopmentContextVmServer({ testMode: true });
const browser = await chromium.launch({ headless: true });
let activePage: Awaited<ReturnType<typeof browser.newPage>> | undefined;
try {
  const page = await browser.newPage(); activePage = page; const requests: string[] = [];
  page.on("request", (request) => requests.push(new URL(request.url()).pathname));
  await page.goto(server.url, { waitUntil: "networkidle" });
  await page.getByRole("button", { name: "Connect" }).click(); await page.getByText("Connected").waitFor();
  await page.getByLabel("Cashu amount (sats)").fill("4000"); await page.getByRole("button", { name: "Fund with Cashu" }).click(); await page.getByText("Cashu credited").waitFor();
  await page.getByLabel("Focused idea").fill("A focused tap counter for daily practice"); await page.getByRole("button", { name: "Generate napplet" }).click();
  await page.getByText("Verified preview ready", { exact: true }).waitFor({ timeout: 120_000 });
  const preview = page.frameLocator("#preview"); const appFrame = preview.frameLocator("iframe").first();
  await appFrame.getByRole("button", { name: "Add" }).click(); await appFrame.getByText("1", { exact: true }).waitFor();
  await server.assertGenerationSettlement();
  const evidence = server.generationEvidence();
  if (evidence.result?.status !== "completed" || !evidence.result.generation) throw new Error("GENERATION_EVIDENCE_INCOMPLETE");
  const sandbox = await preview.locator("iframe").first().getAttribute("sandbox"); const facts = await page.locator("#generation-facts").textContent();
  const isolation = await appFrame.locator("body").evaluate(() => ({ origin: location.origin, nostr: typeof (window as any).nostr }));
  if (sandbox !== "allow-scripts" || isolation.origin !== "null" || isolation.nostr !== "undefined" || !facts?.includes(evidence.result.confirmedSpend) || !facts.includes(evidence.result.artifactId ?? "") || !facts.includes(evidence.result.generation.provider) || !facts.includes(evidence.result.generation.usage.map((line) => `${line.dimension}:${line.units}`).join(", "))) throw new Error("GENERATION_PREVIEW_FACTS_MISMATCH");
  if (requests.some((path) => /\/(?:account|balance|top_up|generation|session)\b/.test(path))) throw new Error(`HTTP product command detected: ${requests.join(",")}`);
  console.log(JSON.stringify({ case: requestedCase, provider: evidence.provider, requests }));
} catch (error) {
  console.error(JSON.stringify({ generation: await activePage?.locator("#generation-status").textContent(), facts: await activePage?.locator("#generation-facts").textContent(), evidence: server.generationEvidence() }));
  throw error;
} finally { await browser.close(); await server.close(); }
