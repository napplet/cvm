import { expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { Pool } from "pg";
import { accountIdForPrincipal } from "../../src/domain/account-command";
import { bindAccountingRealmPool, createAccountingRealm } from "../../src/funding/accounting-realm";
import { ContinuationService } from "../../src/continuity/continuation-service";
import type { PendingActionIntent } from "../../src/continuity/contracts";
import type { ContinuationFundingStore } from "../../src/persistence/funding-store";
import { StartSessionCommandSchema, ReviseSessionCommandSchema } from "../../src/phase-04/metered-generation-service";
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

const integration = process.env.NAPPLET_RUN_POSTGRES_ISOLATION === "1" ? test : test.skip;
const hash = (value: unknown) => createHash("sha256").update(canonicalJson(value)).digest("hex");
async function docker(args: string[]): Promise<string> {
  const child = Bun.spawn(["docker", ...args], { stdin: "ignore", stdout: "pipe", stderr: "pipe" });
  const [out, err, code] = await Promise.all([new Response(child.stdout).text(), new Response(child.stderr).text(), child.exited]);
  if (code !== 0) throw new Error(`DOCKER_FAILED:${args[0]}:${err.slice(0, 300)}`);
  return out.trim();
}
function sqlPool(native: Pool): PostgresSqlPool {
  return { async connect() { const client = await native.connect(); return {
    async query<Row extends Record<string, unknown>>(sql: string, values?: readonly unknown[]) { return { rows: (await client.query<Row>(sql, values ? [...values] : undefined)).rows }; },
    release() { client.release(); },
  }; } };
}

integration("production quote preparation authenticates an encrypted original checkpoint and expired original pricing without spending", async () => {
  const name = `cvm-resume-preparer-${crypto.randomUUID().replaceAll("-", "")}`;
  let admin: Pool | undefined, runtime: Pool | undefined;
  try {
    await docker(["run", "--detach", "--rm", "--name", name, "--publish", "127.0.0.1::5432", "-e", "POSTGRES_HOST_AUTH_METHOD=trust", "postgres:17-alpine"]);
    const port = (await docker(["port", name, "5432/tcp"])).match(/127\.0\.0\.1:(\d+)/u)?.[1];
    if (!port) throw new Error("POSTGRES_PORT_MISSING");
    admin = new Pool({ connectionString: `postgresql://postgres@127.0.0.1:${port}/postgres`, connectionTimeoutMillis: 2000 });
    for (let attempt = 0; attempt < 90; attempt++) { try { await admin.query("SELECT 1"); break; } catch (error) { if (attempt === 89) throw error; await Bun.sleep(250); } }
    for (const file of ["phase-03/001_funding.sql", "phase-04/001_metered_generation.sql", "phase-04/002_action_budget_lifecycle.sql", "phase-05/001_continuation.sql", "phase-06/001_publication.sql", "phase-03/002_production_accounting.sql",
      "phase-07/001_production_operation_journal.sql", "phase-07/002_production_pricing_catalog.sql", "phase-07/003_production_checkpoints.sql", "phase-07/006_production_pending_checkpoints.sql", "phase-07/009_production_resume_pricing_quotes.sql"])
      await admin.query(await Bun.file(`migrations/${file}`).text());
    await admin.query("CREATE ROLE resume_preparer_runtime LOGIN"); await admin.query("GRANT napplet_production_real TO resume_preparer_runtime");
    runtime = new Pool({ connectionString: `postgresql://resume_preparer_runtime@127.0.0.1:${port}/postgres` });
    const pool = sqlPool(runtime), bound = bindAccountingRealmPool(pool, createAccountingRealm("production-real"));
    const store: ContinuationFundingStore = new PostgresSqlFundingStore(bound), quotes = new ProductionResumePricingQuotes(pool);
    await quotes.assertReady();
    const startedAt = Date.now(); let now = startedAt;
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
  } finally { await runtime?.end(); await admin?.end(); await docker(["rm", "--force", name]).catch(() => undefined); }
}, 120_000);
