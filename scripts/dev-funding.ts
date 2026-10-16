import { getDecodedToken, getEncodedToken, HttpResponseError, JSONInt, MintOperationError, NetworkError, type RequestFn, type RequestOptions } from "@cashu/cashu-ts";
import { z } from "zod";
import { FundingService } from "../src/funding/funding-service";
import { CashuMintPolicyRegistry } from "../src/funding/cashu-mint-policy";
import { CashuTsSettlementAdapter } from "../src/funding/cashu-provider";
import { CashuTopUpCoordinator } from "../src/funding/cashu-top-up";
import { LightningTopUpCoordinator } from "../src/funding/lightning-top-up";
import type { LightningCreateInvoiceRequest, LightningInvoiceObservation, LightningQueryInvoiceRequest, LightningReceiptPort } from "../src/funding/lightning-provider";
import { ProtectedRailMaterialVault } from "../src/funding/protected-rail-material";
import { PostgresFundingDatabase } from "../src/persistence/postgres-funding-database";
import { createDevelopmentPool, nwcRequest, type DevPayments } from "./dev-payments";

function loopback(value: string, protocol: string): URL {
  const url = new URL(value);
  if (url.protocol !== protocol || url.hostname !== "127.0.0.1" || !url.port || url.search || url.hash) throw new Error("DEV_FUNDING_REQUIRES_LOOPBACK");
  return url;
}

const Invoice = z.object({
  type: z.literal("incoming"), invoice: z.string().regex(/^lnbc/), payment_hash: z.string().regex(/^[0-9a-f]{64}$/),
  amount: z.number().int().positive().refine((value) => value % 1000 === 0),
  expires_at: z.number().int().positive(), settled_at: z.number().int().positive().nullable().optional(),
});
type Invoice = z.infer<typeof Invoice>;

/** Local Hub receiver only; NIP-47 authenticates the wallet's signed response. */
export class DevelopmentNwcReceiver implements LightningReceiptPort {
  constructor(private readonly uri: string) {}

  async createInvoice(request: LightningCreateInvoiceRequest): Promise<LightningInvoiceObservation> {
    const amount = BigInt(request.amount) * 1000n;
    if (amount <= 0n || amount > BigInt(Number.MAX_SAFE_INTEGER)) throw new Error("DEV_NWC_AMOUNT_INVALID");
    const invoice = Invoice.parse(await nwcRequest(this.uri, "make_invoice", { amount: Number(amount), description: request.idempotencyLabel }, request.signal));
    if (invoice.amount !== Number(amount)) throw new Error("DEV_NWC_AMOUNT_MISMATCH");
    return this.created(request.topUpId, invoice);
  }

  async queryInvoice(request: LightningQueryInvoiceRequest): Promise<LightningInvoiceObservation> {
    // NIP-47 make_invoice has no idempotency-key lookup. An interrupted create
    // without its payment hash must remain unknown; never create a replacement.
    if (!/^[0-9a-f]{64}$/.test(request.serviceReference)) return { status: "unknown", ...requestTarget(request) };
    const invoice = Invoice.parse(await nwcRequest(this.uri, "lookup_invoice", { payment_hash: request.serviceReference }, request.signal));
    if (invoice.payment_hash !== request.serviceReference) throw new Error("DEV_NWC_RECEIPT_MISMATCH");
    const created = this.created(request.topUpId, invoice);
    if (invoice.settled_at) return {
      status: "settled", ...requestTarget(request), invoiceIdentity: invoice.invoice, paymentHash: invoice.payment_hash,
      amount: String(invoice.amount / 1000), unit: "sat", expiresAt: new Date(invoice.expires_at * 1000).toISOString(),
      settledAt: new Date(invoice.settled_at * 1000).toISOString(), final: true,
      settlementReference: `dev-nwc:${invoice.payment_hash}`, receiverAuthenticated: true,
    };
    if (invoice.expires_at * 1000 <= Date.now()) return { status: "failed", ...requestTarget(request), reason: "expired" };
    return created;
  }

