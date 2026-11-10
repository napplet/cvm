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
/** NIP-47 / NWC-05 receipt mapping. Never holds a ledger or reissues a create.
 * https://github.com/nostr-protocol/nips/blob/master/47.md
 * https://github.com/nostr-wallet-connect/nwc/blob/main/05.md
 */
export declare class NwcLightningReceiptPort implements LightningReceiptPort {
    private readonly transport;
    private readonly now;
    readonly accountingRealm: "production-real";
    readonly connectionScopeDigest: string;
    constructor(transport: AuthenticatedNwcInvoiceTransport, now?: () => number);
    createInvoice(request: LightningCreateInvoiceRequest): Promise<LightningInvoiceObservation>;
    queryOriginalIntent(request: Readonly<{
        topUpId: string;
        intent: LightningOriginalIntent;
        signal: AbortSignal;
    }>): Promise<LightningInvoiceObservation>;
    queryInvoice(request: LightningQueryInvoiceRequest): Promise<LightningInvoiceObservation>;
    private permitted;
    private matchesIntent;
    private matchesInvoice;
    private created;
}
