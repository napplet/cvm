import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import { Wallet, getEncodedToken } from "@cashu/cashu-ts";
import { PrivateKeySigner } from "@contextvm/sdk/signer";
import { NostrServerTransport } from "@contextvm/sdk/transport";
import { createDevelopmentFunding } from "../../scripts/dev-funding";
import { developmentStack, type DevPayments } from "../../scripts/dev-payments";
import { AccountStatusService } from "../funding/account-status";
import { ContextVmFundingAdapter } from "../contextvm/adapter";
import { ContextVmSdkBridge } from "../contextvm/sdk-bridge";
import { DevelopmentNwcSettlementReconciler } from "../dev/dev-funding-reconciler";

const root = resolve(import.meta.dir, "../..");
const reserveSat = "3750";

type DevelopmentFunding = Awaited<ReturnType<typeof createDevelopmentFunding>>;
export type DevelopmentContextVmServer = Readonly<{
  url: string;
  stopReconciler(): void;
  restartReconciler(): void;
  assertFundingEvidence(caseName: "cashu-wire" | "both-rails-restart-replay"): Promise<void>;
  close(): Promise<void>;
}>;

async function sha256File(path: string): Promise<string> {
  return new Bun.CryptoHasher("sha256").update(await Bun.file(path).arrayBuffer()).digest("hex");
}

async function browserBundle(): Promise<string> {
  const pinoShim = resolve(root, "src/dev-ui/browser/pino-browser-shim.ts");
  const build = await Bun.build({
    entrypoints: [resolve(root, "src/dev-ui/browser/main.ts")], target: "browser", format: "esm", minify: true, write: false,
    plugins: [{ name: "contextvm-browser-pino", setup(builder) { builder.onResolve({ filter: /^pino$/ }, () => ({ path: pinoShim })); } }],
  });
  if (!build.success) throw new Error(`DEV_UI_BROWSER_BUILD_FAILED:${build.logs.map((item) => item.message).join(";")}`);
  const output = build.outputs.find((file) => file.path.endsWith(".js"));
  if (!output) throw new Error("DEV_UI_BROWSER_BUNDLE_MISSING");
  return output.text();
}

async function mintCashuToken(app: DevelopmentFunding, config: DevPayments, amount: number): Promise<string> {
  if (!Number.isSafeInteger(amount) || amount < 1 || amount > 10_000) throw new Error("DEV_CASHU_FAUCET_AMOUNT_INVALID");
  const wallet = new Wallet(config.mintUrl);
  await wallet.loadMint();
  const quote = await wallet.createMintQuoteBolt11(amount);
  const proofs = await wallet.mintProofsBolt11(amount, quote);
  const localToken = getEncodedToken({ mint: config.mintUrl, unit: "sat", proofs });
  return new TextDecoder().decode(app.applicationToken(localToken));
}

/**
 * Local development surface: static assets and non-secret bootstrap facts only.
 * Account and payment commands always pass through ContextVM over the relay.
 */
