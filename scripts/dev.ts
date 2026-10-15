import { chmod, mkdir, readFile, rm, stat, writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import { developmentStack, type DevPayments } from "./dev-payments";
import { assertLauncherReadiness, type DevelopmentMode } from "../src/dev/readiness";

const root = resolve(import.meta.dir, "..");
const instancePattern = /^[a-z0-9][a-z0-9-]{0,47}$/u;
type Scope = Readonly<{ instance: string; isolated: boolean; root: string; stateRoot: string; configPath: string; recordPath: string; logPath: string }>;
type LaunchRecord = Readonly<{ version: 1; instance: string; port: number; pid?: number; url: string; stateRoot: string; configPath: string; mode?: DevelopmentMode }>;

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
async function freePort(): Promise<number> { const listener = Bun.serve({ hostname: "127.0.0.1", port: 0, fetch: () => new Response("reserved") }); try { return listener.port; } finally { listener.stop(true); } }
function paymentStack(value: Scope) { return developmentStack(value.isolated, value.isolated ? { instance: value.instance } : {}); }

async function ensurePrerequisites(value: Scope): Promise<void> {
  await run(["docker", "info", "--format", "{{.ServerVersion}}"], { timeoutMs: 20_000 });
  const uiRoot = resolve(root, "tests/dev-ui");
  if (!await exists(resolve(uiRoot, "node_modules", "playwright", "package.json"))) await run([process.execPath, "install", "--frozen-lockfile"], { cwd: uiRoot, timeoutMs: 180_000 });
  await run([process.execPath, "./node_modules/playwright/cli.js", "install", "chromium"], { cwd: uiRoot, timeoutMs: 180_000 });
  await run(["docker", "compose", "--env-file", "/dev/null", "-p", `napplet-cvm-ui-${value.instance}`, "-f", "infra/dev-ui/compose.yaml", "build", "worker-image"], { timeoutMs: 600_000 });
}

async function runningMode(url: string): Promise<DevelopmentMode> {
  const response = await fetch(`${url}/bootstrap`, { signal: AbortSignal.timeout(5_000) });
  if (!response.ok) throw new Error("DEV_CONTEXTVM_BOOTSTRAP_NOT_READY");
  const bootstrap = await response.json() as { providerLabel?: unknown };
  if (bootstrap.providerLabel === "Deterministic fixture") return "deterministic-fixture";
  if (bootstrap.providerLabel === "Configured OpenAI Responses") return "configured-openai";
  throw new Error("DEV_CONTEXTVM_PROVIDER_MODE_INVALID");
}

async function startServer(value: Scope, port: number): Promise<LaunchRecord> {
  await mkdir(value.stateRoot, { recursive: true, mode: 0o700 }); await chmod(value.stateRoot, 0o700);
  const program = "import { createDevelopmentContextVmServer } from './src/dev-ui/contextvm-server'; const config = JSON.parse(await Bun.file(process.env.NAPPLET_CVM_DEV_CONFIG_PATH).text()); const server = await createDevelopmentContextVmServer({ config, stateRoot: process.env.NAPPLET_CVM_DEV_STATE_ROOT, port: Number(process.env.NAPPLET_CVM_DEV_PORT) }); console.log(JSON.stringify({ url: server.url })); const stop = async () => { await server.close(); process.exit(0); }; process.once('SIGINT', () => void stop()); process.once('SIGTERM', () => void stop()); await new Promise(() => {});";
  const child = Bun.spawn([process.execPath, "-e", program], { cwd: root, env: { ...process.env, NAPPLET_CVM_DEV_CONFIG_PATH: value.configPath, NAPPLET_CVM_DEV_STATE_ROOT: value.stateRoot, NAPPLET_CVM_DEV_PORT: String(port) }, stdin: "ignore", stdout: "ignore", stderr: "ignore", detached: true });
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
    await assertLauncherReadiness({ config, configPath: value.configPath, url: existing.url, stateRoot: value.stateRoot });
    const complete = { ...existing, mode: await runningMode(existing.url) } as LaunchRecord;
    await writeRecord(value, complete);
    return complete;
  }
  await ensurePrerequisites(value);
  const config = await paymentStack(value).up();
  const record = await startServer(value, existing?.port ?? await freePort());
  const ready = await assertLauncherReadiness({ config, configPath: value.configPath, url: record.url, stateRoot: value.stateRoot });
  const complete = { ...record, mode: await runningMode(record.url) } as LaunchRecord;
  await writeRecord(value, complete);
  return complete;
}

