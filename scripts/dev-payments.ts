// Deprecated typed compatibility surface. Operators install its implementation separately.
import { legacyPaymentModule } from "../src/payments/legacy-module";
export type * from "./dev-payments-contracts";
export const { DEVELOPMENT_MIGRATIONS, createDevelopmentPool, nwcRequest, expectedDevelopmentMigrations, waitUntil, developmentStack, withRunOwnedStack } = await legacyPaymentModule("scripts/dev-payments.ts", ["DEVELOPMENT_MIGRATIONS", "createDevelopmentPool", "nwcRequest", "expectedDevelopmentMigrations", "waitUntil", "developmentStack", "withRunOwnedStack"]) as typeof import("./dev-payments-contracts");

if (import.meta.main) {
  const module = await legacyPaymentModule("scripts/dev-payments.ts", ["runDevelopmentPaymentsCommand"]);
  await (module.runDevelopmentPaymentsCommand as () => Promise<void>)();
}
