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
import { NonGoogleCoolifyDriver } from "../../src/production/non-google-coolify-driver";
import { NonGoogleFreshRestoreDriver, type NativeCommandRunner } from "../../src/production/non-google-fresh-restore-driver";
import { NonGoogleCoreJournal } from "../../src/production/non-google-native-runtime";
import { PostgresRestorerPullStore } from "../../src/production/non-google-restorer-pull-protocol";

const connectionString = process.env.NAPPLET_TEST_POSTGRES_URL;
const integration = connectionString ? test : test.skip;
const postgres17Container = process.env.NAPPLET_POSTGRES17_CONTAINER;

function postgres17Command(name: "pg_dump" | "psql", ...args: string[]): string[] {
  if (!postgres17Container) throw new Error("POSTGRES17_CLIENT_REQUIRED");
  return ["docker", "exec", "-i", postgres17Container, name, ...args];
}

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

function lostCommitAfterCryptoInsertPool(native: Pool): PostgresSqlPool {
  let inserted = false, lost = false;
  return Object.freeze({ async connect() {
    const client = await native.connect();
    return Object.freeze({ async query<Row extends Record<string, unknown>>(text: string, values?: readonly unknown[]) {
      const result = await client.query<Row>(text, values ? [...values] : undefined);
      if (text.includes("INSERT INTO production_real.checkpoint_crypto_records")) inserted = true;
      if (inserted && !lost && text === "COMMIT") { lost = true; throw new Error("SIMULATED_COMMIT_ACK_LOSS"); }
      return Object.freeze({ rows: result.rows });
    }, release(error?: Error) { client.release(error); } });
  } });
}

