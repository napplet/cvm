import type { AccountTopUpStatusPort } from "../funding/account-status";
import { type AccountingRealm, type AccountingRealmName } from "../funding/accounting-realm";
import type { CashuTopUpRepository } from "../funding/cashu-top-up";
import type { LightningTopUpRepository } from "../funding/lightning-top-up";
import type { ProtectedRailMaterialRepository } from "../funding/protected-rail-material";
import { PostgresSqlFundingStore, type PostgresSqlPool, type PostgresSqlStoreOptions } from "./postgres-sql-funding-store";
import type { ContinuationFundingStore, MeteredFundingStore } from "./funding-store";
export type ProductionCustodyMaterial = Readonly<{
    custodyId: string;
    operationId: string;
    accountId: string;
    rail: "cashu" | "lightning";
    materialKind: "cashu_input" | "cashu_blinded_message" | "cashu_output" | "lightning_intent";
    keyReference: string;
    payloadDigest: string;
    nonce: Uint8Array;
    ciphertext: Uint8Array;
    canonicalProofIdentity?: string;
    mintUrl?: string;
    keysetId?: string;
    unit?: "sat";
}>;
export interface ProductionCustodyRepository {
    put(record: ProductionCustodyMaterial): Promise<void>;
    get(custodyId: string): Promise<ProductionCustodyMaterial | undefined>;
}
export type UncertainRailOperation = Readonly<{
    operationId: string;
    accountId: string;
    rail: "cashu" | "lightning";
    providerLocator: string;
    stableLabel?: string;
    state: "created" | "dispatching" | "unknown" | "observed_pending" | "observed_succeeded" | "observed_failed";
}>;
export interface UncertainRailOperationRepository {
    createOrReplay(operation: UncertainRailOperation): Promise<Readonly<{
        operation: UncertainRailOperation;
        created: boolean;
    }>>;
    transition(operationId: string, state: UncertainRailOperation["state"]): Promise<UncertainRailOperation>;
    get(operationId: string): Promise<UncertainRailOperation | undefined>;
}
/**
 * Sole SQL owner for Phase 3. Callers receive capability-specific ports and can
 * neither issue arbitrary queries nor pass database credentials into rail code.
 */
export declare class PostgresFundingDatabase {
    readonly realm: AccountingRealm;
    readonly funding: PostgresSqlFundingStore;
    /** Alias of `funding`, not a second billing/session capability or connection. */
    readonly meteredFunding: MeteredFundingStore;
    /** Alias of `funding`; continuation state never receives a second authority. */
    readonly continuationFunding: ContinuationFundingStore;
    readonly lightning: LightningTopUpRepository;
    readonly cashu: CashuTopUpRepository;
    readonly protectedMaterials: ProtectedRailMaterialRepository;
    readonly railStatuses: AccountTopUpStatusPort;
    readonly custody: ProductionCustodyRepository;
    readonly uncertainRailOperations: UncertainRailOperationRepository;
    constructor(pool: PostgresSqlPool, options?: PostgresSqlStoreOptions & Readonly<{
        realm?: AccountingRealmName;
    }>);
}
