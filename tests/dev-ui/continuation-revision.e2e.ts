import { chromium, type Page } from "playwright";
import { mkdtemp, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { developmentStack, type DevPayments } from "../../scripts/dev-payments";
import { createDevelopmentContextVmServer } from "../../src/dev-ui/contextvm-server";


async function eventually(action: () => Promise<boolean>, label: string, timeoutMs = 30_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) { if (await action()) return; await Bun.sleep(250); }
  throw new Error(`CONTINUATION_TIMEOUT:${label}`);
}

async function waitForRevision(page: Page, expectedVersions: number, label: string): Promise<void> {
  await eventually(async () => {
    const error = (await page.locator("#generation-error").textContent())?.trim();
    if (error) throw new Error(`REVISION_UI_ERROR:${error}`);
    return (await page.locator("#versions li").count()) >= expectedVersions;
  }, label, 120_000);
  await page.getByText("Verified preview ready", { exact: true }).waitFor({ timeout: 120_000 });
  await eventually(async () => await page.getByRole("button", { name: "Revise selected version" }).isEnabled(), `${label}-controls-ready`);
}

async function preAdmissionCase(): Promise<void> {
  const stack = developmentStack(true); const config = await stack.up(); const stateRoot = await mkdtemp(join(tmpdir(), "napplet-cvm-54-"));
  const browser = await chromium.launch({ headless: true }); let server = await createDevelopmentContextVmServer({ config, stateRoot, port: 0 });
  try {
    const page = await browser.newPage(); await page.goto(server.url, { waitUntil: "networkidle" });
    await page.getByRole("button", { name: "Connect" }).click(); await page.getByText("Connected").waitFor();
    await page.getByRole("button", { name: "Generate napplet" }).click();
    await page.getByText("Action saved; funding does not start it", { exact: true }).waitFor();
    await page.getByRole("button", { name: "Resume" }).waitFor();
    if ((await page.locator("#timeline").textContent())?.includes("verified preview")) throw new Error("PRE_ADMISSION_EXECUTED_BEFORE_FUNDING");
    const stableUrl = server.url; await server.close();
    server = await createDevelopmentContextVmServer({ config, stateRoot, port: Number(new URL(stableUrl).port) });
    await page.goto(server.url, { waitUntil: "networkidle" }); await page.getByRole("button", { name: "Connect" }).click(); await page.getByText("Connected").waitFor();
    await page.getByRole("button", { name: "Resume" }).waitFor();
    await page.getByLabel("Cashu amount (sats)").fill("4000"); await page.getByRole("button", { name: "Fund with Cashu" }).click(); await page.getByText("Cashu credited", { exact: true }).waitFor();
    await page.getByRole("button", { name: "Resume" }).click(); await page.getByText("Verified preview ready", { exact: true }).waitFor({ timeout: 120_000 });
    const preview = page.frameLocator("#preview").frameLocator("iframe").first(); await preview.getByRole("button", { name: "Add" }).click(); await preview.getByText("1", { exact: true }).waitFor();
    await server.assertGenerationSettlement();
    const evidence = server.generationEvidence();
    if (evidence.result?.status !== "completed" || !evidence.result.artifactId || evidence.result.confirmedSpend !== "5") throw new Error("PRE_ADMISSION_DURABLE_RESULT_MISMATCH");
    if (!((await page.locator("#generation-facts").textContent())?.includes(evidence.result.artifactId))) throw new Error("PRE_ADMISSION_BROWSER_SQL_MISMATCH");
  } catch (error) {
    const safe = server.generationEvidence().error;
    throw new Error(`PRE_ADMISSION_CASE_FAILED:${error instanceof Error ? error.message : "unknown"}${safe ? `:server=${safe}` : ""}`);
  } finally { await browser.close(); await server.close(); await stack.down(true); await rm(stateRoot, { recursive: true, force: true }); }
}

async function revisionCase(): Promise<void> {
  const stack = developmentStack(true); const config = await stack.up(); const stateRoot = await mkdtemp(join(tmpdir(), "napplet-cvm-54-revisions-"));
  const browser = await chromium.launch({ headless: true }); let server = await createDevelopmentContextVmServer({ config, stateRoot, port: 0 });
  try {
    const page = await browser.newPage(); await page.goto(server.url, { waitUntil: "networkidle" });
    await page.getByRole("button", { name: "Connect" }).click(); await page.getByText("Connected").waitFor();
    await page.getByLabel("Cashu amount (sats)").fill("10000"); await page.getByRole("button", { name: "Fund with Cashu" }).click(); await page.getByText("Cashu credited", { exact: true }).waitFor();
    await page.getByRole("button", { name: "Generate napplet" }).click(); await page.getByText("Verified preview ready", { exact: true }).waitFor({ timeout: 120_000 });
    for (const revision of ["Make the counter label more direct", "Make the reset control clearer"]) {
      await page.getByLabel("Revision").fill(revision); await page.getByRole("button", { name: "Revise selected version" }).click();
      await waitForRevision(page, revision.includes("label") ? 2 : 3, "revision-version");
    }
    const versionText = await page.locator("#versions").textContent();
    if (!versionText?.includes("Version 1") || !versionText.includes("Version 2") || !versionText.includes("Version 3")) throw new Error("REVISION_HISTORY_MISSING");
    await page.reload({ waitUntil: "networkidle" }); await page.getByRole("button", { name: "Connect" }).click(); await page.getByText("Connected").waitFor();
    await eventually(async () => (await page.locator("#versions li").count()) === 3, "revision-restart-history");
    await page.getByRole("button", { name: /Version 1:/ }).click(); await eventually(async () => !(await page.locator("#preview").isHidden()), "prior-preview");
    const evidence = server.generationEvidence(); if (evidence.result?.artifactVersion !== 3) throw new Error("REVISION_SQL_VERSION_MISMATCH");
    await server.assertGenerationSettlement();
    // Exercise the same low-balance pending action after a populated revision
    // lineage, then restart before explicit funding/resume.
    await page.getByLabel("Maximum (sats)").fill("5000"); await page.getByLabel("Focused idea").fill("A second focused counter that waits for funding");
    await page.getByRole("button", { name: "Generate napplet" }).click(); await page.getByText("Action saved; funding does not start it", { exact: true }).waitFor();
    const stableUrl = server.url; await server.close(); server = await createDevelopmentContextVmServer({ config, stateRoot, port: Number(new URL(stableUrl).port) });
    await page.goto(server.url, { waitUntil: "networkidle" }); await page.getByRole("button", { name: "Connect" }).click(); await page.getByText("Connected").waitFor(); await page.getByRole("button", { name: "Resume" }).waitFor();
    await page.getByLabel("Cashu amount (sats)").fill("5000"); await page.getByRole("button", { name: "Fund with Cashu" }).click(); await page.getByText("Cashu credited", { exact: true }).waitFor();
    await page.getByRole("button", { name: "Resume" }).click(); await page.getByText("Verified preview ready", { exact: true }).waitFor({ timeout: 120_000 });
  } catch (error) {
    const safe = server.generationEvidence().error;
    throw new Error(`REVISION_CASE_FAILED:${error instanceof Error ? error.message : "unknown"}${safe ? `:server=${safe}` : ""}`);
  } finally { await browser.close(); await server.close(); await stack.down(true); await rm(stateRoot, { recursive: true, force: true }); }
}

