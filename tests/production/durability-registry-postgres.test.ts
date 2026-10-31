import { expect, test } from "bun:test";
import { Pool } from "pg";
import type { PostgresSqlPool } from "../../src/persistence/postgres-sql-funding-store";
import { createProductionDurabilitySubjectRegistry, type ProductionDurabilitySubject } from "../../src/production/durability-registry";
import { ProductionRestoreCertification } from "../../src/production/restore-certification";
import { MigrationArchiveCipher, ProductionMigrationSource } from "../../src/production/migration-control";
import { PostgresOperationJournal } from "../../src/release/deployment/postgres-operation-journal";
import { DeterministicObjectStore } from "../../src/continuity/object-store";
import { DURABILITY_SUBJECT_KINDS } from "../../src/resilience/fault-harness";

const integration = process.env.NAPPLET_RUN_POSTGRES_ISOLATION === "1" ? test : test.skip;
const digest = "a".repeat(64);
const scope = { checkpointId: "checkpoint-original", sessionId: "session-original", ownerId: "owner-original" };
const migrations = ["phase-03/001_funding.sql", "phase-04/001_metered_generation.sql", "phase-04/002_action_budget_lifecycle.sql", "phase-05/001_continuation.sql", "phase-06/001_publication.sql", "phase-03/002_production_accounting.sql", "phase-03/003_cashu_custody_and_identities.sql", "phase-03/004_production_rail_material_scope.sql", "phase-07/001_production_operation_journal.sql", "phase-07/002_production_pricing_catalog.sql", "phase-07/003_production_checkpoints.sql"];

function sqlPool(native: Pool): PostgresSqlPool {
  return { async connect() { const client = await native.connect(); return {
    async query<Row extends Record<string, unknown>>(text: string, values?: readonly unknown[]) { return { rows: (await client.query<Row>(text, values ? [...values] : undefined)).rows }; },
    release() { client.release(); },
  }; } };
}

async function docker(...args: string[]) {
  const child = Bun.spawn(["docker", ...args], { stdout: "pipe", stderr: "pipe" });
  const timer = setTimeout(() => child.kill(), 15_000);
  try {
    const [code, stdout, stderr] = await Promise.all([child.exited, new Response(child.stdout).text(), new Response(child.stderr).text()]);
    if (code) throw new Error(`DOCKER_${args[0]}:${stderr.slice(0, 300)}`);
    return stdout.trim();
  } finally { clearTimeout(timer); }
}

function restoreReader(pool: PostgresSqlPool, selected = scope) {
  const source = new ProductionMigrationSource({ pool, source: { sourceIdentity: "source-inventory", serviceIdentity: digest, sourceRevision: digest, schemaVersions: migrations, migrationDigests: Object.fromEntries(migrations.map(path => [path, digest])), writers: [], records: [], objects: [], externalOperations: [] } });
  return new ProductionRestoreCertification({ sourceInstanceId: "source-inventory", scope: selected, sourcePool: pool, migrationSource: source,
    migrationCipher: new MigrationArchiveCipher(new Uint8Array(32).fill(7)), backupStore: new DeterministicObjectStore(),
    journal: new PostgresOperationJournal(pool, { namespace: "durability-inventory", scopeSha256: digest }),
    provisioner: { async create() { throw new Error("PROVIDER_EFFECT_DENIED"); }, async attach() { throw new Error("PROVIDER_EFFECT_DENIED"); }, async observeCleanup() { throw new Error("PROVIDER_EFFECT_DENIED"); } },
    candidateSha256: digest, topologySha256: digest,
  });
}

