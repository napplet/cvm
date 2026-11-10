// Deprecated typed compatibility surface. Operators install its implementation separately.
import { legacyPaymentModule } from "../payments/legacy-module";
export type * from "./cashu-mint-policy-contracts";
export type CashuMintPolicyRegistry = import("./cashu-mint-policy-contracts").CashuMintPolicyRegistry;
export const { CashuMintPolicySchema, canonicalCashuMintUrl, CashuMintPolicyRegistry } = await legacyPaymentModule("src/funding/cashu-mint-policy.ts", ["CashuMintPolicySchema", "canonicalCashuMintUrl", "CashuMintPolicyRegistry"]) as typeof import("./cashu-mint-policy-contracts");
