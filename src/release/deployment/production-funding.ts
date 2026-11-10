// Deprecated typed compatibility surface. Operators install its implementation separately.
import { legacyPaymentModule } from "../../payments/legacy-module";
export type * from "./production-funding-contracts";
export const { createSealedFundingFeePolicyProjection, finalizeProductionVertexUsage, createProductionVertexUsageSettlement, createProductionFunding, openProductionFunding } = await legacyPaymentModule("src/release/deployment/production-funding.ts", ["createSealedFundingFeePolicyProjection", "finalizeProductionVertexUsage", "createProductionVertexUsageSettlement", "createProductionFunding", "openProductionFunding"]) as typeof import("./production-funding-contracts");