  private created(topUpId: string, invoice: Invoice): LightningInvoiceObservation {
    return {
      status: "created", topUpId, serviceReference: invoice.payment_hash, invoice: invoice.invoice,
      invoiceIdentity: invoice.invoice, paymentHash: invoice.payment_hash, amount: String(invoice.amount / 1000), unit: "sat",
      expiresAt: new Date(invoice.expires_at * 1000).toISOString(), safeDisplayReference: `dev-nwc:${invoice.payment_hash.slice(0, 12)}`,
    };
  }
}
function requestTarget(request: LightningQueryInvoiceRequest) { return { topUpId: request.topUpId, serviceReference: request.serviceReference }; }

/** Development funding composition. Never imported by the production factory. */
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
  const aliases = ["https://mint.dev.invalid", "https://mint-secondary.dev.invalid"];
  const routes = new Map(aliases.map((alias, index) => [alias, mintUrls[index]!]));
  const mints = await Promise.all(mintUrls.map(async (url, index) => {
    const response = await fetch(`${url}/v1/keysets`, { redirect: "error", signal: AbortSignal.timeout(5000) });
    if (!response.ok) throw new Error("DEV_MINT_KEYSETS_UNAVAILABLE");
    const data = z.object({ keysets: z.array(z.object({ id: z.string(), unit: z.string(), active: z.boolean() })) }).parse(await response.json());
    return { url: aliases[index]!, unit: "sat" as const, keysetIds: data.keysets.filter((keyset) => keyset.active && keyset.unit === "sat").map((keyset) => keyset.id), requireDleq: true, proofConditions: ["none"] };
  }));
  const policies = new CashuMintPolicyRegistry({ version: "development-local-v1", activeFrom: "2026-01-01T00:00:00.000Z", activeUntil: null, mints });
  // Keep the application's HTTPS policy intact. Only this request seam routes
  // these two reserved names to explicit Docker-assigned loopback endpoints.
  const request: RequestFn = async <T>(options: RequestOptions): Promise<T> => {
    const source = new URL(options.endpoint);
    const target = routes.get(source.origin);
    if (!target || source.username || source.password || source.hash) throw new Error("DEV_CASHU_ROUTE_DENIED");
    let response: Response;
    try {
      response = await fetch(`${target}${source.pathname}${source.search}`, {
        method: options.method ?? (options.requestBody ? "POST" : "GET"),
        headers: { "content-type": "application/json" },
        ...(options.requestBody ? { body: JSONInt.stringify(options.requestBody) } : {}),
        signal: AbortSignal.any([AbortSignal.timeout(5000), ...(options.signal ? [options.signal] : [])]), redirect: "error",
      });
    } catch { throw new NetworkError("Local mint request failed"); }
    const body = JSONInt.parse(await response.text()) as { code?: number };
    if (!response.ok) {
      if (typeof body.code === "number") throw new MintOperationError(body.code, "Local mint rejected request");
      throw new HttpResponseError("Local mint request failed", response.status);
    }
    return body as T;
  };
  const pool = createDevelopmentPool(config.databaseUrl);
  // Docker builds and Chromium share this workstation with PostgreSQL. The
  // production 250ms budget can expire while settling an otherwise valid build.
  const database = new PostgresFundingDatabase(pool, { deadlineMs: 5_000 });
  const funding = new FundingService(database.funding);
  const vault = new ProtectedRailMaterialVault({ key: Uint8Array.from(Buffer.from(config.fundingKey, "hex")), repository: database.protectedMaterials });
  return {
    pool, database, funding, vault, policies,
    lightning: new LightningTopUpCoordinator({ funding, vault, repository: database.lightning, receiver: new DevelopmentNwcReceiver(config.nwcUri), providerTimeoutMs: 20_000 }),
    cashu: new CashuTopUpCoordinator({ funding, vault, repository: database.cashu, policies, provider: new CashuTsSettlementAdapter({ request }), providerTimeoutMs: 20_000 }),
    applicationToken(token: string): Uint8Array {
      const decoded = getDecodedToken(token, mints.flatMap((mint) => mint.keysetIds));
      const index = mintUrls.indexOf(decoded.mint);
      if (index < 0) throw new Error("DEV_CASHU_TOKEN_MINT_UNKNOWN");
      return new TextEncoder().encode(getEncodedToken({ ...decoded, mint: aliases[index]! }));
    },
    close: () => pool.end(),
  };
}
