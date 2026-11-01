import { Wallet, getEncodedToken } from "@cashu/cashu-ts";
import { readFile } from "node:fs/promises";
import { loadServiceConfig, SERVICE_SECRETS_DIR } from "../src/service/config";

/**
 * Operator tool for the TEST realm only. It runs on the private stack
 * network beside the FakeWallet mint and test wallet; the service itself has
 * no faucet. Refuses to run when the mounted service config is the real realm.
 *
 *   bun scripts/test-rails.ts nwc            # prints a receive-only NWC URI
 *   bun scripts/test-rails.ts token <sats>   # prints a test Cashu token
 */
const config = await loadServiceConfig(process.env.NAPPLET_CVM_SERVICE_CONFIG ?? undefined);
if (config.realm !== "test") throw new Error("TEST_RAILS_REAL_REALM_DENIED");
const walletApi = process.env.NAPPLET_CVM_TEST_WALLET_URL ?? "http://test-wallet:8080";
const mint = config.funding.cashu.mints.find((candidate) => candidate.route);
if (!mint?.route) throw new Error("TEST_RAILS_MINT_ROUTE_REQUIRED");

async function waitFor(check: () => Promise<boolean>, label: string): Promise<void> {
  const deadline = Date.now() + 120_000;
  while (Date.now() < deadline) { try { if (await check()) return; } catch { /* starting */ } await Bun.sleep(1000); }
  throw new Error(`TEST_RAILS_TIMEOUT:${label}`);
}

async function api(path: string, body?: unknown, token?: string): Promise<any> {
  const response = await fetch(walletApi + path, { method: body ? "POST" : "GET", headers: { "content-type": "application/json", ...(token ? { authorization: `Bearer ${token}` } : {}) }, ...(body ? { body: JSON.stringify(body) } : {}), signal: AbortSignal.timeout(20_000) });
  if (!response.ok) throw new Error(`TEST_WALLET_HTTP:${response.status}:${path}`);
  return response.status === 204 ? null : response.json();
}

const [command, amount] = process.argv.slice(2);
if (command === "nwc") {
  const password = (await readFile(`${process.env.NAPPLET_CVM_SECRETS_DIR ?? SERVICE_SECRETS_DIR}/test_wallet_password`, "utf8")).trim();
  await waitFor(async () => (await fetch(new URL("/v1/info", mint.route))).ok, "mint");
  await waitFor(async () => !!await api("/api/info"), "wallet");
  let info = await api("/api/info");
  if (!info.setupCompleted) await api("/api/setup", { backendType: "CASHU", unlockPassword: password, cashuMintUrl: new URL(mint.route).origin });
  const auth = await api(info.running ? "/api/unlock" : "/api/start", { unlockPassword: password, permission: "full" });
  await waitFor(async () => { info = await api("/api/info"); return info.running && info.relays?.some((relay: { online?: boolean }) => relay.online); }, "wallet relay");
  // Receive-only: the service can create and look up invoices, never pay.
  const app = await api("/api/apps", { name: `napplet-cvm test receiver ${new Date().toISOString()}`, scopes: ["get_info", "make_invoice", "lookup_invoice"], maxAmountSat: 0, budgetRenewal: "never", isolated: false }, auth.token);
  const uri = new URL(app.pairingUri);
  uri.searchParams.delete("relay");
  uri.searchParams.append("relay", config.relay.url);
  console.log(uri.toString());
} else if (command === "token") {
  const sats = Number(amount);
  if (!Number.isSafeInteger(sats) || sats < 1 || sats > 100_000) throw new Error("TEST_RAILS_AMOUNT_INVALID");
  const route = new URL(mint.route).origin;
  const wallet = new Wallet(route);
  await wallet.loadMint();
  const quote = await wallet.createMintQuoteBolt11(sats);
  await waitFor(async () => (await wallet.checkMintQuoteBolt11(quote.quote)).state === "PAID", "fake payment");
  const proofs = await wallet.mintProofsBolt11(sats, quote);
  // The service knows this mint by its public identity, not its private route.
  console.log(getEncodedToken({ mint: new URL(mint.url).origin, unit: "sat", proofs }));
} else {
  console.error("usage: bun scripts/test-rails.ts nwc | token <sats>");
  process.exitCode = 2;
}
