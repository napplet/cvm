import { createAuthorizationReceipt, createAuthorizationRequest } from "../../src/release/authorization";
import { canonicalJson } from "../../src/promotion/schema";
import { PostgresReleasePromotion } from "../../src/production/release-promotion";
import { expect, test } from "bun:test";
import { createRequire } from "node:module";
import { PostgresOperationJournal, assertPostgresOperationJournal } from "../../src/release/deployment/postgres-operation-journal";
import { createPostgresGoogleOperationJournal, createPostgresWorkerOperationJournal, createPostgresVertexOperationJournal } from "../../src/release/deployment/postgres-provider-journals";

const scopeSha256 = "a".repeat(64), identity = "b".repeat(64);
test("journal construction has no effects and rejects structural/prototype impersonation", async () => {
  let calls = 0;
  const journal = new PostgresOperationJournal({ async connect() { calls++; throw new Error("unexpected I/O"); } }, { namespace: "contextvm:run-1", scopeSha256 });
  expect(calls).toBe(0);
  const promotion = new PostgresReleasePromotion({ pool: { async connect() { calls++; throw new Error("unexpected I/O"); } }, deploymentScopeSha256: scopeSha256,
    binding: { candidateId: scopeSha256, topologySha256: identity, authorizationReceiptSha256: identity }, expectedPreviousBundleSha256: null, authorization: { request: {}, receipt: {} } });
  await expect(promotion.persist({ operationId: "invalid", bundleSha256: identity, authorizationReceiptSha256: identity })).rejects.toThrow();
  expect(calls).toBe(0);

  expect(() => assertPostgresOperationJournal(journal)).not.toThrow();
  expect(() => assertPostgresOperationJournal({ durableAuthority: "postgres" })).toThrow("PRODUCTION_POSTGRES_OPERATION_JOURNAL_REQUIRED");
  expect(() => assertPostgresOperationJournal(Object.create(PostgresOperationJournal.prototype))).toThrow("PRODUCTION_POSTGRES_OPERATION_JOURNAL_REQUIRED");
  for (const value of [undefined, NaN, new Date(), { missing: undefined }, { tooLarge: "x".repeat(1_048_577) }]) await expect(journal.claim("op", identity, value)).rejects.toThrow();
  await expect(journal.compareAndSet("op", identity, 0, {})).rejects.toThrow("OPERATION_REVISION_INVALID");
  expect(calls).toBe(0);
});

const integration = process.env.NAPPLET_RUN_POSTGRES_ISOLATION === "1" ? test : test.skip;
integration("real restricted PostgreSQL survives new instances, arbitrates concurrent claims/CAS, and preserves immutable audit", async () => {
  const priorEffects = process.env.NAPPLET_CVM_TEST_EXTERNAL_EFFECTS;
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
    const claims = await Promise.all(Array.from({ length: 4 }, () => create().claim("original", identity, { state: "claimed", eventId: "encrypted-event" })));
    expect(claims.filter(result => result.claimed)).toHaveLength(1);
    expect(claims.every(result => result.record.revision === 1)).toBe(true);
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
    await promote().persist({ ...originalPromotion, authorizationReceiptSha256: binding.authorizationReceiptSha256 });
    loseCommitResponse = true;
    await expect(promote().promote(originalPromotion)).rejects.toThrow("COMMIT_RESPONSE_LOST");
    expect(await promote().observe(originalPromotion)).toBe("promoted");
    expect(await Promise.all(Array.from({ length: 4 }, () => promote().promote(originalPromotion)))).toEqual(["promoted", "promoted", "promoted", "promoted"]);
    const pointer = (await admin.query("SELECT value_json,revision FROM production_real.release_operation_journal WHERE namespace='release-promotion' AND scope_sha256=$1 AND operation_id='current'", [identity])).rows[0];
    expect(pointer.value_json).toMatchObject({ operationId, bundleSha256, status: "promoted" }); expect(Number(pointer.revision)).toBe(2);
    expect((await admin.query("SELECT count(*)::int AS count FROM production_real.release_operation_audit WHERE namespace='release-promotion' AND scope_sha256=$1", [identity])).rows[0].count).toBe(4);
    const otherBundle = "f".repeat(64), otherOperation = `promotion-${new Bun.CryptoHasher("sha256").update(canonicalJson({ candidateId: binding.candidateId, bundleSha256: otherBundle, authorizationReceiptSha256: binding.authorizationReceiptSha256 })).digest("hex")}`;
    await promote().persist({ operationId: otherOperation, bundleSha256: otherBundle, authorizationReceiptSha256: binding.authorizationReceiptSha256 });
    await expect(promote().promote({ operationId: otherOperation, bundleSha256: otherBundle })).rejects.toThrow("PRODUCTION_RELEASE_PROMOTION_PREVIOUS_MISMATCH");
    expect(await promote().observe({ operationId: otherOperation, bundleSha256: otherBundle })).toBe("unknown");
    promotionNow = 2001;
    expect(await promote().observe(originalPromotion)).toBe("promoted");
    await expect(promote().promote(originalPromotion)).rejects.toThrow("RELEASE_AUTHORIZATION_RECEIPT_EXPIRED");
    await expect(promote().persist({ ...originalPromotion, authorizationReceiptSha256: binding.authorizationReceiptSha256 })).rejects.toThrow("RELEASE_AUTHORIZATION_RECEIPT_EXPIRED");
  } finally { if (priorEffects === undefined) delete process.env.NAPPLET_CVM_TEST_EXTERNAL_EFFECTS; else process.env.NAPPLET_CVM_TEST_EXTERNAL_EFFECTS = priorEffects; await application?.end(); await admin?.end(); await docker("rm", "--force", name).catch(() => undefined); }
}, 120000);
