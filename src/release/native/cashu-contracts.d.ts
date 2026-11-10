import { z } from "zod";
import type { CashuSettlementPort, CashuWalletOperations } from "../../funding/cashu-provider";
import { type CashuTopUpCoordinator, type CashuTopUpResult } from "../../funding/cashu-top-up";
declare const ReceiptSchema: z.ZodObject<{
    originalOperationId: z.ZodString;
    requestSha256: z.ZodString;
}, z.core.$strict>;
declare const ConfigSchema: z.ZodObject<{
    mintPolicyReference: z.ZodString;
    mintPolicySha256: z.ZodString;
    accountReference: z.ZodString;
    accountSha256: z.ZodString;
}, z.core.$strict>;
export type NativeCashuConfig = Readonly<z.infer<typeof ConfigSchema>>;
export type NativeCashuPaymentReceipt = Readonly<z.infer<typeof ReceiptSchema>>;
export type NativeCashuProvider = Readonly<{
    discovery(): NativeCashuConfig;
    submitAfterReceipt(input: Readonly<{
        receipt: NativeCashuPaymentReceipt;
        input: unknown;
    }>): Promise<CashuTopUpResult>;
    reconcileOriginal(topUpId: string): Promise<CashuTopUpResult>;
    verifiedSettlementCount(): number;
}>;
export declare function createNativeCashuProvider(input: Readonly<{
    config: unknown;
    settlement: CashuSettlementPort;
    walletOperations: CashuWalletOperations;
    coordinator: CashuTopUpCoordinator;
}>): NativeCashuProvider;
export {};
