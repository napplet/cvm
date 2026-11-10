import { expect, test } from "bun:test";
import { chromium } from "playwright";
import { Pool } from "pg";
import { mkdtemp, mkdir, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { getPublicKey } from "nostr-tools/pure";
import { accountIdForPrincipal } from "../../src/domain/account-command";
import { createServiceRuntime, type ServiceRuntime } from "../../src/service/server";
import { parseServiceConfig, ServiceSecrets, deriveServiceIdentity } from "../../src/service/config";
import { applyCanonicalMigrations, initializeServiceRealm } from "../../src/service/migrations";
import { serviceTestRelay } from "../fixtures/service-test-relay";

const integration = process.env.NAPPLET_RUN_SERVICE_E2E === "1" ? test : test.skip;

async function command(args: string[]) {
  const child = Bun.spawn(args, { stdout: "pipe", stderr: "pipe" });
  const [out, error, code] = await Promise.all([new Response(child.stdout).text(), new Response(child.stderr).text(), child.exited]);
  if (code !== 0) throw new Error(`${args[0]} failed: ${error.slice(-500)}`);
  return out.trim();
}
function freePort() { const server = Bun.serve({ hostname: "127.0.0.1", port: 0, fetch: () => new Response() }); const port = server.port!; server.stop(true); return port; }

integration("public service: allowlisted browser generates, meters, previews and reopens after runtime restart without a payment implementation", async () => {
  const directory = await mkdtemp(join(tmpdir(), "cvm-free-browser-"));
  const container = `cvm-free-browser-${crypto.randomUUID().slice(0, 8)}`;
  const relay = serviceTestRelay();
  const seed = "17".repeat(32), userKey = "21".repeat(32);
  const pubkey = getPublicKey(Buffer.from(userKey, "hex"));
  let runtime: ServiceRuntime | undefined, pool: Pool | undefined;
  let browser: Awaited<ReturnType<typeof chromium.launch>> | undefined;
  let upstream = "";
  const key = join(directory, "tls.key"), cert = join(directory, "tls.crt");
  await command(["openssl", "req", "-x509", "-newkey", "rsa:2048", "-nodes", "-days", "1", "-subj", "/CN=localhost", "-addext", "subjectAltName=DNS:localhost,IP:127.0.0.1,IP:127.0.0.2", "-keyout", key, "-out", cert]);
  // Test-only TLS terminator. The service sees the original origin's Host.
  const tlsProxy = () => Bun.serve<{ upstream?: WebSocket; pending: string[] }>({ hostname: "127.0.0.1", port: 0, idleTimeout: 60, tls: { cert: Bun.file(cert), key: Bun.file(key) },
    async fetch(request, server) {
      if (request.headers.get("upgrade") === "websocket") return server.upgrade(request, { data: { pending: [] } }) ? undefined : new Response(null, { status: 400 });
      return fetch(new URL(new URL(request.url).pathname + new URL(request.url).search, upstream), { headers: request.headers, method: request.method });
    },
    websocket: {
      open(peer) { const socket = new WebSocket(`ws://127.0.0.1:${relay.port}`); peer.data.upstream = socket; socket.onopen = () => { for (const item of peer.data.pending) socket.send(item); peer.data.pending.length = 0; }; socket.onmessage = event => peer.send(String(event.data)); socket.onclose = () => peer.close(); },
      message(peer, bytes) { const value = String(bytes); if (peer.data.upstream?.readyState === WebSocket.OPEN) peer.data.upstream.send(value); else peer.data.pending.push(value); },
      close(peer) { peer.data.upstream?.close(); },
    },
  });
  const proxy = tlsProxy(), previewProxy = tlsProxy(), blobsProxy = tlsProxy();
  const origin = `https://127.0.0.1:${proxy.port}`;
  try {
    await command(["docker", "run", "--rm", "--detach", "--name", container, "--publish", "127.0.0.1::5432", "-e", "POSTGRES_HOST_AUTH_METHOD=trust", "postgres:17.11-alpine3.24"]);
    const port = (await command(["docker", "port", container, "5432/tcp"])).match(/127\.0\.0\.1:(\d+)/u)![1];
    const databaseUrl = `postgresql://postgres@127.0.0.1:${port}/postgres`;
    pool = new Pool({ connectionString: databaseUrl, connectionTimeoutMillis: 2000 });
    for (let attempt = 0; ; attempt++) { try { await pool.query("SELECT 1"); break; } catch (error) { if (attempt > 100) throw error; await Bun.sleep(200); } }
    await applyCanonicalMigrations(pool as any); await initializeServiceRealm(pool as any, "test");
    const secretsDirectory = join(directory, "secrets"); await mkdir(secretsDirectory);
    await writeFile(join(secretsDirectory, "database_url"), databaseUrl, { mode: 0o600 });
    await writeFile(join(secretsDirectory, "service_seed"), seed, { mode: 0o600 });
    const config = parseServiceConfig({ version: 1, realm: "test", listen: { port: freePort() },
      origins: { public: origin, preview: `https://127.0.0.1:${previewProxy.port}`, blobs: `https://127.0.0.1:${blobsProxy.port}`, relay: `wss://127.0.0.1:${proxy.port}/relay` },
      relay: { url: `ws://127.0.0.1:${relay.port}` }, database: { adapter: "postgresql" }, storage: { adapter: "filesystem", root: join(directory, "storage") },
      funding: { mode: "free", allowlist: [pubkey], maximumCredits: "10000", reserveSat: "100" }, model: { adapter: "deterministic-test" },
      worker: { adapter: "docker", runtime: "runc", image: "napplet-cvm/dev-worker:development" }, policy: { version: "service-browser-test-v1" } });
    const start = async () => { runtime = await createServiceRuntime({ config, secrets: new ServiceSecrets(secretsDirectory), hostname: "127.0.0.1" }); upstream = runtime.url; };
    await start();
    browser = await chromium.launch({ headless: true });
    const context = await browser.newContext({ ignoreHTTPSErrors: true }); // Only this disposable certificate and context.
    const servicePubkey = getPublicKey(Buffer.from(deriveServiceIdentity(seed).signerPrivateKey, "hex"));
    await context.addInitScript(({ servicePubkey, userKey, origin }) => { if (location.origin === origin) sessionStorage.setItem(`napplet-cvm/dev-contextvm-key/v1/${servicePubkey}`, userKey); }, { servicePubkey, userKey, origin });
    const page = await context.newPage(); page.setDefaultTimeout(45_000);
    page.on("pageerror", error => console.error(error.message));
    page.on("console", message => { if (message.type() === "error") console.error(message.text().slice(0, 500)); });
    page.on("requestfailed", request => console.error("TEST_HTTP_FAILED", new URL(request.url()).origin, request.failure()?.errorText));
    page.on("websocket", socket => { socket.on("socketerror", error => console.error("service browser: websocket error", error)); });
    await page.goto(origin);
    await page.waitForFunction(() => /Connected:|Connection failed/.test(document.querySelector("#connection-status")?.textContent ?? ""), undefined, { timeout: 30_000 }).catch(async error => { console.error("service browser connection:", await page.locator("#connection-status").textContent()); throw error; });
    expect(await page.locator("#connection-status").textContent()).toContain(`Connected: ${pubkey}`);
    await page.locator("#idea").fill("A single tap counter with an Add button and a visible count.");
    await page.locator("#idea-next").click();
    await page.locator(".budget-details summary").click();
    expect(BigInt(await page.locator("#maximum").inputValue())).toBeLessThanOrEqual(10000n);
    await page.locator("#generate").click();
    await page.waitForFunction(() => document.querySelector("#generation-status")?.textContent === "Verified preview ready" || !!document.querySelector("#generation-error")?.textContent?.trim(), undefined, { timeout: 300_000 });
    expect(await page.locator("#generation-error").textContent()).toBe("");
    expect(await page.locator("dialog[open]").count()).toBe(0);
    const facts = await page.locator("#generation-facts").textContent();
    const artifact = facts!.match(/artifact:sha256:[a-f0-9]{64}/u)![0];
    const napplet = page.frameLocator("#preview").frameLocator("iframe").first();
    await napplet.getByRole("button", { name: "Add", exact: true }).click(); await napplet.getByText("1", { exact: true }).waitFor();
    expect(await napplet.locator("body").evaluate(() => { try { void parent.localStorage.length; return false; } catch { return true; } })).toBe(true);
    const before = (await pool.query("SELECT account_id,direction,amount::text FROM ledger_entries ORDER BY entry_id")).rows;
    const accountId = await accountIdForPrincipal({ pubkey });
    expect(before.filter(row => row.account_id === accountId && row.direction === "debit").map(row => row.amount)).toEqual(["5"]);
    await runtime!.close(); runtime = undefined; await start();
    expect(runtime!.servicePubkey).toBe(servicePubkey);
    await page.reload();
    await page.waitForFunction(expected => document.querySelector("#generation-facts")?.textContent?.includes(expected), artifact, { timeout: 60_000 });
    expect((await pool.query("SELECT account_id,direction,amount::text FROM ledger_entries ORDER BY entry_id")).rows).toEqual(before);
    const deniedContext = await browser.newContext({ ignoreHTTPSErrors: true });
    await deniedContext.addInitScript(({ servicePubkey, origin }) => { if (location.origin === origin) sessionStorage.setItem(`napplet-cvm/dev-contextvm-key/v1/${servicePubkey}`, "22".repeat(32)); }, { servicePubkey, origin });
    const denied = await deniedContext.newPage();
    await denied.goto(origin); await denied.locator("#idea").fill("A counter"); await denied.locator("#idea-next").click();
    await denied.waitForFunction(() => document.querySelector("#connection-status")?.textContent?.includes("failed"), undefined, { timeout: 30_000 });
    expect((await pool.query("SELECT account_id,direction,amount::text FROM ledger_entries ORDER BY entry_id")).rows).toEqual(before);
  } finally {
    await browser?.close(); await runtime?.close(); proxy.stop(true); previewProxy.stop(true); blobsProxy.stop(true); relay.stop(true); await pool?.end();
    await command(["docker", "rm", "--force", container]).catch(() => undefined); await rm(directory, { recursive: true, force: true });
  }
}, 420_000);
