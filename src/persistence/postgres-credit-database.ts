import { PostgresSqlFundingStore, type PostgresSqlPool, type PostgresSqlStoreOptions } from "./postgres-sql-funding-store";
import { bindAccountingRealmPool, createAccountingRealm, type AccountingRealmName } from "../funding/accounting-realm";
import type { MeteredFundingStore, ContinuationFundingStore } from "./funding-store";

/** The application ledger has no wallet, payment-provider or custody dependency. */
export class PostgresCreditDatabase {
  readonly funding;
  readonly meteredFunding: MeteredFundingStore;
  readonly continuationFunding: ContinuationFundingStore;
  constructor(pool: PostgresSqlPool, options: PostgresSqlStoreOptions & Readonly<{ realm?: AccountingRealmName }> = {}) {
    const selectedPool = options.realm ? bindAccountingRealmPool(pool, createAccountingRealm(options.realm)) : pool;
    this.funding = new PostgresSqlFundingStore(selectedPool, options);
    this.meteredFunding = this.funding;
    this.continuationFunding = this.funding;
    Object.freeze(this);
  }
}
