import { ProductionDirectPublicationCertification } from "../../src/production/direct-publication-certification";
import { runLivePublicationCertification } from "../../src/certification/live/publication";
import { DIRECT_CLI_BINARY_SHA256, requireDirectToolchainReceipt } from "../../src/worker-adapters/direct-toolchain-receipt";
import { expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { Pool } from "pg";
import { accountIdForPrincipal } from "../../src/domain/account-command";
import { bindAccountingRealmPool, createAccountingRealm } from "../../src/funding/accounting-realm";
import { ContinuationService } from "../../src/continuity/continuation-service";
import type { PendingActionIntent } from "../../src/continuity/contracts";
import type { ContinuationFundingStore } from "../../src/persistence/funding-store";
import { MeteredGenerationService, StartSessionCommandSchema, ReviseSessionCommandSchema, SessionActionResultSchema } from "../../src/phase-04/metered-generation-service";
import { FundedAdmissionService } from "../../src/funding/funded-admission";
import { FundingService } from "../../src/funding/funding-service";
import { trustedAdmissionReceiptAuthority } from "../fixtures/admission-ready";
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
import { prepareResumePricingQuote, ResumePricingQuoteSchema } from "../../src/continuity/resume-pricing";
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
import { createWorkerDeploymentClients, createFlyMachinesHttpTransport } from "../../src/release/deployment/worker-clients";
import { createPostgresWorkerOperationJournal } from "../../src/release/deployment/postgres-provider-journals";
import { PRODUCTION_WORKER_POLICY } from "../../src/worker-adapters/production-worker-policy";
import { WorkerRunRequestSchema } from "../../src/phase-02/contracts";
import { projectResumePricingQuote } from "../../src/continuity/resume-v2-contracts";
import { ProductionPricedContinuationFinalizer } from "../../src/production/priced-continuation-finalizer";
import { ProductionPricedContinuationRunner } from "../../src/production/priced-continuation-runner";
import { ProductionPricedContinuationService } from "../../src/production/priced-continuation-service";
import { loadProductionConfig } from "../../src/production/config";
import { listProductionRetentionCandidates } from "../../src/production/checkpoint-retention";
import { ContinuationDeadlineReconciler } from "../../src/continuity/deadline-reconciler";
import { ProductionPricedContinuationCleanup } from "../../src/production/priced-continuation-cleanup";
import { createProductionReadyCapacity, productionCapacityIdentity } from "../../src/production/worker-capacity";
import { openLocalProductionWorker } from "../fixtures/local-production-worker";
import { ProductionWorkerJobRouter } from "../../src/production/worker-job-router";
import { verifyProductionConformanceReceipt } from "../../src/worker-adapters/conformance-receipt";
import { ProductionDirectManifestReceiptSchema } from "../../src/worker-adapters/direct-manifest-receipt";
import { readVerifiedDirectWorkerArchive } from "../../src/production/direct-artifact-reader";
import { ProductionOwnedDirectArtifacts } from "../../src/production/owned-direct-artifacts";
import { ProductionDirectArtifactDelivery } from "../../src/production/direct-artifact-delivery";
import { createDirectArtifactReadRequest, verifyDirectArtifactDelivery } from "../../src/publication/direct-delivery";
import { finalizeEvent, getPublicKey, verifyEvent, type Event } from "nostr-tools/pure";
import { proveDirectPreviewBrowser } from "../fixtures/direct-preview-browser";
import { matchFilters } from "nostr-tools/filter";
import { DirectCvmBuildAttestationSchema } from "../../src/publication/direct-attestation";
import { ProductionDirectPublicationFactory } from "../../src/production/direct-publication-factory";
import { ProductionDirectCertificationRelays } from "../../src/production/direct-publication-relays";
import { ProductionBuildAttestationSigner } from "../../src/production/attestation-signer";
import { ProductionDirectCertificationUpload } from "../../src/production/direct-publication-upload";
import { ProductionDirectPublicationIntents } from "../../src/production/direct-publication-intents";
import { openDirectNip46Fixture } from "../fixtures/direct-nip46-bunker";
import { openProductionNip46Signer } from "../../src/production/nip46-signer";
import { openProductionDirectCertificationNip46Signer } from "../../src/production/direct-nip46-signer";
import { createAuthorizationRequest, createAuthorizationReceipt } from "../../src/release/authorization";
import { SignedOwnerManifestEventSchema } from "../../src/publication/contracts";
import { DirectUploadAuthorizationEventSchema } from "../../src/publication/direct-upload-authorization";
import { signDirectUploadAuthorization } from "../../src/publication/direct-upload-authorization";
import { signDirectPublicationIntent } from "../../src/publication/direct-publication";

const integration = process.env.NAPPLET_RUN_POSTGRES_ISOLATION === "1" ? test : test.skip;
const hash = (value: unknown) => createHash("sha256").update(canonicalJson(value)).digest("hex");
/** Historical accepted rows were canonically hashed before V2 provenance
 * existed. Keep their original body shape rather than backfilling lineage. */
const historicalV1Quote = (quote: Awaited<ReturnType<typeof prepareResumePricingQuote>>) => {
  const body = { schemaVersion: "resume-pricing-quote-v1" as const, context: quote.context, preparationKey: quote.preparationKey,
    preparedAtMs: quote.preparedAtMs, expiresAtMs: quote.expiresAtMs, pricing: quote.pricing,
    maximumUsdMicros: quote.maximumUsdMicros, maximumSat: quote.maximumSat, priceSourcesSha256: quote.priceSourcesSha256 };
  const quoteSha256 = hash(body);
  return ResumePricingQuoteSchema.parse({ ...body, quoteReference: `resume-quote:${quoteSha256}`, quoteSha256 });
};
const actualWorkerImage = process.env.NAPPLET_CVM_TEST_REAL_WORKER_IMAGE;
const actualWorkerContract = z.enum(["legacy-aggregate-v1", "nip5d-direct-v1"]).optional().parse(process.env.NAPPLET_CVM_TEST_REAL_WORKER_CONTRACT) ?? "legacy-aggregate-v1";
const directWorker = actualWorkerContract === "nip5d-direct-v1";
if (directWorker && !actualWorkerImage) throw new Error("DIRECT_TEST_EXACT_WORKER_IMAGE_REQUIRED");
const realCounterSource = `import { runtimeHasDomain } from './domain-availability.js';
import './styles.css';
const root = document.querySelector<HTMLElement>('#app');
if (!root) throw new Error('APP_ROOT_MISSING');
const button = document.createElement('button');
let count = 0;
button.textContent = 'Count: 0';
button.addEventListener('click', () => { count++; button.textContent = 'Count: ' + count; });
button.title = runtimeHasDomain('outbox') ? 'Counter ready' : 'Local counter ready';
root.replaceChildren(button);
`;
const directCounterSource = `import { storage } from '@napplet/sdk';
import { runtimeHasDomain } from './domain-availability.js';
import './styles.css';
const root = document.querySelector<HTMLElement>('#app');
if (!root) throw new Error('APP_ROOT_MISSING');
const button = document.createElement('button');
let count = 0;
const render = () => { button.textContent = 'Count: ' + count; };
render(); root.replaceChildren(button);
if (runtimeHasDomain('storage')) storage.getItem('counter').then(value => { const saved = Number(value); if (Number.isSafeInteger(saved) && saved >= 0) count = saved; render(); }).catch(() => undefined);
button.addEventListener('click', () => { count++; render(); if (runtimeHasDomain('storage')) storage.setItem('counter', String(count)).catch(() => undefined); });
`;
const realCounterFiles = directWorker
  ? [{ path: "src/main.ts", content: directCounterSource }, { path: "src/capabilities.json", content: '{"required":["storage"],"optional":[]}' }]
  : [{ path: "src/main.ts", content: realCounterSource }];

function mountedPricedConfig(toolchainSha256: string, policyVersion: string) {
  const digest = "a".repeat(64), image = `registry.example/worker@sha256:${digest}`;
  return loadProductionConfig({
    realm: "production-real", candidateSha256: digest, topologySha256: digest, projectId: "napplet-cvm-01", regions: ["us-central1", "europe-west1"],
    cloudSql: { instanceReference: "sql:priced", database: "production_real", roleCredentialReference: "sql:role", restoreRecoveredRoleCredentialReference: "sql:recovered", restoreMigrationRoleCredentialReference: "sql:migration", migrationRevision: digest },
    gcs: { bucket: "priced-fixture-bucket", location: "nam4", encryptionKeyReference: "gcs:key", migrationBackupKeyReference: "gcs:migration", retentionDays: 30 }, checkpoint: { kekReference: "checkpoint:kek" },
    contextvm: { relay: "wss://relay.example", serviceKeyReference: "contextvm:key" }, certification: { authorizationRequestReference: "cert:request", authorizationReceiptReference: "cert:receipt", clientKeyReference: "cert:client", sessionMaterialReference: "cert:session", serverPubkey: "b".repeat(64) },
    funding: { nwcConnectionReference: "funding:nwc", cashuConsentReference: "funding:cashu", protectedMaterialReference: "funding:protected", admissionReceiptReference: "funding:admission", statusCursorReference: "funding:cursor" },
    vertex: { projectReference: "vertex:project", credentialReference: "vertex:credential", model: "gemini-4-argon", priceSnapshotSha256: digest },
    worker: { selectedProvider: "fly", evidenceReference: "worker:evidence", modalAccessReference: "worker:modal", flyAccessReference: "worker:fly", image, toolchainSha256, policyVersion },
    compatibleHost: { targetUrl: "https://host.example", targetSha256: digest, chromiumExecutable: "/usr/bin/chromium" },
    publication: { cliSourceReference: "publication:cli", signerBrokerReference: "publication:broker", signerSessionKeyReference: "publication:session", attestationKeyReference: "publication:attestation", ownerPubkey: "c".repeat(64), uploadServer: "https://upload.example", uploadTargetReference: "publication:target", relays: ["wss://relay.example"] },
    publicOrigins: { static: "https://static.example", preview: "https://preview.example", artifact: "https://artifact.example" }, policy: { artifactVersion: "fixture-policy", retentionDays: 30, liveGraceMs: 600_000 }, collector: { otlpEndpoint: "https://otlp.example", serviceName: "napplet-cvm-production" },
    operator: { serviceAccount: "priced-runner@napplet-cvm-01.iam.gserviceaccount.com", privateControlAudience: "https://priced-control.run.app" }, image: { controlPlane: image, toolchainSha256 },
  });
}
async function docker(args: string[]): Promise<string> {
  const child = Bun.spawn(["docker", ...args], { stdin: "ignore", stdout: "pipe", stderr: "pipe" });
  const [out, err, code] = await Promise.all([new Response(child.stdout).text(), new Response(child.stderr).text(), child.exited]);
  if (code !== 0) throw new Error(`DOCKER_FAILED:${args[0]}:${err.slice(0, 300)}`);
  return out.trim();
}
function sqlPool(native: Pool, loseCommit?: () => boolean, failRestorePauseWrite?: () => boolean, failTerminalPauseWrite?: () => boolean, observedSql?: string[]): PostgresSqlPool {
  return { async connect() { const client = await native.connect(); return {
    async query<Row extends Record<string, unknown>>(sql: string, values?: readonly unknown[]) {
      observedSql?.push(sql);
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
  let localWorker: Awaited<ReturnType<typeof openLocalProductionWorker>> | undefined;
  let closeDirectSigner = async () => {}, closeDirectBunker = () => {}, closeUploadServer = () => {}, closeAttestationSigner = () => {}, closeDirectFactory = async () => {};
  let publicationServer = "https://publication.example", publicationRelay = "wss://relay.example", uploadPuts = 0, uploadGets = 0;
  const publishedRelayEvents = new Map<string, Event>(), relayPublishes: string[] = [];
  let hideOwnerObservation = false, hideAttestationObservation = false;
  const uploadedBlobs = new Map<string, Uint8Array>();
  try {
    if (directWorker) {
      const cert = process.env.NAPPLET_PUBLICATION_TEST_TLS_CERT, key = process.env.NAPPLET_PUBLICATION_TEST_TLS_KEY;
      if (!cert || !key) throw new Error("RUN_BUN_SCRIPTS_TEST_DIRECT_PUBLICATION_FOR_LOCAL_TLS");
      const uploadServer = Bun.serve({ hostname: "127.0.0.1", port: 0, tls: { cert: Bun.file(cert), key: Bun.file(key) }, async fetch(request, server) {
        if (server.upgrade(request)) return undefined;
        const path = new URL(request.url).pathname;
        if (request.method === "PUT" && path === "/upload") {
          uploadPuts++;
          const header = request.headers.get("authorization");
          if (!header?.startsWith("Nostr ")) throw new Error("FIXTURE_AUTHORIZATION_REQUIRED");
          const event = DirectUploadAuthorizationEventSchema.parse(JSON.parse(Buffer.from(header.slice(6), "base64url").toString("utf8")));
          expect(verifyEvent(event)).toBeTrue();
          const bytes = new Uint8Array(await request.arrayBuffer()), digest = createHash("sha256").update(bytes).digest("hex");
          expect(event.tags).toContainEqual(["x", digest]);
          expect(event.tags).toContainEqual(["server", "127.0.0.1"]);
          uploadedBlobs.set(digest, bytes);
          return new Response("fixture lost upload acknowledgement", { status: 503 });
        }
        if (request.method !== "GET") throw new Error("FIXTURE_ONLY_EXACT_GET_ALLOWED");
        uploadGets++;
        const bytes = uploadedBlobs.get(path.slice(1));
        return bytes ? new Response(new Uint8Array(bytes)) : new Response(null, { status: 404 });
      }, websocket: { message(socket, bytes) {
        const wire: unknown = JSON.parse(String(bytes));
        if (!Array.isArray(wire)) throw new Error("FIXTURE_RELAY_WIRE_INVALID");
        if (wire[0] === "EVENT") {
          const event = SignedOwnerManifestEventSchema.extend({ kind: z.union([z.literal(35129), z.literal(1)]) }).parse(wire[1]);
          expect(verifyEvent(event)).toBeTrue(); publishedRelayEvents.set(event.id, event); relayPublishes.push(event.id);
          socket.close(1011, "fixture lost relay acknowledgement");
        } else if (wire[0] === "REQ") {
          const filters = z.array(z.object({ ids: z.array(z.string()).optional(), authors: z.array(z.string()).optional(), limit: z.number().optional() }).strict()).parse(wire.slice(2));
          for (const event of publishedRelayEvents.values()) if (!(hideOwnerObservation && event.kind === 35129) && !(hideAttestationObservation && event.kind === 1)
            && matchFilters(filters, event)) socket.send(JSON.stringify(["EVENT", wire[1], event]));
          socket.send(JSON.stringify(["EOSE", wire[1]]));
        }
      } } });
      publicationServer = uploadServer.url.origin; publicationRelay = publicationServer.replace(/^https:/u, "wss:"); closeUploadServer = () => { uploadServer.stop(true); };
    }
    await docker(["run", "--detach", "--rm", "--name", name, "--publish", "127.0.0.1::5432", "-e", "POSTGRES_HOST_AUTH_METHOD=trust", "postgres:17-alpine"]);
    const port = (await docker(["port", name, "5432/tcp"])).match(/127\.0\.0\.1:(\d+)/u)?.[1];
    if (!port) throw new Error("POSTGRES_PORT_MISSING");
    admin = new Pool({ connectionString: `postgresql://postgres@127.0.0.1:${port}/postgres`, connectionTimeoutMillis: 2000 });
    for (let attempt = 0; attempt < 90; attempt++) { try { await admin.query("SELECT 1"); break; } catch (error) { if (attempt === 89) throw error; await Bun.sleep(250); } }
    for (const file of ["phase-03/001_funding.sql", "phase-04/001_metered_generation.sql", "phase-04/002_action_budget_lifecycle.sql", "phase-05/001_continuation.sql", "phase-06/001_publication.sql", "phase-03/002_production_accounting.sql",
      "phase-07/001_production_operation_journal.sql", "phase-07/002_production_pricing_catalog.sql", "phase-07/003_production_checkpoints.sql", "phase-07/004_production_source_proposals.sql", "phase-07/006_production_pending_checkpoints.sql", "phase-07/009_production_resume_pricing_quotes.sql", "phase-07/017_production_resume_pricing_quote_v2.sql"])
      await admin.query(await Bun.file(`migrations/${file}`).text());
    await admin.query("CREATE ROLE resume_preparer_runtime LOGIN"); await admin.query("GRANT napplet_production_real TO resume_preparer_runtime");
    runtime = new Pool({ connectionString: `postgresql://resume_preparer_runtime@127.0.0.1:${port}/postgres` });
    const pool = sqlPool(runtime), bound = bindAccountingRealmPool(pool, createAccountingRealm("production-real"));
    const store: ContinuationFundingStore = new PostgresSqlFundingStore(bound), quotes = new ProductionResumePricingQuotes(pool);
    await quotes.assertReady();
    const startedAt = Date.now() - 600_100; let now = startedAt;
    const originalPricing = await resumePricingMaterial(startedAt, "profile:original");
    await registerProductionPricing({ pool, ...originalPricing });
    const directReadKey = new Uint8Array(32).fill(11);
    const principal = { pubkey: directWorker ? getPublicKey(directReadKey) : "7".repeat(64) }, accountId = await accountIdForPrincipal(principal);
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
    // The signed original pause was unfunded. Model the later top-up and cap
    // approval only after it has been durably checkpointed, leaving three sats
    // of held residual for the V2 preparation below.
    await admin.query("UPDATE production_real.account_balance_projection SET settled_available=3,held=3 WHERE account_id=$1", [accountId]);
    await admin.query("UPDATE production_real.session_cap_holds SET held_amount=3 WHERE account_id=$1 AND reference='admission:one'", [accountId]);
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

    // Restore the intentionally unfunded state used by the acceptance denial
    // assertions below. The quote above has already proven its pre-dispatch
    // residual-cap check and created no action reservation.
    await admin.query("UPDATE production_real.account_balance_projection SET settled_available=0,held=0 WHERE account_id=$1", [accountId]);
    await admin.query("UPDATE production_real.session_cap_holds SET held_amount=0 WHERE account_id=$1 AND reference='admission:one'", [accountId]);

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
    // The revision itself was paused without funds. Its final retention-window
    // quote is separately funded with the same three-sat residual used above.
    await admin.query("UPDATE production_real.account_balance_projection SET settled_available=3,held=3 WHERE account_id=$1", [accountId]);
    await admin.query("UPDATE production_real.session_cap_holds SET held_amount=3 WHERE account_id=$1 AND reference='admission:one'", [accountId]);
    const finalPricing = await resumePricingMaterial(now, "profile:final-window"); await registerProductionPricing({ pool, ...finalPricing });
    const finalPreparer = new ProductionResumePricingPreparer({ pool, store, quotes, checkpoint: freshCheckpoint, vertexJournal, currentPricing: finalPricing,
      compatibility: { policyVersion: pending.policyVersion, acceptedToolchains: [pending.toolchainId] }, now: () => now });
    const finalQuote = await finalPreparer.prepare({ principal: { id: accountId }, sessionId: revisionCommand.sessionId, checkpointId: revisionSealed.manifest.checkpointId,
      expectedSessionVersion: 1, expectedCheckpointVersion: 1, idempotencyKey: "quote:final-window" });
    expect(finalQuote).toMatchObject({ status: "quoted", expiresAtMs: Date.parse(revisionSealed.manifest.retentionUntil) });
    await admin.query("UPDATE production_real.account_balance_projection SET settled_available=0,held=0 WHERE account_id=$1", [accountId]);
    await admin.query("UPDATE production_real.session_cap_holds SET held_amount=0 WHERE account_id=$1 AND reference='admission:one'", [accountId]);
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
      fingerprint: hash({ workspace: workspaceCommand.idempotencyKey }), reference: "pending:workspace-resume", toolchainId: workspaceToolchain };
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
    async function acceptanceCheckpoint(key: string, lifetimeMs = 60_000, historicalV1 = false) {
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
      const proposedQuote = await prepareResumePricingQuote({ context: snapshot.context, pricing: acceptancePricing, preparationKey: `prepare:${key}`, nowMs: Date.now(), lifetimeMs });
      const savedQuote = historicalV1 ? historicalV1Quote(proposedQuote) : proposedQuote;
      await quotes.save(savedQuote);
      return { principal: { id: accountId }, sessionId: savedSession, checkpointId: saved.manifest.checkpointId, expectedSessionVersion: 0, expectedCheckpointVersion: 1,
        idempotencyKey: `resume:${key}`, approvePendingAction: true, capApprovalReference: command.admissionReference, pendingAction: savedQuote.context.pendingAction,
        pricingApproval: { quoteReference: savedQuote.quoteReference, quoteSha256: savedQuote.quoteSha256, maximumSat: savedQuote.maximumSat } };
    }
    const accepting = await acceptanceCheckpoint("acceptance:one", 60_000, true);
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
        steps: [{ type: "user_input", content: wire.input }, { type: "model_output", content: [{ type: "text", text: JSON.stringify({ files: actualWorkerImage && modelPosts === 3 ? realCounterFiles : [{ path: "src/main.ts", content: "document.body.textContent = 'One counter';" }] }) }] }],
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
    expect(historical.quote.schemaVersion).toBe("resume-pricing-quote-v1");
    expect(historical.quote).toEqual(accepted.claim.quote);
    const historicalRow = (await admin.query<{ quote_json: unknown; quote_sha256: string }>("SELECT quote_json,quote_sha256 FROM production_real.resume_pricing_quotes WHERE account_id=$1 AND quote_reference=$2", [accountId, accepted.claim.quote.quoteReference])).rows[0];
    expect(historicalRow).toEqual({ quote_json: accepted.claim.quote, quote_sha256: accepted.claim.quote.quoteSha256 });
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
        const capacityBinding = `${value.intentReference}:${value.expectedSessionBindingDigest}`;
        const capacityDigest = createHash("sha256").update(capacityBinding).digest("hex");
        const reference = `capacity:${capacityDigest}`, expiresAt = new Date(Date.now() + (actualWorkerImage ? 1_200_000 : 60_000)).toISOString();
        const ready: CapacityReservation = { status: "available", reference, expiresAt, usable: true,
          ready: { intentReference: value.intentReference, leaseReference: reference, sessionBindingDigest: value.expectedSessionBindingDigest,
            imageDigest: `sha256:${"a".repeat(64)}`, readinessProbeDigest: `sha256:${"b".repeat(64)}`, readyMonotonicMs: 100 } };
        readyWorkers.set(value.intentReference, ready);
        await capacityJournal.claim(`capacity-intent:${createHash("sha256").update(value.intentReference).digest("hex")}`,
          productionCapacityIdentity({ intentReference: value.intentReference, expectedSessionBindingDigest: value.expectedSessionBindingDigest, provider: fixtureProvider }),
          { ...value, reference, workerOperationId: `capacity-${capacityDigest.slice(0, 40)}`, provider: fixtureProvider, deadlineEpochMs: Date.parse(expiresAt) });
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
      worker: { registerContinuationRequest: unexpectedWorkspace, restorePricedCheckpoint: unexpectedWorkspace, observePricedRestoreCheckpoint: unexpectedWorkspace, repairPricedRestoreCheckpoint: unexpectedWorkspace } };
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
    const terminalCapacity = (await admin.query("SELECT state,capacity_reference,expires_at FROM production_real.capacity_intents WHERE account_id=$1 AND intent_reference=$2", [accountId, capacityIntent.capacityIntentReference])).rows[0];
    expect(terminalCapacity?.state).toBe("released");
    await expect(metered.transact(accountId, tx => tx.recordCapacityObservation({ intentReference: capacityIntent.capacityIntentReference, state: "available" }))).resolves.toMatchObject({ state: "released" });
    expect((await admin.query("SELECT state,capacity_reference,expires_at FROM production_real.capacity_intents WHERE account_id=$1 AND intent_reference=$2", [accountId, capacityIntent.capacityIntentReference])).rows[0]).toEqual(terminalCapacity);
    await expect(runtime.query("UPDATE production_real.capacity_intents SET state='available' WHERE account_id=$1 AND intent_reference=$2", [accountId, capacityIntent.capacityIntentReference])).rejects.toThrow("PRICED_CAPACITY_TRANSITION_DENIED");
    await expect(resolver.resolveWorker(workerRequest)).rejects.toThrow("PRODUCTION_WORKER_ACTION_OWNER_NOT_FOUND");
    expect(reserves).toBe(1);
    expect(modelPosts).toBe(2);
    // Full encrypted workspace -> real bridge -> native restore claim and
    // evidence -> durable SQL proof. Only the external provider RPC is local.
    // The checkpoint timeline intentionally advances beyond the live grace
    // window, but the V2 price/claim guard is authoritative on PostgreSQL's
    // wall clock. Keep those identities separate so the mounted facade can
    // exercise the real API and terminal transaction.
    // The real Vertex request includes the fixed policy and response schema;
    // its bounded input envelope must cover those coordinator bytes before
    // the durable provider claim is allowed to reach the single original POST.
    const workspacePricing = await resumePricingMaterial(Date.now(), "profile:workspace-mounted", "2000");
    await registerProductionPricing({ pool, ...workspacePricing });
    const workspacePreparer = new ProductionResumePricingPreparer({ pool, store, quotes, checkpoint, vertexJournal, currentPricing: workspacePricing,
      compatibility: { policyVersion: workspaceIntent.policyVersion, acceptedToolchains: [workspaceToolchain] }, now: Date.now });
    const workspaceAcceptance = new ProductionResumeAcceptance({ pool, quotes, preparer: workspacePreparer, now: Date.now });
    const workspaceWorkers = new ProductionPricedContinuationWorkers({ pool, acceptance: workspaceAcceptance, capacity });
    await workspaceWorkers.assertReady();
    let workspaceAuthority: Awaited<ReturnType<typeof workspacePreparer.loadAuthority>>;
    try {
      workspaceAuthority = await workspacePreparer.loadAuthority({ principal: { id: accountId }, sessionId: workspaceCommand.sessionId,
        checkpointId: workspaceSealed.manifest.checkpointId, expectedSessionVersion: 1, expectedCheckpointVersion: 1, idempotencyKey: "prepare:workspace-native" });
    } catch (error) {
      throw new Error(`WORKSPACE_V2_AUTHORITY_REQUIRED:${error instanceof Error ? error.message : "UNKNOWN"}`);
    }
    expect(workspaceAuthority.context.toolchainId).toBe(workspaceToolchain);
    const workspaceQuote = await workspacePreparer.prepare({ principal: { id: accountId }, sessionId: workspaceCommand.sessionId,
      checkpointId: workspaceSealed.manifest.checkpointId, expectedSessionVersion: 1, expectedCheckpointVersion: 1, idempotencyKey: "prepare:workspace-native" });
    if (workspaceQuote.status !== "quoted") throw new Error(`EXPECTED_NATIVE_WORKSPACE_QUOTE:${workspaceQuote.code}`);
    const workspaceResume = { principal: { id: accountId }, sessionId: workspaceCommand.sessionId, checkpointId: workspaceSealed.manifest.checkpointId,
      expectedSessionVersion: 1, expectedCheckpointVersion: 1, idempotencyKey: "resume:workspace-native", approvePendingAction: true,
      capApprovalReference: workspaceCommand.admissionReference, pendingAction: workspaceQuote.pendingAction,
      pricingApproval: { quoteReference: workspaceQuote.quoteReference, quoteSha256: workspaceQuote.quoteSha256, maximumSat: workspaceQuote.pricing.maximumSat } };
    const workspaceClaim = (await workspaceAcceptance.claim(workspaceResume)).claim;
    fixtureProvider = "fly";
    const workspaceAllocation = await workspaceWorkers.allocate(accountId, workspaceResume.idempotencyKey);
    if (workspaceAllocation.status !== "available") throw new Error("EXPECTED_WORKSPACE_CAPACITY");
    const workspaceCapacityIntent = (await workspaceAcceptance.claimWorker(accountId, workspaceResume.idempotencyKey)).workerIntent;
    // Match the mounted capacity component's immutable operation derivation.
    // The prewarm may reconcile this original worker, but must never create a
    // replacement provider resource after the lost-ACK boundary.
    const workerOperationId = `capacity-${createHash("sha256").update(`${workspaceCapacityIntent.capacityIntentReference}:${workspaceCapacityIntent.sessionBindingDigest}`).digest("hex").slice(0, 40)}`;
    const nativeWorkerJournal = new PostgresOperationJournal(pool, { namespace: "fixture-workspace-workers", scopeSha256: "4".repeat(64) });
    const nativeJobJournal = new PostgresOperationJournal(pool, { namespace: "fixture-workspace-jobs", scopeSha256: "4".repeat(64) });
    const nativeRequestJournal = new PostgresOperationJournal(pool, { namespace: "fixture-workspace-requests", scopeSha256: "4".repeat(64) });
    const nativeWorkerRecords = createPostgresWorkerOperationJournal(nativeWorkerJournal);
    const nativeCreatedAtMs = Date.now();
    await nativeWorkerRecords.claim({ operationId: workerOperationId, requestSha256: "c".repeat(64), resourceName: workerOperationId, provider: "fly", appName: "resume-workspace-fixture",
      region: "ams", policyVersion: PRODUCTION_WORKER_POLICY.version, image: `registry.example/worker@sha256:${"a".repeat(64)}`,
      sessionLeaseSha256: workspaceCapacityIntent.sessionBindingDigest.slice(7), toolchainSha256: workspaceToolchain,
      providerDeadlineEpochMs: Date.parse(workspaceAllocation.allocation.expiresAt), createdAtMs: nativeCreatedAtMs });
    await nativeWorkerRecords.update({ operationId: workerOperationId, requestSha256: "c".repeat(64), resourceId: "fixture-workspace-machine", state: "reconciled", providerCreatedAtMs: nativeCreatedAtMs });
    let nativeRestores = 0, nativeQueries = 0, nativeUploads = 0, nativePlans = 0, wrongNativeReceipt = true;
    const noNativeEffect = async () => { throw new Error("UNEXPECTED_NATIVE_WORKER_OPERATION"); };
    let nativeExists = true, wrongCleanupIdentity = true, nativeDeletes = 0, cleanupGets = 0;
    const nativeFly = createFlyMachinesHttpTransport({ appName: "resume-workspace-fixture", journal: nativeWorkerRecords,
      getAccessToken: async () => "local-test-fly-token-aaaaaaaaaaaa", async fetch(url, init) {
        const parsed = new URL(url);
        if (parsed.origin !== "https://api.machines.dev" || parsed.pathname !== "/v1/apps/resume-workspace-fixture/machines/fixture-workspace-machine")
          throw new Error("UNEXPECTED_CLEANUP_RESOURCE_OR_CREATE");
        if (init.method === "GET") {
          cleanupGets++;
          return nativeExists ? Response.json({ id: "fixture-workspace-machine", name: workerOperationId, created_at: new Date(nativeCreatedAtMs).toISOString(),
            config: { image: `registry.example/worker@sha256:${"a".repeat(64)}`, services: [],
              guest: { cpus: PRODUCTION_WORKER_POLICY.cpu, memory_mb: PRODUCTION_WORKER_POLICY.memoryMiB },
              env: { NAPPLET_CVM_POLICY_VERSION: PRODUCTION_WORKER_POLICY.version }, metadata: { "napplet-cvm-operation": workerOperationId,
                "napplet-cvm-policy": PRODUCTION_WORKER_POLICY.version, "napplet-cvm-role": "isolated-worker",
                "napplet-cvm-request": wrongCleanupIdentity ? "0".repeat(64) : "c".repeat(64) } } }) : new Response(null, { status: 404 });
        }
        if (init.method === "DELETE" && parsed.search === "?force=true") { nativeDeletes++; nativeExists = false; throw new Error("NATIVE_DELETE_ACK_LOST"); }
        throw new Error("UNEXPECTED_CLEANUP_METHOD");
      } });
    const workerClients = createWorkerDeploymentClients({ image: `registry.example/worker@sha256:${"a".repeat(64)}`, workspaceRoot: PRODUCTION_WORKER_POLICY.workspaceRoot,
      policyVersion: PRODUCTION_WORKER_POLICY.version, modalAppName: "resume-workspace-fixture", modalTags: {}, journal: nativeWorkerRecords,
      modalSdk: { apps: { fromName: noNativeEffect }, images: { fromRegistry: noNativeEffect }, sandboxes: { create: noNativeEffect, findByName: noNativeEffect, fromId: noNativeEffect } },
      fly: { create: noNativeEffect, async observe(value) {
        if (value.operationId !== workerOperationId) throw new Error("UNEXPECTED_NATIVE_WORKER_OBSERVATION");
        return { status: "completed" as const, resourceId: "fixture-workspace-machine", readiness: { readyMonotonicMs: 100, readinessProbeDigest: `sha256:${"b".repeat(64)}` } };
      }, terminate: nativeFly.terminate, observeTermination: nativeFly.observeTermination,
        async exec(value): Promise<{ status: "completed"; exitCode: number; stdout: string }> {
          const [, action, archiveSha256, index, data] = value.command;
          if (action === "restore-plan") { nativePlans++; const plan = JSON.parse(Buffer.from(index ?? "", "base64").toString("utf8")); return { status: "completed", exitCode: 0,
            stdout: JSON.stringify({ state: "planned", archiveSha256, chunks: plan.chunks }) }; }
          if (action === "restore-put") { nativeUploads++; return { status: "completed", exitCode: 0,
            stdout: JSON.stringify({ state: "stored", archiveSha256, chunk: Number(index), sha256: bytesSha(Buffer.from(data ?? "", "base64")) }) }; }
          if (action === "restore") { nativeRestores++; throw new Error("NATIVE_WORKSPACE_RESTORE_ACK_LOST"); }
          if (action === "restore-status") { nativeQueries++; return { status: "completed", exitCode: 0,
            stdout: JSON.stringify({ state: "restored", archiveSha256: bytesSha(workspaceBytes), toolchainSha256: workspaceToolchain,
              sourceSha256: wrongNativeReceipt ? "0".repeat(64) : bytesSha(canonicalJson(workspaceSource.files)),
              artifactFilesSha256: bytesSha(canonicalJson(workspaceFiles)), workspacePath: "/workspace/restored" }) }; }
          if (actualWorkerImage && ["put", "start", "status", "artifact"].includes(action ?? "")) {
            localWorker ??= await openLocalProductionWorker(actualWorkerImage);
            return localWorker.exec(value.command, value.stdin);
          }
          throw new Error("UNEXPECTED_NATIVE_RESTORE_COMMAND");
        } } });
    const sourceRequest = WorkerRunRequestSchema.parse({ sessionId: workspaceCommand.sessionId, actionId: workspaceSource.actionId, expectedVersion: 1,
      policyVersion: workspaceCommand.policyVersion, capabilityGrant: "phase-04-coordinator-grant", workspaceId: `workspace:${workspaceCommand.sessionId}`,
      sourceProposalReference: `proposal:sha256:${workspaceSource.proposalSha256}`, sourceProposalSha256: workspaceSource.proposalSha256, sourceProposalFiles: workspaceSource.files });
    await new ProductionWorkerRequestStore(nativeRequestJournal).persist(sourceRequest);
    const changedDefaultClients = directWorker ? createWorkerDeploymentClients({ image: `registry.example/new-default@sha256:${"e".repeat(64)}`,
      workspaceRoot: PRODUCTION_WORKER_POLICY.workspaceRoot, policyVersion: PRODUCTION_WORKER_POLICY.version,
      modalAppName: "resume-workspace-fixture", modalTags: {}, journal: nativeWorkerRecords,
      modalSdk: { apps: { fromName: noNativeEffect }, images: { fromRegistry: noNativeEffect }, sandboxes: { create: noNativeEffect, findByName: noNativeEffect, fromId: noNativeEffect } },
      fly: { create: noNativeEffect, observe: noNativeEffect, terminate: noNativeEffect, observeTermination: noNativeEffect, exec: noNativeEffect } }) : undefined;
    const directRouter = directWorker && changedDefaultClients ? new ProductionWorkerJobRouter({ workerJournal: nativeWorkerJournal, jobJournal: nativeJobJournal,
      publication: { server: publicationServer }, executables: [{ image: `registry.example/new-default@sha256:${"e".repeat(64)}`,
        toolchainSha256: "e".repeat(64), artifactContract: "legacy-aggregate-v1", clients: changedDefaultClients,
        modalAppName: "resume-workspace-fixture", flyAppName: "resume-workspace-fixture" }, { image: `registry.example/worker@sha256:${"a".repeat(64)}`,
        toolchainSha256: workspaceToolchain, artifactContract: "nip5d-direct-v1", restoreRecoveryVersion: 1, clients: workerClients,
        modalAppName: "resume-workspace-fixture", flyAppName: "resume-workspace-fixture" }] }) : undefined;
    const nativeObjects = new GcsObjectStoreAdapter({ config: { bucket: "workspace-fixture", projectId: "fixture" }, client: objectClient });
    const nativeBridge = () => new ProductionWorkerBridge({ resolver: new ProductionWorkerOwnershipResolver({ pool, policyVersion: workspaceCommand.policyVersion,
      capacityJournal, pricedContinuations: workspaceWorkers }), workers: workerClients, workerJournal: nativeWorkerJournal, jobJournal: nativeJobJournal,
      requestJournal: nativeRequestJournal, artifactStore: nativeObjects, toolchainSha256: directWorker ? "e".repeat(64) : workspaceToolchain,
      ...(directRouter ? { jobRouter: directRouter, publication: { server: publicationServer } } : {}) });
    const cleanupCapacity = createProductionReadyCapacity({ provider: "fly", workers: workerClients, journal: capacityJournal, workerJournal: nativeWorkerJournal,
      image: `registry.example/worker@sha256:${"a".repeat(64)}`, toolchainSha256: workspaceToolchain, flyRegion: "ams" });
    const cleanupJournal = new PostgresOperationJournal(pool, { namespace: "fixture-priced-cleanup", scopeSha256: "8".repeat(64) });
    const cleanupInput = { pool, acceptance: workspaceAcceptance, capacity: cleanupCapacity, workerJournal: nativeWorkerJournal, journal: cleanupJournal };
    const cleanup = () => new ProductionPricedContinuationCleanup(cleanupInput);
    const workspaceRestores = () => new ProductionPricedContinuationRestores({ pool, acceptance: workspaceAcceptance, preparer: workspacePreparer,
      workers: workspaceWorkers, checkpoint, jobJournal: nativeJobJournal, worker: nativeBridge() });
    await workspaceRestores().assertReady();
    expect(await workspaceRestores().restore(accountId, workspaceResume.idempotencyKey)).toEqual({ status: "reconciliation_pending" });
    expect(nativeRestores).toBe(1); expect(nativePlans).toBe(directWorker ? 1 : 0); expect(nativeUploads).toBeGreaterThan(0); expect(nativeQueries).toBe(0);
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
    const newProposalFiles = actualWorkerImage ? realCounterFiles : [{ path: "src/main.ts", content: "document.body.textContent = 'A fresh resumed counter';" }];
    const newProposalSha = hash(actualWorkerImage ? { files: newProposalFiles } : newProposalFiles);
    const resumedWorkerRequest = WorkerRunRequestSchema.parse({ ...sourceRequest, actionId: workspaceClaim.actionId, sourceProposalReference: `proposal:sha256:${newProposalSha}`,
      sourceProposalSha256: newProposalSha, sourceProposalFiles: newProposalFiles, ...(directWorker ? { idea: workspaceCommand.revision.trim() } : {}) });
    await new ProductionWorkerRequestStore(nativeRequestJournal).persist(resumedWorkerRequest);
    expect(await new ProductionWorkerRequestStore(nativeRequestJournal).read(resumedWorkerRequest)).toEqual(resumedWorkerRequest);
    expect(await new ProductionWorkerRequestStore(nativeRequestJournal).readArtifactRequest({ sessionId: resumedWorkerRequest.sessionId, actionId: resumedWorkerRequest.actionId, expectedVersion: resumedWorkerRequest.expectedVersion })).toEqual(resumedWorkerRequest);
    expect(await new ProductionWorkerRequestStore(nativeRequestJournal).readArtifactRequest({ sessionId: resumedWorkerRequest.sessionId, actionId: resumedWorkerRequest.actionId, expectedVersion: 2 })).toBeUndefined();
    expect(await new ProductionWorkerRequestStore(nativeRequestJournal).read(sourceRequest)).toEqual(sourceRequest);
    await expect(new ProductionWorkerRequestStore(nativeRequestJournal).persist({ ...resumedWorkerRequest, sourceProposalFiles: workspaceSource.files })).rejects.toThrow("PRODUCTION_CHECKPOINT_REQUEST_BINDING_INVALID");
    // A rebuilt authority has no live runner object to trust. It may still
    // observe/fence this one fully durable priced tuple through the actual
    // resolver, while ordinary priced generation remains separately gated.
    const freshPricedResolver = new ProductionWorkerOwnershipResolver({ pool, policyVersion: workspaceCommand.policyVersion, capacityJournal });
    await expect(freshPricedResolver.resolvePricedRestore(restoredWorkspace.restore.metadata, resumedWorkerRequest)).resolves.toMatchObject({
      accountId, ownerId: principal.pubkey, intentReference: expect.stringMatching(/^capacity-intent:/u), provider: fixtureProvider,
    });
    await expect(freshPricedResolver.resolvePricedRestore({ ...restoredWorkspace.restore.metadata, leaseToken: "lease:foreign" }, resumedWorkerRequest)).rejects.toThrow("PRODUCTION_PRICED_RESTORE_BINDING_DENIED");
    expect(await nativeBridge().observePricedRestoreCheckpoint(restoredWorkspace.restore.metadata)).toMatchObject({ status: "restored" });
    expect(nativeQueries).toBe(3); expect(nativeRestores).toBe(1); expect(nativeUploads).toBe(uploadsAfterOriginal);
    expect(reserves).toBe(2); expect(modelPosts).toBe(2);
    const finalizationMigration = await Bun.file("migrations/phase-07/013_production_priced_continuation_finalizations.sql").text();
    await admin.query(finalizationMigration); await admin.query(finalizationMigration);
    // This fixture seeds balances administratively instead of running a rail
    // credit. Create the clearing account that real verified credit creates.
    await admin.query("INSERT INTO production_real.funding_accounts(account_id,unit) VALUES('treasury:clearing','sat') ON CONFLICT(account_id) DO NOTHING");
    const terminalInput = { pool, acceptance: workspaceAcceptance, restores: workspaceRestores(), gateway, journal: vertexJournal, worker: nativeBridge() };
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
    // Settlement/reconciliation uses the same immutable reduced V2 envelope
    // that passed the provider-dispatch fence; it must not borrow the earlier
    // fixture action's card/profile or maximum units.
    const workspaceApiIntent = ProviderOperationIntentSchema.parse({ accountId, sessionId: workspaceClaim.sessionId, actionId: workspaceClaim.actionId,
      operationId: workspaceClaim.operationId, providerRequestId: workspaceClaim.operationId, actionBudgetReference: workspaceClaim.actionBudgetReference,
      requestFingerprint: workspaceClaim.fingerprint, expectedVersion: workspaceClaim.quote.context.expectedSessionVersion,
      profileId: workspaceClaim.quote.pricing.profile.id, priceCardId: workspaceClaim.quote.pricing.card.id,
      prompt: workspaceCommand.revision, maximumUnits: workspaceClaim.quote.pricing.profile.maximumUnits, selection: "unselected" });
    const noAdmission = async () => { throw new Error("UNEXPECTED_CORE_READMISSION"); };
    const workspaceCoreSettlement = createProductionVertexGenerationSettlement({ gateway, conversion: workspaceClaim.settlement.conversion,
      journal: vertexJournal, resumeSettlements: workspaceAcceptance });
    let mountedSettlementError: unknown;
    const coreOptions = { store: metered, gateway, worker: nativeBridge(), artifactVerifier: nativeBridge(),
      proposalStore: new ProductionSourceProposalStore(pool), continuationCommands: checkpoint.pendingCommands, toolchainIdentity: workspaceClaim.quote.context.toolchainId,
      settlement: { ...workspaceCoreSettlement, prepare: noAdmission, async finalize(input: Parameters<typeof workspaceCoreSettlement.finalize>[0]) {
        try { return await workspaceCoreSettlement.finalize(input); }
        catch (error) { mountedSettlementError = error; throw error; }
      } },
      fundedAdmission: new FundedAdmissionService({ funding: new FundingService(store), store, receiptAuthority: trustedAdmissionReceiptAuthority,
        capacity: { reserveNow: noAdmission, observe: noAdmission, release: noAdmission } }) };
    const core = new MeteredGenerationService(coreOptions);
    const mountedToolchain = directWorker ? "e".repeat(64) : workspaceToolchain;
    const mountedRouter = new ProductionWorkerJobRouter({ workerJournal: nativeWorkerJournal, jobJournal: nativeJobJournal,
      executables: [{ image: `registry.example/worker@sha256:${"a".repeat(64)}`, toolchainSha256: mountedToolchain, clients: workerClients,
        modalAppName: "resume-workspace-fixture", flyAppName: "resume-workspace-fixture" }] });
    // This is a distinct mounted production-capacity instance, prewarmed
    // against the exact original native worker. It can only observe/reconcile
    // that record; create remains an explicit no-effect fixture denial.
    const mountedCapacity = createProductionReadyCapacity({ provider: "fly", workers: workerClients,
      journal: capacityJournal,
      workerJournal: nativeWorkerJournal, image: `registry.example/worker@sha256:${"a".repeat(64)}`,
      toolchainSha256: mountedToolchain, flyRegion: "ams" });
    await mountedCapacity.prewarm({ intentReference: workspaceCapacityIntent.capacityIntentReference,
      expectedSessionBindingDigest: workspaceCapacityIntent.sessionBindingDigest });
    let failFirstMountedTerminalWrite = true;
    const mountedSql: string[] = [];
    const mountedFailurePool = sqlPool(runtime, undefined, undefined, () => {
      const value = failFirstMountedTerminalWrite;
      failFirstMountedTerminalWrite = false;
      return value;
    }, mountedSql);
    const mountedService = await ProductionPricedContinuationService.create({ pool: mountedFailurePool, config: mountedPricedConfig(mountedToolchain, workspaceCommand.policyVersion), generation: core,
      capacity: mountedCapacity, checkpoint, vertexJournal, workerJournal: nativeWorkerJournal, jobJournal: nativeJobJournal,
      requestJournal: nativeRequestJournal, capacityJournal, artifactStore: nativeObjects, workers: workerClients, jobRouter: mountedRouter,
      gateway, pricing: workspacePricing });
    await mountedService.runner.assertReady();
    // The normal mounted facade reads the original quote from SQL; it never
    // accepts caller-supplied pricing or provider authority.
    expect(await mountedService.prepare({ principal: { id: accountId }, sessionId: workspaceCommand.sessionId,
      checkpointId: workspaceSealed.manifest.checkpointId, expectedSessionVersion: 1, expectedCheckpointVersion: 1,
      idempotencyKey: "prepare:workspace-native" })).toMatchObject({ status: "quoted", quoteReference: workspaceQuote.quoteReference });
    const beforeMountedResume = await metered.findMeteredAction(accountId, workspaceClaim.actionKey);
    if (beforeMountedResume?.status !== "prepared") throw new Error(`MOUNTED_PROVIDER_PRECONDITION_INVALID:${beforeMountedResume?.status ?? "missing"}`);
    const runnerInput = { pool, acceptance: workspaceAcceptance, preparer: workspacePreparer, workers: workspaceWorkers,
      restores: workspaceRestores(), generation: core, finalizer, cleanup: cleanup() };
    // First dispatch traverses the mounted public facade into its runner,
    // bridge, verified artifact path, and finalizer. A deterministic late SQL
    // failure rolls the transaction back and stays a private failure; it must
    // not be relabelled as an unknown provider receipt.
    let mountedTerminalError: unknown;
    let mountedTerminalResult: unknown;
    try { mountedTerminalResult = await mountedService.resume(workspaceResume); }
    catch (error) { mountedTerminalError = error; }
    if (failFirstMountedTerminalWrite) {
      const action = await metered.findMeteredAction(accountId, workspaceClaim.actionKey);
      const claim = await workspaceAcceptance.find(accountId, workspaceResume.idempotencyKey);
      const provider = (await admin.query("SELECT state FROM production_real.provider_operations WHERE id=$1", [workspaceClaim.operationId])).rows[0];
      const journal = await vertexJournal.read(workspaceClaim.operationId);
      throw new Error(`MOUNTED_TERMINAL_WRITE_UNREACHED:${mountedTerminalError instanceof Error ? mountedTerminalError.message : canonicalJson(mountedTerminalResult)};SETTLEMENT:${mountedSettlementError instanceof Error ? mountedSettlementError.message : "none"};POSTS:${modelPosts};ACTION:${action?.status ?? "missing"};CLAIM:${claim?.state ?? "missing"};PROVIDER:${provider?.state ?? "missing"};JOURNAL:${journal ? "present" : "missing"};SQL:${mountedSql.slice(-12).map(sql => sql.replaceAll(/\s+/gu, " ").slice(0, 160)).join("|")}`);
    }
    if (!(mountedTerminalError instanceof Error) || mountedTerminalError.message !== "TERMINAL_PAUSE_WRITE_FAILED")
      throw new Error(`MOUNTED_TERMINAL_WRITE_OUTCOME_INVALID:${mountedTerminalError instanceof Error ? mountedTerminalError.message : canonicalJson(mountedTerminalResult)}`);
    expect(modelPosts).toBe(3);
    expect((await metered.findMeteredAction(accountId, workspaceClaim.actionKey))?.status).toBe("dispatching");
    const workspaceObserved = await gateway.lookup(workspaceApiIntent, new AbortController().signal);
    if (workspaceObserved.status !== "receipt_found") throw new Error("EXPECTED_WORKSPACE_MODEL_USAGE");
    const workspaceSettlement = await createProductionVertexGenerationSettlement({ gateway, conversion: workspaceClaim.settlement.conversion, journal: vertexJournal,
      resumeSettlements: workspaceAcceptance }).finalize({ accountId, intent: workspaceApiIntent, receipt: workspaceObserved.receipt, pricedAmount: "3" });
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
    // Consume the authenticated command through receipt-only core recovery.
    // Default mode pins a conflicting proposal and verifies failed billing.
    // Exact-image mode pins the actual proposal and requires real CLI/Chromium
    // artifact verification; it supplies no synthetic successful build reports.
    const acceptedWorkspace = await workspacePreparer.loadAcceptedAuthority({ principal: { id: accountId }, idempotencyKey: workspaceResume.idempotencyKey });
    const coreInput = { intent: acceptedWorkspace.intent, restoredCommand: acceptedWorkspace.command, pricing: acceptedWorkspace.quote.pricing,
      maximumSat: acceptedWorkspace.quote.maximumSat, binding: { accountId, actionKey: workspaceClaim.actionKey, commandFingerprint: workspaceClaim.fingerprint,
        actionId: workspaceClaim.actionId, operationId: workspaceClaim.operationId, actionBudgetReference: workspaceClaim.actionBudgetReference } };
    await expect(core.preparePricedContinuation({ ...coreInput, maximumSat: "40" })).rejects.toThrow("PRICED_CONTINUATION_PREPARED_ACTION_BINDING_DENIED");
    await expect(core.preparePricedContinuation({ ...coreInput, restoredCommand: { ...acceptedWorkspace.command, maximum: "500" } })).rejects.toThrow("CONTINUATION_RETAINED_COMMAND_BINDING_INVALID");
    for (const changed of [{ accountId: "account:foreign" }, { actionKey: acceptedWorkspace.intent.idempotencyKey },
      { actionId: "action:foreign" }, { operationId: "operation:foreign" }, { actionBudgetReference: "budget:foreign" }, { commandFingerprint: "f".repeat(64) }])
      await expect(core.preparePricedContinuation({ ...coreInput, binding: { ...coreInput.binding, ...changed } })).rejects.toThrow();
    const executable = await core.preparePricedContinuation(coreInput);
    expect(await executable.readTerminal()).toBeUndefined();
    // A fresh mounted facade receives no replacement authority. It observes
    // the original provider operation/allocation/restore and finalizes only
    // that exact tuple after the rolled-back terminal write.
    const freshMountedService = await ProductionPricedContinuationService.create({ pool, config: mountedPricedConfig(mountedToolchain, workspaceCommand.policyVersion), generation: core,
      capacity: mountedCapacity, checkpoint, vertexJournal, workerJournal: nativeWorkerJournal, jobJournal: nativeJobJournal,
      requestJournal: nativeRequestJournal, capacityJournal, artifactStore: nativeObjects, workers: workerClients, jobRouter: mountedRouter,
      gateway, pricing: workspacePricing });
    const freshMountedResult = await freshMountedService.resume(workspaceResume);
    expect(["completed", "failed", "reconciliation_pending"]).toContain(freshMountedResult.status);
    expect(modelPosts).toBe(3); expect(nativeRestores).toBe(1); expect(reserves).toBe(2);
    const runner = new ProductionPricedContinuationRunner(runnerInput);
    const concurrentRuns = await Promise.all([runner.run(workspaceResume), runner.run(workspaceResume)]);
    expect(concurrentRuns[0]).toEqual(concurrentRuns[1]);
    expect(concurrentRuns[0]).toEqual({ status: "reconciliation_pending", stage: "cleanup" });
    const coreTerminal = SessionActionResultSchema.parse(await executable.readTerminal());
    expect(coreTerminal).toMatchObject({ status: actualWorkerImage ? "completed" : "failed", confirmedSpend: "1", remainingCap: "198", remainingBalance: "198", sessionVersion: actualWorkerImage ? 2 : 1, artifactVersion: actualWorkerImage ? 2 : 1 });
    if (actualWorkerImage) {
      if (coreTerminal.status !== "completed" || !coreTerminal.artifactId || !localWorker) throw new Error("ACTUAL_VERIFIED_ARTIFACT_REQUIRED");
      expect(await nativeBridge().readVerifiedContinuationArtifact({ accountId, sessionId: workspaceClaim.sessionId, actionId: workspaceClaim.actionId,
        expectedVersion: 1, policyVersion: workspaceClaim.quote.context.policyVersion, workspaceId: `workspace:${workspaceClaim.sessionId}` })).toBeUndefined();
      // Terminal bridge ownership is deliberately retired. Its verified artifact
      // was read by the finalizer BEFORE that same atomic version advancement.
      expect((await admin.query("SELECT version,verified FROM production_real.session_artifacts WHERE id=$1 AND account_id=$2", [coreTerminal.artifactId, accountId])).rows[0]).toEqual({ version: 2, verified: true });
      const nativeRecords = z.array(z.object({ command: z.array(z.string()), exitCode: z.number().int(), stdout: z.string(), stderr: z.string() }).strict())
        .parse((await Bun.file(localWorker.logPath).text()).trim().split("\n").map(line => JSON.parse(line)));
      expect(nativeRecords.filter(value => value.command[1] === "start")).toHaveLength(1);
      const completedNative = nativeRecords.filter(value => value.command[1] === "status").map(value => JSON.parse(value.stdout))
        .find(value => value.state === "completed");
      const realCommands = z.object({ commands: z.array(z.object({ exitCode: z.literal(0), argv: z.array(z.string()) }).passthrough()).length(8) }).passthrough().parse(completedNative).commands;
      expect(realCommands.some(value => value.argv.includes("test:conformance"))).toBeTrue();
      if (directWorker) {
        const sealed = [...values.entries()].find(([key, value]) => key.startsWith("artifacts/") && value.checksum === coreTerminal.artifactId?.slice("artifact:".length))?.[1];
        if (!sealed) throw new Error("DIRECT_SEALED_ARTIFACT_REQUIRED");
        const reread = await readVerifiedDirectWorkerArchive(sealed.bytes, { checksum: coreTerminal.artifactId.slice("artifact:".length),
          build: { accountId, ownerId: principal.pubkey, sessionId: workspaceClaim.sessionId, actionId: workspaceClaim.actionId, expectedVersion: 1,
            proposalSha256: newProposalSha, toolchainSha256: workspaceToolchain, publication: { server: publicationServer } }, purpose: workspaceCommand.revision });
        const measuredToolchain = requireDirectToolchainReceipt(reread.receipts.toolchain);
        expect(measuredToolchain.cliBinarySha256).toBe(DIRECT_CLI_BINARY_SHA256[measuredToolchain.platform]);
        expect(bytesSha(await Bun.file("toolchains/locks/capabilities-worker/package.json").bytes())).toBe(measuredToolchain.workerPackageSha256);
        expect(bytesSha(await Bun.file("toolchains/locks/capabilities-worker/pnpm-lock.yaml").bytes())).toBe(measuredToolchain.workerLockSha256);
        expect(bytesSha(await Bun.file("toolchains/overlays/capabilities-template/package.json").bytes())).toBe(measuredToolchain.templatePackageSha256);
        expect(bytesSha(await Bun.file("toolchains/overlays/capabilities-template/pnpm-lock.yaml").bytes())).toBe(measuredToolchain.templateLockSha256);
        expect(reread.declaration).toEqual({ required: ["storage"], optional: [] });
        expect(reread).not.toHaveProperty("aggregateSha256");
        const archive = z.object({ version: z.literal(3), artifactContract: z.literal("nip5d-direct-v1"), artifactHash: z.string().regex(/^[a-f0-9]{64}$/u),
          build: z.object({ accountId: z.literal(accountId), ownerId: z.literal(principal.pubkey), actionId: z.literal(workspaceClaim.actionId), expectedVersion: z.literal(1), toolchainSha256: z.literal(workspaceToolchain) }).passthrough(),
          files: z.array(z.object({ path: z.literal("index.html"), sha256: z.string(), bytesBase64: z.string() }).strict()).length(1),
          receipts: z.object({ conformance: z.unknown(), manifest: ProductionDirectManifestReceiptSchema }).passthrough() }).passthrough()
          .parse(JSON.parse(new TextDecoder().decode(sealed.bytes)));
        expect(bytesSha(Buffer.from(archive.files[0]!.bytesBase64, "base64"))).toBe(archive.artifactHash);
        expect(archive.files[0]!.sha256).toBe(archive.artifactHash);
        const manifest = z.object({ content: z.literal(workspaceCommand.revision.trim()), artifactHash: z.literal(archive.artifactHash), tags: z.array(z.array(z.string())) }).passthrough()
          .parse(JSON.parse(Buffer.from(archive.receipts.manifest.bytesBase64, "base64").toString("utf8")));
        expect(manifest.tags.filter(tag => tag[0] === "R")).toEqual([["R", "storage"]]);
        expect(manifest.tags.filter(tag => tag[0] === "x")).toEqual([["x", archive.artifactHash]]);
        const actualConformance = verifyProductionConformanceReceipt(archive.receipts.conformance);
        expect(actualConformance.report.checks.find(check => check.id === "wire/envelope-well-formed")?.status).toBe("pass");
        console.log(JSON.stringify({ localDirectReceipt: true, releaseEvidence: false, conformance: actualConformance.report.summary, artifactHash: archive.artifactHash, measuredToolchain }));
      }
      console.log(JSON.stringify({ localActualArtifact: true, releaseEvidence: false, image: localWorker.image,
        artifactContract: actualWorkerContract, nativeLog: localWorker.logPath, nativeStarts: 1, successfulCommands: realCommands.length, artifactId: coreTerminal.artifactId }));
    }
    expect(await executable.readTerminal()).toEqual(coreTerminal);
    expect(await executable.execute(async () => { throw new Error("TERMINAL_MUST_NOT_EXECUTE_AGAIN"); })).toEqual(coreTerminal);
    await expect(runner.run({ ...workspaceResume, pricingApproval: { ...workspaceResume.pricingApproval, maximumSat: "40" } })).rejects.toThrow("IDEMPOTENCY_KEY_CONFLICT");
    expect(await new ProductionPricedContinuationRunner(runnerInput).run(workspaceResume)).toEqual({ status: "reconciliation_pending", stage: "cleanup" });
    expect((await admin.query("SELECT count(*)::int AS count FROM production_real.usage_receipts")).rows[0].count).toBe(2);
    expect((await admin.query("SELECT count(*)::int AS count FROM production_real.ledger_entries WHERE account_id=$1 AND direction='debit'", [accountId])).rows[0].count).toBe(2);
    expect((await admin.query("SELECT confirmed_spend_sat,current_verified_artifact_version,version,state FROM production_real.metered_sessions WHERE id=$1", [workspaceClaim.sessionId])).rows[0]).toEqual({ confirmed_spend_sat: "1", current_verified_artifact_version: actualWorkerImage ? 2 : 1, version: actualWorkerImage ? 2 : 1, state: actualWorkerImage ? "verified" : "failed" });
    expect((await store.findContinuationPause(accountId, workspaceClaim.sessionId, 1))?.state).toBe("completed");
    expect((await workspaceAcceptance.find(accountId, workspaceResume.idempotencyKey))?.state).toBe("completed");
    expect((await admin.query("SELECT count(*)::int AS count FROM production_real.funding_outbox WHERE event_kind='priced_continuation_terminal'")).rows[0].count).toBe(2);
    expect(modelPosts).toBe(3); expect(nativeRestores).toBe(1); expect(reserves).toBe(2);
    // The known original receipt reached the fresh facade, so this path must
    // not manufacture an ambiguity/reconciliation entry merely to recover.
    expect((await admin.query("SELECT count(*)::int AS count FROM production_real.billing_line_items WHERE source_identity=$1 AND kind='reconciliation' AND amount_sat=0", [`reconciliation:${workspaceClaim.operationId}`])).rows[0].count).toBe(0);
    // Terminal consent/result replay must survive actual command/key/object
    // erasure. The runner must not decrypt or revisit a provider after expiry.
    const completedRetentionDeadline = Date.parse(workspaceSealed.manifest.retentionUntil);
    expect((await listProductionRetentionCandidates(pool, completedRetentionDeadline - 1)).some(value => value.checkpointId === workspaceClaim.checkpointId)).toBeFalse();
    await expect(store.transact(accountId, tx => tx.tombstoneExpiredCheckpoint({ checkpointId: workspaceClaim.checkpointId,
      nowMs: completedRetentionDeadline - 1 }))).rejects.toThrow("CHECKPOINT_RETENTION_ACTIVE");
    now = completedRetentionDeadline;
    const eraseWorkspace = { checkpointId: workspaceClaim.checkpointId, accountId, sessionId: workspaceClaim.sessionId };
    const due = await listProductionRetentionCandidates(pool, now);
    expect(due.some(value => value.checkpointId === workspaceClaim.checkpointId)).toBeTrue();
    expect(due.some(value => value.checkpointId === accepted.claim.checkpointId)).toBeFalse();
    expect((await store.transact(accountId, tx => tx.tombstoneExpiredCheckpoint({ checkpointId: accepted.claim.checkpointId, nowMs: now }))).state).toBe("claimed");
    let loseCompletedDeletionAck = true;
    const retention = () => new ContinuationDeadlineReconciler({ store, worker: nativeBridge(), envelope: checkpoint,
      clock: { nowMs: () => now }, candidates: { async listDue() { return []; },
        async listRetentionDue(at) { return (await listProductionRetentionCandidates(pool, at)).filter(value => value.checkpointId === workspaceClaim.checkpointId); } },
      retention: { async destroyExpired(value) { await checkpoint.destroyExpired(value);
        if (loseCompletedDeletionAck) { loseCompletedDeletionAck = false; throw new Error("COMPLETED_DELETE_ACK_LOST"); } } } });
    expect(await retention().scanRetention()).toMatchObject([{ status: "deletion_pending", checkpointId: workspaceClaim.checkpointId }]);
    expect((await store.findContinuationCheckpoint(accountId, workspaceClaim.checkpointId))?.state).toBe("expired");
    expect(await retention().scanRetention()).toMatchObject([{ status: "expired", checkpointId: workspaceClaim.checkpointId }]);
    expect(await retention().scanRetention()).toEqual([]);
    expect((await store.findContinuationPause(accountId, workspaceClaim.sessionId, 1))?.state).toBe("completed");
    expect((await acceptance.find(accountId, workspaceResume.idempotencyKey))?.state).toBe("completed");
    expect(await checkpoint.observeDestroyed(eraseWorkspace)).toBeTrue();
    await expect(workspacePreparer.loadAcceptedAuthority({ principal: { id: accountId }, idempotencyKey: workspaceResume.idempotencyKey })).rejects.toThrow();
    const readsBeforeTerminalReplay = objectReads;
    expect(await new ProductionPricedContinuationRunner(runnerInput).run(workspaceResume)).toEqual({ status: "reconciliation_pending", stage: "cleanup" });
    expect(objectReads).toBe(readsBeforeTerminalReplay);
    expect(modelPosts).toBe(3); expect(nativeRestores).toBe(1); expect(reserves).toBe(2);
    const claimBeforeCleanup = await workspaceAcceptance.find(accountId, workspaceResume.idempotencyKey);
    const getsBeforeDeniedCleanup = cleanupGets;
    await expect(cleanup().cleanup("account:foreign", workspaceResume.idempotencyKey)).rejects.toThrow("PRICED_CLEANUP_NOT_FOUND_OR_DENIED");
    await expect(cleanup().cleanup(accountId, accepting.idempotencyKey)).rejects.toThrow("PRICED_CLEANUP_NOT_FOUND_OR_DENIED");
    const missingNativeCleanup = new ProductionPricedContinuationCleanup({ ...cleanupInput,
      workerJournal: new PostgresOperationJournal(pool, { namespace: "fixture-no-native-record", scopeSha256: "8".repeat(64) }) });
    expect(await missingNativeCleanup.cleanup(accountId, workspaceResume.idempotencyKey)).toEqual({ status: "blocked" });
    expect(cleanupGets).toBe(getsBeforeDeniedCleanup);
    expect(await cleanup().cleanup(accountId, workspaceResume.idempotencyKey)).toEqual({ status: "pending" });
    expect(nativeDeletes).toBe(0);
    expect((await metered.transact(accountId, tx => tx.findCapacityIntent(workspaceClaim.allocationIntentReference)))?.state).toBe("available");
    wrongCleanupIdentity = false;
    let loseCleanupCommit = true;
    const uncertainCleanup = new ProductionPricedContinuationCleanup({ ...cleanupInput,
      pool: sqlPool(runtime, () => { const value = loseCleanupCommit; loseCleanupCommit = false; return value; }) });
    await expect(uncertainCleanup.cleanup(accountId, workspaceResume.idempotencyKey)).rejects.toThrow("COMMIT_ACK_LOST");
    expect(loseCleanupCommit).toBeFalse();
    expect(nativeDeletes).toBe(1);
    expect((await metered.transact(accountId, tx => tx.findCapacityIntent(workspaceClaim.allocationIntentReference)))?.state).toBe("released");
    const getsAfterCleanupProof = cleanupGets;
    const cleanupReplays = await Promise.all([cleanup().cleanup(accountId, workspaceResume.idempotencyKey), cleanup().cleanup(accountId, workspaceResume.idempotencyKey)]);
    expect(cleanupReplays).toEqual([{ status: "cleaned" }, { status: "cleaned" }]);
    expect(nativeDeletes).toBe(1);
    expect(cleanupGets).toBe(getsAfterCleanupProof);
    expect((await admin.query("SELECT count(*)::int AS count FROM production_real.funding_outbox WHERE event_kind='priced_continuation_worker_cleaned'")).rows[0].count).toBe(1);
    expect(await workspaceAcceptance.find(accountId, workspaceResume.idempotencyKey)).toEqual(claimBeforeCleanup);
    expect((await admin.query("SELECT count(*)::int AS count FROM production_real.ledger_entries WHERE account_id=$1 AND direction='debit'", [accountId])).rows[0].count).toBe(2);
    expect(await nativeWorkerRecords.read(workerOperationId)).toMatchObject({ resourceId: "fixture-workspace-machine", requestSha256: "c".repeat(64), state: "terminated" });
    expect(await new ProductionPricedContinuationRunner(runnerInput).run(workspaceResume)).toEqual(coreTerminal);
    // A fresh public facade instance performs the terminal query/replay only:
    // it traverses the mounted runner but cannot redispatch the original model
    // or worker operation after its exact cleanup has completed.
    expect(await mountedService.resume(workspaceResume)).toEqual(coreTerminal);
    expect(modelPosts).toBe(3); expect(nativeRestores).toBe(1); expect(reserves).toBe(2);
    if (directWorker) {
      if (coreTerminal.status !== "completed" || !coreTerminal.artifactId) throw new Error("OWNED_DIRECT_ARTIFACT_REQUIRED");
      const readerInput = { pool, requestJournal: nativeRequestJournal,
        objects: new GcsObjectStoreAdapter({ config: { bucket: "workspace-fixture", projectId: "fixture" }, client: objectClient }),
        profiles: [{ toolchainSha256: "e".repeat(64), artifactContract: "legacy-aggregate-v1" as const }, { toolchainSha256: workspaceToolchain, artifactContract: "nip5d-direct-v1" as const }],
        publication: { server: publicationServer } };
      const ownedCommand = { principal, sessionId: workspaceClaim.sessionId, artifactId: coreTerminal.artifactId };
      const owned = () => new ProductionOwnedDirectArtifacts(readerInput).readVerified(ownedCommand);
      const allocationsBeforeReads = allocations, deletionsBeforeReads = deletions;
      const afterCleanup = await owned();
      if (!afterCleanup) throw new Error("OWNED_DIRECT_ARTIFACT_READ_REQUIRED");
      expect(afterCleanup).toMatchObject({ accountId, ownerId: principal.pubkey, artifactId: coreTerminal.artifactId, artifactVersion: 2,
        archive: { artifactContract: "nip5d-direct-v1", build: { toolchainSha256: workspaceToolchain }, declaration: { required: ["storage"], optional: [] } } });
      expect(afterCleanup?.archive).not.toHaveProperty("aggregateSha256");
      for (const changed of [{ principal: { pubkey: "8".repeat(64) } }, { sessionId: "session:foreign" }, { artifactId: `artifact:${"0".repeat(64)}` }, { accountId }]) {
        expect(await new ProductionOwnedDirectArtifacts(readerInput).readVerified({ ...ownedCommand, ...changed })).toBeUndefined();
      }
      for (const profiles of [[readerInput.profiles[0]!], [{ toolchainSha256: workspaceToolchain }],
        [...readerInput.profiles, { toolchainSha256: workspaceToolchain, artifactContract: "legacy-aggregate-v1" as const }]]) {
        expect(await new ProductionOwnedDirectArtifacts({ ...readerInput, profiles }).readVerified(ownedCommand)).toBeUndefined();
      }
      expect(await new ProductionOwnedDirectArtifacts({ ...readerInput, publication: { server: "https://other.example" } }).readVerified(ownedCommand)).toBeUndefined();
      await admin.query("UPDATE production_real.funding_accounts SET nostr_pubkey=$2 WHERE account_id=$1", [accountId, "8".repeat(64)]);
      try { expect(await owned()).toBeUndefined(); } finally { await admin.query("UPDATE production_real.funding_accounts SET nostr_pubkey=$2 WHERE account_id=$1", [accountId, principal.pubkey]); }
      await admin.query("UPDATE production_real.session_artifacts SET verified=false WHERE id=$1", [coreTerminal.artifactId]);
      try { expect(await owned()).toBeUndefined(); } finally { await admin.query("UPDATE production_real.session_artifacts SET verified=true WHERE id=$1", [coreTerminal.artifactId]); }
      await admin.query("UPDATE production_real.metered_actions SET artifact_version=3 WHERE id=$1", [workspaceClaim.actionId]);
      try { expect(await owned()).toBeUndefined(); } finally { await admin.query("UPDATE production_real.metered_actions SET artifact_version=2 WHERE id=$1", [workspaceClaim.actionId]); }
      const archived = [...values.values()].find(value => value.checksum === coreTerminal.artifactId?.slice("artifact:".length));
      if (!archived) throw new Error("OWNED_DIRECT_ARCHIVE_OBJECT_REQUIRED");
      const originalBytes = archived.bytes;
      archived.bytes = new TextEncoder().encode("{}");
      try { expect(await owned()).toBeUndefined(); } finally { archived.bytes = originalBytes; }
      const originalRequest = await nativeRequestJournal.read(`worker-request:${hash(resumedWorkerRequest)}`);
      if (!originalRequest) throw new Error("OWNED_DIRECT_ORIGINAL_REQUEST_REQUIRED");
      const substituted = await nativeRequestJournal.compareAndSet(originalRequest.operationId, originalRequest.identitySha256, originalRequest.revision,
        { request: { ...resumedWorkerRequest, idea: "Substituted persisted purpose" } });
      if (!substituted) throw new Error("OWNED_DIRECT_REQUEST_NEGATIVE_SETUP_REQUIRED");
      try { expect(await owned()).toBeUndefined(); } finally {
        if (!await nativeRequestJournal.compareAndSet(originalRequest.operationId, originalRequest.identitySha256, substituted.revision, originalRequest.value)) throw new Error("OWNED_DIRECT_REQUEST_RESTORE_REQUIRED");
      }
      expect((await owned())?.archive.checksum).toBe(coreTerminal.artifactId.slice("artifact:".length));
      // Reads survive actual checkpoint/command-key erasure and native cleanup
      // without another provider POST, restore, allocation or termination.
      expect(await checkpoint.observeDestroyed(eraseWorkspace)).toBeTrue();
      expect(modelPosts).toBe(3); expect(nativeRestores).toBe(1); expect(reserves).toBe(2); expect(nativeDeletes).toBe(1);
      expect(cleanupGets).toBe(getsAfterCleanupProof);
      expect(allocations).toBe(allocationsBeforeReads); expect(deletions).toBe(deletionsBeforeReads);
      const delivery = new ProductionDirectArtifactDelivery({ artifacts: new ProductionOwnedDirectArtifacts(readerInput), previewOrigin: "https://preview.example", artifactOrigin: "https://artifact.example" });
      const http = Bun.serve({ hostname: "127.0.0.1", port: 0, fetch(request) { return new URL(request.url).pathname.startsWith("/preview/") ? delivery.preview(request) : delivery.artifact(request); } });
      try {
        const previewPath = `/preview/nip5d-direct-v1/${encodeURIComponent(workspaceClaim.sessionId)}/${coreTerminal.artifactId}`;
        const artifactPath = `/artifacts/nip5d-direct-v1/${encodeURIComponent(workspaceClaim.sessionId)}/${coreTerminal.artifactId}/index.html`;
        const signed = await createDirectArtifactReadRequest({ url: `https://preview.example${previewPath}`, sign: event => finalizeEvent(event, directReadKey) });
        const get = (path: string, headers?: HeadersInit, method = "GET") => fetch(new URL(path, http.url), { headers, method, redirect: "error" });
        const response = await get(previewPath, signed.headers);
        expect(response.status).toBe(200);
        const verified = await verifyDirectArtifactDelivery(await response.json(), { sessionId: workspaceClaim.sessionId, artifactId: coreTerminal.artifactId });
        if (!localWorker) throw new Error("DIRECT_PREVIEW_LOCAL_WORKER_REQUIRED");
        const browserProof = await proveDirectPreviewBrowser({ worker: localWorker, delivery: verified.delivery });
        expect(browserProof).toMatchObject({ storage: true, sourceBinding: true, privateEphemeralState: true, quota: true, networkCanaries: 0, teardown: true, releaseEvidence: false });
        console.log(JSON.stringify({ localDirectPreview: browserProof }));
        expect(bytesSha(verified.bytes)).toBe(afterCleanup?.archive.artifactHash);
        expect(verified.delivery.ownerManifestTemplate).toEqual(afterCleanup?.archive.manifest);
        expect(verified.delivery).not.toHaveProperty("aggregateSha256");
        const rawSigned = await createDirectArtifactReadRequest({ url: `https://artifact.example${artifactPath}`, sign: event => finalizeEvent(event, directReadKey) });
        const raw = await get(artifactPath, rawSigned.headers);
        expect(raw.status).toBe(200); expect(bytesSha(new Uint8Array(await raw.arrayBuffer()))).toBe(verified.delivery.artifact.artifactHash);
        expect(raw.headers.get("content-security-policy")).toContain("sandbox allow-scripts;");
        expect(raw.headers.get("content-security-policy")).toContain("connect-src 'none'");
        expect(raw.headers.get("content-security-policy")).not.toContain("allow-same-origin");
        expect(raw.headers.get("cache-control")).toBe("no-store"); expect(raw.headers.get("referrer-policy")).toBe("no-referrer");
        expect(raw.headers.get("x-napplet-artifact-sha256")).toBe(verified.delivery.artifact.artifactHash);
        expect((await get(previewPath, signed.headers)).status).toBe(200); // Read-only replay.
        expect((await get(previewPath)).status).toBe(401);
        expect(await (await get("/preview/legacy")).json()).toEqual({ code: "PREVIEW_NOT_CONFIGURED" });
        expect(await (await get("/artifacts/legacy")).json()).toEqual({ code: "ARTIFACT_NOT_CONFIGURED" });
        const at = Math.floor(Date.now() / 1000), template = { kind: 27235, created_at: at, content: "", tags: [["u", `https://preview.example${previewPath}`], ["method", "GET"]] };
        for (const changed of [ { kind: 1 }, { content: "extra" }, { created_at: at - 61 }, { created_at: at + 60 },
          { tags: [["u", `https://other.example${previewPath}`], ["method", "GET"]] },
          { tags: [["u", `https://preview.example${artifactPath}`], ["method", "GET"]] },
          { tags: [["u", `https://preview.example${previewPath}`], ["method", "POST"]] },
          { tags: [...template.tags, ["u", `https://preview.example${previewPath}`]] } ]) {
          const event = finalizeEvent({ ...template, ...changed }, directReadKey);
          expect((await get(previewPath, { authorization: `Nostr ${Buffer.from(JSON.stringify(event)).toString("base64")}` })).status).toBe(401);
        }
        const invalidSignature = { ...finalizeEvent(template, directReadKey), sig: "0".repeat(128) };
        expect((await get(previewPath, { authorization: `Nostr ${Buffer.from(JSON.stringify(invalidSignature)).toString("base64")}` })).status).toBe(401);
        const foreign = await createDirectArtifactReadRequest({ url: `https://preview.example${previewPath}`, sign: event => finalizeEvent(event, new Uint8Array(32).fill(12)) });
        expect((await get(previewPath, foreign.headers)).status).toBe(404);
        expect((await get(`${previewPath}?token=refused`, signed.headers)).status).toBe(404);
        expect((await get(previewPath, signed.headers, "POST")).status).toBe(404);
        const preflight = await get(previewPath, { origin: "https://client.example", "access-control-request-method": "GET", "access-control-request-headers": "Authorization" }, "OPTIONS");
        expect(preflight.status).toBe(204); expect(preflight.headers.get("access-control-allow-headers")).toBe("Authorization");
        const bodyHeaders = new Headers(signed.headers); bodyHeaders.set("content-length", "1");
        expect((await delivery.preview(new Request(signed.url, { headers: bodyHeaders }))).status).toBe(404);
        const substitutedBytes = { ...verified.delivery, entrypoint: { ...verified.delivery.entrypoint, bytesBase64: Buffer.from("changed").toString("base64") } };
        await expect(verifyDirectArtifactDelivery(substitutedBytes, { sessionId: workspaceClaim.sessionId, artifactId: coreTerminal.artifactId })).rejects.toThrow("DELIVERY_MISMATCH");
        let publicationNow = Date.now(), losePublicationCommit = true;
        const publicationNamespace = "fixture-direct-publication";
        const publicationPool: PostgresSqlPool = { async connect() {
          const client = await pool.connect(); let inserted = false;
          return { async query<Row extends Record<string, unknown>>(sql: string, parameters?: readonly unknown[]) {
            const result = await client.query<Row>(sql, parameters);
            if (sql.startsWith("INSERT INTO production_real.release_operation_journal") && parameters?.[0] === publicationNamespace) inserted = true;
            if (sql === "COMMIT" && inserted && losePublicationCommit) { losePublicationCommit = false; throw new Error("PUBLICATION_COMMIT_ACK_LOST"); }
            return result;
          }, release() { client.release(); } };
        } };
        const publicationInput = { artifacts: new ProductionOwnedDirectArtifacts(readerInput),
          journal: new PostgresOperationJournal(publicationPool, { namespace: publicationNamespace, scopeSha256: "5".repeat(64) }),
          publication: { server: publicationServer }, relays: [publicationRelay], now: () => publicationNow };
        const publications = () => new ProductionDirectPublicationIntents(publicationInput);
        const publicArtifact = { principal, sessionId: workspaceClaim.sessionId, artifactId: coreTerminal.artifactId };
        const review = await publications().review(publicArtifact);
        expect(review.ownerManifestTemplate).toEqual(verified.delivery.ownerManifestTemplate);
        expect(review.file).toEqual({ path: "/index.html", mimeType: "text/html", sha256: verified.delivery.artifact.artifactHash, size: verified.bytes.length });
        const publishCommand = { ...publicArtifact, idempotencyKey: "direct-publication:first", approval: { consent: "approved", reviewSha256: review.reviewSha256 } };
        const prepared = await Promise.all([publications().prepare(publishCommand), publications().prepare(publishCommand)]);
        expect(prepared[0]).toEqual(prepared[1]); expect(losePublicationCommit).toBeFalse();
        const publicationIntent = prepared[0]!;
        expect(await publications().readOriginal({ principal, idempotencyKey: publishCommand.idempotencyKey })).toEqual(publicationIntent);
        expect(await publications().loadCurrentForSigning({ principal, idempotencyKey: publishCommand.idempotencyKey })).toEqual(publicationIntent);
        expect(publicationIntent.review).not.toHaveProperty("aggregateSha256");
        await expect(publications().prepare({ ...publishCommand, approval: { ...publishCommand.approval, reviewSha256: "0".repeat(64) } })).rejects.toThrow("IDEMPOTENCY_CONFLICT");
        await expect(publications().prepare({ ...publishCommand, idempotencyKey: "direct-publication:stale", approval: { ...publishCommand.approval, reviewSha256: "0".repeat(64) } })).rejects.toThrow("APPROVAL_REQUIRED");
        await expect(publications().prepare({ ...publishCommand, idempotencyKey: "direct-publication:declined", approval: { ...publishCommand.approval, consent: "declined" } })).rejects.toThrow();
        await expect(publications().prepare({ ...publishCommand, servers: ["https://caller.example"] })).rejects.toThrow();
        const owner = { principal, idempotencyKey: publishCommand.idempotencyKey };
        const changedTargets = new ProductionDirectPublicationIntents({ ...publicationInput, relays: ["wss://other.example"] });
        expect(await changedTargets.readOriginal(owner)).toEqual(publicationIntent);
        await expect(changedTargets.loadCurrentForSigning(owner)).rejects.toThrow("INTENT_STALE");
        const foreignOwner = { principal: { pubkey: getPublicKey(new Uint8Array(32).fill(12)) }, idempotencyKey: publishCommand.idempotencyKey };
        expect(await publications().readOriginal(foreignOwner)).toBeUndefined();
        await expect(publications().review({ ...publicArtifact, principal: foreignOwner.principal })).rejects.toThrow("NOT_FOUND_OR_DENIED");
        const bunker = openDirectNip46Fixture(directReadKey, () => publicationNow);
        closeDirectBunker = bunker.close;
        const signingRequest = await createAuthorizationRequest({ candidateSha256: "a".repeat(64), topologySha256: "b".repeat(64), effectPlanSha256: "c".repeat(64),
          controllerStateSha256: "d".repeat(64), providerCapabilitiesSha256: "e".repeat(64),
          orderedEffects: [{ id: "direct-owner-signing", provider: "signer", operation: "verify_integration", estimatedCostMicros: 1 }, { id: "sealed-upload", provider: "upload", operation: "verify_integration", estimatedCostMicros: 1 }, { id: "owner-relay", provider: "owner_relay", operation: "verify_integration", estimatedCostMicros: 1 }, { id: "attestation-relay", provider: "attestation_relay", operation: "verify_integration", estimatedCostMicros: 1 }],
          providerScopes: [{ provider: "signer", accountScopeSha256: "f".repeat(64), projectScopeSha256: "0".repeat(64) }, { provider: "upload", accountScopeSha256: "f".repeat(64), projectScopeSha256: "0".repeat(64) }, { provider: "owner_relay", accountScopeSha256: "f".repeat(64), projectScopeSha256: "0".repeat(64) }, { provider: "attestation_relay", accountScopeSha256: "f".repeat(64), projectScopeSha256: "0".repeat(64) }],
          estimate: { currency: "USD", maximumMicros: 4, sourceId: "local-signing-fixture", observedAtMs: publicationNow - 1, freshUntilMs: publicationNow + 20_000 },
          maximumRunDurationMs: 1000, cleanupByMs: publicationNow + 9000, evidenceRetentionDays: 30, artifactRetentionDays: 30,
          gcpEffects: { projectBootstrap: false, billing: false, apiEnablement: ["storage.googleapis.com"] }, expiresAtMs: publicationNow + 10_000 });
        const signingReceipt = await createAuthorizationReceipt(signingRequest);
        const openDirectSigner = (intents = publications(), signingOwner = owner) => openProductionDirectCertificationNip46Signer({ intents, owner: signingOwner,
          bunkerUri: bunker.bunkerUri, sessionKeyReference: bunker.sessionKeyReference, sessionKeyBroker: bunker.sessionKeyBroker,
          journal: new PostgresOperationJournal(pool, { namespace: "direct-nip46-fixture", scopeSha256: "6".repeat(64) }),
          authorization: { request: signingRequest, receipt: signingReceipt, authorizationRequestSha256: signingRequest.authorizationRequestSha256, authorizationReceiptSha256: signingReceipt.authorizationReceiptSha256 },
          timeoutMs: 1000, now: () => publicationNow });
        const staleSigner = await openDirectSigner(changedTargets);
        try { await expect(staleSigner.signOwnerManifest()).rejects.toThrow("INTENT_STALE"); } finally { await staleSigner.close(); }
        expect(bunker.requests).toHaveLength(0);
        let remoteSigner = await openDirectSigner(); closeDirectSigner = () => remoteSigner.close();
        await expect(remoteSigner.observeOwnerSignature()).rejects.toThrow("ORIGINAL_SIGNING_NOT_FOUND");
        await expect(remoteSigner.observeUploadSignature()).rejects.toThrow("NOT_FOUND_OR_DENIED");
        expect(bunker.requests).toHaveLength(0);
        bunker.hideSigningResponses(true);
        await expect(remoteSigner.signOwnerManifest()).rejects.toThrow("SIGNING_OUTCOME_UNKNOWN");
        expect(bunker.requests.map(value => value.method)).toEqual(["connect", "get_public_key", "sign_event"]);
        await remoteSigner.close(); remoteSigner = await openDirectSigner();
        bunker.hideSigningResponses(false);
        let manifestSigns = 0;
        const ownerEvent = await signDirectPublicationIntent({ intent: publicationIntent,
          expected: { intentId: publicationIntent.intentId, reviewSha256: review.reviewSha256, ownerPubkey: principal.pubkey },
          async sign(template) { manifestSigns++; expect(template).toEqual(publicationIntent.review.ownerManifestTemplate);
            return z.object({ event: SignedOwnerManifestEventSchema }).passthrough().parse(await remoteSigner.observeOwnerSignature()).event; } });
        expect(manifestSigns).toBe(1); expect(ownerEvent.pubkey).toBe(principal.pubkey);
        await expect(changedTargets.acceptOwnerEvent({ ...owner, event: ownerEvent })).rejects.toThrow("INTENT_STALE");
        losePublicationCommit = true;
        const acceptedOwners = await Promise.all([publications().acceptOwnerEvent({ ...owner, event: ownerEvent }), publications().acceptOwnerEvent({ ...owner, event: ownerEvent })]);
        expect(acceptedOwners[0]).toEqual(acceptedOwners[1]); expect(losePublicationCommit).toBeFalse();
        const repeatedSignature = finalizeEvent(structuredClone(publicationIntent.review.ownerManifestTemplate), directReadKey);
        expect((await publications().acceptOwnerEvent({ ...owner, event: repeatedSignature })).event.sig).toBe(ownerEvent.sig);
        expect((await publications().readAcceptedOwner(owner))?.event.id).toBe(ownerEvent.id);
        await expect(publications().acceptOwnerEvent({ ...foreignOwner, event: ownerEvent })).rejects.toThrow("NOT_FOUND_OR_DENIED");
        await expect(publications().acceptOwnerEvent({ ...owner, event: finalizeEvent({ ...structuredClone(publicationIntent.review.ownerManifestTemplate), content: "substituted" }, directReadKey) })).rejects.toThrow("OWNER_EVENT_REQUIRED");
        losePublicationCommit = true;
        const uploadPreparations = await Promise.all([publications().prepareUploadAuthorization(owner), publications().prepareUploadAuthorization(owner)]);
        const uploadAuthorization = uploadPreparations[0]!;
        expect(uploadPreparations[1]).toEqual(uploadAuthorization); expect(losePublicationCommit).toBeFalse();
        expect(uploadAuthorization.artifactHash).toBe(review.artifact.artifactHash);
        expect(uploadAuthorization.archiveSha256).toBe(review.artifact.archiveSha256);
        expect(uploadAuthorization.ownerEventId).toBe(ownerEvent.id);
        expect(await publications().loadUploadAuthorizationForSigning(owner)).toEqual(uploadAuthorization);
        await expect(changedTargets.loadUploadAuthorizationForSigning(owner)).rejects.toThrow("INTENT_STALE");
        expect(uploadAuthorization.template.tags).toContainEqual(["x", review.artifact.artifactHash]);
        expect(await publications().readUploadAuthorization(foreignOwner)).toBeUndefined();
        let uploadSigns = 0;
        const expectedUpload = { authorizationSha256: uploadAuthorization.authorizationSha256, intentId: publicationIntent.intentId, reviewSha256: review.reviewSha256, ownerPubkey: principal.pubkey };
        await expect(signDirectUploadAuthorization({ intent: publicationIntent, authorization: uploadAuthorization, expected: { ...expectedUpload, authorizationSha256: "0".repeat(64) },
          sign(template) { uploadSigns++; return finalizeEvent(template, directReadKey); } })).rejects.toThrow("APPROVED_AUTHORIZATION_REQUIRED");
        expect(uploadSigns).toBe(0);
        const uploadEvent = await signDirectUploadAuthorization({ intent: publicationIntent, authorization: uploadAuthorization, expected: expectedUpload,
          async sign(template) { uploadSigns++; expect(template).toEqual(uploadAuthorization.template);
            return z.object({ event: DirectUploadAuthorizationEventSchema }).passthrough().parse(await remoteSigner.signUploadAuthorization()).event; } });
        expect(uploadSigns).toBe(1);
        expect(bunker.requests.map(value => value.method)).toEqual(["connect", "get_public_key", "sign_event", "sign_event"]);
        await expect(changedTargets.acceptUploadAuthorization({ ...owner, event: uploadEvent })).rejects.toThrow("INTENT_STALE");
        await expect(publications().acceptUploadAuthorization({ ...foreignOwner, event: uploadEvent })).rejects.toThrow("NOT_FOUND_OR_DENIED");
        await expect(publications().acceptUploadAuthorization({ ...owner, event: finalizeEvent({ ...uploadAuthorization.template, tags: uploadAuthorization.template.tags.filter(tag => tag[0] !== "x") }, directReadKey) })).rejects.toThrow("EVENT_REQUIRED");
        losePublicationCommit = true;
        const uploadAccepted = await Promise.all([publications().acceptUploadAuthorization({ ...owner, event: uploadEvent }), publications().acceptUploadAuthorization({ ...owner, event: uploadEvent })]);
        expect(uploadAccepted[0]).toEqual(uploadAccepted[1]); expect(losePublicationCommit).toBeFalse();
        const repeatedUpload = finalizeEvent(structuredClone(uploadAuthorization.template), directReadKey);
        expect((await publications().acceptUploadAuthorization({ ...owner, event: repeatedUpload })).event.sig).toBe(uploadEvent.sig);
        expect((await publications().readAcceptedUploadAuthorization(owner))?.event.id).toBe(uploadEvent.id);
        let loseUploadContextCommit = true;
        const uploadNamespace = "direct-upload-composition";
        const uploadPool: PostgresSqlPool = { async connect() { const client = await pool.connect(); let contextClaim = false;
          return { async query<Row extends Record<string, unknown>>(sql: string, parameters?: readonly unknown[]) {
            const result = await client.query<Row>(sql, parameters);
            if (sql.startsWith("INSERT INTO production_real.release_operation_journal") && parameters?.[0] === uploadNamespace && String(parameters?.[2]).startsWith("direct-certification-upload:v1:")) contextClaim = true;
            if (sql === "COMMIT" && contextClaim && loseUploadContextCommit) { loseUploadContextCommit = false; throw new Error("UPLOAD_CONTEXT_COMMIT_ACK_LOST"); }
            return result;
          }, release() { client.release(); } };
        } };
        const uploadInput = { intents: publications(), artifacts: new ProductionOwnedDirectArtifacts(readerInput), owner,
          binding: { candidateSha256: signingRequest.candidateSha256, topologySha256: signingRequest.topologySha256, effectPlanSha256: signingRequest.effectPlanSha256,
            accountScopeSha256: "f".repeat(64), projectScopeSha256: "0".repeat(64) },
          targetReference: "fixture:direct-tls-server", authorization: { request: signingRequest, receipt: signingReceipt },
          journal: new PostgresOperationJournal(uploadPool, { namespace: uploadNamespace, scopeSha256: "8".repeat(64) }), now: () => publicationNow, timeoutMs: 1000 };
        expect(await new ProductionDirectCertificationUpload(uploadInput).reconcile()).toMatchObject({ state: "unknown" });
        expect((await admin.query("SELECT count(*)::int AS count FROM production_real.release_operation_journal WHERE namespace=$1", [uploadNamespace])).rows[0].count).toBe(0);
        await expect(new ProductionDirectCertificationUpload({ ...uploadInput, intents: changedTargets }).upload()).rejects.toThrow("INTENT_STALE");
        await expect(new ProductionDirectCertificationUpload({ ...uploadInput, owner: foreignOwner }).upload()).rejects.toThrow("NOT_FOUND_OR_DENIED");
        expect(uploadPuts).toBe(0); expect(uploadGets).toBe(0);
        const uploadOutcomes = await Promise.allSettled([new ProductionDirectCertificationUpload(uploadInput).upload(), new ProductionDirectCertificationUpload(uploadInput).upload()]);
        expect(uploadOutcomes.some(outcome => outcome.status === "fulfilled" && outcome.value.state === "complete")).toBeTrue();
        expect(loseUploadContextCommit).toBeFalse(); expect(uploadPuts).toBe(1);
        expect(await new ProductionDirectCertificationUpload(uploadInput).reconcile()).toMatchObject({ state: "complete", fullServerUploadId: `${publicationServer}/${review.artifact.artifactHash}` });
        expect(uploadedBlobs.get(review.artifact.artifactHash)).toEqual(verified.bytes);
        expect(await new ProductionDirectCertificationUpload(uploadInput).upload()).toMatchObject({ state: "complete" });
        expect(uploadPuts).toBe(1);
        await expect(new ProductionDirectCertificationUpload({ ...uploadInput, targetReference: "substituted" }).reconcile()).rejects.toThrow("ORIGINAL_MISMATCH");
        const renewedRequest = await createAuthorizationRequest({ candidateSha256: signingRequest.candidateSha256, topologySha256: signingRequest.topologySha256,
          effectPlanSha256: signingRequest.effectPlanSha256, controllerStateSha256: "1".repeat(64), providerCapabilitiesSha256: signingRequest.providerCapabilitiesSha256,
          orderedEffects: signingRequest.orderedEffects, providerScopes: signingRequest.providerScopes,
          estimate: { currency: "USD", maximumMicros: signingRequest.maximumAuthorizedCostMicros, sourceId: signingRequest.estimateSourceId, observedAtMs: signingRequest.estimateObservedAtMs, freshUntilMs: signingRequest.estimateFreshUntilMs },
          maximumRunDurationMs: signingRequest.maximumRunDurationMs, cleanupByMs: signingRequest.cleanupByMs, evidenceRetentionDays: signingRequest.evidenceRetentionDays,
          artifactRetentionDays: signingRequest.artifactRetentionDays, gcpEffects: signingRequest.gcpEffects, expiresAtMs: signingRequest.expiresAtMs });
        const renewedReceipt = await createAuthorizationReceipt(renewedRequest);
        await expect(new ProductionDirectCertificationUpload({ ...uploadInput, authorization: { request: renewedRequest, receipt: renewedReceipt } }).upload()).rejects.toThrow("ORIGINAL_MISMATCH");
        expect(uploadPuts).toBe(1);
        let directServiceSigns = 0;
        class MeasuredDirectSigner extends ProductionBuildAttestationSigner {
          override async signDirectBuild(value: unknown) { directServiceSigns++; return super.signDirectBuild(value); }
        }
        const directServiceSigner = new MeasuredDirectSigner(new Uint8Array(32).fill(23)); closeAttestationSigner = () => directServiceSigner.close();
        let loseRelayCommit = true;
        const relayNamespace = "direct-relay-composition";
        const relayPool: PostgresSqlPool = { async connect() { const client = await pool.connect(); let inserted = false;
          return { async query<Row extends Record<string, unknown>>(sql: string, parameters?: readonly unknown[]) {
            const result = await client.query<Row>(sql, parameters);
            if (sql.startsWith("INSERT INTO production_real.release_operation_journal") && parameters?.[0] === relayNamespace) inserted = true;
            if (sql === "COMMIT" && inserted && loseRelayCommit) { loseRelayCommit = false; throw new Error("DIRECT_RELAY_COMMIT_ACK_LOST"); }
            return result;
          }, release() { client.release(); } };
        } };
        const relayInput = { intents: publications(), upload: new ProductionDirectCertificationUpload(uploadInput), owner,
          binding: { candidateSha256: signingRequest.candidateSha256, topologySha256: signingRequest.topologySha256, effectPlanSha256: signingRequest.effectPlanSha256,
            ownerAccountScopeSha256: "f".repeat(64), ownerProjectScopeSha256: "0".repeat(64), attestationAccountScopeSha256: "f".repeat(64), attestationProjectScopeSha256: "0".repeat(64) },
          signer: directServiceSigner, authorization: { request: signingRequest, receipt: signingReceipt },
          journal: new PostgresOperationJournal(relayPool, { namespace: relayNamespace, scopeSha256: "2".repeat(64) }), now: () => publicationNow, timeoutMs: 1000 };
        const factoryInput = { settings: { artifactContract: "nip5d-direct-v1" as const, candidateSha256: signingRequest.candidateSha256, topologySha256: signingRequest.topologySha256,
            ownerPubkey: principal.pubkey, toolchainSha256: review.artifact.toolchainSha256, policyVersion: review.artifact.policyVersion,
            server: publicationServer, relays: [publicationRelay], targetReference: uploadInput.targetReference, sessionKeyReference: bunker.sessionKeyReference },
          intents: publications(), artifacts: new ProductionOwnedDirectArtifacts(readerInput),
          journals: { signer: new PostgresOperationJournal(pool, { namespace: "direct-nip46-fixture", scopeSha256: "6".repeat(64) }), upload: uploadInput.journal, relay: relayInput.journal },
          material: { bunkerUri: bunker.bunkerUri, nip46SessionKeyBroker: bunker.sessionKeyBroker, attestationSigner: directServiceSigner },
          authorization: { request: signingRequest, receipt: signingReceipt, authorizationRequestSha256: signingRequest.authorizationRequestSha256, authorizationReceiptSha256: signingReceipt.authorizationReceiptSha256 },
          now: () => publicationNow, timeoutMs: 1000 };
        const directFactory = new ProductionDirectPublicationFactory(factoryInput); closeDirectFactory = () => directFactory.close();
        const openCommand = { ...owner, intentId: publicationIntent.intentId, reviewSha256: review.reviewSha256 };
        const requestsBeforeFactory = bunker.requests.length;
        await expect(directFactory.open({ ...openCommand, principal: foreignOwner.principal })).rejects.toThrow("CONFIGURED_OWNER_REQUIRED");
        await expect(directFactory.open({ ...openCommand, reviewSha256: "0".repeat(64) })).rejects.toThrow("APPROVED_ORIGINAL_REQUIRED");
        const wrongProfileFactory = new ProductionDirectPublicationFactory({ ...factoryInput, settings: { ...factoryInput.settings, toolchainSha256: "0".repeat(64) } });
        try { await expect(wrongProfileFactory.open(openCommand)).rejects.toThrow("CONFIGURED_ARTIFACT_REQUIRED"); } finally { await wrongProfileFactory.close(); }
        const factoryActor = await directFactory.open(openCommand);
        const measuredSource = await factoryActor.source();
        expect(measuredSource).toMatchObject({ status: "verified-source-bytes", artifactContract: "nip5d-direct-v1", candidateSha256: signingRequest.candidateSha256,
          artifactHash: review.artifact.artifactHash, archiveSha256: review.artifact.archiveSha256, productionPromotion: "not_asserted" });
        expect(measuredSource.toolchain.cliBinarySha256).toBe(DIRECT_CLI_BINARY_SHA256[measuredSource.toolchain.platform]);
        const directCertification = new ProductionDirectPublicationCertification(directFactory, owner, signingRequest.candidateSha256, signingRequest.topologySha256);
        const directSource = await directCertification.source();
        expect(directSource.original).toEqual(openCommand);
        await expect(directCertification.observeSubmit(directSource)).rejects.toThrow("ORIGINAL_UNRESOLVED");
        await expect(directCertification.submit({ ...directSource, archiveSha256: "0".repeat(64) })).rejects.toThrow("SOURCE_BINDING_REQUIRED");
        const fixtureOnly = await runLivePublicationCertification({ candidate: { id: signingRequest.candidateSha256, provider: "modal", image: `registry.example/worker@sha256:${"0".repeat(64)}`, sourceSha256: "1".repeat(64) },
          observationPort: { artifactContract: "nip5d-direct-v1", evidenceClass: "deterministic", async verifyPromotedSource() { throw new Error("FIXTURE_CANNOT_BE_LIVE_EVIDENCE"); },
            async submitOriginalPublication() { throw new Error("FIXTURE_CANNOT_BE_LIVE_EVIDENCE"); }, async reconcileOriginalPublication() { throw new Error("FIXTURE_CANNOT_BE_LIVE_EVIDENCE"); } } });
        expect(fixtureOnly.status).toBe("blocked"); expect(fixtureOnly.claims).toEqual([]);
        expect(bunker.requests).toHaveLength(requestsBeforeFactory);
        let releaseOpenings = () => {}, allKeysRequested = () => {};
        const openingGate = new Promise<void>(resolve => { releaseOpenings = resolve; });
        const openingReady = new Promise<void>(resolve => { allKeysRequested = resolve; });
        let keyRequests = 0;
        const cappedFactory = new ProductionDirectPublicationFactory({ ...factoryInput, material: { ...factoryInput.material, nip46SessionKeyBroker: {
          async resolve() { keyRequests++; if (keyRequests === 32) allKeysRequested(); await openingGate; return bunker.sessionKeyBroker.resolve(); },
        } } });
        const cappedResults = Promise.allSettled(Array.from({ length: 33 }, () => cappedFactory.open(openCommand)));
        await openingReady; releaseOpenings();
        const opened = await cappedResults;
        try {
          expect(opened.filter(result => result.status === "fulfilled")).toHaveLength(32);
          expect(opened.filter(result => result.status === "rejected")).toHaveLength(1);
          expect(keyRequests).toBe(32);
        } finally { await cappedFactory.close(); }
        let releaseLateKey = () => {}, lateKeyRequested = () => {};
        const lateGate = new Promise<void>(resolve => { releaseLateKey = resolve; });
        const lateReady = new Promise<void>(resolve => { lateKeyRequested = resolve; });
        const closingFactory = new ProductionDirectPublicationFactory({ ...factoryInput, material: { ...factoryInput.material, nip46SessionKeyBroker: {
          async resolve() { lateKeyRequested(); await lateGate; return bunker.sessionKeyBroker.resolve(); },
        } } });
        const lateOpen = closingFactory.open(openCommand);
        await lateReady; await closingFactory.close(); releaseLateKey();
        await expect(lateOpen).rejects.toThrow("FACTORY_CLOSED");
        expect(bunker.requests).toHaveLength(requestsBeforeFactory);
        expect(JSON.stringify(directFactory)).not.toContain("fixture-direct-consent");
        expect(JSON.stringify(directFactory)).not.toContain("bunker:");
        expect(z.object({ event: SignedOwnerManifestEventSchema }).passthrough().parse(await factoryActor.observeOwnerSignature()).event.id).toBe(ownerEvent.id);
        expect(z.object({ event: DirectUploadAuthorizationEventSchema }).passthrough().parse(await factoryActor.observeUploadSignature()).event.id).toBe(uploadEvent.id);
        expect(bunker.requests).toHaveLength(requestsBeforeFactory);
        expect(await new ProductionDirectCertificationRelays(relayInput).reconcileOwner()).toMatchObject({ state: "unknown" });
        await expect(new ProductionDirectCertificationRelays(relayInput).publishAttestation()).rejects.toThrow("OWNER_OBSERVATION_REQUIRED");
        expect(directServiceSigns).toBe(0); expect(relayPublishes).toHaveLength(0);
        await expect(new ProductionDirectCertificationRelays({ ...relayInput, intents: changedTargets }).publishOwner()).rejects.toThrow("INTENT_STALE");
        await expect(new ProductionDirectCertificationRelays({ ...relayInput, owner: foreignOwner }).publishOwner()).rejects.toThrow();
        expect(await new ProductionDirectCertificationRelays(relayInput).reconcile()).toMatchObject({ state: "partial", stage: "owner" });
        hideOwnerObservation = true;
        await Promise.allSettled([factoryActor.publishOwner(), new ProductionDirectCertificationRelays(relayInput).publishOwner()]);
        expect(loseRelayCommit).toBeFalse(); expect(relayPublishes).toEqual([ownerEvent.id]);
        expect(await new ProductionDirectCertificationRelays(relayInput).publishOwner()).toMatchObject({ state: "unknown", eventId: ownerEvent.id });
        await expect(new ProductionDirectCertificationRelays(relayInput).publishAttestation()).rejects.toThrow("OWNER_OBSERVATION_REQUIRED");
        expect(directServiceSigns).toBe(0); expect(relayPublishes).toHaveLength(1);
        hideOwnerObservation = false;
        expect(await new ProductionDirectCertificationRelays(relayInput).reconcileOwner()).toMatchObject({ state: "complete", eventId: ownerEvent.id });
        hideAttestationObservation = true;
        const attestationPublished = await factoryActor.publishAttestation();
        expect(attestationPublished).toMatchObject({ state: "unknown" }); expect(directServiceSigns).toBe(1);
        expect(relayPublishes).toHaveLength(2);
        expect(await new ProductionDirectCertificationRelays(relayInput).publishAttestation()).toMatchObject({ state: "unknown", eventId: attestationPublished.eventId });
        expect(directServiceSigns).toBe(1); expect(relayPublishes).toHaveLength(2);
        expect(await new ProductionDirectCertificationRelays(relayInput).reconcile()).toMatchObject({ state: "partial", stage: "attestation" });
        const attestationEvent = publishedRelayEvents.get(attestationPublished.eventId!);
        if (!attestationEvent) throw new Error("DIRECT_ATTESTATION_NOT_RETAINED");
        expect(verifyEvent(attestationEvent)).toBeTrue(); expect(attestationEvent.pubkey).toBe(directServiceSigner.publicKey);
        expect(attestationEvent.pubkey).not.toBe(ownerEvent.pubkey);
        const directAttestation = DirectCvmBuildAttestationSchema.parse(JSON.parse(attestationEvent.content));
        expect(directAttestation.ownerEventId).toBe(ownerEvent.id); expect(directAttestation.artifact.archiveSha256).toBe(review.artifact.archiveSha256);
        expect(directAttestation.artifact.artifactHash).toBe(review.artifact.artifactHash);
        expect(attestationEvent.content).not.toContain("aggregate");
        expect(attestationEvent.tags).toContainEqual(["x", review.artifact.artifactHash]);
        hideAttestationObservation = false;
        expect(await new ProductionDirectCertificationRelays(relayInput).reconcileAttestation()).toMatchObject({ state: "complete", eventId: attestationEvent.id });
        await expect(new ProductionDirectCertificationRelays({ ...relayInput, authorization: { request: renewedRequest, receipt: renewedReceipt } }).publishOwner()).rejects.toThrow("BINDING_REQUIRED");
        expect(relayPublishes).toHaveLength(2);
        expect(await factoryActor.publish()).toMatchObject({ state: "complete", artifactHash: review.artifact.artifactHash,
          archiveSha256: review.artifact.archiveSha256, ownerEventId: ownerEvent.id, attestationEventId: attestationEvent.id, locationReference: `${publicationServer}/${review.artifact.artifactHash}` });
        const directSubmitted = await directCertification.submit(directSource);
        expect(directSubmitted).toMatchObject({ artifactHash: review.artifact.artifactHash, archiveSha256: review.artifact.archiveSha256, ownerEventId: ownerEvent.id, attestationEventId: attestationEvent.id });
        expect(await directCertification.reconcile(directSubmitted)).toMatchObject({ status: "complete", originalOperationsOnly: true });
        expect(await directCertification.observeSubmit(directSource)).toEqual(directSubmitted);
        await expect(directCertification.reconcile({ ...directSubmitted, ownerEventId: "0".repeat(64) })).rejects.toThrow("ORIGINAL_UNRESOLVED");
        expect(directServiceSigns).toBe(1); expect(relayPublishes).toHaveLength(2); expect(uploadPuts).toBe(1);
        hideOwnerObservation = true;
        expect(await new ProductionDirectCertificationRelays(relayInput).reconcile()).toMatchObject({ state: "partial", stage: "owner" });
        hideOwnerObservation = false;
        const retainedBlob = uploadedBlobs.get(review.artifact.artifactHash);
        if (!retainedBlob) throw new Error("DIRECT_UPLOAD_BLOB_NOT_RETAINED");
        uploadedBlobs.delete(review.artifact.artifactHash);
        expect(await new ProductionDirectCertificationRelays(relayInput).reconcile()).toMatchObject({ state: "partial", stage: "upload" });
        uploadedBlobs.set(review.artifact.artifactHash, retainedBlob);
        // Expiry/stale authority after durable dispatch fencing must block
        // the actual relay publish and leave permanent query-only recovery.
        let guardChecks = 0;
        const guardInput = { bunkerUri: bunker.bunkerUri, sessionKeyReference: bunker.sessionKeyReference, sessionKeyBroker: bunker.sessionKeyBroker,
          journal: new PostgresOperationJournal(pool, { namespace: "direct-nip46-fixture", scopeSha256: "6".repeat(64) }),
          authorization: { request: signingRequest, receipt: signingReceipt, authorizationRequestSha256: signingRequest.authorizationRequestSha256, authorizationReceiptSha256: signingReceipt.authorizationReceiptSha256 },
          context: { async resolve() { return { operationId: "direct-guard:fenced", ownerPubkey: principal.pubkey, capabilities: ["sign_event"], template: publicationIntent.review.ownerManifestTemplate, expiresAtMs: publicationIntent.expiresAtMs }; } },
          timeoutMs: 1000, now: () => publicationNow };
        const guardDigest = "9".repeat(64), requestsBeforeGuard = bunker.requests.length;
        const guarded = await openProductionNip46Signer({ ...guardInput, async authorizeFreshSigning() { guardChecks++; if (guardChecks === 4) throw new Error("FIXTURE_STALE_AFTER_CAS"); } });
        try { await expect(guarded.signExactIntent({ intentDigest: guardDigest })).rejects.toThrow("FIXTURE_STALE_AFTER_CAS"); } finally { await guarded.close(); }
        expect(guardChecks).toBe(4); expect(bunker.requests).toHaveLength(requestsBeforeGuard);
        const guardRecovery = await openProductionNip46Signer(guardInput);
        try { await expect(guardRecovery.signExactIntent({ intentDigest: guardDigest })).rejects.toThrow("SIGNING_OUTCOME_UNKNOWN"); } finally { await guardRecovery.close(); }
        expect(bunker.requests).toHaveLength(requestsBeforeGuard);
        const unsigned = await publications().prepare({ ...publishCommand, idempotencyKey: "direct-publication:unsigned" });
        const pendingUploadOwner = { principal, idempotencyKey: "direct-publication:pending-upload" };
        const pendingIntent = await publications().prepare({ ...publishCommand, idempotencyKey: pendingUploadOwner.idempotencyKey });
        await expect(publications().prepareUploadAuthorization(pendingUploadOwner)).rejects.toThrow("ACCEPTED_OWNER_REQUIRED");
        await publications().acceptOwnerEvent({ ...pendingUploadOwner, event: ownerEvent });
        const pendingUpload = await publications().prepareUploadAuthorization(pendingUploadOwner);
        let pendingRemote = await openDirectSigner(publications(), pendingUploadOwner);
        closeDirectSigner = async () => { await remoteSigner.close(); await pendingRemote.close(); };
        bunker.hideSigningResponses(true);
        await expect(pendingRemote.signUploadAuthorization()).rejects.toThrow("SIGNING_OUTCOME_UNKNOWN");
        await pendingRemote.close();
        bunker.hideSigningResponses(false);
        publicationNow = Math.max(publicationIntent.expiresAtMs, unsigned.expiresAtMs, pendingIntent.expiresAtMs);
        await expect(publications().acceptOwnerEvent({ principal, idempotencyKey: "direct-publication:unsigned", event: ownerEvent })).rejects.toThrow("INTENT_EXPIRED");
        expect(await publications().readAcceptedOwner({ principal, idempotencyKey: "direct-publication:unsigned" })).toBeUndefined();
        await expect(publications().loadCurrentForSigning(owner)).rejects.toThrow("INTENT_EXPIRED");
        expect(await publications().prepare(publishCommand)).toEqual(publicationIntent); // Historical observation, no new authority.
        expect((await publications().readAcceptedOwner(owner))?.event.id).toBe(ownerEvent.id);
        expect((await publications().acceptOwnerEvent({ ...owner, event: ownerEvent })).event.id).toBe(ownerEvent.id);
        expect(await new ProductionDirectCertificationUpload({ ...uploadInput, intents: changedTargets }).reconcile()).toMatchObject({ state: "complete" });
        await expect(new ProductionDirectCertificationUpload(uploadInput).upload()).rejects.toThrow();
        expect(uploadPuts).toBe(1);
        directServiceSigner.close();
        const historicalRelays = new ProductionDirectCertificationRelays({ ...relayInput, intents: changedTargets });
        expect(await historicalRelays.reconcile()).toMatchObject({ state: "complete", ownerEventId: ownerEvent.id, attestationEventId: attestationEvent.id });
        await expect(historicalRelays.publish()).rejects.toThrow();
        expect(await historicalRelays.reconcileOwner()).toMatchObject({ state: "complete", eventId: ownerEvent.id });
        expect(await historicalRelays.reconcileAttestation()).toMatchObject({ state: "complete", eventId: attestationEvent.id });
        expect(await historicalRelays.publishAttestation()).toMatchObject({ state: "complete", eventId: attestationEvent.id });
        expect(directServiceSigns).toBe(1); expect(relayPublishes).toHaveLength(2);
        expect(await factoryActor.reconcile()).toMatchObject({ state: "complete", ownerEventId: ownerEvent.id, attestationEventId: attestationEvent.id });
        expect(await directCertification.observeSubmit(directSource)).toEqual(directSubmitted);
        expect(await directCertification.reconcile(directSubmitted)).toMatchObject({ status: "complete", originalOperationsOnly: true });
        await expect(directCertification.submit(directSource)).rejects.toThrow();
        expect(uploadPuts).toBe(1); expect(relayPublishes).toHaveLength(2); expect(directServiceSigns).toBe(1);
        const historicalFactory = new ProductionDirectPublicationFactory({ ...factoryInput, intents: changedTargets });
        try {
          const historicalActor = await historicalFactory.open(openCommand);
          expect(await historicalActor.reconcile()).toMatchObject({ state: "complete", ownerEventId: ownerEvent.id, attestationEventId: attestationEvent.id });
          expect(z.object({ event: SignedOwnerManifestEventSchema }).passthrough().parse(await historicalActor.observeOwnerSignature()).event.id).toBe(ownerEvent.id);
          await historicalActor.close();
          await expect(historicalActor.reconcile()).rejects.toThrow("ACTOR_CLOSED");
        } finally { await historicalFactory.close(); }
        await directFactory.close();
        await expect(directFactory.open(openCommand)).rejects.toThrow("FACTORY_CLOSED");
        await expect(factoryActor.reconcile()).rejects.toThrow("ACTOR_CLOSED");
        const signingRequestsBeforeHistory = bunker.requests.length;
        pendingRemote = await openDirectSigner(changedTargets, pendingUploadOwner);
        const pendingUploadEvent = z.object({ event: DirectUploadAuthorizationEventSchema }).passthrough().parse(await pendingRemote.observeUploadSignature()).event;
        expect(pendingUploadEvent.tags).toEqual(pendingUpload.template.tags);
        expect(bunker.requests).toHaveLength(signingRequestsBeforeHistory);
        await pendingRemote.close();
        await remoteSigner.close(); remoteSigner = await openDirectSigner(changedTargets);
        expect(z.object({ event: SignedOwnerManifestEventSchema }).passthrough().parse(await remoteSigner.signOwnerManifest()).event.id).toBe(ownerEvent.id);
        expect(z.object({ event: DirectUploadAuthorizationEventSchema }).passthrough().parse(await remoteSigner.signUploadAuthorization()).event.id).toBe(uploadEvent.id);
        expect(bunker.requests).toHaveLength(signingRequestsBeforeHistory);
        await expect(publications().acceptUploadAuthorization({ ...pendingUploadOwner, event: pendingUploadEvent })).rejects.toThrow("INTENT_EXPIRED");
        expect(await publications().readAcceptedUploadAuthorization(pendingUploadOwner)).toBeUndefined();
        expect(await publications().readUploadAuthorization(pendingUploadOwner)).toEqual(pendingUpload);
        await expect(publications().loadUploadAuthorizationForSigning(owner)).rejects.toThrow("INTENT_EXPIRED");
        expect(await publications().prepareUploadAuthorization(owner)).toEqual(uploadAuthorization);
        expect(await publications().readUploadAuthorization(owner)).toEqual(uploadAuthorization);
        expect((await publications().acceptUploadAuthorization({ ...owner, event: uploadEvent })).event.id).toBe(uploadEvent.id);
        expect((await publications().readAcceptedUploadAuthorization(owner))?.event.id).toBe(uploadEvent.id);
        await expect(publications().prepareUploadAuthorization({ principal, idempotencyKey: "direct-publication:unsigned" })).rejects.toThrow("INTENT_EXPIRED");
        expect((await admin.query("SELECT count(*)::int AS count FROM production_real.release_operation_journal WHERE namespace=$1", [publicationNamespace])).rows[0].count).toBe(8);
        console.log(JSON.stringify({ localDirectPublication: true, intentId: publicationIntent.intentId, ownerEventId: ownerEvent.id, uploadPuts, uploadContextCommitRecovered: !loseUploadContextCommit, uploadedExactArtifact: true, ownerRelayEventId: ownerEvent.id, attestationRelayEventId: attestationEvent.id, relayPublishes: relayPublishes.length, directServiceSigns, lostCommitRecovered: !losePublicationCommit, releaseEvidence: false }));
        expect(modelPosts).toBe(3); expect(nativeRestores).toBe(1); expect(reserves).toBe(2); expect(nativeDeletes).toBe(1);
        expect(cleanupGets).toBe(getsAfterCleanupProof); expect(allocations).toBe(allocationsBeforeReads); expect(deletions).toBe(deletionsBeforeReads);
      } finally { await http.stop(true); }
    }
  } finally { try { await closeDirectSigner(); closeDirectBunker(); closeUploadServer(); closeAttestationSigner(); await closeDirectFactory(); await localWorker?.close(); } finally { await runtime?.end(); await admin?.end(); await docker(["rm", "--force", name]).catch(() => undefined); } }
}, 120_000);
