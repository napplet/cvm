// Deprecated typed compatibility surface. Operators install its implementation separately.
import { legacyPaymentModule } from "../payments/legacy-module";
export type * from "./cashu-provider-contracts";
export type CashuTsSettlementAdapter = import("./cashu-provider-contracts").CashuTsSettlementAdapter;
export type FakeCashuSettlementPort = import("./cashu-provider-contracts").FakeCashuSettlementPort;
export const { CashuSettlementObservationSchema, CashuTsSettlementAdapter, FakeCashuSettlementPort } = await legacyPaymentModule("src/funding/cashu-provider.ts", ["CashuSettlementObservationSchema", "CashuTsSettlementAdapter", "FakeCashuSettlementPort"]) as typeof import("./cashu-provider-contracts");
