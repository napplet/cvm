import { expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { finalizeEvent, verifyEvent } from "nostr-tools/pure";
import { Pool } from "pg";
import type { PostgresSqlPool } from "../../src/persistence/postgres-sql-funding-store";
import { bindAccountingRealmPool, createAccountingRealm } from "../../src/funding/accounting-realm";
import { FundingService } from "../../src/funding/funding-service";
import { SessionCapApprovalService } from "../../src/funding/session-cap";
import { PostgresFundingDatabase } from "../../src/persistence/postgres-funding-database";
import { PostgresSqlFundingStore } from "../../src/persistence/postgres-sql-funding-store";
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
import { createPostgresBigQueryUsageReportJournal, createPostgresWorkerOperationJournal } from "../../src/release/deployment/postgres-provider-journals";
import { createMemoryGoogleOperationJournal } from "../../src/release/deployment/google-clients";
import { googleOperationLabel } from "../../src/release/deployment/google-operation-id";
import { GOOGLE_CONTROL_PLANE_SCOPES, googleAccountScopeSha256 } from "../../src/release/deployment/google-auth";
import { createMountedBigQueryUsageReporter } from "../../src/production/mounted-authoritative-billing";
import { createWorkerDeploymentClients, PRODUCTION_WORKER_POLICY } from "../../src/release/deployment/worker-clients";
import { ProductionWorkerJobRouter } from "../../src/production/worker-job-router";
import { ProductionWorkerRequestStore } from "../../src/production/worker-request-store";
import { ProductionWorkerBridge, ProductionWorkerOwnershipResolver } from "../../src/production/worker-bridge";
import { pricedRestoreBinding } from "../../src/production/priced-restore-binding";
import { WorkerRunRequestSchema } from "../../src/phase-02/contracts";
import { StartSessionCommandSchema } from "../../src/phase-04/metered-generation-service";
import { registerProductionPricing } from "../../src/production/pricing-catalog";
import { ProductionResumePricingQuotes } from "../../src/production/resume-pricing-quotes";
import { ProductionResumePricingPreparer } from "../../src/production/resume-pricing-preparer";
import { ProductionResumeAcceptance } from "../../src/production/resume-acceptance";
import { ProductionPricedContinuationWorkers } from "../../src/production/priced-continuation-workers";
import { resumePricingMaterial } from "../fixtures/resume-pricing";
import type { CapacityReservation, ReadyCapacityPort } from "../../src/funding/funded-admission";
import { convertUsdMicrosToSats, maximumOperationCharge } from "../../src/model/price-card";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { PostgresByteaObjectStoreAdapter } from "../../src/continuity/postgres-bytea-object-store";
import { FileObjectKeyCustody, ObjectProducerBudgets, PerObjectFileCheckpointCrypto } from "../../src/production/object-retention-policy";
import { NonGooglePostgresDriver } from "../../src/production/non-google-postgres";
import { NonGoogleCoolifyDriver } from "../../src/production/non-google-coolify-driver";
import { NonGoogleSigNozDriver } from "../../src/production/non-google-signoz-driver";
import { NonGoogleFreshRestoreDriver, type NativeCommandRunner } from "../../src/production/non-google-fresh-restore-driver";
import { NonGoogleNativeCoreDriverSet } from "../../src/production/non-google-native-core-drivers";
import { createNonGoogleNativeCoreServices } from "../../src/production/non-google-core-services";
import { createNativeProductionCoreSuiteAdapters } from "../../src/release/deployment/production-core-suite-adapters";
import { createProductionReadyCapacity } from "../../src/production/worker-capacity";
import { createNonGoogleInvocationAuthorityVerifier } from "../../src/production/non-google-invocation-authority";
import { createNonGoogleAuthorizationRequestV3 } from "../../src/release/contracts";
import { openContextVmCertificationClient } from "../../src/release/deployment/contextvm-client";
import { createAuthorizationRequest, createAuthorizationReceipt } from "../../src/release/authorization";
import { PrivateKeySigner } from "@contextvm/sdk/signer";
import { validateDurabilityInventory } from "../../src/resilience/fault-harness";

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
async function closePool(pool: Pool | undefined): Promise<void> { if (pool) await pool.end(); }
const migrations = [
  "phase-03/001_funding.sql", "phase-04/001_metered_generation.sql", "phase-04/002_action_budget_lifecycle.sql",
  "phase-05/001_continuation.sql", "phase-06/001_publication.sql", "phase-03/002_production_accounting.sql",
  "phase-03/003_cashu_custody_and_identities.sql", "phase-03/004_production_rail_material_scope.sql",
  "phase-07/001_production_operation_journal.sql", "phase-07/002_production_pricing_catalog.sql",
  "phase-07/003_production_checkpoints.sql", "phase-07/005_production_session_caps.sql",
  "phase-07/008_production_account_owners.sql", "phase-07/009_production_resume_pricing_quotes.sql",
  "phase-07/010_production_priced_continuations.sql", "phase-07/011_production_priced_continuation_workers.sql",
  "phase-07/012_production_priced_continuation_restores.sql", "phase-07/013_production_priced_continuation_finalizations.sql",
  "phase-07/017_production_resume_pricing_quote_v2.sql", "phase-07/018_production_priced_continuation_cleanup_proofs.sql",
  "development/001_generation.sql", "development/002_provider_observations.sql", "development/003_artifact_preview.sql",
  "development/004_source_proposal_bindings.sql", "development/005_pending_actions.sql", "development/006_worker_results.sql",
  "development/007_chatgpt_operations.sql", "development/008_chatgpt_diagnostics.sql", "development/009_operator_publication.sql",
  "development/010_projects.sql", "development/011_publication_relays.sql", "development/012_remix_imports.sql",
  "development/013_publication_tracking.sql", "development/014_request_cost_history.sql", "development/015_revision_restore.sql",
  "development/016_usage_evidence.sql",
] as const;
const retainedSubjectMigrations = ["phase-07/014_production_durability_subjects.sql", "phase-07/015_production_publication_signed_events.sql", "phase-07/016_production_authoritative_usage_reports.sql"] as const;

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
      const existing = entries.get(value.key);
      if (existing) {
        if (existing.checksum !== value.checksum || !Buffer.from(existing.bytes).equals(Buffer.from(value.bytes))) throw new Error("GCS_OBJECT_IMMUTABLE_CONFLICT");
        return { generation: existing.generation, checksum: existing.checksum };
      }
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

test("generation-aware storage preserves an identical immutable create and rejects different bytes", async () => {
  const objects = generationAwareObjects(Date.now);
  const input = { key: "authoritative-usage/original/report.json", bytes: new TextEncoder().encode("original provider report") };
  const first = await objects.createImmutable(input);
  expect(await objects.createImmutable(input)).toEqual(first);
  await expect(objects.createImmutable({ ...input, bytes: new TextEncoder().encode("different provider report") })).rejects.toThrow("GCS_OBJECT_IMMUTABLE_CONFLICT");
  expect(await objects.readExact(first)).toEqual(input.bytes);
});

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

async function proveRetainedSubjectsPostgres(continuationKind: "legacy" | "priced") {
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
    await source.query(await Bun.file(`migrations/${retainedSubjectMigrations[2]}`).text());
    const reportRequest = "a".repeat(64), reportGrant = "b".repeat(64), reportOperation = "c".repeat(64), reportRaw = "d".repeat(64);
    await runtime.query("INSERT INTO production_real.authoritative_usage_report_capture(report_request_sha256,grant_sha256,operation_record_sha256,provider_job_id,artifact_uri,artifact_generation,raw_report_sha256,envelope_json) VALUES($1,$2,$3,$4,$5,$6,$7,$8::jsonb)", [reportRequest, reportGrant, reportOperation, "usage_original", "gs://fixture-bucket/authoritative-usage/original.json", 1, reportRaw, JSON.stringify({ grantSha256: reportGrant, rawReportSha256: reportRaw })]);
    // Runtime cannot update the immutable capture table at all; prove that
    // least privilege separately from the owner-context immutability trigger.
    await expect(runtime.query("UPDATE production_real.authoritative_usage_report_capture SET envelope_json=envelope_json WHERE report_request_sha256=$1", [reportRequest])).rejects.toThrow(/permission denied/u);
    await expect(source.query("UPDATE production_real.authoritative_usage_report_capture SET envelope_json=envelope_json WHERE report_request_sha256=$1", [reportRequest])).rejects.toThrow("AUTHORITATIVE_USAGE_REPORT_CAPTURE_IMMUTABLE");
    const usageReports = createPostgresBigQueryUsageReportJournal(new PostgresOperationJournal(pool, { namespace: "authoritative-usage-fixture", scopeSha256: hex("authoritative-usage-scope") }));
    const reportJob = { reportRequestSha256: "e".repeat(64), dryRunJobId: `usage_dry_${"e".repeat(48)}`, queryJobId: `usage_${"e".repeat(48)}`, state: "claimed" as const };
    expect((await usageReports.claim(reportJob)).claimed).toBe(true);
    expect((await usageReports.claim(reportJob)).claimed).toBe(false);
    await expect(usageReports.mark({ reportRequestSha256: reportJob.reportRequestSha256, expected: "dry_run_complete", state: "query_dispatch_intent" })).rejects.toThrow("BIGQUERY_USAGE_REPORT_JOURNAL_CONFLICT");
    expect(await usageReports.mark({ reportRequestSha256: reportJob.reportRequestSha256, expected: "claimed", state: "dry_run_dispatch_intent" })).toMatchObject({ state: "dry_run_dispatch_intent", queryJobId: reportJob.queryJobId });
    let billingNow = Date.parse("2029-01-01T00:00:00.000Z");
    const billingOperationId = "cloud-run-billing";
    const billingAccountScope = await googleAccountScopeSha256({
      projectId: "project-12345", quotaProjectId: "project-12345", principal: "release@example.com", scopes: GOOGLE_CONTROL_PLANE_SCOPES,
    });
    const billingGoogleJournal = createMemoryGoogleOperationJournal([{
      operationId: googleOperationLabel(billingOperationId),
      resource: "projects/project-12345/locations/us-central1/services/release",
      requestSha256: hex("billing-google-request"), contentSha256: hex("billing-google-content"), state: "completed",
      resourceUid: "billing-resource-uid", createTime: new Date(billingNow - 60_000).toISOString(), owned: true,
    }]);
    const billingObjects = generationAwareObjects(() => billingNow);
    let reportPosts = 0;
    const mountedReporter = createMountedBigQueryUsageReporter({
      configuration: {
        version: 1, detailedExportTable: "project-12345.billing_export.gcp_billing_export_resource_v1", location: "US",
        maximumBytesBilled: "1000000", reportQueryMaximumCostMicros: 10, reportQueryPriceSourceSha256: hex("billing-price-source"),
        reportQueryMicrosPerByteNumerator: "1", reportQueryMicrosPerByteDenominator: "1000000", collectorSha256: hex("billing-collector"),
        maximumIntervalMs: 60_000,
      },
      projectId: "project-12345", quotaProjectId: "project-12345", principal: "release@example.com", accountScopeSha256: billingAccountScope,
      tokenSource: { async getAccessToken() { return { token: "fixture-bearer-token-which-is-never-logged", projectId: "project-12345", quotaProjectId: "project-12345", principal: "release@example.com", scopes: GOOGLE_CONTROL_PLANE_SCOPES, accountScopeSha256: billingAccountScope, expiresAtMs: billingNow + 70_000 }; } },
      googleJournal: billingGoogleJournal,
      billingJournal: new PostgresOperationJournal(pool, { namespace: "mounted-authoritative-usage-fixture", scopeSha256: hex("mounted-authoritative-usage-scope") }),
      pool, objects: billingObjects, bucket: "retained-subject-fixture", now: () => billingNow,
      fetch: async (url, init) => {
        if (init.method === "POST") {
          reportPosts++;
          const payload = JSON.parse(String(init.body));
          return new Response(JSON.stringify({ jobReference: payload.jobReference, statistics: { totalBytesProcessed: "10" } }), { headers: { "content-type": "application/json" } });
        }
        const jobId = new URL(url).pathname.split("/").at(-1);
        return new Response(JSON.stringify({ jobComplete: true, jobReference: { jobId, location: "US" }, totalBytesProcessed: "10", rows: [{ f: [{ v: "1.000000" }, { v: "-0.100000" }] }] }), { headers: { "content-type": "application/json" } });
      },
    });
    const billingCapture = {
      operation: { provider: "cloud_run", operationId: billingOperationId }, operationRecordSha256: hex("billing-operation-record"),
      resourceIdentitySha256: hex("billing-resource-identity"), candidateSha256: hex("billing-candidate"), authorizationRequestSha256: hex("billing-request"),
      authorizationReceiptSha256: hex("billing-receipt"), accountScopeSha256: billingAccountScope, projectScopeSha256: hex("billing-project-scope"),
      billingObservation: {
        version: 1, allowedReportOrigin: "https://bigquery.googleapis.com",
        detailedExportTable: "project-12345.billing_export.gcp_billing_export_resource_v1", location: "US",
        maximumBytesBilled: "1000000", reportQueryMaximumCostMicros: 10, reportQueryPriceSourceSha256: hex("billing-price-source"),
        reportQueryMicrosPerByteNumerator: "1", reportQueryMicrosPerByteDenominator: "1000000", collectorSha256: hex("billing-collector"),
        maximumIntervalMs: 60_000, expiresAtMs: billingNow + 10_000,
      },
    };
    const concurrentBilling = await Promise.all([mountedReporter.capture(billingCapture), mountedReporter.capture(billingCapture)]);
    const capturedBilling = concurrentBilling.find(value => value.status === "captured") ?? await mountedReporter.capture(billingCapture);
    expect(capturedBilling.status).toBe("captured");
    if (capturedBilling.status !== "captured") throw new Error("MOUNTED_BILLING_CAPTURE_REQUIRED");
    expect(capturedBilling.grant.originalScope.resourceName).toBe("projects/project-12345/locations/us-central1/services/release");
    expect(capturedBilling.envelope.rawArtifact.generation).toBe("1");
    expect(reportPosts).toBe(2);
    billingNow += 1_000;
    const resumedBilling = await mountedReporter.capture(billingCapture);
    expect(resumedBilling).toEqual(capturedBilling);
    expect(reportPosts).toBe(2);
    expect(await mountedReporter.readArtifact(capturedBilling.envelope.rawArtifact)).toEqual(new TextEncoder().encode(JSON.stringify({ jobComplete: true, jobReference: { jobId: capturedBilling.envelope.providerJobId, location: "US" }, totalBytesProcessed: "10", rows: [{ f: [{ v: "1.000000" }, { v: "-0.100000" }] }] })));
    expect((await runtime.query("SELECT report_request_sha256 FROM production_real.authoritative_usage_report_capture WHERE report_request_sha256=$1", [capturedBilling.grant.reportRequestSha256])).rowCount).toBe(1);
    // The V2 SQL claim guard uses PostgreSQL's real clock, so its price
    // authority must be minted on that same timeline. Later expiry checks
    // explicitly advance this retained-subject fixture clock independently.
    let now = Date.now();
    const retentionMs = 30 * 86_400_000, fixture = originalFixture(now), kek = Buffer.alloc(32, 17).toString("base64");
    expect(verifyEvent(wire(fixture.ownerEvent))).toBe(true);
    expect(verifyEvent(wire({ ...fixture.ownerEvent, content: "tampered" }))).toBe(false);
    const originalPricing = await resumePricingMaterial(now, "retained-profile", "500");
    const originalMaximumUsdMicros = maximumOperationCharge(originalPricing);
    const originalMaximumSat = convertUsdMicrosToSats({ usdMicros: Number(originalMaximumUsdMicros), conversion: originalPricing.conversion, at: new Date(now).toISOString() }).amount;
    const initialFundedSat = (BigInt(originalMaximumSat) - 1n).toString(), remainingAfterOriginalAction = Number(BigInt(initialFundedSat) - 1n);
    expect({ originalMaximumUsdMicros, originalMaximumSat, initialFundedSat, remainingAfterOriginalAction }).toEqual({ originalMaximumUsdMicros: "1020", originalMaximumSat: "11", initialFundedSat: "10", remainingAfterOriginalAction: 9 });
    const fundingDatabase = new PostgresFundingDatabase(pool, { realm: "production-real" });
    const funding = new FundingService(fundingDatabase.funding);
    const credited = await funding.execute({ principal: { pubkey: fixture.ownerId }, kind: "credit_settlement", idempotencyKey: "retained-fixture-credit", policyVersion: "fixture", protocolVersion: "fixture", payload: { settlement: { topUpId: "retained-fixture", rail: "lightning", unit: "sat", amount: initialFundedSat, externalReference: "fixture:external", settlementReference: "fixture:settlement", verifiedAt: new Date(now).toISOString() } } });
    const accountId = credited.accountId, sessionId = `session:${digest(canonicalJson({ accountId, key: "retained-reattach" })).slice(0, 24)}`, actionId = "action:retained", artifactId = `artifact:${digest(fixture.artifact)}`, checkpointId = "checkpoint:retained";
    // Isolated pricing source records are registered through the same catalog
    // used by V2 preparation. They are not a quote, provider, or release claim.
    await registerProductionPricing({ pool, ...originalPricing });
    const admitted = await funding.execute({ principal: { pubkey: fixture.ownerId }, kind: "funded_admission", idempotencyKey: "retained-fixture-admission", policyVersion: "fixture", protocolVersion: "fixture", payload: { requestedCap: initialFundedSat, unit: "sat", capacity: { usable: true, reference: "capacity:fixture" } } });
    if (admitted.status !== "accepted" || admitted.accountId !== accountId || admitted.approvedCap !== initialFundedSat) throw new Error("RETAINED_FIXTURE_ADMISSION_REQUIRED");
    const admissionReference = admitted.reference;
    await source.query("INSERT INTO production_real.metered_sessions(id,account_id,admission_reference,profile_id,price_card_id,version,state) VALUES($1,$2,$3,$4,$5,0,'prepared')", [sessionId, accountId, admissionReference, originalPricing.profile.id, originalPricing.card.id]);
    await source.query("INSERT INTO production_real.action_budget_reservations(reservation_id,account_id,admission_reference,idempotency_key,fingerprint_sha256,reservation_reference,amount,unit,state) VALUES('reservation:retained',$1,$2,'retained-action',$3,'budget:retained',1,'sat','authorized')", [accountId, admissionReference, hex("action-fingerprint")]);
    const actionSeed = await source.connect();
    try {
      await actionSeed.query("BEGIN; SET CONSTRAINTS ALL DEFERRED");
      await actionSeed.query("INSERT INTO production_real.metered_actions(id,account_id,session_id,idempotency_key,fingerprint,expected_session_version,budget_reference,reservation_sat,operation_id,profile_id,price_card_id,state,terminal_result,evidence_reference,settled_at,admission_reference,receipt_charge,provider_receipt_reference,session_version,artifact_version,remaining_cap_sat,remaining_balance_sat,artifact_id,workspace_lineage,checkpoint_reference,snapshot_reference,validation_evidence_reference,validation_report_reference) VALUES($1,$2,$3,'retained-action',$4,0,'budget:retained',1,'provider:retained',$5,$6,'verified',$7,'evidence:action',clock_timestamp(),$10,1,'receipt-original',0,1,$11,$11,$8,$9,'checkpoint:retained','snapshot:retained',('verification:' || $8),NULL)", [actionId, accountId, sessionId, hex("action-fingerprint"), originalPricing.profile.id, originalPricing.card.id, { status: "verified", releaseEvidence: false }, artifactId, `workspace:${sessionId}`, admissionReference, remainingAfterOriginalAction]);
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
    let workspaceJobId = digest(canonicalJson(workspaceSource));
    const workspaceFile = new TextEncoder().encode("<main>retained workspace</main>");
    const commandEvidence = Array.from({ length: 8 }, () => ({ argv: ["fixture"], exitCode: 0 as const, stdout: "", stderr: "", elapsedMs: 0 }));
    const workspaceArtifact = { version: 1 as const, jobId: workspaceJobId, proposalSha256: sourceProposalSha256, toolchainSha256: config.worker.toolchainSha256, files: [{ path: "index.html", bytesBase64: Buffer.from(workspaceFile).toString("base64"), sha256: digest(workspaceFile), size: workspaceFile.byteLength }], commandEvidence };
    const archive = new TextEncoder().encode(canonicalJson({ version: 1, source: workspaceSource, artifact: workspaceArtifact, toolchainSha256: config.worker.toolchainSha256 }));
    const archiveSha256 = digest(archive);
    const manifest = { checkpointId, accountId, sessionId, pauseGeneration: 1, sessionVersion: 0, actionVersion: 0, artifactVersion: 1, workspaceVersion: 0, workspaceLineage: `workspace:${sessionId}`, action: { actionId, operationId: "provider:retained", ledgerReference: admissionReference, pendingActionReference: "pending:retained", idempotencyKey: "retained-reattach" }, archiveSha256, inventory: ["harness_state", "workspace", "artifact_lineage", "validation_evidence", "financial_action", "pending_action", "compatibility_metadata"], evidenceSha256: hex("checkpoint-evidence"), compatibility: { policyVersion: "fixture-policy", modelIdentity: originalPricing.profile.id, nappletSdkIdentity: originalPricing.card.id, toolchainIdentity: config.worker.toolchainSha256 }, retentionUntil: new Date(now + retentionMs).toISOString() };
    const journal = new PostgresOperationJournal(pool, { namespace: "retained-subjects-postgres", scopeSha256: hex("scope") });
    const artifactRequest = { sessionId, actionId, expectedVersion: 0, policyVersion: "fixture", capabilityGrant: "phase-04-coordinator-grant", workspaceId: "workspace:retained", idea: "Build one focused retained-subject fixture." };
    const artifactResult = { status: "completed" as const, code: "WORKER_PROPOSALS_VALIDATED" as const, events: [{ kind: "progress" as const, turn: 1, detail: "fixture artifact verified" }], artifact: { sessionId, actionId, expectedVersion: 0, policyVersion: "fixture", capabilityGrant: "phase-04-coordinator-grant", workspaceId: "workspace:retained", artifactId, purpose: { kind: "focused" as const, statements: ["one retained-subject fixture"] }, surface: { hasBackend: false as const, hasSecondPurpose: false as const, serviceWorker: false as const, dynamicAuthority: false as const }, dependencies: { appOwnedSignerOrRelay: false as const, privateNappletImport: false as const }, capabilities: { declaredHard: [], observedDomains: [], optionalIntentPresenceRead: false, intentUsedThroughSdk: false }, upstream: { scanner: { verdict: "pass" as const, checkId: "upstream:fixture-scanner" }, conformance: { verdict: "pass" as const, checkId: "upstream:fixture-conformance" } } } };
    const persistedArtifact = await new ProductionWorkerArtifactStore({ journal, objects, toolchainSha256: hex("toolchain") }).persist({ request: artifactRequest, accountId, ownerId: fixture.ownerId, bytes: fixture.artifact, scannerReportSha256: hex("scanner"), conformanceReportSha256: hex("conformance"), result: artifactResult });
    const artifactReference = persistedArtifact.reference;
    const checkpoint = new ProductionCheckpointCoordinator({ pool, objectStore: objects, journal, kekPath: "/fixture/kek", readKekFile: async () => kek, now: () => now });
    const pauseIntent = { accountId, sessionId, idempotencyKey: "retained-reattach", fingerprint: hex("retained-reattach"), reference: "pending:retained", actionKind: "start_session" as const, boundedPayloadHash: digest(canonicalJson({ idea: "Build one focused retained-subject fixture." })), expectedSessionVersion: 0, expectedArtifactVersion: 1, policyVersion: "fixture-policy", priceCardId: originalPricing.card.id, profileId: originalPricing.profile.id, toolchainId: config.worker.toolchainSha256, actionMaximum: originalMaximumSat, admissionReference };
    const retainedCommand = StartSessionCommandSchema.parse({ principal: { pubkey: fixture.ownerId }, admissionReference: pauseIntent.admissionReference,
      idempotencyKey: pauseIntent.idempotencyKey, expectedVersion: 0, maximum: originalMaximumSat, policyVersion: pauseIntent.policyVersion,
      idea: "Build one focused retained-subject fixture." });
    // The source worker is paused because its immediately spendable balance
    // is exhausted. The later V2 acceptance still revalidates the original
    // held cap and quote inside its own serializable transaction.
    const pause = await new ContinuationService({ store: fundingDatabase.continuationFunding, includeAdmissionHold: false,
      pendingCommands: checkpoint.pendingCommands, clock: { nowMs: () => now } }).pauseForFunding({ intent: pauseIntent, command: retainedCommand });
    if (!pause) throw new Error("RETAINED_SUBJECT_PAUSE_REQUIRED");
    await funding.execute({ principal: { pubkey: fixture.ownerId }, kind: "credit_settlement", idempotencyKey: "retained-fixture-topup", policyVersion: "fixture", protocolVersion: "fixture", payload: { settlement: { topUpId: "retained-fixture-topup", rail: "lightning", unit: "sat", amount: "1", externalReference: "fixture:topup", settlementReference: "fixture:topup", verifiedAt: new Date(now).toISOString() } } });
    const capApproval = await new SessionCapApprovalService(fundingDatabase.funding).approve({ principal: { pubkey: fixture.ownerId }, sessionId, admissionReference,
      idempotencyKey: "retained-fixture-cap-approval", expectedApprovedCap: initialFundedSat, maximum: originalMaximumSat, unit: "sat", policyVersion: "fixture", protocolVersion: "fixture" }, { consentReference: `nostr:${hex("retained-cap-consent")}` });
    expect(capApproval).toMatchObject({ approvedCap: originalMaximumSat, heldAmount: originalMaximumSat });
    const paused = await fundingDatabase.continuationFunding.findContinuationPause(accountId, sessionId, 1);
    if (!paused?.liveLeaseToken) throw new Error("RETAINED_SUBJECT_LIVE_LEASE_REQUIRED");
    await fundingDatabase.continuationFunding.transact(accountId, transaction => transaction.beginDeadlineCheckpoint({ sessionId, pauseGeneration: 1, liveLeaseToken: paused.liveLeaseToken! }));
    const sealedCheckpoint = await checkpoint.seal({ ...manifest, archive } satisfies CheckpointSealRequest);
    await fundingDatabase.continuationFunding.transact(accountId, transaction => transaction.commitDeadlineCheckpoint({ accountId, sessionId, pauseGeneration: 1, checkpointId, expectedSessionVersion: 0, expectedArtifactVersion: 1, manifestReference: `manifest:${sealedCheckpoint.envelope.manifestSha256}`, objectKey: sealedCheckpoint.envelope.object.key, objectGeneration: String(sealedCheckpoint.envelope.object.generation), objectChecksum: sealedCheckpoint.envelope.object.checksum, keyReference: sealedCheckpoint.envelope.crypto.keyReference, compatibilityIdentity: digest(canonicalJson(manifest.compatibility)), checkpointCommittedAtMs: now }));
    let continuation: Readonly<{ kind: "legacy" | "priced"; actionId: string; leaseToken: string; allocationIntentReference: string }>;
    let capacityIntent: string, capacityReference: string, workerOperationId: string, workerDeadline: number, workerLeaseSha256: string;
    if (continuationKind === "legacy") {
      await fundingDatabase.continuationFunding.transact(accountId, transaction => transaction.claimResume({ accountId, sessionId, checkpointId, idempotencyKey: "retained-reattach", fingerprint: hex("retained-reattach-claim"), pendingFingerprint: pauseIntent.fingerprint, expectedCheckpointVersion: 1, expectedSessionVersion: 0, nowMs: now, newLeaseToken: "lease:retained:reattach", allocationIntentReference: "allocation:retained", actionId, operationId: "operation:retained-reattach", actionBudgetReference: "budget:retained" }));
      capacityIntent = `capacity-intent:${hex("retained-capacity-intent")}`; capacityReference = `capacity:${hex("retained-capacity")}`;
      workerOperationId = `capacity-${hex("retained-worker").slice(0, 40)}`; workerDeadline = now + 1_200_000; workerLeaseSha256 = hex("retained-worker-lease");
      await source.query("INSERT INTO production_real.capacity_intents(intent_id,account_id,idempotency_key,fingerprint_sha256,intent_reference,capacity_reference,expires_at,state) VALUES('capacity:retained',$1,'retained-capacity',$2,$3,$4,to_timestamp($5 / 1000.0),'available')", [accountId, hex("retained-capacity-fingerprint"), capacityIntent, capacityReference, workerDeadline]);
      await source.query("INSERT INTO production_real.continuation_worker_allocations(checkpoint_id,account_id,session_id,action_id,allocation_intent_reference,capacity_intent_reference,capacity_reference,state) VALUES($1,$2,$3,$4,'allocation:retained',$5,$6,'available')", [checkpointId, accountId, sessionId, actionId, capacityIntent, capacityReference]);
      continuation = { kind: "legacy", actionId, leaseToken: "lease:retained:reattach", allocationIntentReference: "allocation:retained" };
    } else {
      const fundingStore = new PostgresSqlFundingStore(pool);
      const resumeQuotes = new ProductionResumePricingQuotes(pool);
      const vertexJournal = new PostgresOperationJournal(pool, { namespace: "retained-subjects-vertex", scopeSha256: hex("vertex-scope") });
      const originalOperationId = `operation:${digest(canonicalJson({ accountId, key: pauseIntent.idempotencyKey, profile: pauseIntent.profileId })).slice(0, 24)}`;
      await vertexJournal.claim(`vertex-generation-settlement:${originalOperationId}`, digest(canonicalJson({ accountId, operationId: originalOperationId })), { accountId, operationId: originalOperationId, conversion: originalPricing.conversion, acceptedAt: new Date(now).toISOString(), maximumUsdMicros: originalMaximumUsdMicros });
      const v2Preparer = new ProductionResumePricingPreparer({ pool, store: fundingStore, quotes: resumeQuotes, checkpoint, vertexJournal, currentPricing: originalPricing,
        compatibility: { policyVersion: pauseIntent.policyVersion, acceptedToolchains: [pauseIntent.toolchainId] }, now: () => now });
      const v2Acceptance = new ProductionResumeAcceptance({ pool, quotes: resumeQuotes, preparer: v2Preparer, now: () => now });
      let v2Authority: Awaited<ReturnType<typeof v2Preparer.loadAuthority>>;
      try {
        v2Authority = await v2Preparer.loadAuthority({ principal: { id: accountId }, sessionId, checkpointId, expectedSessionVersion: 0,
          expectedCheckpointVersion: 1, idempotencyKey: "prepare:retained-mounted" });
      } catch (error) {
        throw new Error(`RETAINED_V2_AUTHORITY_REQUIRED:${error instanceof Error ? error.message : "UNKNOWN"}`);
      }
      expect(v2Authority).toMatchObject({ context: { accountId, sessionId, checkpointId, originalOperationId, originalCommandMaximum: retainedCommand.maximum } });
      const preparedV2 = await v2Preparer.prepare({ principal: { id: accountId }, sessionId, checkpointId, expectedSessionVersion: 0, expectedCheckpointVersion: 1, idempotencyKey: "prepare:retained-mounted" });
      if (preparedV2.status !== "quoted") throw new Error(`RETAINED_V2_QUOTE_REQUIRED:${preparedV2.code}`);
      // The original 11-sat command remains immutable. The real active cap has
      // one authorized original sat, so V2 derives a 10-sat profile envelope
      // and binds that exact reduced provider ceiling to the new approval.
      expect(preparedV2.pricing.maximumSat).toBe("10");
      const storedV2Quote = await resumeQuotes.findReference(accountId, preparedV2.quoteReference);
      if (!storedV2Quote) throw new Error("RETAINED_V2_STORED_QUOTE_REQUIRED");
      expect(storedV2Quote.schemaVersion).toBe("resume-pricing-quote-v2");
      if (storedV2Quote.schemaVersion !== "resume-pricing-quote-v2") throw new Error("RETAINED_V2_LINEAGE_REQUIRED");
      expect(storedV2Quote.sourceProfile).toEqual(originalPricing.profile);
      expect(storedV2Quote.sourceCard).toEqual(originalPricing.card);
      expect(storedV2Quote.pricing.profile.id).toMatch(/^resume-derived:[a-f0-9]{64}$/u);
      expect(storedV2Quote.pricing.card.id).toMatch(/^resume-derived-card:[a-f0-9]{64}$/u);
      expect(storedV2Quote.pricing.profile.priceCardId).toBe(storedV2Quote.pricing.card.id);
      expect(storedV2Quote.pricing.profile.maximumUnits.every((unit, index) => BigInt(unit.units) <= BigInt(originalPricing.profile.maximumUnits[index]!.units))).toBeTrue();
      expect((await source.query("SELECT count(*)::int AS count FROM production_real.model_profile_versions WHERE id=$1", [storedV2Quote.pricing.profile.id])).rows[0].count).toBe(1);
      expect((await source.query("SELECT count(*)::int AS count FROM production_real.price_card_versions WHERE id=$1 AND profile_id=$2", [storedV2Quote.pricing.card.id, storedV2Quote.pricing.profile.id])).rows[0].count).toBe(1);
      const v2Resume = { principal: { id: accountId }, sessionId, checkpointId, expectedSessionVersion: 0, expectedCheckpointVersion: 1, idempotencyKey: "resume:retained-mounted", approvePendingAction: true,
        capApprovalReference: pauseIntent.admissionReference, pendingAction: preparedV2.pendingAction,
        pricingApproval: { quoteReference: preparedV2.quoteReference, quoteSha256: preparedV2.quoteSha256, maximumSat: preparedV2.pricing.maximumSat } };
      const v2Claim = (await v2Acceptance.claim(v2Resume)).claim;
      expect(v2Claim.quote.maximumSat).toBe("10");
      await expect(fundingStore.transact(accountId, transaction => transaction.reserveActionBudget({ accountId, admissionReference,
        idempotencyKey: "retained-v2-unapproved-unit", fingerprint: hex("retained-v2-unapproved-unit"), reference: "budget:retained-v2-unapproved-unit", amount: 1n }))).rejects.toThrow("ACTION_BUDGET_EXCEEDS_APPROVED_CAP");
      const readyCapacity = new Map<string, CapacityReservation>();
      const v2Capacity: ReadyCapacityPort = { async reserveNow(value) { const reference = `capacity:${digest(canonicalJson(value))}`, expiresAt = new Date(now + 1_200_000).toISOString(); const ready: CapacityReservation = { status: "available", reference, expiresAt, usable: true, ready: { intentReference: value.intentReference, leaseReference: reference, sessionBindingDigest: value.expectedSessionBindingDigest, imageDigest: `sha256:${config.worker.image.split("@sha256:")[1]!}`, readinessProbeDigest: `sha256:${hex("retained-ready")}`, readyMonotonicMs: 1 } }; readyCapacity.set(value.intentReference, ready); return ready; }, async observe(value) { return readyCapacity.get(value.intentReference) ?? { status: "unknown" }; }, async release() { throw new Error("RETAINED_V2_RELEASE_NOT_EXPECTED"); } };
      const v2Workers = new ProductionPricedContinuationWorkers({ pool, acceptance: v2Acceptance, capacity: v2Capacity, now: () => now });
      const allocation = await v2Workers.allocate(accountId, v2Resume.idempotencyKey);
      if (allocation.status !== "available") throw new Error("RETAINED_V2_CAPACITY_REQUIRED");
      const workerIntent = (await v2Acceptance.claimWorker(accountId, v2Resume.idempotencyKey)).workerIntent;
      capacityIntent = workerIntent.capacityIntentReference; capacityReference = allocation.allocation.capacityReference;
      workerOperationId = `capacity-${digest(`${capacityIntent}:${workerIntent.sessionBindingDigest}`).slice(0, 40)}`; workerDeadline = Date.parse(allocation.allocation.expiresAt); workerLeaseSha256 = workerIntent.sessionBindingDigest.slice("sha256:".length);
      continuation = { kind: "priced", actionId: v2Claim.actionId, leaseToken: v2Claim.leaseToken, allocationIntentReference: v2Claim.allocationIntentReference };
    }
    const serviceJournals = await openProductionServiceJournals({ pool, servicePubkey: config.certification.serverPubkey, initialTopologySha256: config.topologySha256 });
    const workerRecords = createPostgresWorkerOperationJournal(serviceJournals.worker);
    const workerRequestSha256 = hex("retained-worker-request");
    await workerRecords.claim({ operationId: workerOperationId, requestSha256: workerRequestSha256, resourceName: workerOperationId, provider: "fly", appName: "retained-workers", policyVersion: PRODUCTION_WORKER_POLICY.version, image: config.worker.image, sessionLeaseSha256: workerLeaseSha256, toolchainSha256: config.worker.toolchainSha256, providerDeadlineEpochMs: workerDeadline, createdAtMs: Date.now() });
    await workerRecords.update({ operationId: workerOperationId, requestSha256: workerRequestSha256, resourceId: "retained-worker-machine", state: "reconciled", providerCreatedAtMs: Date.now() });
    await serviceJournals.capacity.claim(`capacity-intent:${digest(capacityIntent)}`, digest(canonicalJson({ capacityIntent, capacityReference, workerOperationId })), { intentReference: capacityIntent, reference: capacityReference, workerOperationId, provider: "fly", deadlineEpochMs: workerDeadline });
    const workerRequest = WorkerRunRequestSchema.parse({ sessionId, actionId: continuation.actionId, expectedVersion: 0, policyVersion: config.worker.policyVersion, capabilityGrant: "phase-04-coordinator-grant", workspaceId: `workspace:${sessionId}`, sourceProposalReference: `proposal:sha256:${sourceProposalSha256}`, sourceProposalSha256, sourceProposalFiles: workspaceFiles });
    await new ProductionWorkerRequestStore(serviceJournals.request).persist(workerRequest);
    // The retained archive remains the original workspace bytes, while the
    // cloned worker fence must address the exact accepted continuation action.
    // Persist that V1/V2-specific original job tuple through the real journal;
    // it is not a receipt or a replacement worker admission.
    const resumedWorkspaceSource = { ...workspaceSource, actionId: continuation.actionId };
    workspaceJobId = digest(canonicalJson(resumedWorkspaceSource));
    const jobKey = `worker-build:${digest(canonicalJson({ sessionId, actionId: continuation.actionId, expectedVersion: 0 }))}`;
    await serviceJournals.job.claim(jobKey, digest(canonicalJson(workerRequest)), { workerOperationId, workerResourceId: "retained-worker-machine", leaseSha256: workerLeaseSha256, jobId: workspaceJobId, requestBody: canonicalJson(resumedWorkspaceSource), deadlineEpochMs: resumedWorkspaceSource.deadlineEpochMs });
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

    // Barrier 3: the final custody insert uses a second SQL connection after
    // the read-only identity lookup. Crossing expiry after that connection is
    // acquired must not commit a custody row, audit row, intent, or object.
    const insertSource = { kind: "sealed_artifact" as const, sourceIdentity: "barrier:final-insert", bytes: new TextEncoder().encode("barrier final insert original") };
    const insertCustody = retainedSubjectCustodyId({ checkpointId, kind: insertSource.kind, sourceIdentity: insertSource.sourceIdentity });
    const insertOperation = `retained-object:${digest(canonicalJson({ checkpointId, kind: insertSource.kind, sourceIdentity: insertSource.sourceIdentity })).slice(0, 48)}`;
    let insertConnections = 0, insertCreates = 0;
    const finalInsertPool: PostgresSqlPool = {
      async connect() {
        const client = await pool.connect();
        insertConnections++;
        if (insertConnections === 2) now = retentionDeadline;
        return client;
      },
    };
    const finalInsertObjects: ObjectStorePort = {
      async createImmutable(value) { insertCreates++; return objects.createImmutable(value); },
      observeExactByKey: value => objects.observeExactByKey(value), readExact: value => objects.readExact(value),
      scheduleExactDeletion: (value, deadline) => objects.scheduleExactDeletion(value, deadline),
    };
    const finalInsertCrypto = new MountedKekCheckpointCrypto({ pool: finalInsertPool, kekPath: "/fixture/kek", readFile: async () => kek, now: () => now });
    now = retentionDeadline - 1;
    await expect(sealRetainedSubject({ crypto: finalInsertCrypto, objectStore: finalInsertObjects, journal, checkpointId, accountId, ownerId: fixture.ownerId, sessionId, actionId, retentionUntil: barrierRetention, source: insertSource, now: () => now })).rejects.toThrow("RETAINED_SUBJECT_RETENTION_EXPIRED");
    expect(insertConnections).toBe(2);
    expect(insertCreates).toBe(0);
    expect(await finalInsertCrypto.readSealed(insertCustody)).toBeUndefined();
    expect(Number((await runtime.query("SELECT count(*)::int AS count FROM production_real.checkpoint_crypto_audit WHERE checkpoint_id=$1", [insertCustody])).rows[0]!.count)).toBe(0);
    expect(await journal.read(insertOperation)).toBeUndefined();

    // The database predicate is separately authoritative: an injected clock
    // may be stale-future while PostgreSQL's actual clock has passed this
    // retained deadline. The insert still yields no custody/audit/intent.
    const serverRetention = "2020-01-01T00:00:00.000Z", serverClock = Date.parse("2019-12-31T23:59:59.999Z");
    const serverSource = { kind: "attestation" as const, sourceIdentity: "barrier:server-clock", bytes: new TextEncoder().encode("barrier server clock original") };
    const serverCustody = retainedSubjectCustodyId({ checkpointId, kind: serverSource.kind, sourceIdentity: serverSource.sourceIdentity });
    const serverOperation = `retained-object:${digest(canonicalJson({ checkpointId, kind: serverSource.kind, sourceIdentity: serverSource.sourceIdentity })).slice(0, 48)}`;
    const serverCrypto = new MountedKekCheckpointCrypto({ pool, kekPath: "/fixture/kek", readFile: async () => kek, now: () => serverClock });
    await expect(sealRetainedSubject({ crypto: serverCrypto, objectStore: objects, journal, checkpointId, accountId, ownerId: fixture.ownerId, sessionId, actionId, retentionUntil: serverRetention, source: serverSource, now: () => serverClock })).rejects.toThrow("RETAINED_SUBJECT_RETENTION_EXPIRED");
    expect(await serverCrypto.readSealed(serverCustody)).toBeUndefined();
    expect(Number((await runtime.query("SELECT count(*)::int AS count FROM production_real.checkpoint_crypto_audit WHERE checkpoint_id=$1", [serverCustody])).rows[0]!.count)).toBe(0);
    expect(await journal.read(serverOperation)).toBeUndefined();

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
      if (continuation.kind === "priced") {
        const v2Restore = pricedRestoreBinding({ accountId, sessionId, actionId: continuation.actionId, expectedVersion: 0, policyVersion: config.worker.policyVersion,
          capabilityGrant: "phase-05-continuation-grant", workspaceId: `workspace:${sessionId}`, checkpointId, pauseGeneration: 1, actionVersion: 0,
          workspaceLineage: `workspace:${sessionId}`, leaseToken: continuation.leaseToken, resumeClaim: continuation.allocationIntentReference, archiveSha256 });
        expect(await checkpointResolver.resolvePricedRestore(v2Restore.metadata, workerRequest)).toMatchObject({ accountId, ownerId: fixture.ownerId, intentReference: capacityIntent, capacityReference, workerOperationId });
        await expect(checkpointResolver.resolvePricedRestore({ ...v2Restore.metadata, leaseToken: "priced-resume-lease:foreign" }, workerRequest)).rejects.toThrow("PRODUCTION_PRICED_RESTORE_BINDING_DENIED");
      } else {
        expect(await checkpointResolver.resolveCheckpointWorker({ accountId, sessionId, actionId: continuation.actionId, expectedVersion: 0, policyVersion: config.worker.policyVersion, capabilityGrant: "phase-05-continuation-grant", workspaceId: `workspace:${sessionId}`, checkpointId, pauseGeneration: 1, actionVersion: 0, workspaceLineage: `workspace:${sessionId}`, leaseToken: continuation.leaseToken }, workerRequest)).toMatchObject({ accountId, ownerId: fixture.ownerId, intentReference: capacityIntent, capacityReference, workerOperationId });
      }
    } catch (error) { throw new Error(`MOUNTED_${continuation.kind.toUpperCase()}_CHECKPOINT_RESOLUTION:${error instanceof Error ? error.message : "UNKNOWN"}`); }
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
    const deletesBeforeAllSevenExpiry = deleteCalls;
    now += retentionMs;
    await expect(restore.restore({ operationId: "restore:expiry", action: "restore.expiry", payload: { freshInstanceId: fresh.freshInstanceId } })).rejects.toThrow("DELETE_ACK_LOST");
    await expect(restore.restore({ operationId: "restore:expiry", action: "restore.expiry", payload: { freshInstanceId: fresh.freshInstanceId } })).resolves.toEqual({ expired: true, deleted: true });
    await expect(restore.reconcile({ operationId: "restore:expiry", kind: "restore.expiry", payload: { freshInstanceId: fresh.freshInstanceId } })).resolves.toEqual({ expired: true, deleted: true });
    expect(deleteCalls).toBe(deletesBeforeAllSevenExpiry + 7);
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
    /* This is deliberately a second, isolated authority: it reuses only the
     * already-verified original records, never the prior fixture's registry
     * rows or object adapter. The native chain must materialize its own seven
     * retained subjects into Postgres bytea storage before inventory can read. */
    if (continuationKind === "legacy") {
      const nativeNow = Date.now(), nativeCheckpointId = `checkpoint:native:${suffix}`;
      const nativeManifest = { ...manifest, checkpointId: nativeCheckpointId, retentionUntil: new Date(nativeNow + retentionMs).toISOString() };
      const nativeCheckpoint = new ProductionCheckpointCoordinator({ pool: sourceAuthorityPool, objectStore: objects, journal: new PostgresOperationJournal(sourceAuthorityPool, { namespace: "native-restore-source", scopeSha256: hex("native-restore-source") }), kekPath: "/fixture/kek", readKekFile: async () => kek, now: () => nativeNow });
      const nativeSealed = await nativeCheckpoint.seal({ ...nativeManifest, archive });
      const nativeCheckpointCiphertext = await objects.readExact(nativeSealed.envelope.object);
      if (!nativeCheckpointCiphertext) throw new Error("NATIVE_RESTORE_CHECKPOINT_CIPHERTEXT_REQUIRED");
      const nativeDatabase = `retained_native_${suffix}`, nativeServiceRole = role, nativeObjectRole = `retained_object_${suffix}`, nativeBackupRole = `retained_backup_${suffix}`;
      await closePool(runtime); runtime = undefined; await closePool(sourceRuntime); sourceRuntime = undefined; await closePool(source); source = undefined;
      await admin.query(`CREATE DATABASE ${nativeDatabase} TEMPLATE ${sourceDatabase}`);
      let nativeAdmin: Pool | undefined, nativeRuntime: Pool | undefined, nativeObjectRuntime: Pool | undefined;
      const roots = [await mkdtemp(join(tmpdir(), "cvm-native-restore-live-")), await mkdtemp(join(tmpdir(), "cvm-native-restore-copy-"))];
      const previousImage = process.env.NAPPLET_TRUSTED_RESTORER_IMAGE;
      try {
        nativeAdmin = new Pool({ connectionString: connection("postgres", nativeDatabase), connectionTimeoutMillis: 2_000 });
        await nativeAdmin.query(await Bun.file("migrations/phase-07/019_postgres_bytea_objects.sql").text());
        await nativeAdmin.query(`CREATE ROLE ${nativeObjectRole} LOGIN`); await nativeAdmin.query(`CREATE ROLE ${nativeBackupRole} LOGIN`);
        await nativeAdmin.query(`GRANT napplet_production_object TO ${nativeObjectRole}`);
        await nativeAdmin.query(`GRANT pg_read_all_data TO ${nativeBackupRole}`); await nativeAdmin.query(`GRANT CONNECT ON DATABASE ${nativeDatabase} TO ${nativeBackupRole}`); await nativeAdmin.query(`GRANT USAGE ON SCHEMA production_real TO ${nativeBackupRole}`); await nativeAdmin.query(`GRANT EXECUTE ON FUNCTION pg_catalog.pg_control_system() TO ${nativeBackupRole}`);
        nativeRuntime = new Pool({ connectionString: connection(nativeServiceRole, nativeDatabase), connectionTimeoutMillis: 2_000 });
        nativeObjectRuntime = new Pool({ connectionString: connection(nativeObjectRole, nativeDatabase), connectionTimeoutMillis: 2_000 });
        const nativePool = bindAccountingRealmPool(sqlPool(nativeRuntime), createAccountingRealm("production-real"));
        const nativeObjectPool = sqlPool(nativeObjectRuntime);
        const candidateSha256 = hex("native-restore-candidate"), topologySha256 = hex("native-restore-topology"), roleCostBoundSha256 = hex("native-restore-cost"), toolchainSha256 = hex("native-restore-toolchain");
        const bytea = new PostgresByteaObjectStoreAdapter({ pool: nativeObjectPool, now: () => nativeNow, retentionUntil: () => new Date(nativeNow + retentionMs).toISOString(), producerBudget: ObjectProducerBudgets.retained_subject });
        expect(await bytea.createImmutable({ key: nativeSealed.envelope.object.key, bytes: nativeCheckpointCiphertext, originalOperationIdentity: hex("native-restore-checkpoint") })).toEqual(nativeSealed.envelope.object);
        expect(await bytea.createImmutable({ key: artifactReference.key, bytes: fixture.artifact, originalOperationIdentity: hex("native-restore-artifact") })).toEqual(artifactReference);
        const custody = new FileObjectKeyCustody({ roots });
        let dumps = 0, losePrepareAck = true, prepareInserted = false;
        const lossyPool: PostgresSqlPool = Object.freeze({ async connect() {
          const client = await nativePool.connect();
          return Object.freeze({ async query<Row extends Record<string, unknown>>(text: string, values?: readonly unknown[]) {
            const result = await client.query<Row>(text, values);
            if (text.includes("INSERT INTO production_real.release_operation_journal") && values?.some(value => typeof value === "string" && value === `non-google-core:restore:${candidateSha256}:${topologySha256}:prepare`)) prepareInserted = true;
            if (text === "COMMIT" && prepareInserted && losePrepareAck) { losePrepareAck = false; prepareInserted = false; throw new Error("NATIVE_RESTORE_PREPARE_ACK_LOST"); }
            return result;
          }, release(error?: Error) { client.release(error); } });
        } });
        const nativeJournal = new PostgresOperationJournal(lossyPool, { namespace: `native-restore-${suffix}`, scopeSha256: topologySha256 });
        const image = `registry.fixture/native@sha256:${candidateSha256}`;
        const workerUnavailable = async (): Promise<never> => { throw new Error("NATIVE_RESTORE_FIXTURE_WORKER_UNAVAILABLE"); };
        const workers = createWorkerDeploymentClients({ image, workspaceRoot: PRODUCTION_WORKER_POLICY.workspaceRoot, policyVersion: PRODUCTION_WORKER_POLICY.version, modalAppName: "native-restore-workers", modalTags: {}, journal: createPostgresWorkerOperationJournal(nativeJournal), modalSdk: { apps: { fromName: workerUnavailable }, images: { fromRegistry: workerUnavailable }, sandboxes: { create: workerUnavailable, findByName: workerUnavailable, fromId: workerUnavailable } }, fly: { async create(value) { return { status: "unknown" as const, operationId: value.operationId }; }, async observe() { return { status: "unknown" as const }; }, async terminate() { return { status: "blocked" as const }; }, async observeTermination() { return { status: "blocked" as const }; }, async exec() { return { status: "unknown" as const }; } } });
        const capacity = createProductionReadyCapacity({ provider: "fly", workers, journal: nativeJournal, workerJournal: nativeJournal, image, toolchainSha256, flyRegion: "fixture", now: () => nativeNow });
        const coolifyImage = `sha256:${hex("native-restorer-image")}`;
        process.env.NAPPLET_TRUSTED_RESTORER_IMAGE = coolifyImage;
        const coolify = new NonGoogleCoolifyDriver({ baseOrigin: "https://coolify.fixture.invalid", serverUuid: "00000000-0000-4000-8000-000000000101", projectUuid: "00000000-0000-4000-8000-000000000102", environmentUuid: "00000000-0000-4000-8000-000000000103", postgres17Image: coolifyImage, restorerImage: coolifyImage, namePrefix: "native-restore", tokenPath: "/fixture/coolify-token" });
        const runner: NativeCommandRunner = Object.freeze({ async run(command) {
          const argv = [...command];
          if (argv[0] === "psql") {
            if (!argv.some(value => value.includes(`//${nativeBackupRole}@`))) throw new Error("NATIVE_RESTORE_BACKUP_ROLE_REQUIRED");
            const result = await docker(["exec", "-i", container, ...argv]);
            return Object.freeze({ exitCode: 0, stdout: new TextEncoder().encode(result), stderr: new Uint8Array() });
          }
          if (argv[0] !== "pg_dump") throw new Error("NATIVE_RESTORE_TRUSTED_DUMP_REQUIRED");
          if (!argv.some(value => value.includes(`//${nativeBackupRole}@`))) throw new Error("NATIVE_RESTORE_BACKUP_ROLE_REQUIRED");
          dumps++;
          const file = argv.indexOf("--file"); if (file < 0 || !argv[file + 1]) throw new Error("NATIVE_RESTORE_DUMP_PATH_REQUIRED");
          const hostPath = argv[file + 1]!, containerPath = `/tmp/native-${suffix}.dump`;
          argv[file + 1] = containerPath;
          const result = await docker(["exec", "-i", container, ...argv]);
          await docker(["cp", `${container}:${containerPath}`, hostPath]);
          await docker(["exec", "-i", container, "rm", "-f", containerPath]);
          return Object.freeze({ exitCode: 0, stdout: new TextEncoder().encode(result), stderr: new Uint8Array() });
        } });
        const postgres = new NonGooglePostgresDriver({ host: "127.0.0.1", port: Number(port), database: nativeDatabase, user: nativeServiceRole, passwordPath: "/fixture/native-postgres-password", ssl: false }, { async open() { return Object.freeze({ connect: nativePool.connect.bind(nativePool), end: async () => undefined }); } }, async () => "fixture-password");
        const restore = new NonGoogleFreshRestoreDriver(coolify, { sourceDatabaseUrlPath: "/fixture/native-source-url", freshDatabaseUrlPath: "/fixture/native-fresh-url", archiveRoot: "/fixture/native-archive", trustedRestorerName: "native-restorer", expectedPostgresMajor: 17 }, runner, async path => {
          if (path !== "/fixture/native-source-url") throw new Error("NATIVE_RESTORE_UNEXPECTED_SECRET");
          return `postgresql://${nativeBackupRole}@127.0.0.1:${port}/${nativeDatabase}`;
        });
        const signoz = new NonGoogleSigNozDriver({ baseOrigin: "https://signoz.fixture.invalid", ingestionKeyPath: "/fixture/signoz-ingest", queryKeyPath: "/fixture/signoz-query", collectorConfigSha256: hex("native-signoz"), serviceName: "native-restore", queryTemplateVersion: "v1" });
        const nativeScope = { checkpointId: nativeCheckpointId, sessionId, ownerId: fixture.ownerId, sourceAuthorityReference: `source:${nativeCheckpointId}` };
        const drivers = new NonGoogleNativeCoreDriverSet({ candidateSha256, topologySha256, roleCostBoundSha256, journal: nativeJournal, capacity, postgres, objectStore: bytea, coolify, signoz, restore, restoreScope: nativeScope, custodyRoots: roots, restorerCapabilitySha256: hex("native-restorer-capability") });
        const services = createNonGoogleNativeCoreServices({ drivers });
        const scopes = ["production.core"], effects = ["restore.inventory", "restore.prepare"];
        const authorityRequest = await createNonGoogleAuthorizationRequestV3({ identity: { candidateSha256, sourceSha256: hex("native-source"), configSha256: hex("native-config"), toolchainSha256, topologySha256, failureDomainSha256: hex("native-domain"), retentionSha256: hex("native-retention"), cleanupSha256: hex("native-cleanup"), controllerStateSha256: hex("native-state") }, binding: { providerGraphRevision: "non-google-v1", roleInventorySha256: hex("native-roles"), roleCostBoundSha256, scopesSha256: hex(canonicalJson(scopes)), effectsSha256: hex(canonicalJson(effects)) } });
        const pair = await crypto.subtle.generateKey({ name: "Ed25519" }, true, ["sign", "verify"]), costBytes = new TextEncoder().encode("native-restore-cost-artifact"), costSha256 = hex("native-cost-artifact");
        const unsigned = { version: "non-google-invocation-envelope-v1" as const, issuerId: "fixture-root-1", issuedAtMs: nativeNow - 1, expiresAtMs: nativeNow + 60_000, request: authorityRequest, receipt: { kind: "release-authorization-receipt-v4" as const, version: 4 as const, requestSha256: authorityRequest.requestSha256, candidateSha256, topologySha256, providerGraphRevision: "non-google-v1" as const, roleInventorySha256: hex("native-roles"), roleCostBoundSha256, receiptSha256: hex("native-receipt") }, scopes, effects, costArtifactSha256: costSha256 };
        const digestCost = Array.from(new Uint8Array(await crypto.subtle.digest("SHA-256", costBytes)), byte => byte.toString(16).padStart(2, "0")).join("");
        const signed = Buffer.from(new Uint8Array(await crypto.subtle.sign({ name: "Ed25519" }, pair.privateKey, new TextEncoder().encode(canonicalJson({ ...unsigned, costArtifactSha256: digestCost })))).buffer).toString("base64url");
        const authority = await createNonGoogleInvocationAuthorityVerifier({ trustedIssuers: [{ issuerId: unsigned.issuerId, publicKeySpkiDer: new Uint8Array(await crypto.subtle.exportKey("spki", pair.publicKey)) }], allowedScopes: scopes, allowedEffects: effects, costArtifact: { bytes: costBytes, sha256: digestCost }, now: () => nativeNow }).verify({ ...unsigned, costArtifactSha256: digestCost, signature: signed });
        const contextRequest = await createAuthorizationRequest({ candidateSha256, topologySha256, effectPlanSha256: hex("native-context-effects"), controllerStateSha256: hex("native-context-state"), providerCapabilitiesSha256: hex("native-context-capabilities"), orderedEffects: [{ id: "contextvm-fixture", provider: "contextvm", operation: "verify_integration", estimatedCostMicros: 1 }, { id: "collector-fixture", provider: "collector", operation: "verify_integration", estimatedCostMicros: 1 }], providerScopes: [{ provider: "contextvm", accountScopeSha256: hex("native-context-account"), projectScopeSha256: hex("native-context-project") }, { provider: "collector", accountScopeSha256: hex("native-context-account"), projectScopeSha256: hex("native-context-project") }], estimate: { currency: "USD", maximumMicros: 2, sourceId: "fixture", observedAtMs: nativeNow, freshUntilMs: nativeNow + 60_000 }, maximumRunDurationMs: 1_000, cleanupByMs: nativeNow + 10_000, evidenceRetentionDays: 30, artifactRetentionDays: 30, gcpEffects: { projectBootstrap: false, billing: false, apiEnablement: [] }, expiresAtMs: nativeNow + 60_000 });
        const contextSigner = new PrivateKeySigner("1".repeat(64));
        const contextvm = await openContextVmCertificationClient({ certificationKeyReference: "nostr:native-restore-fixture", serverPubkey: "b".repeat(64), relays: ["wss://127.0.0.1:1"], signerBroker: { async resolveContextVmCertificationSigner() { return contextSigner; } }, journal: nativeJournal, candidateSha256, topologySha256, authorizationRequest: contextRequest, authorizationReceipt: await createAuthorizationReceipt(contextRequest), now: () => nativeNow, timeoutMs: 1_000 });
        try {
          const adapters = createNativeProductionCoreSuiteAdapters({ candidate: { id: candidateSha256, provider: "fly", image, sourceSha256: hex("native-source") }, services, contextvm, authority, requestSha256: authorityRequest.requestSha256 });
          await expect(adapters.durability.inventory()).rejects.toThrow("NATIVE_RESTORE_PREPARE_ACK_LOST");
          const subjects = validateDurabilityInventory(await adapters.durability.inventory());
          expect(subjects).toHaveLength(7); expect(new Set(subjects.map(subject => subject.kind))).toEqual(new Set(["checkpoint", "sealed_artifact", "validation_evidence", "usage_receipt", "promotion_evidence", "owner_event", "attestation"]));
          expect(dumps).toBe(1);
          const prepareId = `restore:${candidateSha256}:${topologySha256}:prepare`;
          const prepared = await nativeJournal.read(`non-google-core:${prepareId}`), job = await nativeJournal.read(`non-google-core:restorer-job:${prepareId}`);
          expect(prepared?.value).toMatchObject({ state: "prepared", scope: nativeScope }); expect(job?.value).toMatchObject({ originalId: prepareId });
          const backupCrypto = new PerObjectFileCheckpointCrypto({ pool: nativePool, custody, now: () => nativeNow }), stored = await backupCrypto.readSealed(`restore-backup:${candidateSha256.slice(0, 24)}`);
          if (!stored || !job) throw new Error("NATIVE_RESTORE_BACKUP_ORIGINAL_REQUIRED");
          const jobValue = job.value as { archive: { key: string; generation: number; checksum: string } };
          const ciphertext = await bytea.readExact(jobValue.archive); if (!ciphertext) throw new Error("NATIVE_RESTORE_BACKUP_OBJECT_REQUIRED");
          const plaintext = await backupCrypto.open({ keyReference: stored.keyReference, nonce: stored.nonce, ciphertext, additionalData: new TextEncoder().encode(JSON.stringify({ scope: nativeScope, binding: { candidateSha256, topologySha256 } })) });
          expect(new TextDecoder().decode(plaintext.slice(0, 5))).toBe("PGDMP"); expect(jobValue.archive.key).not.toBe(nativeSealed.envelope.object.key);
          plaintext.fill(0); ciphertext.fill(0);
        } finally { await contextvm.close(); }
      } finally {
        if (previousImage === undefined) delete process.env.NAPPLET_TRUSTED_RESTORER_IMAGE; else process.env.NAPPLET_TRUSTED_RESTORER_IMAGE = previousImage;
        nativeCheckpointCiphertext.fill(0); await nativeObjectRuntime?.end(); await nativeRuntime?.end(); await nativeAdmin?.end(); await admin.query(`DROP DATABASE IF EXISTS ${nativeDatabase}`).catch(() => undefined); await Promise.all(roots.map(root => rm(root, { recursive: true, force: true })));
      }
    }
    console.log(JSON.stringify({ retainedSubjectsPostgres: true, subjects: 7, freshClone: true, releaseEvidence: false }));
  } finally {
    await migration?.end(); await recovered?.end(); await runtime?.end(); await sourceRuntime?.end(); await source?.end(); await admin?.end();
    await docker(["rm", "--force", container]).catch(() => undefined);
  }
}

integration("canonical SQL legacy V1 prepares, clones, reattaches, and erases all seven retained subjects without replaying ambiguous provider effects", () => proveRetainedSubjectsPostgres("legacy"), 120_000);
integration("canonical SQL priced V2 prepares, clones, fences, reattaches, and erases all seven retained subjects without replaying ambiguous provider effects", () => proveRetainedSubjectsPostgres("priced"), 120_000);
