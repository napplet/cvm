import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, test } from "bun:test";
import { Pool } from "pg";
import { PostgresByteaObjectStoreAdapter } from "../../src/continuity/postgres-bytea-object-store";
import { FileObjectKeyCustody, ObjectProducerBudgets, PerObjectFileCheckpointCrypto, THIRTY_DAY_RETENTION_MS, assertProducerWriteBudget } from "../../src/production/object-retention-policy";
import { ProductionCheckpointCoordinator } from "../../src/production/checkpoint-coordinator";
import { PostgresOperationJournal } from "../../src/release/deployment/postgres-operation-journal";
import type { PostgresSqlPool } from "../../src/persistence/postgres-sql-funding-store";

const connectionString = process.env.NAPPLET_TEST_POSTGRES_URL;
const integration = connectionString ? test : test.skip;

function sqlPool(native: Pool): PostgresSqlPool {
  return Object.freeze({ async connect() { const client = await native.connect(); return Object.freeze({ async query<Row extends Record<string, unknown>>(text: string, values?: readonly unknown[]) { return Object.freeze({ rows: (await client.query<Row>(text, values ? [...values] : undefined)).rows }); }, release(error?: Error) { client.release(error); } }); } });
}
async function run(argv: readonly string[], input?: string): Promise<string> {
  const child = Bun.spawn([...argv], { stdin: input === undefined ? "ignore" : "pipe", stdout: "pipe", stderr: "pipe" });
  if (input !== undefined && child.stdin) { child.stdin.write(input); child.stdin.end(); }
  const [stdout, stderr, code] = await Promise.all([new Response(child.stdout).text(), new Response(child.stderr).text(), child.exited]);
  if (code !== 0) throw new Error(`POSTGRES_CLIENT_FAILED:${argv[0]}:${stderr.slice(0, 200)}`);
  return stdout;
}

