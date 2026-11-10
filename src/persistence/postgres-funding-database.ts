// Deprecated typed compatibility surface. Operators install its implementation separately.
import { legacyPaymentModule } from "../payments/legacy-module";
export type * from "./postgres-funding-database-contracts";
export type PostgresFundingDatabase = import("./postgres-funding-database-contracts").PostgresFundingDatabase;
export const { PostgresFundingDatabase } = await legacyPaymentModule("src/persistence/postgres-funding-database.ts", ["PostgresFundingDatabase"]) as typeof import("./postgres-funding-database-contracts");
