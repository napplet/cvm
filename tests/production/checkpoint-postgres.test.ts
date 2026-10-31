import { mkdtemp, readFile, writeFile, unlink, rm, link } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { z } from "zod";
import { canonicalJson } from "../../src/promotion/schema";
import { expect, test } from "bun:test";
import { Pool } from "pg";
import type { PostgresSqlPool } from "../../src/persistence/postgres-sql-funding-store";
import { bindAccountingRealmPool, createAccountingRealm } from "../../src/funding/accounting-realm";
import { FundingService } from "../../src/funding/funding-service";
import { PostgresFundingDatabase } from "../../src/persistence/postgres-funding-database";
import { PostgresOperationJournal } from "../../src/release/deployment/postgres-operation-journal";
import { assertProductionCheckpointSchema } from "../../src/production/checkpoint-schema";
import { ProductionCheckpointCoordinator } from "../../src/production/checkpoint-coordinator";
import { GcsObjectStoreAdapter, type VersionedObjectClientPort, type ObjectStorePort } from "../../src/continuity/object-store";
import type { CheckpointSealRequest } from "../../src/continuity/checkpoint-envelope";

const integration = process.env.NAPPLET_RUN_POSTGRES_ISOLATION === "1" ? test : test.skip;
async function docker(args: string[], input?: string) {
  const child = Bun.spawn(["docker", ...args], { stdin: input === undefined ? "ignore" : "pipe", stdout: "pipe", stderr: "pipe" });
  if (input !== undefined && child.stdin) { child.stdin.write(input); child.stdin.end(); }
  const [out, err, code] = await Promise.all([new Response(child.stdout).text(), new Response(child.stderr).text(), child.exited]);
  if (code) throw new Error(`DOCKER_FAILED:${args[0]}:${err.slice(0, 300)}`);
  return out.trim();
}
function sqlPool(native: Pool): PostgresSqlPool {
  return { async connect() { const client = await native.connect(); return {
    async query<Row extends Record<string, unknown>>(sql: string, values?: readonly unknown[]) { return { rows: (await client.query<Row>(sql, values ? [...values] : undefined)).rows }; },
    release() { client.release(); },
  }; } };
}

