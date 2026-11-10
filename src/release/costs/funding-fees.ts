// Deprecated typed compatibility surface. Operators install its implementation separately.
import { legacyPaymentModule } from "../../payments/legacy-module";
export type * from "./funding-fees-contracts";
export const { createOfficialFundingRailFeePort } = await legacyPaymentModule("src/release/costs/funding-fees.ts", ["createOfficialFundingRailFeePort"]) as typeof import("./funding-fees-contracts");
