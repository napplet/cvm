// Deprecated typed compatibility surface. Operators install its implementation separately.
import { legacyPaymentModule } from "../payments/legacy-module";
export type * from "./cashu-top-up-contracts";
export type InMemoryCashuTopUpRepository = import("./cashu-top-up-contracts").InMemoryCashuTopUpRepository;
export type CashuTopUpCoordinator = import("./cashu-top-up-contracts").CashuTopUpCoordinator;
export const { InMemoryCashuTopUpRepository, CashuTopUpCoordinator } = await legacyPaymentModule("src/funding/cashu-top-up.ts", ["InMemoryCashuTopUpRepository", "CashuTopUpCoordinator"]) as typeof import("./cashu-top-up-contracts");
