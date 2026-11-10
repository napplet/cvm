import { ProductionWorkerJobRouter } from "../../src/production/worker-job-router";
import { PRODUCTION_WORKER_POLICY } from "../../src/worker-adapters/production-worker-policy";
import { expect, test } from "bun:test";
import { createRequire } from "node:module";
import { mkdtemp, mkdir, writeFile, rm, realpath } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { loadPromotedVerificationAuthority } from "../../src/production/release-verification-authority";
import { PostgresOperationJournal, assertPostgresOperationJournal } from "../../src/release/deployment/postgres-operation-journal";
import { createPostgresGoogleOperationJournal, createPostgresModalBillingReportJournal, createPostgresWorkerOperationJournal, createPostgresVertexOperationJournal } from "../../src/release/deployment/postgres-provider-journals";
import { ProductionCoreControlClient } from "../../src/release/deployment/production-core-control";
import { ProductionCertificationControl, type ProductionCertificationServices } from "../../src/production/certification-control";
import { createAuthorizationReceipt, createAuthorizationRequest } from "../../src/release/authorization";
import { createModalBillingObservationGrant, ModalBillingReportCaptureSchema, createModalBillingReportCollector, ModalBillingReportJournalRecordSchema } from "../../src/release/deployment/modal-billing-report";
import { ProductionRestoreEvidenceSchema, ProductionWorkerJobClient } from "../../src/worker-adapters/production-job-client";
import { canonicalJson } from "../../src/promotion/schema";
import { PostgresReleasePromotion } from "../../src/production/release-promotion";
import { ProductionWorkerArtifactStore } from "../../src/production/worker-artifact-store";
import { DeterministicObjectStore } from "../../src/continuity/object-store";
import { WorkerRunResultSchema } from "../../src/phase-02/contracts";
import { ProductionWorkerRequestStore } from "../../src/production/worker-request-store";
import { pricedRestoreBinding } from "../../src/production/priced-restore-binding";

const scopeSha256 = "a".repeat(64), identity = "b".repeat(64);
test("journal construction has no effects and rejects structural/prototype impersonation", async () => {
  let calls = 0;
  const journal = new PostgresOperationJournal({ async connect() { calls++; throw new Error("unexpected I/O"); } }, { namespace: "contextvm:run-1", scopeSha256 });
  expect(calls).toBe(0);
  const promotion = new PostgresReleasePromotion({ pool: { async connect() { calls++; throw new Error("unexpected I/O"); } }, deploymentScopeSha256: scopeSha256,
    binding: { candidateId: scopeSha256, topologySha256: identity, authorizationReceiptSha256: identity }, expectedPreviousBundleSha256: null, authorization: { request: {}, receipt: {} } });
  await expect(promotion.persist({ operationId: "invalid", bundleSha256: identity, authorizationReceiptSha256: identity })).rejects.toThrow();
  expect(calls).toBe(0);
  let network = 0;
  const control = new ProductionCoreControlClient({ serviceUrl: "https://candidate-example.run.app", candidateSha256: scopeSha256, topologySha256: identity, request: {}, receipt: {}, journal, identity: { async token() { network++; return "x".repeat(32); } }, fetch: async () => { network++; return new Response(); } });
  await expect(control.execute({ operationId: "no-authority", kind: "fault.inject", payload: {} })).rejects.toThrow();
  expect(network).toBe(0); expect(calls).toBe(0);
  expect(() => assertPostgresOperationJournal(journal)).not.toThrow();
  expect(() => assertPostgresOperationJournal({ durableAuthority: "postgres" })).toThrow("PRODUCTION_POSTGRES_OPERATION_JOURNAL_REQUIRED");
  expect(() => assertPostgresOperationJournal(Object.create(PostgresOperationJournal.prototype))).toThrow("PRODUCTION_POSTGRES_OPERATION_JOURNAL_REQUIRED");
  for (const value of [undefined, NaN, new Date(), { missing: undefined }, { tooLarge: "x".repeat(1_048_577) }]) await expect(journal.claim("op", identity, value)).rejects.toThrow();
  await expect(journal.compareAndSet("op", identity, 0, {})).rejects.toThrow("OPERATION_REVISION_INVALID");
  expect(calls).toBe(0);
});

