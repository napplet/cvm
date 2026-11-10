import { type Principal } from "../phase-03/contracts";
import { FundingService } from "./funding-service";
import { CashuMintPolicyRegistry, type CashuMintPolicy } from "./cashu-mint-policy";
import { type CashuSettlementPort, type CashuTreasuryState } from "./cashu-provider";
import type { VerifiedCreditWakeDispatcher } from "../continuity/continuation-service";
export type CashuTopUpState = "verifying" | "credited" | "failed" | "reconciliation_pending";
export type CashuTopUpResult = Readonly<{
    topUpId: string;
    state: CashuTopUpState;
    policyVersion: string;
    commitment: string;
    amount?: string;
    grossAmount?: string;
    feeAmount?: string;
    settlementReference?: string;
    treasuryState?: CashuTreasuryState;
}>;
type Vault = Readonly<{
    seal(metadata: {
        accountId: string;
        topUpId: string;
        rail: "cashu";
    }, plaintext: Uint8Array): Promise<{
        id: string;
        payloadDigest: string;
    }>;
    expire(id: string): Promise<void>;
    open?(request: {
        id: string;
        accountId: string;
        topUpId: string;
        rail: "cashu";
    }): Promise<Uint8Array>;
}>;
export type CashuCustodyJournal = Readonly<{
    operationId: string;
    mintUrl: string;
    keysetId: string;
    unit: "sat";
    amount: string;
    maxFee: string;
    inputFeePpk: number;
    feeAmount: string;
    expectedOutputAmount: string;
    inputProtectedId: string;
    outputDataProtectedId: string;
    outputDataDigest: string;
    state: "prepared" | "dispatching" | "owned_outputs";
    ownedOutputsProtectedId?: string;
    ownedOutputsDigest?: string;
}>;
export type CashuTopUpRecord = Readonly<{
    result: CashuTopUpResult;
    accountId: string;
    policy: CashuMintPolicy;
    protectedId: string;
    semanticProofIdentities: readonly string[];
    idempotencyKey: string;
    principal: Principal;
    amount: string;
    maxFee: string;
    createdAt: string;
    custody?: CashuCustodyJournal;
}>;
export interface CashuTopUpRepository {
    /** Durable uniqueness claim before any bearer is sealed or provider effect starts. */
    claim(input: CashuTopUpRecord): Promise<Readonly<{
        claimed: boolean;
        record: CashuTopUpRecord;
    }>>;
    find(topUpId: string): Promise<CashuTopUpRecord | undefined>;
    update(record: CashuTopUpRecord): Promise<void>;
    /** Row-locked, monotonic lifecycle projection update. */
    updateResult(topUpId: string, result: CashuTopUpResult): Promise<CashuTopUpRecord>;
    /** Persist-before-effect custody journal and a durable single-dispatch fence. */
    prepareCustody(topUpId: string, journal: Omit<CashuCustodyJournal, "state">): Promise<CashuCustodyJournal>;
    claimCustodyDispatch(topUpId: string): Promise<boolean>;
    recordOwnedCustodyOutputs(topUpId: string, protectedId: string, payloadDigest: string): Promise<Readonly<{
        accepted: boolean;
        protectedId: string;
    }>>;
    custody(topUpId: string): Promise<CashuCustodyJournal | undefined>;
    findTreasury(topUpId: string): Promise<CashuTopUpResult | undefined>;
    recordTreasury(topUpId: string, result: CashuTopUpResult): Promise<void>;
}
/** Test-only repository. Production composition must provide a PostgreSQL-backed implementation. */
export declare class InMemoryCashuTopUpRepository implements CashuTopUpRepository {
    #private;
    claim(input: CashuTopUpRecord): Promise<Readonly<{
        claimed: boolean;
        record: CashuTopUpRecord;
    }>>;
    find(topUpId: string): Promise<CashuTopUpRecord | undefined>;
    update(record: CashuTopUpRecord): Promise<void>;
    updateResult(topUpId: string, result: CashuTopUpResult): Promise<CashuTopUpRecord>;
    prepareCustody(topUpId: string, journal: Omit<CashuCustodyJournal, "state">): Promise<CashuCustodyJournal>;
    claimCustodyDispatch(topUpId: string): Promise<boolean>;
    recordOwnedCustodyOutputs(topUpId: string, protectedId: string, payloadDigest: string): Promise<Readonly<{
        accepted: boolean;
        protectedId: string;
    }>>;
    custody(topUpId: string): Promise<CashuCustodyJournal | undefined>;
    findTreasury(topUpId: string): Promise<CashuTopUpResult | undefined>;
    recordTreasury(topUpId: string, result: CashuTopUpResult): Promise<void>;
}
/** Coordinates protected bearer material, adapter observations, and the sole credit authority. */
export declare class CashuTopUpCoordinator {
    #private;
    private readonly options;
    constructor(options: Readonly<{
        policies: CashuMintPolicyRegistry;
        provider: CashuSettlementPort;
        vault: Vault;
        funding: FundingService;
        repository: CashuTopUpRepository;
        verifiedCreditWake?: VerifiedCreditWakeDispatcher;
        now?: () => string;
        providerTimeoutMs?: number;
    }>);
    prepare(input: unknown): Promise<CashuTopUpResult>;
    submit(input: unknown): Promise<CashuTopUpResult>;
    reconcile(topUpId: string): Promise<CashuTopUpResult>;
    reconcileTreasury(topUpId: string): Promise<CashuTopUpResult>;
}
export {};
