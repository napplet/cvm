import { lstat, readFile, realpath } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import type { DevPayments } from "../../scripts/dev-payments";

const root = resolve(import.meta.dir, "../..");
const runIdPattern = /^[a-z0-9][a-z0-9-]{0,47}$/u;
type Environment = Readonly<Record<string, string | undefined>>;

function fail(code: string): never { throw new Error(code); }

function loopbackUrl(value: unknown, protocol: "http:" | "ws:"): string {
  if (typeof value !== "string") fail("DEV_TEST_PAYMENT_CONFIG_INVALID");
  let endpoint: URL;
  try { endpoint = new URL(value); } catch { fail("DEV_TEST_PAYMENT_CONFIG_ENDPOINT_INVALID"); }
  if (endpoint.protocol !== protocol || endpoint.hostname !== "127.0.0.1" || !endpoint.port || endpoint.username || endpoint.password || endpoint.search || endpoint.hash) fail("DEV_TEST_PAYMENT_CONFIG_ENDPOINT_INVALID");
  return value;
}

function parse(value: unknown): DevPayments {
  if (!value || typeof value !== "object" || Array.isArray(value)) fail("DEV_TEST_PAYMENT_CONFIG_INVALID");
  const config = value as Record<string, unknown>;
  if (config.version !== 1 || config.developmentOnly !== true) fail(config.developmentOnly === false ? "DEV_TEST_PAYMENT_CONFIG_NOT_DEVELOPMENT_ONLY" : "DEV_TEST_PAYMENT_CONFIG_INVALID");
  const mintUrl = loopbackUrl(config.mintUrl, "http:");
  const secondaryMintUrl = loopbackUrl(config.secondaryMintUrl, "http:");
  const hubUrl = loopbackUrl(config.hubUrl, "http:");
  const relayUrl = loopbackUrl(config.relayUrl, "ws:");
  if (typeof config.databaseUrl !== "string" || typeof config.nwcUri !== "string" || typeof config.cashuToken !== "string" || typeof config.fundingKey !== "string") fail("DEV_TEST_PAYMENT_CONFIG_INVALID");
  let database: URL; let nwc: URL;
  try { database = new URL(config.databaseUrl); nwc = new URL(config.nwcUri); } catch { fail("DEV_TEST_PAYMENT_CONFIG_ENDPOINT_INVALID"); }
  if (database.protocol !== "postgresql:" || database.hostname !== "127.0.0.1" || !database.port || database.pathname !== "/napplet_dev" || database.username !== "napplet_dev" || database.search || database.hash) fail("DEV_TEST_PAYMENT_CONFIG_ENDPOINT_INVALID");
  const nwcRelay = nwc.searchParams.get("relay");
  if (nwc.protocol !== "nostr+walletconnect:" || !/^[a-f0-9]{64}$/u.test(nwc.hostname) || !/^[a-f0-9]{64}$/u.test(nwc.searchParams.get("secret") ?? "") || !nwcRelay) fail("DEV_TEST_PAYMENT_CONFIG_ENDPOINT_INVALID");
  loopbackUrl(nwcRelay, "ws:");
  if (!/^cashu[AB][a-zA-Z0-9_-]+$/u.test(config.cashuToken) || !/^[a-f0-9]{64}$/u.test(config.fundingKey)) fail("DEV_TEST_PAYMENT_CONFIG_INVALID");
  return Object.freeze({ version: 1, developmentOnly: true, mintUrl, secondaryMintUrl, relayUrl, hubUrl, nwcUri: config.nwcUri, cashuToken: config.cashuToken, databaseUrl: config.databaseUrl, fundingKey: config.fundingKey });
}

/** Reads only the per-run config created by scripts/dev-payments.ts test. */
export async function readDevelopmentPaymentConfig(environment: Environment = process.env): Promise<DevPayments> {
  const runId = environment.NAPPLET_CVM_DEV_TEST_RUN_ID;
  const configured = environment.NAPPLET_CVM_DEV_TEST_PAYMENTS_FILE;
  if (!runId || !configured) fail("DEV_TEST_PAYMENT_CONFIG_REQUIRED");
  if (!runIdPattern.test(runId)) fail("DEV_TEST_PAYMENT_CONFIG_OWNERSHIP_INVALID");
  const expected = resolve(root, ".local", "napplet-cvm-dev", runId, "payments", "payments.json");
  if (configured !== expected) fail("DEV_TEST_PAYMENT_CONFIG_OWNERSHIP_INVALID");
  let metadata;
  try { metadata = await lstat(configured); } catch { fail("DEV_TEST_PAYMENT_CONFIG_INVALID"); }
  if (metadata.isSymbolicLink()) fail("DEV_TEST_PAYMENT_CONFIG_SYMLINK");
  try {
    const canonicalRoot = await realpath(root);
    const canonicalDirectory = await realpath(dirname(expected));
    if (canonicalDirectory !== resolve(canonicalRoot, ".local", "napplet-cvm-dev", runId, "payments")) fail("DEV_TEST_PAYMENT_CONFIG_OWNERSHIP_INVALID");
  } catch (error) { if (error instanceof Error && error.message === "DEV_TEST_PAYMENT_CONFIG_OWNERSHIP_INVALID") throw error; fail("DEV_TEST_PAYMENT_CONFIG_INVALID"); }
  if (!metadata.isFile() || (metadata.mode & 0o777) !== 0o600) fail("DEV_TEST_PAYMENT_CONFIG_INVALID");
  try { return parse(JSON.parse(await readFile(configured, "utf8"))); }
  catch (error) { if (error instanceof Error && error.message.startsWith("DEV_TEST_PAYMENT_CONFIG_")) throw error; fail("DEV_TEST_PAYMENT_CONFIG_INVALID"); }
}
