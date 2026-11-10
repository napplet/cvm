// Deprecated typed compatibility surface. Operators install its implementation separately.
import { legacyPaymentModule } from "../../payments/legacy-module";
export type * from "./payment-clients-contracts";
export const { createPaymentDeploymentClients } = await legacyPaymentModule("src/release/deployment/payment-clients.ts", ["createPaymentDeploymentClients"]) as typeof import("./payment-clients-contracts");