async function status(): Promise<LaunchRecord & { ready: boolean; mode?: DevelopmentMode }> {
  const value = scope(); const record = await readRecord(value);
  if (!record || !await alive(record)) return { version: 1, instance: value.instance, port: record?.port ?? 0, url: record?.url ?? "", stateRoot: value.stateRoot, configPath: value.configPath, ready: false };
  const config = JSON.parse(await readFile(value.configPath, "utf8")) as DevPayments;
  await assertLauncherReadiness({ config, configPath: value.configPath, url: record.url, stateRoot: value.stateRoot });
  return { ...record, ready: true, mode: await runningMode(record.url) };
}

async function down(): Promise<void> {
  const value = scope(); const record = await readRecord(value);
  if (record?.pid && await ownedProcessAlive(record.pid)) { process.kill(record.pid, "SIGTERM"); for (let attempts = 0; attempts < 20 && await ownedProcessAlive(record.pid); attempts += 1) await Bun.sleep(250); }
  await paymentStack(value).down(false);
  if (record) await writeRecord(value, { ...record, pid: undefined });
}

async function reset(): Promise<void> {
  const value = scope(); await down(); await paymentStack(value).down(true);
  await rm(value.recordPath, { force: true });
  for (const path of [resolve(value.stateRoot, "development-artifacts"), resolve(value.stateRoot, "development-checkpoints"), resolve(value.stateRoot, "development-worker-results")]) await rm(path, { recursive: true, force: true });
}

async function test(): Promise<void> {
  const splitIndex = process.argv.indexOf("--case");
  const inline = process.argv.find((argument) => argument.startsWith("--case="))?.slice("--case=".length);
  const testCase = inline ?? (splitIndex >= 0 ? process.argv[splitIndex + 1] : "full");
  const cases: Record<string, Array<readonly [string, ...string[]]>> = {
    "contextvm-funding": [["tests/dev-ui/contextvm-funding.e2e.ts", "--case=both-rails-restart-replay"]],
    "generation-preview": [["tests/dev-ui/generation-preview.e2e.ts", "--case=deterministic-real-worker-compatible-host"]],
    "continuation-revision": [["tests/dev-ui/continuation-revision.e2e.ts", "--case=pre-admission-fund-restart-explicit-resume"], ["tests/dev-ui/continuation-revision.e2e.ts", "--case=revisions-duplicates-restarts"]],
    full: [
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
  if (!testCase || !cases[testCase]) throw new Error("DEV_TEST_CASE_INVALID:contextvm-funding|generation-preview|continuation-revision|full");
  const providerKeys = ["OPENAI_API_KEY", "NAPPLET_CVM_OPENAI_MODEL", "NAPPLET_CVM_OPENAI_PROFILE", "NAPPLET_CVM_OPENAI_PRICE_CARD", "NAPPLET_CVM_OPENAI_PRICE_SOURCES"] as const;
  const saved = Object.fromEntries(providerKeys.map((key) => [key, process.env[key]]));
  for (const key of providerKeys) delete process.env[key];
  try {
    await up();
    for (const command of cases[testCase]!) {
      const [verb, ...args] = command;
      await run([process.execPath, verb === "test" ? "test" : "run", ...(verb === "test" ? args : command)], { env: { NAPPLET_CVM_DEV_INSTANCE: scope().instance, ...Object.fromEntries(providerKeys.map((key) => [key, undefined])) }, timeoutMs: 600_000 });
      console.log(JSON.stringify({ case: command.filter((part) => part.endsWith(".ts") || part.startsWith("--case=")).join(" "), status: "passed" }));
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
