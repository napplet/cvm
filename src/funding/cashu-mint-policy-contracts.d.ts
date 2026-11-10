import { z } from "zod";
export declare const CashuMintPolicySchema: z.ZodObject<{
    version: z.ZodString;
    activeFrom: z.ZodISODateTime;
    activeUntil: z.ZodNullable<z.ZodISODateTime>;
    mints: z.ZodArray<z.ZodObject<{
        url: z.ZodString;
        unit: z.ZodDefault<z.ZodLiteral<"sat">>;
        keysetIds: z.ZodArray<z.ZodString>;
        maxInputFeePpk: z.ZodNumber;
        requireDleq: z.ZodBoolean;
        proofConditions: z.ZodDefault<z.ZodArray<z.ZodLiteral<"none">>>;
    }, z.core.$strict>>;
}, z.core.$strict>;
export type CashuMintPolicy = Readonly<z.infer<typeof CashuMintPolicySchema>>;
export declare function canonicalCashuMintUrl(value: string): string;
/** Immutable multi-mint policy history. Rotation only changes the active pointer. */
export declare class CashuMintPolicyRegistry {
    #private;
    constructor(initial: unknown);
    add(input: unknown): CashuMintPolicy;
    rotate(version: string): CashuMintPolicy;
    get(version: string): CashuMintPolicy;
    pinActive(): CashuMintPolicy;
}
