import { expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { finalizeEvent, verifyEvent } from "nostr-tools/pure";
import { Pool } from "pg";
import type { PostgresSqlPool } from "../../src/persistence/postgres-sql-funding-store";
import { bindAccountingRealmPool, createAccountingRealm } from "../../src/funding/accounting-realm";
import { FundingService } from "../../src/funding/funding-service";
import { PostgresFundingDatabase } from "../../src/persistence/postgres-funding-database";
import { PostgresOperationJournal } from "../../src/release/deployment/postgres-operation-journal";
import { ProductionCheckpointCoordinator } from "../../src/production/checkpoint-coordinator";
import { ProductionRetainedSubjectPreparer } from "../../src/production/retained-subject-preparer";
import { createProductionDurabilitySubjectRegistry } from "../../src/production/durability-registry";
import { openRetainedSubject, retainedSubjectCustodyId } from "../../src/production/retained-subject-archive";
import { MountedKekCheckpointCrypto } from "../../src/production/checkpoint-crypto";
import { GcsObjectStoreAdapter, type ObjectStorePort, type VersionedObjectClientPort } from "../../src/continuity/object-store";
import type { CheckpointSealRequest } from "../../src/continuity/checkpoint-envelope";
import { buildCvmAttestation } from "../../src/publication/attestation-event";
import { ProductionBuildAttestationSigner } from "../../src/production/attestation-signer";
import { ProductionWorkerArtifactStore } from "../../src/production/worker-artifact-store";
import { canonicalJson } from "../../src/promotion/schema";
import { assertProductionRetainedSubjectSchema } from "../../src/production/checkpoint-schema";

/* This is deliberately an opt-in local integration test.  The source records,
 * funding account, provider receipt, and signed events below are explicit
 * isolated fixtures (releaseEvidence: false); Docker is never a live Cloud SQL,
 * GCS, payment, signer, model, or worker certification claim. */
const integration = process.env.NAPPLET_RUN_POSTGRES_ISOLATION === "1" ? test : test.skip;
const digest = (value: Uint8Array | string) => createHash("sha256").update(value).digest("hex");
const hex = (value: string) => digest(value);
const wire = <Value>(value: Value): Value => JSON.parse(JSON.stringify(value)) as Value;
const migrations = [
  "phase-03/001_funding.sql", "phase-04/001_metered_generation.sql", "phase-04/002_action_budget_lifecycle.sql",
  "phase-05/001_continuation.sql", "phase-06/001_publication.sql", "phase-03/002_production_accounting.sql",
  "phase-03/003_cashu_custody_and_identities.sql", "phase-03/004_production_rail_material_scope.sql",
  "phase-07/001_production_operation_journal.sql", "phase-07/002_production_pricing_catalog.sql",
  "phase-07/003_production_checkpoints.sql",
] as const;
const retainedSubjectMigrations = ["phase-07/014_production_durability_subjects.sql", "phase-07/015_production_publication_signed_events.sql"] as const;

function sqlPool(native: Pool): PostgresSqlPool {
  return { async connect() { const client = await native.connect(); return {
    async query<Row extends Record<string, unknown>>(text: string, values?: readonly unknown[]) {
      return { rows: (await client.query<Row>(text, values ? [...values] : undefined)).rows };
    },
    release() { client.release(); },
  }; } };
}

async function docker(args: string[]) {
  const child = Bun.spawn(["docker", ...args], { stdout: "pipe", stderr: "pipe" });
  const timer = setTimeout(() => child.kill(), 15_000);
  try {
    const [code, stdout, stderr] = await Promise.all([child.exited, new Response(child.stdout).text(), new Response(child.stderr).text()]);
    if (code) throw new Error(`DOCKER_${args[0]}:${stderr.slice(0, 300)}`);
    return stdout.trim();
  } finally { clearTimeout(timer); }
}

function originalFixture(now: number) {
  // Fixture-only locally generated Nostr keys; never user keys or release evidence.
  const ownerKey = new Uint8Array(32).fill(7), artifact = new TextEncoder().encode("original sealed artifact bytes");
  const ownerEvent = finalizeEvent({ kind: 35129, created_at: Math.floor(now / 1_000), tags: [["d", "retained-fixture"], ["t", "napplet"]], content: "owner-owned original event" }, ownerKey);
  return {
    ownerId: ownerEvent.pubkey, artifact, ownerEvent,
    normalizedReceipt: { provider: "fixture-provider", inputTokens: 4, outputTokens: 2, releaseEvidence: false },
  } as const;
}

function generationAwareObjects(now: () => number): GcsObjectStoreAdapter {
  type Stored = Readonly<{ generation: number; checksum: string; bytes: Uint8Array }>;
  const entries = new Map<string, Stored>();
  const client: VersionedObjectClientPort = {
    async createIfAbsent(value) {
      if (entries.has(value.key)) throw new Error("FIXTURE_OBJECT_ALREADY_EXISTS");
      entries.set(value.key, Object.freeze({ generation: 1, checksum: value.checksum, bytes: new Uint8Array(value.bytes) }));
      return { generation: 1, checksum: value.checksum };
    },
    async findExactByKey(value) {
      const stored = entries.get(value.key);
      return stored?.checksum === value.checksum ? { generation: stored.generation, checksum: stored.checksum } : undefined;
    },
    async readGeneration(value) {
      const stored = entries.get(value.key);
      return stored?.generation === value.generation && stored.checksum === value.expectedChecksum
        ? { generation: stored.generation, checksum: stored.checksum, bytes: new Uint8Array(stored.bytes) } : undefined;
    },
    async scheduleGenerationDeletion(value) {
      const stored = entries.get(value.key);
      if (!stored || stored.generation !== value.generation || stored.checksum !== value.expectedChecksum || Date.parse(value.deleteAfter) > now()) throw new Error("FIXTURE_EXACT_GENERATION_DELETION_REQUIRED");
      entries.delete(value.key);
      return { generation: stored.generation, checksum: stored.checksum };
    },
  };
  return new GcsObjectStoreAdapter({ config: { bucket: "retained-subject-fixture", projectId: "retained-subject-fixture" }, client });
}

integration("canonical SQL prepares, clones, reattaches, and erases all seven retained subjects without replaying ambiguous provider effects", async () => {
  const suffix = crypto.randomUUID().replaceAll("-", "").slice(0, 16);
  const container = `cvm-retained-${suffix}`, sourceDatabase = `retained_source_${suffix}`, cloneDatabase = `retained_clone_${suffix}`, role = `retained_${suffix}`;
  let admin: Pool | undefined, source: Pool | undefined, runtime: Pool | undefined, recovered: Pool | undefined;
  try {
    await docker(["run", "--rm", "--detach", "--name", container, "--publish", "127.0.0.1::5432", "-e", "POSTGRES_HOST_AUTH_METHOD=trust", "postgres:17-alpine"]);
    const port = (await docker(["port", container, "5432/tcp"])).match(/127\.0\.0\.1:(\d+)/u)?.[1];
    if (!port) throw new Error("POSTGRES_PORT_REQUIRED");
    const connection = (user: string, database: string) => `postgresql://${user}@127.0.0.1:${port}/${database}`;
    admin = new Pool({ connectionString: connection("postgres", "postgres"), connectionTimeoutMillis: 2_000 });
    for (let attempt = 0; attempt < 60; attempt++) { try { await admin.query("SELECT 1"); break; } catch (error) { if (attempt === 59) throw error; await Bun.sleep(100); } }
    await admin.query(`CREATE DATABASE ${sourceDatabase}`);
    source = new Pool({ connectionString: connection("postgres", sourceDatabase), connectionTimeoutMillis: 2_000 });
    for (const path of migrations) await source.query(await Bun.file(`migrations/${path}`).text());
    await source.query(`CREATE ROLE ${role} LOGIN`); await source.query(`GRANT napplet_production_real TO ${role}`);
    runtime = new Pool({ connectionString: connection(role, sourceDatabase), connectionTimeoutMillis: 2_000 });
    const pool = bindAccountingRealmPool(sqlPool(runtime), createAccountingRealm("production-real"));
    await expect(assertProductionRetainedSubjectSchema(pool)).rejects.toThrow("PRODUCTION_RETAINED_SUBJECT_SCHEMA_REQUIRED");
    await source.query(await Bun.file(`migrations/${retainedSubjectMigrations[0]}`).text());
    await expect(assertProductionRetainedSubjectSchema(pool)).rejects.toThrow("PRODUCTION_RETAINED_SUBJECT_SCHEMA_REQUIRED");
    await source.query(await Bun.file(`migrations/${retainedSubjectMigrations[1]}`).text());
    await assertProductionRetainedSubjectSchema(pool);
    let now = Date.parse("2029-01-01T00:00:00.000Z");
    const retentionMs = 30 * 86_400_000, fixture = originalFixture(now), kek = Buffer.alloc(32, 17).toString("base64");
    expect(verifyEvent(wire(fixture.ownerEvent))).toBe(true);
    expect(verifyEvent(wire({ ...fixture.ownerEvent, content: "tampered" }))).toBe(false);
    const funding = new FundingService(new PostgresFundingDatabase(pool, { realm: "production-real" }).funding);
    const credited = await funding.execute({ principal: { pubkey: fixture.ownerId }, kind: "credit_settlement", idempotencyKey: "retained-fixture-credit", policyVersion: "fixture", protocolVersion: "fixture", payload: { settlement: { topUpId: "retained-fixture", rail: "lightning", unit: "sat", amount: "10", externalReference: "fixture:external", settlementReference: "fixture:settlement", verifiedAt: new Date(now).toISOString() } } });
    const accountId = credited.accountId, sessionId = "session:retained", actionId = "action:retained", artifactId = `artifact:${digest(fixture.artifact)}`, checkpointId = "checkpoint:retained";
    // Explicit zero-funded producer fixtures. They are records consumed by the
    // real preparer, not asserted as a release proof or external provider call.
    await source.query("INSERT INTO production_real.model_profile_versions VALUES('retained-profile',$1,'fixture','fixture','{}')", [hex("profile")]);
    await source.query("INSERT INTO production_real.price_card_versions(id,card_hash,profile_id,unit,normalized_card) VALUES('retained-price',$1,'retained-profile','sat','{}')", [hex("price")]);
    await source.query("INSERT INTO production_real.metered_sessions(id,account_id,admission_reference,profile_id,price_card_id,version,state) VALUES($1,$2,'fixture:admission','retained-profile','retained-price',0,'prepared')", [sessionId, accountId]);
    await source.query("INSERT INTO production_real.session_cap_holds(hold_id,account_id,reference,requested_cap,held_amount,state) VALUES('hold:retained',$1,'fixture:admission',10,10,'active')", [accountId]);
    await source.query("INSERT INTO production_real.admissions(admission_id,account_id,reference,capacity_reference,state) VALUES('admission:retained',$1,'fixture:admission','capacity:fixture','accepted')", [accountId]);
    await source.query("INSERT INTO production_real.action_budget_reservations(reservation_id,account_id,admission_reference,idempotency_key,fingerprint_sha256,reservation_reference,amount,unit,state) VALUES('reservation:retained',$1,'fixture:admission','retained-action',$2,'budget:retained',1,'sat','authorized')", [accountId, hex("action-fingerprint")]);
    const actionSeed = await source.connect();
    try {
      await actionSeed.query("BEGIN; SET CONSTRAINTS ALL DEFERRED");
      await actionSeed.query("INSERT INTO production_real.metered_actions(id,account_id,session_id,idempotency_key,fingerprint,expected_session_version,budget_reference,reservation_sat,operation_id,profile_id,price_card_id,state,terminal_result,evidence_reference,settled_at,admission_reference,receipt_charge,provider_receipt_reference,session_version,artifact_version,remaining_cap_sat,remaining_balance_sat,artifact_id,workspace_lineage,checkpoint_reference,snapshot_reference,validation_evidence_reference,validation_report_reference) VALUES($1,$2,$3,'retained-action',$4,0,'budget:retained',1,'provider:retained','retained-profile','retained-price','verified',$5,'evidence:action',clock_timestamp(),'fixture:admission',1,'receipt-original',0,1,9,9,$6,'workspace:retained','checkpoint:retained','snapshot:retained','validation:retained','validation:retained')", [actionId, accountId, sessionId, hex("action-fingerprint"), { status: "verified", releaseEvidence: false }, artifactId]);
      await actionSeed.query("INSERT INTO production_real.provider_operations(id,account_id,action_id,provider,model,provider_request_id,sub_reservation_sat,state) VALUES('provider:retained',$1,$2,'fixture-provider','fixture-model','request-original',1,'verified')", [accountId, actionId]);
      await actionSeed.query("COMMIT");
    } catch (error) { await actionSeed.query("ROLLBACK").catch(() => undefined); throw error; }
    finally { actionSeed.release(); }
    const objects = generationAwareObjects(() => now);
    const archive = new TextEncoder().encode("original checkpoint workspace bytes");
    const archiveSha256 = digest(archive);
    const manifest = { checkpointId, accountId, sessionId, pauseGeneration: 1, sessionVersion: 0, actionVersion: 0, artifactVersion: 1, workspaceVersion: 0, workspaceLineage: "workspace:retained", action: { actionId, operationId: "provider:retained", ledgerReference: "fixture:admission", pendingActionReference: "pending:retained", idempotencyKey: "retained-action" }, archiveSha256, inventory: ["harness_state", "workspace", "artifact_lineage", "validation_evidence", "financial_action", "pending_action", "compatibility_metadata"], evidenceSha256: hex("checkpoint-evidence"), compatibility: { policyVersion: "fixture", modelIdentity: "retained-profile", nappletSdkIdentity: "retained-price", toolchainIdentity: hex("toolchain") }, retentionUntil: new Date(now + retentionMs).toISOString() };
    const journal = new PostgresOperationJournal(pool, { namespace: "retained-subjects-postgres", scopeSha256: hex("scope") });
    const artifactRequest = { sessionId, actionId, expectedVersion: 0, policyVersion: "fixture", capabilityGrant: "phase-04-coordinator-grant", workspaceId: "workspace:retained", idea: "Build one focused retained-subject fixture." };
    const artifactResult = { status: "completed" as const, code: "WORKER_PROPOSALS_VALIDATED" as const, events: [{ kind: "progress" as const, turn: 1, detail: "fixture artifact verified" }], artifact: { sessionId, actionId, expectedVersion: 0, policyVersion: "fixture", capabilityGrant: "phase-04-coordinator-grant", workspaceId: "workspace:retained", artifactId, purpose: { kind: "focused" as const, statements: ["one retained-subject fixture"] }, surface: { hasBackend: false as const, hasSecondPurpose: false as const, serviceWorker: false as const, dynamicAuthority: false as const }, dependencies: { appOwnedSignerOrRelay: false as const, privateNappletImport: false as const }, capabilities: { declaredHard: [], observedDomains: [], optionalIntentPresenceRead: false, intentUsedThroughSdk: false }, upstream: { scanner: { verdict: "pass" as const, checkId: "upstream:fixture-scanner" }, conformance: { verdict: "pass" as const, checkId: "upstream:fixture-conformance" } } } };
    const persistedArtifact = await new ProductionWorkerArtifactStore({ journal, objects, toolchainSha256: hex("toolchain") }).persist({ request: artifactRequest, accountId, ownerId: fixture.ownerId, bytes: fixture.artifact, scannerReportSha256: hex("scanner"), conformanceReportSha256: hex("conformance"), result: artifactResult });
    const artifactReference = persistedArtifact.reference;
    const checkpoint = new ProductionCheckpointCoordinator({ pool, objectStore: objects, journal, kekPath: "/fixture/kek", readKekFile: async () => kek, now: () => now });
    await checkpoint.seal({ ...manifest, archive } satisfies CheckpointSealRequest);
    await source.query("INSERT INTO production_real.usage_receipts(id,account_id,action_id,operation_id,provider,model,provider_receipt_id,normalized_receipt,protected_evidence_reference) VALUES('receipt:retained',$1,$2,'provider:retained','fixture-provider','fixture-model','receipt-original',$3,'evidence:receipt')", [accountId, actionId, fixture.normalizedReceipt]);
    await source.query("INSERT INTO production_real.session_artifacts(id,account_id,session_id,action_id,version,lineage,validation_evidence_reference,verified) VALUES($1,$2,$3,$4,1,$5,'validation:retained',true)", [artifactId, accountId, sessionId, actionId, { lineage: "original", releaseEvidence: false }]);
    const artifact = { accountId, sessionId, artifactId, artifactVersion: 1, aggregateSha256: artifactReference.checksum, manifestSha256: hex("manifest"), verificationEvidenceSha256: hex("verification"), sealedObjectGeneration: String(artifactReference.generation), sealedObjectSha256: artifactReference.checksum, sealedFiles: [{ path: "/index.html", mimeType: "text/html", sha256: artifactReference.checksum, size: fixture.artifact.byteLength }], entrypoint: "/index.html", normalizedDTag: "retained-fixture", requiredCapabilities: [], optionalCapabilities: [], policyIdentity: "fixture-policy", toolchainIdentity: "fixture-toolchain", runtimeCompatibilityIdentity: "fixture-runtime" };
    const attestationSigner = new ProductionBuildAttestationSigner(new Uint8Array(32).fill(19));
    const attestation = attestationSigner.signBuild(buildCvmAttestation({ ownerEventId: fixture.ownerEvent.id, ownerPubkey: fixture.ownerId, artifact, sessionVersion: 0, policyVersion: "fixture-policy", toolchainIdentity: "fixture-toolchain", verificationEvidenceReference: "verification:retained", createdAtMs: now }));
    attestationSigner.close();
    expect(verifyEvent(wire(attestation))).toBe(true);
    expect(verifyEvent(wire({ ...attestation, tags: [["e", "wrong"]] }))).toBe(false);
    await source.query("INSERT INTO production_real.publication_intents(intent_id,owner_principal_id,session_id,artifact_id,artifact_version,artifact_sha256,manifest_sha256,aggregate_sha256,capability_digest,normalized_d_tag,runtime_variant,policy_identity,toolchain_identity,runtime_compatibility_identity,request_fingerprint_sha256,owner_template_json,owner_template_sha256,state,created_at_ms,expires_at_ms,record_json) VALUES('publication:retained',$1,$2,$3,1,$4,$5,$6,$7,'retained-fixture','fixture-runtime','fixture-policy','fixture-toolchain','fixture-runtime',$8,'{}',$9,'complete',$10,$11,$12)", [fixture.ownerId, sessionId, artifactId, artifactReference.checksum, hex("manifest"), hex("aggregate"), hex("capabilities"), hex("publication-request"), hex("template"), now, now + 60_000, { releaseEvidence: false }]);
    await source.query("INSERT INTO production_real.publication_signed_events(intent_id,event_id,event_json) VALUES('publication:retained',$1,$2)", [fixture.ownerEvent.id, fixture.ownerEvent]);
    for (const effect of ["deploy", "owner_manifest", "attestation"] as const) { const observation = effect === "attestation" ? attestation : { effect, releaseEvidence: false }; await source.query("INSERT INTO production_real.publication_effect_intents(effect_id,intent_id,effect_kind,operation_id,request_fingerprint_sha256,state,observation_json,observation_sha256,observed_at) VALUES($1,'publication:retained',$2,$3,$4,'observed_complete',$5,$6,clock_timestamp())", [`effect:${effect}`, effect, `operation:${effect}`, hex(`request:${effect}`), observation, digest(canonicalJson(observation))]); }
    await source.query("INSERT INTO production_real.publication_records(intent_id,owner_event_id,attestation_event_id,artifact_id,aggregate_sha256,deployment_operation_id,owner_manifest_operation_id,attestation_operation_id,terminal_state) VALUES('publication:retained',$1,$2,$3,$4,'operation:deploy','operation:owner_manifest','operation:attestation','complete')", [fixture.ownerEvent.id, attestation.id, artifactId, hex("aggregate")]);
    await expect(source.query("UPDATE production_real.publication_signed_events SET event_json=$1 WHERE intent_id='publication:retained'", [wire({ ...fixture.ownerEvent, content: "tampered" })])).rejects.toThrow("PRODUCTION_PUBLICATION_SIGNED_EVENT_IMMUTABLE");
    const originalRows = await source.query("SELECT normalized_receipt FROM production_real.usage_receipts WHERE id='receipt:retained'");
    const originalEvents = await source.query("SELECT e.event_json,ae.observation_json FROM production_real.publication_records p JOIN production_real.publication_signed_events e ON e.intent_id=p.intent_id JOIN production_real.publication_effect_intents ae ON ae.intent_id=p.intent_id AND ae.effect_kind='attestation' WHERE p.intent_id='publication:retained'");
    let createCalls = 0, deleteCalls = 0, loseCreateAck = true, loseDeleteAck = true;
    const effects: ObjectStorePort = {
      createImmutable: async value => { createCalls++; const result = await objects.createImmutable(value); if (loseCreateAck) { loseCreateAck = false; throw new Error("OBJECT_ACK_LOST"); } return result; },
      observeExactByKey: value => objects.observeExactByKey(value), readExact: value => objects.readExact(value),
      scheduleExactDeletion: async (value, deadline) => { deleteCalls++; await objects.scheduleExactDeletion(value, deadline); if (loseDeleteAck) { loseDeleteAck = false; throw new Error("DELETE_ACK_LOST"); } },
    };
    const preparer = new ProductionRetainedSubjectPreparer({ pool, objectStore: effects, journal, kekPath: "/fixture/kek", readKekFile: async () => kek, now: () => now });
    const scope = { checkpointId, sessionId, ownerId: fixture.ownerId };
    // The raw wire checks above reject invalid signatures/bindings. Stored
    // producer history then rejects tampering before preparation can read it.
    await expect(preparer.prepare(scope)).rejects.toThrow("OBJECT_ACK_LOST");
    await preparer.prepare(scope); // query-only reconciliation observes the original create; no replacement dispatch.
    expect(createCalls).toBe(6); // all six retained copies; lost ACK did not duplicate its subject.
    const inventory = await createProductionDurabilitySubjectRegistry(pool).inventory(scope);
    expect(inventory).toHaveLength(7);
    await runtime.end(); runtime = undefined; await source.end(); source = undefined;
    await admin.query(`CREATE DATABASE ${cloneDatabase} TEMPLATE ${sourceDatabase}`);
    recovered = new Pool({ connectionString: connection(role, cloneDatabase), connectionTimeoutMillis: 2_000 });
    const recoveredPool = bindAccountingRealmPool(sqlPool(recovered), createAccountingRealm("production-real"));
    const freshPreparer = new ProductionRetainedSubjectPreparer({ pool: recoveredPool, objectStore: effects, journal: new PostgresOperationJournal(recoveredPool, { namespace: "retained-subjects-postgres", scopeSha256: hex("scope") }), kekPath: "/fixture/kek", readKekFile: async () => kek, now: () => now });
    const recoveredInventory = await createProductionDurabilitySubjectRegistry(recoveredPool).inventory(scope);
    expect(recoveredInventory).toEqual(inventory);
    const recoveredCheckpoint = new ProductionCheckpointCoordinator({ pool: recoveredPool, objectStore: effects, journal: new PostgresOperationJournal(recoveredPool, { namespace: "retained-subjects-postgres", scopeSha256: hex("scope") }), kekPath: "/fixture/kek", readKekFile: async () => kek, now: () => now });
    const checkpointSubject = recoveredInventory.find(subject => subject.kind === "checkpoint");
    if (!checkpointSubject) throw new Error("CHECKPOINT_SUBJECT_REQUIRED");
    expect(await recoveredCheckpoint.restore({ checkpointId, accountId, sessionId })).toEqual(archive);
    const recoveredCrypto = new MountedKekCheckpointCrypto({ pool: recoveredPool, kekPath: "/fixture/kek", readFile: async () => kek, now: () => now });
    const retainedKeys = new Map<string, string>();
    for (const subject of recoveredInventory) if (subject.kind !== "checkpoint") {
      const stored = await recoveredCrypto.readSealed(retainedSubjectCustodyId({ checkpointId, kind: subject.kind, sourceIdentity: subject.sourceIdentity }));
      if (!stored) throw new Error("RETAINED_SUBJECT_KEY_REQUIRED");
      retainedKeys.set(subject.kind, stored.keyReference);
      const opened = await openRetainedSubject({ crypto: recoveredCrypto, objectStore: effects, checkpointId, accountId, sessionId, actionId, subject });
      await freshPreparer.validateOpened(scope, subject, opened);
      await expect(freshPreparer.validateOpened({ ...scope, ownerId: "f".repeat(64) }, subject, opened)).rejects.toThrow();
    }
    // Lost delete ACK is reconciled only by the new controller observing the
    // original operation: it must not dispatch replacement deletes or keys.
    now += retentionMs;
    await expect(freshPreparer.destroyExpired(scope)).rejects.toThrow("DELETE_ACK_LOST");
    expect(await freshPreparer.observeExpired(scope)).toBe(false);
    await freshPreparer.destroyExpired(scope); expect(await freshPreparer.observeExpired(scope)).toBe(true);
    expect(deleteCalls).toBe(6);
    for (const subject of recoveredInventory) if (subject.kind !== "checkpoint") {
      expect(await effects.readExact(subject.object)).toBeUndefined();
      expect(await recoveredCrypto.isDestroyed(retainedKeys.get(subject.kind) ?? "missing-key")).toBe(true);
    }
    expect((await recovered.query("SELECT count(*)::int AS count FROM production_real.durability_subjects WHERE checkpoint_id=$1 AND deletion_state='deleted'", [checkpointId])).rows).toEqual([{ count: 6 }]);
    expect((await recovered.query("SELECT deletion_state FROM production_real.durability_subjects WHERE checkpoint_id=$1 AND kind='checkpoint'", [checkpointId])).rows).toEqual([{ deletion_state: "retained" }]);
    expect((await recovered.query("SELECT normalized_receipt FROM production_real.usage_receipts WHERE id='receipt:retained'")).rows).toEqual(originalRows.rows);
    expect((await recovered.query("SELECT e.event_json,ae.observation_json FROM production_real.publication_records p JOIN production_real.publication_signed_events e ON e.intent_id=p.intent_id JOIN production_real.publication_effect_intents ae ON ae.intent_id=p.intent_id AND ae.effect_kind='attestation' WHERE p.intent_id='publication:retained'")).rows).toEqual(originalEvents.rows);
    console.log(JSON.stringify({ retainedSubjectsPostgres: true, subjects: 7, freshClone: true, releaseEvidence: false }));
  } finally {
    await recovered?.end(); await runtime?.end(); await source?.end(); await admin?.end();
    await docker(["rm", "--force", container]).catch(() => undefined);
  }
}, 120_000);
