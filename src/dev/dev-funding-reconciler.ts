// Deprecated typed compatibility surface. Operators install its implementation separately.
import { legacyPaymentModule } from "../payments/legacy-module";
export type * from "./dev-funding-reconciler-contracts";
export type DevelopmentNwcSettlementReconciler = import("./dev-funding-reconciler-contracts").DevelopmentNwcSettlementReconciler;
export const { DevelopmentNwcSettlementReconciler } = await legacyPaymentModule("src/dev/dev-funding-reconciler.ts", ["DevelopmentNwcSettlementReconciler"]) as typeof import("./dev-funding-reconciler-contracts");
