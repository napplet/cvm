import { chmod, mkdir, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import { randomBytes } from "node:crypto";
import { createRequire } from "node:module";
import type { PostgresSqlClient, PostgresSqlPool } from "../src/persistence/postgres-sql-funding-store";
import { Wallet, getEncodedToken } from "@cashu/cashu-ts";
import { nwcRequest as serviceNwcRequest } from "../src/service/nwc";
import { SERVICE_MIGRATIONS, applyCanonicalMigrations, canonicalMigrations } from "../src/service/migrations";

const root = resolve(import.meta.dir, "..");
const composeFile = resolve(root, "infra/dev-payments/compose.yaml");
export type DevPayments = { version: 1; developmentOnly: true; mintUrl: string; secondaryMintUrl: string; relayUrl: string; hubUrl: string; nwcUri: string; cashuToken: string; databaseUrl: string; fundingKey: string };

type DevelopmentPool = PostgresSqlPool & Pick<PostgresSqlClient, "query"> & { end(): Promise<void> };
export const DEVELOPMENT_MIGRATIONS = SERVICE_MIGRATIONS;
// pg has no bundled declarations; expose only the application's existing SQL
// port plus pool lifecycle, without changing the approved package manifest.
const { Pool } = createRequire(import.meta.url)("pg") as { Pool: new (options: Record<string, unknown>) => DevelopmentPool };
export function createDevelopmentPool(databaseUrl: string): DevelopmentPool {
  const url = new URL(databaseUrl);
  if (url.protocol !== "postgresql:" || url.hostname !== "127.0.0.1" || !url.port || url.search || url.hash || url.pathname !== "/napplet_dev" || url.username !== "napplet_dev") throw new Error("DEV_DATABASE_INVALID");
  return new Pool({ connectionString: databaseUrl, ssl: false, connectionTimeoutMillis: 2000, query_timeout: 5000, max: 10 });
}

/** Real encrypted NIP-47 request over the local relay only. */
export async function nwcRequest(uri: string, method: string, params: Record<string, unknown> = {}, callerSignal?: AbortSignal): Promise<any> {
  return serviceNwcRequest(uri, method, params, callerSignal, "loopback");
}

async function privateJson(path: string, value: unknown) {
  await writeFile(path, JSON.stringify(value, null, 2) + "\n", { mode: 0o600 });
  await chmod(path, 0o600);
}

async function localSecret(path: string): Promise<string> {
  try {
    const value = JSON.parse(await readFile(path, "utf8"));
    if (typeof value !== "string" || !/^[0-9a-f]{64}$/.test(value)) throw new Error("DEV_SECRET_INVALID");
    return value;
  } catch (error: any) {
    if (error.code !== "ENOENT") throw error;
    const value = randomBytes(32).toString("hex");
    await privateJson(path, value);
    return value;
  }
}

export async function expectedDevelopmentMigrations(): Promise<Array<Readonly<{ name: string; sha256: string; sql: string }>>> {
  return [...await canonicalMigrations()];
}

/** Development database: the canonical service migration sequence. */
async function migrate(databaseUrl: string) {
  const pool = createDevelopmentPool(databaseUrl);
  try {
    await waitUntil(async () => !!await pool.query("SELECT 1"), "postgres");
    await applyCanonicalMigrations(pool);
  } finally { await pool.end(); }
}

export async function waitUntil(check: () => Promise<boolean>, label: string, timeoutMs = 90_000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try { if (await check()) return; } catch { /* services are still starting */ }
    await Bun.sleep(500);
  }
  throw new Error(`DEV_PAYMENTS_TIMEOUT:${label}`);
}