integration("restricted SQL checkpoints encrypt, retain originals after lost upload ACK, restore in fresh SQL and erase exact expired material", async () => {
  const name = `cvm-checkpoint-${crypto.randomUUID().replaceAll("-", "")}`;
  let admin: Pool | undefined, native: Pool | undefined, recovered: Pool | undefined, restoredNative: Pool | undefined;
  let objectDirectory: string | undefined;
  try {
    await docker(["run", "--detach", "--rm", "--name", name, "--publish", "127.0.0.1::5432", "-e", "POSTGRES_HOST_AUTH_METHOD=trust", "postgres:17-alpine"]);
    const port = (await docker(["port", name, "5432/tcp"])).match(/127\.0\.0\.1:(\d+)/u)?.[1];
    if (!port) throw new Error("POSTGRES_PORT_MISSING");
    admin = new Pool({ connectionString: `postgresql://postgres@127.0.0.1:${port}/postgres`, connectionTimeoutMillis: 2000 });
    for (let attempt = 0; attempt < 90; attempt++) { try { await admin.query("SELECT 1"); break; } catch (error) { if (attempt === 89) throw error; await Bun.sleep(250); } }
    for (const file of ["phase-03/001_funding.sql", "phase-04/001_metered_generation.sql", "phase-04/002_action_budget_lifecycle.sql", "phase-05/001_continuation.sql", "phase-06/001_publication.sql", "phase-03/002_production_accounting.sql", "phase-07/001_production_operation_journal.sql", "phase-07/002_production_pricing_catalog.sql"]) await admin.query(await Bun.file(`migrations/${file}`).text());
    await admin.query("CREATE ROLE checkpoint_runtime_test LOGIN"); await admin.query("GRANT napplet_production_real TO checkpoint_runtime_test");
    native = new Pool({ connectionString: `postgresql://checkpoint_runtime_test@127.0.0.1:${port}/postgres` });
    const pool = bindAccountingRealmPool(sqlPool(native), createAccountingRealm("production-real"));
    await expect(assertProductionCheckpointSchema(pool)).rejects.toThrow("PRODUCTION_CHECKPOINT_SCHEMA_REQUIRED");
    await admin.query(await Bun.file("migrations/phase-07/003_production_checkpoints.sql").text());
    await admin.query(await Bun.file("migrations/phase-07/003_production_checkpoints.sql").text());
    await assertProductionCheckpointSchema(pool);
    await admin.query("ALTER TABLE production_real.checkpoint_crypto_records DISABLE TRIGGER checkpoint_crypto_immutable");
    await expect(assertProductionCheckpointSchema(pool)).rejects.toThrow("PRODUCTION_CHECKPOINT_SCHEMA_REQUIRED");
    await admin.query("ALTER TABLE production_real.checkpoint_crypto_records ENABLE TRIGGER checkpoint_crypto_immutable");
    await admin.query("GRANT DELETE ON production_real.checkpoint_envelopes TO napplet_production_real");
    await expect(assertProductionCheckpointSchema(pool)).rejects.toThrow("PRODUCTION_CHECKPOINT_SCHEMA_REQUIRED");
    await admin.query("REVOKE DELETE ON production_real.checkpoint_envelopes FROM napplet_production_real");
    await assertProductionCheckpointSchema(pool);
    const funding = new FundingService(new PostgresFundingDatabase(pool, { realm: "production-real" }).funding);
    const credited = await funding.execute({ principal: { pubkey: "7".repeat(64) }, kind: "credit_settlement", idempotencyKey: "checkpoint-fixture-credit", policyVersion: "fixture", protocolVersion: "fixture", payload: { settlement: { topUpId: "fixture", rail: "lightning", unit: "sat", amount: "10", externalReference: "fixture:external", settlementReference: "fixture:settlement", verifiedAt: new Date().toISOString() } } });
    const accountId = credited.accountId, sessionId = "session:checkpoint";
    // Explicit metadata/credit fixtures: no real rail, provider or worker claim.
    await admin.query("INSERT INTO production_real.model_profile_versions VALUES('crypto-profile',$1,'fixture','fixture','{}')", ["1".repeat(64)]);
    await admin.query("INSERT INTO production_real.price_card_versions(id,card_hash,profile_id,unit,normalized_card) VALUES('crypto-price',$1,'crypto-profile','sat','{}')", ["2".repeat(64)]);
    await admin.query("INSERT INTO production_real.metered_sessions(id,account_id,admission_reference,profile_id,price_card_id,version,state) VALUES($1,$2,'fixture:admission','crypto-profile','crypto-price',0,'prepared')", [sessionId, accountId]);
    let now = Date.now(), creates = 0, deletes = 0, loseAck = true, loseDeleteAck = true, failBeforeCreate = false, hideCurrent = false, failReads = false;
    objectDirectory = await mkdtemp(join(tmpdir(), "cvm-checkpoint-objects-"));
    const directory = objectDirectory;
    const StoredObject = z.object({ key: z.string(), generation: z.literal(1), checksum: z.string(), bytesBase64: z.string() }).strict();
    const pathFor = (key: string) => join(directory, new Bun.CryptoHasher("sha256").update(key).digest("hex"));
    const load = async (key: string) => {
      try { return StoredObject.parse(JSON.parse(await readFile(pathFor(key), "utf8"))); }
      catch (error) { if (error && typeof error === "object" && "code" in error && error.code === "ENOENT") return undefined; throw error; }
    };
    // Disk-backed protocol fixture behind the actual GCS adapter: expiry
    // physically unlinks the exact ciphertext, not merely a scheduled marker.
    const disk: VersionedObjectClientPort = {
      async createIfAbsent(value) {
        const temporary = join(directory, crypto.randomUUID());
        try {
          await writeFile(temporary, JSON.stringify({ key: value.key, generation: 1, checksum: value.checksum, bytesBase64: Buffer.from(value.bytes).toString("base64") }), { flag: "wx", mode: 0o600 });
          await link(temporary, pathFor(value.key)); // Atomic whole-object create-if-absent.
          return { generation: 1, checksum: value.checksum };
        } finally { await unlink(temporary).catch(() => undefined); }
      },
      async findExactByKey(value) { if (hideCurrent) return undefined; const record = await load(value.key); return record?.key === value.key && record.checksum === value.checksum ? { generation: record.generation, checksum: record.checksum } : undefined; },
      async readGeneration(value) { const record = await load(value.key); return record?.key === value.key && record.generation === value.generation && record.checksum === value.expectedChecksum ? { generation: record.generation, checksum: record.checksum, bytes: new Uint8Array(Buffer.from(record.bytesBase64, "base64")) } : undefined; },
      async scheduleGenerationDeletion(value) { const record = await load(value.key); if (!record || record.key !== value.key || record.generation !== value.generation || record.checksum !== value.expectedChecksum || Date.parse(value.deleteAfter) > now) throw new Error("FIXTURE_EXACT_DELETION_REQUIRED"); await unlink(pathFor(value.key)); return { generation: value.generation, checksum: value.expectedChecksum }; },
    };
    const objects = new GcsObjectStoreAdapter({ config: { bucket: "test-checkpoint-bucket", projectId: "test-checkpoint-project" }, client: disk });
    const objectPort: ObjectStorePort = {
      reconciliationMode: objects.reconciliationMode,
      async createImmutable(value) { creates++; if (failBeforeCreate) { failBeforeCreate = false; throw new Error("UPLOAD_OUTCOME_UNKNOWN"); } const result = await objects.createImmutable(value); if (loseAck) { loseAck = false; throw new Error("OBJECT_ACK_LOST"); } return result; },
      readExact: value => { if (failReads) throw new Error("GCS_READ_UNAVAILABLE"); return objects.readExact(value); }, observeExactByKey: value => objects.observeExactByKey(value), async scheduleExactDeletion(value, deadline) { deletes++; await objects.scheduleExactDeletion(value, deadline); if (loseDeleteAck) { loseDeleteAck = false; throw new Error("DELETE_ACK_LOST"); } },
    };
    const open = (db = pool, key = Buffer.alloc(32, 9).toString("base64")) => new ProductionCheckpointCoordinator({ pool: db, objectStore: objectPort, journal: new PostgresOperationJournal(db, { namespace: "checkpoint-integration", scopeSha256: "a".repeat(64) }), kekPath: "/mounted/test-kek", readKekFile: async () => key, now: () => now });
    const plaintext = new TextEncoder().encode("private checkpoint workspace bytes; no credentials or user signing keys");
    const request: CheckpointSealRequest = { checkpointId: "checkpoint:original", accountId, sessionId, pauseGeneration: 1, sessionVersion: 0, actionVersion: 0, artifactVersion: 0, workspaceVersion: 0, workspaceLineage: "workspace:checkpoint", action: { actionId: "action:checkpoint", operationId: "operation:checkpoint", ledgerReference: "fixture:admission", pendingActionReference: "pending:checkpoint", idempotencyKey: "checkpoint-original" }, archive: plaintext, inventory: ["harness_state", "workspace", "artifact_lineage", "validation_evidence", "financial_action", "pending_action", "compatibility_metadata"], evidenceSha256: "b".repeat(64), compatibility: { policyVersion: "fixture", modelIdentity: "crypto-profile", nappletSdkIdentity: "crypto-price", toolchainIdentity: "c".repeat(64) }, retentionUntil: new Date(now + 2_592_000_000).toISOString() };
    await expect(open().seal(request)).rejects.toThrow("OBJECT_ACK_LOST");
    const encrypted = await admin.query("SELECT key_reference,nonce,wrap_nonce,wrapped_dek,ciphertext,plaintext_sha256 FROM production_real.checkpoint_crypto_records WHERE checkpoint_id='checkpoint:original'");
    expect(encrypted.rows).toHaveLength(1);
    expect(encrypted.rows[0].nonce.length).toBe(12); expect(encrypted.rows[0].wrapped_dek.length).toBe(48);
    expect(Buffer.from(encrypted.rows[0].ciphertext).includes(Buffer.from(plaintext))).toBe(false);
    const sealed = await open().seal(request);
    expect(creates).toBe(1); // Unknown object write must observe, not upload again.
    expect(await open().restore({ checkpointId: request.checkpointId, accountId, sessionId })).toEqual(plaintext);
    await expect(open(pool, Buffer.alloc(32, 8).toString("base64")).restore({ checkpointId: request.checkpointId, accountId, sessionId })).rejects.toThrow("CHECKPOINT_RESTORE_DENIED");
    await expect(open().loadExact({ checkpointId: request.checkpointId, accountId: "account:foreign", sessionId })).rejects.toThrow("CHECKPOINT_RESTORE_DENIED");
    await expect(open().seal({ ...request, archive: new Uint8Array([1]) })).rejects.toThrow();
    const bound = await pool.connect();
    try {
      await expect(bound.query("UPDATE production_real.checkpoint_crypto_records SET ciphertext=$1 WHERE checkpoint_id=$2", [Buffer.from([0]), request.checkpointId])).rejects.toThrow();
      await expect(bound.query("DELETE FROM production_real.checkpoint_envelopes WHERE checkpoint_id=$1", [request.checkpointId])).rejects.toThrow();
    } finally { bound.release(); }
    // Independent controllers must converge on one original DEK, nonce and
    // object dispatch. A loser can be pending while the winner is writing.
    const concurrent = { ...request, checkpointId: "checkpoint:concurrent" };
    const outcomes = await Promise.allSettled(Array.from({ length: 6 }, () => open().seal(concurrent)));
    for (const outcome of outcomes) if (outcome.status === "rejected") expect(String(outcome.reason)).toContain("CHECKPOINT_OBJECT_RECONCILIATION_REQUIRED");
    const converged = await open().seal(concurrent);
    expect(await open().restore({ checkpointId: concurrent.checkpointId, accountId, sessionId })).toEqual(plaintext);
    expect((await admin.query("SELECT count(*)::int AS count FROM production_real.checkpoint_crypto_records WHERE checkpoint_id=$1", [concurrent.checkpointId])).rows[0].count).toBe(1);
    expect(creates).toBe(2);
    for (const outcome of outcomes) if (outcome.status === "fulfilled") expect(outcome.value).toEqual(converged);
    expect((await admin.query("SELECT count(*)::int AS count FROM production_real.checkpoint_crypto_audit WHERE checkpoint_id=$1 AND event='sealed'", [concurrent.checkpointId])).rows[0].count).toBe(1);
    const unresolved = { ...request, checkpointId: "checkpoint:unresolved" };
    failBeforeCreate = true;
    await expect(open().seal(unresolved)).rejects.toThrow("UPLOAD_OUTCOME_UNKNOWN");
    await expect(open().seal(unresolved)).rejects.toThrow("CHECKPOINT_OBJECT_RECONCILIATION_REQUIRED");
    expect(creates).toBe(3);
    // A pre-dispatch-fence header is preserved. No replacement key, nonce or
    // upload may be invented for its unresolved original operation.
    const legacy = { ...request, checkpointId: "checkpoint:legacy" };
    const digest = (value: string | Uint8Array) => new Bun.CryptoHasher("sha256").update(value).digest("hex");
    const requestSha256 = digest(canonicalJson({ ...legacy, archive: undefined, archiveSha256: digest(legacy.archive) }));
    const journal = new PostgresOperationJournal(pool, { namespace: "checkpoint-integration", scopeSha256: "a".repeat(64) });
    const legacyHeader = { checkpointId: legacy.checkpointId, requestSha256, committedAt: new Date(now).toISOString() };
    await journal.claim(`checkpoint-seal:${legacy.checkpointId}`, requestSha256, legacyHeader);
    await expect(open().seal(legacy)).rejects.toThrow("CHECKPOINT_OBJECT_RECONCILIATION_REQUIRED");
    expect((await journal.read(`checkpoint-seal:${legacy.checkpointId}`))?.value).toEqual(legacyHeader);
    expect((await admin.query("SELECT count(*)::int AS count FROM production_real.checkpoint_crypto_records WHERE checkpoint_id=$1", [legacy.checkpointId])).rows[0].count).toBe(0);
    expect(creates).toBe(3);
    const dump = await docker(["exec", name, "pg_dump", "-U", "postgres", "--schema=production_real", "--no-owner", "--no-privileges", "postgres"]);
    await admin.query("CREATE DATABASE recovered_checkpoint");
    await docker(["exec", "-i", name, "psql", "-U", "postgres", "--set", "ON_ERROR_STOP=1", "--dbname", "recovered_checkpoint"], `${dump}\n`);
    recovered = new Pool({ connectionString: `postgresql://postgres@127.0.0.1:${port}/recovered_checkpoint` });
    await recovered.query("GRANT USAGE ON SCHEMA production_real TO napplet_production_real");
    await recovered.query("GRANT SELECT,INSERT ON production_real.release_operation_journal TO napplet_production_real");
    await recovered.query("GRANT UPDATE(value_json,revision,updated_at) ON production_real.release_operation_journal TO napplet_production_real");
    await recovered.query(await Bun.file("migrations/phase-07/003_production_checkpoints.sql").text());
    restoredNative = new Pool({ connectionString: `postgresql://checkpoint_runtime_test@127.0.0.1:${port}/recovered_checkpoint` });
    const restoredPool = bindAccountingRealmPool(sqlPool(restoredNative), createAccountingRealm("production-real"));
    expect(await open(restoredPool).restore({ checkpointId: request.checkpointId, accountId, sessionId })).toEqual(plaintext);
    expect(creates).toBe(3);
    await assertProductionCheckpointSchema(restoredPool);
    expect((await admin.query("SELECT key_reference,nonce,wrap_nonce,wrapped_dek,ciphertext,plaintext_sha256 FROM production_real.checkpoint_crypto_records WHERE checkpoint_id='checkpoint:original'")).rows).toEqual(encrypted.rows);
    now = Date.parse(request.retentionUntil);
    await expect(open().restore({ checkpointId: request.checkpointId, accountId, sessionId })).rejects.toThrow("CHECKPOINT_RESTORE_DENIED");
    const auditFailure: PostgresSqlPool = { async connect() { const client = await pool.connect(); return {
      async query<Row extends Record<string, unknown>>(sql: string, values?: readonly unknown[]) { if (sql.startsWith("INSERT INTO production_real.checkpoint_crypto_audit")) throw new Error("AUDIT_UNAVAILABLE"); return client.query<Row>(sql, values); },
      release() { client.release(); },
    }; } };
    await expect(open(auditFailure).destroyExpired({ checkpointId: request.checkpointId, accountId, sessionId })).rejects.toThrow("AUDIT_UNAVAILABLE");
    expect((await admin.query("SELECT key_reference,nonce,wrap_nonce,wrapped_dek,ciphertext,plaintext_sha256 FROM production_real.checkpoint_crypto_records WHERE checkpoint_id='checkpoint:original'")).rows).toEqual(encrypted.rows);
    expect(deletes).toBe(0);
    hideCurrent = true; // The exact generation can survive without a current-key match.
    failReads = true;
    await expect(open().destroyExpired({ checkpointId: request.checkpointId, accountId, sessionId })).rejects.toThrow("GCS_READ_UNAVAILABLE");
    expect(deletes).toBe(0);
    failReads = false;
    await expect(open().destroyExpired({ checkpointId: request.checkpointId, accountId, sessionId })).rejects.toThrow("DELETE_ACK_LOST");
    expect(await open().observeDestroyed({ checkpointId: request.checkpointId, accountId, sessionId })).toBe(false);
    await open().destroyExpired({ checkpointId: request.checkpointId, accountId, sessionId });
    await open().destroyExpired({ checkpointId: request.checkpointId, accountId, sessionId });
    expect(deletes).toBe(1);
    expect((await admin.query("SELECT count(*)::int AS count FROM production_real.checkpoint_crypto_audit WHERE event='destroyed'")).rows[0].count).toBe(1);
    await expect(open(restoredPool).restore({ checkpointId: request.checkpointId, accountId, sessionId })).rejects.toThrow("CHECKPOINT_RESTORE_DENIED");
    expect(await open().observeDestroyed({ checkpointId: request.checkpointId, accountId, sessionId })).toBe(true);
    expect((await admin.query("SELECT wrapped_dek,state,octet_length(ciphertext) AS ciphertext_bytes FROM production_real.checkpoint_crypto_records WHERE checkpoint_id=$1", [request.checkpointId])).rows[0]).toEqual({ wrapped_dek: null, state: "destroyed", ciphertext_bytes: 0 });
    expect(await objects.readExact(sealed.envelope.object)).toBeUndefined();
  } finally {
    await restoredNative?.end(); await recovered?.end(); await native?.end(); await admin?.end();
    await docker(["rm", "--force", name]).catch(() => undefined);
    if (objectDirectory) await rm(objectDirectory, { recursive: true, force: true });
  }
}, 120_000);
