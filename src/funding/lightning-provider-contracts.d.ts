import { z } from "zod";
export declare const LightningInvoiceObservationSchema: z.ZodDiscriminatedUnion<[z.ZodObject<{
    status: z.ZodLiteral<"created">;
    topUpId: z.ZodOptional<z.ZodString>;
    serviceReference: z.ZodString;
    invoice: z.ZodString;
    invoiceIdentity: z.ZodString;
    paymentHash: z.ZodString;
    amount: z.ZodString;
    unit: z.ZodLiteral<"sat">;
    expiresAt: z.ZodISODateTime;
    safeDisplayReference: z.ZodString;
}, z.core.$strict>, z.ZodObject<{
    status: z.ZodLiteral<"settled">;
    topUpId: z.ZodString;
    serviceReference: z.ZodString;
    invoiceIdentity: z.ZodString;
    paymentHash: z.ZodString;
    amount: z.ZodString;
    unit: z.ZodLiteral<"sat">;
    expiresAt: z.ZodISODateTime;
    settledAt: z.ZodISODateTime;
    final: z.ZodLiteral<true>;
    settlementReference: z.ZodString;
    receiverAuthenticated: z.ZodLiteral<true>;
}, z.core.$strict>, z.ZodObject<{
    status: z.ZodLiteral<"failed">;
    topUpId: z.ZodString;
    serviceReference: z.ZodString;
    reason: z.ZodEnum<{
        expired: "expired";
        cancelled: "cancelled";
        reversed: "reversed";
        rejected: "rejected";
    }>;
}, z.core.$strict>, z.ZodObject<{
    status: z.ZodLiteral<"unknown">;
    topUpId: z.ZodString;
    serviceReference: z.ZodString;
}, z.core.$strict>], "status">;
export type LightningInvoiceObservation = z.infer<typeof LightningInvoiceObservationSchema>;
export type LightningOriginalIntent = Readonly<{
    operationId: string;
    realm: "development-test" | "production-real";
    descriptionHash: string;
    connectionScopeDigest: string;
    amount: string;
    type: "incoming";
    from: number;
    until: number;
}>;
export type LightningCreateInvoiceRequest = Readonly<{
    topUpId: string;
    idempotencyLabel: string;
    amount: string;
    unit: "sat";
    originalIntent?: LightningOriginalIntent;
    signal: AbortSignal;
}>;
export type LightningQueryInvoiceRequest = Readonly<{
    topUpId: string;
    serviceReference: string;
    signal: AbortSignal;
}>;
/** Rail adapter boundary: it returns receiver observations and has no funding/ledger dependency. */
export interface LightningReceiptPort {
    readonly connectionScopeDigest?: string;
    readonly accountingRealm?: "development-test" | "production-real";
    createInvoice(request: LightningCreateInvoiceRequest): Promise<LightningInvoiceObservation>;
    queryInvoice(request: LightningQueryInvoiceRequest): Promise<LightningInvoiceObservation>;
    queryOriginalIntent?(request: Readonly<{
        topUpId: string;
        intent: LightningOriginalIntent;
        signal: AbortSignal;
    }>): Promise<LightningInvoiceObservation>;
}
type FakeOptions = Readonly<{
    create: Extract<LightningInvoiceObservation, {
        status: "created";
    }>;
}>;
/** Deterministic receiver fake. It intentionally exposes only opaque receiver observations. */
export declare class FakeLightningReceiptPort implements LightningReceiptPort {
    #private;
    createCalls: number;
    queryCalls: number;
    createMode: "created" | "fail_before_effect" | "effect_then_throw";
    queryMode: "created" | "settled" | "failed" | "unknown";
    queryObservation?: LightningInvoiceObservation;
    constructor(options: FakeOptions);
    createInvoice(request: LightningCreateInvoiceRequest): Promise<LightningInvoiceObservation>;
    queryInvoice(request: LightningQueryInvoiceRequest): Promise<LightningInvoiceObservation>;
    private created;
}
export {};
