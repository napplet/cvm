export declare const OPENAI_PRICING_MARKDOWN = "https://developers.openai.com/api/docs/pricing.md";
type Rate = {
    numerator: string;
    denominator: string;
};
type Prices = {
    inputUsdPerMillion: string;
    outputUsdPerMillion: string;
};
type AdminClient = {
    callTool(tool: "cvm_admin", args: Record<string, unknown>): Promise<any>;
};
/** Fail closed if OpenAI changes the Standard table or publishes two matching rows. */
export declare function extractStandardPrices(markdown: string, model: string): Prices;
/** USD / million tokens × 100,000,000 sats/BTC ÷ USD/BTC. */
export declare function satsPerToken(usdPerMillion: string, usdPerBtc: string): Rate;
/** Uses only signed CVM admin calls to read the OAuth catalog, quote and synthetic rates. */
export declare function syncDevelopmentRates(client: AdminClient, options?: {
    dryRun?: boolean;
    fetcher?: typeof fetch;
    now?: () => number;
}): Promise<{
    result: string;
    modelCount: number;
    updatedCount: number;
    basis: string;
    source: {
        url: string;
        sha256: string;
    };
    conversion: {
        source: "Kraken";
        usdPerBtc: string;
        fetchedAt: string;
    };
    models: {
        model: string;
        change: string;
        input: {
            usdPerMillionTokens: string;
            testSatsPerThousandTokens: string;
        };
        output: {
            usdPerMillionTokens: string;
            testSatsPerThousandTokens: string;
        };
    }[];
} | {
    activePriceCardId: any;
    result: string;
    modelCount: number;
    updatedCount: number;
    basis: string;
    source: {
        url: string;
        sha256: string;
    };
    conversion: {
        source: "Kraken";
        usdPerBtc: string;
        fetchedAt: string;
    };
    models: {
        model: string;
        change: string;
        input: {
            usdPerMillionTokens: string;
            testSatsPerThousandTokens: string;
        };
        output: {
            usdPerMillionTokens: string;
            testSatsPerThousandTokens: string;
        };
    }[];
}>;
export {};
