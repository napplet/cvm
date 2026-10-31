import { expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { finalizeEvent, verifyEvent } from "nostr-tools/pure";
import { Pool } from "pg";
import type { PostgresSqlPool } from "../../src/persistence/postgres-sql-funding-store";
import { bindAccountingRealmPool, createAccountingRealm } from "../../src/funding/accounting-realm";
import { FundingService } from "../../src/funding/funding-service";
import { PostgresFundingDatabase } from "../../src/persistence/postgres-funding-database";
import { ContinuationService } from "../../src/continuity/continuation-service";
import { PostgresOperationJournal } from "../../src/release/deployment/postgres-operation-journal";
import { ProductionCheckpointCoordinator } from "../../src/production/checkpoint-coordinator";
import { ProductionRetainedSubjectPreparer } from "../../src/production/retained-subject-preparer";
import { createProductionDurabilitySubjectRegistry } from "../../src/production/durability-registry";
import { retainedSubjectCustodyId, sealRetainedSubject } from "../../src/production/retained-subject-archive";
import { MountedKekCheckpointCrypto } from "../../src/production/checkpoint-crypto";
import { GcsObjectStoreAdapter, type ObjectStorePort, type VersionedObjectClientPort } from "../../src/continuity/object-store";
import type { CheckpointSealRequest } from "../../src/continuity/checkpoint-envelope";
import { buildCvmAttestation } from "../../src/publication/attestation-event";
import { ProductionBuildAttestationSigner } from "../../src/production/attestation-signer";
import { ProductionWorkerArtifactStore } from "../../src/production/worker-artifact-store";
import { canonicalJson } from "../../src/promotion/schema";
import { assertProductionRetainedSubjectSchema } from "../../src/production/checkpoint-schema";
import { ProductionRestoreCertification } from "../../src/production/restore-certification";
import { MigrationArchiveCipher, ProductionMigrationSource } from "../../src/production/migration-control";
import { CoreFreshInstanceSchema, CoreRestoreDescriptorSchema } from "../../src/release/deployment/production-core-suite-protocol";
import { createMountedFreshRestoreRuntime } from "../../src/production/mounted-fresh-restore-runtime";
import { loadProductionConfig } from "../../src/production/config";
import { MountedProductionSecretMaterial } from "../../src/production/secret-material";
import { openProductionServiceJournals } from "../../src/production/service-journals";
import { createPostgresWorkerOperationJournal } from "../../src/release/deployment/postgres-provider-journals";
import { createWorkerDeploymentClients, PRODUCTION_WORKER_POLICY } from "../../src/release/deployment/worker-clients";
import { ProductionWorkerJobRouter } from "../../src/production/worker-job-router";
import { ProductionWorkerRequestStore } from "../../src/production/worker-request-store";
import { ProductionWorkerBridge, ProductionWorkerOwnershipResolver } from "../../src/production/worker-bridge";
import { WorkerRunRequestSchema } from "../../src/phase-02/contracts";

/* This is deliberately an opt-in local integration test.  The source records,
 * funding account, provider receipt, and signed events below are explicit
 * isolated fixtures (releaseEvidence: false); Docker is never a live Cloud SQL,
 * GCS, payment, signer, model, or worker certification claim. */
const integration = process.env.NAPPLET_RUN_POSTGRES_ISOLATION === "1" ? test : test.skip;
const digest = (value: Uint8Array | string) => createHash("sha256").update(value).digest("hex");
const hex = (value: string) => digest(value);
const wire = <Value>(value: Value): Value => JSON.parse(JSON.stringify(value)) as Value;
function deferred<Value>() {
  let resolve!: (value: Value | PromiseLike<Value>) => void;
  const promise = new Promise<Value>(value => { resolve = value; });
  return { promise, resolve };
}
const migrations = [
  "phase-03/001_funding.sql", "phase-04/001_metered_generation.sql", "phase-04/002_action_budget_lifecycle.sql",
  "phase-05/001_continuation.sql", "phase-06/001_publication.sql", "phase-03/002_production_accounting.sql",
  "phase-03/003_cashu_custody_and_identities.sql", "phase-03/004_production_rail_material_scope.sql",
  "phase-07/001_production_operation_journal.sql", "phase-07/002_production_pricing_catalog.sql",
  "phase-07/003_production_checkpoints.sql",
  "development/001_generation.sql", "development/002_provider_observations.sql", "development/003_artifact_preview.sql",
  "development/004_source_proposal_bindings.sql", "development/005_pending_actions.sql", "development/006_worker_results.sql",
  "development/007_chatgpt_operations.sql", "development/008_chatgpt_diagnostics.sql", "development/009_operator_publication.sql",
  "development/010_projects.sql", "development/011_publication_relays.sql", "development/012_remix_imports.sql",
  "development/013_publication_tracking.sql", "development/014_request_cost_history.sql", "development/015_revision_restore.sql",
  "development/016_usage_evidence.sql",
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

function generationAwareObjects(now: () => number, loseDeletionAck: () => boolean = () => false, onDeletion: () => void = () => undefined): GcsObjectStoreAdapter {
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
      onDeletion();
      if (loseDeletionAck()) throw new Error("DELETE_ACK_LOST");
      return { generation: stored.generation, checksum: stored.checksum };
    },
  };
  return new GcsObjectStoreAdapter({ config: { bucket: "retained-subject-fixture", projectId: "retained-subject-fixture" }, client });
}

