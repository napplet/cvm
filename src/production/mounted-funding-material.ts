// Deprecated typed compatibility surface. Operators install its implementation separately.
import { legacyPaymentModule } from "../payments/legacy-module";
export type * from "./mounted-funding-material-contracts";
export const { createMountedProductionFundingMaterial } = await legacyPaymentModule("src/production/mounted-funding-material.ts", ["createMountedProductionFundingMaterial"]) as typeof import("./mounted-funding-material-contracts");
