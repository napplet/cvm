import { chromium, type Page } from "playwright";
import { mkdir } from "node:fs/promises";
import { resolve } from "node:path";
import { createDevelopmentPool, type DevPayments } from "../../scripts/dev-payments";
import { accountIdForPrincipal } from "../../src/domain/account-command";
import { runFullContinuationJourney } from "./continuation-revision.e2e";

const root = resolve(import.meta.dir, "../..");
const instance = `test-full-${crypto.randomUUID().slice(0, 8)}`;
const env = { ...process.env, NAPPLET_CVM_DEV_INSTANCE: instance };
for (const name of ["OPENAI_API_KEY", "NAPPLET_CVM_OPENAI_MODEL", "NAPPLET_CVM_OPENAI_PROFILE", "NAPPLET_CVM_OPENAI_PRICE_CARD", "NAPPLET_CVM_OPENAI_PRICE_SOURCES"]) delete (env as Record<string, string | undefined>)[name];
const evidenceRoot = resolve(root, ".local/development-gui-evidence");
const hashes = { "package.json": "cbcc433278d32391b075576ebd847ae30039f1d86ad229a149f5566856989f23", "bun.lock": "8916ee4ec92924ae9e09bc4f315fd6656033812696e35a1b7785161d872c5ac3" };
type Status = { ready: boolean; url: string; mode: string; configPath: string };
type Snapshot = { stage: string; settled: string; held: string; available: string; credits: number; actions: number; providers: number; receipts: number; debits: number; artifacts: number; workers: number; charges: string };

function check(condition: unknown, code: string): asserts condition { if (!condition) throw new Error(code); }
async function integrity(): Promise<void> {
  for (const [file, expected] of Object.entries(hashes)) check(new Bun.CryptoHasher("sha256").update(await Bun.file(resolve(root, file)).arrayBuffer()).digest("hex") === expected, `ROOT_MANIFEST_CHANGED:${file}`);
}
async function launch(command: string, ...args: string[]): Promise<string> {
  const child = Bun.spawn([process.execPath, "scripts/dev.ts", command, ...args], { cwd: root, env, stdout: "pipe", stderr: "pipe" });
  const timer = setTimeout(() => child.kill("SIGTERM"), 600_000);
  try {
    const [stdout, stderr, exitCode] = await Promise.all([new Response(child.stdout).text(), new Response(child.stderr).text(), child.exited]);
    // Startup diagnostics belong to the launcher's private log. Never echo an
    // arbitrary subprocess stream into browser test evidence.
    check(exitCode === 0, `FULL_FLOW_LAUNCHER_FAILED:${command}:exit=${exitCode}:diagnosticBytes=${stderr.length}`);
    return stdout;
  } finally { clearTimeout(timer); }
}
async function status(): Promise<Status> {
  const value = JSON.parse(await launch("status")) as Status;
  check(value.ready && /^http:\/\/127\.0\.0\.1:\d+\/?$/.test(value.url), "FULL_FLOW_LAUNCHER_NOT_READY");
  return value;
}