export async function createDevelopmentContextVmServer(options: Readonly<{ testMode?: boolean; config?: DevPayments }> = {}): Promise<DevelopmentContextVmServer> {
  const stack = options.testMode ? developmentStack(true) : undefined;
  const config = options.config ?? (stack ? await stack.up() : await Bun.file(resolve(root, ".local/napplet-cvm-dev-payments/payments.json")).json() as DevPayments);
  const app = await createDevelopmentFunding(config);
  const signer = new PrivateKeySigner();
  const transport = new NostrServerTransport({ signer, relayHandler: [config.relayUrl], encryptionMode: "required", publishRelayList: false, injectRequestEventId: true, logLevel: "silent" });
  const bridge = new ContextVmSdkBridge(transport);
  const accountStatus = new AccountStatusService({
    store: app.database.funding,
    sessions: { list: async () => ({ active: [], resumable: [], pendingActions: [] }) },
    rails: app.database.railStatuses,
  });
  new ContextVmFundingAdapter({ service: app.funding, transport: bridge, accountStatus, topUps: { lightning: app.lightning, cashu: app.cashu }, policyVersion: "development-local-v1" });
  const reconciler = new DevelopmentNwcSettlementReconciler(app);
  const [html, javascript, servicePubkey] = await Promise.all([
    readFile(resolve(root, "src/dev-ui/browser/index.html"), "utf8"), browserBundle(), signer.getPublicKey(),
  ]);
  await transport.start();
  reconciler.start();

  const web = Bun.serve({
    hostname: "127.0.0.1",
    port: 0,
    async fetch(request) {
      const url = new URL(request.url);
      if (url.hostname !== "127.0.0.1" && url.hostname !== "localhost") return new Response("loopback only", { status: 403 });
      if (url.pathname === "/") return new Response(html, { headers: { "content-type": "text/html; charset=utf-8", "cache-control": "no-store" } });
      if (url.pathname === "/app.js") return new Response(javascript, { headers: { "content-type": "text/javascript; charset=utf-8", "cache-control": "no-store" } });
      if (url.pathname === "/bootstrap") return Response.json({ relayUrl: config.relayUrl, servicePubkey, reserveSat, actionCeilingSat: reserveSat }, { headers: { "cache-control": "no-store" } });
      if (url.pathname === "/dev/faucet/cashu" && request.method === "POST") {
        try {
          const amount = Number(url.searchParams.get("amount"));
          return Response.json({ token: await mintCashuToken(app, config, amount) }, { headers: { "cache-control": "no-store" } });
        } catch { return Response.json({ code: "faucet_rejected" }, { status: 400 }); }
      }
      if (url.pathname === "/health") return Response.json({ status: "ok" });
      return new Response("not found", { status: 404 });
    },
  });
  const url = `http://127.0.0.1:${web.port}`;

  return Object.freeze({
    url,
    stopReconciler: () => reconciler.stop(),
    restartReconciler: () => { reconciler.stop(); reconciler.start(); },
    async assertFundingEvidence(caseName) {
      const last = bridge.lastInbound;
      if (!last || !/^[a-f0-9]{64}$/.test(last.verifiedClientPubkey) || !/^[a-f0-9]{64}$/.test(last.requestEventId)) throw new Error("DEV_UI_SIGNED_EVENT_EVIDENCE_MISSING");
      for (const method of ["initialize", "tools/list", "tools/call", "notifications/initialized"]) {
        if (!bridge.observedMethods.has(method)) throw new Error(`DEV_UI_MCP_LIFECYCLE_MISSING:${method}`);
      }
      const status = await accountStatus.status({ pubkey: last.verifiedClientPubkey });
      const expected = caseName === "cashu-wire" ? "64" : "3814";
      if (status.available !== expected) throw new Error(`DEV_UI_BALANCE_MISMATCH:${status.available}`);
      const credits = await app.pool.query<{ count: number }>("SELECT count(*)::int AS count FROM ledger_entries WHERE account_id=$1 AND direction='credit'", [status.accountId]);
      if (credits.rows[0]?.count !== (caseName === "cashu-wire" ? 1 : 2)) throw new Error("DEV_UI_LEDGER_REPLAY_MISMATCH");
      const [packageHash, lockHash] = await Promise.all([sha256File(resolve(root, "package.json")), sha256File(resolve(root, "bun.lock"))]);
      if (packageHash !== "cbcc433278d32391b075576ebd847ae30039f1d86ad229a149f5566856989f23" || lockHash !== "8916ee4ec92924ae9e09bc4f315fd6656033812696e35a1b7785161d872c5ac3") throw new Error("DEV_UI_ROOT_MANIFEST_DRIFT");
    },
    async close() {
      reconciler.stop();
      try { web.stop(true); }
      finally {
        // Relay shutdown is best-effort in the local SDK; do not leave a
        // browser evidence run holding containers forever on a lost close ACK.
        try { await Promise.race([transport.close().catch(() => undefined), Bun.sleep(1_000)]); }
        finally {
          try { await app.close(); }
          finally { if (stack) await stack.down(true); }
        }
      }
    },
  });
}

if (import.meta.main) {
  const server = await createDevelopmentContextVmServer();
  console.log(`Development ContextVM funding workspace: ${server.url}`);
  const stop = async () => { await server.close(); process.exit(0); };
  process.once("SIGINT", () => { void stop(); });
  process.once("SIGTERM", () => { void stop(); });
  await new Promise<void>(() => undefined);
}