export async function runContinuationCase(caseName: "pre-admission-fund-restart-explicit-resume" | "revisions-duplicates-restarts"): Promise<Readonly<{ case: string; status: "passed" }>> {
  if (caseName === "pre-admission-fund-restart-explicit-resume") await preAdmissionCase();
  else await revisionCase();
  return Object.freeze({ case: caseName, status: "passed" as const });
}

/** Reusable one-browser journey for the detached Plan 55 launcher harness. */
export async function runFullContinuationJourney(input: Readonly<{ page: Page; config: DevPayments; url: string; restart(): Promise<string>; observe?(stage: string): Promise<void> }>): Promise<Readonly<{ initialVersions: number; resumed: true }>> {
  const page = input.page;
  await page.goto(input.url, { waitUntil: "networkidle" });
  await page.getByRole("button", { name: "Connect" }).click(); await page.getByText("Connected").waitFor();
  await page.getByLabel("Cashu amount (sats)").fill("10000"); await page.getByRole("button", { name: "Fund with Cashu" }).click(); await page.getByText("Cashu credited", { exact: true }).waitFor(); await input.observe?.("cashu");
  await page.getByRole("button", { name: "Replay Cashu" }).click(); await page.getByText("Cashu replay credited once", { exact: true }).waitFor(); await input.observe?.("cashu-replay");
  await page.getByLabel("NWC amount (sats)").fill("64"); await page.getByRole("button", { name: "Fund with NWC" }).click(); await page.getByText("NWC credited", { exact: true }).waitFor({ timeout: 90_000 }); await input.observe?.("nwc");
  await page.getByRole("button", { name: "Generate napplet" }).click(); await page.getByText("Verified preview ready", { exact: true }).waitFor({ timeout: 120_000 }); await input.observe?.("generation");
  for (const revision of ["Make the counter label more direct", "Make the reset control clearer"]) {
    await page.getByLabel("Revision").fill(revision); await page.getByRole("button", { name: "Revise selected version" }).click();
    await waitForRevision(page, revision.includes("label") ? 2 : 3, "full-flow-revision");
    await input.observe?.(revision.includes("label") ? "revision2" : "revision3");
  }
  const initialVersions = await page.locator("#versions li").count();
  if (initialVersions !== 3) throw new Error("FULL_FLOW_INITIAL_VERSIONS_MISSING");
  await page.getByRole("button", { name: /Version 1:/ }).click();
  await page.getByLabel("Maximum (sats)").fill("5000"); await page.getByLabel("Focused idea").fill("A second focused counter that waits for funding");
  await page.getByRole("button", { name: "Generate napplet" }).click(); await page.getByText("Action saved; funding does not start it", { exact: true }).waitFor(); await input.observe?.("pending-save");
  const restartedUrl = await input.restart();
  await page.goto(restartedUrl, { waitUntil: "networkidle" }); await page.getByRole("button", { name: "Connect" }).click(); await page.getByText("Connected").waitFor(); await page.getByRole("button", { name: "Resume" }).waitFor(); await input.observe?.("post-restart");
  await page.getByLabel("Cashu amount (sats)").fill("5000"); await page.getByRole("button", { name: "Fund with Cashu" }).click(); await page.getByText("Cashu credited", { exact: true }).waitFor(); await input.observe?.("topup");
  await page.getByRole("button", { name: "Resume" }).click(); await page.getByText("Verified preview ready", { exact: true }).waitFor({ timeout: 120_000 }); await input.observe?.("resume");
  return Object.freeze({ initialVersions, resumed: true as const });
}

if (import.meta.main) {
  const requestedCase = process.argv.find((argument) => argument.startsWith("--case="))?.slice("--case=".length) ?? "pre-admission-fund-restart-explicit-resume";
  try {
    if (requestedCase !== "pre-admission-fund-restart-explicit-resume" && requestedCase !== "revisions-duplicates-restarts") throw new Error(`Unknown continuation case: ${requestedCase}`);
    console.log(JSON.stringify(await runContinuationCase(requestedCase)));
    process.exit(0);
  }
  catch (error) { console.error(error); process.exit(1); }
}
