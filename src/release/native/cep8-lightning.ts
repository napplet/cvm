// Deprecated typed compatibility surface. Operators install its implementation separately.
import { legacyPaymentModule } from "../../payments/legacy-module";
export type * from "./cep8-lightning-contracts";
export const { createNativeCep8LightningProvider } = await legacyPaymentModule("src/release/native/cep8-lightning.ts", ["createNativeCep8LightningProvider"]) as typeof import("./cep8-lightning-contracts");
