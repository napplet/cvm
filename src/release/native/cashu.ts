// Deprecated typed compatibility surface. Operators install its implementation separately.
import { legacyPaymentModule } from "../../payments/legacy-module";
export type * from "./cashu-contracts";
export const { createNativeCashuProvider } = await legacyPaymentModule("src/release/native/cashu.ts", ["createNativeCashuProvider"]) as typeof import("./cashu-contracts");
