// Deprecated typed compatibility surface. Operators install its implementation separately.
import { legacyPaymentModule } from "../../payments/legacy-module";
export type * from "./signed-nwc-transport-contracts";
export const { createNwcCredentialSigningBroker, openSignedNwcTransport } = await legacyPaymentModule("src/release/deployment/signed-nwc-transport.ts", ["createNwcCredentialSigningBroker", "openSignedNwcTransport"]) as typeof import("./signed-nwc-transport-contracts");