function mountedConfig(topologySha256: string) {
  const digest = "a".repeat(64), image = `registry.example/retained@sha256:${digest}`;
  return loadProductionConfig({
    realm: "production-real", candidateSha256: digest, topologySha256, projectId: "napplet-cvm-01", regions: ["us-central1", "europe-west1"],
    cloudSql: { instanceReference: "sql:retained", database: "production_real", roleCredentialReference: "sql:role", restoreRecoveredRoleCredentialReference: "sql:recovered", restoreMigrationRoleCredentialReference: "sql:migration", migrationRevision: digest },
    gcs: { bucket: "retained-subject-bucket", location: "nam4", encryptionKeyReference: "gcs:key", migrationBackupKeyReference: "gcs:migration", retentionDays: 30 }, checkpoint: { kekReference: "checkpoint:kek" },
    contextvm: { relay: "wss://relay.example", serviceKeyReference: "contextvm:key" }, certification: { authorizationRequestReference: "cert:request", authorizationReceiptReference: "cert:receipt", clientKeyReference: "cert:client", sessionMaterialReference: "cert:session", serverPubkey: "b".repeat(64) },
    funding: { nwcConnectionReference: "funding:nwc", cashuConsentReference: "funding:cashu", protectedMaterialReference: "funding:protected", admissionReceiptReference: "funding:admission", statusCursorReference: "funding:cursor" },
    vertex: { projectReference: "vertex:project", credentialReference: "vertex:credential", model: "gemini-4-argon", priceSnapshotSha256: digest },
    worker: { selectedProvider: "fly", evidenceReference: "worker:evidence", modalAccessReference: "worker:modal", flyAccessReference: "worker:fly", image, toolchainSha256: hex("mounted-worker-toolchain"), policyVersion: "fixture-policy" },
    compatibleHost: { targetUrl: "https://host.example", targetSha256: digest, chromiumExecutable: "/usr/bin/chromium" },
    publication: { cliSourceReference: "publication:cli", signerBrokerReference: "publication:broker", signerSessionKeyReference: "publication:session", attestationKeyReference: "publication:attestation", ownerPubkey: "c".repeat(64), uploadServer: "https://upload.example", uploadTargetReference: "publication:target", relays: ["wss://relay.example"] },
    publicOrigins: { static: "https://static.example", preview: "https://preview.example", artifact: "https://artifact.example" }, policy: { artifactVersion: "fixture-policy", retentionDays: 30, liveGraceMs: 600_000 }, collector: { otlpEndpoint: "https://otlp.example", serviceName: "napplet-cvm-production" },
    operator: { serviceAccount: "retained-runner@napplet-cvm-01.iam.gserviceaccount.com", privateControlAudience: "https://retained-control.run.app" }, image: { controlPlane: image, toolchainSha256: hex("mounted-worker-toolchain") },
  });
}

