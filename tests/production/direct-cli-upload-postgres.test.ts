import { Pool } from "pg";
import { expect, test } from "bun:test";
import { finalizeEvent, getPublicKey, type Event } from "nostr-tools/pure";
import type { PostgresSqlPool } from "../../src/persistence/postgres-sql-funding-store";
import { PostgresOperationJournal } from "../../src/release/deployment/postgres-operation-journal";
import { createAuthorizationRequest, createAuthorizationReceipt } from "../../src/release/authorization";
import { DirectUploadScopeSchema, createExactDirectSealedUploadAdapter } from "../../src/release/native/direct-upload";
import { createProductionDirectCliUploadPort } from "../../src/production/direct-cli-upload";
import { loadPinnedDirectCliNetworkHelpers } from "../../src/production/pinned-direct-cli-network";

const isolated = process.env.NAPPLET_RUN_POSTGRES_ISOLATION === "1" ? test : test.skip;
const hash = (value: string | Uint8Array) => new Bun.CryptoHasher("sha256").update(value).digest("hex");
async function docker(args: string[]) {
  const child = Bun.spawn(["docker", ...args], { stdout: "pipe", stderr: "pipe", stdin: "ignore" });
  const timer = setTimeout(() => child.kill(), 15_000);
  try {
    const [stdout, stderr, code] = await Promise.all([new Response(child.stdout).text(), new Response(child.stderr).text(), child.exited]);
    if (code !== 0) throw new Error(`DOCKER_FAILED:${args[0]}:${stderr.slice(0, 300)}`);
    return stdout.trim();
  } finally { clearTimeout(timer); }
}
function adapter(pool: Pool, loseDispatchCommit: () => boolean): PostgresSqlPool {
  return { async connect() {
    const client = await pool.connect(); let dispatch = false;
    return { async query<Row extends Record<string, unknown> = Record<string, unknown>>(sql: string, values?: readonly unknown[]) {
      const result = await client.query<Row>(sql, values ? [...values] : undefined);
      if (sql.startsWith("UPDATE production_real.release_operation_journal") && String(values?.[5]).includes('"state":"dispatching"') && result.rows.length) dispatch = true;
      if (sql === "COMMIT" && dispatch && loseDispatchCommit()) throw new Error("FIXTURE_COMMIT_ACK_LOST");
      return result;
    }, release() { client.release(); } };
  } };
}

