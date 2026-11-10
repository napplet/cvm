import { nip47 } from "nostr-tools";
import type { LightningCreateInvoiceRequest, LightningInvoiceObservation, LightningQueryInvoiceRequest, LightningReceiptPort } from "../funding/lightning-provider";
/**
 * Which wallet relays a NIP-47 connection may use. Development and the test
 * realm may use a private plaintext relay; the real-money realm requires TLS.
 */
export type NwcRelayPolicy = "loopback" | "private-test" | "tls";
export declare function assertNwcConnection(uri: string, policy: NwcRelayPolicy): ReturnType<typeof nip47.parseConnectionString>;
/** Real encrypted NIP-47 request. The wallet's signed response authenticates it. */
export declare function nwcRequest(uri: string, method: string, params?: Record<string, unknown>, callerSignal?: AbortSignal, policy?: NwcRelayPolicy): Promise<any>;
/**
 * Receive-only NIP-47 wallet port: `make_invoice` and `lookup_invoice`. The
 * service never asks this wallet to pay. Settlement is accepted only from the
 * wallet's signed `lookup_invoice` result for the original payment hash.
 */
export declare class NwcInvoiceReceiver implements LightningReceiptPort {
    private readonly uri;
    private readonly options;
    constructor(uri: string, options?: Readonly<{
        policy?: NwcRelayPolicy;
        referencePrefix?: string;
    }>);
    private get prefix();
    private request;
    createInvoice(request: LightningCreateInvoiceRequest): Promise<LightningInvoiceObservation>;
    queryInvoice(request: LightningQueryInvoiceRequest): Promise<LightningInvoiceObservation>;
    private created;
}
