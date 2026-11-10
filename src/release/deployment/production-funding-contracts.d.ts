import { CashuMintPolicyRegistry } from "../../funding/cashu-mint-policy";
import { NwcLightningReceiptPort } from "../../funding/nwc-receipt-port";
import type { ReadyCapacityPort } from "../../funding/funded-admission";
import { type FundedCore, type FundedCoreOptions } from "../../phase-03/funded-core";
import { PostgresFundingDatabase } from "../../persistence/postgres-funding-database";
import type { PostgresSqlPool } from "../../persistence/postgres-sql-funding-store";
import type { MeteredArtifactLineage } from "../../persistence/funding-store";
import type { ContextVmTransportPort } from "../../contextvm/sdk-bridge";
import type { ProductionNwcTransport } from "./payment-clients";
import { type NwcCredentialBroker } from "./signed-nwc-transport";
import { type UsdSatConversion } from "../../model/price-card";
import { createOfficialPricingSources } from "../costs/official-sources";
import type { SealedFundingFeePolicyProjection } from "../costs/funding-fees";
import type { VertexProviderReceipt } from "./vertex-client";
import { type PostgresOperationJournal } from "./postgres-operation-journal";
import type { ContinuationService } from "../../continuity/continuation-service";
/** The production composition accepts only bounded project-owned ports. It has
 * no faucet, FakeWallet, test realm, fixture model, or synthetic billing path. */
export type ProductionFundingInput = Readonly<{
    postgresPool: PostgresSqlPool;
    transport: ContextVmTransportPort;
    nwcTransport: ProductionNwcTransport;
    nwcReceipt: NwcLightningReceiptPort;
    cashuPolicies: CashuMintPolicyRegistry;
    capacity: ReadyCapacityPort;
    protectedMaterialKey: Uint8Array;
    admissionReceiptSecret: Uint8Array;
    statusCursorSecret: Uint8Array;
    accountingConfiguration: unknown;
    meteredService?: NonNullable<FundedCoreOptions["meteredService"]>;
    continuationService?: Pick<ContinuationService, "resumeSession">;
    pricedContinuation?: FundedCoreOptions["pricedContinuation"];
}>;
export declare function createSealedFundingFeePolicyProjection(input: Readonly<{
    cashuPolicies: CashuMintPolicyRegistry;
    maximumCashuProofs: number;
    nwc: Readonly<{
        maximumReceiverFeeSats: string;
        policySha256: string;
    }>;
    observedAtMs?: number;
    freshnessMs?: number;
}>): SealedFundingFeePolicyProjection;
/** Real SQL-backed action finalization. The selected action is located by its
 * durable original operation and the same metered transaction both checks the
 * reservation/cap and posts its terminal debit. Unknown/pending results have
 * no receipt type and therefore cannot call this function. */
/** The worker/build outcome, not the model receipt, owns session terminal
 * state. A successful inference may still produce a failed build; only a
 * verified artifact may advance the session to completed. */
export type ProductionModelTerminal = Readonly<{
    status: "failed";
    result: unknown;
    sessionVersion: number;
    artifactVersion: number;
    artifact?: MeteredArtifactLineage;
}> | Readonly<{
    status: "completed";
    result: unknown;
    sessionVersion: number;
    artifactVersion: number;
    artifact: MeteredArtifactLineage & Readonly<{
        artifactId: string;
    }>;
}>;
export type ProductionVertexUsageSettlement = Readonly<{
    /** Call before reservation/dispatch; its output is the quote to bind into
     * the action's source-priced model card and maximum sat reservation. */
    prepare(input: Readonly<{
        accountId: string;
        operationId: string;
        at: string;
    }>): Promise<Readonly<{
        conversion: UsdSatConversion;
        acceptedAt: string;
    }>>;
    /** Settlement reloads the durable pre-dispatch binding. It never fetches or
     * substitutes a newer FX observation after provider work has happened. */
    finalize(input: Readonly<{
        accountId: string;
        receipt: VertexProviderReceipt;
        terminal: ProductionModelTerminal;
    }>): Promise<Readonly<{
        currency: "sat";
        amount: string;
    }>>;
}>;
export declare function finalizeProductionVertexUsage(input: Readonly<{
    database: PostgresFundingDatabase;
    accountId: string;
    receipt: VertexProviderReceipt;
    conversion: UsdSatConversion;
    at: string;
    terminal: ProductionModelTerminal;
}>): Promise<Readonly<{
    currency: "sat";
    amount: string;
}>>;
export declare function createProductionVertexUsageSettlement(input: Readonly<{
    database: PostgresFundingDatabase;
    sources: ReturnType<typeof createOfficialPricingSources>["sources"];
    journal: PostgresOperationJournal;
}>): ProductionVertexUsageSettlement;
/**
 * Builds the real-money ledger core without starting a relay, mint request, or
 * wallet action. Provider effects remain receipt/original-operation gated by
 * the coordinators constructed in `createFundedCore`.
 */
export declare function createProductionFunding(input: ProductionFundingInput): Readonly<{
    database: PostgresFundingDatabase;
    core: FundedCore;
}>;
/** Opens the project-owned NIP-47 rail from a broker reference, then composes
 * the production core.  It deliberately does not accept a relay, raw NWC URI,
 * or private key: the broker is the only authority able to use the connection
 * capability and the concrete journal is the only durable original-request
 * authority.  Network I/O starts only while opening the consented connection. */
export declare function openProductionFunding(input: Readonly<Omit<ProductionFundingInput, "nwcTransport" | "nwcReceipt"> & {
    nwcConnectionReference: string;
    nwcCredentialBroker: NwcCredentialBroker;
    nwcJournal: PostgresOperationJournal;
}>): Promise<Readonly<{
    database: PostgresFundingDatabase;
    core: FundedCore;
    close(): Promise<void>;
}>>;
