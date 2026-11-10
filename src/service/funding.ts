import { FundingService } from "../funding/funding-service";
import { PostgresCreditDatabase } from "../persistence/postgres-credit-database";
import type { PostgresSqlClient, PostgresSqlPool } from "../persistence/postgres-sql-funding-store";
import { loadPaymentAdapters } from "../payments/loader";
import { PaymentAdapterRegistry } from "../payments/registry";
import { FreeCreditAccess } from "../payments/free-access";
import type { ServiceConfig } from "./config";

export type ServicePool = PostgresSqlPool & Pick<PostgresSqlClient, "query"> & { end(): Promise<void> };

/** The ledger is always present. Payment implementations are optional operator modules. */
export async function createServiceFunding(input: Readonly<{
  pool: ServicePool;
  fundingKey: Uint8Array;
  config: ServiceConfig;
  deadlineMs?: number;
}>) {
  const database = new PostgresCreditDatabase(input.pool, { deadlineMs: input.deadlineMs ?? 5_000 });
  const funding = new FundingService(database.funding);
  const payments = input.config.funding.mode === "adapters"
    ? await loadPaymentAdapters({ modules: input.config.funding.adapters, funding, host: { pool: input.pool, key: input.fundingKey, realm: input.config.realm } })
    : new PaymentAdapterRegistry([]);
  const freeAccess = input.config.funding.mode === "free" ? new FreeCreditAccess(funding, input.config.funding) : undefined;
  return { pool: input.pool, database, funding, payments, freeAccess, close: async () => { try { await payments.close(); } finally { await input.pool.end(); } } };
}
export type ServiceFunding = Awaited<ReturnType<typeof createServiceFunding>>;
