import type { NostrSigner } from "@contextvm/sdk/core";
import type { AuthenticatedNwcInvoiceTransport } from "../../funding/nwc-receipt-port";
import { PostgresOperationJournal } from "./postgres-operation-journal";
export type NwcSigningBroker = Readonly<{
    openNwcConnection(input: Readonly<{
        reference: string;
        purpose: "nwc_lightning_receipts";
    }>): Promise<Readonly<{
        connectionScopeDigest: string;
        walletPubkey: string;
        relays: readonly string[];
        consentedMethods: readonly string[];
        signer: NostrSigner;
    }>>;
}>;
/** Deployment credential authority (Keychain/HSM/secret-manager backed).
 * It returns a narrowly-scoped NIP-44 signing capability, never a connection
 * URI, nsec, or exported key bytes. This is the production composition seam;
 * `NwcSigningBroker` remains the normalized transport-facing shape. */
export type NwcCredentialBroker = Readonly<{
    resolveNwcLightningCapability(input: Readonly<{
        reference: string;
        purpose: "nwc_lightning_receipts";
    }>): Promise<Readonly<{
        connectionScopeDigest: string;
        walletPubkey: string;
        relays: readonly string[];
        consentedMethods: readonly string[];
        signer: NostrSigner;
    }>>;
}>;
export declare function createNwcCredentialSigningBroker(input: Readonly<{
    credentials: NwcCredentialBroker;
}>): NwcSigningBroker;
/** NIP-47 transport using an authority-held NIP-44 signer. The connection
 * secret is never materialized in application memory: the broker exposes only
 * signing/encryption operations. Original signed request identity is stored in
 * PostgreSQL before publication; uncertainty observes `#e`, never republishes. */
export declare function openSignedNwcTransport(input: Readonly<{
    connectionReference: string;
    broker: NwcSigningBroker;
    journal: PostgresOperationJournal;
}>): Promise<AuthenticatedNwcInvoiceTransport & Readonly<{
    journal: PostgresOperationJournal;
    close(): Promise<void>;
}>>;