integration.each([false, true])("canonical durability inventory preserves restricted original identities and fresh SQL readback (legacy table: %s)", async legacy => {
  const suffix = crypto.randomUUID().replaceAll("-", "").slice(0, 16);
  const container = `cvm-durability-${suffix}`;
  const sourceDatabase = `source_${suffix}`, cloneDatabase = `clone_${suffix}`, role = `inventory_${suffix}`;
  let admin: Pool | undefined, source: Pool | undefined, application: Pool | undefined, recovered: Pool | undefined;
  try {
    await docker("run", "--rm", "--detach", "--name", container, "--publish", "127.0.0.1::5432", "-e", "POSTGRES_HOST_AUTH_METHOD=trust", "postgres:17-alpine");
    const port = (await docker("port", container, "5432/tcp")).match(/127\.0\.0\.1:(\d+)/u)?.[1];
    if (!port) throw new Error("POSTGRES_PORT_REQUIRED");
    const connection = (user: string, database: string) => `postgresql://${user}@127.0.0.1:${port}/${database}`;
    admin = new Pool({ connectionString: connection("postgres", "postgres"), connectionTimeoutMillis: 2_000 });
    for (let attempt = 0; attempt < 60; attempt++) { try { await admin.query("SELECT 1"); break; } catch (error) { if (attempt === 59) throw error; await Bun.sleep(100); } }
    await admin.query(`CREATE DATABASE ${sourceDatabase}`);
    source = new Pool({ connectionString: connection("postgres", sourceDatabase), connectionTimeoutMillis: 2_000 });
    for (const path of migrations) await source.query(await Bun.file(`migrations/${path}`).text());
    const expansion = await Bun.file("migrations/phase-07/014_production_durability_subjects.sql").text();
    await source.query(legacy ? await Bun.file("tests/fixtures/legacy-durability-subjects.sql").text() : expansion);
    await source.query(`CREATE ROLE ${role} LOGIN`);
    await source.query(`GRANT napplet_production_real TO ${role}`);
    application = new Pool({ connectionString: connection(role, sourceDatabase), connectionTimeoutMillis: 2_000 });
    const pool = sqlPool(application), registry = createProductionDurabilitySubjectRegistry(pool);
    const subjects = DURABILITY_SUBJECT_KINDS.map((kind, index): ProductionDurabilitySubject => ({ ...scope, actionId: "action-original", kind,
      sourceIdentity: `${kind}-original`, object: { key: `retained/${kind}`, generation: index + 1, checksum: digest }, payloadSha256: digest,
      retentionUntil: "2030-01-01T00:00:00.000Z", deletionState: "retained",
    }));
    for (const subject of subjects) await registry.register(subject);
    const before = (await source.query("SELECT * FROM production_real.durability_subjects ORDER BY kind")).rows;
    await source.query(expansion);
    await source.query(expansion); // a repeated expansion must preserve the rows
    expect((await source.query("SELECT * FROM production_real.durability_subjects ORDER BY kind")).rows).toEqual(before);
    for (const subject of subjects) await registry.register({ ...subject, retentionUntil: "2030-01-01T00:00:00Z" });
    const observe = (reader: ProductionRestoreCertification) => reader.restore({ operationId: "inventory-original", action: "restore.inventory", payload: {} });
    const inventory = await observe(restoreReader(pool));
    expect(inventory).toHaveLength(7);
    await expect(observe(restoreReader(pool, { ...scope, ownerId: "foreign-owner" }))).rejects.toThrow();
    await expect(observe(restoreReader(pool, { ...scope, sessionId: "foreign-session" }))).rejects.toThrow();
    await expect(observe(restoreReader(pool, { ...scope, checkpointId: "later-checkpoint" }))).rejects.toThrow();
    const original = subjects[0]; if (!original) throw new Error("SUBJECT_REQUIRED");
    await expect(registry.register({ ...original, ownerId: "foreign-owner" })).rejects.toThrow("PRODUCTION_DURABILITY_SUBJECT_CONFLICT");
    await expect(application.query("UPDATE production_real.durability_subjects SET owner_id='foreign-owner'")).rejects.toThrow();
    await expect(source.query("UPDATE production_real.durability_subjects SET object_generation=object_generation+1")).rejects.toThrow("PRODUCTION_DURABILITY_IDENTITY_IMMUTABLE");
    await expect(source.query("DELETE FROM production_real.durability_subjects")).rejects.toThrow("PRODUCTION_DURABILITY_DELETE_DENIED");
    await expect(source.query("TRUNCATE production_real.durability_subjects")).rejects.toThrow("PRODUCTION_DURABILITY_DELETE_DENIED");
    await expect(source.query("INSERT INTO production_real.durability_subjects(checkpoint_id,kind,source_identity,object_key,object_generation,object_checksum,payload_sha256,owner_id,session_id,action_id,retention_until,deletion_state) SELECT 'bad-checkpoint',kind,source_identity,object_key,0,object_checksum,payload_sha256,owner_id,session_id,action_id,retention_until,deletion_state FROM production_real.durability_subjects LIMIT 1")).rejects.toThrow("PRODUCTION_DURABILITY_SUBJECT_INVALID");
    const deletion = { checkpointId: original.checkpointId, kind: original.kind, objectGeneration: original.object.generation, objectChecksum: original.object.checksum };
    await registry.markDeletion({ ...deletion, state: "tombstoned" });
    await expect(registry.markDeletion({ ...deletion, objectGeneration: 99, state: "deleted" })).rejects.toThrow("PRODUCTION_DURABILITY_DELETE_BINDING_REQUIRED");
    await registry.markDeletion({ ...deletion, state: "deleted" });
    const updated = (await source.query("SELECT updated_at::text FROM production_real.durability_subjects WHERE checkpoint_id=$1 AND kind=$2", [original.checkpointId, original.kind])).rows;
    await registry.markDeletion({ ...deletion, state: "deleted" });
    expect((await source.query("SELECT updated_at::text FROM production_real.durability_subjects WHERE checkpoint_id=$1 AND kind=$2", [original.checkpointId, original.kind])).rows).toEqual(updated);
    await expect(registry.markDeletion({ ...deletion, state: "tombstoned" })).rejects.toThrow("PRODUCTION_DURABILITY_DELETE_BINDING_REQUIRED");
    await expect(application.query("UPDATE production_real.durability_subjects SET deletion_state='retained'")).rejects.toThrow("PRODUCTION_DURABILITY_IDENTITY_IMMUTABLE");
    const expected = await observe(restoreReader(pool));
    expect((await source.query("SELECT count(*)::int AS count FROM production_real.ledger_entries")).rows).toEqual([{ count: 0 }]);
    await application.end(); application = undefined;
    await source.end(); source = undefined;
    await admin.query(`CREATE DATABASE ${cloneDatabase} TEMPLATE ${sourceDatabase}`);
    recovered = new Pool({ connectionString: connection(role, cloneDatabase), connectionTimeoutMillis: 2_000 });
    expect(await observe(restoreReader(sqlPool(recovered)))).toEqual(expected);
    console.log(JSON.stringify({ localDurabilityInventory: true, legacyTable: legacy, subjects: 7, freshDatabaseReadback: true, releaseEvidence: false }));
  } finally {
    await recovered?.end(); await application?.end(); await source?.end(); await admin?.end();
    await docker("rm", "--force", container).catch(() => undefined);
  }
}, 120_000);