integration("canonical SQL prepares, clones, reattaches, and erases all seven retained subjects without replaying ambiguous provider effects", async () => {
  const suffix = crypto.randomUUID().replaceAll("-", "").slice(0, 16);
  const container = `cvm-retained-${suffix}`, sourceDatabase = `retained_source_${suffix}`, cloneDatabase = `retained_clone_${suffix}`, migrationDatabase = `retained_migration_${suffix}`, role = `retained_${suffix}`;
  let admin: Pool | undefined, source: Pool | undefined, sourceRuntime: Pool | undefined, runtime: Pool | undefined, recovered: Pool | undefined, migration: Pool | undefined;
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
    const fundingDatabase = new PostgresFundingDatabase(pool, { realm: "production-real" });
    const funding = new FundingService(fundingDatabase.funding);
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
      await actionSeed.query("INSERT INTO production_real.metered_actions(id,account_id,session_id,idempotency_key,fingerprint,expected_session_version,budget_reference,reservation_sat,operation_id,profile_id,price_card_id,state,terminal_result,evidence_reference,settled_at,admission_reference,receipt_charge,provider_receipt_reference,session_version,artifact_version,remaining_cap_sat,remaining_balance_sat,artifact_id,workspace_lineage,checkpoint_reference,snapshot_reference,validation_evidence_reference,validation_report_reference) VALUES($1,$2,$3,'retained-action',$4,0,'budget:retained',1,'provider:retained','retained-profile','retained-price','verified',$5,'evidence:action',clock_timestamp(),'fixture:admission',1,'receipt-original',0,1,9,9,$6,$7,'checkpoint:retained','snapshot:retained',('verification:' || $6),NULL)", [actionId, accountId, sessionId, hex("action-fingerprint"), { status: "verified", releaseEvidence: false }, artifactId, `workspace:${sessionId}`]);
      await actionSeed.query("INSERT INTO production_real.provider_operations(id,account_id,action_id,provider,model,provider_request_id,sub_reservation_sat,state) VALUES('provider:retained',$1,$2,'fixture-provider','fixture-model','request-original',1,'verified')", [accountId, actionId]);
      await actionSeed.query("COMMIT");
    } catch (error) { await actionSeed.query("ROLLBACK").catch(() => undefined); throw error; }
    finally { actionSeed.release(); }
    let deleteCalls = 0, loseMountedDeleteAck = true;
    const objects = generationAwareObjects(() => now, () => {
      if (!loseMountedDeleteAck) return false;
      loseMountedDeleteAck = false;
      return true;
    }, () => { deleteCalls++; });
    const config = mountedConfig(hex("topology"));
    const workspaceFiles = [{ path: "src/main.ts", content: "document.body.textContent = 'retained workspace';" }, { path: "src/styles.css", content: "body{color:#111}" }, { path: "src/capabilities.json", content: "{}" }] as const;
    const sourceProposalSha256 = digest(canonicalJson(workspaceFiles));
    const workspaceSource = { version: 1 as const, actionId, sessionId, expectedVersion: 0, proposalSha256: sourceProposalSha256, toolchainSha256: config.worker.toolchainSha256, deadlineEpochMs: Date.now() + 1_200_000, files: workspaceFiles };
    const workspaceJobId = digest(canonicalJson(workspaceSource));
    const workspaceFile = new TextEncoder().encode("<main>retained workspace</main>");
    const commandEvidence = Array.from({ length: 8 }, () => ({ argv: ["fixture"], exitCode: 0 as const, stdout: "", stderr: "", elapsedMs: 0 }));
    const workspaceArtifact = { version: 1 as const, jobId: workspaceJobId, proposalSha256: sourceProposalSha256, toolchainSha256: config.worker.toolchainSha256, files: [{ path: "index.html", bytesBase64: Buffer.from(workspaceFile).toString("base64"), sha256: digest(workspaceFile), size: workspaceFile.byteLength }], commandEvidence };
    const archive = new TextEncoder().encode(canonicalJson({ version: 1, source: workspaceSource, artifact: workspaceArtifact, toolchainSha256: config.worker.toolchainSha256 }));
    const archiveSha256 = digest(archive);
    const manifest = { checkpointId, accountId, sessionId, pauseGeneration: 1, sessionVersion: 0, actionVersion: 0, artifactVersion: 1, workspaceVersion: 0, workspaceLineage: `workspace:${sessionId}`, action: { actionId, operationId: "provider:retained", ledgerReference: "fixture:admission", pendingActionReference: "pending:retained", idempotencyKey: "retained-action" }, archiveSha256, inventory: ["harness_state", "workspace", "artifact_lineage", "validation_evidence", "financial_action", "pending_action", "compatibility_metadata"], evidenceSha256: hex("checkpoint-evidence"), compatibility: { policyVersion: "fixture-policy", modelIdentity: "retained-profile", nappletSdkIdentity: "retained-price", toolchainIdentity: config.worker.toolchainSha256 }, retentionUntil: new Date(now + retentionMs).toISOString() };
    const journal = new PostgresOperationJournal(pool, { namespace: "retained-subjects-postgres", scopeSha256: hex("scope") });
    const artifactRequest = { sessionId, actionId, expectedVersion: 0, policyVersion: "fixture", capabilityGrant: "phase-04-coordinator-grant", workspaceId: "workspace:retained", idea: "Build one focused retained-subject fixture." };
    const artifactResult = { status: "completed" as const, code: "WORKER_PROPOSALS_VALIDATED" as const, events: [{ kind: "progress" as const, turn: 1, detail: "fixture artifact verified" }], artifact: { sessionId, actionId, expectedVersion: 0, policyVersion: "fixture", capabilityGrant: "phase-04-coordinator-grant", workspaceId: "workspace:retained", artifactId, purpose: { kind: "focused" as const, statements: ["one retained-subject fixture"] }, surface: { hasBackend: false as const, hasSecondPurpose: false as const, serviceWorker: false as const, dynamicAuthority: false as const }, dependencies: { appOwnedSignerOrRelay: false as const, privateNappletImport: false as const }, capabilities: { declaredHard: [], observedDomains: [], optionalIntentPresenceRead: false, intentUsedThroughSdk: false }, upstream: { scanner: { verdict: "pass" as const, checkId: "upstream:fixture-scanner" }, conformance: { verdict: "pass" as const, checkId: "upstream:fixture-conformance" } } } };
    const persistedArtifact = await new ProductionWorkerArtifactStore({ journal, objects, toolchainSha256: hex("toolchain") }).persist({ request: artifactRequest, accountId, ownerId: fixture.ownerId, bytes: fixture.artifact, scannerReportSha256: hex("scanner"), conformanceReportSha256: hex("conformance"), result: artifactResult });
    const artifactReference = persistedArtifact.reference;
    const checkpoint = new ProductionCheckpointCoordinator({ pool, objectStore: objects, journal, kekPath: "/fixture/kek", readKekFile: async () => kek, now: () => now });
    const pauseIntent = { accountId, sessionId, idempotencyKey: "retained-reattach", fingerprint: hex("retained-reattach"), reference: "pending:retained", actionKind: "start_session" as const, boundedPayloadHash: hex("retained-idea"), expectedSessionVersion: 0, expectedArtifactVersion: 1, policyVersion: "fixture", priceCardId: "retained-price", profileId: "retained-profile", toolchainId: "fixture-toolchain", actionMaximum: "11", admissionReference: "fixture:admission" };
    const pause = await new ContinuationService({ store: fundingDatabase.continuationFunding, includeAdmissionHold: true, clock: { nowMs: () => now } }).pauseForFunding({ intent: pauseIntent });
    if (!pause) throw new Error("RETAINED_SUBJECT_PAUSE_REQUIRED");
    const paused = await fundingDatabase.continuationFunding.findContinuationPause(accountId, sessionId, 1);
    if (!paused?.liveLeaseToken) throw new Error("RETAINED_SUBJECT_LIVE_LEASE_REQUIRED");
    await fundingDatabase.continuationFunding.transact(accountId, transaction => transaction.beginDeadlineCheckpoint({ sessionId, pauseGeneration: 1, liveLeaseToken: paused.liveLeaseToken! }));
    const sealedCheckpoint = await checkpoint.seal({ ...manifest, archive } satisfies CheckpointSealRequest);
    await fundingDatabase.continuationFunding.transact(accountId, transaction => transaction.commitDeadlineCheckpoint({ accountId, sessionId, pauseGeneration: 1, checkpointId, expectedSessionVersion: 0, expectedArtifactVersion: 1, manifestReference: `manifest:${sealedCheckpoint.envelope.manifestSha256}`, objectKey: sealedCheckpoint.envelope.object.key, objectGeneration: String(sealedCheckpoint.envelope.object.generation), objectChecksum: sealedCheckpoint.envelope.object.checksum, keyReference: sealedCheckpoint.envelope.crypto.keyReference, compatibilityIdentity: "fixture-toolchain", checkpointCommittedAtMs: now }));
    await fundingDatabase.continuationFunding.transact(accountId, transaction => transaction.claimResume({ accountId, sessionId, checkpointId, idempotencyKey: "retained-reattach", fingerprint: hex("retained-reattach-claim"), pendingFingerprint: pauseIntent.fingerprint, expectedCheckpointVersion: 1, expectedSessionVersion: 0, nowMs: now, newLeaseToken: "lease:retained:reattach", allocationIntentReference: "allocation:retained", actionId, operationId: "operation:retained-reattach", actionBudgetReference: "budget:retained" }));
    // Seed the original, zero-effect worker ownership through canonical SQL
    // records before cloning. The mounted bridge must resolve this tuple; it
    // receives no callback authority from the test.
    const capacityIntent = `capacity-intent:${hex("retained-capacity-intent")}`, capacityReference = `capacity:${hex("retained-capacity")}`, workerOperationId = `capacity-${hex("retained-worker").slice(0, 40)}`, workerDeadline = Date.now() + 1_200_000;
    await source.query("INSERT INTO production_real.capacity_intents(intent_id,account_id,idempotency_key,fingerprint_sha256,intent_reference,capacity_reference,expires_at,state) VALUES('capacity:retained',$1,'retained-capacity',$2,$3,$4,to_timestamp($5 / 1000.0),'available')", [accountId, hex("retained-capacity-fingerprint"), capacityIntent, capacityReference, workerDeadline]);
    await source.query("INSERT INTO production_real.continuation_worker_allocations(checkpoint_id,account_id,session_id,action_id,allocation_intent_reference,capacity_intent_reference,capacity_reference,state) VALUES($1,$2,$3,$4,'allocation:retained',$5,$6,'available')", [checkpointId, accountId, sessionId, actionId, capacityIntent, capacityReference]);
    const serviceJournals = await openProductionServiceJournals({ pool, servicePubkey: config.certification.serverPubkey, initialTopologySha256: config.topologySha256 });
    const workerRecords = createPostgresWorkerOperationJournal(serviceJournals.worker);
    await workerRecords.claim({ operationId: workerOperationId, requestSha256: hex("retained-worker-request"), resourceName: workerOperationId, provider: "fly", appName: "retained-workers", policyVersion: PRODUCTION_WORKER_POLICY.version, image: config.worker.image, sessionLeaseSha256: hex("retained-worker-lease"), toolchainSha256: config.worker.toolchainSha256, providerDeadlineEpochMs: workerDeadline, createdAtMs: Date.now() });
    await workerRecords.update({ operationId: workerOperationId, requestSha256: hex("retained-worker-request"), resourceId: "retained-worker-machine", state: "reconciled", providerCreatedAtMs: Date.now() });
    await serviceJournals.capacity.claim(`capacity-intent:${digest(capacityIntent)}`, hex("retained-capacity-journal"), { intentReference: capacityIntent, reference: capacityReference, workerOperationId, provider: "fly", deadlineEpochMs: workerDeadline });
    const workerRequest = WorkerRunRequestSchema.parse({ sessionId, actionId, expectedVersion: 0, policyVersion: config.worker.policyVersion, capabilityGrant: "phase-04-coordinator-grant", workspaceId: `workspace:${sessionId}`, sourceProposalReference: `proposal:sha256:${sourceProposalSha256}`, sourceProposalSha256, sourceProposalFiles: workspaceFiles });
    await new ProductionWorkerRequestStore(serviceJournals.request).persist(workerRequest);
    const jobKey = `worker-build:${digest(canonicalJson({ sessionId, actionId, expectedVersion: 0 }))}`;
    await serviceJournals.job.claim(jobKey, digest(canonicalJson(workerRequest)), { workerOperationId, workerResourceId: "retained-worker-machine", leaseSha256: hex("retained-worker-lease"), jobId: workspaceJobId, requestBody: canonicalJson(workspaceSource), deadlineEpochMs: workspaceSource.deadlineEpochMs });
    await source.query("INSERT INTO production_real.usage_receipts(id,account_id,action_id,operation_id,provider,model,provider_receipt_id,normalized_receipt,protected_evidence_reference) VALUES('receipt:retained',$1,$2,'provider:retained','fixture-provider','fixture-model','receipt-original',$3,'evidence:receipt')", [accountId, actionId, fixture.normalizedReceipt]);
    await source.query("INSERT INTO production_real.session_artifacts(id,account_id,session_id,action_id,version,lineage,validation_evidence_reference,verified) VALUES($1,$2,$3,$4,1,$5,('verification:' || $1),true)", [artifactId, accountId, sessionId, actionId, { lineage: "original", releaseEvidence: false }]);
    const artifact = { accountId, sessionId, artifactId, artifactVersion: 1, aggregateSha256: artifactReference.checksum, manifestSha256: hex("manifest"), verificationEvidenceSha256: hex("scanner"), sealedObjectGeneration: String(artifactReference.generation), sealedObjectSha256: artifactReference.checksum, sealedFiles: [{ path: "/index.html", mimeType: "text/html", sha256: artifactReference.checksum, size: fixture.artifact.byteLength }], entrypoint: "/index.html", normalizedDTag: "retained-fixture", requiredCapabilities: [], optionalCapabilities: [], policyIdentity: "fixture-policy", toolchainIdentity: "fixture-toolchain", runtimeCompatibilityIdentity: "fixture-runtime" };
    const attestationSigner = new ProductionBuildAttestationSigner(new Uint8Array(32).fill(19));
    const attestationAuthority = { schemaVersion: "mounted-attestation-signer-v1", publicKey: attestationSigner.publicKey };
    const attestation = attestationSigner.signBuild(buildCvmAttestation({ ownerEventId: fixture.ownerEvent.id, ownerPubkey: fixture.ownerId, artifact, sessionVersion: 0, policyVersion: "fixture-policy", toolchainIdentity: "fixture-toolchain", verificationEvidenceReference: `verification:${artifactId}`, createdAtMs: now }));
    attestationSigner.close();
    expect(verifyEvent(wire(attestation))).toBe(true);
    expect(verifyEvent(wire({ ...attestation, tags: [["e", "wrong"]] }))).toBe(false);
    await source.query("INSERT INTO production_real.release_operation_journal(namespace,scope_sha256,operation_id,identity_sha256,value_json) VALUES('production-worker-request',$1,'attestation-signer-authority',$2,$3)", [config.topologySha256, digest(canonicalJson(attestationAuthority)), attestationAuthority]);
    await source.query("INSERT INTO production_real.publication_intents(intent_id,owner_principal_id,session_id,artifact_id,artifact_version,artifact_sha256,manifest_sha256,aggregate_sha256,capability_digest,normalized_d_tag,runtime_variant,policy_identity,toolchain_identity,runtime_compatibility_identity,request_fingerprint_sha256,owner_template_json,owner_template_sha256,state,created_at_ms,expires_at_ms,record_json) VALUES('publication:retained',$1,$2,$3,1,$4,$5,$6,$7,'retained-fixture','fixture-runtime','fixture-policy','fixture-toolchain','fixture-runtime',$8,'{}',$9,'complete',$10,$11,$12)", [fixture.ownerId, sessionId, artifactId, artifactReference.checksum, hex("manifest"), artifactReference.checksum, hex("capabilities"), hex("publication-request"), hex("template"), now, now + 60_000, { releaseEvidence: false }]);
    await source.query("INSERT INTO production_real.publication_signed_events(intent_id,event_id,event_json) VALUES('publication:retained',$1,$2)", [fixture.ownerEvent.id, fixture.ownerEvent]);
    for (const effect of ["deploy", "owner_manifest", "attestation"] as const) { const observation = effect === "attestation" ? attestation : { effect, releaseEvidence: false }; await source.query("INSERT INTO production_real.publication_effect_intents(effect_id,intent_id,effect_kind,operation_id,request_fingerprint_sha256,state,observation_json,observation_sha256,observed_at) VALUES($1,'publication:retained',$2,$3,$4,'observed_complete',$5,$6,clock_timestamp())", [`effect:${effect}`, effect, `operation:${effect}`, hex(`request:${effect}`), observation, digest(canonicalJson(observation))]); }
    await source.query("INSERT INTO production_real.publication_records(intent_id,owner_event_id,attestation_event_id,artifact_id,aggregate_sha256,deployment_operation_id,owner_manifest_operation_id,attestation_operation_id,terminal_state) VALUES('publication:retained',$1,$2,$3,$4,'operation:deploy','operation:owner_manifest','operation:attestation','complete')", [fixture.ownerEvent.id, attestation.id, artifactId, artifactReference.checksum]);
    await expect(source.query("UPDATE production_real.publication_signed_events SET event_json=$1 WHERE intent_id='publication:retained'", [wire({ ...fixture.ownerEvent, content: "tampered" })])).rejects.toThrow("PRODUCTION_PUBLICATION_SIGNED_EVENT_IMMUTABLE");
    const originalRows = await source.query("SELECT normalized_receipt FROM production_real.usage_receipts WHERE id='receipt:retained'");
    const originalEvents = await source.query("SELECT e.event_json,ae.observation_json FROM production_real.publication_records p JOIN production_real.publication_signed_events e ON e.intent_id=p.intent_id JOIN production_real.publication_effect_intents ae ON ae.intent_id=p.intent_id AND ae.effect_kind='attestation' WHERE p.intent_id='publication:retained'");
    let createCalls = 0, loseCreateAck = true;
    const effects: ObjectStorePort = {
      createImmutable: async value => { createCalls++; const result = await objects.createImmutable(value); if (loseCreateAck) { loseCreateAck = false; throw new Error("OBJECT_ACK_LOST"); } return result; },
      observeExactByKey: value => objects.observeExactByKey(value), readExact: value => objects.readExact(value),
      scheduleExactDeletion: (value, deadline) => objects.scheduleExactDeletion(value, deadline),
    };
    const preparer = new ProductionRetainedSubjectPreparer({ pool, objectStore: effects, journal, kekPath: "/fixture/kek", readKekFile: async () => kek, now: () => now });
    const scope = { checkpointId, sessionId, ownerId: fixture.ownerId };
    const retentionDeadline = now + retentionMs;
    // Barrier 1: the schema assertion itself is an await. If it reaches the
    // exact deadline, the registry connection may be acquired but must never
    // issue a new checkpoint registry insert.
    let schemaVerified = false;
    const schemaBarrierPool: PostgresSqlPool = {
      async connect() {
        if (schemaVerified) now = retentionDeadline;
        const client = await pool.connect();
        return {
          async query<Row extends Record<string, unknown>>(text: string, values?: readonly unknown[]) {
            const result = await client.query<Row>(text, values);
            if (text.includes("checkpoint_crypto_audit_sequence_seq")) schemaVerified = true;
            return result;
          },
          release() { client.release(); },
        };
      },
    };
    now = retentionDeadline - 1;
    const schemaBarrierPreparer = new ProductionRetainedSubjectPreparer({ pool: schemaBarrierPool, objectStore: effects, journal, kekPath: "/fixture/kek", readKekFile: async () => kek, now: () => now });
    await expect(schemaBarrierPreparer.prepare(scope)).rejects.toThrow("RETAINED_SUBJECT_RETENTION_EXPIRED");
    expect(Number((await runtime.query("SELECT count(*)::int AS count FROM production_real.durability_subjects WHERE checkpoint_id=$1", [checkpointId])).rows[0]!.count)).toBe(0);

    // Barriers 2 and 3 exercise the actual mounted crypto/SQL journal while
    // pausing only fixture transports. The first crosses the KEK wait before
    // crypto custody insertion; the second crosses an existing custody read
    // before an object-intent claim.
    const barrierRetention = new Date(retentionDeadline).toISOString();
    const cryptoSource = { kind: "validation_evidence" as const, sourceIdentity: "barrier:crypto", bytes: new TextEncoder().encode("barrier crypto original") };
    const cryptoCustody = retainedSubjectCustodyId({ checkpointId, kind: cryptoSource.kind, sourceIdentity: cryptoSource.sourceIdentity });
    const kekGate = deferred<string>();
    const cryptoDeadline = new MountedKekCheckpointCrypto({ pool, kekPath: "/fixture/kek", readFile: async () => kekGate.promise, now: () => now });
    now = retentionDeadline - 1;
    const pendingCrypto = sealRetainedSubject({ crypto: cryptoDeadline, objectStore: objects, journal, checkpointId, accountId, ownerId: fixture.ownerId, sessionId, actionId, retentionUntil: barrierRetention, source: cryptoSource, now: () => now });
    now = retentionDeadline;
    kekGate.resolve(kek);
    await expect(pendingCrypto).rejects.toThrow("RETAINED_SUBJECT_RETENTION_EXPIRED");
    expect(await cryptoDeadline.readSealed(cryptoCustody)).toBeUndefined();

    const readSource = { kind: "usage_receipt" as const, sourceIdentity: "barrier:crypto-read", bytes: new TextEncoder().encode("barrier crypto read original") };
    const readCustody = retainedSubjectCustodyId({ checkpointId, kind: readSource.kind, sourceIdentity: readSource.sourceIdentity });
    const readOperation = `retained-object:${digest(canonicalJson({ checkpointId, kind: readSource.kind, sourceIdentity: readSource.sourceIdentity })).slice(0, 48)}`;
    const mountedCrypto = new MountedKekCheckpointCrypto({ pool, kekPath: "/fixture/kek", readFile: async () => kek, now: () => now });
    const readStarted = deferred<void>(), readGate = deferred<void>();
    const readBarrierCrypto = {
      seal: (value: Parameters<typeof mountedCrypto.seal>[0]) => mountedCrypto.seal(value),
      open: (value: Parameters<typeof mountedCrypto.open>[0]) => mountedCrypto.open(value),
      destroy: (keyReference: string) => mountedCrypto.destroy(keyReference),
      isDestroyed: (keyReference: string) => mountedCrypto.isDestroyed(keyReference),
      async readSealed(id: string) {
        const value = await mountedCrypto.readSealed(id);
        if (id === readCustody) { readStarted.resolve(); await readGate.promise; }
        return value;
      },
    };
    now = retentionDeadline - 1;
    const pendingRead = sealRetainedSubject({ crypto: readBarrierCrypto, objectStore: objects, journal, checkpointId, accountId, ownerId: fixture.ownerId, sessionId, actionId, retentionUntil: barrierRetention, source: readSource, now: () => now });
    await readStarted.promise;
    now = retentionDeadline;
    readGate.resolve();
    await expect(pendingRead).rejects.toThrow("RETAINED_SUBJECT_RETENTION_EXPIRED");
    expect(await mountedCrypto.isDestroyed((await mountedCrypto.readSealed(readCustody))?.keyReference ?? "checkpoint-key:missing")).toBe(true);
    expect(await journal.read(readOperation)).toBeUndefined();

    const journalSource = { kind: "owner_event" as const, sourceIdentity: "barrier:journal", bytes: new TextEncoder().encode("barrier journal original") };
    const journalCustody = retainedSubjectCustodyId({ checkpointId, kind: journalSource.kind, sourceIdentity: journalSource.sourceIdentity });
    const journalOperation = `retained-object:${digest(canonicalJson({ checkpointId, kind: journalSource.kind, sourceIdentity: journalSource.sourceIdentity })).slice(0, 48)}`;
    const journalCrypto = new MountedKekCheckpointCrypto({ pool, kekPath: "/fixture/kek", readFile: async () => kek, now: () => now });
    let journalBarrierCreates = 0;
    const journalClaimed = deferred<void>(), journalGate = deferred<void>();
    const journalBarrier = {
      async claim<T>(operationId: string, identitySha256: string, value: T) {
        const result = await journal.claim(operationId, identitySha256, value);
        journalClaimed.resolve(); await journalGate.promise;
        return result;
      },
      read: journal.read.bind(journal),
    };
    const journalBarrierObjects: ObjectStorePort = {
      async createImmutable(value) { journalBarrierCreates++; return objects.createImmutable(value); },
      observeExactByKey: value => objects.observeExactByKey(value), readExact: value => objects.readExact(value),
      scheduleExactDeletion: (value, deadline) => objects.scheduleExactDeletion(value, deadline),
    };
    now = retentionDeadline - 1;
    const pendingJournal = sealRetainedSubject({ crypto: journalCrypto, objectStore: journalBarrierObjects, journal: journalBarrier, checkpointId, accountId, ownerId: fixture.ownerId, sessionId, actionId, retentionUntil: barrierRetention, source: journalSource, now: () => now });
    await journalClaimed.promise;
    now = retentionDeadline;
    journalGate.resolve();
    await expect(pendingJournal).rejects.toThrow("RETAINED_SUBJECT_RETENTION_EXPIRED");
    expect(journalBarrierCreates).toBe(0);
    expect(await journal.read(journalOperation)).toBeDefined();
    expect(await journalCrypto.isDestroyed((await journalCrypto.readSealed(journalCustody))?.keyReference ?? "checkpoint-key:missing")).toBe(true);

    // Barrier 5: an original immutable create can be ambiguous. On a retry
    // that crosses expiry after exact observation, the archive reconciles and
    // erases that original only; it cannot dispatch a replacement create.
    const uncertainSource = { kind: "promotion_evidence" as const, sourceIdentity: "barrier:uncertain", bytes: new TextEncoder().encode("barrier uncertain original") };
    const uncertainCustody = retainedSubjectCustodyId({ checkpointId, kind: uncertainSource.kind, sourceIdentity: uncertainSource.sourceIdentity });
    const uncertainCrypto = new MountedKekCheckpointCrypto({ pool, kekPath: "/fixture/kek", readFile: async () => kek, now: () => now });
    let uncertainCreates = 0, loseUncertainAck = true, pauseObserved = false;
    const observedStarted = deferred<void>(), observedGate = deferred<void>();
    const uncertainObjects: ObjectStorePort = {
      async createImmutable(value) { uncertainCreates++; const object = await objects.createImmutable(value); if (loseUncertainAck) { loseUncertainAck = false; throw new Error("OBJECT_ACK_LOST"); } return object; },
      async observeExactByKey(value) {
        const object = await objects.observeExactByKey(value);
        if (pauseObserved) { pauseObserved = false; observedStarted.resolve(); await observedGate.promise; }
        return object;
      },
      readExact: value => objects.readExact(value),
      scheduleExactDeletion: (value, deadline) => objects.scheduleExactDeletion(value, deadline),
    };
    now = retentionDeadline - 1;
    await expect(sealRetainedSubject({ crypto: uncertainCrypto, objectStore: uncertainObjects, journal, checkpointId, accountId, ownerId: fixture.ownerId, sessionId, actionId, retentionUntil: barrierRetention, source: uncertainSource, now: () => now })).rejects.toThrow("OBJECT_ACK_LOST");
    pauseObserved = true;
    // Keep the all-seven expiry path's own lost-delete acknowledgement for
    // its later assertion; this barrier only models its original create ACK.
    const loseMountedDeleteAckForExpiry = loseMountedDeleteAck;
    loseMountedDeleteAck = false;
    const pendingUncertain = sealRetainedSubject({ crypto: uncertainCrypto, objectStore: uncertainObjects, journal, checkpointId, accountId, ownerId: fixture.ownerId, sessionId, actionId, retentionUntil: barrierRetention, source: uncertainSource, now: () => now });
    await observedStarted.promise;
    now = retentionDeadline;
    observedGate.resolve();
    await expect(pendingUncertain).rejects.toThrow("RETAINED_SUBJECT_RETENTION_EXPIRED");
    expect(uncertainCreates).toBe(1);
    const uncertainStored = await uncertainCrypto.readSealed(uncertainCustody);
    if (!uncertainStored) throw new Error("BARRIER_UNCERTAIN_CUSTODY_REQUIRED");
    expect(await uncertainCrypto.isDestroyed(uncertainStored.keyReference)).toBe(true);
    const uncertainKey = `durability-subjects/${uncertainCustody}/${uncertainStored.ciphertextSha256}`;
    expect(await objects.observeExactByKey({ key: uncertainKey, checksum: uncertainStored.ciphertextSha256 })).toBeUndefined();
    loseMountedDeleteAck = loseMountedDeleteAckForExpiry;
    now = retentionDeadline - retentionMs;
    const createsBeforeExpiry = createCalls;
    now += retentionMs;
    await expect(preparer.prepare(scope)).rejects.toThrow("RETAINED_SUBJECT_RETENTION_EXPIRED");
    expect(createCalls).toBe(createsBeforeExpiry);
    now -= retentionMs;
    // The raw wire checks above reject invalid signatures/bindings. Stored
    // producer history then rejects tampering before preparation can read it.
    await expect(preparer.prepare(scope)).rejects.toThrow("OBJECT_ACK_LOST");
    await preparer.prepare(scope); // query-only reconciliation observes the original create; no replacement dispatch.
    expect(createCalls).toBe(6); // all six retained copies; lost ACK did not duplicate its subject.
    const inventory = await createProductionDurabilitySubjectRegistry(pool).inventory(scope);
    expect(inventory).toHaveLength(7);
    await runtime.end(); runtime = undefined; await source.end(); source = undefined;
    await admin.query(`CREATE DATABASE ${cloneDatabase} TEMPLATE ${sourceDatabase}`);
    await admin.query(`CREATE DATABASE ${migrationDatabase}`);
    source = new Pool({ connectionString: connection("postgres", sourceDatabase), connectionTimeoutMillis: 2_000 });
    sourceRuntime = new Pool({ connectionString: connection(role, sourceDatabase), connectionTimeoutMillis: 2_000 });
    recovered = new Pool({ connectionString: connection(role, cloneDatabase), connectionTimeoutMillis: 2_000 });
    migration = new Pool({ connectionString: connection("postgres", migrationDatabase), connectionTimeoutMillis: 2_000 });
    const recoveredPool = bindAccountingRealmPool(sqlPool(recovered), createAccountingRealm("production-real"));
    const recoveredInventory = await createProductionDurabilitySubjectRegistry(recoveredPool).inventory(scope);
    expect(recoveredInventory).toEqual(inventory);
    const recoveredJournal = new PostgresOperationJournal(recoveredPool, { namespace: "retained-subjects-postgres", scopeSha256: hex("scope") });
    const recoveredCheckpoint = new ProductionCheckpointCoordinator({ pool: recoveredPool, objectStore: effects, journal: recoveredJournal, kekPath: "/fixture/kek", readKekFile: async () => kek, now: () => now });
    const checkpointSubject = recoveredInventory.find(subject => subject.kind === "checkpoint");
    if (!checkpointSubject) throw new Error("CHECKPOINT_SUBJECT_REQUIRED");
    expect(await recoveredCheckpoint.restore({ checkpointId, accountId, sessionId })).toEqual(archive);
    const recoveredCrypto = new MountedKekCheckpointCrypto({ pool: recoveredPool, kekPath: "/fixture/kek", readFile: async () => kek, now: () => now });
    if (!source || !migration) throw new Error("RETAINED_SUBJECT_FRESH_DATABASE_REQUIRED");
    const sourcePool = sqlPool(source), sourceAuthorityPool = bindAccountingRealmPool(sqlPool(sourceRuntime), createAccountingRealm("production-real")), migrationPool = sqlPool(migration);
    // Migration capture deliberately reads the original public-history schema;
    // controller journaling and retained inventory use the least-privilege
    // production authority instead of the administrative capture connection.
    const restoreJournal = new PostgresOperationJournal(sourceAuthorityPool, { namespace: "retained-subjects-restore", scopeSha256: hex("restore-scope") });
    const retainedKeys = new Map<string, string>();
    for (const subject of recoveredInventory) if (subject.kind !== "checkpoint") {
      const stored = await recoveredCrypto.readSealed(retainedSubjectCustodyId({ checkpointId, kind: subject.kind, sourceIdentity: subject.sourceIdentity }));
      if (!stored) throw new Error("RETAINED_SUBJECT_KEY_REQUIRED");
      retainedKeys.set(subject.kind, stored.keyReference);
    }
    let mountedFences = 0, mountedRestores = 0, mountedObservations = 0, mountedCommand = "none", uploadedArchive: Uint8Array | undefined, lostRestoreAck = true;
    const noModal = async () => { throw new Error("FIXTURE_MODAL_UNUSED"); };
    const mountedWorkers = createWorkerDeploymentClients({ image: config.worker.image, workspaceRoot: PRODUCTION_WORKER_POLICY.workspaceRoot, policyVersion: PRODUCTION_WORKER_POLICY.version, modalAppName: "retained-workers", modalTags: {}, journal: createPostgresWorkerOperationJournal(recoveredJournal),
      modalSdk: { apps: { fromName: noModal }, images: { fromRegistry: noModal }, sandboxes: { create: noModal, findByName: noModal, fromId: noModal } },
      fly: { create: noModal, observe: noModal, terminate: noModal, observeTermination: noModal,
        async exec(value) {
          const [, action, archiveDigest, index, data] = value.command;
          mountedCommand = action ?? "missing";
          if (action === "fence") { mountedFences++; return { status: "completed" as const, exitCode: 0, stdout: JSON.stringify({ state: "fenced", jobId: workspaceJobId, fenceSha256: index }) }; }
          if (action === "restore-put") { uploadedArchive = new Uint8Array(Buffer.from(data ?? "", "base64")); return { status: "completed" as const, exitCode: 0, stdout: JSON.stringify({ state: "stored", archiveSha256: archiveDigest, chunk: Number(index), sha256: digest(uploadedArchive) }) }; }
          if (action === "restore") { mountedRestores++; if (lostRestoreAck) { lostRestoreAck = false; throw new Error("FIXTURE_RESTORE_ACK_LOST"); } }
          if (action === "restore-status" || action === "restore") { mountedObservations++; const bytes = uploadedArchive ?? archive; return { status: "completed" as const, exitCode: 0, stdout: JSON.stringify({ state: "restored", archiveSha256: digest(bytes), toolchainSha256: config.worker.toolchainSha256, sourceSha256: digest(canonicalJson(workspaceSource.files)), artifactFilesSha256: digest(canonicalJson(workspaceArtifact.files)), workspacePath: "/workspace/restored" }) }; }
          throw new Error("FIXTURE_UNEXPECTED_WORKER_COMMAND");
        } } });
    const mountedRuntime = createMountedFreshRestoreRuntime({ config, secrets: new MountedProductionSecretMaterial(config, { root: "/tmp/retained-subjects-no-secrets" }), google: { cloudSqlPostgres: { async observePrivateAddress() { return { status: "completed" as const, privateAddress: "127.0.0.1" }; } } }, artifactStore: objects, observeTopology: async () => ({ releaseEvidence: false }), now: () => now,
      mounts: { async openPool(input) { return input.binding === "cloudSql.restoreRecoveredRoleCredentialReference" ? { pool: recoveredPool, close: async () => undefined } : { pool: migrationPool, close: async () => undefined }; }, readKekFile: async () => kek,
        async createWorkerClients() { return { clients: mountedWorkers, flyRegion: "fixture", certification: { modalSdk: { apps: { fromName: noModal }, images: { fromRegistry: noModal }, sandboxes: { create: noModal, findByName: noModal, fromId: noModal } }, modalConfig: { appName: "retained-workers", image: config.worker.image, workspaceRoot: PRODUCTION_WORKER_POLICY.workspaceRoot, tags: { "napplet-cvm-realm": "production-real" as const }, regions: config.regions, policyVersion: PRODUCTION_WORKER_POLICY.version }, flyClient: { create: noModal, observe: noModal, terminate: noModal, observeTermination: noModal, exec: noModal }, flyConfig: { appName: "retained-workers", image: config.worker.image, region: "fixture" } } }; },
        async createWorkerRouter(input) { return new ProductionWorkerJobRouter({ workerJournal: input.workerJournal, jobJournal: input.jobJournal, executables: [{ image: config.worker.image, toolchainSha256: config.worker.toolchainSha256, clients: mountedWorkers, modalAppName: "retained-workers", flyAppName: "retained-workers" }] }); } } });
    const mounted = await mountedRuntime.open({ freshInstanceId: "fresh-retained", databaseInstanceId: cloneDatabase, migrationDatabaseInstanceId: migrationDatabase, applicationInstanceId: "application-retained", providerOperationId: "provider-retained-restore" });
    const recoveredServiceJournals = await openProductionServiceJournals({ pool: recoveredPool, servicePubkey: config.certification.serverPubkey, initialTopologySha256: config.topologySha256, requireExisting: true });
    const checkpointResolver = new ProductionWorkerOwnershipResolver({ pool: recoveredPool, policyVersion: config.worker.policyVersion, capacityJournal: recoveredServiceJournals.capacity });
    const ordinaryBridge = new ProductionWorkerBridge({
      resolver: checkpointResolver,
      workers: mountedWorkers,
      workerJournal: recoveredServiceJournals.worker,
      jobJournal: recoveredServiceJournals.job,
      requestJournal: recoveredServiceJournals.request,
      artifactStore: objects,
      toolchainSha256: config.worker.toolchainSha256,
      jobRouter: new ProductionWorkerJobRouter({ workerJournal: recoveredServiceJournals.worker, jobJournal: recoveredServiceJournals.job, executables: [{ image: config.worker.image, toolchainSha256: config.worker.toolchainSha256, clients: mountedWorkers, modalAppName: "retained-workers", flyAppName: "retained-workers" }] }),
    });
    // A receipt-finalized retained action gains only the exact checkpoint
    // reattach capability. It cannot restart ordinary model/tool generation.
    expect(await ordinaryBridge.run(workerRequest, new AbortController().signal)).toEqual({ status: "unavailable", code: "WORKER_UNAVAILABLE" });
    expect(mountedFences).toBe(0); expect(mountedRestores).toBe(0); expect(mountedObservations).toBe(0);
    try {
      expect(await checkpointResolver.resolveCheckpointWorker({ accountId, sessionId, actionId, expectedVersion: 0, policyVersion: config.worker.policyVersion, capabilityGrant: "phase-05-continuation-grant", workspaceId: `workspace:${sessionId}`, checkpointId, pauseGeneration: 1, actionVersion: 0, workspaceLineage: `workspace:${sessionId}`, leaseToken: "lease:retained:reattach" }, workerRequest)).toMatchObject({ accountId, ownerId: fixture.ownerId, intentReference: capacityIntent, capacityReference, workerOperationId });
    } catch (error) { throw new Error(`MOUNTED_CHECKPOINT_RESOLUTION:${error instanceof Error ? error.message : "UNKNOWN"}`); }
    const mountedInstance = {
      freshInstanceId: "fresh-retained", sourceInstanceId: "source-retained", databaseInstanceId: cloneDatabase, migrationDatabaseInstanceId: migrationDatabase, applicationInstanceId: "application-retained", providerOperationId: "provider-retained-restore",
      pool: mounted.pool, migrationTargetPool: mounted.migrationTargetPool, objectStore: mounted.objectStore,
      startAfterRestore: mounted.startAfterRestore, openRetainedArchive: mounted.openRetainedArchive,
      reattachOriginal: mounted.reattachOriginal, observeReattach: mounted.observeReattach,
      exerciseExpiryDeletion: mounted.exerciseExpiryDeletion, observeExpiryDeletion: mounted.observeExpiryDeletion,
      observeTopology: mounted.observeTopology,
      async cleanup() { await mounted.cleanupLocal(); return { state: "absent" as const }; },
      async observeCleanup() { return { state: "absent" as const }; },
    };
    const restore = new ProductionRestoreCertification({ sourceInstanceId: "source-retained", scope, sourcePool: sourceAuthorityPool, migrationSource: new ProductionMigrationSource({ pool: sourcePool, source: { sourceIdentity: "source-retained", serviceIdentity: hex("service"), sourceRevision: hex("revision"), schemaVersions: migrations, migrationDigests: Object.fromEntries(migrations.map(path => [path, hex(path)])), writers: [], records: [], objects: [], externalOperations: [] } }), migrationCipher: new MigrationArchiveCipher(new Uint8Array(32).fill(23)), backupStore: objects, journal: restoreJournal, provisioner: { async create() { return mountedInstance; }, async attach() { return mountedInstance; }, async observeCleanup() { return { state: "absent" as const }; } }, candidateSha256: hex("candidate"), topologySha256: hex("topology") });
    const fresh = CoreFreshInstanceSchema.parse(await restore.restore({ operationId: "restore:retained", action: "restore.create", payload: {} }));
    for (const subject of recoveredInventory) {
      const descriptor = CoreRestoreDescriptorSchema.parse(await restore.restore({ operationId: `restore:describe:${subject.kind}`, action: "restore.subject", payload: { freshInstanceId: fresh.freshInstanceId, subject, action: "describe" } }));
      const expectedStatus = subject.kind === "checkpoint" ? "reconciliation_pending" : "reattached";
      try {
        expect(await restore.restore({ operationId: `restore:reattach:${subject.kind}`, action: "restore.subject", payload: { freshInstanceId: fresh.freshInstanceId, subject, action: "reattach", archiveSha256: subject.payloadSha256, expected: descriptor.expected } })).toMatchObject({ status: expectedStatus });
      } catch (error) { throw new Error(`MOUNTED_REATTACH_${subject.kind}:${error instanceof Error ? error.message : "UNKNOWN"}:command=${mountedCommand}:fences=${mountedFences}`); }
    }
    await restore.restore({ operationId: "restore:retained", action: "restore.lose-local", payload: {} });
    for (const subject of recoveredInventory) {
      const descriptor = CoreRestoreDescriptorSchema.parse(await restore.restore({ operationId: "restore:retained", action: "restore.subject", payload: { freshInstanceId: fresh.freshInstanceId, subject, action: "describe" } }));
      await expect(restore.reconcile({ operationId: "restore:retained", kind: "restore.subject", payload: { freshInstanceId: fresh.freshInstanceId, subject, action: "reattach", archiveSha256: subject.payloadSha256, expected: descriptor.expected } })).resolves.toMatchObject({ status: "reattached" });
    }
    // The mounted runtime fences before the
    // single restore dispatch. Its lost ACK reconciles by restore-status only.
    expect(mountedFences).toBe(1); expect(mountedRestores).toBe(1); expect(mountedObservations).toBe(1);
    // Lost delete ACK is reconciled only by the fresh controller observing the
    // original intent; retry completes all six retained copies and checkpoint.
    now += retentionMs;
    await expect(restore.restore({ operationId: "restore:expiry", action: "restore.expiry", payload: { freshInstanceId: fresh.freshInstanceId } })).rejects.toThrow("DELETE_ACK_LOST");
    await expect(restore.restore({ operationId: "restore:expiry", action: "restore.expiry", payload: { freshInstanceId: fresh.freshInstanceId } })).resolves.toEqual({ expired: true, deleted: true });
    await expect(restore.reconcile({ operationId: "restore:expiry", kind: "restore.expiry", payload: { freshInstanceId: fresh.freshInstanceId } })).resolves.toEqual({ expired: true, deleted: true });
    expect(deleteCalls).toBe(7);
    expect(await effects.readExact(checkpointSubject.object)).toBeUndefined();
    expect(await recoveredCrypto.isDestroyed(sealedCheckpoint.envelope.crypto.keyReference)).toBe(true);
    expect(await recoveredCheckpoint.observeDestroyed({ checkpointId, accountId, sessionId })).toBe(true);
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
    await migration?.end(); await recovered?.end(); await runtime?.end(); await sourceRuntime?.end(); await source?.end(); await admin?.end();
    await docker(["rm", "--force", container]).catch(() => undefined);
  }
}, 120_000);
