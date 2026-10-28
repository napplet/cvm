import { SessionCapApprovalService } from "../../src/funding/session-cap";
import { FundedAdmissionService } from "../../src/funding/funded-admission";
import { MeteredGenerationService } from "../../src/phase-04/metered-generation-service";
import { ModelProfileSchema, PriceCardSchema, PHASE_04_DETERMINISTIC_PRICE_CARD } from "../../src/model/price-card";
import type { ModelGateway, NormalizedUsageReceipt } from "../../src/model/model-gateway";
import type { ArtifactVerifier } from "../../src/phase-02/trusted-core";
import type { WorkerPort } from "../../src/phase-02/contracts";
import { exactReadyReservation, trustedAdmissionReceipt, trustedAdmissionReceiptAuthority } from "../fixtures/admission-ready";
import { expect, test } from "bun:test";
import { Pool } from "pg";
import { canonicalJson } from "../../src/promotion/schema";
import { ProtectedContinuationCommands } from "../../src/continuity/protected-command";
import { loadMountedCheckpointKek } from "../../src/production/checkpoint-crypto";
import { ContinuationService } from "../../src/continuity/continuation-service";
import { validatePendingCommandCheckpointArchive } from "../../src/continuity/checkpoint-envelope";
import { ProductionCheckpointCoordinator } from "../../src/production/checkpoint-coordinator";
import { ProductionInitialPendingCheckpoint } from "../../src/production/initial-pending-checkpoint";
import { ContinuationDeadlineReconciler } from "../../src/continuity/deadline-reconciler";
import { PostgresOperationJournal } from "../../src/release/deployment/postgres-operation-journal";
import { DeterministicObjectStore } from "../../src/continuity/object-store";
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

