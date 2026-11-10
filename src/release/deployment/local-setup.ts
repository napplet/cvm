// Deprecated typed compatibility surface. Operators install its implementation separately.
import { legacyPaymentModule } from "../../payments/legacy-module";
export type * from "./local-setup-contracts";
export const { createLocalOperatorFundingSetup, requireMacOsSecretStore, createMacOsKeychainSecretStore, createMacOsBrowserPort, createBunLocalFundingLoopbackPort, createFileOperatorFundingReadinessStore } = await legacyPaymentModule("src/release/deployment/local-setup.ts", ["createLocalOperatorFundingSetup", "requireMacOsSecretStore", "createMacOsKeychainSecretStore", "createMacOsBrowserPort", "createBunLocalFundingLoopbackPort", "createFileOperatorFundingReadinessStore"]) as typeof import("./local-setup-contracts");
