import { loadServiceConfig, ServiceSecrets } from "../src/service/config";
import { applyCanonicalMigrations, assertCanonicalSchema, initializeServiceRealm } from "../src/service/migrations";
import { createServicePool } from "../src/service/server";

/**
 * Explicit schema step for deployments: apply pending canonical migrations,
 * then record (or confirm) the database realm. `--check` only verifies.
 * Uses the same mounted configuration and secrets as the service.
 */
const check = process.argv.includes("--check");
const config = await loadServiceConfig(process.env.NAPPLET_CVM_SERVICE_CONFIG ?? undefined);
const secrets = new ServiceSecrets(process.env.NAPPLET_CVM_SECRETS_DIR ?? undefined);
const pool = createServicePool(await secrets.text("database_url"), config);
try {
  for (let attempt = 0; ; attempt++) {
    try { await pool.query("SELECT 1"); break; }
    catch (error) { if (attempt >= 60) throw error; await Bun.sleep(1000); }
  }
  if (check) {
    await assertCanonicalSchema(pool);
    const realm = (await pool.query<{ realm: string }>("SELECT realm FROM service_realm")).rows[0]?.realm;
    if (realm !== config.realm) throw new Error(`SERVICE_REALM_MISMATCH:${realm ?? "uninitialized"}`);
    console.log(JSON.stringify({ status: "current", realm }));
  } else {
    const result = await applyCanonicalMigrations(pool);
    const realm = await initializeServiceRealm(pool, config.realm);
    console.log(JSON.stringify({ status: "migrated", applied: result.applied, total: result.current, realm }));
  }
} catch (error) {
  const message = error instanceof Error ? error.message : "SERVICE_MIGRATION_FAILED";
  console.error(JSON.stringify({ status: "failed", error: /^[A-Z][A-Z0-9_:./,-]{2,400}$/u.test(message) ? message : "SERVICE_MIGRATION_FAILED" }));
  process.exitCode = 1;
} finally { await pool.end(); }
