import { NwcInvoiceReceiver } from "../src/service/nwc";
import { type DevPayments } from "./dev-payments";
/** Local Hub receiver only; NIP-47 authenticates the wallet's signed response. */
export declare class DevelopmentNwcReceiver extends NwcInvoiceReceiver {
    constructor(uri: string);
}
/** Development funding composition: the service composition with local test rails. */
export declare function createDevelopmentFunding(config: DevPayments): Promise<{
    payments: import("../src/payments/registry").PaymentAdapterRegistry;
    applicationToken(token: string): Uint8Array;
    pool: import("../src/service/funding").ServicePool;
    database: import("../src/persistence/postgres-funding-database").PostgresFundingDatabase;
    funding: import("../src/funding/funding-service").FundingService;
    vault: import("../src/funding/protected-rail-material").ProtectedRailMaterialVault;
    policies: import("../src/funding/cashu-mint-policy").CashuMintPolicyRegistry;
    routes: Map<string, string>;
    lightning: import("../src/funding/lightning-top-up").LightningTopUpCoordinator;
    cashu: import("../src/funding/cashu-top-up").CashuTopUpCoordinator;
    close: () => Promise<void>;
}>;
