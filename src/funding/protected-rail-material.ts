// Deprecated typed compatibility surface. Operators install its implementation separately.
import { legacyPaymentModule } from "../payments/legacy-module";
export type * from "./protected-rail-material-contracts";
export type InMemoryProtectedRailMaterialRepository = import("./protected-rail-material-contracts").InMemoryProtectedRailMaterialRepository;
export type ProtectedRailMaterialVault = import("./protected-rail-material-contracts").ProtectedRailMaterialVault;
export const { InMemoryProtectedRailMaterialRepository, ProtectedRailMaterialVault } = await legacyPaymentModule("src/funding/protected-rail-material.ts", ["InMemoryProtectedRailMaterialRepository", "ProtectedRailMaterialVault"]) as typeof import("./protected-rail-material-contracts");
