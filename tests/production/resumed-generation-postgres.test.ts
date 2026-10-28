import { SessionCapApprovalService } from "../../src/funding/session-cap";
import { FundedAdmissionService } from "../../src/funding/funded-admission";
import { MeteredGenerationService } from "../../src/phase-04/metered-generation-service";
import { ModelProfileSchema, PriceCardSchema, PHASE_04_DETERMINISTIC_PRICE_CARD } from "../../src/model/price-card";
import type { ModelGateway, NormalizedUsageReceipt } from "../../src/model/model-gateway";
import type { ArtifactVerifier } from "../../src/phase-02/trusted-core";
import type { WorkerPort } from "../../src/phase-02/contracts";
import { trustedAdmissionReceiptAuthority } from "../fixtures/admission-ready";
import { expect, test } from "bun:test";
import { Pool } from "pg";
import { canonicalJson } from "../../src/promotion/schema";
import { ProtectedContinuationCommands } from "../../src/continuity/protected-command";
import { loadMountedCheckpointKek } from "../../src/production/checkpoint-crypto";
import { ContinuationService } from "../../src/continuity/continuation-service";
import { AesGcmCheckpointCrypto, CheckpointEnvelopeService } from "../../src/continuity/checkpoint-envelope";
import { DeterministicObjectStore } from "../../src/continuity/object-store";
import { FundingService } from "../../src/funding/funding-service";
import { PostgresFundingDatabase } from "../../src/persistence/postgres-funding-database";
import type { ContinuationFundingTransaction } from "../../src/persistence/funding-store";
import type { PostgresSqlPool } from "../../src/persistence/postgres-sql-funding-store";
import type { ContinuationWorkerPort } from "../../src/phase-02/contracts";