integration("declared per-object custody survives a fresh snapshot before expiry and denies recovery after every declared key copy is erased", async () => {
  const admin = new Pool({ connectionString });
  const suffix = crypto.randomUUID().replaceAll("-", "").slice(0, 16);
  const runtimeRole = `retention_runtime_${suffix}`, objectRole = `retention_object_${suffix}`, recoveredDb = `retention_recovered_${suffix}`;
  let runtime: Pool | undefined, objectRuntime: Pool | undefined, recoveredRuntime: Pool | undefined, recoveredObjectRuntime: Pool | undefined;
  const roots = [await mkdtemp(join(tmpdir(), "cvm-object-live-")), await mkdtemp(join(tmpdir(), "cvm-object-key-backup-"))];
  try {
    for (const file of ["phase-03/001_funding.sql", "phase-04/001_metered_generation.sql", "phase-04/002_action_budget_lifecycle.sql", "phase-05/001_continuation.sql", "phase-06/001_publication.sql", "phase-03/002_production_accounting.sql", "phase-07/001_production_operation_journal.sql", "phase-07/003_production_checkpoints.sql", "phase-07/019_postgres_bytea_objects.sql"]) await admin.query(await Bun.file(`migrations/${file}`).text());
    await admin.query(`CREATE ROLE ${runtimeRole} LOGIN`); await admin.query(`CREATE ROLE ${objectRole} LOGIN`);
    await admin.query(`GRANT napplet_production_real TO ${runtimeRole}`); await admin.query(`GRANT napplet_production_object TO ${objectRole}`);
    runtime = new Pool({ connectionString: connectionString!.replace(/\/\/[^@]+@/u, `//${runtimeRole}@`) });
    objectRuntime = new Pool({ connectionString: connectionString!.replace(/\/\/[^@]+@/u, `//${objectRole}@`) });
    const raw = sqlPool(runtime), objects = new PostgresByteaObjectStoreAdapter({ pool: sqlPool(objectRuntime), now: () => now, retentionUntil: () => new Date(now + THIRTY_DAY_RETENTION_MS).toISOString() });
    const accountId = `account:${suffix}`, sessionId = `session:${suffix}`;
    await admin.query("INSERT INTO production_real.funding_accounts(account_id,nostr_pubkey,unit) VALUES($1,$2,'sat')", [accountId, "7".repeat(64)]);
    await admin.query("INSERT INTO production_real.model_profile_versions VALUES($1,$2,'fixture','fixture','{}')", [`profile:${suffix}`, "1".repeat(64)]);
    await admin.query("INSERT INTO production_real.price_card_versions(id,card_hash,profile_id,unit,normalized_card) VALUES($1,$2,$3,'sat','{}')", [`price:${suffix}`, "2".repeat(64), `profile:${suffix}`]);
    await admin.query("INSERT INTO production_real.metered_sessions(id,account_id,admission_reference,profile_id,price_card_id,version,state) VALUES($1,$2,'fixture:admission',$3,$4,0,'prepared')", [sessionId, accountId, `profile:${suffix}`, `price:${suffix}`]);
    const custody = new FileObjectKeyCustody({ roots });
    const cryptoPort = new PerObjectFileCheckpointCrypto({ pool: raw, custody, now: () => now });
    const open = (pool = raw, objectStore = objects, checkpointCrypto = cryptoPort) => new ProductionCheckpointCoordinator({ pool, objectStore, journal: new PostgresOperationJournal(pool, { namespace: `retention-${suffix}`, scopeSha256: "a".repeat(64) }), crypto: checkpointCrypto, kekPath: "/unused/legacy-kek", readKekFile: async () => Buffer.alloc(32, 3).toString("base64"), now: () => now });
    const archive = new TextEncoder().encode("per-object custody checkpoint bytes");
    const sealed = await open().seal({ checkpointId: `checkpoint:${suffix}`, accountId, sessionId, pauseGeneration: 1, sessionVersion: 0, actionVersion: 0, artifactVersion: 0, workspaceVersion: 0, workspaceLineage: `workspace:${suffix}`, action: { actionId: `action:${suffix}`, operationId: `operation:${suffix}`, ledgerReference: "fixture:admission", pendingActionReference: `pending:${suffix}`, idempotencyKey: `key:${suffix}` }, archive, inventory: ["harness_state", "workspace", "artifact_lineage", "validation_evidence", "financial_action", "pending_action", "compatibility_metadata"], evidenceSha256: "b".repeat(64), compatibility: { policyVersion: "fixture", modelIdentity: `profile:${suffix}`, nappletSdkIdentity: `price:${suffix}`, toolchainIdentity: "c".repeat(64) }, retentionUntil: new Date(now + THIRTY_DAY_RETENTION_MS).toISOString() });
    const record = await admin.query("SELECT key_reference,wrapped_dek,ciphertext FROM production_real.checkpoint_crypto_records WHERE checkpoint_id=$1", [`checkpoint:${suffix}`]);
    expect(record.rows).toHaveLength(1); expect(record.rows[0].wrapped_dek).toBeTruthy(); expect(Buffer.from(record.rows[0].ciphertext).includes(Buffer.from(archive))).toBe(false);
    const dump = await run(["pg_dump", connectionString!, "--schema=production_real", "--no-owner", "--no-privileges"]);
    await admin.query(`CREATE DATABASE ${recoveredDb}`);
    await run(["psql", connectionString!.replace(/\/postgres(?:\?.*)?$/u, `/${recoveredDb}`), "--set", "ON_ERROR_STOP=1"], dump);
    recoveredRuntime = new Pool({ connectionString: connectionString!.replace(/\/\/[^@]+@/u, `//${runtimeRole}@`).replace(/\/postgres(?:\?.*)?$/u, `/${recoveredDb}`) });
    recoveredObjectRuntime = new Pool({ connectionString: connectionString!.replace(/\/\/[^@]+@/u, `//${objectRole}@`).replace(/\/postgres(?:\?.*)?$/u, `/${recoveredDb}`) });
    const recoveredPool = sqlPool(recoveredRuntime);
    const recoveredObjects = new PostgresByteaObjectStoreAdapter({ pool: sqlPool(recoveredObjectRuntime), now: () => now, retentionUntil: () => new Date(now + THIRTY_DAY_RETENTION_MS).toISOString() });
    const recoveredCrypto = new PerObjectFileCheckpointCrypto({ pool: recoveredPool, custody, now: () => now });
    expect(await open(recoveredPool, recoveredObjects, recoveredCrypto).restore({ checkpointId: `checkpoint:${suffix}`, accountId, sessionId })).toEqual(archive);
    const copies = custody.inventory(sealed.envelope.crypto.keyReference);
    expect(copies).toHaveLength(2);
    now += THIRTY_DAY_RETENTION_MS;
    await expect(open(recoveredPool, recoveredObjects, recoveredCrypto).restore({ checkpointId: `checkpoint:${suffix}`, accountId, sessionId })).rejects.toThrow("CHECKPOINT_RESTORE_DENIED");
    await cryptoPort.destroy(sealed.envelope.crypto.keyReference);
    now -= 1;
    await expect(open(recoveredPool, recoveredObjects, recoveredCrypto).restore({ checkpointId: `checkpoint:${suffix}`, accountId, sessionId })).rejects.toThrow("CHECKPOINT_RESTORE_DENIED");
    expect(await cryptoPort.isDestroyed(sealed.envelope.crypto.keyReference)).toBe(true);
  } finally {
    await recoveredObjectRuntime?.end(); await recoveredRuntime?.end(); await objectRuntime?.end(); await runtime?.end();
    await admin.query(`DROP DATABASE IF EXISTS ${recoveredDb}`).catch(() => undefined);
    await admin.query(`REVOKE napplet_production_real FROM ${runtimeRole}`).catch(() => undefined); await admin.query(`REVOKE napplet_production_object FROM ${objectRole}`).catch(() => undefined);
    await admin.query(`DROP ROLE IF EXISTS ${runtimeRole}`).catch(() => undefined); await admin.query(`DROP ROLE IF EXISTS ${objectRole}`).catch(() => undefined);
    await admin.end(); await Promise.all(roots.map(root => rm(root, { recursive: true, force: true })));
  }
}, 60_000);

test("new write budgets are producer-specific while ordinary checkpoints stay uncapped", () => {
  expect(() => assertProducerWriteBudget({ budget: ObjectProducerBudgets.ordinary_checkpoint, plaintextBytes: 32 * 1024 * 1024 })).not.toThrow();
  expect(() => assertProducerWriteBudget({ budget: ObjectProducerBudgets.retained_subject, plaintextBytes: 16 * 1024 * 1024 + 1 })).toThrow("OBJECT_PRODUCER_BUDGET_EXCEEDED");
  expect(() => assertProducerWriteBudget({ budget: ObjectProducerBudgets.migration_archive, plaintextBytes: 384 * 1024 * 512 + 1 })).toThrow("OBJECT_PRODUCER_BUDGET_EXCEEDED");
});

test("hosted PostgreSQL is mandatory in CI for retention custody proof", () => { if (process.env.CI && !connectionString) throw new Error("NAPPLET_TEST_POSTGRES_URL_REQUIRED"); });

let now = Date.parse("2030-01-01T00:00:00.000Z");
