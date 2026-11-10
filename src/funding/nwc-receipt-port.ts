// Deprecated typed compatibility surface. Operators install its implementation separately.
import { legacyPaymentModule } from "../payments/legacy-module";
export type * from "./nwc-receipt-port-contracts";
export type NwcLightningReceiptPort = import("./nwc-receipt-port-contracts").NwcLightningReceiptPort;
export const { NwcLightningReceiptPort } = await legacyPaymentModule("src/funding/nwc-receipt-port.ts", ["NwcLightningReceiptPort"]) as typeof import("./nwc-receipt-port-contracts");