const integration = process.env.NAPPLET_RUN_POSTGRES_ISOLATION === "1" ? test : test.skip;
integration("real restricted PostgreSQL survives new instances, arbitrates concurrent claims/CAS, and preserves immutable audit", async () => {
  const previousEffects = process.env.NAPPLET_CVM_TEST_EXTERNAL_EFFECTS;
  process.env.NAPPLET_CVM_TEST_EXTERNAL_EFFECTS = "deny";
  const name = `napplet-cvm-journal-${crypto.randomUUID().replaceAll("-", "")}`;
  const docker = async (...args: string[]) => {
    const child = Bun.spawn(["docker", ...args], { stdout: "pipe", stderr: "pipe" });
    const timer = setTimeout(() => child.kill(), 15000);
    try { const [code, out, err] = await Promise.all([child.exited, new Response(child.stdout).text(), new Response(child.stderr).text()]); if (code) throw new Error(`DOCKER_${args[0]}:${err.slice(0,300)}`); return out.trim(); }
    finally { clearTimeout(timer); }
  };
  const { Pool } = createRequire(import.meta.url)("pg");
  let admin: any, application: any;
  let verificationWorkspace: string | undefined;
  let modalWorkspace: string | undefined;
  try {
    await docker("run", "--detach", "--rm", "--name", name, "--publish", "127.0.0.1::5432", "-e", "POSTGRES_HOST_AUTH_METHOD=trust", "postgres:17-alpine");
    const port = (await docker("port", name, "5432/tcp")).match(/127\.0\.0\.1:(\d+)/u)?.[1];
    if (!port) throw new Error("POSTGRES_PORT_MISSING");
    admin = new Pool({ connectionString: `postgresql://postgres@127.0.0.1:${port}/postgres`, connectionTimeoutMillis: 2000 });
    for (let attempt = 0; attempt < 60; attempt++) { try { await admin.query("SELECT 1"); break; } catch (error) { if (attempt === 59) throw error; await Bun.sleep(250); } }
    for (const path of ["phase-03/001_funding.sql", "phase-04/001_metered_generation.sql", "phase-04/002_action_budget_lifecycle.sql", "phase-05/001_continuation.sql", "phase-06/001_publication.sql", "phase-03/002_production_accounting.sql", "phase-03/003_cashu_custody_and_identities.sql", "phase-03/004_production_rail_material_scope.sql", "phase-07/001_production_operation_journal.sql"]) await admin.query(await Bun.file(`migrations/${path}`).text());
    await admin.query(await Bun.file("migrations/phase-07/001_production_operation_journal.sql").text());
    await admin.query("CREATE ROLE journal_test LOGIN");
    await admin.query("GRANT napplet_production_real TO journal_test");
    application = new Pool({ connectionString: `postgresql://journal_test@127.0.0.1:${port}/postgres`, connectionTimeoutMillis: 2000 });
    const create = (namespace = "nwc:run-1", scope = scopeSha256) => new PostgresOperationJournal(application, { namespace, scopeSha256: scope });
    {
      // The application role, a new repository instance, and an exact-generation
      // object port exercise durable worker recovery without a worker redispatch.
      const objects = new DeterministicObjectStore(); let uploads = 0, loseAcknowledgement = false, refuseCreate = false, corruptRead = false;
      const objectPort = {
        async createImmutable(input: Parameters<typeof objects.createImmutable>[0]) {
          uploads++; if (refuseCreate) throw new Error("CREATE_UNKNOWN");
          const reference = await objects.createImmutable(input);
          if (loseAcknowledgement) throw new Error("ACK_LOST");
          return reference;
        },
        observeExactByKey: objects.observeExactByKey.bind(objects),
        async readExact(reference: Parameters<typeof objects.readExact>[0]) { return corruptRead ? new Uint8Array([99]) : objects.readExact(reference); },
        scheduleExactDeletion: objects.scheduleExactDeletion.bind(objects),
      };
      const artifacts = () => new ProductionWorkerArtifactStore({ journal: create("worker-artifacts"), objects: objectPort, toolchainSha256: identity });
      const request = { sessionId: "session:durable", actionId: "action:durable", expectedVersion: 0, policyVersion: "funding-policy-v1", capabilityGrant: "phase-04-coordinator-grant", workspaceId: "workspace:session:durable", idea: "One counter" };
      const archive = new TextEncoder().encode('{"version":1,"files":[]}');
      const checksum = new Bun.CryptoHasher("sha256").update(archive).digest("hex");
      const contract = { purpose: { kind: "focused", statements: ["One counter"] }, surface: { hasBackend: false, hasSecondPurpose: false, serviceWorker: false, dynamicAuthority: false }, dependencies: { appOwnedSignerOrRelay: false, privateNappletImport: false }, capabilities: { declaredHard: [], observedDomains: [], optionalIntentPresenceRead: false, intentUsedThroughSdk: false }, upstream: { scanner: { verdict: "pass", checkId: "upstream:cli-verify" }, conformance: { verdict: "pass", checkId: "upstream:chromium-conformance" } } };
      const { idea: _idea, ...correlation } = request;
      const completed = WorkerRunResultSchema.parse({ status: "completed", code: "WORKER_PROPOSALS_VALIDATED", events: [{ kind: "progress", turn: 1, detail: "verified" }], artifact: { ...correlation, artifactId: `artifact:${checksum}`, ...contract } });
      if (completed.status !== "completed") throw new Error("TEST_RESULT_INVALID");
      const artifactInput = { request, bytes: archive, result: completed, accountId: `account:${scopeSha256}`, ownerId: identity, scannerReportSha256: identity, conformanceReportSha256: scopeSha256 };
      const requests = () => new ProductionWorkerRequestStore(create("worker-requests"));
      const { idea: _source, ...lookup } = request;
      const requestDigest = (value: unknown) => new Bun.CryptoHasher("sha256").update(canonicalJson(value)).digest("hex");
      // Reproduce a pre-index full-request record: lookup has no proposal bytes.
      await create("worker-requests").claim(`worker-request:${requestDigest(request)}`, requestDigest(request), { request });
      expect(await requests().read(lookup)).toEqual(request);
      await expect(requests().persist({ ...request, idea: "replacement source" })).rejects.toThrow("PRODUCTION_CHECKPOINT_REQUEST_BINDING_INVALID");
      await requests().persist(request); expect(await requests().read(lookup)).toEqual(request);
      await expect(requests().read({ ...lookup, workspaceId: "workspace:other" })).rejects.toThrow("PRODUCTION_CHECKPOINT_REQUEST_BINDING_INVALID");
      // Restore correlation must not pin the old proposal as the new action's
      // run request. Fresh instances then persist the actual resumed proposal.
      const restoreTarget = { ...lookup, actionId: "action:resumed-restore" };
      await Promise.all(Array.from({ length: 3 }, () => requests().persistRestore(request, restoreTarget)));
      expect(await requests().readRestore(restoreTarget)).toEqual({ ...request, actionId: restoreTarget.actionId });
      expect(await requests().read(restoreTarget)).toBeUndefined();
      await expect(requests().persistRestore({ ...request, idea: "forged source" }, restoreTarget)).rejects.toThrow("PRODUCTION_CHECKPOINT_REQUEST_BINDING_INVALID");
      await expect(requests().persistRestore(request, { ...restoreTarget, workspaceId: "workspace:other" })).rejects.toThrow("PRODUCTION_CHECKPOINT_REQUEST_BINDING_INVALID");
      await expect(requests().persistRestore(request, { ...restoreTarget, sessionId: "session:other" })).rejects.toThrow("PRODUCTION_CHECKPOINT_REQUEST_BINDING_INVALID");
      await expect(requests().readRestore({ ...restoreTarget, workspaceId: "workspace:other" })).rejects.toThrow("PRODUCTION_CHECKPOINT_REQUEST_BINDING_INVALID");
      expect(await requests().readRestore({ ...restoreTarget, actionId: "action:other" })).toBeUndefined();
      const resumedRequest = { ...request, ...restoreTarget, idea: "New focused proposal after explicit resume" };
      await requests().persist(resumedRequest);
      expect(await requests().read(restoreTarget)).toEqual(resumedRequest);
      expect(await requests().readRestore(restoreTarget)).toEqual({ ...request, actionId: restoreTarget.actionId });
      await expect(requests().persist({ ...resumedRequest, idea: "changed after dispatch" })).rejects.toThrow("PRODUCTION_CHECKPOINT_REQUEST_BINDING_INVALID");
      expect(await requests().read(lookup)).toEqual(request);
      const forgedRestore = { ...restoreTarget, actionId: "action:forged-restore" };
      const forgedRecord = { schemaVersion: "worker-restore-request-v1", sourceActionId: request.actionId, sourceRequestSha256: "c".repeat(64), restoreRequest: { ...request, actionId: forgedRestore.actionId } };
      await create("worker-requests").claim(`worker-restore-request:${requestDigest({ sessionId: forgedRestore.sessionId, actionId: forgedRestore.actionId, expectedVersion: forgedRestore.expectedVersion })}`, requestDigest(forgedRecord), forgedRecord);
      await expect(requests().readRestore(forgedRestore)).rejects.toThrow("PRODUCTION_CHECKPOINT_REQUEST_BINDING_INVALID");
      // Previously persisted legacy copies remain protected against changes.
      const legacyRestore = { ...request, actionId: "action:legacy-restore-copy" };
      await requests().persist(legacyRestore);
      await expect(requests().persist({ ...legacyRestore, idea: "replacement proposal" })).rejects.toThrow("PRODUCTION_CHECKPOINT_REQUEST_BINDING_INVALID");
      const newRequest = { ...request, actionId: "action:new-index" };
      await Promise.all(Array.from({ length: 3 }, () => requests().persist(newRequest)));
      expect(await requests().read({ ...lookup, actionId: newRequest.actionId })).toEqual(newRequest);
      const partial = { ...request, actionId: "action:partial-index" };
      await create("worker-requests").claim(`worker-request-index:${requestDigest({ sessionId: partial.sessionId, actionId: partial.actionId, expectedVersion: partial.expectedVersion })}`, requestDigest(partial), { originalOperationId: `worker-request:${requestDigest(partial)}`, requestSha256: requestDigest(partial) });
      expect(await requests().read({ ...lookup, actionId: partial.actionId })).toBeUndefined();
      await requests().persist(partial);
      expect(await requests().read({ ...lookup, actionId: partial.actionId })).toEqual(partial);
      const ambiguous = { ...request, actionId: "action:legacy-ambiguous" }, changed = { ...request, actionId: "action:legacy-ambiguous", idea: "other" };
      for (const value of [ambiguous, changed]) await create("worker-requests").claim(`worker-request:${requestDigest(value)}`, requestDigest(value), { request: value });
      await expect(requests().read({ ...lookup, actionId: ambiguous.actionId })).rejects.toThrow("OPERATION_JOURNAL_LOOKUP_AMBIGUOUS");
      loseAcknowledgement = true;
      await expect(artifacts().persist(artifactInput)).rejects.toThrow("ACK_LOST");
      const recovered = await artifacts().read(request);
      expect(recovered?.result).toEqual(completed); expect(recovered?.bytes).toEqual(archive); expect(recovered?.reference.generation).toBe(1);
      loseAcknowledgement = false;
      expect((await artifacts().persist(artifactInput)).result).toEqual(completed); expect(uploads).toBe(1);
      expect(await artifacts().read({ ...request, actionId: "missing" })).toBeUndefined();
      await expect(artifacts().read({ ...request, idea: "changed source" })).rejects.toThrow("PRODUCTION_ARTIFACT_REQUEST_MISMATCH");
      await expect(artifacts().persist({ ...artifactInput, ownerId: scopeSha256 })).rejects.toThrow("OPERATION_IDENTITY_CONFLICT");
      await expect(new ProductionWorkerArtifactStore({ journal: create("worker-artifacts"), objects: objectPort, toolchainSha256: scopeSha256 }).read(request)).rejects.toThrow("PRODUCTION_ARTIFACT_REQUEST_MISMATCH");
      const approved = new ProductionWorkerArtifactStore({ journal: create("worker-artifacts"), objects: objectPort, toolchainSha256: scopeSha256, retainedToolchainSha256s: [identity] });
      const uploadsBeforeUpgrade = uploads;
      expect((await approved.read(request))?.toolchainSha256).toBe(identity);
      expect((await approved.read(request))?.result).toEqual(completed);
      expect(uploads).toBe(uploadsBeforeUpgrade);
      await expect(approved.read({ ...request, policyVersion: "changed-policy" })).rejects.toThrow("PRODUCTION_ARTIFACT_REQUEST_MISMATCH");
      corruptRead = true; expect(await artifacts().read(request)).toBeUndefined(); corruptRead = false;
      refuseCreate = true;
      const missingRequest = { ...request, actionId: "action:missing-create" };
      const missingInput = { ...artifactInput, request: missingRequest, bytes: new Uint8Array([1]), result: { ...completed, artifact: { ...completed.artifact, actionId: missingRequest.actionId, artifactId: `artifact:${new Bun.CryptoHasher("sha256").update(new Uint8Array([1])).digest("hex")}` } } };
      await expect(artifacts().persist(missingInput)).rejects.toThrow("CREATE_UNKNOWN");
      refuseCreate = false;
      await expect(artifacts().persist(missingInput)).rejects.toThrow("PRODUCTION_ARTIFACT_UPLOAD_UNCERTAIN"); expect(uploads).toBe(2);
      const parallelRequest = { ...request, actionId: "action:parallel" };
      const parallelInput = { ...artifactInput, request: parallelRequest, result: { ...completed, artifact: { ...completed.artifact, actionId: parallelRequest.actionId } } };
      const parallelArtifacts = await Promise.allSettled(Array.from({ length: 4 }, () => artifacts().persist(parallelInput)));
      expect(parallelArtifacts.some(result => result.status === "fulfilled")).toBe(true); expect(uploads).toBe(3);
      expect((await artifacts().read(parallelRequest))?.result).toEqual(parallelInput.result);
    }
    const capped = () => create("bounded:run-1");
    const limited = await Promise.allSettled(Array.from({ length: 4 }, (_, i) => capped().claimBounded(`limited-${i}`, identity, { state: "claimed" }, 2)));
    const accepted = limited.filter(result => result.status === "fulfilled");
    expect(accepted).toHaveLength(2);
    expect(limited.filter(result => result.status === "rejected").every(result => result.status === "rejected" && result.reason.message === "PRODUCTION_CONTROL_OPERATION_LIMIT_REACHED")).toBe(true);
    expect((await admin.query("SELECT count(*)::int AS count FROM production_real.release_operation_journal WHERE namespace='bounded:run-1'")).rows[0].count).toBe(2);
    for (const result of accepted) if (result.status === "fulfilled") expect((await capped().claimBounded(result.value.record.operationId, identity, { state: "claimed" }, 2)).claimed).toBe(false);
    const boundedAudit = (await admin.query("SELECT count(*)::int AS count FROM production_real.release_operation_audit WHERE namespace='bounded:run-1'")).rows[0].count;
    expect(boundedAudit).toBe(2);
    const claims = await Promise.all(Array.from({ length: 4 }, () => create().claim("original", identity, { state: "claimed", eventId: "encrypted-event" })));
    expect(claims.filter(result => result.claimed)).toHaveLength(1);
    expect(claims.every(result => result.record.revision === 1)).toBe(true);
    const modal = () => createPostgresModalBillingReportJournal(create("modal-billing:run-1"));
    const modalRecord = { schemaVersion: "modal-billing-report-journal-v2" as const, grantSha256: identity, reportRequestSha256: scopeSha256, attempts: [] };
    const modalClaims = await Promise.all(Array.from({ length: 4 }, () => modal().claim(modalRecord)));
    expect(modalClaims.filter(result => result.claimed)).toHaveLength(1);
    const modalWinner = await modal().read(scopeSha256);
    if (!modalWinner) throw new Error("MODAL_JOURNAL_RECORD_MISSING");
    const intent = { ...modalWinner.record, attempts: [{ attempt: 1, state: "dispatch_intent" as const, atMs: 1, argvSha256: identity, executableSha256: scopeSha256 }] };
    expect(await modal().compareAndSet({ reportRequestSha256: scopeSha256, expectedRevision: modalWinner.revision, record: intent })).toMatchObject({ revision: 2 });
    const modalRestart = await modal().read(scopeSha256);
    expect(modalRestart?.record.attempts).toMatchObject([{ state: "dispatch_intent", attempt: 1 }]);
    // Fresh adapters recover the original finite failure reason from actual
    // restricted SQL, without resolving a secret, reading an object or retrying.
    let modalRecoveryEffects = 0;
    modalWorkspace = await mkdtemp(join(tmpdir(), "cvm-modal-sql-launch-"));
    for (const disposition of ["launch_unavailable", "credential_unavailable", "grant_expired"] as const) {
      const nowMs = Date.now(), executable = join(modalWorkspace, `modal-${disposition}`);
      const launcher = `#!${process.execPath}\nthrow new Error("CREDENTIAL_FAILURE_MUST_PREVENT_CHILD");\n`;
      const executableSha256 = new Bun.CryptoHasher("sha256").update(launcher).digest("hex");
      if (disposition === "credential_unavailable") await writeFile(executable, launcher, { mode: 0o700 });
      let producerResolves = 0;
      const grant = createModalBillingObservationGrant({
        version: 1, authorizationRequestSha256: identity, authorizationReceiptSha256: identity, candidateSha256: scopeSha256,
        operationRecordSha256: identity, accountScopeSha256: scopeSha256, environmentScopeSha256: identity, resourceIdentitySha256: scopeSha256,
        currencyPolicySha256: identity, credentialReferenceSha256: identity, cliExecutableSha256: executableSha256,
        environmentName: "cvm-prod", expectedObjectId: "sb-original", intervalStartMs: Date.parse("2026-10-30T10:00:00Z"), intervalEndMs: Date.parse("2026-10-30T11:00:00Z"),
        requiredTags: { cvm_operation: "operation-1" }, maximumStdoutBytes: 1_024, maximumStderrBytes: 128, timeoutMs: 1_000, maximumAttempts: 1, expiresAtMs: disposition === "grant_expired" ? nowMs - 1 : nowMs + 60_000,
      });
      const journal = () => createPostgresModalBillingReportJournal(create(`modal-recovery:${disposition}`));
      const result = ModalBillingReportCaptureSchema.parse({ status: "held", reason: disposition === "launch_unavailable" ? "child_failure" : disposition, grantSha256: grant.grantSha256, reportRequestSha256: grant.grantSha256 });
      const artifacts = { async createImmutable(): Promise<never> { modalRecoveryEffects++; throw new Error("UNEXPECTED_RECOVERY_WRITE"); }, async readExact(): Promise<never> { modalRecoveryEffects++; throw new Error("UNEXPECTED_RECOVERY_READ"); } };
      const producer = createModalBillingReportCollector({
        executable, executableSha256, credentialReference: "secret/modal-report", credentialReferenceSha256: identity, journal: journal(), artifactOrigin: "gs://original-evidence/", artifacts,
        credentialResolver: { async resolve() {
          producerResolves++;
          if (disposition === "credential_unavailable") throw new Error("OFFLINE_CREDENTIAL_UNAVAILABLE");
          return { tokenId: "offline-id", tokenSecret: "offline-secret" };
        } },
      });
      // These three real producer paths all stop before a process starts:
      // expired authority, unavailable credential, or an absent executable.
      await expect(producer.capture(grant)).resolves.toEqual(result);
      expect(producerResolves).toBe(disposition === "credential_unavailable" ? 1 : 0);
      const completed = await journal().read(grant.grantSha256);
      expect(completed?.revision).toBe(3);
      expect(ModalBillingReportJournalRecordSchema.parse(completed?.record).attempts).toMatchObject([{ state: "completed", disposition }]);
      const recovered = createModalBillingReportCollector({
        executable, executableSha256, credentialReference: "secret/modal-report", credentialReferenceSha256: identity, journal: journal(), artifactOrigin: "gs://original-evidence/",
        credentialResolver: { async resolve(): Promise<never> { modalRecoveryEffects++; throw new Error("UNEXPECTED_RECOVERY_CREDENTIAL"); } },
        artifacts,
      });
      await expect(recovered.recover(grant)).resolves.toEqual(result);
      await expect(recovered.capture(grant)).resolves.toEqual(result);
      expect((await journal().read(grant.grantSha256))?.record.attempts).toHaveLength(1);
      expect((await admin.query("SELECT count(*)::int AS count FROM production_real.release_operation_audit WHERE namespace=$1", [`modal-recovery:${disposition}`])).rows[0].count).toBe(3);
    }
    expect(modalRecoveryEffects).toBe(0);
    expect(await create().read("missing")).toBeUndefined();
    const race = await Promise.all([create().compareAndSet("original", identity, 1, { state: "completed" }), create().compareAndSet("original", identity, 1, { state: "unknown" })]);
    expect(race.filter(Boolean)).toHaveLength(1);
    const winner = race.find(Boolean)!;
    expect(await create().read("original")).toEqual(winner);
    expect(Object.isFrozen(winner.value)).toBe(true);
    expect(await create().compareAndSet("original", identity, 1, { state: "stale" })).toBeUndefined();
    expect(await create().compareAndSet("original", "c".repeat(64), 2, { state: "rebound" })).toBeUndefined();
    await expect(create().claim("original", "c".repeat(64), {})).rejects.toThrow("OPERATION_IDENTITY_CONFLICT");
    expect(await create().read("original")).toEqual(winner);
    expect((await create("other:run-1").claim("original", identity, {})).claimed).toBe(true);
    expect((await create("nwc:run-1", "d".repeat(64)).claim("original", identity, {})).claimed).toBe(true);
    const client = await application.connect();
    try {
      await client.query("SET ROLE napplet_production_real");
      for (const sql of ["DELETE FROM production_real.release_operation_journal", "TRUNCATE production_real.release_operation_journal CASCADE", "UPDATE production_real.release_operation_journal SET identity_sha256=repeat('f',64)", "DELETE FROM production_real.release_operation_audit", "INSERT INTO production_real.release_operation_audit SELECT * FROM production_real.release_operation_audit", "SELECT * FROM public.funding_accounts"]) await expect(client.query(sql)).rejects.toThrow();
      await expect(client.query("UPDATE production_real.release_operation_journal SET revision=revision+2")).rejects.toThrow("OPERATION_IDENTITY_OR_REVISION_IMMUTABLE");
    } finally { client.release(); }
    const audit = (await admin.query("SELECT revision,value_json FROM production_real.release_operation_audit WHERE namespace='nwc:run-1' AND scope_sha256=$1 ORDER BY revision", [scopeSha256])).rows;
    expect(audit).toEqual([{ revision: "1", value_json: { state: "claimed", eventId: "encrypted-event" } }, { revision: "2", value_json: winner.value }]);
    await expect(new PostgresOperationJournal(admin, { namespace: "forbidden", scopeSha256 }).read("original")).rejects.toThrow("ACCOUNTING_REALM_SUPERUSER_DENIED");
    expect((await admin.query("SELECT to_regclass('public.release_operation_journal') AS value")).rows[0].value).toBeNull();
    const google = () => createPostgresGoogleOperationJournal(create("google:run-1"));
    const googleInput = { operationId: "google-original", requestSha256: identity, contentSha256: scopeSha256, resource: "projects/original", owned: false };
    expect((await google().claim(googleInput)).claimed).toBe(true);
    await google().markCompleted({ operationId: googleInput.operationId, requestSha256: identity, generation: "1", owned: true });
    await google().markDispatched({ operationId: googleInput.operationId, requestSha256: identity, operationName: "original-lro" });
    expect(await google().read(googleInput.operationId)).toMatchObject({ state: "completed", owned: true, generation: "1", operationName: "original-lro" });
    await expect(google().markCompleted({ operationId: googleInput.operationId, requestSha256: identity, generation: "2" })).rejects.toThrow("PROVIDER_OPERATION_IDENTITY_CONFLICT");
    await expect(google().claim({ ...googleInput, resource: "projects/replaced" })).rejects.toThrow("OPERATION_IDENTITY_CONFLICT");
    const worker = () => createPostgresWorkerOperationJournal(create("worker:run-1"));
    const workerInput = { operationId: "worker-original", requestSha256: identity, resourceName: "original-worker", provider: "modal" as const, image: "registry/image@sha256:" + scopeSha256 };
    expect((await worker().claim(workerInput)).claimed).toBe(true);
    await worker().update({ operationId: workerInput.operationId, requestSha256: identity, state: "reconciled", resourceId: "actual-worker" });
    await worker().update({ operationId: workerInput.operationId, requestSha256: identity, state: "unknown" });
    expect(await worker().read(workerInput.operationId)).toMatchObject({ state: "reconciled", resourceId: "actual-worker" });
    await worker().update({ operationId: workerInput.operationId, requestSha256: identity, state: "terminated" });
    await worker().update({ operationId: workerInput.operationId, requestSha256: identity, state: "dispatched" });
    expect(await worker().read(workerInput.operationId)).toMatchObject({ state: "terminated" });
    await expect(worker().update({ operationId: workerInput.operationId, requestSha256: identity, state: "reconciled", resourceId: "different-worker" })).rejects.toThrow("PROVIDER_OPERATION_IDENTITY_CONFLICT");
    const vertex = () => createPostgresVertexOperationJournal(create("vertex:run-1"));
    const entry = { operationId: "vertex-original", requestSha256: identity, nonce: "original", request: { idea: "small app", systemInstruction: "bounded", maximumOutputTokens: 128 }, candidateSha256: scopeSha256, projectId: "original-project", model: "gemini-4-argon" as const, location: "global" as const, price: { sourceUrl: "https://cloud.google.com/pricing", sourceDocumentSha256: identity, quoteSha256: identity, observedAtMs: 1, freshUntilMs: 2, effectiveFromMs: 1, effectiveUntilMs: 2, currency: "USD" as const, inputMicrosPerMillion: 1, cachedInputMicrosPerMillion: 1, outputAndThoughtMicrosPerMillion: 1 } };
    expect((await vertex().claim(entry)).claimed).toBe(true);
    await vertex().write({ ...entry, interactionId: "original-result", completedReceipt: { immutable: "receipt" } });
    await vertex().write(entry);
    expect(await vertex().read(entry.operationId)).toMatchObject({ interactionId: "original-result", completedReceipt: { immutable: "receipt" } });
    await expect(vertex().write({ ...entry, interactionId: "other-result" })).rejects.toThrow("PROVIDER_OPERATION_IDENTITY_CONFLICT");
    await expect(vertex().write({ ...entry, completedReceipt: { immutable: "different" } })).rejects.toThrow("PROVIDER_OPERATION_IDENTITY_CONFLICT");
    const request = await createAuthorizationRequest({ candidateSha256: scopeSha256, topologySha256: identity, effectPlanSha256: identity, controllerStateSha256: identity, providerCapabilitiesSha256: identity,
      orderedEffects: [{ id: "cloud-run-control", provider: "cloud_run", operation: "create_or_update", estimatedCostMicros: 1 }], providerScopes: [{ provider: "cloud_run", accountScopeSha256: identity, projectScopeSha256: identity }],
      estimate: { currency: "USD", maximumMicros: 1, sourceId: "contract-test", observedAtMs: 1000, freshUntilMs: 3000 }, maximumRunDurationMs: 60000, cleanupByMs: 1900, evidenceRetentionDays: 30, artifactRetentionDays: 30, gcpEffects: { projectBootstrap: false, billing: false, apiEnablement: ["run.googleapis.com"] }, expiresAtMs: 2000 });
    const receipt = await createAuthorizationReceipt(request);
    // A certified release pointer and original result commit together in the
    // restricted realm. A lost COMMIT response must be queried, never inferred.
    let promotionNow = 1400, loseCommitResponse = false;
    const promotionPool = { async connect() {
      const client = await application.connect();
      return { async query(text: string, values?: readonly unknown[]) {
        const result = await client.query(text, values);
        if (text === "COMMIT" && loseCommitResponse) { loseCommitResponse = false; throw new Error("COMMIT_RESPONSE_LOST"); }
        return result;
      }, release() { client.release(); } };
    } };
    const binding = { candidateId: request.candidateSha256, topologySha256: request.topologySha256, authorizationReceiptSha256: receipt.authorizationReceiptSha256 };
    const promote = (prior: string | null = null) => new PostgresReleasePromotion({ pool: promotionPool, deploymentScopeSha256: identity, binding, expectedPreviousBundleSha256: prior, authorization: { request, receipt }, now: () => promotionNow });
    const bundleSha256 = "e".repeat(64);
    const operationId = `promotion-${new Bun.CryptoHasher("sha256").update(canonicalJson({ candidateId: binding.candidateId, bundleSha256, authorizationReceiptSha256: binding.authorizationReceiptSha256 })).digest("hex")}`;
    const originalPromotion = { operationId, bundleSha256 };
    expect(await promote().observe(originalPromotion)).toBe("unknown");
    verificationWorkspace = await realpath(await mkdtemp(join(tmpdir(), "cvm-sql-verification-")));
    const finalRoot = join(verificationWorkspace, "certifier-materializations", binding.candidateId, "d".repeat(64), "final");
    await mkdir(finalRoot, { recursive: true });
    const configPath = join(finalRoot, "certifier.json");
    const modulePin = { root: finalRoot, modulePath: join(finalRoot, "trust.js"), sha256: scopeSha256 };
    const finalConfig = { version: 1, mode: "protected", credentials: "configured", releaseProfilePath: join(finalRoot, "profile.json"), evidenceDirectory: finalRoot, adapter: modulePin, trustRoot: modulePin,
      controller: { ...binding, releaseId: scopeSha256, sourceRevision: "a".repeat(40), sourceSha256: scopeSha256 } } as const;
    const configBytes = canonicalJson(finalConfig);
    const verificationAuthority = { path: configPath, sha256: new Bun.CryptoHasher("sha256").update(configBytes).digest("hex") };
    await writeFile(configPath, configBytes);
    const authorityInput = { pool: application, deploymentScopeSha256: identity, workspace: verificationWorkspace, bundleSha256, candidateId: binding.candidateId, topologySha256: binding.topologySha256 };
    await promote().persist({ ...originalPromotion, authorizationReceiptSha256: binding.authorizationReceiptSha256, verificationAuthority });
    await expect(loadPromotedVerificationAuthority(authorityInput)).rejects.toThrow();
    await expect(promote().persist({ ...originalPromotion, authorizationReceiptSha256: binding.authorizationReceiptSha256, verificationAuthority: { ...verificationAuthority, sha256: identity } })).rejects.toThrow("PRODUCTION_RELEASE_PROMOTION_OPERATION_CONFLICT");
    loseCommitResponse = true;
    await expect(promote().promote(originalPromotion)).rejects.toThrow("COMMIT_RESPONSE_LOST");
    expect(await promote().observe(originalPromotion)).toBe("promoted");
    expect(await loadPromotedVerificationAuthority(authorityInput)).toEqual({ config: finalConfig, configSha256: verificationAuthority.sha256 });
    await expect(loadPromotedVerificationAuthority({ ...authorityInput, candidateId: identity })).rejects.toThrow("PRODUCTION_VERIFICATION_AUTHORITY_BINDING_INVALID");
    await writeFile(configPath, configBytes + " ");
    await expect(loadPromotedVerificationAuthority(authorityInput)).rejects.toThrow("PRODUCTION_VERIFICATION_AUTHORITY_PIN_INVALID");
    await writeFile(configPath, configBytes);
    expect(await Promise.all(Array.from({ length: 4 }, () => promote().promote(originalPromotion)))).toEqual(["promoted", "promoted", "promoted", "promoted"]);
    const pointer = (await admin.query("SELECT value_json,revision FROM production_real.release_operation_journal WHERE namespace='release-promotion' AND scope_sha256=$1 AND operation_id='current'", [identity])).rows[0];
    expect(pointer.value_json).toMatchObject({ operationId, bundleSha256, status: "promoted" }); expect(Number(pointer.revision)).toBe(2);
    expect((await admin.query("SELECT count(*)::int AS count FROM production_real.release_operation_audit WHERE namespace='release-promotion' AND scope_sha256=$1", [identity])).rows[0].count).toBe(4);
    const otherBundle = "f".repeat(64), otherOperation = `promotion-${new Bun.CryptoHasher("sha256").update(canonicalJson({ candidateId: binding.candidateId, bundleSha256: otherBundle, authorizationReceiptSha256: binding.authorizationReceiptSha256 })).digest("hex")}`;
    await promote().persist({ operationId: otherOperation, bundleSha256: otherBundle, authorizationReceiptSha256: binding.authorizationReceiptSha256 });
    await expect(promote().promote({ operationId: otherOperation, bundleSha256: otherBundle })).rejects.toThrow("PRODUCTION_RELEASE_PROMOTION_PREVIOUS_MISMATCH");
    expect(await promote().observe({ operationId: otherOperation, bundleSha256: otherBundle })).toBe("unknown");
    promotionNow = 2001;
    expect((await loadPromotedVerificationAuthority(authorityInput)).configSha256).toBe(verificationAuthority.sha256);
    expect(await promote().observe(originalPromotion)).toBe("promoted");
    await expect(promote().promote(originalPromotion)).rejects.toThrow("RELEASE_AUTHORIZATION_RECEIPT_EXPIRED");
    await expect(promote().persist({ ...originalPromotion, authorizationReceiptSha256: binding.authorizationReceiptSha256 })).rejects.toThrow("RELEASE_AUTHORIZATION_RECEIPT_EXPIRED");
    let posts = 0, gets = 0, tokens = 0, now = 1400; let original: any;
    const control = () => new ProductionCoreControlClient({ serviceUrl: "https://candidate-example.run.app", candidateSha256: scopeSha256, topologySha256: identity, request, receipt, journal: create("core:run-1"), now: () => now,
      identity: { async token(audience) { expect(audience).toBe("https://candidate-example.run.app"); tokens++; return "x".repeat(32); } },
      fetch: async (url, init) => {
        expect(String(url)).toStartWith("https://candidate-example.run.app/internal/certification/operations");
        expect(init?.redirect).toBe("error");
        if (init?.method === "POST") { posts++; original = JSON.parse(String(init.body)); throw new Error("response lost after accepted operation"); }
        gets++;
        return new Response(JSON.stringify({ operationId: original.operationId, kind: original.kind, requestSha256: original.requestSha256, state: "completed", result: { evidenceClass: "deterministic" } }));
      },
    });
    const command = { operationId: "restore-original", kind: "restore.expiry" as const, payload: { freshInstanceId: "immutable-backup" } };
    expect((await control().execute(command)).state).toBe("unknown");
    expect((await control().execute(command)).state).toBe("completed");
    expect(posts).toBe(1); expect(gets).toBe(1);
    await expect(control().execute({ ...command, payload: { freshInstanceId: "replacement" } })).rejects.toThrow("OPERATION_IDENTITY_CONFLICT");
    now = 2001;
    await expect(control().execute({ ...command, operationId: "new-after-expiry" })).rejects.toThrow("RELEASE_AUTHORIZATION_RECEIPT_EXPIRED");
    expect(posts).toBe(1); expect(gets).toBe(1); expect(tokens).toBe(2);
    expect((await control().observe({ operationId: command.operationId, kind: command.kind, requestSha256: original.requestSha256 })).state).toBe("completed");
    expect(posts).toBe(1); expect(gets).toBe(2); expect(tokens).toBe(3);
    await expect(control().observe({ operationId: "missing-original", kind: command.kind, requestSha256: original.requestSha256 })).rejects.toThrow("CORE_CONTROL_ORIGINAL_REQUIRED");
    expect(tokens).toBe(3);
    expect((await control().execute(command)).state).toBe("completed");
    expect(posts).toBe(1); expect(gets).toBe(3); expect(tokens).toBe(4);
    let serverNow = 1400, serverEffects = 0, serverQueries = 0;
    const unexpected = async () => { throw new Error("UNEXPECTED_SERVICE_OPERATION"); };
    const services: ProductionCertificationServices = {
      prepareCohort: unexpected, observeCohort: unexpected, emitTelemetry: unexpected, telemetryWindow: unexpected,
      injectFault: unexpected, observeFault: unexpected,
      async restore() { serverEffects++; throw new Error("lost original result"); },
      async reconcile(value) { serverQueries++; expect(value.kind).toBe("restore.expiry"); return { expired: true, deleted: true }; },
    };
    const server = () => new ProductionCertificationControl({ candidateSha256: scopeSha256, topologySha256: identity, authorizationRequestSha256: request.authorizationRequestSha256, authorizationRequest: request, authorizationReceipt: receipt, journal: create("server:run-1"), services, now: () => serverNow });
    expect((await server().execute(original)).state).toBe("unknown");
    expect(serverEffects).toBe(1);
    serverNow = 2001;
    expect((await server().observe({ operationId: original.operationId })).state).toBe("completed");
    expect(serverQueries).toBe(1); expect(serverEffects).toBe(1);
    expect((await server().observe({ operationId: original.operationId })).state).toBe("completed");
    expect(serverQueries).toBe(1);
    await expect(server().execute(original)).rejects.toThrow("RELEASE_AUTHORIZATION_RECEIPT_EXPIRED");
    expect(serverEffects).toBe(1);
    const workerJournal = create("build-workers:run-1"), jobJournal = create("build-jobs:run-1");
    const workerRecords = createPostgresWorkerOperationJournal(workerJournal);
    const workerOperationId = "original-build-worker";
    await workerRecords.claim({ operationId: workerOperationId, requestSha256: identity, resourceName: workerOperationId, provider: "fly", appName: "original-app", policyVersion: PRODUCTION_WORKER_POLICY.version, image: `registry/worker@sha256:${scopeSha256}`, sessionLeaseSha256: identity, toolchainSha256: scopeSha256, providerDeadlineEpochMs: Date.now() + 1_200_000 });
    await workerRecords.update({ operationId: workerOperationId, requestSha256: identity, resourceId: "original-machine", state: "reconciled" });
    let starts = 0, queries = 0, originalJobId = "", fences = 0, fenceQueries = 0, restores = 0, restoreQueries = 0, restorePuts = 0, restoreRepairs = 0;
    let restoreReceipt: unknown;
    let completedJobBytes: Buffer | undefined;
    let completedCommands: Array<{ argv: string[]; exitCode: number; stdout: string; stderr: string; elapsedMs: number }> = [];
    const clients = { fly: { async exec(value: { command: string[] }) {
      const [, action, id, index, data] = value.command;
      if (action === "put") return { status: "completed", exitCode: 0, stdout: JSON.stringify({ state: "stored", jobId: id, chunk: Number(index), sha256: new Bun.CryptoHasher("sha256").update(Buffer.from(data!, "base64")).digest("hex") }) };
      if (action === "start") { starts++; originalJobId = id!; throw new Error("accepted original job; response lost"); }
      if (action === "status") {
        queries++; expect(id).toBe(originalJobId);
        const sha = (value: string | Uint8Array) => new Bun.CryptoHasher("sha256").update(value).digest("hex");
        const completed = completedJobBytes ? { version: 1, state: "completed", jobId: id, requestSha256: id, artifactBytes: completedJobBytes.length, artifactSha256: sha(completedJobBytes), commands: completedCommands.map(({ stdout, stderr, ...entry }) => ({ ...entry, stdoutSha256: sha(stdout), stderrSha256: sha(stderr) })) } : { state: "pending", jobId: id };
        return { status: "completed", exitCode: 0, stdout: JSON.stringify(completed) };
      }
      if (action === "artifact") {
        if (!completedJobBytes) throw new Error("NO_COMPLETED_ARTIFACT");
        return { status: "completed", exitCode: 0, stdout: JSON.stringify({ jobId: id, offset: Number(index), totalBytes: completedJobBytes.length, artifactSha256: new Bun.CryptoHasher("sha256").update(completedJobBytes).digest("hex"), bytesBase64: completedJobBytes.subarray(Number(index), Number(index) + 24_576).toString("base64") }) };
      }
      if (action === "fence") { fences++; throw new Error("fenced original lease; response lost"); }
      if (action === "fence-status") { fenceQueries++; return { status: "completed", exitCode: 0, stdout: JSON.stringify({ state: "fenced", jobId: id, fenceSha256: index }) }; }
      if (action === "restore-put") { restorePuts++; return { status: "completed", exitCode: 0, stdout: JSON.stringify({ state: "stored", archiveSha256: id, chunk: Number(index), sha256: new Bun.CryptoHasher("sha256").update(Buffer.from(data!, "base64")).digest("hex") }) }; }
      if (action === "restore") { restores++; throw new Error("restored bytes; response lost"); }
      if (action === "restore-status") { restoreQueries++; return { status: "completed", exitCode: 0, stdout: JSON.stringify(restoreReceipt) }; }
      if (action === "restore-repair") { restoreRepairs++; throw new Error("UNEXPECTED_LEGACY_RESTORE_REPAIR"); }
      throw new Error("UNEXPECTED_REDISPATCH");
    } } };
    const jobClient = (publication?: { server: string }, artifactContract?: "nip5d-direct-v1") => new ProductionWorkerJobClient({ publication, artifactContract, provider: "fly", workerOperationId, clients: clients as never, workerJournal, jobJournal, toolchainSha256: scopeSha256 });
    const originalImage = `registry/worker@sha256:${scopeSha256}`, changedImage = `registry/worker@sha256:${identity}`;
    const routerClients = { modal: { config: { image: originalImage, policyVersion: PRODUCTION_WORKER_POLICY.version } }, fly: { ...clients.fly, config: { image: originalImage, policyVersion: PRODUCTION_WORKER_POLICY.version } } };
    let wrongProfileCalls = 0;
    const currentClients = { modal: { config: { image: changedImage, policyVersion: PRODUCTION_WORKER_POLICY.version } }, fly: { config: { image: changedImage, policyVersion: PRODUCTION_WORKER_POLICY.version }, async exec() { wrongProfileCalls++; throw new Error("WRONG_PROFILE_EXECUTED"); } } };
    const router = (retain = true, flyAppName = "original-app", restoreRecoveryVersion: 1 | undefined = 1) => new ProductionWorkerJobRouter({ workerJournal, jobJournal, executables: [
      { image: changedImage, toolchainSha256: identity, modalAppName: "original-app", flyAppName, clients: currentClients as never },
      ...(retain ? [{ image: originalImage, toolchainSha256: scopeSha256, modalAppName: "original-app", flyAppName, clients: routerClients as never,
        ...(restoreRecoveryVersion === undefined ? {} : { restoreRecoveryVersion }) }] : []),
    ] });
    const buildRequest = { sessionId: "session", actionId: "action", expectedVersion: 0, policyVersion: "test-policy", capabilityGrant: "grant", workspaceId: "workspace", sourceProposalSha256: identity, sourceProposalReference: `proposal:sha256:${identity}`, sourceProposalFiles: [{ path: "src/main.ts", content: "console.log('bounded test');" }] };
    expect((await jobClient().start(buildRequest)).state).toBe("unknown");
    expect((await jobClient().start(buildRequest)).state).toBe("pending");
    expect((await jobClient().observe(buildRequest)).state).toBe("pending");
    expect(starts).toBe(1); expect(queries).toBe(2);
    const retainedClient = await router().resolve({ provider: "fly", workerOperationId });
    expect(retainedClient.toolchainSha256).toBe(scopeSha256);
    expect((await retainedClient.start(buildRequest)).state).toBe("pending");
    expect(starts).toBe(1); expect(wrongProfileCalls).toBe(0);
    await expect(router(false).resolve({ provider: "fly", workerOperationId })).rejects.toThrow("PRODUCTION_WORKER_ORIGINAL_EXECUTABLE_REQUIRED");
    await expect(router(true, "another-app").resolve({ provider: "fly", workerOperationId })).rejects.toThrow("PRODUCTION_WORKER_ORIGINAL_EXECUTABLE_REQUIRED");
    await expect(router().resolve({ provider: "modal", workerOperationId })).rejects.toThrow("PRODUCTION_WORKER_ORIGINAL_EXECUTABLE_REQUIRED");
    const modalOriginalId = "original-modal-worker";
    await workerRecords.claim({ operationId: modalOriginalId, requestSha256: identity, resourceName: modalOriginalId, provider: "modal", appName: "original-app", policyVersion: PRODUCTION_WORKER_POLICY.version, image: originalImage, sessionLeaseSha256: identity, toolchainSha256: scopeSha256, providerDeadlineEpochMs: Date.now() + 1_200_000 });
    await workerRecords.update({ operationId: modalOriginalId, requestSha256: identity, resourceId: "original-sandbox", state: "reconciled" });
    expect((await router().resolve({ provider: "modal", workerOperationId: modalOriginalId })).toolchainSha256).toBe(scopeSha256);
    expect(wrongProfileCalls).toBe(0);


    expect((await jobClient({ server: "https://blossom.example" }).start(buildRequest)).state).toBe("pending");
    expect(starts).toBe(1); // A new controller observes the legacy original only.

    const hash = (value: string | Uint8Array) => new Bun.CryptoHasher("sha256").update(value).digest("hex");
    const publishedRequest = { ...buildRequest, actionId: "published-action" };
    expect((await jobClient({ server: "https://blossom.example/" }).start(publishedRequest)).state).toBe("unknown");
    expect(starts).toBe(2);
    const publishedKey = `worker-build:${hash(canonicalJson({ sessionId: publishedRequest.sessionId, actionId: publishedRequest.actionId, expectedVersion: publishedRequest.expectedVersion }))}`;
    const published = await jobJournal.read<{ requestBody: string; jobId: string }>(publishedKey);
    expect(JSON.parse(published!.value.requestBody).publication).toEqual({ server: "https://blossom.example" });
    expect(published!.identitySha256).toBe(hash(canonicalJson({ request: publishedRequest, publication: { server: "https://blossom.example" } })));
    expect(published!.value.jobId).toBe(hash(published!.value.requestBody));
    expect((await jobClient({ server: "https://different.example" }).start(publishedRequest)).state).toBe("pending");
    expect(starts).toBe(2); // Changed settings cannot dispatch a replacement.
    await expect(jobClient().start({ ...buildRequest, sourceProposalFiles: [{ path: "src/main.ts", content: "changed" }] })).rejects.toThrow("OPERATION_IDENTITY_CONFLICT");
    expect(starts).toBe(2);
    expect((await jobClient().fence(buildRequest, identity)).state).toBe("unknown");
    expect((await retainedClient.fence(buildRequest, identity)).state).toBe("fenced");
    expect(fences).toBe(1); expect(fenceQueries).toBe(1);
    await expect(jobClient().fence(buildRequest, scopeSha256)).rejects.toThrow("OPERATION_IDENTITY_CONFLICT");
    const source = { version: 1, actionId: "original-action", sessionId: "original-session", expectedVersion: 0, proposalSha256: identity, toolchainSha256: scopeSha256, deadlineEpochMs: 1, files: buildRequest.sourceProposalFiles };
    const files = [{ path: "index.html", bytesBase64: Buffer.from("<html></html>").toString("base64"), sha256: hash("<html></html>"), size: 13 }];
    const workspace = Buffer.from(canonicalJson({ version: 1, source, toolchainSha256: scopeSha256, artifact: { version: 1, jobId: hash(canonicalJson(source)), proposalSha256: identity, toolchainSha256: scopeSha256, files, commandEvidence: Array.from({ length: 8 }, () => ({ argv: ["contract-test"], exitCode: 0, stdout: "", stderr: "", elapsedMs: 1 })) } }));
    restoreReceipt = { state: "restored", archiveSha256: hash(workspace), toolchainSha256: scopeSha256, sourceSha256: hash(canonicalJson(source.files)), artifactFilesSha256: hash(canonicalJson(files)), workspacePath: "/workspace/restored" };
    const restoreInput = { operationId: "original-restore", bindingSha256: identity, bytes: workspace };
    expect((await jobClient().restoreWorkspace(restoreInput)).state).toBe("unknown");
    expect((await jobClient().restoreWorkspace(restoreInput)).state).toBe("restored");
    expect(restores).toBe(1); expect(restoreQueries).toBe(1);
    /* A fresh control process only queries the exact original restore claim;
     * it does not upload archive chunks or send another restore command. */
    expect((await jobClient().observeRestoreWorkspace({ operationId: restoreInput.operationId, archiveSha256: hash(workspace), bindingSha256: identity })).state).toBe("restored");
    expect(restores).toBe(1); expect(restoreQueries).toBe(2);
    const correctRestoreReceipt = restoreReceipt;
    for (const changed of [
      { toolchainSha256: identity }, { sourceSha256: identity }, { artifactFilesSha256: identity },
    ]) {
      restoreReceipt = { state: "restored", archiveSha256: hash(workspace), toolchainSha256: scopeSha256,
        sourceSha256: hash(canonicalJson(source.files)), artifactFilesSha256: hash(canonicalJson(files)), workspacePath: "/workspace/restored", ...changed };
      expect((await jobClient().observeRestoreWorkspace({ operationId: restoreInput.operationId, archiveSha256: hash(workspace), bindingSha256: identity })).state).toBe("unknown");
    }
    restoreReceipt = correctRestoreReceipt;
    const originalRestore = await jobJournal.read("worker-restore:original-restore");
    const restoreEvidence = await jobJournal.read("worker-restore-evidence:original-restore");
    if (!originalRestore || !restoreEvidence) throw new Error("EXPECTED_RESTORE_EVIDENCE");
    expect(restoreEvidence.revision).toBe(1);
    expect(restoreEvidence.value).toMatchObject({ schemaVersion: "worker-restore-evidence-v1", originalOperationId: originalRestore.operationId,
      originalIdentitySha256: originalRestore.identitySha256, expected: { archiveSha256: hash(workspace), toolchainSha256: scopeSha256,
        sourceSha256: hash(canonicalJson(source.files)), artifactFilesSha256: hash(canonicalJson(files)) } });
    // A row written before v1 recovery has precisely these five fields. Its
    // canonical identity deliberately has no `chunks`, so retained-profile
    // observation must preserve that historical shape and remain query-only.
    const legacyRestoreOperation = "legacy-five-field-restore";
    const legacyRestoreValue = { workerOperationId, workerResourceId: "original-machine", leaseSha256: identity,
      archiveSha256: hash(workspace), bindingSha256: identity };
    const legacyRestoreIdentity = hash(canonicalJson(legacyRestoreValue));
    const legacyEvidenceValue = { ...ProductionRestoreEvidenceSchema.parse(restoreEvidence.value),
      originalOperationId: `worker-restore:${legacyRestoreOperation}`, originalIdentitySha256: legacyRestoreIdentity };
    await jobJournal.claim(`worker-restore:${legacyRestoreOperation}`, legacyRestoreIdentity, legacyRestoreValue);
    await jobJournal.claim(`worker-restore-evidence:${legacyRestoreOperation}`, hash(canonicalJson(legacyEvidenceValue)), legacyEvidenceValue);
    const legacyRetained = await router().resolve({ provider: "fly", workerOperationId });
    const queriesBeforeLegacyRestore = restoreQueries;
    expect((await legacyRetained.observeRestoreWorkspace({ operationId: legacyRestoreOperation, archiveSha256: hash(workspace), bindingSha256: identity })).state).toBe("restored");
    expect(restoreQueries).toBe(queriesBeforeLegacyRestore + 1);
    expect((await legacyRetained.repairRestoreWorkspace({ operationId: legacyRestoreOperation, archiveSha256: hash(workspace), bindingSha256: identity })).state).toBe("unknown");
    expect(restoreRepairs).toBe(0);
    // A malformed claimed v1 shape is neither queried nor promoted to repair.
    const malformedRestoreOperation = "malformed-v1-restore";
    const malformedRestoreValue = { ...legacyRestoreValue, chunks: 0 };
    await jobJournal.claim(`worker-restore:${malformedRestoreOperation}`, hash(canonicalJson(malformedRestoreValue)), malformedRestoreValue);
    const queriesBeforeMalformedRestore = restoreQueries;
    expect((await legacyRetained.observeRestoreWorkspace({ operationId: malformedRestoreOperation, archiveSha256: hash(workspace), bindingSha256: identity })).state).toBe("unknown");
    expect(restoreQueries).toBe(queriesBeforeMalformedRestore); expect(restoreRepairs).toBe(0);
    const observerOnlyRetained = await router(true, "original-app", undefined).resolve({ provider: "fly", workerOperationId });
    expect((await observerOnlyRetained.repairRestoreWorkspace({ operationId: legacyRestoreOperation, archiveSha256: hash(workspace), bindingSha256: identity })).state).toBe("unknown");
    expect(restoreRepairs).toBe(0);
    // Retained pre-companion originals cannot invent metadata-only proof. An
    // explicit full-archive retry remains query-only and preserves history.
    await jobJournal.claim("worker-restore:legacy-without-evidence", originalRestore.identitySha256, originalRestore.value);
    const beforeLegacy = { queries: restoreQueries, uploads: restorePuts, restores };
    expect((await jobClient().observeRestoreWorkspace({ operationId: "legacy-without-evidence", archiveSha256: hash(workspace), bindingSha256: identity })).state).toBe("unknown");
    expect(restoreQueries).toBe(beforeLegacy.queries);
    expect((await jobClient().restoreWorkspace({ ...restoreInput, operationId: "legacy-without-evidence" })).state).toBe("restored");
    expect(restoreQueries).toBe(beforeLegacy.queries + 1);
    expect(restorePuts).toBe(beforeLegacy.uploads); expect(restores).toBe(beforeLegacy.restores);
    expect(await jobJournal.read("worker-restore-evidence:legacy-without-evidence")).toBeUndefined();
    expect((await jobJournal.read("worker-restore:legacy-without-evidence"))?.value).toEqual(originalRestore.value);
    // Even a rewrite with identical content invalidates immutable revision1
    // evidence and must refuse before a native query or upload.
    await jobJournal.compareAndSet(restoreEvidence.operationId, restoreEvidence.identitySha256, restoreEvidence.revision, restoreEvidence.value);
    const queriesBeforeChangedEvidence = restoreQueries;
    expect((await jobClient().observeRestoreWorkspace({ operationId: restoreInput.operationId, archiveSha256: hash(workspace), bindingSha256: identity })).state).toBe("unknown");
    expect(restoreQueries).toBe(queriesBeforeChangedEvidence);
    await expect(jobClient().restoreWorkspace({ ...restoreInput, bindingSha256: scopeSha256 })).rejects.toThrow("OPERATION_IDENTITY_CONFLICT");
    expect(restores).toBe(1);

    const capabilityContent = '{"required":[],"optional":[]}', capabilityReceipt = { state: "present", path: "src/capabilities.json", sha256: hash(capabilityContent), bytesBase64: Buffer.from(capabilityContent).toString("base64") };
    const expanded = JSON.parse(workspace.toString("utf8")); expanded.artifact.version = 2; expanded.artifact.capabilityReceipt = capabilityReceipt;
    expanded.source.files.push({ path: "src/capabilities.json", content: capabilityContent }); expanded.artifact.jobId = hash(canonicalJson(expanded.source));
    const changedCapabilities = structuredClone(expanded); changedCapabilities.artifact.capabilityReceipt.sha256 = scopeSha256;
    await expect(jobClient().restoreWorkspace({ operationId: "bad-capability-restore", bindingSha256: identity, bytes: Buffer.from(canonicalJson(changedCapabilities)) })).rejects.toThrow();
    expect(await jobJournal.read("worker-restore:bad-capability-restore")).toBeUndefined(); expect(restores).toBe(1);
    const changedSource = structuredClone(expanded); changedSource.source.files[1].content = "changed"; changedSource.artifact.jobId = hash(canonicalJson(changedSource.source));
    await expect(jobClient().restoreWorkspace({ operationId: "changed-capability-restore", bindingSha256: identity, bytes: Buffer.from(canonicalJson(changedSource)) })).rejects.toThrow("PRODUCTION_WORKSPACE_CAPABILITY_RECEIPT_MISMATCH");
    expect(await jobJournal.read("worker-restore:changed-capability-restore")).toBeUndefined(); expect(restores).toBe(1);
    const expandedBytes = Buffer.from(canonicalJson(expanded));
    restoreReceipt = { state: "restored", archiveSha256: hash(expandedBytes), toolchainSha256: scopeSha256, sourceSha256: hash(canonicalJson(expanded.source.files)), artifactFilesSha256: hash(canonicalJson(files)), workspacePath: "/workspace/restored" };
    expect((await jobClient().restoreWorkspace({ operationId: "expanded-original-restore", bindingSha256: identity, bytes: expandedBytes })).state).toBe("unknown");
    expect((await jobClient().restoreWorkspace({ operationId: "expanded-original-restore", bindingSha256: identity, bytes: expandedBytes })).state).toBe("restored");
    expect(restores).toBe(2);

    // Separate direct-source/bundle versions preserve original bodies across
    // changed controller defaults; missing/ambiguous acknowledgements only query.
    const restarted = await router().resolve({ provider: "fly", workerOperationId });
    expect((await restarted.observeRestoreWorkspace({ operationId: "expanded-original-restore", archiveSha256: hash(expandedBytes), bindingSha256: identity })).state).toBe("restored");
    expect(restores).toBe(2); expect(starts).toBe(2); expect(wrongProfileCalls).toBe(0);
    const directPublication = { server: "https://publication.example" };
    const directRequest = { ...buildRequest, actionId: "direct-action", idea: "Keep one short note", sourceProposalFiles: [...buildRequest.sourceProposalFiles, { path: "src/capabilities.json", content: capabilityContent }] };
    expect((await jobClient(directPublication, "nip5d-direct-v1").start(directRequest)).state).toBe("unknown");
    expect(starts).toBe(3);
    expect((await jobClient({ server: "https://changed.example" }).start(directRequest)).state).toBe("pending");
    expect(starts).toBe(3);
    const directKey = `worker-build:${hash(canonicalJson({ sessionId: directRequest.sessionId, actionId: directRequest.actionId, expectedVersion: directRequest.expectedVersion }))}`;
    const directOriginal = await jobJournal.read<{ requestBody: string; jobId: string }>(directKey);
    expect(JSON.parse(directOriginal!.value.requestBody)).toMatchObject({ version: 2, artifactContract: "nip5d-direct-v1", purpose: directRequest.idea, publication: directPublication });
    expect(directOriginal!.identitySha256).toBe(hash(canonicalJson({ request: directRequest, publication: directPublication, artifactContract: "nip5d-direct-v1" })));
    await expect(jobClient(directPublication, "nip5d-direct-v1").start({ ...directRequest, idea: "changed purpose" })).rejects.toThrow("OPERATION_IDENTITY_CONFLICT");
    const badDeclaration = { ...directRequest, actionId: "bad-declaration", sourceProposalFiles: [buildRequest.sourceProposalFiles[0]!, { path: "src/capabilities.json", content: '{"required":["storage"],"optional":["storage"]}' }] };
    await expect(jobClient(directPublication, "nip5d-direct-v1").start(badDeclaration)).rejects.toThrow();
    expect(starts).toBe(3);
    const badKey = `worker-build:${hash(canonicalJson({ sessionId: badDeclaration.sessionId, actionId: badDeclaration.actionId, expectedVersion: badDeclaration.expectedVersion }))}`;
    expect(await jobJournal.read(badKey)).toBeUndefined();

    const directWorkspace = JSON.parse(expandedBytes.toString("utf8"));
    Object.assign(directWorkspace.source, { version: 2, artifactContract: "nip5d-direct-v1", purpose: directRequest.idea, publication: directPublication });
    const report = await Bun.file("tests/fixtures/direct-artifact/conformance-current.json").json();
    const sidecar = { kind: 35129, created_at: 1, tags: [["d", "my-napplet"], ["x", files[0]!.sha256]], content: directRequest.idea, artifactHash: files[0]!.sha256 };
    const observedReceipt = (path: string, value: unknown) => { const bytes = Buffer.from(JSON.stringify(value)); return { path, sha256: hash(bytes), bytesBase64: bytes.toString("base64") }; };
    Object.assign(directWorkspace.artifact, { version: 3, artifactContract: "nip5d-direct-v1", jobId: hash(canonicalJson(directWorkspace.source)), manifestReceipt: observedReceipt(".nip5a-manifest.json", sidecar), conformanceReceipt: observedReceipt("test-results/conformance.json", report) });
    const directBytes = Buffer.from(canonicalJson(directWorkspace));
    restoreReceipt = { state: "restored", archiveSha256: hash(directBytes), toolchainSha256: scopeSha256, sourceSha256: hash(canonicalJson(directWorkspace.source.files)), artifactFilesSha256: hash(canonicalJson(files)), workspacePath: "/workspace/restored" };
    expect((await jobClient(directPublication, "nip5d-direct-v1").restoreWorkspace({ operationId: "direct-original-restore", bindingSha256: identity, bytes: directBytes })).state).toBe("unknown");
    expect((await jobClient().restoreWorkspace({ operationId: "direct-original-restore", bindingSha256: identity, bytes: directBytes })).state).toBe("restored");
    expect((await jobClient().observeRestoreWorkspace({ operationId: "direct-original-restore", archiveSha256: hash(directBytes), bindingSha256: identity })).state).toBe("restored");
    expect(restores).toBe(3);
    for (const fault of ["mixed-contract", "sidecar-hash", "purpose", "report", "extra-file"] as const) {
      const changed = structuredClone(directWorkspace);
      if (fault === "mixed-contract") { changed.artifact.version = 2; delete changed.artifact.artifactContract; delete changed.artifact.manifestReceipt; delete changed.artifact.conformanceReceipt; }
      if (fault === "sidecar-hash") changed.artifact.manifestReceipt = observedReceipt(".nip5a-manifest.json", { ...sidecar, artifactHash: "0".repeat(64) });
      if (fault === "purpose") { changed.source.purpose = "Substituted purpose"; changed.artifact.jobId = hash(canonicalJson(changed.source)); }
      if (fault === "report") changed.artifact.conformanceReceipt = observedReceipt("test-results/conformance.json", { ...report, ok: false });
      if (fault === "extra-file") changed.artifact.files.push({ ...files[0], path: "extra.html" });
      const operationId = `bad-direct-${fault}`;
      await expect(jobClient().restoreWorkspace({ operationId, bindingSha256: identity, bytes: Buffer.from(canonicalJson(changed)) })).rejects.toThrow();
      expect(await jobJournal.read(`worker-restore:${operationId}`)).toBeUndefined();
    }
    expect(restores).toBe(3);
    const directBundle = { ...directWorkspace.artifact, jobId: directOriginal!.value.jobId };
    completedCommands = directBundle.commandEvidence;
    completedJobBytes = Buffer.from(canonicalJson(directBundle));
    expect((await jobClient().readArtifact(directRequest)).version).toBe(3);
    const materialized = await jobClient().materializeArtifact(directRequest, { ownerId: "f".repeat(64), accountId: "unit:account" });
    try {
      expect(materialized).toMatchObject({ artifactContract: "nip5d-direct-v1", publication: directPublication, manifestReceipt: directBundle.manifestReceipt, conformanceReceipt: directBundle.conformanceReceipt });
      expect(await Bun.file(join(materialized.distRoot, "index.html")).text()).toBe("<html></html>");
      expect(await Bun.file(join(materialized.distRoot, ".nip5a-manifest.json")).exists()).toBe(false);
    } finally { await materialized.cleanup(); }
    const downgraded = structuredClone(directBundle); downgraded.version = 2; delete downgraded.artifactContract; delete downgraded.manifestReceipt; delete downgraded.conformanceReceipt;
    completedJobBytes = Buffer.from(canonicalJson(downgraded));
    await expect(jobClient().readArtifact(directRequest)).rejects.toThrow("PRODUCTION_JOB_ARTIFACT_CONTRACT_MISMATCH");
    expect(starts).toBe(3);

    // Real native journal/RPC recovery with the exact metadata identity used
    // by the new bridge; archive bytes are absent from observer inputs.
    const restoreMetadata = { accountId: "account:restore", sessionId: "session:restore", actionId: "priced-resume-action:restore", expectedVersion: 0,
      policyVersion: "policy:restore", capabilityGrant: "phase-05-continuation-grant", workspaceId: "workspace:session:restore",
      checkpointId: "checkpoint:restore", pauseGeneration: 1, actionVersion: 0, workspaceLineage: "workspace:session:restore",
      leaseToken: "lease:restore", resumeClaim: "allocation:restore", archiveSha256: hash(workspace) };
    const pricedRestore = pricedRestoreBinding(restoreMetadata);
    expect(pricedRestoreBinding(JSON.parse(JSON.stringify(restoreMetadata)))).toEqual(pricedRestore);
    expect(() => pricedRestoreBinding({ ...restoreMetadata, archive: workspace })).toThrow();
    expect(() => pricedRestoreBinding({ ...restoreMetadata, bindingSha256: identity })).toThrow();
    restoreReceipt = correctRestoreReceipt;
    const restoresBeforePriced = restores;
    expect((await jobClient().restoreWorkspace({ operationId: pricedRestore.operationId, bindingSha256: pricedRestore.bindingSha256, bytes: workspace })).state).toBe("unknown");
    const uploadsAfterPriced = restorePuts;
    const restartedPriced = pricedRestoreBinding(restoreMetadata);
    expect((await jobClient().observeRestoreWorkspace({ operationId: restartedPriced.operationId, bindingSha256: restartedPriced.bindingSha256, archiveSha256: restartedPriced.metadata.archiveSha256 })).state).toBe("restored");
    expect(restores).toBe(restoresBeforePriced + 1); expect(restorePuts).toBe(uploadsAfterPriced);
    const queriesBeforeForeign = restoreQueries;
    for (const changed of [{ accountId: "account:other" }, { sessionId: "session:other" }, { actionId: "action:other" }, { expectedVersion: 1 },
      { policyVersion: "policy:other" }, { workspaceId: "workspace:other" }, { checkpointId: "checkpoint:other" }, { pauseGeneration: 2 },
      { actionVersion: 1 }, { workspaceLineage: "workspace:other" }, { leaseToken: "lease:other" }, { resumeClaim: "allocation:other" }, { archiveSha256: identity }]) {
      const foreign = pricedRestoreBinding({ ...restoreMetadata, ...changed });
      expect(foreign.operationId).not.toBe(pricedRestore.operationId);
      expect((await jobClient().observeRestoreWorkspace({ operationId: foreign.operationId, bindingSha256: foreign.bindingSha256, archiveSha256: foreign.metadata.archiveSha256 })).state).toBe("unknown");
    }
    expect(restoreQueries).toBe(queriesBeforeForeign); expect(restores).toBe(restoresBeforePriced + 1);

  } finally {
    if (previousEffects === undefined) delete process.env.NAPPLET_CVM_TEST_EXTERNAL_EFFECTS; else process.env.NAPPLET_CVM_TEST_EXTERNAL_EFFECTS = previousEffects;
    if (verificationWorkspace) await rm(verificationWorkspace, { recursive: true, force: true });
    if (modalWorkspace) await rm(modalWorkspace, { recursive: true, force: true });
    await application?.end(); await admin?.end(); await docker("rm", "--force", name).catch(() => undefined);
  }
}, 120000);
