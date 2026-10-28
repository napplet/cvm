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

integration("same-controller resume retries after credit and uncertain allocation reuse one SQL claim and budget", async () => {
  const name = `cvm-resume-retry-${crypto.randomUUID().replaceAll("-", "")}`;
  let admin: Pool | undefined, native: Pool | undefined;
  try {
    await docker(["run", "--detach", "--rm", "--name", name, "--publish", "127.0.0.1::5432", "-e", "POSTGRES_HOST_AUTH_METHOD=trust", "postgres:17-alpine"]);
    const port = (await docker(["port", name, "5432/tcp"])).match(/127\.0\.0\.1:(\d+)/u)?.[1];
    if (!port) throw new Error("POSTGRES_PORT_MISSING");
    admin = new Pool({ connectionString: `postgresql://postgres@127.0.0.1:${port}/postgres`, connectionTimeoutMillis: 2000 });
    for (let attempt = 0; attempt < 90; attempt++) { try { await admin.query("SELECT 1"); break; } catch (error) { if (attempt === 89) throw error; await Bun.sleep(250); } }
    for (const file of ["phase-03/001_funding.sql", "phase-04/001_metered_generation.sql", "phase-04/002_action_budget_lifecycle.sql", "phase-05/001_continuation.sql", "phase-06/001_publication.sql", "phase-03/002_production_accounting.sql"]) await admin.query(await Bun.file(`migrations/${file}`).text());
    await admin.query("INSERT INTO production_real.model_profile_versions(id,profile_hash,provider,model,normalized_profile) VALUES('retry-profile',$1,'fixture','fixture','{}')", ["c".repeat(64)]);
    await admin.query("INSERT INTO production_real.price_card_versions(id,card_hash,profile_id,unit,normalized_card) VALUES('retry-card',$1,'retry-profile','sat','{}')", ["d".repeat(64)]);
    await admin.query("CREATE ROLE resume_retry_test LOGIN"); await admin.query("GRANT napplet_production_real TO resume_retry_test");
    native = new Pool({ connectionString: `postgresql://resume_retry_test@127.0.0.1:${port}/postgres` });
    const database = new PostgresFundingDatabase(sqlPool(native), { realm: "production-real" }), store = database.funding;
    const funding = new FundingService(store), principal = { pubkey: "8".repeat(64) };
    let now = Date.now(), allocations = 0, restores = 0;
    // Explicit rail, archive and worker protocol fixtures. No paid generation,
    // actual funding, isolated workspace or release certification is claimed.
    const credit = (id: string) => funding.execute({ principal, kind: "credit_settlement", idempotencyKey: `credit:${id}`, policyVersion: "fixture", protocolVersion: "fixture", payload: { settlement: { topUpId: id, rail: "lightning", unit: "sat", amount: "10", externalReference: `external:${id}`, settlementReference: `settlement:${id}`, verifiedAt: new Date(now).toISOString() } } });
    const accountId = (await credit("initial")).accountId;
    const admission = await funding.execute({ principal, kind: "funded_admission", idempotencyKey: "admit:retry", policyVersion: "fixture", protocolVersion: "fixture", payload: { requestedCap: "10", unit: "sat", capacity: { usable: true, reference: "capacity:retry" } } });
    if (admission.status !== "accepted") throw new Error("FIXTURE_ADMISSION_REQUIRED");
    const admissionReference = admission.reference, checkpointId = "checkpoint:retry";
    const hash = (value: unknown) => new Bun.CryptoHasher("sha256").update(canonicalJson(value)).digest("hex");
    const pendingCommand = { principal, admissionReference, idempotencyKey: "pending:retry", expectedVersion: 0 as const, maximum: "10", policyVersion: "fixture", idea: "Private bounded timer command retained across pause." };
    const sessionId = `session:${hash({ accountId, key: pendingCommand.idempotencyKey }).slice(0, 24)}`;
    const commands = () => new ProtectedContinuationCommands({ reference: "test:checkpoint-kek", load: () => loadMountedCheckpointKek({ kekPath: "/test/kek", readFile: async () => Buffer.alloc(32, 9).toString("base64") }) }, () => now);
    const intent = { accountId, sessionId, idempotencyKey: "pending:retry", fingerprint: "a".repeat(64), reference: "pending:retry", actionKind: "start_session" as const, boundedPayloadHash: hash({ idea: pendingCommand.idea }), expectedSessionVersion: 0, expectedArtifactVersion: 0, policyVersion: "fixture", priceCardId: "retry-card", profileId: "retry-profile", toolchainId: "retry-toolchain", actionMaximum: "10", admissionReference };
    // Interrupt after the INSERT but before commit: neither the pause nor
    // its encrypted command may survive independently of the transaction.
    const rawPool = sqlPool(native);
    const failedPool: PostgresSqlPool = { async connect() { const client = await rawPool.connect(); return {
      async query<Row extends Record<string, unknown>>(sql: string, values?: readonly unknown[]) { const result = await client.query<Row>(sql, values); if (sql.startsWith("INSERT INTO continuation_pauses")) throw new Error("PAUSE_WRITE_INTERRUPTED"); return result; },
      release() { client.release(); },
    }; } };
    const failedStore = new PostgresFundingDatabase(failedPool, { realm: "production-real" }).funding;
    await expect(new ContinuationService({ store: failedStore, clock: { nowMs: () => now }, pendingCommands: commands() }).pauseForFunding({ intent, command: pendingCommand })).rejects.toThrow("PAUSE_WRITE_INTERRUPTED");
    expect((await admin.query("SELECT count(*)::int AS count FROM production_real.continuation_pauses")).rows[0].count).toBe(0);
    expect((await admin.query("SELECT count(*)::int AS count FROM production_real.metered_sessions")).rows[0].count).toBe(0);
    const pause = await new ContinuationService({ store, clock: { nowMs: () => now }, pendingCommands: commands() }).pauseForFunding({ intent, command: pendingCommand });
    if (!pause) throw new Error("FIXTURE_PAUSE_REQUIRED");
    now = pause.graceDeadlineMs;
    const live = await store.findContinuationPause(accountId, sessionId, 1);
    if (!live?.liveLeaseToken) throw new Error("FIXTURE_LIVE_LEASE_REQUIRED");
    expect(JSON.stringify(live)).not.toContain(pendingCommand.idea);
    expect(await commands().open(live.intent)).toEqual(pendingCommand); // New protector/controller.
    expect(JSON.stringify(pause)).not.toContain("protectedCommand");
    expect(JSON.stringify(pause)).not.toContain("ciphertextBase64");
    await store.transact(accountId, (tx: ContinuationFundingTransaction) => tx.beginDeadlineCheckpoint({ sessionId, pauseGeneration: 1, liveLeaseToken: live.liveLeaseToken! }));
    const envelope = new CheckpointEnvelopeService({ crypto: new AesGcmCheckpointCrypto(), objectStore: new DeterministicObjectStore(), now: () => new Date(now).toISOString() });
    const material = await envelope.seal({ checkpointId, accountId, sessionId, pauseGeneration: 1, sessionVersion: 0, actionVersion: 0, artifactVersion: 0, workspaceVersion: 0, workspaceLineage: "workspace:retry", action: { actionId: "action:fixture", operationId: "operation:fixture", ledgerReference: admissionReference, pendingActionReference: intent.reference, idempotencyKey: intent.idempotencyKey }, archive: new TextEncoder().encode("explicit protocol archive fixture"), inventory: ["harness_state", "workspace", "artifact_lineage", "validation_evidence", "financial_action", "pending_action", "compatibility_metadata"], evidenceSha256: "e".repeat(64), compatibility: { policyVersion: "fixture", modelIdentity: "retry-profile", nappletSdkIdentity: "retry-card", toolchainIdentity: "retry-toolchain" }, retentionUntil: new Date(now + 2_592_000_000).toISOString() });
    await store.transact(accountId, (tx: ContinuationFundingTransaction) => tx.commitDeadlineCheckpoint({ accountId, sessionId, pauseGeneration: 1, checkpointId, expectedSessionVersion: 0, expectedArtifactVersion: 0, manifestReference: `manifest:${material.envelope.manifestSha256}`, objectKey: material.envelope.object.key, objectGeneration: String(material.envelope.object.generation), objectChecksum: material.envelope.object.checksum, keyReference: material.envelope.crypto.keyReference, compatibilityIdentity: "retry-toolchain", checkpointCommittedAtMs: now }));
    const restored = new Set<string>();
    const worker: ContinuationWorkerPort = {
      async run() { throw new Error("NO_GENERATION_IN_PROTOCOL_TEST"); }, async fenceCheckpoint() { throw new Error("UNUSED"); }, async exportCheckpoint() { throw new Error("UNUSED"); }, async terminateCheckpoint() { throw new Error("UNUSED"); },
      async restoreCheckpoint(value) { if (!restored.has(value.resumeClaim)) { restored.add(value.resumeClaim); restores++; } return { status: "restored", code: "WORKER_CHECKPOINT_RESTORED", workspaceId: value.workspaceId, workspaceLineage: value.workspaceLineage }; },
    };
    const bindings: string[] = [];
    const open = () => new ContinuationService({ store, clock: { nowMs: () => now }, resume: { compatibility: { policyVersion: "fixture", profileId: "retry-profile", priceCardId: "retry-card", toolchainId: "retry-toolchain" }, checkpoint: { loadExact: async () => material, restore: value => envelope.restore(value.envelope, value.manifest) }, allocate: async value => { bindings.push(value.allocationIntentReference); allocations++; return allocations === 1 ? { status: "unknown" } : { status: "allocated", worker }; } } });
    const service = open();
    const command = { principal: { id: accountId }, sessionId, checkpointId, expectedSessionVersion: 0, expectedCheckpointVersion: 1, idempotencyKey: "resume:retry", approvePendingAction: true, capApprovalReference: admissionReference, pendingAction: { reference: intent.reference, fingerprint: intent.fingerprint, kind: intent.actionKind, maximum: "10" } };
    expect(await service.resumeSession(command)).toMatchObject({ status: "denied", code: "RESUME_BALANCE_INSUFFICIENT" });
    expect(allocations).toBe(0);
    await credit("retry");
    expect(await service.resumeSession(command)).toMatchObject({ status: "reconciliation_pending", code: "RESUME_ALLOCATION_RECONCILIATION" });
    expect(await service.resumeSession(command)).toMatchObject({ status: "restored" });
    expect(await open().resumeSession(command)).toMatchObject({ status: "restored" });
    expect(new Set(bindings).size).toBe(1); expect(restores).toBe(1);
    expect(await service.resumeSession({ ...command, pendingAction: { ...command.pendingAction, fingerprint: "f".repeat(64) } })).toMatchObject({ status: "denied", code: "RESUME_PENDING_ACTION_MISMATCH" });
    for (const table of ["continuation_resume_commands", "action_budget_reservations", "metered_actions", "provider_operations"]) expect((await admin.query(`SELECT count(*)::int AS count FROM production_real.${table}`)).rows[0].count).toBe(1);
  } finally { await native?.end(); await admin?.end(); await docker(["rm", "--force", name]).catch(() => undefined); }
}, 120_000);
