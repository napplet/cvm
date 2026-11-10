// Deprecated typed compatibility surface. Operators install its implementation separately.
import { legacyPaymentModule } from "../src/payments/legacy-module";
export type * from "./dev-funding-contracts";
export type DevelopmentNwcReceiver = import("./dev-funding-contracts").DevelopmentNwcReceiver;
export const { DevelopmentNwcReceiver, createDevelopmentFunding } = await legacyPaymentModule("scripts/dev-funding.ts", ["DevelopmentNwcReceiver", "createDevelopmentFunding"]) as typeof import("./dev-funding-contracts");