integration("initial admitted command checkpoints without a workspace and recovers commit and capacity release acknowledgements", async () => {
  const name = `cvm-initial-pending-${crypto.randomUUID().replaceAll("-", "")}`;
  let admin: Pool | undefined, native: Pool | undefined, recovered: Pool | undefined;
  try {
    await docker(["run", "--detach", "--rm", "--name", name, "--publish", "127.0.0.1::5432", "-e", "POSTGRES_HOST_AUTH_METHOD=trust", "postgres:17-alpine"]);
    const port = (await docker(["port", name, "5432/tcp"])).match(/127\.0\.0\.1:(\d+)/u)?.[1];
    if (!port) throw new Error("POSTGRES_PORT_MISSING");
    admin = new Pool({ connectionString: `postgresql://postgres@127.0.0.1:${port}/postgres`, connectionTimeoutMillis: 2000 });
    for (let attempt = 0; attempt < 90; attempt++) { try { await admin.query("SELECT 1"); break; } catch (error) { if (attempt === 89) throw error; await Bun.sleep(250); } }
    for (const file of ["phase-03/001_funding.sql", "phase-04/001_metered_generation.sql", "phase-04/002_action_budget_lifecycle.sql", "phase-05/001_continuation.sql", "phase-06/001_publication.sql", "phase-03/002_production_accounting.sql", "phase-07/001_production_operation_journal.sql", "phase-07/003_production_checkpoints.sql", "phase-07/005_production_session_caps.sql"]) await admin.query(await Bun.file(`migrations/${file}`).text());
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
    const capacity = { async reserveNow(value: { intentReference: string }) { return exactReadyReservation(value.intentReference, `capacity:${digest(value.intentReference)}`, new Date(now + 1_200_000).toISOString()); }, async observe(value: { intentReference: string }) { return this.reserveNow(value); }, async release(value: { intentReference: string; reference: string }) { releaseAttempts++; if (!released.has(value.reference)) { released.add(value.reference); throw new Error("FIXTURE_LOST_CAPACITY_RELEASE_ACK"); } } };
    const admissions = new FundedAdmissionService({ funding, store, capacity, receiptAuthority: trustedAdmissionReceiptAuthority, now: () => now });
    const admissionCommand = { principal, idempotencyKey: "admit", policyVersion: "fixture", protocolVersion: "fixture", payload: { requestedCap: "10", unit: "sat" } };
    const admission = await admissions.admit(admissionCommand, await trustedAdmissionReceipt(admissionCommand));
    if (admission.status !== "accepted") throw new Error("FIXTURE_ADMISSION_REQUIRED");
    const admissionReference = admission.reference;
    const commands = () => new ProtectedContinuationCommands({ reference: "test:kek", load: () => loadMountedCheckpointKek({ kekPath: "/test/kek", readFile: async () => Buffer.alloc(32, 9).toString("base64") }) }, () => now);
    const continuation = new ContinuationService({ store, includeAdmissionHold: true, pendingCommands: commands(), clock: { nowMs: () => now } });

    let receipt: NormalizedUsageReceipt | undefined;
    const gateway: ModelGateway = { async dispatch(intent) { dispatches++; receipt = { operationId: intent.operationId, providerRequestId: intent.providerRequestId, provider: "deterministic_fixture", model: "phase-04-fixture-model", profileId: intent.profileId, priceCardId: intent.priceCardId, selection: "unselected", completedAt: new Date(now).toISOString(), provenance: { protectedEvidenceReference: "fixture:receipt" }, usage: [{ dimension: "input_tokens", units: "2" }, { dimension: "output_tokens", units: "1" }] }; throw new Error("FIXTURE_LOST_PROVIDER_ACK"); }, async lookup(intent) { lookups++; if (!receipt || receipt.operationId !== intent.operationId) throw new Error("ORIGINAL_RECEIPT_REQUIRED"); return { status: "receipt_found", receipt }; } };
    const worker: WorkerPort = { async run(request) { builds++; return { status: "completed", code: "WORKER_PROPOSALS_VALIDATED", events: [{ kind: "progress", turn: 1, detail: "explicit protocol fixture completed" }], artifact: { sessionId: request.sessionId, actionId: request.actionId, expectedVersion: request.expectedVersion, policyVersion: request.policyVersion, capabilityGrant: request.capabilityGrant, workspaceId: request.workspaceId, artifactId: "fixture:artifact", purpose: { kind: "focused", statements: ["one counter"] }, surface: { hasBackend: false, hasSecondPurpose: false, serviceWorker: false, dynamicAuthority: false }, dependencies: { appOwnedSignerOrRelay: false, privateNappletImport: false }, capabilities: { declaredHard: [], observedDomains: [], optionalIntentPresenceRead: false, intentUsedThroughSdk: false }, upstream: { scanner: { verdict: "pass", checkId: "upstream:fixture-scanner" }, conformance: { verdict: "pass", checkId: "upstream:fixture-browser" } } } }; } };
    const verifier: ArtifactVerifier = { async verify(facts) { if (facts.result.status !== "completed") return undefined; return { artifact: { artifactId: facts.result.artifact.artifactId, artifactSha256: "a".repeat(64), scannerReportSha256: "b".repeat(64), conformanceReportSha256: "c".repeat(64) }, contractInput: facts.result.artifact }; } };
    const generation = new MeteredGenerationService({ fundedAdmission: admissions, store: database.meteredFunding, gateway, worker, artifactVerifier: verifier, pricing: { card, profile }, continuation, continuationCommands: commands(), toolchainIdentity: "resume-toolchain", clock: { nowMs: () => now } });
    const pending = await generation.startSession({ principal, admissionReference, idempotencyKey: "start", expectedVersion: 0, maximum: "10", policyVersion: "fixture", idea: "Build one focused counter." });
    expect(pending).toMatchObject({ status: "needs_top_up", requiredAdditionalFunding: "2", requiredCapApproval: "2" });
    if (pending.status !== "needs_top_up") throw new Error("NATURAL_PAUSE_REQUIRED");
    expect(dispatches).toBe(0);
    const live = await store.findContinuationPause(accountId, pending.sessionId, 1);
    if (!live?.liveLeaseToken) throw new Error("LIVE_PAUSE_REQUIRED");
    const changed = new MeteredGenerationService({ fundedAdmission: admissions, store: database.meteredFunding, gateway, worker, artifactVerifier: verifier, pricing: { card, profile }, continuationCommands: commands(), toolchainIdentity: "changed-toolchain" });
    await expect(changed.prepareContinuation(live.intent)).rejects.toThrow("CONTINUATION_EXECUTION_COMPATIBILITY_DENIED");
    const foreignSettlement = new MeteredGenerationService({ fundedAdmission: admissions, store: database.meteredFunding, gateway, worker, artifactVerifier: verifier, pricing: { card, profile }, continuationCommands: commands(), toolchainIdentity: "resume-toolchain", settlement: { async prepare() { throw new Error("MUST_NOT_REPRICE"); }, async finalize() { throw new Error("MUST_NOT_SETTLE"); } } });
    await expect(foreignSettlement.prepareContinuation(live.intent)).rejects.toThrow("CONTINUATION_ORIGINAL_SETTLEMENT_REQUIRED");
    const missingSettlement = new MeteredGenerationService({ fundedAdmission: admissions, store: database.meteredFunding, gateway, worker, artifactVerifier: verifier, pricing: { card: { ...card, currency: "usd_micros" }, profile }, continuationCommands: commands(), toolchainIdentity: "resume-toolchain" });
    await expect(missingSettlement.prepareContinuation(live.intent)).rejects.toThrow("CONTINUATION_ORIGINAL_SETTLEMENT_REQUIRED");
    expect((await admin.query("SELECT count(*)::int AS count FROM production_real.metered_actions")).rows[0].count).toBe(0);
    now = pending.graceDeadlineMs + 5000;
    await credit("increase", "2");
    await new SessionCapApprovalService(store).approve({ principal, sessionId: pending.sessionId, admissionReference, idempotencyKey: "approve", expectedApprovedCap: "8", maximum: "10", unit: "sat", policyVersion: "fixture", protocolVersion: "fixture" }, { consentReference: `nostr:${"e".repeat(64)}` });
    const objects = new DeterministicObjectStore();
    const pool = sqlPool(native);
    const checkpoint = () => new ProductionCheckpointCoordinator({ pool, objectStore: objects, journal: new PostgresOperationJournal(pool, { namespace: "initial-pending", scopeSha256: "a".repeat(64) }), kekPath: "/test/kek", readKekFile: async () => Buffer.alloc(32, 9).toString("base64"), now: () => now });
    const initial = () => new ProductionInitialPendingCheckpoint({ pool, checkpoint: checkpoint(), capacity, commands: commands(), now: () => now });
    // A historical v1 archive is a format fixture, not a workspace claim.
    const legacy = await checkpoint().seal({ checkpointId: "checkpoint:legacy-read-fixture", accountId, sessionId: pending.sessionId, pauseGeneration: 0, sessionVersion: 0, actionVersion: 0, artifactVersion: 0, workspaceVersion: 0, workspaceLineage: "workspace:legacy-format-fixture", action: { actionId: "action:legacy-format-fixture", operationId: "operation:legacy-format-fixture", ledgerReference: admissionReference, pendingActionReference: "pending:legacy-format-fixture", idempotencyKey: "legacy:fixture" }, archive: new TextEncoder().encode("synthetic legacy format fixture"), inventory: ["harness_state", "workspace", "artifact_lineage", "validation_evidence", "financial_action", "pending_action", "compatibility_metadata"], evidenceSha256: "e".repeat(64), compatibility: { policyVersion: "fixture", modelIdentity: profile.id, nappletSdkIdentity: card.id, toolchainIdentity: "resume-toolchain" }, retentionUntil: new Date(now + 2_592_000_000).toISOString() });
    await expect(initial().seal(live)).rejects.toThrow("PRODUCTION_PENDING_CHECKPOINT_SCHEMA_REQUIRED");
    expect(objects.entries()).toHaveLength(1);
    const expansion = await Bun.file("migrations/phase-07/006_production_pending_checkpoints.sql").text();
    await admin.query(expansion); await admin.query(expansion);
    expect(await checkpoint().loadExact({ checkpointId: legacy.manifest.checkpointId, accountId, sessionId: pending.sessionId })).toEqual(legacy);
    await expect(initial().seal(live)).rejects.toThrow("INITIAL_PENDING_CHECKPOINT_SQL_AUTHORITY_REQUIRED");

    const forbiddenWorkspace: ContinuationWorkerPort = { ...worker, async fenceCheckpoint() { throw new Error("NO_WORKSPACE_TO_FENCE"); }, async exportCheckpoint() { throw new Error("NO_WORKSPACE_TO_EXPORT"); }, async terminateCheckpoint() { throw new Error("NO_WORKSPACE_TO_TERMINATE"); }, async restoreCheckpoint() { restores++; throw new Error("NO_WORKSPACE_TO_RESTORE"); } };
    const candidate = { accountId, sessionId: pending.sessionId, pauseGeneration: 1, liveLeaseToken: live.liveLeaseToken };
    const deadlines = new ContinuationDeadlineReconciler({ store, worker: forbiddenWorkspace, envelope: checkpoint(), initialPending: initial(), clock: { nowMs: () => now }, candidates: { async listDue() { return [candidate]; } } });
    deadlines.failNext("before_commit");
    expect(await deadlines.scan()).toMatchObject([{ status: "checkpoint_retryable", code: "CHECKPOINT_COMMIT_RETRYABLE" }]);
    expect(objects.entries()).toHaveLength(2);
    const originalCiphertext = (await admin.query("SELECT nonce,wrap_nonce,wrapped_dek,ciphertext FROM production_real.checkpoint_crypto_records")).rows;
    expect((await admin.query("SELECT count(*)::int AS count FROM production_real.continuation_checkpoints")).rows[0].count).toBe(0);
    expect(releaseAttempts).toBe(0);
    now += 5000;
    deadlines.failNext("after_commit");
    expect(await deadlines.scan()).toMatchObject([{ status: "checkpoint_retryable", code: "CHECKPOINT_COMMIT_RETRYABLE" }]);
    expect(objects.entries()).toHaveLength(2);
    expect((await admin.query("SELECT nonce,wrap_nonce,wrapped_dek,ciphertext FROM production_real.checkpoint_crypto_records")).rows).toEqual(originalCiphertext);
    const committed = await store.findContinuationCheckpointForSession(accountId, pending.sessionId);
    if (!committed) throw new Error("COMMITTED_CHECKPOINT_REQUIRED");
    const checkpointId = committed.checkpointId;
    const material = await checkpoint().loadExact({ checkpointId, accountId, sessionId: pending.sessionId });
    expect(material.manifest).toMatchObject({ schemaVersion: "checkpoint-manifest-v2", payloadKind: "pending_command", inventory: ["admission_state", "compatibility_metadata", "pending_action"] });
    expect(JSON.stringify(material)).not.toContain("Build one focused counter.");
    expect(committed.retentionDeadlineMs).toBe(Date.parse(material.manifest.retentionUntil));
    expect(committed.checkpointCommittedAtMs).toBe(Date.parse(material.manifest.committedAt));
    const dump = await docker(["exec", name, "pg_dump", "-U", "postgres", "--schema=production_real", "--no-owner", "postgres"]);
    await admin.query("CREATE DATABASE recovered_pending");
    await docker(["exec", "-i", name, "psql", "-U", "postgres", "--set", "ON_ERROR_STOP=1", "--dbname", "recovered_pending"], `${dump}\n`);
    recovered = new Pool({ connectionString: `postgresql://resumed_generation_test@127.0.0.1:${port}/recovered_pending` });
    const recoveredPool = sqlPool(recovered);
    const recoveredCheckpoint = new ProductionCheckpointCoordinator({ pool: recoveredPool, objectStore: objects, journal: new PostgresOperationJournal(recoveredPool, { namespace: "initial-pending", scopeSha256: "a".repeat(64) }), kekPath: "/test/kek", readKekFile: async () => Buffer.alloc(32, 9).toString("base64"), now: () => now });
    expect(await recoveredCheckpoint.loadExact({ checkpointId, accountId, sessionId: pending.sessionId })).toEqual(material);
    expect(await recoveredCheckpoint.loadExact({ checkpointId: legacy.manifest.checkpointId, accountId, sessionId: pending.sessionId })).toEqual(legacy);
    expect(validatePendingCommandCheckpointArchive(await recoveredCheckpoint.restore({ checkpointId, accountId, sessionId: pending.sessionId }), live.intent)).toMatchObject({ idea: "Build one focused counter." });
    await expect(recoveredCheckpoint.loadExact({ checkpointId, accountId: "account:foreign", sessionId: pending.sessionId })).rejects.toThrow("CHECKPOINT_RESTORE_DENIED");

    expect(await initial().reconcileReleases()).toMatchObject([{ checkpointId, status: "pending" }]);
    expect(await initial().reconcileReleases()).toMatchObject([{ checkpointId, status: "released" }]);
    expect(await initial().reconcileReleases()).toEqual([]);
    expect(releaseAttempts).toBe(2);
    expect([...released]).toEqual([admissionReference]);
    expect((await funding.status(principal)).held).toBe("10");
    expect((await admin.query("SELECT count(*)::int AS count FROM production_real.metered_actions")).rows[0].count).toBe(0);
    const innerExpiry = live.intent.protectedCommand?.retentionUntilMs;
    if (!innerExpiry) throw new Error("ORIGINAL_LIVE_COMMAND_EXPIRY_REQUIRED");
    now = innerExpiry + 1;
    expect(now).toBeLessThan(committed.retentionDeadlineMs);
    await expect(commands().open(live.intent)).rejects.toThrow("CONTINUATION_COMMAND_RESTORE_DENIED");
    let terminalWrite = false, lostTerminalAcknowledgement = false;
    const originalPool = sqlPool(native);
    const lossyPool: PostgresSqlPool = { async connect() { const client = await originalPool.connect(); return {
      async query<Row extends Record<string, unknown>>(sql: string, values?: readonly unknown[]) {
        const result = await client.query<Row>(sql, values);
        if (sql.startsWith("UPDATE continuation_pauses SET state='completed'")) terminalWrite = true;
        if (sql === "COMMIT" && terminalWrite && !lostTerminalAcknowledgement) { lostTerminalAcknowledgement = true; throw new Error("FIXTURE_LOST_TERMINAL_COMMIT_ACK"); }
        return result;
      }, release() { client.release(); },
    }; } };
    const completionStore = new PostgresFundingDatabase(lossyPool, { realm: "production-real" }).funding;
    const open = (corruptObject = false) => new ContinuationService({ store: completionStore, includeAdmissionHold: true, clock: { nowMs: () => now }, resume: { compatibility: { policyVersion: "fixture", profileId: profile.id, priceCardId: card.id, toolchainId: "resume-toolchain" }, execution: generation, checkpoint: { loadExact: async value => { const original = await checkpoint().loadExact(value); return corruptObject ? { ...original, envelope: { ...original.envelope, object: { ...original.envelope.object, generation: original.envelope.object.generation + 1 } } } : original; }, restore: value => checkpoint().restore({ checkpointId: value.manifest.checkpointId, accountId, sessionId: pending.sessionId }) }, allocate: async value => { expect(value.payloadKind).toBe("pending_command"); allocations++; return allocations === 1 ? { status: "unknown" } : { status: "allocated", worker: forbiddenWorkspace }; } } });
    const command = { principal: { id: accountId }, sessionId: pending.sessionId, checkpointId, expectedSessionVersion: 0, expectedCheckpointVersion: 1, idempotencyKey: "resume", approvePendingAction: true, capApprovalReference: admissionReference, pendingAction: { reference: live.intent.reference, fingerprint: live.intent.fingerprint, kind: "start_session", maximum: "10" } };
    expect(await open(true).resumeSession(command)).toMatchObject({ status: "reconciliation_pending", code: "RESUME_CHECKPOINT_RECONCILIATION" });
    expect(allocations).toBe(0);
    expect((await admin.query("SELECT count(*)::int AS count FROM production_real.action_budget_reservations")).rows[0].count).toBe(0);
    const service = open();
    expect(await service.resumeSession(command)).toMatchObject({ status: "reconciliation_pending", code: "RESUME_ALLOCATION_RECONCILIATION" });
    expect((await admin.query("SELECT state FROM production_real.provider_operations")).rows[0].state).toBe("prepared");
    const prepared = (await store.listMeteredActionsForSession(accountId, pending.sessionId))[0];
    if (!prepared) throw new Error("PREPARED_ACTION_REQUIRED");
    const executable = await generation.prepareContinuation(live.intent, validatePendingCommandCheckpointArchive(await checkpoint().restore({ checkpointId, accountId, sessionId: pending.sessionId }), live.intent));
    await expect(executable.readTerminal({ accountId, actionKey: prepared.idempotencyKey, commandFingerprint: prepared.fingerprint, actionId: prepared.actionId, operationId: "wrong:original", actionBudgetReference: prepared.actionBudgetReference })).rejects.toThrow("CONTINUATION_PREPARED_ACTION_BINDING_DENIED");
    expect(dispatches).toBe(0);
    expect(await service.resumeSession(command)).toMatchObject({ status: "reconciliation_pending", code: "RESUME_ACTION_RECONCILIATION" });
    expect({ dispatches, builds }).toEqual({ dispatches: 1, builds: 0 });
    expect(await open().resumeSession(command)).toMatchObject({ status: "reconciliation_pending", code: "RESUME_ACTION_RECONCILIATION" });
    expect(lostTerminalAcknowledgement).toBe(true);
    expect({ dispatches, lookups, builds, restores }).toEqual({ dispatches: 1, lookups: 1, builds: 1, restores: 0 });
    const action = (await store.listMeteredActionsForSession(accountId, pending.sessionId))[0];
    expect(action).toMatchObject({ status: "completed", receiptCharge: "3" });
    expect((await funding.status(principal)).held).toBe("7");
    expect(await store.findContinuationPause(accountId, pending.sessionId, 1)).toMatchObject({ state: "completed" });
    expect((await store.findContinuationPause(accountId, pending.sessionId, 1))?.liveLeaseToken).toBeUndefined();
    const allocationsAtCompletion = allocations;
    expect(await open().resumeSession(command)).toMatchObject({ status: "restored" });
    expect(allocations).toBe(allocationsAtCompletion);
    expect({ dispatches, lookups, builds, restores }).toEqual({ dispatches: 1, lookups: 1, builds: 1, restores: 0 });
    for (const table of ["continuation_resume_commands", "action_budget_reservations", "metered_actions", "provider_operations"]) expect((await admin.query(`SELECT count(*)::int AS count FROM production_real.${table}`)).rows[0].count).toBe(1);
  } finally { await recovered?.end(); await native?.end(); await admin?.end(); await docker(["rm", "--force", name]).catch(() => undefined); }
}, 120_000);
