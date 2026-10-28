import { listProductionRetentionCandidates } from "../../src/production/checkpoint-retention";
import type { ObjectStorePort } from "../../src/continuity/object-store";
import { FundedAdmissionService } from "../../src/funding/funded-admission";
import { MeteredGenerationService } from "../../src/phase-04/metered-generation-service";
import { ModelProfileSchema, PriceCardSchema, PHASE_04_DETERMINISTIC_PRICE_CARD } from "../../src/model/price-card";
import type { ModelGateway } from "../../src/model/model-gateway";
import type { ArtifactVerifier } from "../../src/phase-02/trusted-core";
import type { WorkerPort } from "../../src/phase-02/contracts";
import { exactReadyReservation, trustedAdmissionReceipt, trustedAdmissionReceiptAuthority } from "../fixtures/admission-ready";
import { expect, test } from "bun:test";
import { Pool } from "pg";
import { canonicalJson } from "../../src/promotion/schema";
import { ProtectedContinuationCommands } from "../../src/continuity/protected-command";
import { loadMountedCheckpointKek } from "../../src/production/checkpoint-crypto";
import { ContinuationService } from "../../src/continuity/continuation-service";
import { ProductionCheckpointCoordinator } from "../../src/production/checkpoint-coordinator";
import { ProductionInitialPendingCheckpoint } from "../../src/production/initial-pending-checkpoint";
import { ContinuationDeadlineReconciler } from "../../src/continuity/deadline-reconciler";
import { PostgresOperationJournal } from "../../src/release/deployment/postgres-operation-journal";
import { GcsObjectStoreAdapter, type VersionedObjectClientPort } from "../../src/continuity/object-store";
import { FundingService } from "../../src/funding/funding-service";
import { PostgresFundingDatabase } from "../../src/persistence/postgres-funding-database";
import type { PostgresSqlPool } from "../../src/persistence/postgres-sql-funding-store";
import type { ContinuationWorkerPort } from "../../src/phase-02/contracts";

