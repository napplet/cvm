import { Pool } from "pg";
import type { PostgresSqlPool } from "../persistence/postgres-sql-funding-store";
import type { ProductionConfig } from "./config";
import { MountedProductionSecretMaterial } from "./secret-material";

type RestrictedCloudSqlCredential = Readonly<{ host: string; port: number; user: string; password: string; servername: string }>;

function credential(value: string, hostOverride?: string): RestrictedCloudSqlCredential {
  let parsed: unknown;
  try { parsed = JSON.parse(value); } catch { throw new Error("PRODUCTION_CLOUD_SQL_CREDENTIAL_INVALID"); }
  if (!parsed || typeof parsed !== "object") throw new Error("PRODUCTION_CLOUD_SQL_CREDENTIAL_INVALID");
  const item = parsed as Partial<RestrictedCloudSqlCredential>;
  const port = item.port;
  const host = hostOverride ?? item.host;
  if (typeof host !== "string" || !/^(?:10\.|192\.168\.|172\.(?:1[6-9]|2[0-9]|3[0-1])\.)/u.test(host)
    || typeof port !== "number" || !Number.isInteger(port) || port < 1 || port > 65_535
    || item.user !== "napplet_cvm_runtime" || typeof item.password !== "string" || item.password.length < 20
    || typeof item.servername !== "string" || item.servername.length < 3) throw new Error("PRODUCTION_CLOUD_SQL_CREDENTIAL_INVALID");
  return Object.freeze({ host, port, user: item.user, password: item.password, servername: item.servername });
}

async function openRestrictedPool(config: ProductionConfig, secrets: MountedProductionSecretMaterial, binding: "cloudSql.roleCredentialReference" | "cloudSql.restoreRecoveredRoleCredentialReference" | "cloudSql.restoreMigrationRoleCredentialReference", hostOverride?: string): Promise<Readonly<{ pool: PostgresSqlPool; close(): Promise<void> }>> {
  const raw = await secrets.text(binding); const input = credential(raw, hostOverride);
  const native = new Pool({ host: input.host, port: input.port, user: input.user, password: input.password, database: config.cloudSql.database, max: 12, idleTimeoutMillis: 10_000, connectionTimeoutMillis: 5_000, ssl: { rejectUnauthorized: true, servername: input.servername } });
  try {
    const client = await native.connect();
    try { await client.query("SELECT current_user, current_schema()"); }
    finally { client.release(); }
  } catch (error) { await native.end().catch(() => undefined); throw new Error("PRODUCTION_CLOUD_SQL_UNAVAILABLE", { cause: error }); }
  return Object.freeze({ pool: native as unknown as PostgresSqlPool, close: async () => { await native.end(); } });
}

/** Actual private-IP Cloud SQL pool. Credentials enter the driver only; no
 * connection string, password, or environment fallback is ever exposed. */
export async function openProductionPostgresPool(config: ProductionConfig, secrets = new MountedProductionSecretMaterial(config)): Promise<Readonly<{ pool: PostgresSqlPool; close(): Promise<void> }>> {
  return openRestrictedPool(config, secrets, "cloudSql.roleCredentialReference");
}

/** Opens an already provider-observed private address using one of the two
 * dedicated restore roles. Neither role may be used for the live authority. */
export async function openFreshRestorePostgresPool(input: Readonly<{ config: ProductionConfig; secrets: MountedProductionSecretMaterial; binding: "cloudSql.restoreRecoveredRoleCredentialReference" | "cloudSql.restoreMigrationRoleCredentialReference"; privateAddress: string }>): Promise<Readonly<{ pool: PostgresSqlPool; close(): Promise<void> }>> {
  return openRestrictedPool(input.config, input.secrets, input.binding, input.privateAddress);
}
