import { z } from "zod";
import type { LightningCreateInvoiceRequest, LightningInvoiceObservation, LightningOriginalIntent, LightningQueryInvoiceRequest, LightningReceiptPort } from "./lightning-provider";

/** Authenticated NIP-47 transport: verifies wallet signature, recipient and #e,
 * decrypts the selected connection, and checks result_type before returning.
 * Connection identity and consent are captured by the deployment broker.
 */
export interface AuthenticatedNwcInvoiceTransport {
  readonly connectionScopeDigest: string;
  readonly consentedMethods: readonly string[];
  request(method: "make_invoice" | "lookup_invoice" | "list_transactions", params: Readonly<Record<string, unknown>>, signal: AbortSignal, originalOperationId?: string): Promise<unknown>;
  /** Query retained kind-23195 response by the persisted original request #e.
   * This MUST NOT publish the original request again. */
  observeOriginalResponse?(operationId: string, signal: AbortSignal): Promise<unknown | undefined>;
}

const Hash = z.string().regex(/^[0-9a-f]{64}$/u);
const Invoice = z.object({
  type: z.literal("incoming"), invoice: z.string().min(1).max(16384), payment_hash: Hash,
  description_hash: Hash.optional(), amount: z.number().int().positive().max(Number.MAX_SAFE_INTEGER),
  created_at: z.number().int().nonnegative(), expires_at: z.number().int().positive(),
  settled_at: z.number().int().positive().nullable().optional(),
  state: z.enum(["pending", "settled", "accepted", "expired", "failed"]).optional(),
});
type Invoice = z.infer<typeof Invoice>;
const Page = z.object({ transactions: z.array(z.unknown()).max(20), total_count: z.number().int().nonnegative().optional() });
const unknown = (topUpId: string, serviceReference = `invoice-create:${topUpId}`): LightningInvoiceObservation => ({ status: "unknown", topUpId, serviceReference });

/** NIP-47 / NWC-05 receipt mapping. Never holds a ledger or reissues a create.
 * https://github.com/nostr-protocol/nips/blob/master/47.md
 * https://github.com/nostr-wallet-connect/nwc/blob/main/05.md
 */
export class NwcLightningReceiptPort implements LightningReceiptPort {
  readonly accountingRealm = "production-real" as const;
  readonly connectionScopeDigest: string;
  constructor(private readonly transport: AuthenticatedNwcInvoiceTransport, private readonly now = () => Date.now()) {
    this.connectionScopeDigest = Hash.parse(transport.connectionScopeDigest);
  }

  async createInvoice(request: LightningCreateInvoiceRequest): Promise<LightningInvoiceObservation> {
    const intent = request.originalIntent;
    if (!intent || !this.matchesIntent(intent, request.topUpId) || intent.amount !== request.amount || !this.permitted("make_invoice")) throw new Error("NWC_ORIGINAL_INTENT_REQUIRED");
    const msats = BigInt(request.amount) * 1000n;
    if (msats > BigInt(Number.MAX_SAFE_INTEGER)) throw new Error("NWC_AMOUNT_OUT_OF_RANGE");
    const invoice = Invoice.parse(await this.transport.request("make_invoice", { amount: Number(msats), description_hash: intent.descriptionHash, expiry: 600 }, request.signal, intent.operationId));
    if (!this.matchesInvoice(invoice, intent)) return unknown(request.topUpId);
    return this.created(request.topUpId, invoice);
  }

