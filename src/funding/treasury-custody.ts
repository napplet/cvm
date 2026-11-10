// Deprecated typed compatibility surface. Operators install its implementation separately.
import { legacyPaymentModule } from "../payments/legacy-module";
export type * from "./treasury-custody-contracts";
export type InMemoryCashuTreasuryCustody = import("./treasury-custody-contracts").InMemoryCashuTreasuryCustody;
export const { canonicalCashuTokenIdentity, canonicalCashuProofIdentities, InMemoryCashuTreasuryCustody } = await legacyPaymentModule("src/funding/treasury-custody.ts", ["canonicalCashuTokenIdentity", "canonicalCashuProofIdentities", "InMemoryCashuTreasuryCustody"]) as typeof import("./treasury-custody-contracts");
