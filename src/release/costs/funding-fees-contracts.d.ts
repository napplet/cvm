import type { UsdSatConversion } from "../../model/price-card";
type FeeFact = Readonly<{
    provider: "cep8_lightning" | "cashu";
    sourceId: string;
    sourceDocumentSha256: string;
    quoteSha256: string;
    currency: "USD";
    unit: "operation";
    priceMicros: number;
    observedAtMs: number;
    freshUntilMs: number;
}>;
export type SealedFundingFeePolicyProjection = Readonly<{
    observedAtMs: number;
    freshUntilMs: number;
    nwc: Readonly<{
        maximumReceiverFeeSats: string;
        policySha256: string;
    }>;
    cashu: Readonly<{
        maximumProofs: number;
        mints: readonly Readonly<{
            url: string;
            keysetIds: readonly string[];
        }>[];
    }>;
}>;
/** Builds fee facts from an already sealed controller projection. It never
 * chooses a mint or wallet; no projection means consent is genuinely absent. */
export declare function createOfficialFundingRailFeePort(input: Readonly<{
    policy: SealedFundingFeePolicyProjection;
    readUsdSatConversion(): Promise<UsdSatConversion>;
    fetch?: typeof fetch;
    now?: () => number;
}>): Readonly<{
    readFeeFacts(): Promise<readonly FeeFact[]>;
}>;
export {};
