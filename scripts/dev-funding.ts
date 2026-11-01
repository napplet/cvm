import { getDecodedToken, getEncodedToken } from "@cashu/cashu-ts";
import { createServiceFunding } from "../src/service/funding";
import { NwcInvoiceReceiver } from "../src/service/nwc";
import { createDevelopmentPool, type DevPayments } from "./dev-payments";

function loopback(value: string, protocol: string): URL {
  const url = new URL(value);
  if (url.protocol !== protocol || url.hostname !== "127.0.0.1" || !url.port || url.search || url.hash) throw new Error("DEV_FUNDING_REQUIRES_LOOPBACK");
  return url;
}

/** Local Hub receiver only; NIP-47 authenticates the wallet's signed response. */
export class DevelopmentNwcReceiver extends NwcInvoiceReceiver {
  constructor(uri: string) { super(uri, { policy: "loopback", referencePrefix: "dev-nwc" }); }
}

/** Development funding composition: the service composition with local test rails. */
export async function createDevelopmentFunding(config: DevPayments) {
  if (config.developmentOnly !== true || config.version !== 1 || !/^[0-9a-f]{64}$/.test(config.fundingKey)) throw new Error("DEV_FUNDING_CONFIG_INVALID");
  const db = loopback(config.databaseUrl, "postgresql:");
  if (db.pathname !== "/napplet_dev" || db.username !== "napplet_dev") throw new Error("DEV_DATABASE_INVALID");
  const mintUrls = [config.mintUrl, config.secondaryMintUrl];
  for (const value of mintUrls) {
    const url = loopback(value, "http:");
    if (url.username || url.password || url.pathname !== "/") throw new Error("DEV_MINT_INVALID");
  }
  if (new Set(mintUrls).size !== 2) throw new Error("DEV_MINTS_MUST_BE_DISTINCT");
  // Keep the application's HTTPS policy intact. Only these two reserved names
  // route to explicit Docker-assigned loopback endpoints.
  const aliases = ["https://mint.dev.invalid", "https://mint-secondary.dev.invalid"];
  const pool = createDevelopmentPool(config.databaseUrl);
  // Docker builds and Chromium share this workstation with PostgreSQL. The
  // production 250ms budget can expire while settling an otherwise valid build.
  const service = await createServiceFunding({
    pool, fundingKey: Uint8Array.from(Buffer.from(config.fundingKey, "hex")), nwcUri: config.nwcUri, nwcPolicy: "loopback", settlementPrefix: "dev-nwc",
    mints: aliases.map((url, index) => ({ url, route: mintUrls[index]! })), mintPolicyVersion: "development-local-v1", allowMintRoutes: true, deadlineMs: 5_000,
  }).catch(async (error) => { await pool.end(); throw error; });
  const keysetIds = service.policies.pinActive().mints.flatMap((mint) => mint.keysetIds);
  return {
    ...service,
    applicationToken(token: string): Uint8Array {
      const decoded = getDecodedToken(token, keysetIds);
      const index = mintUrls.indexOf(decoded.mint);
      if (index < 0) throw new Error("DEV_CASHU_TOKEN_MINT_UNKNOWN");
      return new TextEncoder().encode(getEncodedToken({ ...decoded, mint: aliases[index]! }));
    },
  };
}