export function developmentStack(test = false, options: Readonly<{ instance?: string }> = {}) {
  const instance = options.instance;
  if (instance !== undefined && !/^[a-z0-9][a-z0-9-]{0,47}$/u.test(instance)) throw new Error("DEV_INSTANCE_INVALID");
  if (instance !== undefined && !test) throw new Error("DEV_INSTANCE_REQUIRES_TEST_SCOPE");
  const project = instance ? `napplet-cvm-payments-${instance}` : test ? `napplet-cvm-payments-test-${randomBytes(6).toString("hex")}` : "napplet-cvm-dev-payments";
  const directory = instance ? resolve(root, ".local", "napplet-cvm-dev", instance, "payments") : resolve(root, ".local", project);
  // Deliberately ignore ambient endpoint/credential variables and .env files.
  const env = { ...process.env, DEV_MINT_PORT: test ? "0" : "3338", DEV_SECONDARY_MINT_PORT: test ? "0" : "3339", DEV_POSTGRES_PORT: test ? "0" : "55432", DEV_RELAY_PORT: test ? "0" : "7777", DEV_HUB_PORT: test ? "0" : "8081", COMPOSE_PROFILES: "" };
  async function compose(...args: string[]) {
    const proc = Bun.spawn(["docker", "compose", "--env-file", "/dev/null", "-p", project, "-f", composeFile, ...args], { cwd: root, env, stdout: "pipe", stderr: "pipe" });
    const [stdout, stderr, code] = await Promise.all([new Response(proc.stdout).text(), new Response(proc.stderr).text(), proc.exited]);
    if (code !== 0) throw new Error(`Docker Compose failed (${args[0]}): ${stderr}`);
    return stdout.trim();
  }
  async function endpoint(service: string, port: number, protocol: string) {
    const address = await compose("port", service, String(port));
    if (!/^127\.0\.0\.1:\d+$/.test(address)) throw new Error("DEV_PORT_BINDING_INVALID");
    return `${protocol}://${address}`;
  }
  return {
    directory,
    async externalTestInvoice() {
      // Generate a signed BOLT11 outside the mint's quote database to exercise
      // FakeWallet's outgoing payment path rather than an internal mint transfer.
      const result = await compose("exec", "-T", "mint", "poetry", "run", "python", "-c", "import asyncio; from cashu.lightning.fake import FakeWallet; from cashu.core.base import Amount, Unit; print(asyncio.run(FakeWallet().create_invoice(Amount(Unit.sat, 21))).payment_request)");
      const invoice = result.split("\n").find((line) => line.startsWith("lnbc"));
      if (!invoice) throw new Error("DEV_INVOICE_GENERATION_FAILED");
      return invoice;
    },
    async down(reset = false) {
      await compose("down", ...(reset ? ["--volumes"] : []), "--remove-orphans");
      if (reset) await rm(directory, { recursive: true, force: true });
    },
    async up(): Promise<DevPayments> {
      await mkdir(directory, { recursive: true, mode: 0o700 });
      await chmod(directory, 0o700);
      console.error("Starting local mints, relay, NWC wallet, and funding database…");
      await compose("up", "-d");
      const mintUrl = await endpoint("mint", 3338, "http");
      const secondaryMintUrl = await endpoint("mint-secondary", 3338, "http");
      const databaseEndpoint = new URL(await endpoint("postgres", 5432, "postgresql"));
      databaseEndpoint.username = "napplet_dev";
      databaseEndpoint.password = "development-only-no-real-funds";
      databaseEndpoint.pathname = "/napplet_dev";
      const databaseUrl = databaseEndpoint.toString();
      await migrate(databaseUrl);
      const fundingKey = await localSecret(resolve(directory, "funding-key.json"));
      const hubUrl = await endpoint("hub", 8080, "http");
      const relayUrl = await endpoint("relay", 8080, "ws");
      async function api(path: string, body?: unknown, token?: string) {
        const response = await fetch(hubUrl + path, { method: body ? "POST" : "GET", headers: { "content-type": "application/json", ...(token ? { authorization: `Bearer ${token}` } : {}) }, ...(body ? { body: JSON.stringify(body) } : {}), signal: AbortSignal.timeout(5000) });
        if (!response.ok) throw new Error(`DEV_HUB_HTTP:${response.status}:${path}`);
        return response.status === 204 ? null : response.json();
      }
      await waitUntil(async () => (await fetch(mintUrl + "/v1/info", { signal: AbortSignal.timeout(2000) })).ok, "mint");
      await waitUntil(async () => (await fetch(secondaryMintUrl + "/v1/info", { signal: AbortSignal.timeout(2000) })).ok, "secondary mint");
      await waitUntil(async () => !!await api("/api/info"), "hub");
      const password = await localSecret(resolve(directory, "password.json"));
      let info = await api("/api/info");
      if (!info.setupCompleted) await api("/api/setup", { backendType: "CASHU", unlockPassword: password, cashuMintUrl: "http://mint:3338" });
      const auth = await api(info.running ? "/api/unlock" : "/api/start", { unlockPassword: password, permission: "full" });
      await waitUntil(async () => {
        info = await api("/api/info");
        return info.running && info.relays?.some((relay: any) => relay.online);
      }, "wallet and relay");
      const connectionFile = resolve(directory, "connection.json");
      let nwcUri: string;
      try { nwcUri = JSON.parse(await readFile(connectionFile, "utf8")).nwcUri; }
      catch (error: any) {
        if (error.code !== "ENOENT") throw error;
        const app = await api("/api/apps", { name: "napplet-cvm development", scopes: ["get_info", "get_balance", "make_invoice", "lookup_invoice", "pay_invoice"], maxAmountSat: 0, budgetRenewal: "never", isolated: false }, auth.token);
        nwcUri = app.pairingUri;
      }
      const uri = new URL(nwcUri);
      uri.searchParams.delete("relay");
      uri.searchParams.append("relay", relayUrl);
      nwcUri = uri.toString();
      await privateJson(connectionFile, { nwcUri });
      // FakeWallet automatically settles mint quotes; Hub polls and mints the balance.
      if ((await nwcRequest(nwcUri, "get_balance")).balance < 1_000_000) {
        const invoice = await nwcRequest(nwcUri, "make_invoice", { amount: 10_000_000, description: "Development test funds" });
        await waitUntil(async () => {
          await nwcRequest(nwcUri, "lookup_invoice", { payment_hash: invoice.payment_hash });
          return (await nwcRequest(nwcUri, "get_balance")).balance >= 1_000_000;
        }, "test funds");
      }
      const wallet = new Wallet(mintUrl);
      await wallet.loadMint();
      const quote = await wallet.createMintQuoteBolt11(1024);
      const proofs = await wallet.mintProofsBolt11(1024, quote);
      const config: DevPayments = { version: 1, developmentOnly: true, mintUrl, secondaryMintUrl, hubUrl, relayUrl, nwcUri, databaseUrl, fundingKey, cashuToken: getEncodedToken({ mint: mintUrl, unit: "sat", proofs }) };
      await privateJson(resolve(directory, "payments.json"), config);
      return config;
    },
  };
}

