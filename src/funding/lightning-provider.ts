// Deprecated typed compatibility surface. Operators install its implementation separately.
import { legacyPaymentModule } from "../payments/legacy-module";
export type * from "./lightning-provider-contracts";
export type FakeLightningReceiptPort = import("./lightning-provider-contracts").FakeLightningReceiptPort;
export const { LightningInvoiceObservationSchema, FakeLightningReceiptPort } = await legacyPaymentModule("src/funding/lightning-provider.ts", ["LightningInvoiceObservationSchema", "FakeLightningReceiptPort"]) as typeof import("./lightning-provider-contracts");
