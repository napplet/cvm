import { chmod, mkdir, readFile, rm, stat, writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import { developmentStack, type DevPayments } from "./dev-payments";
import { assertLauncherReadiness, type DevelopmentMode } from "../src/dev/readiness";

const root = resolve(import.meta.dir, "..");
const instancePattern = /^[a-z0-9][a-z0-9-]{0,47}$/u;
type Scope = Readonly<{ instance: string; isolated: boolean; root: string; stateRoot: string; configPath: string; recordPath: string; logPath: string }>;
type LaunchRecord = Readonly<{ version: 1; instance: string; port: number; pid?: number; url: string; stateRoot: string; configPath: string; mode?: DevelopmentMode; workerImageDigest?: string }>;

function scope(): Scope {
  const instance = process.env.NAPPLET_CVM_DEV_INSTANCE ?? "default";
  if (!instancePattern.test(instance)) throw new Error("DEV_INSTANCE_INVALID");
  const isolated = instance !== "default";
  const instanceRoot = isolated ? resolve(root, ".local", "napplet-cvm-dev", instance) : resolve(root, ".local");
  return Object.freeze({ instance, isolated, root: instanceRoot, stateRoot: isolated ? resolve(instanceRoot, "state") : instanceRoot, configPath: isolated ? resolve(instanceRoot, "payments", "payments.json") : resolve(instanceRoot, "napplet-cvm-dev-payments", "payments.json"), recordPath: isolated ? resolve(instanceRoot, "launcher.json") : resolve(instanceRoot, "napplet-cvm-dev-launcher.json"), logPath: isolated ? resolve(instanceRoot, "contextvm-server.log") : resolve(instanceRoot, "napplet-cvm-dev-contextvm.log") });
}

async function run(argv: string[], input: Readonly<{ cwd?: string; env?: Record<string, string | undefined>; timeoutMs?: number }> = {}): Promise<string> {
  const child = Bun.spawn(argv, { cwd: input.cwd ?? root, env: { ...process.env, ...input.env }, stdout: "pipe", stderr: "pipe", stdin: "ignore" });
  const timeout = setTimeout(() => child.kill(), input.timeoutMs ?? 120_000);
  const [stdout, stderr, code] = await Promise.all([new Response(child.stdout).text(), new Response(child.stderr).text(), child.exited]);
  clearTimeout(timeout);
  if (code !== 0) throw new Error(`DEV_COMMAND_FAILED:${argv.join(" ")}:${stderr.slice(0, 4_000)}`);
  return stdout;
}

async function exists(path: string): Promise<boolean> { try { await stat(path); return true; } catch { return false; } }
async function readRecord(value: Scope): Promise<LaunchRecord | undefined> {
  try {
    const record = JSON.parse(await readFile(value.recordPath, "utf8")) as LaunchRecord;
    if (record.version !== 1 || record.instance !== value.instance || !Number.isInteger(record.port) || record.port < 1 || record.port > 65535 || record.stateRoot !== value.stateRoot || record.configPath !== value.configPath || record.url !== `http://127.0.0.1:${record.port}`) throw new Error("DEV_LAUNCH_RECORD_INVALID");
    return record;
  } catch (error) { if ((error as { code?: string }).code === "ENOENT") return undefined; throw error; }
}
async function writeRecord(value: Scope, record: LaunchRecord): Promise<void> {
  await mkdir(value.root, { recursive: true, mode: 0o700 }); await chmod(value.root, 0o700);
  await writeFile(value.recordPath, `${JSON.stringify(record)}\n`, { mode: 0o600 }); await chmod(value.recordPath, 0o600);
}
async function alive(record: LaunchRecord): Promise<boolean> {
  if (!record.pid) return false;
  try { process.kill(record.pid, 0); } catch { return false; }
  try { return (await fetch(`${record.url}/health`, { signal: AbortSignal.timeout(2_000) })).ok; } catch { return false; }
}
async function ownedProcessAlive(pid: number): Promise<boolean> {
  const child = Bun.spawn(["ps", "-p", String(pid), "-o", "command="], { stdout: "pipe", stderr: "ignore", stdin: "ignore" });
  const [stdout, code] = await Promise.all([new Response(child.stdout).text(), child.exited]);
  return code === 0 && stdout.includes("createDevelopmentContextVmServer");
}
async function stopServer(record: LaunchRecord | undefined): Promise<void> {
  const pid = record?.pid;
  if (!pid || !await ownedProcessAlive(pid)) return;
  process.kill(pid, "SIGTERM");
  for (let attempts = 0; attempts < 60 && await ownedProcessAlive(pid); attempts += 1) await Bun.sleep(250);
  if (await ownedProcessAlive(pid)) process.kill(pid, "SIGKILL");
}
async function freePort(): Promise<number> { const listener = Bun.serve({ hostname: "127.0.0.1", port: 0, fetch: () => new Response("reserved") }); try { return listener.port; } finally { listener.stop(true); } }
function paymentStack(value: Scope) { return developmentStack(value.isolated, value.isolated ? { instance: value.instance } : {}); }

async function ensurePrerequisites(value: Scope): Promise<void> {
  await run(["docker", "info", "--format", "{{.ServerVersion}}"], { timeoutMs: 20_000 });
  const uiRoot = resolve(root, "tests/dev-ui");
  if (!await exists(resolve(uiRoot, "node_modules", "playwright", "package.json"))) await run([process.execPath, "install", "--frozen-lockfile"], { cwd: uiRoot, timeoutMs: 180_000 });
  await run([process.execPath, "./node_modules/playwright/cli.js", "install", "chromium"], { cwd: uiRoot, timeoutMs: 180_000 });
  // The worker image is shared. Compose injects its project name into image
  // labels, so an instance-specific build project would change its identity.
  await run(["docker", "compose", "--env-file", "/dev/null", "-p", "napplet-cvm-ui-worker", "-f", "infra/dev-ui/compose.yaml", "build", "--provenance=false", "--sbom=false", "worker-image"], { timeoutMs: 600_000 });
}

async function runningMode(url: string): Promise<DevelopmentMode> {
  const response = await fetch(`${url}/bootstrap`, { signal: AbortSignal.timeout(5_000) });
  if (!response.ok) throw new Error("DEV_CONTEXTVM_BOOTSTRAP_NOT_READY");
  const bootstrap = await response.json() as { providerLabel?: unknown };
  if (bootstrap.providerLabel === "Deterministic fixture") return "deterministic-fixture";
  if (bootstrap.providerLabel === "Configured OpenAI Responses") return "configured-openai";
  if (bootstrap.providerLabel === "ChatGPT subscription · local test sats" || bootstrap.providerLabel === "ChatGPT plan · test credits") return "chatgpt-oauth";
  throw new Error("DEV_CONTEXTVM_PROVIDER_MODE_INVALID");
}

async function startServer(value: Scope, port: number): Promise<LaunchRecord> {
  await mkdir(value.stateRoot, { recursive: true, mode: 0o700 }); await chmod(value.stateRoot, 0o700);
  const program = String.raw`
    import { appendFile, chmod, mkdir } from 'node:fs/promises';
    import { dirname } from 'node:path';
    import { createDevelopmentContextVmServer } from './src/dev-ui/contextvm-server';
    const tracePath = process.env.NAPPLET_CVM_DEV_LOG_PATH;
    const safeDetail = (value) => typeof value === 'string' && /^[A-Z][A-Z0-9_:-]{2,120}$/.test(value) ? value : undefined;
    const trace = async (code, detail) => {
      try { const safe = safeDetail(detail); await mkdir(dirname(tracePath), { recursive: true, mode: 0o700 }); await appendFile(tracePath, JSON.stringify({ at: new Date().toISOString(), code, ...(safe ? { detail: safe } : {}) }) + '\n', { mode: 0o600 }); await chmod(tracePath, 0o600); } catch {}
    };
    await trace('creator-start');
    let server;
    const expectedUrl = 'http://127.0.0.1:' + process.env.NAPPLET_CVM_DEV_PORT;
    try {
      const config = JSON.parse(await Bun.file(process.env.NAPPLET_CVM_DEV_CONFIG_PATH).text());
      server = await createDevelopmentContextVmServer({ config, stateRoot: process.env.NAPPLET_CVM_DEV_STATE_ROOT, port: Number(process.env.NAPPLET_CVM_DEV_PORT) });
      await trace(server.url === expectedUrl ? 'ready-port-match' : 'ready-port-mismatch');
    } catch {
      await trace('start-error');
      process.exit(1);
    }
    let heartbeatCount = 0;
    const heartbeat = setInterval(() => void (async () => {
      try { await trace((await fetch(server.url + '/health', { signal: AbortSignal.timeout(1_000) })).ok ? 'health-ok' : 'health-not-ok'); }
      catch { await trace('health-unreachable'); }
      heartbeatCount += 1;
      if (heartbeatCount >= 12) clearInterval(heartbeat);
    })(), 2_500);
    const stop = async (code) => { clearInterval(heartbeat); await trace(code); const error = server.generationEvidence().error; if (error) await trace('generation-error', safeDetail(error) ?? 'GENERATION_ERROR_REDACTED'); await server.close(); await trace('close-complete'); process.exit(0); };
    process.once('SIGINT', () => void stop('signal-SIGINT'));
    process.once('SIGTERM', () => void stop('signal-SIGTERM'));
    await new Promise(() => {});
  `;
  const child = Bun.spawn([process.execPath, "-e", program], { cwd: root, env: { ...process.env, NAPPLET_CVM_DEV_CONFIG_PATH: value.configPath, NAPPLET_CVM_DEV_STATE_ROOT: value.stateRoot, NAPPLET_CVM_DEV_PORT: String(port), NAPPLET_CVM_DEV_LOG_PATH: value.logPath }, stdin: "ignore", stdout: "ignore", stderr: "ignore", detached: true });
  child.unref();
  const record: LaunchRecord = { version: 1, instance: value.instance, port, pid: child.pid, url: `http://127.0.0.1:${port}`, stateRoot: value.stateRoot, configPath: value.configPath };
  await writeRecord(value, record);
  for (let attempts = 0; attempts < 120; attempts += 1) {
    if (await alive(record)) return record;
    await Bun.sleep(250);
  }
  if (record.pid && await ownedProcessAlive(record.pid)) process.kill(record.pid, "SIGTERM");
  throw new Error("DEV_CONTEXTVM_START_FAILED:server did not expose /health within 30 seconds");
}

async function up(): Promise<LaunchRecord> {
  const value = scope(); const existing = await readRecord(value);
  if (existing && await alive(existing)) {
    const config = JSON.parse(await readFile(value.configPath, "utf8")) as DevPayments;
    const ready = await assertLauncherReadiness({ config, configPath: value.configPath, url: existing.url, stateRoot: value.stateRoot });
    if (existing.workerImageDigest === ready.workerImageDigest) {
      const complete = { ...existing, mode: await runningMode(existing.url) } as LaunchRecord;
      await writeRecord(value, complete);
      return complete;
    }
  }
  await stopServer(existing);
  await ensurePrerequisites(value);
  const config = await paymentStack(value).up();
  const record = await startServer(value, existing?.port ?? await freePort());
  const ready = await assertLauncherReadiness({ config, configPath: value.configPath, url: record.url, stateRoot: value.stateRoot });
  const complete = { ...record, workerImageDigest: ready.workerImageDigest, mode: await runningMode(record.url) } as LaunchRecord;
  await writeRecord(value, complete);
  return complete;
}

async function status(): Promise<LaunchRecord & { ready: boolean; mode?: DevelopmentMode }> {
  const value = scope(); const record = await readRecord(value);
  if (!record || !await alive(record)) return { version: 1, instance: value.instance, port: record?.port ?? 0, url: record?.url ?? "", stateRoot: value.stateRoot, configPath: value.configPath, ready: false };
  const config = JSON.parse(await readFile(value.configPath, "utf8")) as DevPayments;
  const ready = await assertLauncherReadiness({ config, configPath: value.configPath, url: record.url, stateRoot: value.stateRoot });
  if (record.workerImageDigest !== ready.workerImageDigest) throw new Error("DEV_WORKER_IMAGE_CHANGED:run bun scripts/dev.ts up to restart the service with the current image");
  return { ...record, ready: true, mode: await runningMode(record.url) };
}

async function down(): Promise<void> {
  const value = scope(); const record = await readRecord(value);
  await stopServer(record);
  await paymentStack(value).down(false);
  if (record) await writeRecord(value, { ...record, pid: undefined });
}

async function reset(): Promise<void> {
  const value = scope(); await down(); await paymentStack(value).down(true);
  await rm(value.recordPath, { force: true });
  for (const path of [resolve(value.stateRoot, "development-artifacts"), resolve(value.stateRoot, "development-checkpoints"), resolve(value.stateRoot, "development-worker-results"), resolve(value.stateRoot, "development-chatgpt")]) await rm(path, { recursive: true, force: true });
}

async function test(): Promise<void> {
  const splitIndex = process.argv.indexOf("--case");
  const inline = process.argv.find((argument) => argument.startsWith("--case="))?.slice("--case=".length);
  const testCase = inline ?? (splitIndex >= 0 ? process.argv[splitIndex + 1] : "full");
  if (testCase === "chatgpt-live") {
    if (!process.argv.includes("--allow-chatgpt-usage")) throw new Error("CHATGPT_LIVE_USAGE_OPT_IN_REQUIRED:pass --allow-chatgpt-usage after signing in through the GUI");
    const record = await up();
    const output = await run([process.execPath, "run", "tests/dev-ui/chatgpt-live.e2e.ts", "--allow-chatgpt-usage"], { env: { NAPPLET_CVM_DEV_URL: record.url }, timeoutMs: 420_000 });
    const proof = output.split("\n").some((line) => { try { const value = JSON.parse(line); return value.status === "passed" && value.case === "chatgpt-live"; } catch { return false; } });
    if (!proof) throw new Error("CHATGPT_LIVE_COMPLETION_MISSING");
    console.log(JSON.stringify({ status: "passed", case: "chatgpt-live" })); return;
  }
  const cases: Record<string, Array<readonly [string, ...string[]]>> = {
    "progress": [["test", "tests/dev-ui/development-progress.test.ts"], ["tests/dev-ui/progress-view.e2e.ts"], ["tests/dev-ui/chatgpt-oauth.e2e.ts"]],
    "chatgpt-oauth": [["tests/dev-ui/chatgpt-oauth.e2e.ts"]],
    "contextvm-funding": [["tests/dev-ui/contextvm-funding.e2e.ts", "--case=both-rails-restart-replay"]],
    "generation-preview": [["tests/dev-ui/generation-preview.e2e.ts", "--case=deterministic-real-worker-compatible-host"]],
    "continuation-revision": [["tests/dev-ui/continuation-revision.e2e.ts", "--case=pre-admission-fund-restart-explicit-resume"], ["tests/dev-ui/continuation-revision.e2e.ts", "--case=revisions-duplicates-restarts"]],
    full: [
      ["test", "tests/dev-ui/development-progress.test.ts"],
      ["tests/dev-ui/progress-view.e2e.ts"],
      ["test", "tests/dev/chatgpt-oauth.test.ts", "tests/dev/chatgpt-model-gateway.test.ts"],
      ["tests/dev-ui/chatgpt-oauth.e2e.ts"],
      ["tests/dev-ui/contextvm-funding.e2e.ts", "--case=both-rails-restart-replay"],
      ["tests/dev-ui/generation-preview.e2e.ts", "--case=deterministic-real-worker-compatible-host"],
      ["tests/dev-ui/generation-preview.e2e.ts", "--case=boundaries-platform-provider-recovery", "--allow-skip-without-provider-credentials"],
      ["tests/dev-ui/continuation-revision.e2e.ts", "--case=pre-admission-fund-restart-explicit-resume"],
      ["tests/dev-ui/continuation-revision.e2e.ts", "--case=revisions-duplicates-restarts"],
      ["tests/dev-ui/security-accessibility.e2e.ts", "--case=security-accessibility"],
      ["test", "tests/dev-ui/preview-server.boundaries.test.ts", "--timeout", "120000"],
      ["tests/dev-ui/full-flow.e2e.ts"],
    ],
  };
  if (!testCase || !cases[testCase]) throw new Error("DEV_TEST_CASE_INVALID:contextvm-funding|generation-preview|continuation-revision|progress|chatgpt-oauth|chatgpt-live|full");
  const providerKeys = ["OPENAI_API_KEY", "NAPPLET_CVM_OPENAI_MODEL", "NAPPLET_CVM_OPENAI_PROFILE", "NAPPLET_CVM_OPENAI_PRICE_CARD", "NAPPLET_CVM_OPENAI_PRICE_SOURCES"] as const;
  const saved = Object.fromEntries(providerKeys.map((key) => [key, process.env[key]]));
  for (const key of providerKeys) delete process.env[key];
  try {
    await up();
    for (const command of cases[testCase]!) {
      const [verb, ...args] = command;
      const output = await run([process.execPath, verb === "test" ? "test" : "run", ...(verb === "test" ? args : command)], { env: { NAPPLET_CVM_DEV_INSTANCE: scope().instance, ...Object.fromEntries(providerKeys.map((key) => [key, undefined])) }, timeoutMs: 600_000 });
      const proof = output.split("\n").flatMap((line) => { try { const value = JSON.parse(line); return value.status === "passed" ? [value] : []; } catch { return []; } }).at(-1);
      if (verb !== "test" && !proof) throw new Error(`DEV_TEST_COMPLETION_MISSING:${command[0]}`);
      console.log(JSON.stringify({ case: command.filter((part) => part.endsWith(".ts") || part.startsWith("--case=")).join(" "), status: "passed", ...(proof?.configuredProvider === "skipped_without_credentials" ? { configuredProvider: "skipped_without_credentials" } : {}) }));
    }
  } finally {
    for (const key of providerKeys) { const value = saved[key]; if (value === undefined) delete process.env[key]; else process.env[key] = value; }
  }
}

if (import.meta.main) {
  const command = process.argv[2];
  try {
    if (command === "up") console.log(JSON.stringify({ ...(await up()), ready: true }));
    else if (command === "status") console.log(JSON.stringify(await status()));
    else if (command === "down") { await down(); console.log(JSON.stringify({ ready: false, instance: scope().instance })); }
    else if (command === "reset") { if (!process.argv.includes("--confirm")) throw new Error("DEV_RESET_CONFIRM_REQUIRED"); await reset(); console.log(JSON.stringify({ reset: true, instance: scope().instance })); }
    else if (command === "test") {
      await test();
      const inline = process.argv.find((argument) => argument.startsWith("--case="))?.slice("--case=".length);
      const index = process.argv.indexOf("--case");
      console.log(JSON.stringify({ passed: true, case: inline ?? (index >= 0 ? process.argv[index + 1] : "full") }));
    }
    else throw new Error("Usage: bun scripts/dev.ts up|status|test|down|reset --confirm");
  } catch (error) { console.error(error instanceof Error ? error.message : "DEV_LAUNCHER_FAILED"); process.exitCode = 1; }
}