  async queryOriginalIntent(request: Readonly<{ topUpId: string; intent: LightningOriginalIntent; signal: AbortSignal }>): Promise<LightningInvoiceObservation> {
    const { topUpId, intent, signal } = request;
    if (!this.matchesIntent(intent, topUpId)) return unknown(topUpId);
    if (this.transport.observeOriginalResponse) {
      try {
        const original = await this.transport.observeOriginalResponse(intent.operationId, signal);
        if (original !== undefined) {
          const invoice = Invoice.parse(original);
          return this.matchesInvoice(invoice, intent) ? this.created(topUpId, invoice) : unknown(topUpId);
        }
      } catch { return unknown(topUpId); }
    }
    if (!this.permitted("list_transactions")) return unknown(topUpId);
    const matches: Invoice[] = []; const hashes = new Set<string>(); let expectedTotal: number | undefined;
    // Fixed window, small pages, finite complete traversal. Never select the
    // first match before checking later pages for ambiguity.
    for (let page = 0; page < 10; page += 1) {
      signal.throwIfAborted();
      let result: z.infer<typeof Page>;
      try { result = Page.parse(await this.transport.request("list_transactions", { from: intent.from, until: intent.until, limit: 20, offset: page * 20, unpaid: true, type: "incoming" }, signal)); }
      catch { return unknown(topUpId); }
      if (result.total_count !== undefined) {
        if (expectedTotal !== undefined && expectedTotal !== result.total_count) return unknown(topUpId);
        expectedTotal = result.total_count;
        if (expectedTotal > 200 || page * 20 + result.transactions.length > expectedTotal) return unknown(topUpId);
      }
      for (const raw of result.transactions) {
        const parsed = Invoice.safeParse(raw);
        // An unparseable matching-window record could conceal another match.
        if (!parsed.success) return unknown(topUpId);
        const invoice = parsed.data;
        if (hashes.has(invoice.payment_hash)) return unknown(topUpId);
        hashes.add(invoice.payment_hash);
        if (this.matchesInvoice(invoice, intent)) matches.push(invoice);
      }
      const exhausted = result.transactions.length < 20 || expectedTotal === (page + 1) * 20;
      if (exhausted) {
        if (expectedTotal !== undefined && expectedTotal !== page * 20 + result.transactions.length) return unknown(topUpId);
        return matches.length === 1 ? this.created(topUpId, matches[0]!) : unknown(topUpId);
      }
    }
    return unknown(topUpId);
  }

  async queryInvoice(request: LightningQueryInvoiceRequest): Promise<LightningInvoiceObservation> {
    if (!Hash.safeParse(request.serviceReference).success || !this.permitted("lookup_invoice")) return unknown(request.topUpId, request.serviceReference);
    const invoice = Invoice.parse(await this.transport.request("lookup_invoice", { payment_hash: request.serviceReference }, request.signal));
    if (invoice.payment_hash !== request.serviceReference || invoice.amount % 1000 !== 0) return unknown(request.topUpId, request.serviceReference);
    if (invoice.settled_at && (!invoice.state || invoice.state === "settled")) return {
      status: "settled", topUpId: request.topUpId, serviceReference: request.serviceReference,
      invoiceIdentity: invoice.invoice, paymentHash: invoice.payment_hash, amount: String(invoice.amount / 1000), unit: "sat",
      expiresAt: new Date(invoice.expires_at * 1000).toISOString(), settledAt: new Date(invoice.settled_at * 1000).toISOString(),
      final: true, receiverAuthenticated: true, settlementReference: `nwc:${this.connectionScopeDigest}:${invoice.payment_hash}`,
    };
    if (invoice.expires_at * 1000 <= this.now() || invoice.state === "expired" || invoice.state === "failed") return { status: "failed", topUpId: request.topUpId, serviceReference: request.serviceReference, reason: "expired" };
    return this.created(request.topUpId, invoice);
  }

  private permitted(method: string): boolean { return this.transport.consentedMethods.includes(method); }
  private matchesIntent(intent: LightningOriginalIntent, topUpId: string): boolean {
    return intent.realm === this.accountingRealm && intent.type === "incoming" && intent.operationId === `invoice-create:${topUpId}` &&
      intent.connectionScopeDigest === this.connectionScopeDigest && Hash.safeParse(intent.descriptionHash).success &&
      /^[1-9][0-9]*$/u.test(intent.amount) && Number.isSafeInteger(intent.from) && Number.isSafeInteger(intent.until) &&
      intent.from >= 0 && intent.until >= intent.from && intent.until - intent.from <= 120;
  }
  private matchesInvoice(invoice: Invoice, intent: LightningOriginalIntent): boolean {
    return invoice.description_hash === intent.descriptionHash && BigInt(invoice.amount) === BigInt(intent.amount) * 1000n &&
      invoice.created_at >= intent.from && invoice.created_at <= intent.until && invoice.expires_at * 1000 > this.now() &&
      invoice.state !== "expired" && invoice.state !== "failed";
  }
  private created(topUpId: string, invoice: Invoice): LightningInvoiceObservation {
    return { status: "created", topUpId, serviceReference: invoice.payment_hash, invoice: invoice.invoice, invoiceIdentity: invoice.invoice,
      paymentHash: invoice.payment_hash, amount: String(invoice.amount / 1000), unit: "sat", expiresAt: new Date(invoice.expires_at * 1000).toISOString(),
      safeDisplayReference: `lightning:${invoice.payment_hash.slice(0, 12)}` };
  }
}
