import { expect, test } from "bun:test";
import { Pool } from "pg";
import { FundingService } from "../../src/funding/funding-service";
import { FundedAdmissionService } from "../../src/funding/funded-admission";
import { PostgresFundingDatabase } from "../../src/persistence/postgres-funding-database";
import type { PostgresSqlPool } from "../../src/persistence/postgres-sql-funding-store";
import { PostgresOperationJournal } from "../../src/release/deployment/postgres-operation-journal";
import { createPostgresWorkerOperationJournal, createPostgresVertexOperationJournal } from "../../src/release/deployment/postgres-provider-journals";
import { createWorkerDeploymentClients, createFlyMachinesHttpTransport, PRODUCTION_WORKER_POLICY } from "../../src/release/deployment/worker-clients";
import type { ModalSandboxPort, ModalSdkPort } from "../../src/worker-adapters/modal-worker";
import { createProductionReadyCapacity } from "../../src/production/worker-capacity";
import { ProductionWorkerJobRouter } from "../../src/production/worker-job-router";
import { ProductionWorkerBridge, ProductionWorkerOwnershipResolver } from "../../src/production/worker-bridge";
import { ProductionOwnedDirectArtifacts } from "../../src/production/owned-direct-artifacts";
import { GcsObjectStoreAdapter, type VersionedObjectClientPort } from "../../src/continuity/object-store";
import { registerProductionPricing } from "../../src/production/pricing-catalog";
import { createVertexDeploymentClient, createVertexInteractionsHttpPort } from "../../src/release/deployment/vertex-client";
import { ProductionVertexModelGateway } from "../../src/production/vertex-model-gateway";
import { ProductionSourceProposalStore } from "../../src/production/source-proposal-store";
import { createProductionVertexGenerationSettlement } from "../../src/production/vertex-generation-settlement";
import { MeteredGenerationService } from "../../src/phase-04/metered-generation-service";
import { openLocalProductionWorker } from "../fixtures/local-production-worker";
import { resumePricingMaterial } from "../fixtures/resume-pricing";
import { trustedAdmissionReceipt, trustedAdmissionReceiptAuthority } from "../fixtures/admission-ready";
import { verifyProductionConformanceReceipt } from "../../src/worker-adapters/conformance-receipt";
import { DIRECT_CLI_BINARY_SHA256, requireDirectToolchainReceipt } from "../../src/worker-adapters/direct-toolchain-receipt";

const actualImage = process.env.NAPPLET_CVM_TEST_REAL_WORKER_IMAGE;
const integration = process.env.NAPPLET_RUN_POSTGRES_ISOLATION === "1" && actualImage && process.env.NAPPLET_CVM_TEST_REAL_WORKER_CONTRACT === "nip5d-direct-v1" ? test : test.skip;
const counterSource = `import { runtimeHasDomain } from './domain-availability.js';
import './styles.css';
const root = document.querySelector<HTMLElement>('#app');
if (!root) throw new Error('APP_ROOT_REQUIRED');
const button = document.createElement('button');
let count = 0;
button.textContent = 'Count: 0';
button.addEventListener('click', () => { count++; button.textContent = 'Count: ' + count; });
button.title = runtimeHasDomain('outbox') ? 'Counter ready' : 'Local counter ready';
root.replaceChildren(button);
`;
async function docker(args: string[]) {
  const child = Bun.spawn(["docker", ...args], { stdin: "ignore", stdout: "pipe", stderr: "pipe" });
  const [output, error, code] = await Promise.all([new Response(child.stdout).text(), new Response(child.stderr).text(), child.exited]);
  if (code !== 0) throw new Error(`FRESH_TEST_DOCKER_FAILED:${error.slice(0, 400)}`);
  return output.trim();
}

/** Actual first build and native readiness, local provider/model/rail/object
 * fixtures. This privileged Docker mechanism is not production certification. */
