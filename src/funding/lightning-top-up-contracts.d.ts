import { type FundingResult, type Principal } from "../phase-03/contracts";
import type { FundingService } from "./funding-service";
import { type LightningReceiptPort, type LightningOriginalIntent } from "./lightning-provider";
import type { ProtectedRailMaterialVault } from "./protected-rail-material";
import type { VerifiedCreditWakeDispatcher } from "../continuity/continuation-service";
type TopUpState = "pending" | "settled" | "credited" | "failed" | "reconciliation_pending";
export type LightningTopUpStatus = Readonly<{
    topUpId: string;
    rail: "lightning";
    state: TopUpState;
    amount: string;
    unit: "sat";
    createdAt: string;
    safeDisplayReference?: string;
    expiresAt?: string;
    settlementReference?: string;
}>;
export type LightningTopUpResult = Readonly<{
    status: "payment_required" | "reconciliation_pending" | "failed" | "credited";
    topUpId: string;
    rail: "lightning";
    state: TopUpState;
    amount: string;
    unit: "sat";
    safeDisplayReference?: string;
    expiresAt?: string;
    settlementReference?: string;
}>;
export type BeginLightningTopUpInput = Readonly<{
    principal: Principal;
    idempotencyKey: string;
    amount: string;
    unit: "sat";
    policyVersion: string;
    protocolVersion: string;
}>;
export type LightningPrivateTopUp = LightningTopUpStatus & Readonly<{
    accountId: string;
    principal: Principal;
    commandFingerprint: string;
    commandKey: string;
    providerIntent: "created" | "completed" | "uncertain";
    providerReference: string;
    invoiceIdentityDigest?: string;
    paymentHashDigest?: string;
    protectedMaterialId?: string;
    protectedPayloadDigest?: string;
    creditedResult?: FundingResult;
    originalIntent?: LightningOriginalIntent;
}>;
export type LightningTopUpState = {
    topUps: Map<string, LightningPrivateTopUp>;
    commands: Map<string, {
        fingerprint: string;
        topUpId: string;
    }>;
};
export interface LightningTopUpRepository {
    transact<T>(operation: (state: LightningTopUpState) => Promise<T> | T): Promise<T>;
    snapshot?(): readonly LightningTopUpStatus[];
}
/** Deterministic test double; production composition must inject a durable rail repository. */
export declare class InMemoryLightningTopUpRepository implements LightningTopUpRepository {
    #private;
    transact<T>(operation: (state: LightningTopUpState) => Promise<T> | T): Promise<T>;
    snapshot(): readonly LightningTopUpStatus[];
}
export type LightningTopUpCoordinatorOptions = Readonly<{
    funding: FundingService;
    receiver: LightningReceiptPort;
    repository: LightningTopUpRepository;
    vault: ProtectedRailMaterialVault;
    verifiedCreditWake?: VerifiedCreditWakeDispatcher;
    now?: () => string;
    providerTimeoutMs?: number;
}>;
/** Service-owned BOLT11 coordinator: receiver observations never receive ledger authority. */
export declare class LightningTopUpCoordinator {
    #private;
    private readonly options;
    constructor(options: LightningTopUpCoordinatorOptions);
    begin(input: unknown): Promise<LightningTopUpResult>;
    /**
     * The BOLT11 payment request for the owner's own pending top-up, so the
     * payer can actually pay it. Invoices are payment requests, not bearer
     * secrets, but they are still released only to the verified principal and
     * never stored in public projections or logs.
     */
    paymentRequest(input: Readonly<{
        principal: Principal;
        topUpId: string;
    }>): Promise<string | undefined>;
    reconcile(input: Readonly<{
        principal: Principal;
        topUpId: string;
    }>): Promise<LightningTopUpResult>;
    observeSettlement(input: Readonly<{
        principal: Principal;
        topUpId: string;
    }>): Promise<LightningTopUpResult>;
    private reconcileRecord;
    private recordObservation;
    private recordCreated;
    private recordSettled;
    private markUnknown;
    private boundedProvider;
    private topUp;
    private assertObservationTarget;
    private parseBegin;
    private fingerprint;
}
export {};
