import { z } from "zod";
import { finalizeEvent, nip04, nip47, Relay, verifyEvent } from "nostr-tools";
import type { LightningCreateInvoiceRequest, LightningInvoiceObservation, LightningQueryInvoiceRequest, LightningReceiptPort } from "../funding/lightning-provider";

/**
 * Which wallet relays a NIP-47 connection may use. Development and the test
 * realm may use a private plaintext relay; the real-money realm requires TLS.
 */
export type NwcRelayPolicy = "loopback" | "private-test" | "tls";

export function assertNwcConnection(uri: string, policy: NwcRelayPolicy): ReturnType<typeof nip47.parseConnectionString> {
  const connection = nip47.parseConnectionString(uri);
  const endpoint = new URL(connection.relay);
  const valid = !endpoint.username && !endpoint.password && /^[0-9a-f]{64}$/u.test(connection.secret) && /^[0-9a-f]{64}$/u.test(connection.pubkey)
    && (policy === "loopback" ? endpoint.protocol === "ws:" && endpoint.hostname === "127.0.0.1"
      : policy === "private-test" ? endpoint.protocol === "ws:" || endpoint.protocol === "wss:"
        : endpoint.protocol === "wss:");
  if (!valid) throw new Error(policy === "loopback" ? "DEV_NWC_REQUIRES_LOOPBACK" : "NWC_CONNECTION_INVALID");
  return connection;
}

/** Real encrypted NIP-47 request. The wallet's signed response authenticates it. */
export async function nwcRequest(uri: string, method: string, params: Record<string, unknown> = {}, callerSignal?: AbortSignal, policy: NwcRelayPolicy = "loopback"): Promise<any> {
  const connection = assertNwcConnection(uri, policy);
  const signal = AbortSignal.any([AbortSignal.timeout(20_000), ...(callerSignal ? [callerSignal] : [])]);
  const secret = Uint8Array.from(Buffer.from(connection.secret, "hex"));
  const relay = new Relay(connection.relay);
  try {
    signal.throwIfAborted();
    const event = finalizeEvent({ kind: 23194, created_at: Math.floor(Date.now() / 1000), tags: [["p", connection.pubkey]], content: await nip04.encrypt(secret, connection.pubkey, JSON.stringify({ method, params })) }, secret);
    await relay.connect({ abort: signal, timeout: 5000 });
    return await new Promise((resolve, reject) => {
      const abort = () => { sub.close(); reject(new Error(`NWC_ABORTED:${method}`)); };
      const sub = relay.subscribe([{ kinds: [23195], authors: [connection.pubkey], "#e": [event.id] }], {
        async onevent(response) {
          try {
            if (!verifyEvent(response)) throw new Error("NWC_SIGNATURE_INVALID");
            const decoded = JSON.parse(await nip04.decrypt(secret, connection.pubkey, response.content));
            if (decoded.result_type !== method) throw new Error("NWC_RESULT_TYPE_INVALID");
            if (decoded.error) throw new Error(`NWC_ERROR:${decoded.error.code}`);
            resolve(decoded.result);
          } catch (error) { reject(error); }
          finally { signal.removeEventListener("abort", abort); sub.close(); }
        },
        oneose() {
          relay.publish(event).catch(() => { signal.removeEventListener("abort", abort); sub.close(); reject(new Error("NWC_PUBLISH_FAILED")); });
        },
      });
      signal.addEventListener("abort", abort, { once: true });
      if (signal.aborted) abort();
    });
  } finally { relay.close(); secret.fill(0); }
}

const Invoice = z.object({
  type: z.literal("incoming"), invoice: z.string().regex(/^ln(bc|tb|bcrt)/u), payment_hash: z.string().regex(/^[0-9a-f]{64}$/u),
  amount: z.number().int().positive().refine((value) => value % 1000 === 0),
  expires_at: z.number().int().positive(), settled_at: z.number().int().positive().nullable().optional(),
});
type Invoice = z.infer<typeof Invoice>;

/**
 * Receive-only NIP-47 wallet port: `make_invoice` and `lookup_invoice`. The
 * service never asks this wallet to pay. Settlement is accepted only from the
 * wallet's signed `lookup_invoice` result for the original payment hash.
 */
export class NwcInvoiceReceiver implements LightningReceiptPort {
  constructor(private readonly uri: string, private readonly options: Readonly<{ policy?: NwcRelayPolicy; referencePrefix?: string }> = {}) {}
  private get prefix() { return this.options.referencePrefix ?? "dev-nwc"; }
  private request(method: string, params: Record<string, unknown>, signal?: AbortSignal) { return nwcRequest(this.uri, method, params, signal, this.options.policy ?? "loopback"); }

  async createInvoice(request: LightningCreateInvoiceRequest): Promise<LightningInvoiceObservation> {
    const amount = BigInt(request.amount) * 1000n;
    if (amount <= 0n || amount > BigInt(Number.MAX_SAFE_INTEGER)) throw new Error("NWC_AMOUNT_INVALID");
    const invoice = Invoice.parse(await this.request("make_invoice", { amount: Number(amount), description: request.idempotencyLabel }, request.signal));
    if (invoice.amount !== Number(amount)) throw new Error("NWC_AMOUNT_MISMATCH");
    return this.created(request.topUpId, invoice);
  }

  async queryInvoice(request: LightningQueryInvoiceRequest): Promise<LightningInvoiceObservation> {
    // NIP-47 make_invoice has no idempotency-key lookup. An interrupted create
    // without its payment hash must remain unknown; never create a replacement.
    const target = { topUpId: request.topUpId, serviceReference: request.serviceReference };
    if (!/^[0-9a-f]{64}$/u.test(request.serviceReference)) return { status: "unknown", ...target };
    const invoice = Invoice.parse(await this.request("lookup_invoice", { payment_hash: request.serviceReference }, request.signal));
    if (invoice.payment_hash !== request.serviceReference) throw new Error("NWC_RECEIPT_MISMATCH");
    if (invoice.settled_at) return {
      status: "settled", ...target, invoiceIdentity: invoice.invoice, paymentHash: invoice.payment_hash,
      amount: String(invoice.amount / 1000), unit: "sat", expiresAt: new Date(invoice.expires_at * 1000).toISOString(),
      settledAt: new Date(invoice.settled_at * 1000).toISOString(), final: true,
      settlementReference: `${this.prefix}:${invoice.payment_hash}`, receiverAuthenticated: true,
    };
    if (invoice.expires_at * 1000 <= Date.now()) return { status: "failed", ...target, reason: "expired" };
    return this.created(request.topUpId, invoice);
  }

  private created(topUpId: string, invoice: Invoice): LightningInvoiceObservation {
    return {
      status: "created", topUpId, serviceReference: invoice.payment_hash, invoice: invoice.invoice,
      invoiceIdentity: invoice.invoice, paymentHash: invoice.payment_hash, amount: String(invoice.amount / 1000), unit: "sat",
      expiresAt: new Date(invoice.expires_at * 1000).toISOString(), safeDisplayReference: `${this.prefix}:${invoice.payment_hash.slice(0, 12)}`,
    };
  }
}
