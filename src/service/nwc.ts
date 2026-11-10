// Deprecated typed compatibility surface. Operators install its implementation separately.
import { legacyPaymentModule } from "../payments/legacy-module";
export type * from "./nwc-contracts";
export type NwcInvoiceReceiver = import("./nwc-contracts").NwcInvoiceReceiver;
export const { assertNwcConnection, nwcRequest, NwcInvoiceReceiver } = await legacyPaymentModule("src/service/nwc.ts", ["assertNwcConnection", "nwcRequest", "NwcInvoiceReceiver"]) as typeof import("./nwc-contracts");