async function command(argv: string[], input: Readonly<{ cwd?: string; timeoutMs?: number }> = {}): Promise<void> {
  const child = Bun.spawn(argv, { cwd: input.cwd ?? root, stdin: "ignore", stdout: "inherit", stderr: "inherit" });
  const timeout = setTimeout(() => child.kill(), input.timeoutMs ?? 600_000);
  const code = await child.exited;
  clearTimeout(timeout);
  if (code !== 0) throw new Error(`DEV_TEST_PREREQUISITE_FAILED:${argv[0]}`);
}

async function testFiles(directory: string): Promise<string[]> {
  const files: string[] = [];
  for (const entry of await readdir(directory, { withFileTypes: true })) {
    const path = resolve(directory, entry.name);
    if (entry.isDirectory()) files.push(...await testFiles(path));
    else if (entry.isFile() && entry.name.endsWith(".test.ts")) files.push(path);
  }
  return files;
}

async function ensureTestPrerequisites(): Promise<void> {
  await command(["docker", "info", "--format", "{{.ServerVersion}}"], { timeoutMs: 20_000 });
  const uiRoot = resolve(root, "tests", "dev-ui");
  if (!await Bun.file(resolve(uiRoot, "node_modules", "playwright", "package.json")).exists()) await command([process.execPath, "install", "--frozen-lockfile"], { cwd: uiRoot, timeoutMs: 180_000 });
  await command([process.execPath, "./node_modules/playwright/cli.js", "install", "chromium"], { cwd: uiRoot, timeoutMs: 180_000 });
  await command(["docker", "compose", "--env-file", "/dev/null", "-p", "napplet-cvm-ui-worker", "-f", "infra/dev-ui/compose.yaml", "build", "--provenance=false", "--sbom=false", "worker-image"], { timeoutMs: 600_000 });
  await command(["docker", "compose", "--env-file", "/dev/null", "-p", "napplet-cvm-publication", "-f", "infra/dev-publication/compose.yaml", "build", "--provenance=false", "--sbom=false", "publication-image"], { timeoutMs: 600_000 });
}

export async function withRunOwnedStack<T>(stack: Readonly<{ down(reset?: boolean): Promise<void> }>, work: () => Promise<T>): Promise<T> {
  try { return await work(); }
  finally { await stack.down(true); }
}

async function runIsolatedTests(): Promise<void> {
  const instance = `test-${randomBytes(8).toString("hex")}`;
  const stack = developmentStack(true, { instance });
  let cleaned = false;
  const cleanup = async () => {
    if (cleaned) return;
    cleaned = true;
    await stack.down(true);
  };
  const interrupt = () => { void cleanup().finally(() => process.exit(130)); };
  process.once("SIGINT", interrupt); process.once("SIGTERM", interrupt);
  try { await withRunOwnedStack({ down: cleanup }, async () => {
    await ensureTestPrerequisites();
    await stack.up();
    const selected = (await Promise.all([testFiles(resolve(root, "tests", "dev")), testFiles(resolve(root, "tests", "dev-ui"))])).flat().sort();
    if (!selected.length) throw new Error("DEV_TEST_SELECTION_EMPTY");
    const child = Bun.spawn([process.execPath, "test", ...selected], {
      cwd: root,
      env: { ...process.env, NAPPLET_CVM_DEV_PAYMENTS_E2E: "1", NAPPLET_CVM_DEV_TEST_RUN_ID: instance, NAPPLET_CVM_DEV_TEST_PAYMENTS_FILE: resolve(stack.directory, "payments.json") },
      stdout: "inherit", stderr: "inherit", stdin: "ignore",
    });
    if (await child.exited !== 0) throw new Error("DEV_PAYMENT_TESTS_FAILED");
  });
  } finally {
    process.off("SIGINT", interrupt); process.off("SIGTERM", interrupt);
  }
}

if (import.meta.main) {
  const command = process.argv[2] ?? "up";
  const stack = developmentStack();
  try {
    if (command === "up") {
      await stack.up();
      console.log(`Ready. Development connections and fresh Cashu test token: ${stack.directory}/payments.json`);
    } else if (command === "down" || command === "reset") {
      await stack.down(command === "reset");
      console.log(command === "reset" ? "Development payment data removed." : "Development payments stopped; data retained.");
    } else if (command === "test") await runIsolatedTests();
    else throw new Error("Usage: bun scripts/dev-payments.ts up|down|reset|test");
  } catch (error) { console.error(error instanceof Error ? error.message : "Development setup failed"); process.exitCode = 1; }
}
