import { z } from "zod";
import type { LightningReceiptPort } from "../../funding/lightning-provider";
import { type BeginLightningTopUpInput, type LightningTopUpCoordinator, type LightningTopUpResult } from "../../funding/lightning-top-up";
declare const ReceiptSchema: z.ZodObject<{
    originalOperationId: z.ZodString;
    requestSha256: z.ZodString;
}, z.core.$strict>;
declare const ConfigSchema: z.ZodObject<{
    endpointReference: z.ZodString;
    endpointSha256: z.ZodString;
    accountReference: z.ZodString;
    accountSha256: z.ZodString;
}, z.core.$strict>;
export type NativeCep8LightningConfig = Readonly<z.infer<typeof ConfigSchema>>;
export type NativeCep8PaymentReceipt = Readonly<z.infer<typeof ReceiptSchema>>;
export type NativeCep8LightningProvider = Readonly<{
    discovery(): NativeCep8LightningConfig;
    beginAfterReceipt(input: Readonly<{
        receipt: NativeCep8PaymentReceipt;
        input: BeginLightningTopUpInput;
    }>): Promise<LightningTopUpResult>;
    reconcileOriginal(input: Readonly<{
        principal: BeginLightningTopUpInput["principal"];
        topUpId: string;
    }>): Promise<LightningTopUpResult>;
    verifiedSettlementCount(): number;
}>;
export declare function createNativeCep8LightningProvider(input: Readonly<{
    config: unknown;
    receiver: LightningReceiptPort;
    coordinator: LightningTopUpCoordinator;
}>): NativeCep8LightningProvider;
export {};
