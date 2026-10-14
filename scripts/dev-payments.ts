import { chmod, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import { randomBytes } from "node:crypto";
import { Wallet, getEncodedToken } from "@cashu/cashu-ts";
import { finalizeEvent, nip04, nip47, Relay, verifyEvent } from "nostr-tools";

const root = resolve(import.meta.dir, "..");
const composeFile = resolve(root, "infra/dev-payments/compose.yaml");
export type DevPayments = { version: 1; developmentOnly: true; mintUrl: string; relayUrl: string; hubUrl: string; nwcUri: string; cashuToken: string };

/** Real encrypted NIP-47 request over the local relay; never used by production. */
export async function nwcRequest(uri: string, method: string, params: Record<string, unknown> = {}): Promise<any> {
  const connection = nip47.parseConnectionString(uri);
  const endpoint = new URL(connection.relay);
  if (endpoint.protocol !== "ws:" || endpoint.hostname !== "127.0.0.1") throw new Error("DEV_NWC_REQUIRES_LOOPBACK");
  const secret = Uint8Array.from(Buffer.from(connection.secret, "hex"));
  const event = finalizeEvent({ kind: 23194, created_at: Math.floor(Date.now() / 1000), tags: [["p", connection.pubkey]], content: await nip04.encrypt(secret, connection.pubkey, JSON.stringify({ method, params })) }, secret);
  const relay = await Relay.connect(connection.relay);
  try {
    return await new Promise((resolve, reject) => {
      const timeout = setTimeout(() => { sub.close(); reject(new Error(`NWC_TIMEOUT:${method}`)); }, 20_000);
      const sub = relay.subscribe([{ kinds: [23195], authors: [connection.pubkey], "#e": [event.id] }], {
        async onevent(response) {
          try {
            if (!verifyEvent(response)) throw new Error("NWC_SIGNATURE_INVALID");
            const decoded = JSON.parse(await nip04.decrypt(secret, connection.pubkey, response.content));
            if (decoded.result_type !== method) throw new Error("NWC_RESULT_TYPE_INVALID");
            if (decoded.error) throw new Error(`NWC_ERROR:${decoded.error.code}`);
            resolve(decoded.result);
          } catch (error) { reject(error); }
          finally { clearTimeout(timeout); sub.close(); }
        },
        oneose() {
          relay.publish(event).catch((error) => { clearTimeout(timeout); sub.close(); reject(error); });
        },
      });
    });
  } finally { relay.close(); secret.fill(0); }
}

async function privateJson(path: string, value: unknown) {
  await writeFile(path, JSON.stringify(value, null, 2) + "\n", { mode: 0o600 });
  await chmod(path, 0o600);
}

export async function waitUntil(check: () => Promise<boolean>, label: string, timeoutMs = 90_000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try { if (await check()) return; } catch { /* services are still starting */ }
    await Bun.sleep(500);
  }
  throw new Error(`DEV_PAYMENTS_TIMEOUT:${label}`);
}

export function developmentStack(test = false) {
  const project = test ? `napplet-cvm-payments-test-${randomBytes(6).toString("hex")}` : "napplet-cvm-dev-payments";
  const directory = resolve(root, ".local", project);
  // Deliberately ignore ambient endpoint/credential variables and .env files.
  const env = { ...process.env, DEV_MINT_PORT: test ? "0" : "3338", DEV_RELAY_PORT: test ? "0" : "7777", DEV_HUB_PORT: test ? "0" : "8081", COMPOSE_PROFILES: "" };
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
      console.log("Starting local mint, relay, and NWC wallet…");
      await compose("up", "-d");
      const mintUrl = await endpoint("mint", 3338, "http");
      const hubUrl = await endpoint("hub", 8080, "http");
      const relayUrl = await endpoint("relay", 8080, "ws");
      async function api(path: string, body?: unknown, token?: string) {
        const response = await fetch(hubUrl + path, { method: body ? "POST" : "GET", headers: { "content-type": "application/json", ...(token ? { authorization: `Bearer ${token}` } : {}) }, ...(body ? { body: JSON.stringify(body) } : {}), signal: AbortSignal.timeout(5000) });
        if (!response.ok) throw new Error(`DEV_HUB_HTTP:${response.status}:${path}`);
        return response.status === 204 ? null : response.json();
      }
      await waitUntil(async () => (await fetch(mintUrl + "/v1/info", { signal: AbortSignal.timeout(2000) })).ok, "mint");
      await waitUntil(async () => !!await api("/api/info"), "hub");
      const passwordFile = resolve(directory, "password.json");
      let password: string;
      try { password = JSON.parse(await readFile(passwordFile, "utf8")); }
      catch (error: any) {
        if (error.code !== "ENOENT") throw error;
        password = randomBytes(32).toString("hex");
        await privateJson(passwordFile, password);
      }
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
      const config: DevPayments = { version: 1, developmentOnly: true, mintUrl, hubUrl, relayUrl, nwcUri, cashuToken: getEncodedToken({ mint: mintUrl, unit: "sat", proofs }) };
      await privateJson(resolve(directory, "payments.json"), config);
      return config;
    },
  };
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
    } else if (command === "test") {
      const child = Bun.spawn([process.execPath, "test", "tests/dev/payments.e2e.test.ts"], { cwd: root, env: { ...process.env, NAPPLET_CVM_DEV_PAYMENTS_E2E: "1" }, stdout: "inherit", stderr: "inherit" });
      process.exitCode = await child.exited;
    } else throw new Error("Usage: bun scripts/dev-payments.ts up|down|reset|test");
  } catch (error) { console.error(error instanceof Error ? error.message : "Development setup failed"); process.exitCode = 1; }
}
