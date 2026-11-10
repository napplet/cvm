// Deprecated typed compatibility surface. Operators install its implementation separately.
import { legacyPaymentModule } from "../payments/legacy-module";
export type * from "./lightning-top-up-contracts";
export type InMemoryLightningTopUpRepository = import("./lightning-top-up-contracts").InMemoryLightningTopUpRepository;
export type LightningTopUpCoordinator = import("./lightning-top-up-contracts").LightningTopUpCoordinator;
export const { InMemoryLightningTopUpRepository, LightningTopUpCoordinator } = await legacyPaymentModule("src/funding/lightning-top-up.ts", ["InMemoryLightningTopUpRepository", "LightningTopUpCoordinator"]) as typeof import("./lightning-top-up-contracts");
