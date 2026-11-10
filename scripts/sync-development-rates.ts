import { legacyPaymentModule } from "../src/payments/legacy-module";
if (!process.env.NAPPLET_CVM_PAYMENT_IMPLEMENTATION_ROOT) throw new Error("PAYMENT_ADAPTER_NOT_INSTALLED");
await legacyPaymentModule("scripts/sync-development-rates.ts", []);