const integration = process.env.NAPPLET_RUN_POSTGRES_ISOLATION === "1" ? test : test.skip;
async function docker(args: string[]) {
  const child = Bun.spawn(["docker", ...args], { stdout: "pipe", stderr: "pipe" });
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

integration("saved exact command consumes one resume budget and reconciles one original provider operation to terminal accounting", async () => {
  const name = `cvm-resumed-generation-${crypto.randomUUID().replaceAll("-", "")}`;
  let admin: Pool | undefined, native: Pool | undefined;
  try {
    await docker(["run", "--detach", "--rm", "--name", name, "--publish", "127.0.0.1::5432", "-e", "POSTGRES_HOST_AUTH_METHOD=trust", "postgres:17-alpine"]);
    const port = (await docker(["port", name, "5432/tcp"])).match(/127\.0\.0\.1:(\d+)/u)?.[1];
    if (!port) throw new Error("POSTGRES_PORT_MISSING");
    admin = new Pool({ connectionString: `postgresql://postgres@127.0.0.1:${port}/postgres`, connectionTimeoutMillis: 2000 });
    for (let attempt = 0; attempt < 90; attempt++) { try { await admin.query("SELECT 1"); break; } catch (error) { if (attempt === 89) throw error; await Bun.sleep(250); } }
    for (const file of ["phase-03/001_funding.sql", "phase-04/001_metered_generation.sql", "phase-04/002_action_budget_lifecycle.sql", "phase-05/001_continuation.sql", "phase-06/001_publication.sql", "phase-03/002_production_accounting.sql", "phase-07/005_production_session_caps.sql"]) await admin.query(await Bun.file(`migrations/${file}`).text());
    const card = PriceCardSchema.parse({ ...PHASE_04_DETERMINISTIC_PRICE_CARD, id: "resume-card", version: "resume-card" });
    const profile = ModelProfileSchema.parse({ id: "resume-profile", provider: "deterministic_fixture", model: "phase-04-fixture-model", priceCardId: card.id, selection: "unselected", deadlineMs: 30000, maximumUnits: [{ dimension: "input_tokens", units: "2" }, { dimension: "output_tokens", units: "1" }, { dimension: "cached_tokens", units: "2" }, { dimension: "reasoning_tokens", units: "3" }] });
    await admin.query("INSERT INTO production_real.model_profile_versions(id,profile_hash,provider,model,normalized_profile) VALUES($1,$2,$3,$4,$5::jsonb)", [profile.id, "c".repeat(64), profile.provider, profile.model, JSON.stringify(profile)]);
    await admin.query("INSERT INTO production_real.price_card_versions(id,card_hash,profile_id,unit,normalized_card) VALUES($1,$2,$3,'sat',$4::jsonb)", [card.id, "d".repeat(64), profile.id, JSON.stringify(card)]);
    await admin.query("CREATE ROLE resumed_generation_test LOGIN"); await admin.query("GRANT napplet_production_real TO resumed_generation_test");
    native = new Pool({ connectionString: `postgresql://resumed_generation_test@127.0.0.1:${port}/postgres` });
    const database = new PostgresFundingDatabase(sqlPool(native), { realm: "production-real" }), store = database.funding;
    const funding = new FundingService(store), principal = { pubkey: "8".repeat(64) };
    let now = Date.now(), allocations = 0, restores = 0, dispatches = 0, lookups = 0, builds = 0;
    // Deliberate rail/model/worker/archive fixtures. This exercises the actual
    // SQL/core consumer, not real API use or a production checkpoint producer.
    const credit = (key: string, amount: string) => funding.execute({ principal, kind: "credit_settlement", idempotencyKey: key, policyVersion: "fixture", protocolVersion: "fixture", payload: { settlement: { topUpId: key, rail: "lightning", unit: "sat", amount, externalReference: `external:${key}`, settlementReference: `settlement:${key}`, verifiedAt: new Date(now).toISOString() } } });
    const accountId = (await credit("initial", "8")).accountId;
    const admission = await funding.execute({ principal, kind: "funded_admission", idempotencyKey: "admit", policyVersion: "fixture", protocolVersion: "fixture", payload: { requestedCap: "10", unit: "sat", capacity: { usable: true, reference: "capacity:resumed" } } });
    if (admission.status !== "accepted") throw new Error("FIXTURE_ADMISSION_REQUIRED");
    const admissionReference = admission.reference, checkpointId = "checkpoint:resumed";
    const commands = () => new ProtectedContinuationCommands({ reference: "test:kek", load: () => loadMountedCheckpointKek({ kekPath: "/test/kek", readFile: async () => Buffer.alloc(32, 9).toString("base64") }) }, () => now);
    const continuation = new ContinuationService({ store, includeAdmissionHold: true, pendingCommands: commands(), clock: { nowMs: () => now } });
    const admissions = new FundedAdmissionService({ funding, store, receiptAuthority: trustedAdmissionReceiptAuthority, capacity: { async reserveNow() { throw new Error("UNUSED"); }, async observe() { throw new Error("UNUSED"); }, async release() { throw new Error("UNUSED"); } } });
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
    expect((await admin.query("SELECT count(*)::int AS count FROM production_real.metered_actions")).rows[0].count).toBe(0);
    now = pending.graceDeadlineMs;
    await credit("increase", "2");
    await new SessionCapApprovalService(store).approve({ principal, sessionId: pending.sessionId, admissionReference, idempotencyKey: "approve", expectedApprovedCap: "8", maximum: "10", unit: "sat", policyVersion: "fixture", protocolVersion: "fixture" }, { consentReference: `nostr:${"e".repeat(64)}` });
    await store.transact(accountId, (tx: ContinuationFundingTransaction) => tx.beginDeadlineCheckpoint({ sessionId: pending.sessionId, pauseGeneration: 1, liveLeaseToken: live.liveLeaseToken! }));
    const envelope = new CheckpointEnvelopeService({ crypto: new AesGcmCheckpointCrypto(), objectStore: new DeterministicObjectStore(), now: () => new Date(now).toISOString() });
    const material = await envelope.seal({ checkpointId, accountId, sessionId: pending.sessionId, pauseGeneration: 1, sessionVersion: 0, actionVersion: 0, artifactVersion: 0, workspaceVersion: 0, workspaceLineage: "workspace:resumed", action: { actionId: "action:protocol-fixture", operationId: "operation:protocol-fixture", ledgerReference: admissionReference, pendingActionReference: live.intent.reference, idempotencyKey: live.intent.idempotencyKey }, archive: new TextEncoder().encode("explicit protocol archive fixture"), inventory: ["harness_state", "workspace", "artifact_lineage", "validation_evidence", "financial_action", "pending_action", "compatibility_metadata"], evidenceSha256: "e".repeat(64), compatibility: { policyVersion: "fixture", modelIdentity: profile.id, nappletSdkIdentity: card.id, toolchainIdentity: "resume-toolchain" }, retentionUntil: new Date(now + 2_592_000_000).toISOString() });
    await store.transact(accountId, (tx: ContinuationFundingTransaction) => tx.commitDeadlineCheckpoint({ accountId, sessionId: pending.sessionId, pauseGeneration: 1, checkpointId, expectedSessionVersion: 0, expectedArtifactVersion: 0, manifestReference: `manifest:${material.envelope.manifestSha256}`, objectKey: material.envelope.object.key, objectGeneration: String(material.envelope.object.generation), objectChecksum: material.envelope.object.checksum, keyReference: material.envelope.crypto.keyReference, compatibilityIdentity: "resume-toolchain", checkpointCommittedAtMs: now }));
    const restored = new Set<string>();
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
    const restoring: ContinuationWorkerPort = { ...worker, async fenceCheckpoint() { throw new Error("UNUSED"); }, async exportCheckpoint() { throw new Error("UNUSED"); }, async terminateCheckpoint() { throw new Error("UNUSED"); }, async restoreCheckpoint(value) { if (!restored.has(value.resumeClaim)) { restores++; restored.add(value.resumeClaim); } return { status: "restored", code: "WORKER_CHECKPOINT_RESTORED", workspaceId: value.workspaceId, workspaceLineage: value.workspaceLineage }; } };
    const open = () => new ContinuationService({ store: completionStore, includeAdmissionHold: true, clock: { nowMs: () => now }, resume: { compatibility: { policyVersion: "fixture", profileId: profile.id, priceCardId: card.id, toolchainId: "resume-toolchain" }, execution: generation, checkpoint: { loadExact: async () => material, restore: value => envelope.restore(value.envelope, value.manifest) }, allocate: async () => { allocations++; return allocations === 1 ? { status: "unknown" } : { status: "allocated", worker: restoring }; } } });
    const command = { principal: { id: accountId }, sessionId: pending.sessionId, checkpointId, expectedSessionVersion: 0, expectedCheckpointVersion: 1, idempotencyKey: "resume", approvePendingAction: true, capApprovalReference: admissionReference, pendingAction: { reference: live.intent.reference, fingerprint: live.intent.fingerprint, kind: "start_session", maximum: "10" } };
    const service = open();
    expect(await service.resumeSession(command)).toMatchObject({ status: "reconciliation_pending", code: "RESUME_ALLOCATION_RECONCILIATION" });
    expect((await admin.query("SELECT state FROM production_real.provider_operations")).rows[0].state).toBe("prepared");
    const prepared = (await store.listMeteredActionsForSession(accountId, pending.sessionId))[0];
    if (!prepared) throw new Error("PREPARED_ACTION_REQUIRED");
    const executable = await generation.prepareContinuation(live.intent);
    await expect(executable.readTerminal({ accountId, actionKey: prepared.idempotencyKey, commandFingerprint: prepared.fingerprint, actionId: prepared.actionId, operationId: "wrong:original", actionBudgetReference: prepared.actionBudgetReference })).rejects.toThrow("CONTINUATION_PREPARED_ACTION_BINDING_DENIED");
    expect(dispatches).toBe(0);
    expect(await service.resumeSession(command)).toMatchObject({ status: "reconciliation_pending", code: "RESUME_ACTION_RECONCILIATION" });
    expect({ dispatches, builds }).toEqual({ dispatches: 1, builds: 0 });
    expect(await open().resumeSession(command)).toMatchObject({ status: "reconciliation_pending", code: "RESUME_ACTION_RECONCILIATION" });
    expect(lostTerminalAcknowledgement).toBe(true);
    expect({ dispatches, lookups, builds, restores }).toEqual({ dispatches: 1, lookups: 1, builds: 1, restores: 1 });
    const action = (await store.listMeteredActionsForSession(accountId, pending.sessionId))[0];
    expect(action).toMatchObject({ status: "completed", receiptCharge: "3" });
    expect((await funding.status(principal)).held).toBe("7");
    expect(await store.findContinuationPause(accountId, pending.sessionId, 1)).toMatchObject({ state: "completed" });
    expect((await store.findContinuationPause(accountId, pending.sessionId, 1))?.liveLeaseToken).toBeUndefined();
    const allocationsAtCompletion = allocations;
    expect(await open().resumeSession(command)).toMatchObject({ status: "restored" });
    expect(allocations).toBe(allocationsAtCompletion);
    expect({ dispatches, lookups, builds, restores }).toEqual({ dispatches: 1, lookups: 1, builds: 1, restores: 1 });
    for (const table of ["continuation_resume_commands", "action_budget_reservations", "metered_actions", "provider_operations"]) expect((await admin.query(`SELECT count(*)::int AS count FROM production_real.${table}`)).rows[0].count).toBe(1);
  } finally { await native?.end(); await admin?.end(); await docker(["rm", "--force", name]).catch(() => undefined); }
}, 120_000);