const integration = process.env.NAPPLET_RUN_POSTGRES_ISOLATION === "1" ? test : test.skip;
async function docker(args: string[], input?: string) {
  const child = Bun.spawn(["docker", ...args], { stdin: input === undefined ? "ignore" : new TextEncoder().encode(input), stdout: "pipe", stderr: "pipe" });
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

integration("expired checkpoint deletion remains discoverable across a lost ACK and controller restart", async () => {
  const name = `cvm-retention-discovery-${crypto.randomUUID().replaceAll("-", "")}`;
  let admin: Pool | undefined, native: Pool | undefined;
  try {
    await docker(["run", "--detach", "--rm", "--name", name, "--publish", "127.0.0.1::5432", "-e", "POSTGRES_HOST_AUTH_METHOD=trust", "postgres:17-alpine"]);
    const port = (await docker(["port", name, "5432/tcp"])).match(/127\.0\.0\.1:(\d+)/u)?.[1];
    if (!port) throw new Error("POSTGRES_PORT_MISSING");
    admin = new Pool({ connectionString: `postgresql://postgres@127.0.0.1:${port}/postgres`, connectionTimeoutMillis: 2000 });
    for (let attempt = 0; attempt < 90; attempt++) { try { await admin.query("SELECT 1"); break; } catch (error) { if (attempt === 89) throw error; await Bun.sleep(250); } }
    for (const file of ["phase-03/001_funding.sql", "phase-04/001_metered_generation.sql", "phase-04/002_action_budget_lifecycle.sql", "phase-05/001_continuation.sql", "phase-06/001_publication.sql", "phase-03/002_production_accounting.sql", "phase-07/001_production_operation_journal.sql", "phase-07/003_production_checkpoints.sql", "phase-07/005_production_session_caps.sql", "phase-07/006_production_pending_checkpoints.sql"]) await admin.query(await Bun.file(`migrations/${file}`).text());
    const card = PriceCardSchema.parse({ ...PHASE_04_DETERMINISTIC_PRICE_CARD, id: "resume-card", version: "resume-card" });
    const profile = ModelProfileSchema.parse({ id: "resume-profile", provider: "deterministic_fixture", model: "phase-04-fixture-model", priceCardId: card.id, selection: "unselected", deadlineMs: 30000, maximumUnits: [{ dimension: "input_tokens", units: "2" }, { dimension: "output_tokens", units: "1" }, { dimension: "cached_tokens", units: "2" }, { dimension: "reasoning_tokens", units: "3" }] });
    await admin.query("INSERT INTO production_real.model_profile_versions(id,profile_hash,provider,model,normalized_profile) VALUES($1,$2,$3,$4,$5::jsonb)", [profile.id, "c".repeat(64), profile.provider, profile.model, JSON.stringify(profile)]);
    await admin.query("INSERT INTO production_real.price_card_versions(id,card_hash,profile_id,unit,normalized_card) VALUES($1,$2,$3,'sat',$4::jsonb)", [card.id, "d".repeat(64), profile.id, JSON.stringify(card)]);
    await admin.query("CREATE ROLE resumed_generation_test LOGIN"); await admin.query("GRANT napplet_production_real TO resumed_generation_test");
    native = new Pool({ connectionString: `postgresql://resumed_generation_test@127.0.0.1:${port}/postgres` });
    const database = new PostgresFundingDatabase(sqlPool(native), { realm: "production-real" }), store = database.funding;
    const funding = new FundingService(store), principal = { pubkey: "8".repeat(64) };
    let now = Date.now(), allocations = 0, restores = 0, dispatches = 0, lookups = 0, builds = 0;
    // Actual restricted SQL, durable encryption/checkpoint/deadline/consumer.
    // The rail, capacity, object backend, model and build remain explicit fixtures.
    const credit = (key: string, amount: string) => funding.execute({ principal, kind: "credit_settlement", idempotencyKey: key, policyVersion: "fixture", protocolVersion: "fixture", payload: { settlement: { topUpId: key, rail: "lightning", unit: "sat", amount, externalReference: `external:${key}`, settlementReference: `settlement:${key}`, verifiedAt: new Date(now).toISOString() } } });
    const accountId = (await credit("initial", "8")).accountId;
    let releaseAttempts = 0;
    const released = new Set<string>();
    const digest = (value: unknown) => new Bun.CryptoHasher("sha256").update(canonicalJson(value)).digest("hex");
    const capacity = { async reserveNow(value: { intentReference: string }) { return exactReadyReservation(value.intentReference, `capacity:${digest(value.intentReference)}`, new Date(now + 1_200_000).toISOString()); }, async observe(value: { intentReference: string }) { return this.reserveNow(value); }, async release(value: { intentReference: string; reference: string }) { releaseAttempts++; if (!released.has(value.reference)) { released.add(value.reference); } } };
    const admissions = new FundedAdmissionService({ funding, store, capacity, receiptAuthority: trustedAdmissionReceiptAuthority, now: () => now });
    const admissionCommand = { principal, idempotencyKey: "admit", policyVersion: "fixture", protocolVersion: "fixture", payload: { requestedCap: "10", unit: "sat" } };
    const admission = await admissions.admit(admissionCommand, await trustedAdmissionReceipt(admissionCommand));
    if (admission.status !== "accepted") throw new Error("FIXTURE_ADMISSION_REQUIRED");
    const admissionReference = admission.reference;
    const commands = () => new ProtectedContinuationCommands({ reference: "test:kek", load: () => loadMountedCheckpointKek({ kekPath: "/test/kek", readFile: async () => Buffer.alloc(32, 9).toString("base64") }) }, () => now);
    const continuation = new ContinuationService({ store, includeAdmissionHold: true, pendingCommands: commands(), clock: { nowMs: () => now } });

    const noEffect = async (): Promise<never> => { throw new Error("NO_GENERATION_EFFECT_EXPECTED"); };
    const gateway: ModelGateway = { dispatch: noEffect, lookup: noEffect };
    const worker: WorkerPort = { run: noEffect };
    const verifier: ArtifactVerifier = { verify: noEffect };
    const generation = new MeteredGenerationService({ fundedAdmission: admissions, store: database.meteredFunding, gateway, worker, artifactVerifier: verifier, pricing: { card, profile }, continuation, continuationCommands: commands(), toolchainIdentity: "resume-toolchain", clock: { nowMs: () => now } });
    const pending = await generation.startSession({ principal, admissionReference, idempotencyKey: "start", expectedVersion: 0, maximum: "10", policyVersion: "fixture", idea: "Build one focused counter." });
    expect(pending).toMatchObject({ status: "needs_top_up", requiredAdditionalFunding: "2", requiredCapApproval: "2" });
    if (pending.status !== "needs_top_up") throw new Error("NATURAL_PAUSE_REQUIRED");
    expect(dispatches).toBe(0);
    const live = await store.findContinuationPause(accountId, pending.sessionId, 1);
    if (!live?.liveLeaseToken) throw new Error("LIVE_PAUSE_REQUIRED");
    const pool = sqlPool(native);
    // In-memory provider protocol fixture; the real GCS adapter and SQL crypto
    // execute. This is not live cloud or physical storage deletion evidence.
    const entries = new Map<string, { generation: number; checksum: string; bytes: Uint8Array }>();
    const objectClient: VersionedObjectClientPort = {
      async createIfAbsent(value) { const prior = entries.get(value.key); if (prior && prior.checksum !== value.checksum) throw new Error("FIXTURE_IMMUTABLE_CONFLICT"); const entry = prior ?? { generation: 1, checksum: value.checksum, bytes: new Uint8Array(value.bytes) }; entries.set(value.key, entry); return { generation: entry.generation, checksum: entry.checksum }; },
      async findExactByKey(value) { const entry = entries.get(value.key); return entry?.checksum === value.checksum ? { generation: entry.generation, checksum: entry.checksum } : undefined; },
      async readGeneration(value) { const entry = entries.get(value.key); return entry?.generation === value.generation && entry.checksum === value.expectedChecksum ? { ...entry, bytes: new Uint8Array(entry.bytes) } : undefined; },
      async scheduleGenerationDeletion(value) { const entry = entries.get(value.key); if (!entry || entry.generation !== value.generation || entry.checksum !== value.expectedChecksum || Date.parse(value.deleteAfter) > now) throw new Error("FIXTURE_EXACT_DELETE_REQUIRED"); entry.bytes.fill(0); entries.delete(value.key); return { generation: entry.generation, checksum: entry.checksum }; },
    };
    const objects = new GcsObjectStoreAdapter({ config: { bucket: "retention-test-bucket", projectId: "retention-test-project" }, client: objectClient });
    let deletes = 0;
    const objectPort: ObjectStorePort = {
      createImmutable: value => objects.createImmutable(value),
      readExact: value => objects.readExact(value),
      observeExactByKey: value => objects.observeExactByKey(value),
      async scheduleExactDeletion(value, deadline) { deletes++; await objects.scheduleExactDeletion(value, deadline); throw new Error("FIXTURE_LOST_DELETE_ACK"); },
    };
    const checkpoint = () => new ProductionCheckpointCoordinator({ pool, objectStore: objectPort, journal: new PostgresOperationJournal(pool, { namespace: "retention-discovery", scopeSha256: "a".repeat(64) }), kekPath: "/test/kek", readKekFile: async () => Buffer.alloc(32, 9).toString("base64"), now: () => now });
    const initial = new ProductionInitialPendingCheckpoint({ pool, checkpoint: checkpoint(), capacity, commands: commands(), now: () => now });
    const forbiddenWorkspace: ContinuationWorkerPort = { ...worker, fenceCheckpoint: noEffect, exportCheckpoint: noEffect, terminateCheckpoint: noEffect, restoreCheckpoint: noEffect };
    const candidate = { accountId, sessionId: pending.sessionId, pauseGeneration: 1, liveLeaseToken: live.liveLeaseToken };
    const open = () => new ContinuationDeadlineReconciler({ store, worker: forbiddenWorkspace, envelope: checkpoint(), retention: checkpoint(), initialPending: initial, clock: { nowMs: () => now }, candidates: { async listDue() { return [candidate]; }, listRetentionDue: value => listProductionRetentionCandidates(pool, value) } });
    now = live.graceDeadlineMs;
    expect((await open().scan())[0]?.status).toBe("checkpointed");
    const committed = await store.findContinuationCheckpointForSession(accountId, pending.sessionId);
    if (!committed) throw new Error("COMMITTED_CHECKPOINT_REQUIRED");
    expect(await listProductionRetentionCandidates(pool, now)).toEqual([]);
    await expect(listProductionRetentionCandidates(pool, Number.NaN)).rejects.toThrow("RETENTION_CLOCK_REQUIRED");
    // A deletion record for another generation must not hide this original.
    await admin.query("INSERT INTO production_real.continuation_deletions(checkpoint_id,object_generation,attempt,state) VALUES($1,'999',1,'deleted')", [committed.checkpointId]);
    now = committed.retentionDeadlineMs;
    expect(await listProductionRetentionCandidates(pool, now)).toEqual([{ accountId, sessionId: pending.sessionId, pauseGeneration: 1, checkpointId: committed.checkpointId }]);
    expect(await open().scanRetention()).toMatchObject([{ status: "deletion_pending", code: "RETENTION_DELETE_RECONCILIATION" }]);
    expect(deletes).toBe(1);
    expect((await store.findContinuationCheckpointForSession(accountId, pending.sessionId))?.state).toBe("expired");
    // A fresh discovery/reconciler has no remembered candidate or result.
    expect(await listProductionRetentionCandidates(pool, now)).toHaveLength(1);
    expect(await open().scanRetention()).toMatchObject([{ status: "expired" }]);
    expect(deletes).toBe(1);
    expect(await checkpoint().observeDestroyed({ checkpointId: committed.checkpointId, accountId, sessionId: pending.sessionId })).toBe(true);
    expect(await listProductionRetentionCandidates(pool, now)).toEqual([]);
    expect(await open().scanRetention()).toEqual([]);
    expect((await admin.query("SELECT count(*)::int AS count FROM production_real.checkpoint_crypto_audit WHERE event='destroyed'")).rows[0].count).toBe(1);
    expect({ allocations, restores, dispatches, lookups, builds }).toEqual({ allocations: 0, restores: 0, dispatches: 0, lookups: 0, builds: 0 });
  } finally { await native?.end(); await admin?.end(); await docker(["rm", "--force", name]).catch(() => undefined); }
}, 120_000);