// Local transport proof only: restricted real PostgreSQL, verified local TLS,
// upstream CLI code, and disposable fixture keys. No release certification.
isolated("direct upload binds receipts and raw HTML, fences dispatch permanently, and recovers by exact GET", async () => {
  const name = `cvm-direct-upload-${crypto.randomUUID().replaceAll("-", "")}`;
  let admin: Pool | undefined, application: Pool | undefined, close = () => {};
  try {
    const cert = process.env.NAPPLET_PUBLICATION_TEST_TLS_CERT, key = process.env.NAPPLET_PUBLICATION_TEST_TLS_KEY;
    if (!cert || !key) throw new Error("RUN_BUN_SCRIPTS_TEST_DIRECT_UPLOAD_FOR_LOCAL_TLS");
    let now = Math.floor(Date.now() / 1000) * 1000, puts = 0, heads = 0, gets = 0;
    let mode: "lost" | "deny" | "expire" | "redirect" = "lost";
    const blobs = new Map<string, Uint8Array>();
    const server = Bun.serve({ hostname: "127.0.0.1", port: 0, tls: { cert: Bun.file(cert), key: Bun.file(key) }, async fetch(request): Promise<Response> {
      const path = new URL(request.url).pathname;
      if (request.method === "PUT") {
        puts++;
        expect(path).toBe("/upload");
        if (mode === "deny") return new Response(null, { status: 401 });
        if (mode === "redirect") return new Response(null, { status: 307, headers: { location: `${server.url.origin}/escaped` } });
        const bytes = new Uint8Array(await request.arrayBuffer());
        blobs.set(hash(bytes), bytes);
        return new Response("lost acknowledgement", { status: 503 });
      }
      if (request.method === "HEAD") { heads++; return new Response(null, { status: 200 }); }
      gets++;
      if (mode === "expire") now += 20_000;
      const bytes = blobs.get(path.slice(1));
      return bytes ? new Response(new Uint8Array(bytes)) : new Response(null, { status: 404 });
    } });
    close = () => { server.stop(true); };
    const origin = server.url.origin;
    await docker(["run", "--detach", "--rm", "--name", name, "--publish", "127.0.0.1::5432", "-e", "POSTGRES_HOST_AUTH_METHOD=trust", "postgres:17-alpine"]);
    const port = (await docker(["port", name, "5432/tcp"])).match(/127\.0\.0\.1:(\d+)/u)?.[1];
    if (!port) throw new Error("POSTGRES_PORT_UNAVAILABLE");
    admin = new Pool({ connectionString: `postgresql://postgres@127.0.0.1:${port}/postgres`, connectionTimeoutMillis: 2000 });
    for (let attempt = 0; attempt < 90; attempt++) {
      try { await admin.query("SELECT 1"); break; } catch (error) { if (attempt === 89) throw error; await Bun.sleep(100); }
    }
    for (const migration of ["phase-03/001_funding.sql", "phase-04/001_metered_generation.sql", "phase-04/002_action_budget_lifecycle.sql", "phase-03/002_production_accounting.sql", "phase-07/001_production_operation_journal.sql"]) await admin.query(await Bun.file(`migrations/${migration}`).text());
    await admin.query("CREATE ROLE direct_upload_test LOGIN");
    await admin.query("GRANT napplet_production_real TO direct_upload_test");
    application = new Pool({ connectionString: `postgresql://direct_upload_test@127.0.0.1:${port}/postgres`, connectionTimeoutMillis: 2000 });
    let loseCommit = false;
    const pool = adapter(application, () => { const lose = loseCommit; loseCommit = false; return lose; });
    const journal = () => new PostgresOperationJournal(pool, { namespace: "direct-upload", scopeSha256: hash("local-test") });
    const ownerKey = new Uint8Array(32).fill(7), helpers = await loadPinnedDirectCliNetworkHelpers();
    async function fixture(label: string) {
      const binding = { candidateSha256: hash("candidate"), topologySha256: hash("topology"), effectPlanSha256: hash("effects"), accountScopeSha256: hash("account"), projectScopeSha256: hash("project") };
      const bytes = new TextEncoder().encode(`<!doctype html><main>${label}</main>`), artifactHash = hash(bytes);
      const request = await createAuthorizationRequest({ candidateSha256: binding.candidateSha256, topologySha256: binding.topologySha256, effectPlanSha256: binding.effectPlanSha256,
        controllerStateSha256: hash("controller"), providerCapabilitiesSha256: hash("capabilities"),
        orderedEffects: [{ id: "sealed-upload", provider: "upload", operation: "verify_integration", estimatedCostMicros: 1 }],
        providerScopes: [{ provider: "upload", accountScopeSha256: binding.accountScopeSha256, projectScopeSha256: binding.projectScopeSha256 }],
        estimate: { currency: "USD", maximumMicros: 1, sourceId: "local-only-fixture", observedAtMs: now - 1, freshUntilMs: now + 20_000 },
        maximumRunDurationMs: 1000, cleanupByMs: now + 9000, evidenceRetentionDays: 30, artifactRetentionDays: 30,
        gcpEffects: { projectBootstrap: false, billing: false, apiEnablement: ["storage.googleapis.com"] }, expiresAtMs: now + 10_000 });
      const receipt = await createAuthorizationReceipt(request);
      const ownerManifest = finalizeEvent({ kind: 35129, created_at: Math.floor(now / 1000), content: "", tags: [["d", "fixture"], ["x", artifactHash], ["server", origin]] }, ownerKey);
      const config = { ...binding, version: "direct-sealed-upload-v1", operationId: `direct-upload:${hash(label)}`, intentReference: `fixture:${label}`,
        artifactHash, archiveSha256: hash(`archive:${label}`), ownerManifest, server: origin, targetReference: "local-only", retentionDays: 30, intentExpiresAtMs: now + 10_000 };
      let authorization: Event | undefined;
      await helpers.createUploadAuthorization({ async sign(template) { authorization = finalizeEvent(template, ownerKey); return authorization; } }, [artifactHash], Math.floor(now / 1000), "127.0.0.1");
      if (!authorization) throw new Error("FIXTURE_AUTH_MISSING");
      const completed = authorization;
      const makePort = () => createProductionDirectCliUploadPort({ server: origin, targetReference: config.targetReference, ownerPubkey: getPublicKey(ownerKey), binding, journal: journal(), now: () => now });
      const make = async () => createExactDirectSealedUploadAdapter({ config, request, receipt, port: await makePort(), now: () => now });
      return { config, request, receipt, make, makePort, call: { operationId: config.operationId, files: [{ path: "/index.html", mimeType: "text/html", sha256: artifactHash, size: bytes.length, bytes }], authorization: completed } };
    }

    const first = await fixture("lost-response");
    expect(await (await first.make()).uploadExact(first.call)).toMatchObject({ state: "complete", fullServerUploadId: `${origin}/${first.config.artifactHash}` });
    expect(puts).toBe(1); expect(heads).toBe(0); expect(gets).toBeGreaterThanOrEqual(2);
    now += 4_000_000;
    expect(await (await first.make()).reconcileOriginalUpload(first.call)).toMatchObject({ state: "complete" });
    await expect((await first.make()).uploadExact(first.call)).rejects.toThrow("DIRECT_SEALED_UPLOAD_AUTHORIZATION_INVALID");
    expect(puts).toBe(1);
    const retained = await journal().read(`direct-cli-upload:v1:${hash(first.call.operationId)}`);
    expect(JSON.stringify(retained?.value)).toContain(first.config.archiveSha256);
    expect(JSON.stringify(retained?.value)).not.toContain("aggregate");

    mode = "deny";
    const denied = await fixture("no-unscoped-retry");
    expect(await (await denied.make()).uploadExact(denied.call)).toMatchObject({ state: "unknown" });
    expect(puts).toBe(2);
    expect(await (await denied.make()).uploadExact(denied.call)).toMatchObject({ state: "unknown" });
    expect(puts).toBe(2);

    mode = "expire";
    const expired = await fixture("expires-during-get");
    expect(await (await expired.make()).uploadExact(expired.call)).toMatchObject({ state: "unknown" });
    expect(puts).toBe(2);
    mode = "lost";
    const lost = await fixture("lost-dispatch-commit"); loseCommit = true;
    expect(await (await lost.make()).uploadExact(lost.call)).toMatchObject({ state: "unknown" });
    expect(await (await lost.make()).uploadExact(lost.call)).toMatchObject({ state: "unknown" });
    expect(puts).toBe(2);

    const bad = await fixture("invalid-authority");
    await expect(createExactDirectSealedUploadAdapter({ config: bad.config, request: bad.request, receipt: { ...bad.receipt, candidateSha256: hash("other") }, port: await bad.makePort(), now: () => now }).uploadExact(bad.call)).rejects.toThrow();
    await expect((await bad.make()).uploadExact({ ...bad.call, files: [{ ...bad.call.files[0]!, bytes: new Uint8Array([1]) }] })).rejects.toThrow("DIRECT_SEALED_UPLOAD_BYTES_INVALID");
    expect(await journal().read(`direct-cli-upload:v1:${hash(bad.call.operationId)}`)).toBeUndefined();
    expect(puts).toBe(2);

    // Bypassing the adapter still cannot dispatch without matching authority
    // and a completed owner signature over the actual CLI's exact hash scope.
    const leaf = await fixture("leaf-authority"), leafPort = await leaf.makePort();
    const { accountScopeSha256: _account, projectScopeSha256: _project, ...leafConfig } = leaf.config;
    await leafPort.persist(DirectUploadScopeSchema.parse({ ...leafConfig, authorizationRequestSha256: leaf.request.authorizationRequestSha256, authorizationReceiptSha256: leaf.receipt.authorizationReceiptSha256 }));
    const leafCall = { ...leaf.call, targetReference: leaf.config.targetReference, retentionDays: leaf.config.retentionDays, effectAuthorization: { request: leaf.request, receipt: leaf.receipt } };
    await expect(leafPort.uploadExact({ ...leafCall, effectAuthorization: { request: leaf.request, receipt: { ...leaf.receipt, authorizationReceiptSha256: hash("forged") } } })).rejects.toThrow();
    const wrongHashToken = finalizeEvent({ kind: leaf.call.authorization.kind, created_at: leaf.call.authorization.created_at, content: leaf.call.authorization.content,
      tags: leaf.call.authorization.tags.map(tag => tag[0] === "x" ? ["x", hash("wrong")] : tag) }, ownerKey);
    await expect(leafPort.uploadExact({ ...leafCall, authorization: wrongHashToken })).rejects.toThrow("DIRECT_UPLOAD_AUTH_SCOPE_DOWNGRADE_DENIED");
    expect((await journal().read<{ state: string }>(`direct-cli-upload:v1:${hash(leaf.call.operationId)}`))?.value.state).toBe("prepared");
    expect(puts).toBe(2);

    const corrupt = await fixture("corrupt-existing-bytes");
    blobs.set(corrupt.config.artifactHash, new Uint8Array([1, 2]));
    expect(await (await corrupt.make()).uploadExact(corrupt.call)).toMatchObject({ state: "complete" });
    expect(puts).toBe(3);

    const existing = await fixture("existing-correct-bytes");
    blobs.set(existing.config.artifactHash, existing.call.files[0]!.bytes);
    expect(await (await existing.make()).uploadExact(existing.call)).toMatchObject({ state: "complete" });
    expect(puts).toBe(3);

    mode = "redirect";
    const redirected = await fixture("no-redirects");
    expect(await (await redirected.make()).uploadExact(redirected.call)).toMatchObject({ state: "unknown" });
    expect(puts).toBe(4);
    mode = "lost";
    const concurrent = await fixture("concurrent");
    await Promise.allSettled([(await concurrent.make()).uploadExact(concurrent.call), (await concurrent.make()).uploadExact(concurrent.call)]);
    expect(await (await concurrent.make()).reconcileOriginalUpload(concurrent.call)).toMatchObject({ state: "complete" });
    expect(puts).toBe(5);
  } finally {
    close(); await application?.end(); await admin?.end(); await docker(["rm", "--force", name]).catch(() => undefined);
  }
}, 120_000);
