import { legacyPaymentModule } from "../payments/legacy-module";
export type * from "./openai-price-sync-contracts";
export const { OPENAI_PRICING_MARKDOWN, extractStandardPrices, satsPerToken, syncDevelopmentRates } = await legacyPaymentModule("src/dev/openai-price-sync.ts", ["OPENAI_PRICING_MARKDOWN", "extractStandardPrices", "satsPerToken", "syncDevelopmentRates"]) as typeof import("./openai-price-sync-contracts");
