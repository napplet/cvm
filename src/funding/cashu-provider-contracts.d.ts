import { getDecodedToken, type RequestFn } from "@cashu/cashu-ts";
import { z } from "zod";
import { type CashuMintPolicy } from "./cashu-mint-policy";
export declare const CashuSettlementObservationSchema: z.ZodDiscriminatedUnion<[z.ZodObject<{
    status: z.ZodLiteral<"verified">;
    externalReference: z.ZodString;
    settlementReference: z.ZodString;
    verifiedAt: z.ZodISODateTime;
    amounts: z.ZodOptional<z.ZodObject<{
        grossAmount: z.ZodString;
        feeAmount: z.ZodString;
        netAmount: z.ZodString;
    }, z.core.$strict>>;
}, z.core.$strict>, z.ZodObject<{
    status: z.ZodLiteral<"failed">;
    code: z.ZodEnum<{
        untrusted_mint: "untrusted_mint";
        wrong_unit: "wrong_unit";
        wrong_amount: "wrong_amount";
        inactive_keyset: "inactive_keyset";
        invalid_dleq: "invalid_dleq";
        unsupported_condition: "unsupported_condition";
        duplicate_proof: "duplicate_proof";
        malformed: "malformed";
        swap_failed: "swap_failed";
    }>;
}, z.core.$strict>, z.ZodObject<{
    status: z.ZodLiteral<"unknown">;
    operationReference: z.ZodString;
}, z.core.$strict>], "status">;
export type CashuSettlementObservation = z.infer<typeof CashuSettlementObservationSchema>;
export type CashuSwapAmounts = Readonly<{
    grossAmount: string;
    feeAmount: string;
    netAmount: string;
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
    state: "prepared" | "dispatching" | "owned_outputs";
    ownedOutputsProtectedId?: string;
}>;
/**
 * Coordinator-provided narrow persistence port.  It intentionally accepts only
 * opaque JSON-safe output data and is the sole bridge from cashu-ts secrets to
 * encrypted durable custody.  The adapter has no SQL/funding authority.
 */
export interface CashuTreasuryCustody {
    prepare(input: Readonly<{
        operationId: string;
        mintUrl: string;
        keysetId: string;
        grossAmount: string;
        maxFee: string;
        inputFeePpk: number;
        feeAmount: string;
        expectedOutputAmount: string;
        outputData: readonly unknown[];
    }>): Promise<CashuCustodyJournal>;
    claimDispatch(): Promise<boolean>;
    recordOwnedOutputs(outputs: readonly unknown[]): Promise<void>;
    load(): Promise<Readonly<{
        journal: CashuCustodyJournal;
        outputData?: Uint8Array;
        outputs?: Uint8Array;
    }> | undefined>;
}
export type CashuSettlementRequest = Readonly<{
    topUpId: string;
    accountId?: string;
    policy: CashuMintPolicy;
    amount: string;
    maxFee: string;
    commitment: string;
    token: Uint8Array;
    custody?: CashuTreasuryCustody;
    signal: AbortSignal;
}>;
export type CashuObserveRequest = Readonly<{
    topUpId: string;
    accountId?: string;
    policy: CashuMintPolicy;
    commitment: string;
    amount: string;
    maxFee: string;
    token?: Uint8Array;
    custody?: CashuTreasuryCustody;
    signal: AbortSignal;
}>;
export type CashuProofIdentity = Readonly<{
    status: "accepted";
    semanticProofIdentities: readonly string[];
}> | Extract<CashuSettlementObservation, {
    status: "failed";
}>;
export type CashuTreasuryState = "held_at_trusted_mint" | "melted_settled" | "failed" | "unknown";
/** Adapter-only port. Its normalized observations have no access to funding or ledger authority. */
export interface CashuSettlementPort {
    /** Validates parsed bearer facts before any durable claim or mint effect. */
    identify(request: Omit<CashuSettlementRequest, "topUpId" | "commitment" | "signal">): Promise<CashuProofIdentity>;
    settle(request: CashuSettlementRequest): Promise<CashuSettlementObservation>;
    observe(request: CashuObserveRequest): Promise<CashuSettlementObservation>;
    reconcileTreasury(input: Readonly<{
        topUpId: string;
        commitment: string;
        signal: AbortSignal;
    }>): Promise<Readonly<{
        state: CashuTreasuryState;
    }>>;
    /** True only for the default cashu-ts bridge with persist-before-swap recovery. */
    readonly productionSafe?: boolean;
    /** The same persisted-swap transport used by the production settlement
     * adapter. It is absent from fixtures and never accepts a caller callback. */
    readonly walletOperations?: CashuWalletOperations;
}
type DecodedToken = ReturnType<typeof getDecodedToken>;
type AllowedMint = CashuMintPolicy["mints"][number];
type CashuWalletOperationInput = Readonly<{
    topUpId: string;
    decoded: DecodedToken;
    mint: AllowedMint;
    keysetId: string;
    amount: string;
    maxFee: string;
    custody?: CashuTreasuryCustody;
    signal: AbortSignal;
}>;
export interface CashuWalletOperations {
    /** Void is legacy fake compatibility; production default always returns facts. */
    settle(input: CashuWalletOperationInput): Promise<CashuSwapAmounts | void>;
    observe(input: CashuWalletOperationInput): Promise<"spent" | "pending" | "unspent" | "mixed">;
    /** Optional because deterministic legacy fakes intentionally cannot claim recovery ownership. */
    recover?(input: CashuWalletOperationInput): Promise<CashuSwapAmounts | false>;
}
/**
 * The only Cashu library bridge. It validates decoded proof facts against a pinned
 * policy, loads the selected mint, then requires a live receive/swap before value
 * is reported as verified. It intentionally never exposes proofs or cashu-ts DTOs.
 */
export declare class CashuTsSettlementAdapter implements CashuSettlementPort {
    #private;
    readonly productionSafe: boolean;
    constructor(options?: Readonly<{
        operations?: CashuWalletOperations;
        request?: RequestFn;
        now?: () => string;
    }>);
    get walletOperations(): CashuWalletOperations;
    identify(request: Omit<CashuSettlementRequest, "topUpId" | "commitment" | "signal">): Promise<CashuProofIdentity>;
    settle(request: CashuSettlementRequest): Promise<CashuSettlementObservation>;
    observe(request: CashuObserveRequest): Promise<CashuSettlementObservation>;
    reconcileTreasury(): Promise<Readonly<{
        state: CashuTreasuryState;
    }>>;
}
/** Deterministic test adapter: it returns observations only and cannot credit accounts. */
export declare class FakeCashuSettlementPort implements CashuSettlementPort {
    #private;
    readonly productionSafe = false;
    settleCalls: number;
    observeCalls: number;
    treasuryCalls: number;
    requests: Omit<CashuSettlementRequest, "signal">[];
    nextSettlement(value: CashuSettlementObservation): void;
    nextObservation(value: CashuSettlementObservation): void;
    nextTreasury(value: Readonly<{
        state: CashuTreasuryState;
    }>): void;
    effectThenThrowOnce(value: CashuSettlementObservation): void;
    identify(request: Omit<CashuSettlementRequest, "topUpId" | "commitment" | "signal">): Promise<CashuProofIdentity>;
    settle(request: CashuSettlementRequest): Promise<CashuSettlementObservation>;
    observe(request: CashuObserveRequest): Promise<CashuSettlementObservation>;
    reconcileTreasury(): Promise<Readonly<{
        state: CashuTreasuryState;
    }>>;
}
export {};