class FailOnceEraseCustody extends FileObjectKeyCustody {
  #fail = true;
  override async erase(reference: string): Promise<void> {
    if (this.#fail) { this.#fail = false; throw new Error("SIMULATED_FILESYSTEM_ERASE_FAILURE"); }
    await super.erase(reference);
  }
}

integration("declared per-object custody survives a fresh snapshot before expiry and denies recovery after every declared key copy is erased", async () => {
  const admin = new Pool({ connectionString });
  const suffix = crypto.randomUUID().replaceAll("-", "").slice(0, 16);
  const runtimeRole = `retention_runtime_${suffix}`, objectRole = `retention_object_${suffix}`, recoveredDb = `retention_recovered_${suffix}`;
  let runtime: Pool | undefined, objectRuntime: Pool | undefined, recoveredAdmin: Pool | undefined, recoveredRuntime: Pool | undefined, recoveredObjectRuntime: Pool | undefined;
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
    const journalRecord = await new PostgresOperationJournal(raw, { namespace: `retention-${suffix}`, scopeSha256: "a".repeat(64) }).read(`checkpoint-seal:checkpoint:${suffix}`);
    expect(journalRecord?.value).toMatchObject({ formatVersion: 4, reconciliationMode: "original-operation-v1", objectWrite: { reconciliationMode: "original-operation-v1" } });
    const record = await admin.query("SELECT key_reference,wrapped_dek,ciphertext FROM production_real.checkpoint_crypto_records WHERE checkpoint_id=$1", [`checkpoint:${suffix}`]);
    expect(record.rows).toHaveLength(1); expect(record.rows[0].wrapped_dek).toBeTruthy(); expect(Buffer.from(record.rows[0].ciphertext).includes(Buffer.from(archive))).toBe(false);
    expect(await run(postgres17Command("pg_dump", "--version"))).toContain("17.");
    expect(await run(postgres17Command("psql", "--version"))).toContain("17.");
    const dump = await run(postgres17Command("pg_dump", connectionString!, "--schema=production_real", "--no-owner", "--no-privileges"));
    await admin.query(`CREATE DATABASE ${recoveredDb}`);
    const recoveredConnectionString = connectionString!.replace(/\/postgres(?:\?.*)?$/u, `/${recoveredDb}`);
    await run(postgres17Command("psql", recoveredConnectionString, "--set", "ON_ERROR_STOP=1"), dump);
    // A no-privileges dump intentionally omits ACLs. Reapply only the original
    // production-realm schema usage plus checked migration-owned narrow grants.
    // The full accounting migration cannot be rerun in a schema-only restore:
    // its public-history alterations are intentionally absent from this fixture.
    recoveredAdmin = new Pool({ connectionString: recoveredConnectionString });
    await recoveredAdmin.query("GRANT USAGE ON SCHEMA production_real TO napplet_production_real");
    for (const file of ["phase-07/003_production_checkpoints.sql", "phase-07/019_postgres_bytea_objects.sql"]) await recoveredAdmin.query(await Bun.file(`migrations/${file}`).text());
    recoveredRuntime = new Pool({ connectionString: connectionString!.replace(/\/\/[^@]+@/u, `//${runtimeRole}@`).replace(/\/postgres(?:\?.*)?$/u, `/${recoveredDb}`) });
    recoveredObjectRuntime = new Pool({ connectionString: connectionString!.replace(/\/\/[^@]+@/u, `//${objectRole}@`).replace(/\/postgres(?:\?.*)?$/u, `/${recoveredDb}`) });
    const recoveredPool = sqlPool(recoveredRuntime);
    const recoveredObjects = new PostgresByteaObjectStoreAdapter({ pool: sqlPool(recoveredObjectRuntime), now: () => now, retentionUntil: () => new Date(now + THIRTY_DAY_RETENTION_MS).toISOString() });
    const recoveredCrypto = new PerObjectFileCheckpointCrypto({ pool: recoveredPool, custody, now: () => now });
    expect(await open(recoveredPool, recoveredObjects, recoveredCrypto).restore({ checkpointId: `checkpoint:${suffix}`, accountId, sessionId })).toEqual(archive);
    const recoveredObjectClient = await recoveredObjectRuntime.connect();
    try {
      await recoveredObjectClient.query("SET ROLE napplet_production_object");
      for (const table of ["funding_accounts", "checkpoint_crypto_records", "checkpoint_object_key_custody", "immutable_object_generations"]) {
        await expect(recoveredObjectClient.query(`SELECT * FROM production_real.${table} LIMIT 1`)).rejects.toThrow();
      }
    } finally { recoveredObjectClient.release(); }
    const copies = custody.inventory(sealed.envelope.crypto.keyReference);
    expect(copies).toHaveLength(2);
    now += THIRTY_DAY_RETENTION_MS;
    await expect(open(recoveredPool, recoveredObjects, recoveredCrypto).restore({ checkpointId: `checkpoint:${suffix}`, accountId, sessionId })).rejects.toThrow("CHECKPOINT_RESTORE_DENIED");
    await cryptoPort.destroy(sealed.envelope.crypto.keyReference);
    now -= 1;
    await expect(open(recoveredPool, recoveredObjects, recoveredCrypto).restore({ checkpointId: `checkpoint:${suffix}`, accountId, sessionId })).rejects.toThrow("CHECKPOINT_RESTORE_DENIED");
    expect(await cryptoPort.isDestroyed(sealed.envelope.crypto.keyReference)).toBe(true);

    const binding = { accountId, sessionId, actionId: `action:direct:${suffix}`, operationId: `operation:direct:${suffix}`, retentionUntil: new Date(now + THIRTY_DAY_RETENTION_MS).toISOString() };
    const concurrentCheckpoint = `checkpoint:concurrent:${suffix}`, concurrentPlaintext = new TextEncoder().encode("concurrent custody");
    const concurrentA = new PerObjectFileCheckpointCrypto({ pool: raw, custody, now: () => now });
    const concurrentB = new PerObjectFileCheckpointCrypto({ pool: raw, custody, now: () => now });
    const [concurrentOne, concurrentTwo] = await Promise.all([
      concurrentA.seal({ checkpointId: concurrentCheckpoint, plaintext: concurrentPlaintext, additionalData: new TextEncoder().encode("direct-aad"), binding }),
      concurrentB.seal({ checkpointId: concurrentCheckpoint, plaintext: concurrentPlaintext, additionalData: new TextEncoder().encode("direct-aad"), binding }),
    ]);
    expect(concurrentOne).toEqual(concurrentTwo);
    expect(await concurrentA.open({ ...concurrentOne, additionalData: new TextEncoder().encode("direct-aad") })).toEqual(concurrentPlaintext);

    const lostCheckpoint = `checkpoint:lost-commit:${suffix}`, lostBinding = { ...binding, actionId: `action:lost:${suffix}`, operationId: `operation:lost:${suffix}` };
    const uncertain = new PerObjectFileCheckpointCrypto({ pool: lostCommitAfterCryptoInsertPool(runtime!), custody, now: () => now });
    const lostPlaintext = new TextEncoder().encode("unknown commit custody");
    await expect(uncertain.seal({ checkpointId: lostCheckpoint, plaintext: lostPlaintext, additionalData: new TextEncoder().encode("lost-aad"), binding: lostBinding })).rejects.toThrow("SIMULATED_COMMIT_ACK_LOSS");
    const reconciled = new PerObjectFileCheckpointCrypto({ pool: raw, custody, now: () => now });
    const replay = await reconciled.seal({ checkpointId: lostCheckpoint, plaintext: lostPlaintext, additionalData: new TextEncoder().encode("lost-aad"), binding: lostBinding });
    expect(await reconciled.open({ ...replay, additionalData: new TextEncoder().encode("lost-aad") })).toEqual(lostPlaintext);
    const durableCustody = await admin.query("SELECT state FROM production_real.checkpoint_object_key_custody WHERE checkpoint_id=$1", [lostCheckpoint]);
    expect(durableCustody.rows).toEqual([{ state: "active" }]);

    const boundaryCheckpoint = `checkpoint:erase-boundary:${suffix}`, boundaryBinding = { ...binding, actionId: `action:erase:${suffix}`, operationId: `operation:erase:${suffix}` };
    const boundary = await reconciled.seal({ checkpointId: boundaryCheckpoint, plaintext: new TextEncoder().encode("erase boundary"), additionalData: new TextEncoder().encode("erase-aad"), binding: boundaryBinding });
    const failingDestroy = new PerObjectFileCheckpointCrypto({ pool: raw, custody: new FailOnceEraseCustody({ roots }), now: () => now });
    await expect(failingDestroy.destroy(boundary.keyReference)).rejects.toThrow("SIMULATED_FILESYSTEM_ERASE_FAILURE");
    expect((await admin.query("SELECT state FROM production_real.checkpoint_object_key_custody WHERE checkpoint_id=$1", [boundaryCheckpoint])).rows).toEqual([{ state: "erasing" }]);
    await expect(reconciled.open({ ...boundary, additionalData: new TextEncoder().encode("erase-aad") })).rejects.toThrow("CHECKPOINT_RESTORE_DENIED");
    await reconciled.destroy(boundary.keyReference);
    expect(await reconciled.isDestroyed(boundary.keyReference)).toBe(true);

    const confirmationCheckpoint = `checkpoint:erase-confirmation:${suffix}`, confirmationBinding = { ...binding, actionId: `action:confirm:${suffix}`, operationId: `operation:confirm:${suffix}` };
    const confirmation = await reconciled.seal({ checkpointId: confirmationCheckpoint, plaintext: new TextEncoder().encode("confirmation boundary"), additionalData: new TextEncoder().encode("confirmation-aad"), binding: confirmationBinding });
    const uncertainConfirmation = new PerObjectFileCheckpointCrypto({ pool: raw, custody: new FileObjectKeyCustody({ roots, confirmAbsent: async () => { throw Object.assign(new Error("SIMULATED_CONFIRMATION_UNAVAILABLE"), { code: "EACCES" }); } }), now: () => now });
    await expect(uncertainConfirmation.destroy(confirmation.keyReference)).rejects.toThrow("SIMULATED_CONFIRMATION_UNAVAILABLE");
    expect((await admin.query("SELECT state FROM production_real.checkpoint_object_key_custody WHERE checkpoint_id=$1", [confirmationCheckpoint])).rows).toEqual([{ state: "erasing" }]);
    expect(await uncertainConfirmation.isDestroyed(confirmation.keyReference)).toBe(false);
    await reconciled.destroy(confirmation.keyReference);
    expect(await reconciled.isDestroyed(confirmation.keyReference)).toBe(true);
  } finally {
    await recoveredObjectRuntime?.end(); await recoveredRuntime?.end(); await recoveredAdmin?.end(); await objectRuntime?.end(); await runtime?.end();
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

integration("trusted PostgreSQL 17 custom dumps are independently encrypted, generation-pinned, and replayed without treating checkpoint ciphertext as the backup", async () => {
  const container = postgres17Container; if (!container) throw new Error("POSTGRES17_CLIENT_REQUIRED");
  const admin = new Pool({ connectionString });
  const suffix = crypto.randomUUID().replaceAll("-", "").slice(0, 16);
  const role = `restore_object_${suffix}`, database = `restore_source_${suffix}`;
  const roots = [await mkdtemp(join(tmpdir(), "cvm-restore-live-")), await mkdtemp(join(tmpdir(), "cvm-restore-key-copy-"))];
  const priorImage = process.env.NAPPLET_TRUSTED_RESTORER_IMAGE;
  let fixture: Pool | undefined;
  try {
    await admin.query(`CREATE DATABASE ${database}`);
    fixture = new Pool({ connectionString: connectionString!.replace(/\/postgres(?:\?.*)?$/u, `/${database}`) });
    for (const file of ["phase-03/001_funding.sql", "phase-04/001_metered_generation.sql", "phase-04/002_action_budget_lifecycle.sql", "phase-05/001_continuation.sql", "phase-06/001_publication.sql", "phase-03/002_production_accounting.sql", "phase-07/001_production_operation_journal.sql", "phase-07/003_production_checkpoints.sql", "phase-07/019_postgres_bytea_objects.sql"]) await fixture.query(await Bun.file(`migrations/${file}`).text());
    await fixture.query(`CREATE ROLE ${role} LOGIN`); await fixture.query(`GRANT napplet_production_real TO ${role}`); await fixture.query(`GRANT napplet_production_object TO ${role}`);
    const runtime = new Pool({ connectionString: connectionString!.replace(/\/\/[^@]+@/u, `//${role}@`).replace(/\/postgres(?:\?.*)?$/u, `/${database}`) });
    try {
      const pool = sqlPool(runtime);
      const now = Date.parse("2030-01-01T00:00:00.000Z");
      const objects = new PostgresByteaObjectStoreAdapter({ pool, now: () => now, retentionUntil: () => new Date(now + THIRTY_DAY_RETENTION_MS).toISOString(), producerBudget: ObjectProducerBudgets.migration_archive });
      const custody = new FileObjectKeyCustody({ roots });
      const cryptoPort = new PerObjectFileCheckpointCrypto({ pool, custody, now: () => now });
      const image = `sha256:${"a".repeat(64)}`;
      process.env.NAPPLET_TRUSTED_RESTORER_IMAGE = image;
      let dumps = 0;
      const runner: NativeCommandRunner = Object.freeze({ async run(command) {
        const argv = [...command];
        if (argv[0] === "pg_dump") {
          dumps++;
          const file = argv.indexOf("--file"); if (file < 0 || !argv[file + 1]) throw new Error("FIXTURE_DUMP_FILE_REQUIRED");
          const hostPath = argv[file + 1]!;
          const containerPath = `/tmp/napplet-${suffix}.dump`;
          argv[file + 1] = containerPath;
          const stdout = await run(postgres17Command("pg_dump", ...argv.slice(1)));
          await run(["docker", "cp", `${container}:${containerPath}`, hostPath]);
          await run(["docker", "exec", "-i", container, "rm", "-f", containerPath]);
          return Object.freeze({ exitCode: 0, stdout: new TextEncoder().encode(stdout), stderr: new Uint8Array() });
        }
        if (argv[0] !== "psql") throw new Error("FIXTURE_TRUSTED_COMMAND_REQUIRED");
        const stdout = await run(postgres17Command("psql", ...argv.slice(1)));
        return Object.freeze({ exitCode: 0, stdout: new TextEncoder().encode(stdout), stderr: new Uint8Array() });
      } });
      const coolify = new NonGoogleCoolifyDriver({ baseOrigin: "https://coolify.fixture.invalid", serverUuid: "00000000-0000-4000-8000-000000000001", projectUuid: "00000000-0000-4000-8000-000000000002", environmentUuid: "00000000-0000-4000-8000-000000000003", postgres17Image: image, restorerImage: image, namePrefix: "restore-fixture", tokenPath: "/fixture/coolify-token" });
      const driver = new NonGoogleFreshRestoreDriver(coolify, { sourceDatabaseUrlPath: "/fixture/source-url", freshDatabaseUrlPath: "/fixture/fresh-url", archiveRoot: "/fixture/archive", trustedRestorerName: "trusted-restorer", expectedPostgresMajor: 17 }, runner, async path => {
        if (path !== "/fixture/source-url") throw new Error("FIXTURE_UNEXPECTED_SECRET");
        return `postgresql://postgres@127.0.0.1:5432/${database}`;
      });
      const backup = await driver.captureCustomBackup();
      expect(dumps).toBe(1); expect(new TextDecoder().decode(backup.slice(0, 5))).toBe("PGDMP");
      const scope = { checkpointId: `checkpoint:${suffix}`, sessionId: `session:${suffix}`, ownerId: "b".repeat(64), sourceAuthorityReference: `source:${suffix}` };
      const binding = { candidateSha256: "c".repeat(64), topologySha256: "d".repeat(64) };
      const checkpointId = `restore-backup:${suffix}`;
      const aad = new TextEncoder().encode(JSON.stringify({ scope, binding }));
      const sealed = await cryptoPort.seal({ checkpointId, plaintext: backup, additionalData: aad, binding: { accountId: "restore", sessionId: scope.sessionId, actionId: scope.checkpointId, operationId: `restore:${suffix}`, retentionUntil: new Date(now + THIRTY_DAY_RETENTION_MS).toISOString() } });
      const stored = await cryptoPort.readSealed(checkpointId); if (!stored) throw new Error("FIXTURE_BACKUP_CUSTODY_REQUIRED");
      expect(Buffer.from(stored.ciphertext).subarray(0, 5).toString()).not.toBe("PGDMP");
      const archive = await objects.createImmutable({ key: `restore-backups/${checkpointId}/${stored.ciphertextSha256}`, bytes: stored.ciphertext, originalOperationIdentity: "e".repeat(64) });
      const journal = new PostgresOperationJournal(pool, { namespace: `restore-fixture-${suffix}`, scopeSha256: "f".repeat(64) });
      const pull = new PostgresRestorerPullStore(NonGoogleCoreJournal.fromPostgres(journal), objects);
      const job = { originalId: `restore:${suffix}`, candidateSha256: binding.candidateSha256, topologySha256: binding.topologySha256, roleCostBoundSha256: "1".repeat(64), capabilitySha256: "2".repeat(64), archive: { ...archive, byteCount: stored.ciphertext.byteLength }, expiresAtMs: now + THIRTY_DAY_RETENTION_MS };
      await pull.claimJob(job); await pull.claimJob(job); // Lost ACK reconciliation reads the original job only.
      expect(await pull.readJob(job.originalId)).toEqual(job);
      const ciphertext = await pull.readArchive({ ...archive, start: 0, end: stored.ciphertext.byteLength - 1 });
      expect(ciphertext).toEqual(stored.ciphertext);
      expect(await cryptoPort.open({ keyReference: sealed.keyReference, nonce: sealed.nonce, ciphertext: ciphertext!, additionalData: aad })).toEqual(backup);
      backup.fill(0); ciphertext?.fill(0);
    } finally { await runtime.end(); }
  } finally {
    if (priorImage === undefined) delete process.env.NAPPLET_TRUSTED_RESTORER_IMAGE; else process.env.NAPPLET_TRUSTED_RESTORER_IMAGE = priorImage;
    await fixture?.end(); await admin.query(`DROP DATABASE IF EXISTS ${database}`).catch(() => undefined); await admin.query(`REVOKE napplet_production_real FROM ${role}`).catch(() => undefined); await admin.query(`REVOKE napplet_production_object FROM ${role}`).catch(() => undefined); await admin.query(`DROP ROLE IF EXISTS ${role}`).catch(() => undefined);
    await admin.end(); await Promise.all(roots.map(root => rm(root, { recursive: true, force: true })));
  }
}, 60_000);

test("hosted PostgreSQL 17 is mandatory in CI for retention custody proof", () => { if (process.env.CI && (!connectionString || !postgres17Container)) throw new Error("NAPPLET_POSTGRES17_CLIENT_REQUIRED"); });

let now = Date.parse("2030-01-01T00:00:00.000Z");