for (const { loseCreateAck, loseStartAck } of [{ loseCreateAck: false, loseStartAck: false }, { loseCreateAck: true, loseStartAck: false }, { loseCreateAck: false, loseStartAck: true }]) integration(`fresh funded admission runs first direct artifact without seeded state (CREATE ack lost: ${loseCreateAck}; START ack lost: ${loseStartAck})`, async () => {
  if (!actualImage) throw new Error("FRESH_TEST_EXACT_IMAGE_REQUIRED");
  const name = `cvm-fresh-generation-${crypto.randomUUID().replaceAll("-", "")}`;
  let admin: Pool | undefined, native: Pool | undefined, local: Awaited<ReturnType<typeof openLocalProductionWorker>> | undefined;
  try {
    await docker(["run", "--detach", "--rm", "--name", name, "--publish", "127.0.0.1::5432", "-e", "POSTGRES_HOST_AUTH_METHOD=trust", "postgres:17-alpine"]);
    const port = (await docker(["port", name, "5432/tcp"])).match(/127\.0\.0\.1:(\d+)/u)?.[1];
    if (!port) throw new Error("FRESH_TEST_PORT_REQUIRED");
    admin = new Pool({ connectionString: `postgresql://postgres@127.0.0.1:${port}/postgres` });
    for (let attempt = 0; ; attempt++) {
      try { await admin.query("SELECT 1"); break; } catch (error) { if (attempt === 89) throw error; await Bun.sleep(250); }
    }
    for (const file of ["phase-03/001_funding.sql", "phase-04/001_metered_generation.sql", "phase-04/002_action_budget_lifecycle.sql", "phase-05/001_continuation.sql", "phase-06/001_publication.sql", "phase-03/002_production_accounting.sql", "phase-07/001_production_operation_journal.sql", "phase-07/002_production_pricing_catalog.sql", "phase-07/003_production_checkpoints.sql", "phase-07/004_production_source_proposals.sql"])
      await admin.query(await Bun.file(`migrations/${file}`).text());
    await admin.query("CREATE ROLE fresh_generation_runtime LOGIN");
    await admin.query("GRANT napplet_production_real TO fresh_generation_runtime");
    native = new Pool({ connectionString: `postgresql://fresh_generation_runtime@127.0.0.1:${port}/postgres` });
    const runtime = native;
    const pool: PostgresSqlPool = { async connect() {
      const client = await runtime.connect();
      return { async query<Row extends Record<string, unknown>>(sql: string, values?: readonly unknown[]) {
        const result = await client.query<Row>(sql, values ? [...values] : undefined); return { rows: result.rows };
      }, release() { client.release(); } };
    } };
    const journal = (namespace: string) => new PostgresOperationJournal(pool, { namespace, scopeSha256: "a".repeat(64) });
    const workerJournal = journal("fresh-workers"), jobJournal = journal("fresh-jobs"), requests = journal("fresh-requests"), capacityJournal = journal("fresh-capacity");
    const providerJournal = createPostgresWorkerOperationJournal(workerJournal);
    const image = `local/worker@${actualImage}`, toolchainSha256 = "d".repeat(64);
    let creates = 0, modelPosts = 0, starts = 0, exists = false;
    let resource: ModalSandboxPort | undefined;
    const sdk: ModalSdkPort = { apps: { fromName: async () => ({}) }, images: { fromRegistry: value => value }, sandboxes: {
      async create(_app, suppliedImage, options) {
        expect(suppliedImage).toBe(image); expect(options.blockNetwork).toBeTrue();
        creates++; local = await openLocalProductionWorker(actualImage); exists = true;
        const worker = local, tags = { ...options.tags };
        resource = { id: "fresh-native-original", async getTags() { return tags; }, async poll() { return {}; },
          async exec(argv) {
            expect(argv[0]).toBe("/usr/local/bin/napplet-cvm-bootstrap");
            if (argv[2] === "start") starts++;
            const result = await worker.exec(argv.slice(1));
            if (loseStartAck && argv[2] === "start") throw new Error("FIXTURE_NATIVE_START_ACK_LOST");
            return { stdout: result.stdout, stderr: result.stderr, exitCode: result.exitCode };
          },
          async terminate() { await worker.close(); exists = false; local = undefined; },
          filesystem: { async copyFromLocal() { throw new Error("NO_FILE_COPY"); }, async copyToLocal() { throw new Error("NO_FILE_COPY"); }, async listFiles() { return []; } } };
        if (loseCreateAck) throw new Error("FIXTURE_NATIVE_CREATE_ACK_LOST");
        return resource;
      },
      async findByName() { return exists && resource ? { kind: "found", sandbox: resource } : { kind: "missing" }; },
    } };
    const workers = createWorkerDeploymentClients({ image, workspaceRoot: "/workspace", policyVersion: PRODUCTION_WORKER_POLICY.version,
      modalAppName: "fresh-generation", modalTags: {}, modalSdk: sdk, journal: providerJournal,
      fly: createFlyMachinesHttpTransport({ appName: "fresh-generation", journal: providerJournal, getAccessToken: async () => { throw new Error("WRONG_PROVIDER"); }, fetch: async () => { throw new Error("WRONG_PROVIDER"); } }) });
    const capacity = createProductionReadyCapacity({ provider: "modal", workers, journal: capacityJournal, workerJournal, image, toolchainSha256 });
    const database = new PostgresFundingDatabase(pool, { realm: "production-real" }), funding = new FundingService(database.funding);
    const principal = { pubkey: "ba".repeat(32) };
    await funding.execute({ principal, kind: "credit_settlement", idempotencyKey: "fresh:credit", policyVersion: "p1", protocolVersion: "v1",
      payload: { settlement: { topUpId: "fresh-topup", rail: "lightning", unit: "sat", amount: "100", externalReference: "fresh-local-fixture", settlementReference: "fresh-settlement", verifiedAt: new Date().toISOString() } } });
    const admissionCommand = { principal, idempotencyKey: "fresh:admit", policyVersion: "p1", protocolVersion: "v1", payload: { requestedCap: "50", unit: "sat" } };
    const admissions = () => new FundedAdmissionService({ funding, store: database.funding, capacity, receiptAuthority: trustedAdmissionReceiptAuthority, capacityTimeoutMs: 30_000 });
    let admitted = await admissions().admit(admissionCommand, await trustedAdmissionReceipt(admissionCommand));
    if (loseCreateAck) {
      expect(admitted.status).toBe("reconciliation_pending");
      expect((await funding.status(principal)).held).toBe("0");
      expect({ creates, modelPosts, starts }).toEqual({ creates: 1, modelPosts: 0, starts: 0 });
      admitted = await admissions().admit(admissionCommand, await trustedAdmissionReceipt(admissionCommand));
    }
    expect(admitted.status).toBe("accepted");
    if (admitted.status !== "accepted") throw new Error(`ACTUAL_FRESH_ADMISSION_FAILED:${local?.logPath ?? "before-native-create"}`);
    expect(await admissions().admit(admissionCommand, await trustedAdmissionReceipt(admissionCommand))).toEqual(admitted);
    expect({ creates, modelPosts, starts }).toEqual({ creates: 1, modelPosts: 0, starts: 0 });
    expect((await funding.status(principal)).held).toBe("50");
    for (const table of ["metered_sessions", "metered_actions", "provider_operations", "session_artifacts"])
      expect((await admin.query(`SELECT count(*)::int AS count FROM production_real.${table}`)).rows[0].count).toBe(0);
    const values = new Map<string, { bytes: Uint8Array; checksum: string }>();
    const objectClient: VersionedObjectClientPort = {
      async createIfAbsent(value) { if (values.has(value.key)) throw new Error("OBJECT_EXISTS"); values.set(value.key, { bytes: new Uint8Array(value.bytes), checksum: value.checksum }); return { generation: 1, checksum: value.checksum }; },
      async findExactByKey(value) { const found = values.get(value.key); return found?.checksum === value.checksum ? { generation: 1, checksum: value.checksum } : undefined; },
      async readGeneration(value) { const found = values.get(value.key); return found && value.generation === 1 && found.checksum === value.expectedChecksum ? { generation: 1, checksum: found.checksum, bytes: new Uint8Array(found.bytes) } : undefined; },
      async scheduleGenerationDeletion() { throw new Error("NO_ARTIFACT_DELETION"); },
    };
    const objects = new GcsObjectStoreAdapter({ config: { bucket: "fresh-fixture", projectId: "fixture" }, client: objectClient });
    const publication = { server: "https://publication.example" };
    const router = new ProductionWorkerJobRouter({ workerJournal, jobJournal, publication, executables: [{ image, toolchainSha256, clients: workers,
      modalAppName: "fresh-generation", flyAppName: "fresh-generation", artifactContract: "nip5d-direct-v1" }] });
    const bridge = () => new ProductionWorkerBridge({ resolver: new ProductionWorkerOwnershipResolver({ pool, policyVersion: "p1", capacityJournal }),
      workers, workerJournal, jobJournal, requestJournal: requests, artifactStore: objects, toolchainSha256, jobRouter: router, publication });
    const pricing = await resumePricingMaterial(Date.now(), "profile:fresh", "2000", 120_000);
    await registerProductionPricing({ pool, ...pricing });
    const sources = pricing.card.sources; if (!sources) throw new Error("PRICING_SOURCE_REQUIRED");
    const vertexJournal = journal("fresh-vertex"), proposals = new ProductionSourceProposalStore(pool);
    const interactions = createVertexInteractionsHttpPort({ accessToken: async () => "local-fixture-token-aaaaaaaaaaaaaaaaaaaa", fetch: Object.assign(async (_url: Parameters<typeof fetch>[0], init?: RequestInit) => {
      if (init?.method !== "POST") throw new Error("NO_SECOND_MODEL_REQUEST"); modelPosts++;
      const wire: unknown = JSON.parse(String(init.body));
      return Response.json({ id: "fresh-model-original", model: "gemini-4-argon", status: "completed", created: new Date().toISOString(),
        steps: [{ type: "user_input", content: typeof wire === "object" && wire && "input" in wire ? wire.input : [] },
          { type: "model_output", content: [{ type: "text", text: JSON.stringify({ files: [{ path: "src/main.ts", content: counterSource }, { path: "src/capabilities.json", content: '{"required":[],"optional":[]}' }] }) }] }],
        usage: { total_input_tokens: 2, total_cached_tokens: 0, total_output_tokens: 1, total_thought_tokens: 0, total_tool_use_tokens: 0, total_tokens: 3 } });
    }, { preconnect() {} }) });
    const vertex = createVertexDeploymentClient({ candidateSha256: "f".repeat(64), projectId: "napplet-cvm-fixture", location: "global", model: "gemini-4-argon", credentialReference: "gcp:adc:fixture",
      price: { sourceUrl: sources.provider.url, sourceDocumentSha256: sources.provider.capturedBytesSha256, quoteSha256: "c".repeat(64), observedAtMs: Date.parse(sources.provider.observedAt),
        freshUntilMs: Date.parse(sources.provider.freshUntil), effectiveFromMs: Date.parse(sources.provider.effectiveAt), effectiveUntilMs: Date.parse(sources.provider.freshUntil),
        currency: "USD", inputMicrosPerMillion: 1_000_000, cachedInputMicrosPerMillion: 1_000_000, outputAndThoughtMicrosPerMillion: 1_000_000 }, journal: createPostgresVertexOperationJournal(vertexJournal), interactions });
    const gateway = new ProductionVertexModelGateway({ vertex, proposals });
    const core = () => new MeteredGenerationService({ fundedAdmission: admissions(), store: database.meteredFunding, gateway, worker: bridge(), artifactVerifier: bridge(),
      proposalStore: proposals, pricing, toolchainIdentity: toolchainSha256, settlement: createProductionVertexGenerationSettlement({ gateway, conversion: pricing.conversion, journal: vertexJournal }) });
    const command = { principal, admissionReference: admitted.reference, idempotencyKey: "fresh:start", expectedVersion: 0, maximum: "50", policyVersion: "p1", idea: "Build one focused private counter napplet." };
    const completed = await core().startSessionAfterAdmission(command);
    if (completed.status !== "completed") throw new Error(`ACTUAL_FRESH_BUILD_FAILED:${JSON.stringify(completed)}:${local?.logPath}`);
    expect(completed.status).toBe("completed");
    if (!completed.artifactId) throw new Error(`ACTUAL_FRESH_ARTIFACT_MISSING:${local?.logPath}`);
    expect(completed.confirmedSpend).toBe("1"); expect(completed.artifactVersion).toBe(1); expect(completed.sessionVersion).toBe(1);
    expect(await core().startSessionAfterAdmission(command)).toEqual(completed);
    expect({ creates, modelPosts, starts }).toEqual({ creates: 1, modelPosts: 1, starts: 1 });
    const owned = new ProductionOwnedDirectArtifacts({ pool, requestJournal: requests, objects, profiles: [{ toolchainSha256, artifactContract: "nip5d-direct-v1" }], publication });
    const artifact = await owned.readVerified({ principal, sessionId: completed.sessionId, artifactId: completed.artifactId });
    expect(artifact?.artifactVersion).toBe(1);
    if (!artifact) throw new Error("ACTUAL_FRESH_OWNED_ARTIFACT_REQUIRED");
    expect(artifact.archive.receipts.commands).toHaveLength(8);
    expect(artifact.archive.receipts.commands.every(command => command.exitCode === 0)).toBeTrue();
    const conformance = verifyProductionConformanceReceipt(artifact.archive.receipts.conformance);
    expect(conformance.report.checks.find(check => check.id === "wire/envelope-well-formed")?.status).toBe("pass");
    const measured = requireDirectToolchainReceipt(artifact.archive.receipts.toolchain);
    expect(measured.cliBinarySha256).toBe(DIRECT_CLI_BINARY_SHA256[measured.platform]);
    expect(await owned.readVerified({ principal: { pubkey: "bb".repeat(32) }, sessionId: completed.sessionId, artifactId: completed.artifactId })).toBeUndefined();
    expect((await funding.status(principal)).held).toBe("49"); expect((await funding.status(principal)).available).toBe("50");
    for (const table of ["admissions", "session_cap_holds", "metered_sessions", "metered_actions", "provider_operations", "session_artifacts", "usage_receipts"])
      expect((await admin.query(`SELECT count(*)::int AS count FROM production_real.${table}`)).rows[0].count).toBe(1);
    expect((await admin.query("SELECT count(*)::int AS count FROM public.funding_accounts")).rows[0].count).toBe(0);
    if (!local) throw new Error("ACTUAL_FRESH_ARTIFACT_REQUIRED");
    const logPath = local.logPath;
    const intent = await database.funding.transact(admitted.accountId, tx => tx.findCapacityIntent(admissionCommand.idempotencyKey));
    if (!intent) throw new Error("ACTUAL_FRESH_INTENT_REQUIRED");
    const original = await capacity.inspect({ intentReference: intent.intentReference });
    if (!original) throw new Error("ACTUAL_FRESH_CAPACITY_REQUIRED");
    expect(await workers.modal.terminate({ operationId: original.workerOperationId })).toEqual({ status: "terminated" });
    expect(await workers.modal.observeTermination({ operationId: original.workerOperationId })).toEqual({ status: "terminated" });
    expect((await providerJournal.read(original.workerOperationId))?.state).toBe("terminated");
    expect((await owned.readVerified({ principal, sessionId: completed.sessionId, artifactId: completed.artifactId }))?.archive.artifactHash).toBe(artifact.archive.artifactHash);
    expect(await core().startSessionAfterAdmission(command)).toEqual(completed);
    expect({ creates, modelPosts, starts }).toEqual({ creates: 1, modelPosts: 1, starts: 1 });
    expect((await funding.status(principal)).held).toBe("49");
    console.log(JSON.stringify({ localFreshGeneration: true, releaseEvidence: false, lostCreateAcknowledgment: loseCreateAck, lostStartAcknowledgment: loseStartAck, image: actualImage, nativeLog: logPath,
      nativeCreates: creates, modelPosts, nativeStarts: starts, artifactVersion: artifact.artifactVersion, conformance: conformance.report.summary,
      artifactHash: artifact.archive.artifactHash }));
  } finally { try { await local?.close(); } finally { await native?.end(); await admin?.end(); await docker(["rm", "--force", name]).catch(() => undefined); } }
}, 120_000);
