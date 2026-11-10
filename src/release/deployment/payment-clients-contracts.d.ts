import type { AuthenticatedNwcInvoiceTransport } from "../../funding/nwc-receipt-port";
import { PostgresOperationJournal } from "./postgres-operation-journal";
/** Runtime material is resolved only by a broker-held NWC session. The
 * descriptor never accepts connection strings, tokens, proof bytes, or keys. */
export type ProductionNwcTransport = AuthenticatedNwcInvoiceTransport & Readonly<{
    journal: PostgresOperationJournal;
}>;
/** Reference-only NWC and funded-Cashu rails. Consent, wallet access, and
 * settlement dispatch remain injected operational steps after authorization. */
export declare function createPaymentDeploymentClients(input: Readonly<{
    nwcConnectionReference: unknown;
    cashuWalletReference: unknown;
    nwcTransport?: ProductionNwcTransport;
}>): Readonly<{
    nwcTransport?: ProductionNwcTransport | undefined;
    nwc: Readonly<{
        discovery: () => Readonly<{
            rail: "cashu" | "nwc_lightning";
            consentReference: string;
        }>;
        reconcileOriginal(input: Readonly<{
            originalOperationId: unknown;
            receiptOperationId: unknown;
        }>): Promise<Readonly<{
            status: "reconciled";
            originalOperationId: string;
        }> | Readonly<{
            status: "blocked";
            originalOperationId: string;
        }>>;
    }>;
    cashu: Readonly<{
        discovery: () => Readonly<{
            rail: "cashu" | "nwc_lightning";
            consentReference: string;
        }>;
        reconcileOriginal(input: Readonly<{
            originalOperationId: unknown;
            receiptOperationId: unknown;
        }>): Promise<Readonly<{
            status: "reconciled";
            originalOperationId: string;
        }> | Readonly<{
            status: "blocked";
            originalOperationId: string;
        }>>;
    }>;
}>;
