import { expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { Pool } from "pg";
import { accountIdForPrincipal } from "../../src/domain/account-command";
import { bindAccountingRealmPool, createAccountingRealm } from "../../src/funding/accounting-realm";
import { ContinuationService } from "../../src/continuity/continuation-service";
import type { PendingActionIntent } from "../../src/continuity/contracts";
import type { ContinuationFundingStore } from "../../src/persistence/funding-store";
import { StartSessionCommandSchema, ReviseSessionCommandSchema, SessionActionResultSchema } from "../../src/phase-04/metered-generation-service";
import { GcsObjectStoreAdapter, type VersionedObjectClientPort } from "../../src/continuity/object-store";
import { PostgresSqlFundingStore, type PostgresSqlPool } from "../../src/persistence/postgres-sql-funding-store";
import { canonicalJson } from "../../src/promotion/schema";
import { PostgresOperationJournal } from "../../src/release/deployment/postgres-operation-journal";
import { ProductionCheckpointCoordinator } from "../../src/production/checkpoint-coordinator";
import { ProductionInitialPendingCheckpoint } from "../../src/production/initial-pending-checkpoint";
import { registerProductionPricing } from "../../src/production/pricing-catalog";
import { ProductionResumePricingQuotes } from "../../src/production/resume-pricing-quotes";
import { ProductionResumePricingPreparer } from "../../src/production/resume-pricing-preparer";
import { readOriginalPendingVertexSettlement } from "../../src/production/vertex-generation-settlement";
import { resumePricingMaterial } from "../fixtures/resume-pricing";
import { ProductionResumeAcceptance } from "../../src/production/resume-acceptance";
import { prepareResumePricingQuote } from "../../src/continuity/resume-pricing";
import { createProductionVertexGenerationSettlement } from "../../src/production/vertex-generation-settlement";
import { createPostgresVertexOperationJournal } from "../../src/release/deployment/postgres-provider-journals";
import { createVertexDeploymentClient, createVertexInteractionsHttpPort } from "../../src/release/deployment/vertex-client";
import { ProductionVertexModelGateway } from "../../src/production/vertex-model-gateway";
import { ProductionSourceProposalStore } from "../../src/production/source-proposal-store";
import { ProviderOperationIntentSchema, NormalizedUsageReceiptSchema } from "../../src/model/model-gateway";
import { z } from "zod";
import { ProductionPricedContinuationWorkers } from "../../src/production/priced-continuation-workers";
import { ProductionWorkerBridge, ProductionWorkerOwnershipResolver } from "../../src/production/worker-bridge";
import type { CapacityReservation, ReadyCapacityPort } from "../../src/funding/funded-admission";
import { pricedRestoreBinding } from "../../src/production/priced-restore-binding";
import { ProductionPricedContinuationRestores } from "../../src/production/priced-continuation-restores";
import { ProductionWorkerRequestStore } from "../../src/production/worker-request-store";
import { createWorkerDeploymentClients } from "../../src/release/deployment/worker-clients";
import { createPostgresWorkerOperationJournal } from "../../src/release/deployment/postgres-provider-journals";
import { PRODUCTION_WORKER_POLICY } from "../../src/worker-adapters/production-worker-policy";
import { WorkerRunRequestSchema } from "../../src/phase-02/contracts";
import { projectResumePricingQuote } from "../../src/continuity/resume-v2-contracts";
import { ProductionPricedContinuationFinalizer } from "../../src/production/priced-continuation-finalizer";

const integration = process.env.NAPPLET_RUN_POSTGRES_ISOLATION === "1" ? test : test.skip;
const hash = (value: unknown) => createHash("sha256").update(canonicalJson(value)).digest("hex");
async function docker(args: string[]): Promise<string> {
  const child = Bun.spawn(["docker", ...args], { stdin: "ignore", stdout: "pipe", stderr: "pipe" });
  const [out, err, code] = await Promise.all([new Response(child.stdout).text(), new Response(child.stderr).text(), child.exited]);
  if (code !== 0) throw new Error(`DOCKER_FAILED:${args[0]}:${err.slice(0, 300)}`);
  return out.trim();
}
function sqlPool(native: Pool, loseCommit?: () => boolean, failRestorePauseWrite?: () => boolean, failTerminalPauseWrite?: () => boolean): PostgresSqlPool {
  return { async connect() { const client = await native.connect(); return {
    async query<Row extends Record<string, unknown>>(sql: string, values?: readonly unknown[]) {
      if (sql.startsWith("UPDATE production_real.continuation_pauses SET state='restored'") && failRestorePauseWrite?.()) throw new Error("RESTORE_PAUSE_WRITE_FAILED");
      if (sql.startsWith("UPDATE production_real.continuation_pauses SET state='completed'") && failTerminalPauseWrite?.()) throw new Error("TERMINAL_PAUSE_WRITE_FAILED");
      const result = await client.query<Row>(sql, values ? [...values] : undefined);
      if (sql === "COMMIT" && loseCommit?.()) throw new Error("COMMIT_ACK_LOST");
      return { rows: result.rows };
    },
    release() { client.release(); },
  }; } };
}

integration("owned encrypted resume authenticates pricing, fences spending and restores command/workspace originals without redispatch", async () => {
  const name = `cvm-resume-preparer-${crypto.randomUUID().replaceAll("-", "")}`;
  let admin: Pool | undefined, runtime: Pool | undefined;
  try {
    await docker(["run", "--detach", "--rm", "--name", name, "--publish", "127.0.0.1::5432", "-e", "POSTGRES_HOST_AUTH_METHOD=trust", "postgres:17-alpine"]);
    const port = (await docker(["port", name, "5432/tcp"])).match(/127\.0\.0\.1:(\d+)/u)?.[1];
    if (!port) throw new Error("POSTGRES_PORT_MISSING");
    admin = new Pool({ connectionString: `postgresql://postgres@127.0.0.1:${port}/postgres`, connectionTimeoutMillis: 2000 });
    for (let attempt = 0; attempt < 90; attempt++) { try { await admin.query("SELECT 1"); break; } catch (error) { if (attempt === 89) throw error; await Bun.sleep(250); } }
    for (const file of ["phase-03/001_funding.sql", "phase-04/001_metered_generation.sql", "phase-04/002_action_budget_lifecycle.sql", "phase-05/001_continuation.sql", "phase-06/001_publication.sql", "phase-03/002_production_accounting.sql",
      "phase-07/001_production_operation_journal.sql", "phase-07/002_production_pricing_catalog.sql", "phase-07/003_production_checkpoints.sql", "phase-07/004_production_source_proposals.sql", "phase-07/006_production_pending_checkpoints.sql", "phase-07/009_production_resume_pricing_quotes.sql"])
      await admin.query(await Bun.file(`migrations/${file}`).text());
    await admin.query("CREATE ROLE resume_preparer_runtime LOGIN"); await admin.query("GRANT napplet_production_real TO resume_preparer_runtime");
    runtime = new Pool({ connectionString: `postgresql://resume_preparer_runtime@127.0.0.1:${port}/postgres` });
    const pool = sqlPool(runtime), bound = bindAccountingRealmPool(pool, createAccountingRealm("production-real"));
    const store: ContinuationFundingStore = new PostgresSqlFundingStore(bound), quotes = new ProductionResumePricingQuotes(pool);
    await quotes.assertReady();
    const startedAt = Date.now() - 600_100; let now = startedAt;
    const originalPricing = await resumePricingMaterial(startedAt, "profile:original");
    await registerProductionPricing({ pool, ...originalPricing });
    const principal = { pubkey: "7".repeat(64) }, accountId = await accountIdForPrincipal(principal);
    const command = StartSessionCommandSchema.parse({ principal, admissionReference: "admission:one", idempotencyKey: "start:one", expectedVersion: 0,
      maximum: "50", policyVersion: "policy:one", idea: "Build one focused private counter." });
    const sessionId = `session:${hash({ accountId, key: command.idempotencyKey }).slice(0, 24)}`;
    await admin.query("INSERT INTO production_real.funding_accounts(account_id,unit) VALUES($1,'sat')", [accountId]);
    await admin.query("INSERT INTO production_real.account_balance_projection(account_id,unit,settled_available,held) VALUES($1,'sat',0,0)", [accountId]);
    await admin.query("INSERT INTO production_real.session_cap_holds(hold_id,account_id,reference,requested_cap,held_amount,state) VALUES('hold:one',$1,'admission:one',50,0,'active')", [accountId]);
    await admin.query("INSERT INTO production_real.admissions(admission_id,account_id,reference,capacity_reference,state) VALUES('admission:one',$1,'admission:one','capacity:fixture','accepted')", [accountId]);

    const values = new Map<string, { bytes: Uint8Array; checksum: string }>(); let objectReads = 0, allocations = 0, deletions = 0;
    const objectClient: VersionedObjectClientPort = {
      async createIfAbsent(value) { if (values.has(value.key)) throw new Error("OBJECT_ALREADY_EXISTS"); values.set(value.key, { bytes: new Uint8Array(value.bytes), checksum: value.checksum }); return { generation: 1, checksum: value.checksum }; },
      async findExactByKey(value) { const item = values.get(value.key); return item?.checksum === value.checksum ? { generation: 1, checksum: item.checksum } : undefined; },
      async readGeneration(value) { objectReads++; const item = values.get(value.key); return item && value.generation === 1 && item.checksum === value.expectedChecksum ? { generation: 1, checksum: item.checksum, bytes: new Uint8Array(item.bytes) } : undefined; },
      async scheduleGenerationDeletion(value) {
        const item = values.get(value.key);
        if (!item || value.generation !== 1 || item.checksum !== value.expectedChecksum || Date.parse(value.deleteAfter) > now) throw new Error("FIXTURE_DELETION_BINDING_DENIED");
        values.delete(value.key); deletions++; return { generation: 1, checksum: item.checksum };
      },
    };
    const vertexJournal = new PostgresOperationJournal(pool, { namespace: "resume-preparer-vertex", scopeSha256: "a".repeat(64) });
    const checkpoint = new ProductionCheckpointCoordinator({ pool, objectStore: new GcsObjectStoreAdapter({ config: { bucket: "resume-preparer-fixture", projectId: "fixture" }, client: objectClient }),
      journal: new PostgresOperationJournal(pool, { namespace: "resume-preparer-checkpoint", scopeSha256: "b".repeat(64) }),
      kekPath: "/mounted/fixture-kek", readKekFile: async () => Buffer.alloc(32, 9).toString("base64"), now: () => now });
    const continuation = new ContinuationService({ store, clock: { nowMs: () => now }, includeAdmissionHold: true, pendingCommands: checkpoint.pendingCommands });
    const pending: PendingActionIntent = { accountId, sessionId, idempotencyKey: command.idempotencyKey, fingerprint: "c".repeat(64), reference: "pending:one", actionKind: "start_session",
      boundedPayloadHash: hash({ idea: command.idea }), expectedSessionVersion: 0, expectedArtifactVersion: 0, policyVersion: command.policyVersion,
      profileId: originalPricing.profile.id, priceCardId: originalPricing.card.id, toolchainId: "toolchain:one", actionMaximum: "3", admissionReference: command.admissionReference };
    const originalOperationId = `operation:${hash({ accountId, key: command.idempotencyKey, profile: pending.profileId }).slice(0, 24)}`;
    const settlement = { accountId, operationId: originalOperationId, conversion: originalPricing.conversion, acceptedAt: new Date(startedAt).toISOString(), maximumUsdMicros: "220" };
    const identity = createHash("sha256").update(JSON.stringify({ accountId, operationId: originalOperationId })).digest("hex");
    const journalKey = `vertex-generation-settlement:${originalOperationId}`;
    await vertexJournal.claim(journalKey, identity, settlement);
    expect(await continuation.pauseForFunding({ intent: pending, command })).toMatchObject({ status: "needs_top_up", actionMaximum: "3" });
    const pause = await store.findContinuationPause(accountId, sessionId, 1);
    if (!pause?.liveLeaseToken) throw new Error("EXPECTED_LIVE_PAUSE");
    const liveLeaseToken = pause.liveLeaseToken;
    now = pause.graceDeadlineMs + 1;
    const checkpointing = await store.transact(accountId, tx => tx.beginDeadlineCheckpoint({ sessionId, pauseGeneration: 1, liveLeaseToken }));
    const initial = new ProductionInitialPendingCheckpoint({ pool, checkpoint, commands: checkpoint.pendingCommands, now: () => now,
      capacity: { async reserveNow() { allocations++; throw new Error("UNEXPECTED_QUOTE_ALLOCATION"); }, async observe() { allocations++; throw new Error("UNEXPECTED_QUOTE_OBSERVATION"); }, async release() {} } });
    const sealed = await initial.seal(checkpointing);
    const committed = await store.transact(accountId, tx => tx.commitDeadlineCheckpoint({ accountId, sessionId, pauseGeneration: 1, checkpointId: sealed.manifest.checkpointId,
      expectedSessionVersion: 0, expectedArtifactVersion: 0, manifestReference: `checkpoint-manifest:${sealed.manifest.checkpointId}:${sealed.envelope.manifestSha256}`,
      objectKey: sealed.envelope.object.key, objectGeneration: String(sealed.envelope.object.generation), objectChecksum: sealed.envelope.object.checksum,
      keyReference: sealed.envelope.crypto.keyReference, compatibilityIdentity: hash(sealed.manifest.compatibility), checkpointCommittedAtMs: Date.parse(sealed.manifest.committedAt) }));
    const currentPricing = await resumePricingMaterial(now, "profile:current");
    await registerProductionPricing({ pool, ...currentPricing });
    const preparer = new ProductionResumePricingPreparer({ pool, store, quotes, checkpoint, vertexJournal, currentPricing,
      compatibility: { policyVersion: pending.policyVersion, acceptedToolchains: [pending.toolchainId] }, now: () => now });
    const request = { principal: { id: accountId }, sessionId, checkpointId: committed.checkpointId, expectedSessionVersion: 0, expectedCheckpointVersion: 1, idempotencyKey: "quote:one" };
    const quoted = await preparer.prepare(request);
    expect(quoted).toMatchObject({ status: "quoted", pricing: { profileId: currentPricing.profile.id, priceCardId: currentPricing.card.id, maximumSat: "3" } });
    if (quoted.status !== "quoted") throw new Error("EXPECTED_OWNED_QUOTE");
    const authority = await preparer.loadAuthority(request);
    expect(authority.command).toEqual(command);
    expect(authority.context.originalOperationId).toBe(originalOperationId);
    expect(authority.originalPricing.card).toEqual(originalPricing.card);
    expect(authority.context.checkpointSha256).toBe(sealed.envelope.manifestSha256);
    expect(authority.context.originalCommandMaximum).toBe("50");
    const reads = objectReads;
    expect(await preparer.prepare({ ...request, principal: { id: "account:foreign" }, idempotencyKey: "quote:foreign" })).toEqual({ status: "denied", code: "RESUME_CHECKPOINT_NOT_FOUND_OR_DENIED" });
    expect(objectReads).toBe(reads);
    expect(await preparer.prepare({ ...request, expectedSessionVersion: 1 })).toEqual({ status: "denied", code: "RESUME_STALE_OR_CONFLICTING" });
    expect(await preparer.prepare({ ...request, idempotencyKey: "quote:wrong-version", expectedSessionVersion: 1 })).toEqual({ status: "denied", code: "RESUME_STALE_OR_CONFLICTING" });
    const json = JSON.stringify(quoted);
    for (const secret of [accountId, command.idea, committed.objectKey, committed.keyReference, authority.context.originalSettlementSha256]) expect(json).not.toContain(secret);
    now += 300_001;
    expect(await preparer.prepare(request)).toEqual(quoted); // Same preparation key returns its original immutable result.
    expect(await preparer.prepare({ ...request, idempotencyKey: "quote:stale-pricing" })).toEqual({ status: "blocked", code: "RESUME_PRICE_AUTHORITY_UNAVAILABLE" });
    now -= 300_001;
    const object = values.get(committed.objectKey); if (!object) throw new Error("EXPECTED_ORIGINAL_OBJECT");
    const originalBytes = new Uint8Array(object.bytes); object.bytes[0] = object.bytes[0]! ^ 1;
    expect(await preparer.prepare({ ...request, idempotencyKey: "quote:tampered-object" })).toEqual({ status: "blocked", code: "RESUME_PRICE_AUTHORITY_UNAVAILABLE" });
    object.bytes = originalBytes;
    await vertexJournal.compareAndSet(journalKey, identity, 1, { ...settlement, maximumUsdMicros: "221" });
    await expect(readOriginalPendingVertexSettlement({ journal: vertexJournal, accountId, operationId: originalOperationId })).rejects.toThrow("PRODUCTION_PENDING_SETTLEMENT_REQUIRED");
    expect(await preparer.prepare({ ...request, idempotencyKey: "quote:changed-settlement" })).toEqual({ status: "blocked", code: "RESUME_PRICE_AUTHORITY_UNAVAILABLE" });
    expect((await admin.query("SELECT count(*)::int AS count FROM production_real.resume_pricing_quotes")).rows[0].count).toBe(1);
    for (const table of ["action_budget_reservations", "provider_operations", "ledger_entries"]) expect((await admin.query(`SELECT count(*)::int AS count FROM production_real.${table}`)).rows[0].count).toBe(0);
    expect(allocations).toBe(0);
    expect(deletions).toBe(0);

    // A revision's delayed checkpoint expires later than the original SQL
    // command envelope. Retain its authenticated command for that final window.
    now = startedAt;
    const revisionCommand = ReviseSessionCommandSchema.parse({ principal, sessionId: "session:revision", admissionReference: command.admissionReference,
      idempotencyKey: "revision:one", expectedVersion: 1, maximum: "50", policyVersion: command.policyVersion, revision: "Make the existing counter compact." });
    await admin.query("INSERT INTO production_real.metered_sessions(id,account_id,admission_reference,profile_id,price_card_id,version,current_verified_artifact_version,state) VALUES($1,$2,$3,$4,$5,1,1,'verified')",
      [revisionCommand.sessionId, accountId, command.admissionReference, originalPricing.profile.id, originalPricing.card.id]);
    const revisionIntent: PendingActionIntent = { ...pending, sessionId: revisionCommand.sessionId, idempotencyKey: revisionCommand.idempotencyKey,
      fingerprint: "d".repeat(64), reference: "pending:revision", actionKind: "revise_session", boundedPayloadHash: hash({ revision: revisionCommand.revision }), expectedSessionVersion: 1, expectedArtifactVersion: 1 };
    expect(await continuation.pauseForFunding({ intent: revisionIntent, command: revisionCommand })).toMatchObject({ status: "needs_top_up" });
    const revisionPause = await store.findContinuationPause(accountId, revisionCommand.sessionId, 1);
    if (!revisionPause?.liveLeaseToken || !revisionPause.intent.protectedCommand) throw new Error("EXPECTED_PROTECTED_REVISION");
    const revisionLease = revisionPause.liveLeaseToken;
    const revisionOperationId = `operation:${hash({ accountId, key: revisionCommand.idempotencyKey, profile: revisionIntent.profileId }).slice(0, 24)}`;
    await vertexJournal.claim(`vertex-generation-settlement:${revisionOperationId}`, createHash("sha256").update(JSON.stringify({ accountId, operationId: revisionOperationId })).digest("hex"),
      { ...settlement, operationId: revisionOperationId });
    now = revisionPause.graceDeadlineMs + 5000;
    const revisionCheckpointing = await store.transact(accountId, tx => tx.beginDeadlineCheckpoint({ sessionId: revisionCommand.sessionId, pauseGeneration: 1, liveLeaseToken: revisionLease }));
    const revisionSealed = await checkpoint.seal({ checkpointId: "checkpoint:revision", accountId, sessionId: revisionCommand.sessionId, pauseGeneration: 1,
      sessionVersion: 1, actionVersion: 1, artifactVersion: 1, workspaceVersion: 1, workspaceLineage: "workspace:revision",
      action: { actionId: "action:prior", operationId: "operation:prior", ledgerReference: command.admissionReference, pendingActionReference: revisionIntent.reference, idempotencyKey: revisionCommand.idempotencyKey },
      archive: new TextEncoder().encode("bounded worker workspace fixture"), inventory: ["harness_state", "workspace", "artifact_lineage", "validation_evidence", "financial_action", "pending_action", "compatibility_metadata"],
      evidenceSha256: "e".repeat(64), compatibility: { policyVersion: revisionIntent.policyVersion, modelIdentity: originalPricing.profile.id, nappletSdkIdentity: originalPricing.card.id, toolchainIdentity: revisionIntent.toolchainId },
      retentionUntil: new Date(now + 2_592_000_000).toISOString() });
    const custodyInput = { checkpointId: revisionSealed.manifest.checkpointId, accountId, sessionId: revisionCommand.sessionId, intent: revisionCheckpointing.intent };
    await Promise.all([checkpoint.retainPendingCommand(custodyInput), checkpoint.retainPendingCommand(custodyInput), checkpoint.retainPendingCommand(custodyInput)]);
    await store.transact(accountId, tx => tx.commitDeadlineCheckpoint({ accountId, sessionId: revisionCommand.sessionId, pauseGeneration: 1, checkpointId: revisionSealed.manifest.checkpointId,
      expectedSessionVersion: 1, expectedArtifactVersion: 1, manifestReference: `checkpoint-manifest:${revisionSealed.manifest.checkpointId}:${revisionSealed.envelope.manifestSha256}`,
      objectKey: revisionSealed.envelope.object.key, objectGeneration: String(revisionSealed.envelope.object.generation), objectChecksum: revisionSealed.envelope.object.checksum,
      keyReference: revisionSealed.envelope.crypto.keyReference, compatibilityIdentity: hash(revisionSealed.manifest.compatibility), checkpointCommittedAtMs: Date.parse(revisionSealed.manifest.committedAt) }));
    expect((await admin.query("SELECT count(*)::int AS count FROM production_real.checkpoint_crypto_records WHERE checkpoint_id LIKE 'checkpoint-command:%'")).rows[0].count).toBe(1);
    const freshCheckpoint = new ProductionCheckpointCoordinator({ pool, objectStore: new GcsObjectStoreAdapter({ config: { bucket: "resume-preparer-fixture", projectId: "fixture" }, client: objectClient }),
      journal: new PostgresOperationJournal(pool, { namespace: "resume-preparer-checkpoint", scopeSha256: "b".repeat(64) }), kekPath: "/mounted/fixture-kek", readKekFile: async () => Buffer.alloc(32, 9).toString("base64"), now: () => now });
    now = revisionPause.intent.protectedCommand.retentionUntilMs + 1;
    await expect(freshCheckpoint.pendingCommands.open(revisionCheckpointing.intent)).rejects.toThrow();
    expect(await freshCheckpoint.readRetainedPendingCommand(custodyInput)).toEqual(revisionCommand);
    await expect(freshCheckpoint.readRetainedPendingCommand({ ...custodyInput, accountId: "account:foreign" })).rejects.toThrow("CHECKPOINT_COMMAND_CUSTODY_BINDING_DENIED");
    await expect(freshCheckpoint.readRetainedPendingCommand({ ...custodyInput, intent: { ...custodyInput.intent, commandSha256: "f".repeat(64) } })).rejects.toThrow("CHECKPOINT_COMMAND_CUSTODY_BINDING_DENIED");
    const finalPricing = await resumePricingMaterial(now, "profile:final-window"); await registerProductionPricing({ pool, ...finalPricing });
    const finalPreparer = new ProductionResumePricingPreparer({ pool, store, quotes, checkpoint: freshCheckpoint, vertexJournal, currentPricing: finalPricing,
      compatibility: { policyVersion: pending.policyVersion, acceptedToolchains: [pending.toolchainId] }, now: () => now });
    const finalQuote = await finalPreparer.prepare({ principal: { id: accountId }, sessionId: revisionCommand.sessionId, checkpointId: revisionSealed.manifest.checkpointId,
      expectedSessionVersion: 1, expectedCheckpointVersion: 1, idempotencyKey: "quote:final-window" });
    expect(finalQuote).toMatchObject({ status: "quoted", expiresAtMs: Date.parse(revisionSealed.manifest.retentionUntil) });
    const expirationInput = { checkpointId: revisionSealed.manifest.checkpointId, accountId, sessionId: revisionCommand.sessionId };
    await expect(freshCheckpoint.destroyExpired(expirationInput)).rejects.toThrow("CHECKPOINT_DELETE_BINDING_REQUIRED");
    now = Date.parse(revisionSealed.manifest.retentionUntil);
    await expect(freshCheckpoint.readRetainedPendingCommand(custodyInput)).rejects.toThrow("CHECKPOINT_COMMAND_CUSTODY_BINDING_DENIED");
    await freshCheckpoint.destroyExpired(expirationInput); await freshCheckpoint.destroyExpired(expirationInput);
    expect(await freshCheckpoint.observeDestroyed(expirationInput)).toBeTrue();
    expect((await store.findContinuationPause(accountId, revisionCommand.sessionId, 1))?.intent.protectedCommand).toBeUndefined();
    expect((await admin.query("SELECT state,wrapped_dek,octet_length(ciphertext)::int AS bytes FROM production_real.checkpoint_crypto_records WHERE checkpoint_id LIKE 'checkpoint-command:%'")).rows).toEqual([{ state: "destroyed", wrapped_dek: null, bytes: 0 }]);
    expect(deletions).toBe(1);
    for (const table of ["action_budget_reservations", "provider_operations", "ledger_entries"]) expect((await admin.query(`SELECT count(*)::int AS count FROM production_real.${table}`)).rows[0].count).toBe(0);
    // Exercise the actual shared money transaction and provider fence. These
    // remain local protocol fixtures; no model request or worker is executed.
    // Independent in-progress revision workspace, not the expired/deleted
    // retention scenario above. Its archive is valid for the real job parser.
    now = startedAt;
    const workspaceToolchain = "d".repeat(64);
    const bytesSha = (value: string | Uint8Array) => createHash("sha256").update(value).digest("hex");
    const workspaceCommand = ReviseSessionCommandSchema.parse({ ...revisionCommand, sessionId: "session:workspace-resume", idempotencyKey: "revision:workspace-resume" });
    await admin.query("INSERT INTO production_real.metered_sessions(id,account_id,admission_reference,profile_id,price_card_id,version,current_verified_artifact_version,state) VALUES($1,$2,$3,$4,$5,1,1,'verified')",
      [workspaceCommand.sessionId, accountId, command.admissionReference, originalPricing.profile.id, originalPricing.card.id]);
    const workspaceIntent: PendingActionIntent = { ...revisionIntent, sessionId: workspaceCommand.sessionId, idempotencyKey: workspaceCommand.idempotencyKey,
      fingerprint: hash({ workspace: workspaceCommand.idempotencyKey }), reference: "pending:workspace-resume" };
    await continuation.pauseForFunding({ intent: workspaceIntent, command: workspaceCommand });
    const workspacePause = await store.findContinuationPause(accountId, workspaceCommand.sessionId, 1);
    if (!workspacePause?.liveLeaseToken) throw new Error("EXPECTED_WORKSPACE_PAUSE");
    const workspaceLease = workspacePause.liveLeaseToken;
    const workspaceOperation = `operation:${hash({ accountId, key: workspaceCommand.idempotencyKey, profile: workspaceIntent.profileId }).slice(0, 24)}`;
    await vertexJournal.claim(`vertex-generation-settlement:${workspaceOperation}`, createHash("sha256").update(JSON.stringify({ accountId, operationId: workspaceOperation })).digest("hex"), { ...settlement, operationId: workspaceOperation });
    now = workspacePause.graceDeadlineMs + 1;
    const workspacePausing = await store.transact(accountId, tx => tx.beginDeadlineCheckpoint({ sessionId: workspaceCommand.sessionId, pauseGeneration: 1, liveLeaseToken: workspaceLease }));
    const workspaceSource = { version: 1, actionId: "action:in-progress-workspace", sessionId: workspaceCommand.sessionId, expectedVersion: 1,
      proposalSha256: "c".repeat(64), toolchainSha256: workspaceToolchain, deadlineEpochMs: 1, files: [{ path: "src/main.ts", content: "document.body.textContent = 'One counter';" }] };
    const workspaceFiles = [{ path: "index.html", bytesBase64: Buffer.from("<html></html>").toString("base64"), sha256: bytesSha("<html></html>"), size: 13 }];
    const workspaceBytes = Buffer.from(canonicalJson({ version: 1, source: workspaceSource, toolchainSha256: workspaceToolchain,
      artifact: { version: 1, jobId: bytesSha(canonicalJson(workspaceSource)), proposalSha256: workspaceSource.proposalSha256, toolchainSha256: workspaceToolchain,
        files: workspaceFiles, commandEvidence: Array.from({ length: 8 }, () => ({ argv: ["contract-fixture"], exitCode: 0, stdout: "", stderr: "", elapsedMs: 1 })) } }));
    const workspaceSealed = await checkpoint.seal({ checkpointId: "checkpoint:workspace-resume", accountId, sessionId: workspaceCommand.sessionId, pauseGeneration: 1,
      sessionVersion: 1, actionVersion: 1, artifactVersion: 1, workspaceVersion: 1, workspaceLineage: `workspace:${workspaceCommand.sessionId}`,
      action: { actionId: workspaceSource.actionId, operationId: "operation:in-progress-workspace", ledgerReference: command.admissionReference,
        pendingActionReference: workspaceIntent.reference, idempotencyKey: workspaceCommand.idempotencyKey }, archive: new Uint8Array(workspaceBytes),
      inventory: ["harness_state", "workspace", "artifact_lineage", "validation_evidence", "financial_action", "pending_action", "compatibility_metadata"],
      evidenceSha256: "e".repeat(64), compatibility: { policyVersion: workspaceIntent.policyVersion, modelIdentity: originalPricing.profile.id,
        nappletSdkIdentity: originalPricing.card.id, toolchainIdentity: workspaceIntent.toolchainId }, retentionUntil: new Date(now + 2_592_000_000).toISOString() });
    await checkpoint.retainPendingCommand({ checkpointId: workspaceSealed.manifest.checkpointId, accountId, sessionId: workspaceCommand.sessionId, intent: workspacePausing.intent });
    await store.transact(accountId, tx => tx.commitDeadlineCheckpoint({ accountId, sessionId: workspaceCommand.sessionId, pauseGeneration: 1, checkpointId: workspaceSealed.manifest.checkpointId,
      expectedSessionVersion: 1, expectedArtifactVersion: 1, manifestReference: `checkpoint-manifest:${workspaceSealed.manifest.checkpointId}:${workspaceSealed.envelope.manifestSha256}`,
      objectKey: workspaceSealed.envelope.object.key, objectGeneration: String(workspaceSealed.envelope.object.generation), objectChecksum: workspaceSealed.envelope.object.checksum,
      keyReference: workspaceSealed.envelope.crypto.keyReference, compatibilityIdentity: hash(workspaceSealed.manifest.compatibility), checkpointCommittedAtMs: Date.parse(workspaceSealed.manifest.committedAt) }));
    const acceptMigration = await Bun.file("migrations/phase-07/010_production_priced_continuations.sql").text();
    await admin.query(acceptMigration); await admin.query(acceptMigration);
    const workersMigration = await Bun.file("migrations/phase-07/011_production_priced_continuation_workers.sql").text();
    await admin.query(workersMigration); await admin.query(workersMigration);
    const acceptancePricing = await resumePricingMaterial(Date.now(), "profile:acceptance", "2000", 8000);
    await registerProductionPricing({ pool, ...acceptancePricing });
    const acceptancePreparer = new ProductionResumePricingPreparer({ pool, store, quotes, checkpoint, vertexJournal, currentPricing: acceptancePricing,
      compatibility: { policyVersion: pending.policyVersion, acceptedToolchains: [pending.toolchainId] }, now: () => now });
    const acceptance = new ProductionResumeAcceptance({ pool, quotes, preparer: acceptancePreparer, now: Date.now });
    await acceptance.assertReady();
    await admin.query("ALTER TABLE production_real.provider_operations DISABLE TRIGGER priced_provider_dispatch_fence");
    await expect(acceptance.assertReady()).rejects.toThrow("PRODUCTION_PRICED_CONTINUATION_SCHEMA_REQUIRED");
    await admin.query("ALTER TABLE production_real.provider_operations ENABLE TRIGGER priced_provider_dispatch_fence");
    await acceptance.assertReady();
    await admin.query("ALTER TABLE production_real.release_operation_journal DISABLE TRIGGER priced_vertex_api_claim_fence");
    await expect(acceptance.assertReady()).rejects.toThrow("PRODUCTION_PRICED_CONTINUATION_SCHEMA_REQUIRED");
    await admin.query("ALTER TABLE production_real.release_operation_journal ENABLE TRIGGER priced_vertex_api_claim_fence");
    await acceptance.assertReady();
    async function acceptanceCheckpoint(key: string, lifetimeMs = 60_000) {
      now = startedAt;
      const savedCommand = StartSessionCommandSchema.parse({ ...command, idempotencyKey: key });
      const savedSession = `session:${hash({ accountId, key }).slice(0, 24)}`;
      const savedIntent: PendingActionIntent = { ...pending, sessionId: savedSession, idempotencyKey: key, fingerprint: hash({ fixture: key }), reference: `pending:${key}` };
      const savedOperation = `operation:${hash({ accountId, key, profile: savedIntent.profileId }).slice(0, 24)}`;
      await vertexJournal.claim(`vertex-generation-settlement:${savedOperation}`, createHash("sha256").update(JSON.stringify({ accountId, operationId: savedOperation })).digest("hex"), { ...settlement, operationId: savedOperation });
      await continuation.pauseForFunding({ intent: savedIntent, command: savedCommand });
      const savedPause = await store.findContinuationPause(accountId, savedSession, 1);
      if (!savedPause?.liveLeaseToken) throw new Error("EXPECTED_ACCEPTANCE_PAUSE");
      const token = savedPause.liveLeaseToken;
      now = savedPause.graceDeadlineMs + 1;
      const pausing = await store.transact(accountId, tx => tx.beginDeadlineCheckpoint({ sessionId: savedSession, pauseGeneration: 1, liveLeaseToken: token }));
      const saved = await initial.seal(pausing);
      await store.transact(accountId, tx => tx.commitDeadlineCheckpoint({ accountId, sessionId: savedSession, pauseGeneration: 1, checkpointId: saved.manifest.checkpointId,
        expectedSessionVersion: 0, expectedArtifactVersion: 0, manifestReference: `checkpoint-manifest:${saved.manifest.checkpointId}:${saved.envelope.manifestSha256}`,
        objectKey: saved.envelope.object.key, objectGeneration: String(saved.envelope.object.generation), objectChecksum: saved.envelope.object.checksum,
        keyReference: saved.envelope.crypto.keyReference, compatibilityIdentity: hash(saved.manifest.compatibility), checkpointCommittedAtMs: Date.parse(saved.manifest.committedAt) }));
      const snapshot = await acceptancePreparer.loadAuthority({ principal: { id: accountId }, sessionId: savedSession, checkpointId: saved.manifest.checkpointId,
        expectedSessionVersion: 0, expectedCheckpointVersion: 1, idempotencyKey: `prepare:${key}` });
      const savedQuote = await prepareResumePricingQuote({ context: snapshot.context, pricing: acceptancePricing, preparationKey: `prepare:${key}`, nowMs: Date.now(), lifetimeMs });
      await quotes.save(savedQuote);
      return { principal: { id: accountId }, sessionId: savedSession, checkpointId: saved.manifest.checkpointId, expectedSessionVersion: 0, expectedCheckpointVersion: 1,
        idempotencyKey: `resume:${key}`, approvePendingAction: true, capApprovalReference: command.admissionReference, pendingAction: savedQuote.context.pendingAction,
        pricingApproval: { quoteReference: savedQuote.quoteReference, quoteSha256: savedQuote.quoteSha256, maximumSat: savedQuote.maximumSat } };
    }
    const accepting = await acceptanceCheckpoint("acceptance:one");
    const short = await acceptanceCheckpoint("acceptance:short", 8000);
    const lateApi = await acceptanceCheckpoint("acceptance:late-api", 8000);
    const workerPending = await acceptanceCheckpoint("acceptance:worker", 8000);
    await expect(acceptance.claim({ ...accepting, principal: { id: "account:foreign" } })).rejects.toThrow("RESUME_QUOTE_NOT_FOUND_OR_DENIED");
    await expect(acceptance.claim({ ...accepting, pricingApproval: { ...accepting.pricingApproval, maximumSat: "4" } })).rejects.toThrow("RESUME_QUOTE_APPROVAL_MISMATCH");
    await expect(acceptance.claim(accepting)).rejects.toThrow("RESUME_BALANCE_INSUFFICIENT");
    await admin.query("UPDATE production_real.account_balance_projection SET settled_available=50,held=0 WHERE account_id=$1", [accountId]);
    await expect(acceptance.claim(accepting)).rejects.toThrow("RESUME_CAP_INSUFFICIENT");
    expect((await admin.query("SELECT count(*)::int AS count FROM production_real.priced_continuation_claims")).rows[0].count).toBe(0);
    expect((await admin.query("SELECT count(*)::int AS count FROM production_real.action_budget_reservations")).rows[0].count).toBe(0);
    // Explicit funded metadata fixture; this is not a real rail credit.
    await admin.query("UPDATE production_real.account_balance_projection SET settled_available=200,held=200 WHERE account_id=$1", [accountId]);
    await admin.query("UPDATE production_real.session_cap_holds SET requested_cap=200,held_amount=200 WHERE account_id=$1", [accountId]);
    let loseCommit = true;
    const uncertain = new ProductionResumeAcceptance({ pool: sqlPool(runtime, () => { const value = loseCommit; loseCommit = false; return value; }), quotes, preparer: acceptancePreparer, now: Date.now });
    await expect(uncertain.claim(accepting)).rejects.toThrow("COMMIT_ACK_LOST");
    const accepted = await acceptance.claim(accepting);
    expect(accepted.replayed).toBeTrue();
    expect(accepted.claim.state).toBe("accepted");
    expect(accepted.claim.settlement.operationId).toBe(accepted.claim.operationId);
    expect(accepted.claim.quote.maximumSat).toBe("41");
    expect(accepted.claim.quote.context.pendingAction.maximum).toBe("3");
    expect(accepted.claim.settlement.conversion).toEqual(acceptancePricing.conversion);
    await expect(acceptance.claim({ ...accepting, pricingApproval: { ...accepting.pricingApproval, maximumSat: "4" } })).rejects.toThrow("IDEMPOTENCY_KEY_CONFLICT");
    const metered = new PostgresSqlFundingStore(bound, { deadlineMs: 5000 });
    expect((await metered.transact(accountId, tx => tx.claimProviderOperation(accepted.claim.operationId))).claimed).toBeTrue();
    expect((await metered.transact(accountId, tx => tx.claimProviderOperation(accepted.claim.operationId))).claimed).toBeFalse();
    expect((await acceptance.find(accountId, accepting.idempotencyKey))?.state).toBe("dispatching");
    let modelPosts = 0;
    const source = acceptancePricing.card.sources;
    if (!source) throw new Error("EXPECTED_ACCEPTANCE_PRICE_SOURCE");
    const interactions = createVertexInteractionsHttpPort({ accessToken: async () => "test-only-token-aaaaaaaaaaaaaaaaaaaa", fetch: Object.assign(async (_url: Parameters<typeof fetch>[0], init?: RequestInit) => {
      if (init?.method !== "POST") throw new Error("UNEXPECTED_MODEL_REDISPATCH_OR_GET");
      modelPosts++;
      const wire = z.object({ input: z.array(z.unknown()), generation_config: z.object({ max_output_tokens: z.literal(20) }).passthrough() }).passthrough().parse(JSON.parse(String(init.body)));
      return Response.json({ id: "resume-owned-operation", model: "gemini-4-argon", status: "completed", created: new Date().toISOString(),
        steps: [{ type: "user_input", content: wire.input }, { type: "model_output", content: [{ type: "text", text: JSON.stringify({ files: [{ path: "src/main.ts", content: "document.body.textContent = 'One counter';" }] }) }] }],
        usage: { total_input_tokens: 2, total_cached_tokens: 0, total_output_tokens: 1, total_thought_tokens: 0, total_tool_use_tokens: 0, total_tokens: 3 } });
    }, { preconnect() {} }) });
    const vertexInput = { candidateSha256: "f".repeat(64), projectId: "napplet-cvm-fixture", location: "global", model: "gemini-4-argon", credentialReference: "gcp:adc:fixture",
      price: { sourceUrl: source.provider.url, sourceDocumentSha256: source.provider.capturedBytesSha256, quoteSha256: "c".repeat(64),
        observedAtMs: Date.parse(source.provider.observedAt), freshUntilMs: Date.parse(source.provider.freshUntil), effectiveFromMs: Date.parse(source.provider.effectiveAt), effectiveUntilMs: Date.parse(source.provider.freshUntil),
        currency: "USD", inputMicrosPerMillion: 1_000_000, cachedInputMicrosPerMillion: 1_000_000, outputAndThoughtMicrosPerMillion: 1_000_000 },
      journal: createPostgresVertexOperationJournal(vertexJournal), interactions, now: Date.now };
    const vertex = createVertexDeploymentClient(vertexInput);
    const gateway = new ProductionVertexModelGateway({ vertex, proposals: new ProductionSourceProposalStore(pool) });
    const intent = ProviderOperationIntentSchema.parse({ accountId, sessionId: accepting.sessionId, actionId: accepted.claim.actionId, operationId: accepted.claim.operationId, providerRequestId: accepted.claim.operationId,
      expectedVersion: 0, actionBudgetReference: accepted.claim.actionBudgetReference, profileId: acceptancePricing.profile.id, priceCardId: acceptancePricing.card.id,
      requestFingerprint: accepted.claim.fingerprint, prompt: "A focused counter", maximumUnits: acceptancePricing.profile.maximumUnits, selection: "unselected" });
    const wrongPrice = new ProductionVertexModelGateway({ vertex: createVertexDeploymentClient({ ...vertexInput, price: { ...vertexInput.price, inputMicrosPerMillion: 2_000_000 } }), proposals: new ProductionSourceProposalStore(pool) });
    expect(await wrongPrice.dispatch(intent, new AbortController().signal)).toMatchObject({ status: "definitive_not_accepted", reason: "pre_dispatch_rejected" });
    expect(modelPosts).toBe(0);
    expect(await vertexJournal.read(accepted.claim.operationId)).toBeUndefined();
    expect((await acceptance.find(accountId, accepting.idempotencyKey))?.apiClaimedAtMs).toBeNull();
    await expect(runtime.query("UPDATE production_real.priced_continuation_claims SET api_claimed_at_ms=0,api_namespace='forged',api_scope_sha256=$2,api_request_sha256=$3 WHERE claim_reference=$1", [accepted.claim.claimReference, "a".repeat(64), "b".repeat(64)])).rejects.toThrow("PRICED_CONTINUATION_API_BINDING_DENIED");
    const observed = await gateway.dispatch(intent, new AbortController().signal);
    expect(observed.status).toBe("completed");
    if (observed.status !== "completed") throw new Error("EXPECTED_MODEL_PROTOCOL_RECEIPT");
    const resumedSettlement = createProductionVertexGenerationSettlement({ gateway, journal: vertexJournal, resumeSettlements: acceptance,
      conversion: { ...acceptancePricing.conversion, satsPerUsd: { numerator: "999999", denominator: "1" } } });
    expect((await admin.query("SELECT state FROM production_real.priced_continuation_audit WHERE claim_reference=$1 ORDER BY sequence", [accepted.claim.claimReference])).rows).toEqual([{ state: "accepted" }, { state: "dispatching" }, { state: "api_claimed" }]);
    await expect(runtime.query("UPDATE production_real.priced_continuation_claims SET api_claimed_at_ms=NULL,api_namespace=NULL,api_scope_sha256=NULL,api_request_sha256=NULL WHERE claim_reference=$1", [accepted.claim.claimReference])).rejects.toThrow("PRICED_CONTINUATION_API_BINDING_IMMUTABLE");
    await expect(runtime.query("UPDATE production_real.priced_continuation_claims SET settlement_json='{}'")).rejects.toThrow();
    await expect(runtime.query("DELETE FROM production_real.priced_continuation_claims")).rejects.toThrow();
    await expect(runtime.query("INSERT INTO production_real.priced_continuation_audit(claim_reference,state) VALUES($1,'completed')", [accepted.claim.claimReference])).rejects.toThrow();
    const race = await Promise.all([acceptance.claim(short), acceptance.claim(short), acceptance.claim(short)]);
    expect(race.filter(item => !item.replayed)).toHaveLength(1);
    expect(new Set(race.map(item => item.claim.operationId)).size).toBe(1);
    const shortClaim = race[0]!.claim;
    const lateClaim = (await acceptance.claim(lateApi)).claim;
    expect((await metered.transact(accountId, tx => tx.claimProviderOperation(lateClaim.operationId))).claimed).toBeTrue();
    const workerClaim = (await acceptance.claim(workerPending)).claim;
    let loseWorkerCommit = true;
    const workerUncertain = new ProductionResumeAcceptance({ pool: sqlPool(runtime, () => { const value = loseWorkerCommit; loseWorkerCommit = false; return value; }), quotes, preparer: acceptancePreparer });
    await expect(workerUncertain.claimWorker(accountId, workerPending.idempotencyKey)).rejects.toThrow("COMMIT_ACK_LOST");
    const workerReplay = await acceptance.claimWorker(accountId, workerPending.idempotencyKey);
    expect(workerReplay.claimed).toBeFalse();
    expect(workerReplay.claim.workerClaimedAtMs).not.toBeNull();
    await expect(runtime.query("UPDATE production_real.priced_continuation_claims SET worker_claimed_at_ms=NULL WHERE claim_reference=$1", [workerClaim.claimReference])).rejects.toThrow("PRICED_CONTINUATION_WORKER_BINDING_IMMUTABLE");
    await expect(acceptance.supersedeUnclaimed(accountId, workerPending.idempotencyKey)).rejects.toThrow("PRICED_CONTINUATION_SUPERSESSION_DENIED");
    await Bun.sleep(Math.max(1, shortClaim.quote.expiresAtMs - Date.now() + 10));
    expect(Date.now()).toBeGreaterThanOrEqual(Date.parse(accepted.claim.settlement.conversion.source.freshUntil));
    const firstSettlement = await resumedSettlement.finalize({ accountId, intent, receipt: observed.receipt, pricedAmount: "3" });
    expect(firstSettlement.amount).toBe("1");
    const historical = await acceptancePreparer.loadAcceptedAuthority({ principal: accepting.principal, idempotencyKey: accepting.idempotencyKey });
    expect(Date.now()).toBeGreaterThanOrEqual(historical.quote.expiresAtMs);
    expect(historical.quote).toEqual(accepted.claim.quote);
    expect(historical.command).toEqual({ ...command, idempotencyKey: "acceptance:one" });
    expect(historical.context.commandSha256).toBe(accepted.claim.quote.context.commandSha256);
    expect(historical.originalSettlement.bindingSha256).toBe(accepted.claim.quote.context.originalSettlementSha256);
    expect(historical.claimReference).toBe(accepted.claim.claimReference);
    const readsAfterHistorical = objectReads;
    await expect(acceptancePreparer.loadAcceptedAuthority({ principal: { id: "account:foreign" }, idempotencyKey: accepting.idempotencyKey })).rejects.toThrow("RESUME_ACCEPTED_COMMAND_NOT_FOUND_OR_DENIED");
    await expect(acceptancePreparer.loadAcceptedAuthority({ principal: accepting.principal, idempotencyKey: "resume:missing" })).rejects.toThrow("RESUME_ACCEPTED_COMMAND_NOT_FOUND_OR_DENIED");
    await expect(acceptancePreparer.loadAcceptedAuthority({ principal: accepting.principal, idempotencyKey: accepting.idempotencyKey, replay: true })).rejects.toThrow();
    expect(objectReads).toBe(readsAfterHistorical);
    expect(await acceptancePreparer.prepare({ principal: accepting.principal, sessionId: accepting.sessionId, checkpointId: accepting.checkpointId,
      expectedSessionVersion: 0, expectedCheckpointVersion: 1, idempotencyKey: "prepare:claimed-refresh" })).toEqual({ status: "denied", code: "RESUME_STALE_OR_CONFLICTING" });
    const expiredCustody = new ProductionResumePricingPreparer({ pool, store, quotes, checkpoint, vertexJournal, currentPricing: acceptancePricing,
      compatibility: { policyVersion: pending.policyVersion, acceptedToolchains: [pending.toolchainId] }, now: () => historical.context.retentionUntilMs });
    await expect(expiredCustody.loadAcceptedAuthority({ principal: accepting.principal, idempotencyKey: accepting.idempotencyKey })).rejects.toThrow("RESUME_STALE_OR_CONFLICTING");
    expect(modelPosts).toBe(1);
    expect(await resumedSettlement.finalize({ accountId, intent, receipt: observed.receipt, pricedAmount: "3" })).toEqual(firstSettlement);
    for (const changedIntent of [
      { ...intent, accountId: "account:foreign" }, { ...intent, sessionId: "session:foreign" }, { ...intent, actionId: "action:foreign" },
      { ...intent, providerRequestId: "operation:foreign" }, { ...intent, actionBudgetReference: "budget:foreign" },
      { ...intent, requestFingerprint: "a".repeat(64) }, { ...intent, expectedVersion: 1 }, { ...intent, profileId: "profile:foreign" },
      { ...intent, priceCardId: "card:foreign" }, { ...intent, maximumUnits: [{ dimension: "input_tokens", units: "1" }] },
    ]) await expect(resumedSettlement.finalize({ accountId, intent: ProviderOperationIntentSchema.parse(changedIntent), receipt: observed.receipt, pricedAmount: "3" })).rejects.toThrow("PRODUCTION_PRICED_SETTLEMENT_BINDING_DENIED");
    for (const changedReceipt of [
      { ...observed.receipt, operationId: "operation:foreign" }, { ...observed.receipt, providerRequestId: "request:foreign" },
      { ...observed.receipt, profileId: "profile:foreign" }, { ...observed.receipt, priceCardId: "card:foreign" },
      { ...observed.receipt, model: "model:foreign" }, { ...observed.receipt, provider: "deterministic_fixture" },
    ]) await expect(resumedSettlement.finalize({ accountId, intent, receipt: NormalizedUsageReceiptSchema.parse(changedReceipt), pricedAmount: "3" })).rejects.toThrow("PRODUCTION_PRICED_SETTLEMENT_BINDING_DENIED");
    expect(modelPosts).toBe(1);
    const lateIntent = ProviderOperationIntentSchema.parse({ ...intent, sessionId: lateApi.sessionId, actionId: lateClaim.actionId, operationId: lateClaim.operationId,
      providerRequestId: lateClaim.operationId, actionBudgetReference: lateClaim.actionBudgetReference, requestFingerprint: lateClaim.fingerprint });
    expect(await gateway.dispatch(lateIntent, new AbortController().signal)).toMatchObject({ status: "definitive_not_accepted", reason: "pre_dispatch_rejected" });
    expect(await vertexJournal.read(lateClaim.operationId)).toBeUndefined();
    expect((await acceptance.find(accountId, lateApi.idempotencyKey))?.apiClaimedAtMs).toBeNull();
    expect(modelPosts).toBe(1);
    expect((await acceptance.claim(short)).replayed).toBeTrue(); // Expiry cannot change an accepted operation's identity/FX.
    await expect(metered.transact(accountId, tx => tx.claimProviderOperation(shortClaim.operationId))).rejects.toThrow("PRICED_CONTINUATION_DISPATCH_DENIED");
    expect((await acceptance.find(accountId, short.idempotencyKey))?.state).toBe("accepted");
    expect((await admin.query("SELECT count(*)::int AS count FROM production_real.priced_continuation_claims")).rows[0].count).toBe(4);
    expect((await admin.query("SELECT count(*)::int AS count FROM production_real.action_budget_reservations")).rows[0].count).toBe(4);
    expect((await admin.query("SELECT count(*)::int AS count FROM production_real.ledger_entries")).rows[0].count).toBe(0);
    await expect(acceptance.supersedeUnclaimed("account:foreign", lateApi.idempotencyKey)).rejects.toThrow("PRICED_CONTINUATION_NOT_FOUND_OR_DENIED");
    await expect(acceptance.supersedeUnclaimed(accountId, accepting.idempotencyKey)).rejects.toThrow("PRICED_CONTINUATION_SUPERSESSION_DENIED");
    await expect(acceptance.claimWorker(accountId, short.idempotencyKey)).rejects.toThrow("PRICED_CONTINUATION_WORKER_CLAIM_DENIED");
    // A late validation failure rolls back the release and every state change.
    await admin.query("UPDATE production_real.metered_sessions SET version=1 WHERE id=$1", [lateApi.sessionId]);
    await expect(acceptance.supersedeUnclaimed(accountId, lateApi.idempotencyKey)).rejects.toThrow("METERED_SESSION_VERSION_CONFLICT");
    expect((await admin.query("SELECT state FROM production_real.action_budget_reservations WHERE reservation_reference=$1", [lateClaim.actionBudgetReference])).rows[0].state).toBe("authorized");
    expect((await acceptance.find(accountId, lateApi.idempotencyKey))?.state).toBe("dispatching");
    await admin.query("UPDATE production_real.metered_sessions SET version=0 WHERE id=$1", [lateApi.sessionId]);
    let loseSupersessionCommit = true;
    const supersessionUncertain = new ProductionResumeAcceptance({ pool: sqlPool(runtime, () => { const value = loseSupersessionCommit; loseSupersessionCommit = false; return value; }), quotes, preparer: acceptancePreparer });
    await expect(supersessionUncertain.supersedeUnclaimed(accountId, lateApi.idempotencyKey)).rejects.toThrow("COMMIT_ACK_LOST");
    expect((await acceptance.supersedeUnclaimed(accountId, lateApi.idempotencyKey)).state).toBe("superseded");
    const superseded = await Promise.all([acceptance.supersedeUnclaimed(accountId, short.idempotencyKey), acceptance.supersedeUnclaimed(accountId, short.idempotencyKey)]);
    expect(superseded.every(item => item.state === "superseded")).toBeTrue();
    expect((await acceptance.claim(short)).claim.state).toBe("superseded");
    await expect(acceptancePreparer.loadAcceptedAuthority({ principal: short.principal, idempotencyKey: short.idempotencyKey })).rejects.toThrow("RESUME_ACCEPTED_COMMAND_NOT_FOUND_OR_DENIED");
    await expect(acceptance.claimWorker(accountId, short.idempotencyKey)).rejects.toThrow("PRICED_CONTINUATION_WORKER_CLAIM_DENIED");
    expect(await gateway.dispatch(lateIntent, new AbortController().signal)).toMatchObject({ status: "definitive_not_accepted" });
    expect(modelPosts).toBe(1);
    expect((await metered.transact(accountId, tx => tx.claimProviderOperation(shortClaim.operationId))).claimed).toBeFalse();
    for (const releasedClaim of [lateClaim, shortClaim]) {
      expect((await admin.query("SELECT state FROM production_real.action_budget_reservations WHERE reservation_reference=$1", [releasedClaim.actionBudgetReference])).rows[0].state).toBe("released");
      expect((await admin.query("SELECT state FROM production_real.continuation_checkpoints WHERE checkpoint_id=$1", [releasedClaim.checkpointId])).rows[0].state).toBe("resume_required");
      expect((await admin.query("SELECT state FROM production_real.continuation_pauses WHERE session_id=$1", [releasedClaim.sessionId])).rows[0].state).toBe("resume_required");
      expect((await admin.query("SELECT state,version,current_verified_artifact_version,confirmed_spend_sat FROM production_real.metered_sessions WHERE id=$1", [releasedClaim.sessionId])).rows[0]).toEqual({ state: "needs_top_up", version: 0, current_verified_artifact_version: 0, confirmed_spend_sat: "0" });
      expect((await admin.query("SELECT state,receipt_charge,provider_receipt_reference,session_version,artifact_version FROM production_real.metered_actions WHERE id=$1", [releasedClaim.actionId])).rows[0]).toEqual({ state: "failed", receipt_charge: "0", provider_receipt_reference: null, session_version: 0, artifact_version: 0 });
      const terminal = await metered.findMeteredAction(accountId, releasedClaim.actionKey);
      expect(SessionActionResultSchema.parse(terminal?.result)).toMatchObject({ status: "failed", code: "PROVIDER_NOT_ACCEPTED", operationId: releasedClaim.operationId, confirmedSpend: "0" });
      expect((await admin.query("SELECT kind,amount_sat FROM production_real.billing_line_items WHERE operation_id=$1", [releasedClaim.operationId])).rows).toEqual([{ kind: "release", amount_sat: "41" }]);
      expect((await admin.query("SELECT state FROM production_real.priced_continuation_audit WHERE claim_reference=$1 ORDER BY sequence DESC LIMIT 1", [releasedClaim.claimReference])).rows[0].state).toBe("superseded");
    }
    expect((await admin.query("SELECT settled_available,held FROM production_real.account_balance_projection WHERE account_id=$1", [accountId])).rows[0]).toEqual({ settled_available: "200", held: "200" });
    expect((await admin.query("SELECT held_amount FROM production_real.session_cap_holds WHERE account_id=$1", [accountId])).rows[0].held_amount).toBe("200");
    for (const table of ["usage_receipts", "ledger_entries"]) expect((await admin.query(`SELECT count(*)::int AS count FROM production_real.${table}`)).rows[0].count).toBe(0);
    // Explicit new approval can reuse the preserved checkpoint, but neither
    // old signed delivery nor a quote refresh resurrects the old operation.
    const refreshedPricing = await resumePricingMaterial(Date.now(), "profile:refreshed", "2000");
    await registerProductionPricing({ pool, ...refreshedPricing });
    const refreshedPreparer = new ProductionResumePricingPreparer({ pool, store, quotes, checkpoint, vertexJournal, currentPricing: refreshedPricing,
      compatibility: { policyVersion: pending.policyVersion, acceptedToolchains: [pending.toolchainId] }, now: Date.now });
    const retainedAfterRepricing = await refreshedPreparer.loadAcceptedAuthority({ principal: accepting.principal, idempotencyKey: accepting.idempotencyKey });
    expect(retainedAfterRepricing.quote.pricing.profile.id).toBe(acceptancePricing.profile.id);
    expect(retainedAfterRepricing.quote.pricing.profile.id).not.toBe(refreshedPricing.profile.id);
    expect(retainedAfterRepricing.originalPricing.profile.id).toBe(originalPricing.profile.id);
    const refreshedAcceptance = new ProductionResumeAcceptance({ pool, quotes, preparer: refreshedPreparer });
    const renewedQuote = await refreshedPreparer.prepare({ principal: short.principal, sessionId: short.sessionId, checkpointId: short.checkpointId,
      expectedSessionVersion: 0, expectedCheckpointVersion: 1, idempotencyKey: "prepare:explicit-renewal" });
    if (renewedQuote.status !== "quoted") throw new Error(`EXPECTED_RENEWED_QUOTE:${renewedQuote.code}`);
    const renewed = await refreshedAcceptance.claim({ ...short, idempotencyKey: "resume:explicit-renewal", pricingApproval: {
      quoteReference: renewedQuote.quoteReference, quoteSha256: renewedQuote.quoteSha256, maximumSat: renewedQuote.pricing.maximumSat } });
    expect(renewed.replayed).toBeFalse();
    expect(renewed.claim.quote.context.commandSha256).toBe(shortClaim.quote.context.commandSha256);
    expect(renewed.claim.operationId).not.toBe(shortClaim.operationId);
    expect((await refreshedAcceptance.claim(short)).claim.state).toBe("superseded");
    expect((await metered.transact(accountId, tx => tx.claimProviderOperation(renewed.claim.operationId))).claimed).toBeTrue();
    expect((await refreshedAcceptance.supersedeUnclaimed(accountId, "resume:explicit-renewal")).state).toBe("superseded");
    expect(Date.now()).toBeLessThan(renewed.claim.quote.expiresAtMs);
    const supersededIntent = ProviderOperationIntentSchema.parse({ ...intent, sessionId: short.sessionId, actionId: renewed.claim.actionId,
      operationId: renewed.claim.operationId, providerRequestId: renewed.claim.operationId, actionBudgetReference: renewed.claim.actionBudgetReference,
      requestFingerprint: renewed.claim.fingerprint, profileId: refreshedPricing.profile.id, priceCardId: refreshedPricing.card.id });
    expect(await gateway.dispatch(supersededIntent, new AbortController().signal)).toMatchObject({ status: "definitive_not_accepted", reason: "pre_dispatch_rejected" });
    expect(await vertexJournal.read(renewed.claim.operationId)).toBeUndefined();
    expect(modelPosts).toBe(1);
    // Protocol-only worker fixture. Durable SQL intents and the real resolver
    // are exercised; no external Modal/Fly worker is allocated by this test.
    let reserves = 0, observes = 0;
    let fixtureProvider: "modal" | "fly" = "modal";
    const readyWorkers = new Map<string, CapacityReservation>();
    const capacityJournal = new PostgresOperationJournal(pool, { namespace: "fixture-resume-capacity", scopeSha256: "9".repeat(64) });
    const capacity: ReadyCapacityPort = {
      async reserveNow(value) {
        reserves++;
        const reference = `capacity:${hash(value)}`, expiresAt = new Date(Date.now() + 60_000).toISOString();
        const ready: CapacityReservation = { status: "available", reference, expiresAt, usable: true,
          ready: { intentReference: value.intentReference, leaseReference: reference, sessionBindingDigest: value.expectedSessionBindingDigest,
            imageDigest: `sha256:${"a".repeat(64)}`, readinessProbeDigest: `sha256:${"b".repeat(64)}`, readyMonotonicMs: 100 } };
        readyWorkers.set(value.intentReference, ready);
        await capacityJournal.claim(`capacity-intent:${createHash("sha256").update(value.intentReference).digest("hex")}`, hash(value),
          { ...value, reference, workerOperationId: `capacity-${hash(value).slice(0, 40)}`, provider: fixtureProvider, deadlineEpochMs: Date.parse(expiresAt) });
        throw new Error("WORKER_RESERVE_ACK_LOST");
      },
      async observe(value) {
        observes++;
        const original = readyWorkers.get(value.intentReference);
        if (!original || observes === 1) return { status: "unknown" };
        if (observes === 2) return { ...original, ready: { ...original.ready, sessionBindingDigest: `sha256:${"0".repeat(64)}` } };
        return original;
      },
      async release() { throw new Error("UNEXPECTED_WORKER_RELEASE"); },
    };
    const workerAuthority = new ProductionPricedContinuationWorkers({ pool, acceptance: refreshedAcceptance, capacity });
    await workerAuthority.assertReady();
    await admin.query("REVOKE INSERT ON production_real.priced_continuation_worker_allocations FROM napplet_production_real");
    await expect(workerAuthority.assertReady()).rejects.toThrow("PRODUCTION_PRICED_WORKER_SCHEMA_REQUIRED");
    await admin.query("GRANT INSERT ON production_real.priced_continuation_worker_allocations TO napplet_production_real");
    await workerAuthority.assertReady();
    for (const [table, trigger] of [["priced_continuation_worker_intents", "priced_worker_intent_guard"],
      ["priced_continuation_worker_allocations", "priced_worker_allocation_guard"], ["capacity_intents", "priced_capacity_dispatch_fence"]]) {
      await admin.query(`ALTER TABLE production_real.${table} DISABLE TRIGGER ${trigger}`);
      await expect(workerAuthority.assertReady()).rejects.toThrow("PRODUCTION_PRICED_WORKER_SCHEMA_REQUIRED");
      await admin.query(`ALTER TABLE production_real.${table} ENABLE TRIGGER ${trigger}`);
    }
    await workerAuthority.assertReady();
    await expect(workerAuthority.allocate(accountId, workerPending.idempotencyKey)).rejects.toThrow("PRICED_CAPACITY_DISPATCH_DENIED");
    expect(reserves).toBe(0);
    const terminalQuoteAuthority = await refreshedPreparer.loadAuthority({ principal: short.principal, sessionId: short.sessionId, checkpointId: short.checkpointId,
      expectedSessionVersion: 0, expectedCheckpointVersion: 1, idempotencyKey: "prepare:worker-allocation" });
    const terminalQuote = await prepareResumePricingQuote({ context: terminalQuoteAuthority.context, pricing: refreshedPricing,
      preparationKey: "prepare:worker-allocation", nowMs: Date.now(), lifetimeMs: 8000 });
    await quotes.save(terminalQuote);
    const workerQuote = await projectResumePricingQuote(terminalQuote);
    const workerCommand = { ...short, idempotencyKey: "resume:worker-allocation", pricingApproval: {
      quoteReference: workerQuote.quoteReference, quoteSha256: workerQuote.quoteSha256, maximumSat: workerQuote.pricing.maximumSat } };
    const allocating = (await refreshedAcceptance.claim(workerCommand)).claim;
    await expect(workerAuthority.allocate("account:foreign", workerCommand.idempotencyKey)).rejects.toThrow("PRICED_CONTINUATION_WORKER_CLAIM_DENIED");
    expect(await workerAuthority.allocate(accountId, workerCommand.idempotencyKey)).toEqual({ status: "reconciliation_pending" });
    expect(reserves).toBe(1);
    expect(await workerAuthority.read(accountId, allocating.claimReference)).toBeUndefined();
    expect(await workerAuthority.allocate(accountId, workerCommand.idempotencyKey)).toEqual({ status: "reconciliation_pending" });
    expect(reserves).toBe(1);
    expect(await workerAuthority.read(accountId, allocating.claimReference)).toBeUndefined();
    let allocationCommits = 0;
    const uncertainWorkers = new ProductionPricedContinuationWorkers({ pool: sqlPool(runtime, () => ++allocationCommits === 2), acceptance: refreshedAcceptance, capacity });
    await expect(uncertainWorkers.allocate(accountId, workerCommand.idempotencyKey)).rejects.toThrow("COMMIT_ACK_LOST");
    expect(await workerAuthority.read(accountId, allocating.claimReference)).toBeDefined();
    const allocated = await workerAuthority.allocate(accountId, workerCommand.idempotencyKey);
    expect(allocated.status).toBe("available");
    if (allocated.status !== "available") throw new Error("EXPECTED_ORIGINAL_WORKER_ALLOCATION");
    const allocationRaces = await Promise.all(Array.from({ length: 3 }, () => workerAuthority.allocate(accountId, workerCommand.idempotencyKey)));
    expect(allocationRaces.every(item => item.status === "available")).toBeTrue();
    expect(reserves).toBe(1);
    expect(await workerAuthority.read("account:foreign", allocating.claimReference)).toBeUndefined();
    expect((await admin.query("SELECT count(*)::int AS count FROM production_real.priced_continuation_worker_allocations")).rows[0].count).toBe(1);
    await expect(runtime.query("UPDATE production_real.priced_continuation_worker_allocations SET expires_at=expires_at+interval '1 second'")).rejects.toThrow();
    await expect(runtime.query("DELETE FROM production_real.priced_continuation_worker_intents")).rejects.toThrow();
    const capacityIntent = (await refreshedAcceptance.claimWorker(accountId, workerCommand.idempotencyKey)).workerIntent;
    await expect(runtime.query("UPDATE production_real.capacity_intents SET capacity_reference=$3 WHERE account_id=$1 AND intent_reference=$2", [accountId, capacityIntent.capacityIntentReference, `capacity:${"f".repeat(64)}`])).rejects.toThrow("PRICED_CAPACITY_TRANSITION_DENIED");
    await admin.query("UPDATE production_real.funding_accounts SET nostr_pubkey=$2 WHERE account_id=$1", [accountId, principal.pubkey]);
    const workerRequest = { sessionId: allocating.sessionId, actionId: allocating.actionId, expectedVersion: 0, policyVersion: pending.policyVersion,
      capabilityGrant: "phase-04-coordinator-grant", workspaceId: `workspace:${allocating.sessionId}`, idea: "One counter" };
    const oldResolver = new ProductionWorkerOwnershipResolver({ pool, policyVersion: pending.policyVersion, capacityJournal });
    await expect(oldResolver.resolveWorker(workerRequest)).rejects.toThrow("PRODUCTION_PRICED_CONTINUATION_WORKERS_REQUIRED");
    const resolver = new ProductionWorkerOwnershipResolver({ pool, policyVersion: pending.policyVersion, capacityJournal, pricedContinuations: workerAuthority });
    expect(await resolver.resolveWorker(workerRequest)).toMatchObject({ accountId, ownerId: principal.pubkey, intentReference: capacityIntent.capacityIntentReference,
      capacityReference: allocated.allocation.capacityReference, provider: "modal" });
    const pendingAuthority = await refreshedPreparer.loadAcceptedAuthority({ principal: workerCommand.principal, idempotencyKey: workerCommand.idempotencyKey });
    const { idea: _restoreIdea, ...restoreWorkerBinding } = workerRequest;
    const commandOnlyRestore = pricedRestoreBinding({ ...restoreWorkerBinding, accountId, capabilityGrant: "phase-05-continuation-grant",
      checkpointId: allocating.checkpointId, pauseGeneration: pendingAuthority.material.manifest.pauseGeneration,
      actionVersion: pendingAuthority.material.manifest.actionVersion, workspaceLineage: pendingAuthority.material.manifest.workspaceLineage,
      leaseToken: allocating.leaseToken, resumeClaim: allocating.allocationIntentReference, archiveSha256: pendingAuthority.material.manifest.archiveSha256 });
    await expect(resolver.resolvePricedRestore(commandOnlyRestore.metadata, workerRequest)).rejects.toThrow("PRODUCTION_PRICED_RESTORE_BINDING_DENIED");
    const restoreMigration = await Bun.file("migrations/phase-07/012_production_priced_continuation_restores.sql").text();
    await admin.query(restoreMigration); await admin.query(restoreMigration);
    let workspaceCalls = 0;
    const unexpectedWorkspace = async () => { workspaceCalls++; throw new Error("COMMAND_ONLY_CANNOT_RESTORE_WORKSPACE"); };
    const restoreInput = { pool, acceptance: refreshedAcceptance, preparer: refreshedPreparer, workers: workerAuthority, checkpoint, jobJournal: vertexJournal,
      worker: { registerContinuationRequest: unexpectedWorkspace, restorePricedCheckpoint: unexpectedWorkspace, observePricedRestoreCheckpoint: unexpectedWorkspace } };
    const restores = new ProductionPricedContinuationRestores(restoreInput);
    await restores.assertReady();
    for (const [table, trigger] of [["priced_continuation_restores", "priced_restore_guard"], ["priced_continuation_restores", "priced_restore_audit"],
      ["priced_continuation_restore_audit", "priced_restore_audit_immutable"], ["release_operation_journal", "priced_restored_api_claim_fence"]]) {
      await admin.query(`ALTER TABLE production_real.${table} DISABLE TRIGGER ${trigger}`);
      await expect(restores.assertReady()).rejects.toThrow("PRODUCTION_PRICED_RESTORE_SCHEMA_REQUIRED");
      await admin.query(`ALTER TABLE production_real.${table} ENABLE TRIGGER ${trigger}`);
    }
    await restores.assertReady();
    expect((await metered.transact(accountId, tx => tx.claimProviderOperation(allocating.operationId))).claimed).toBeTrue();
    const allocatingIntent = ProviderOperationIntentSchema.parse({ ...intent, sessionId: allocating.sessionId, actionId: allocating.actionId,
      operationId: allocating.operationId, providerRequestId: allocating.operationId, actionBudgetReference: allocating.actionBudgetReference,
      requestFingerprint: allocating.fingerprint, profileId: refreshedPricing.profile.id, priceCardId: refreshedPricing.card.id });
    expect(await gateway.dispatch(allocatingIntent, new AbortController().signal)).toMatchObject({ status: "definitive_not_accepted", reason: "pre_dispatch_rejected" });
    expect(modelPosts).toBe(1);
    expect(await vertexJournal.read(allocating.operationId)).toBeUndefined();
    let failPauseWrite = true;
    const rollbackRestores = new ProductionPricedContinuationRestores({ ...restoreInput,
      pool: sqlPool(runtime, undefined, () => { const value = failPauseWrite; failPauseWrite = false; return value; }) });
    await expect(rollbackRestores.restore(accountId, workerCommand.idempotencyKey)).rejects.toThrow("RESTORE_PAUSE_WRITE_FAILED");
    expect((await restores.read(accountId, allocating.claimReference))?.state).toBe("claimed");
    expect((await store.findContinuationPause(accountId, allocating.sessionId, 1))?.state).toBe("claimed");
    await expect(runtime.query("UPDATE production_real.priced_continuation_restores SET state='restored',proof_json=$2::jsonb WHERE claim_reference=$1", [allocating.claimReference,
      JSON.stringify({ kind: "workspace", nativeEvidenceSha256: "a".repeat(64) })])).rejects.toThrow("PRICED_RESTORE_COMMAND_PROOF_DENIED");
    let restoreCommits = 0;
    const uncertainRestores = new ProductionPricedContinuationRestores({ ...restoreInput, pool: sqlPool(runtime, () => ++restoreCommits === 2) });
    await expect(uncertainRestores.restore(accountId, workerCommand.idempotencyKey)).rejects.toThrow("COMMIT_ACK_LOST");
    expect((await store.findContinuationPause(accountId, allocating.sessionId, 1))?.state).toBe("restored");
    const restoredCommand = await restores.restore(accountId, workerCommand.idempotencyKey);
    expect(restoredCommand.status).toBe("restored");
    if (restoredCommand.status !== "restored") throw new Error("EXPECTED_COMMAND_CUSTODY_PROOF");
    expect(restoredCommand.restore.proof).toEqual({ kind: "command", commandSha256: allocating.quote.context.commandSha256 });
    expect((await restores.restore(accountId, workerCommand.idempotencyKey))).toEqual(restoredCommand);
    expect(workspaceCalls).toBe(0);
    expect(await restores.read("account:foreign", allocating.claimReference)).toBeUndefined();
    await expect(restores.restore("account:foreign", workerCommand.idempotencyKey)).rejects.toThrow("PRICED_RESTORE_NOT_FOUND_OR_DENIED");
    await expect(runtime.query("UPDATE production_real.priced_continuation_restores SET state='unknown',proof_json=NULL")).rejects.toThrow("PRICED_RESTORE_IMMUTABLE");
    await expect(runtime.query("DELETE FROM production_real.priced_continuation_restores")).rejects.toThrow();
    expect((await admin.query("SELECT state FROM production_real.priced_continuation_restore_audit WHERE claim_reference=$1 ORDER BY sequence", [allocating.claimReference])).rows).toEqual([{ state: "claimed" }, { state: "restored" }]);
    const pendingObserved = await gateway.dispatch(allocatingIntent, new AbortController().signal);
    expect(pendingObserved.status).toBe("completed");
    if (pendingObserved.status !== "completed") throw new Error("EXPECTED_PENDING_NATIVE_USAGE");
    expect(modelPosts).toBe(2);
    const unallocatedRequest = { ...workerRequest, sessionId: workerPending.sessionId, actionId: workerClaim.actionId, workspaceId: `workspace:${workerPending.sessionId}` };
    await expect(resolver.resolveWorker(unallocatedRequest)).rejects.toThrow("PRODUCTION_WORKER_ACTION_OWNER_NOT_FOUND");
    await expect(refreshedAcceptance.supersedeUnclaimed(accountId, workerCommand.idempotencyKey)).rejects.toThrow("PRICED_CONTINUATION_SUPERSESSION_DENIED");
    await metered.transact(accountId, tx => tx.releaseCapacityIntent(capacityIntent.capacityIntentReference));
    await expect(workerAuthority.allocate(accountId, workerCommand.idempotencyKey)).resolves.toEqual({ status: "refused" });
    await expect(metered.transact(accountId, tx => tx.recordCapacityObservation({ intentReference: capacityIntent.capacityIntentReference, state: "available" }))).rejects.toThrow("PRICED_CAPACITY_TRANSITION_DENIED");
    await expect(resolver.resolveWorker(workerRequest)).rejects.toThrow("PRODUCTION_WORKER_ACTION_OWNER_NOT_FOUND");
    expect(reserves).toBe(1);
    expect(modelPosts).toBe(2);
    // Full encrypted workspace -> real bridge -> native restore claim and
    // evidence -> durable SQL proof. Only the external provider RPC is local.
    const workspaceQuote = await refreshedPreparer.prepare({ principal: { id: accountId }, sessionId: workspaceCommand.sessionId,
      checkpointId: workspaceSealed.manifest.checkpointId, expectedSessionVersion: 1, expectedCheckpointVersion: 1, idempotencyKey: "prepare:workspace-native" });
    if (workspaceQuote.status !== "quoted") throw new Error(`EXPECTED_NATIVE_WORKSPACE_QUOTE:${workspaceQuote.code}`);
    const workspaceResume = { principal: { id: accountId }, sessionId: workspaceCommand.sessionId, checkpointId: workspaceSealed.manifest.checkpointId,
      expectedSessionVersion: 1, expectedCheckpointVersion: 1, idempotencyKey: "resume:workspace-native", approvePendingAction: true,
      capApprovalReference: workspaceCommand.admissionReference, pendingAction: workspaceQuote.pendingAction,
      pricingApproval: { quoteReference: workspaceQuote.quoteReference, quoteSha256: workspaceQuote.quoteSha256, maximumSat: workspaceQuote.pricing.maximumSat } };
    const workspaceClaim = (await refreshedAcceptance.claim(workspaceResume)).claim;
    fixtureProvider = "fly";
    const workspaceAllocation = await workerAuthority.allocate(accountId, workspaceResume.idempotencyKey);
    if (workspaceAllocation.status !== "available") throw new Error("EXPECTED_WORKSPACE_CAPACITY");
    const workspaceCapacityIntent = (await refreshedAcceptance.claimWorker(accountId, workspaceResume.idempotencyKey)).workerIntent;
    const workerOperationId = `capacity-${hash({ intentReference: workspaceCapacityIntent.capacityIntentReference, expectedSessionBindingDigest: workspaceCapacityIntent.sessionBindingDigest }).slice(0, 40)}`;
    const nativeWorkerJournal = new PostgresOperationJournal(pool, { namespace: "fixture-workspace-workers", scopeSha256: "4".repeat(64) });
    const nativeJobJournal = new PostgresOperationJournal(pool, { namespace: "fixture-workspace-jobs", scopeSha256: "4".repeat(64) });
    const nativeRequestJournal = new PostgresOperationJournal(pool, { namespace: "fixture-workspace-requests", scopeSha256: "4".repeat(64) });
    const nativeWorkerRecords = createPostgresWorkerOperationJournal(nativeWorkerJournal);
    await nativeWorkerRecords.claim({ operationId: workerOperationId, requestSha256: "c".repeat(64), resourceName: workerOperationId, provider: "fly", appName: "resume-workspace-fixture",
      policyVersion: PRODUCTION_WORKER_POLICY.version, image: `registry.example/worker@sha256:${"a".repeat(64)}`,
      sessionLeaseSha256: workspaceCapacityIntent.sessionBindingDigest.slice(7), toolchainSha256: workspaceToolchain,
      providerDeadlineEpochMs: Date.parse(workspaceAllocation.allocation.expiresAt), createdAtMs: Date.now() });
    await nativeWorkerRecords.update({ operationId: workerOperationId, requestSha256: "c".repeat(64), resourceId: "fixture-workspace-machine", state: "reconciled" });
    let nativeRestores = 0, nativeQueries = 0, nativeUploads = 0, wrongNativeReceipt = true;
    const noNativeEffect = async () => { throw new Error("UNEXPECTED_NATIVE_WORKER_OPERATION"); };
    const workerClients = createWorkerDeploymentClients({ image: `registry.example/worker@sha256:${"a".repeat(64)}`, workspaceRoot: PRODUCTION_WORKER_POLICY.workspaceRoot,
      policyVersion: PRODUCTION_WORKER_POLICY.version, modalAppName: "resume-workspace-fixture", modalTags: {}, journal: nativeWorkerRecords,
      modalSdk: { apps: { fromName: noNativeEffect }, images: { fromRegistry: noNativeEffect }, sandboxes: { create: noNativeEffect, findByName: noNativeEffect, fromId: noNativeEffect } },
      fly: { create: noNativeEffect, observe: noNativeEffect, terminate: noNativeEffect, observeTermination: noNativeEffect,
        async exec(value): Promise<{ status: "completed"; exitCode: number; stdout: string }> {
          const [, action, archiveSha256, index, data] = value.command;
          if (action === "restore-put") { nativeUploads++; return { status: "completed", exitCode: 0,
            stdout: JSON.stringify({ state: "stored", archiveSha256, chunk: Number(index), sha256: bytesSha(Buffer.from(data ?? "", "base64")) }) }; }
          if (action === "restore") { nativeRestores++; throw new Error("NATIVE_WORKSPACE_RESTORE_ACK_LOST"); }
          if (action === "restore-status") { nativeQueries++; return { status: "completed", exitCode: 0,
            stdout: JSON.stringify({ state: "restored", archiveSha256: bytesSha(workspaceBytes), toolchainSha256: workspaceToolchain,
              sourceSha256: wrongNativeReceipt ? "0".repeat(64) : bytesSha(canonicalJson(workspaceSource.files)),
              artifactFilesSha256: bytesSha(canonicalJson(workspaceFiles)), workspacePath: "/workspace/restored" }) }; }
          throw new Error("UNEXPECTED_NATIVE_RESTORE_COMMAND");
        } } });
    const sourceRequest = WorkerRunRequestSchema.parse({ sessionId: workspaceCommand.sessionId, actionId: workspaceSource.actionId, expectedVersion: 1,
      policyVersion: workspaceCommand.policyVersion, capabilityGrant: "phase-04-coordinator-grant", workspaceId: `workspace:${workspaceCommand.sessionId}`,
      sourceProposalReference: `proposal:sha256:${workspaceSource.proposalSha256}`, sourceProposalSha256: workspaceSource.proposalSha256, sourceProposalFiles: workspaceSource.files });
    await new ProductionWorkerRequestStore(nativeRequestJournal).persist(sourceRequest);
    const nativeBridge = () => new ProductionWorkerBridge({ resolver: new ProductionWorkerOwnershipResolver({ pool, policyVersion: workspaceCommand.policyVersion,
      capacityJournal, pricedContinuations: workerAuthority }), workers: workerClients, workerJournal: nativeWorkerJournal, jobJournal: nativeJobJournal,
      requestJournal: nativeRequestJournal, artifactStore: new GcsObjectStoreAdapter({ config: { bucket: "workspace-fixture", projectId: "fixture" }, client: objectClient }), toolchainSha256: workspaceToolchain });
    const workspaceRestores = () => new ProductionPricedContinuationRestores({ pool, acceptance: refreshedAcceptance, preparer: refreshedPreparer,
      workers: workerAuthority, checkpoint, jobJournal: nativeJobJournal, worker: nativeBridge() });
    await workspaceRestores().assertReady();
    expect(await workspaceRestores().restore(accountId, workspaceResume.idempotencyKey)).toEqual({ status: "reconciliation_pending" });
    expect(nativeRestores).toBe(1); expect(nativeUploads).toBeGreaterThan(0); expect(nativeQueries).toBe(0);
    expect((await workspaceRestores().read(accountId, workspaceClaim.claimReference))?.state).toBe("unknown");
    const uploadsAfterOriginal = nativeUploads;
    expect(await workspaceRestores().restore(accountId, workspaceResume.idempotencyKey)).toEqual({ status: "reconciliation_pending" });
    expect(nativeQueries).toBe(1); expect(nativeRestores).toBe(1); expect(nativeUploads).toBe(uploadsAfterOriginal);
    expect((await store.findContinuationPause(accountId, workspaceClaim.sessionId, 1))?.state).toBe("claimed");
    await expect(runtime.query("UPDATE production_real.priced_continuation_restores SET state='restored',proof_json=$2::jsonb WHERE claim_reference=$1",
      [workspaceClaim.claimReference, JSON.stringify({ kind: "command", commandSha256: workspaceClaim.quote.context.commandSha256 })])).rejects.toThrow("PRICED_RESTORE_NATIVE_PROOF_DENIED");
    wrongNativeReceipt = false;
    const restoredWorkspace = await workspaceRestores().restore(accountId, workspaceResume.idempotencyKey);
    expect(restoredWorkspace.status).toBe("restored");
    if (restoredWorkspace.status !== "restored") throw new Error("EXPECTED_NATIVE_RESTORE_PROOF");
    expect(restoredWorkspace.restore.payloadKind).toBe("workspace");
    expect(restoredWorkspace.restore.proof?.kind).toBe("workspace");
    expect(nativeQueries).toBe(2); expect(nativeRestores).toBe(1); expect(nativeUploads).toBe(uploadsAfterOriginal);
    expect(await workspaceRestores().restore(accountId, workspaceResume.idempotencyKey)).toEqual(restoredWorkspace);
    expect(nativeQueries).toBe(2);
    expect((await store.findContinuationPause(accountId, workspaceClaim.sessionId, 1))?.state).toBe("restored");
    expect((await admin.query("SELECT state FROM production_real.priced_continuation_restore_audit WHERE claim_reference=$1 ORDER BY sequence", [workspaceClaim.claimReference])).rows).toEqual([{ state: "claimed" }, { state: "unknown" }, { state: "restored" }]);
    for (const changed of [{ accountId: "account:foreign" }, { leaseToken: "lease:foreign" }, { resumeClaim: "allocation:foreign" }, { archiveSha256: "f".repeat(64) }]) {
      expect(await nativeBridge().observePricedRestoreCheckpoint({ ...restoredWorkspace.restore.metadata, ...changed })).toEqual({ status: "unknown" });
    }
    expect(nativeQueries).toBe(2); expect(nativeRestores).toBe(1); expect(nativeUploads).toBe(uploadsAfterOriginal);
    const newProposalFiles = [{ path: "src/main.ts", content: "document.body.textContent = 'A fresh resumed counter';" }];
    const newProposalSha = hash(newProposalFiles);
    const resumedWorkerRequest = WorkerRunRequestSchema.parse({ ...sourceRequest, actionId: workspaceClaim.actionId, sourceProposalReference: `proposal:sha256:${newProposalSha}`,
      sourceProposalSha256: newProposalSha, sourceProposalFiles: newProposalFiles });
    await new ProductionWorkerRequestStore(nativeRequestJournal).persist(resumedWorkerRequest);
    expect(await new ProductionWorkerRequestStore(nativeRequestJournal).read(resumedWorkerRequest)).toEqual(resumedWorkerRequest);
    expect(await new ProductionWorkerRequestStore(nativeRequestJournal).read(sourceRequest)).toEqual(sourceRequest);
    await expect(new ProductionWorkerRequestStore(nativeRequestJournal).persist({ ...resumedWorkerRequest, sourceProposalFiles: workspaceSource.files })).rejects.toThrow("PRODUCTION_CHECKPOINT_REQUEST_BINDING_INVALID");
    expect(await nativeBridge().observePricedRestoreCheckpoint(restoredWorkspace.restore.metadata)).toMatchObject({ status: "restored" });
    expect(nativeQueries).toBe(3); expect(nativeRestores).toBe(1); expect(nativeUploads).toBe(uploadsAfterOriginal);
    expect(reserves).toBe(2); expect(modelPosts).toBe(2);
    const finalizationMigration = await Bun.file("migrations/phase-07/013_production_priced_continuation_finalizations.sql").text();
    await admin.query(finalizationMigration); await admin.query(finalizationMigration);
    // This fixture seeds balances administratively instead of running a rail
    // credit. Create the clearing account that real verified credit creates.
    await admin.query("INSERT INTO production_real.funding_accounts(account_id,unit) VALUES('treasury:clearing','sat') ON CONFLICT(account_id) DO NOTHING");
    const terminalInput = { pool, acceptance: refreshedAcceptance, restores: workspaceRestores(), gateway, journal: vertexJournal, worker: nativeBridge() };
    const finalizer = new ProductionPricedContinuationFinalizer(terminalInput);
    await finalizer.assertReady();
    for (const trigger of ["priced_finalization_guard", "priced_finalization_immutable"]) {
      await admin.query(`ALTER TABLE production_real.priced_continuation_finalizations DISABLE TRIGGER ${trigger}`);
      await expect(finalizer.assertReady()).rejects.toThrow("PRODUCTION_PRICED_FINALIZATION_SCHEMA_REQUIRED");
      await admin.query(`ALTER TABLE production_real.priced_continuation_finalizations ENABLE TRIGGER ${trigger}`);
    }
    const pendingSettlement = await createProductionVertexGenerationSettlement({ gateway, conversion: allocating.settlement.conversion,
      journal: vertexJournal, resumeSettlements: refreshedAcceptance }).finalize({ accountId, intent: allocatingIntent, receipt: pendingObserved.receipt, pricedAmount: "3" });
    const pendingTerminal = { accountId, idempotencyKey: workerCommand.idempotencyKey, leaseToken: allocating.leaseToken, allocationIntentReference: allocating.allocationIntentReference,
      intent: allocatingIntent, receipt: pendingObserved.receipt, finalization: { idempotencyKey: allocating.actionKey, operationId: allocating.operationId,
        receiptCharge: pendingSettlement.amount, providerReceiptReference: pendingSettlement.providerReceiptReference, status: "failed",
        result: { status: "failed", code: "WORKER_OR_ARTIFACT_FAILED", accountId, sessionId: allocating.sessionId, operationId: allocating.operationId,
          sessionVersion: 0, artifactVersion: 0, confirmedSpend: pendingSettlement.amount, remainingCap: "0", remainingBalance: "0", nextAction: "revise_session" }, sessionVersion: 0, artifactVersion: 0 } };
    await Bun.sleep(Math.max(1, terminalQuote.expiresAtMs - Date.now() + 10));
    expect(Date.now()).toBeGreaterThanOrEqual(terminalQuote.expiresAtMs);
    await expect(finalizer.complete({ ...pendingTerminal, leaseToken: "lease:foreign" })).rejects.toThrow("PRICED_FINALIZATION_BINDING_DENIED");
    await expect(finalizer.complete({ ...pendingTerminal, finalization: { ...pendingTerminal.finalization, receiptCharge: "2" } })).rejects.toThrow("PRICED_FINALIZATION_RECEIPT_DENIED");
    let failTerminalWrite = true;
    const rollbackFinalizer = new ProductionPricedContinuationFinalizer({ ...terminalInput,
      pool: sqlPool(runtime, undefined, undefined, () => { const value = failTerminalWrite; failTerminalWrite = false; return value; }) });
    await expect(rollbackFinalizer.complete(pendingTerminal)).rejects.toThrow("TERMINAL_PAUSE_WRITE_FAILED");
    for (const table of ["ledger_entries", "usage_receipts", "priced_continuation_finalizations"]) expect((await admin.query(`SELECT count(*)::int AS count FROM production_real.${table}`)).rows[0].count).toBe(0);
    expect((await acceptance.find(accountId, workerCommand.idempotencyKey))?.state).toBe("dispatching");
    expect((await store.findContinuationPause(accountId, allocating.sessionId, 1))?.state).toBe("restored");
    let loseFinalCommit = true;
    const uncertainFinalizer = new ProductionPricedContinuationFinalizer({ ...terminalInput, pool: sqlPool(runtime, () => { const value = loseFinalCommit; loseFinalCommit = false; return value; }) });
    await expect(uncertainFinalizer.complete(pendingTerminal)).rejects.toThrow("COMMIT_ACK_LOST");
    const terminal = await finalizer.complete(pendingTerminal);
    expect(terminal).toMatchObject({ status: "failed", confirmedSpend: "1", remainingCap: "199", remainingBalance: "199", sessionVersion: 0, artifactVersion: 0 });
    const duplicateTerminals = await Promise.all(Array.from({ length: 3 }, () => finalizer.complete(pendingTerminal)));
    expect(duplicateTerminals.every(value => canonicalJson(value) === canonicalJson(terminal))).toBeTrue();
    await expect(finalizer.complete({ ...pendingTerminal, finalization: { ...pendingTerminal.finalization, artifactVersion: 1 } })).rejects.toThrow("PRICED_FINALIZATION_IDENTITY_CONFLICT");
    expect((await store.findContinuationPause(accountId, allocating.sessionId, 1))?.state).toBe("completed");
    expect((await acceptance.find(accountId, workerCommand.idempotencyKey))?.state).toBe("completed");
    expect((await admin.query("SELECT state,amount FROM production_real.action_budget_reservations WHERE reservation_reference=$1", [allocating.actionBudgetReference])).rows[0]).toEqual({ state: "released", amount: "41" });
    expect((await admin.query("SELECT direction,amount FROM production_real.ledger_entries WHERE account_id=$1", [accountId])).rows).toEqual([{ direction: "debit", amount: "1" }]);
    expect((await admin.query("SELECT amount_sat FROM production_real.billing_line_items WHERE operation_id=$1 AND kind='release'", [allocating.operationId])).rows[0].amount_sat).toBe("40");
    expect((await admin.query("SELECT count(*)::int AS count FROM production_real.usage_receipts")).rows[0].count).toBe(1);
    expect((await admin.query("SELECT provider,model FROM production_real.usage_receipts WHERE operation_id=$1", [allocating.operationId])).rows[0]).toEqual({ provider: "vertex_ai_gemini", model: "gemini-4-argon" });
    const finalSnapshot = (await admin.query("SELECT normalized_receipt_json,settlement_json FROM production_real.priced_continuation_finalizations WHERE claim_reference=$1", [allocating.claimReference])).rows[0];
    expect(finalSnapshot.normalized_receipt_json).toEqual(pendingObserved.receipt);
    expect(finalSnapshot.settlement_json).toEqual(allocating.settlement);
    await expect(runtime.query("UPDATE production_real.priced_continuation_finalizations SET request_sha256=$1", ["f".repeat(64)])).rejects.toThrow();
    expect((await admin.query("SELECT count(*)::int AS count FROM production_real.funding_outbox WHERE event_kind='priced_continuation_terminal'")).rows[0].count).toBe(1);
    expect(modelPosts).toBe(2); expect(nativeRestores).toBe(1);
    expect((await metered.transact(accountId, tx => tx.claimProviderOperation(workspaceClaim.operationId))).claimed).toBeTrue();
    const workspaceApiIntent = ProviderOperationIntentSchema.parse({ ...allocatingIntent, sessionId: workspaceClaim.sessionId, actionId: workspaceClaim.actionId,
      operationId: workspaceClaim.operationId, providerRequestId: workspaceClaim.operationId, actionBudgetReference: workspaceClaim.actionBudgetReference,
      requestFingerprint: workspaceClaim.fingerprint, expectedVersion: 1, prompt: workspaceCommand.revision });
    const workspaceObserved = await gateway.dispatch(workspaceApiIntent, new AbortController().signal);
    if (workspaceObserved.status !== "completed") throw new Error("EXPECTED_WORKSPACE_MODEL_USAGE");
    const workspaceSettlement = await createProductionVertexGenerationSettlement({ gateway, conversion: workspaceClaim.settlement.conversion, journal: vertexJournal,
      resumeSettlements: refreshedAcceptance }).finalize({ accountId, intent: workspaceApiIntent, receipt: workspaceObserved.receipt, pricedAmount: "3" });
    const workspaceTerminal = { ...pendingTerminal, idempotencyKey: workspaceResume.idempotencyKey, leaseToken: workspaceClaim.leaseToken,
      allocationIntentReference: workspaceClaim.allocationIntentReference, intent: workspaceApiIntent, receipt: workspaceObserved.receipt,
      finalization: { ...pendingTerminal.finalization, idempotencyKey: workspaceClaim.actionKey, operationId: workspaceClaim.operationId,
        receiptCharge: workspaceSettlement.amount, providerReceiptReference: workspaceSettlement.providerReceiptReference, sessionVersion: 1, artifactVersion: 1,
        result: { ...pendingTerminal.finalization.result, sessionId: workspaceClaim.sessionId, operationId: workspaceClaim.operationId,
          confirmedSpend: workspaceSettlement.amount, sessionVersion: 1, artifactVersion: 1 } } };
    const forgedArtifact = { artifactId: "artifact:forged", workspaceLineage: `workspace:${workspaceClaim.sessionId}`,
      checkpointReference: `checkpoint:${workspaceClaim.sessionId}:${workspaceClaim.actionId}`, snapshotReference: `snapshot:${workspaceClaim.sessionId}:${workspaceClaim.actionId}`,
      validationEvidenceReference: "verification:artifact:forged" };
    await expect(finalizer.complete({ ...workspaceTerminal, finalization: { ...workspaceTerminal.finalization, status: "completed", sessionVersion: 2, artifactVersion: 2, artifact: forgedArtifact,
      result: { status: "completed", code: "ACTION_COMMITTED", accountId, sessionId: workspaceClaim.sessionId, operationId: workspaceClaim.operationId,
        sessionVersion: 2, artifactVersion: 2, artifactId: forgedArtifact.artifactId, confirmedSpend: workspaceSettlement.amount, remainingCap: "0", remainingBalance: "0", nextAction: "revise_session" } } })).rejects.toThrow("PRICED_FINALIZATION_ARTIFACT_DENIED");
    expect((await admin.query("SELECT count(*)::int AS count FROM production_real.priced_continuation_finalizations")).rows[0].count).toBe(1);
    const concurrentWorkspaceTerminals = await Promise.all([finalizer.complete(workspaceTerminal), finalizer.complete(workspaceTerminal)]);
    expect(concurrentWorkspaceTerminals[0]).toEqual(concurrentWorkspaceTerminals[1]);
    expect(concurrentWorkspaceTerminals[0]).toMatchObject({ status: "failed", confirmedSpend: "1", remainingCap: "198", remainingBalance: "198", sessionVersion: 1, artifactVersion: 1 });
    expect((await admin.query("SELECT count(*)::int AS count FROM production_real.usage_receipts")).rows[0].count).toBe(2);
    expect((await admin.query("SELECT count(*)::int AS count FROM production_real.ledger_entries WHERE account_id=$1 AND direction='debit'", [accountId])).rows[0].count).toBe(2);
    expect((await admin.query("SELECT confirmed_spend_sat,current_verified_artifact_version,version,state FROM production_real.metered_sessions WHERE id=$1", [workspaceClaim.sessionId])).rows[0]).toEqual({ confirmed_spend_sat: "1", current_verified_artifact_version: 1, version: 1, state: "failed" });
    expect((await store.findContinuationPause(accountId, workspaceClaim.sessionId, 1))?.state).toBe("completed");
    expect((await acceptance.find(accountId, workspaceResume.idempotencyKey))?.state).toBe("completed");
    expect((await admin.query("SELECT count(*)::int AS count FROM production_real.funding_outbox WHERE event_kind='priced_continuation_terminal'")).rows[0].count).toBe(2);
    expect(modelPosts).toBe(3); expect(nativeRestores).toBe(1); expect(reserves).toBe(2);
  } finally { await runtime?.end(); await admin?.end(); await docker(["rm", "--force", name]).catch(() => undefined); }
}, 120_000);