await integrity();
await mkdir(evidenceRoot, { recursive: true, mode: 0o700 });
let browser: Awaited<ReturnType<typeof chromium.launch>> | undefined;
let activePage: Page | undefined;
let failedReport: Record<string, unknown> | undefined;
const observations: Snapshot[] = [];
try {
  await launch("up");
  let current = await status();
  check(current.mode.toLowerCase().includes("deterministic"), "FULL_FLOW_EXPECTS_EXPLICIT_DETERMINISTIC_MODE");
  let config = await Bun.file(current.configPath).json() as DevPayments;
  browser = await chromium.launch({ headless: true });
  const page = await browser.newPage({ viewport: { width: 1280, height: 1000 } });
  activePage = page;
  const observe = async (stage: string): Promise<void> => {
    const pubkey = (await page.locator("#connection-status").textContent())?.match(/[a-f0-9]{64}/)?.[0];
    check(pubkey, `FULL_FLOW_IDENTITY_MISSING:${stage}`);
    const accountId = await accountIdForPrincipal({ pubkey });
    const pool = createDevelopmentPool(config.databaseUrl);
    try {
      const money = (await pool.query("SELECT settled_available::text AS settled,held::text,(settled_available-held)::text AS available FROM account_balance_projection WHERE account_id=$1", [accountId])).rows[0];
      check(money, `FULL_FLOW_ACCOUNT_MISSING:${stage}`);
      check(await page.locator("#balance").textContent() === `Available: ${money.available} sats · held: ${money.held} sats · settled: ${money.settled} sats`, `FULL_FLOW_BROWSER_SQL_BALANCE_MISMATCH:${stage}`);
      const counts: Record<string, number> = {};
      for (const [label, table, where] of [
        ["credits", "ledger_entries", " AND direction='credit'"], ["debits", "ledger_entries", " AND direction='debit'"],
        ["actions", "metered_actions", ""], ["providers", "provider_operations", ""], ["receipts", "usage_receipts", ""],
        ["artifacts", "session_artifacts", " AND verified=true"], ["workers", "development_worker_results", " AND state='completed'"],
      ]) counts[label!] = Number((await pool.query(`SELECT count(*)::int AS count FROM ${table} WHERE account_id=$1${where}`, [accountId])).rows[0]?.count);
      const charges = String((await pool.query("SELECT COALESCE(SUM(amount),0)::text AS total FROM ledger_entries WHERE account_id=$1 AND direction='debit'", [accountId])).rows[0]?.total);
      const snapshot = { stage, ...money, ...counts, charges } as Snapshot;
      const completed = stage === "generation" ? 1 : stage === "revision2" ? 2 : ["revision3", "pending-save", "post-restart", "topup"].includes(stage) ? 3 : stage === "resume" ? 4 : 0;
      for (const kind of ["actions", "providers", "receipts", "debits", "artifacts", "workers"] as const) check(snapshot[kind] === completed, `FULL_FLOW_EFFECT_COUNT:${stage}:${kind}:${snapshot[kind]}`);
      check(charges === String(completed * 5), `FULL_FLOW_EXACT_CHARGE:${stage}`);
      const expectedCredits = stage === "cashu" || stage === "cashu-replay" ? 1 : stage === "topup" || stage === "resume" ? 3 : 2;
      check(snapshot.credits === expectedCredits, `FULL_FLOW_DUPLICATE_CREDIT:${stage}`);
      if (["generation", "revision2", "revision3", "resume"].includes(stage)) {
        const latest = (await pool.query("SELECT terminal_result FROM metered_actions WHERE account_id=$1 AND state='verified' ORDER BY settled_at DESC LIMIT 1", [accountId])).rows[0]?.terminal_result as Record<string, unknown>;
        const shown = await page.locator("#generation-facts").evaluate((list) => Object.fromEntries([...list.querySelectorAll("dt")].map((term) => [term.textContent, term.nextElementSibling?.textContent])));
        for (const [label, field] of [["charge", "confirmedSpend"], ["remainingMaximum", "remainingCap"], ["remainingBalance", "remainingBalance"], ["version", "artifactVersion"], ["artifact", "artifactId"]]) check(shown[label!] === String(latest[field!]), `FULL_FLOW_DISPLAYED_ACTION_MISMATCH:${stage}:${label}`);
        const timeline = await page.locator("#timeline").textContent() ?? "";
        for (const event of ["source recorded", "provider recorded", "worker completed", "artifact verified", "ledger settled"]) check(timeline.includes(event), `FULL_FLOW_DURABLE_TIMELINE_MISSING:${stage}:${event}`);
      }
      if (stage === "pending-save" || stage === "post-restart" || stage === "topup") {
        const saved = (await pool.query("SELECT count(*)::int AS count FROM development_pending_actions WHERE account_id=$1 AND state='saved'", [accountId])).rows[0]?.count;
        check(saved === 1, `FULL_FLOW_PENDING_ACTION_NOT_DURABLE:${stage}`);
      }
      observations.push(snapshot);
      console.log(JSON.stringify({ stage, status: "verified", settled: snapshot.settled, charges }));
    } finally { await pool.end(); }
  };
  let watchErrors = true;
  const monitor = async (): Promise<never> => {
    while (watchErrors) {
      const error = await page.locator("#generation-error").textContent({ timeout: 1_000 }).catch(() => "");
      if (error?.trim()) throw new Error(`FULL_FLOW_UI_ERROR:${error.trim()}`);
      await Bun.sleep(500);
    }
    return new Promise<never>(() => {});
  };
  const result = await Promise.race([monitor(), runFullContinuationJourney({ page, config, url: current.url, observe, restart: async () => {
    await launch("down"); await launch("up"); current = await status();
    config = await Bun.file(current.configPath).json() as DevPayments;
    return current.url;
  } })]).finally(() => { watchErrors = false; });
  check(observations.map(({ stage }) => stage).join(",") === "cashu,cashu-replay,nwc,generation,revision2,revision3,pending-save,post-restart,topup,resume", "FULL_FLOW_OBSERVATION_COVERAGE_INCOMPLETE");
  const preview = page.frameLocator("#preview").frameLocator("iframe").first();
  await preview.getByRole("button", { name: "Add", exact: true }).click();
  await preview.getByText("1", { exact: true }).waitFor();
  check((await page.locator("#publication-status").textContent())?.includes("publish to your Blossom servers"), "FULL_FLOW_PUBLICATION_MODE_MISREPRESENTED");
  for (const width of [1280, 768, 375]) {
    await page.setViewportSize({ width, height: 1000 });
    check(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), `FULL_FLOW_COMPLETED_LAYOUT_OVERFLOW:${width}`);
    await page.locator("#preview").scrollIntoViewIfNeeded();
    await preview.getByRole("button", { name: "Add", exact: true }).waitFor({ state: "visible" });
    await page.screenshot({ path: resolve(evidenceRoot, `full-flow-${width}.png`), fullPage: true });
  }
  await integrity();
  const report = { status: "passed", mode: current.mode, journey: result, observations, boundaries: ["Chromium", "encrypted ContextVM", "relay", "Cashu", "NWC", "PostgreSQL", "durable metering", "isolated worker", "verification", "Paja preview", "detached service restart"], configuredProvider: "not exercised without explicit credentials" };
  await Bun.write(resolve(evidenceRoot, "full-flow-latest.json"), `${JSON.stringify(report, null, 2)}\n`);
  console.log(JSON.stringify(report));
} catch (error) {
  const ui = activePage && !activePage.isClosed() ? await activePage.locator("#generation-error").textContent({ timeout: 1_000 }).catch(() => "") : "";
  failedReport = { status: "failed", code: error instanceof Error ? error.message : "FULL_FLOW_FAILED", ui, observations };
  await Bun.write(resolve(evidenceRoot, "full-flow-latest.json"), `${JSON.stringify(failedReport, null, 2)}\n`);
  throw error;
} finally {
  try {
    await launch("reset", "--confirm");
    if (failedReport) {
      // Shutdown records only allowlisted diagnostic codes in the private log.
      // Preserve those codes for CI without uploading any private state files.
      const log = await Bun.file(resolve(root, ".local/napplet-cvm-dev", instance, "contextvm-server.log")).text().catch(() => "");
      const serverErrorCodes = log.split("\n").flatMap((line) => {
        try { const entry = JSON.parse(line); return entry.code === "generation-error" && typeof entry.detail === "string" && /^[A-Z][A-Z0-9_:-]{2,120}$/.test(entry.detail) ? [entry.detail] : []; }
        catch { return []; }
      });
      await Bun.write(resolve(evidenceRoot, "full-flow-latest.json"), `${JSON.stringify({ ...failedReport, serverErrorCodes }, null, 2)}\n`);
    }
  } finally { await browser?.close(); }
}
