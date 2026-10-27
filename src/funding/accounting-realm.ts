import type { PostgresSqlClient, PostgresSqlPool } from "../persistence/postgres-sql-funding-store";

export const AccountingRealms = ["development-test", "production-real"] as const;
export type AccountingRealmName = typeof AccountingRealms[number];

export type AccountingRealm = Readonly<{
  name: AccountingRealmName;
  schema: "public" | "production_real";
  role: "napplet_development_history" | "napplet_production_real";
}>;

const REALMS: Readonly<Record<AccountingRealmName, AccountingRealm>> = Object.freeze({
  "development-test": Object.freeze({ name: "development-test", schema: "public", role: "napplet_development_history" }),
  "production-real": Object.freeze({ name: "production-real", schema: "production_real", role: "napplet_production_real" }),
});

/** Maps the finite realm name to a server-side schema and least-privilege role. */
export function createAccountingRealm(name: AccountingRealmName): AccountingRealm {
  const realm = REALMS[name];
  if (!realm) throw new Error("ACCOUNTING_REALM_INVALID");
  return realm;
}

/**
 * Production composition may not smuggle a development wallet, price card, key,
 * fixture model, or faucet into a real-money authority. This deliberately scans
 * names only: credentials and protected material must never enter this check.
 */
export function assertProductionAccountingConfiguration(configuration: unknown): void {
  const seen = new Set<unknown>();
  const visit = (value: unknown): void => {
    if (typeof value === "string") {
      if (/\b(fakewallet|faucet|fixture|synthetic|development|test[-_ ]?only|local[-_ ]?mint|deterministic_fixture)\b/iu.test(value)) throw new Error("PRODUCTION_ACCOUNTING_DEVELOPMENT_MARKER");
      return;
    }
    if (!value || typeof value !== "object" || seen.has(value)) return;
    seen.add(value);
    for (const [key, child] of Object.entries(value as Record<string, unknown>)) {
      if (/^(secret|key|token|proof|ciphertext|password)$/iu.test(key)) continue;
      visit(child);
    }
  };
  visit(configuration);
}

/**
 * The only pool adapter allowed to select a realm. It pins search_path for each
 * checked-out connection. Deployment credentials must log in as the matching
 * least-privilege role; this adapter deliberately does not impersonate a role.
 */
export function bindAccountingRealmPool(pool: PostgresSqlPool, realm: AccountingRealm): PostgresSqlPool {
  return Object.freeze({
    async connect(): Promise<PostgresSqlClient> {
      const client = await pool.connect();
      try {
        await client.query(`SET search_path TO ${realm.schema}, pg_catalog`);
        return client;
      } catch (error) {
        client.release();
        throw error;
      }
    },
  });
}

export function assertProductionRealm(realm: AccountingRealm): void {
  if (realm.name !== "production-real" || realm.schema !== "production_real" || realm.role !== "napplet_production_real") throw new Error("PRODUCTION_ACCOUNTING_REALM_REQUIRED");
}
