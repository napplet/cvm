import { PostgresSqlFundingStore, type PostgresSqlPool, type PostgresSqlStoreOptions } from "./postgres-sql-funding-store";

/** The application ledger has no wallet, payment-provider or custody dependency. */
export class PostgresCreditDatabase {
  readonly funding;
  readonly meteredFunding;
  readonly continuationFunding;
  constructor(pool: PostgresSqlPool, options: PostgresSqlStoreOptions = {}) {
    this.funding = new PostgresSqlFundingStore(pool, options);
    this.meteredFunding = this.funding;
    this.continuationFunding = this.funding;
    Object.freeze(this);
  }
}
