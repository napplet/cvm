// Deprecated typed compatibility surface. Operators install its implementation separately.
import { legacyPaymentModule } from "../payments/legacy-module";
export type * from "./funded-core-contracts";
export const { createFundedCore } = await legacyPaymentModule("src/phase-03/funded-core.ts", ["createFundedCore"]) as typeof import("./funded-core-contracts");
