import { expect, test } from "bun:test";
import { createRequire } from "node:module";
import { finalizeEvent, generateSecretKey, getPublicKey } from "nostr-tools/pure";
import { createProductionCliUploadPort } from "../../src/production/cli-upload";
import { canonicalSealedDeployAggregate } from "../../src/publication/napplet-cli-adapter";
import { PostgresOperationJournal } from "../../src/release/deployment/postgres-operation-journal";
const hash = (value: Uint8Array | string) => new Bun.CryptoHasher("sha256").update(value).digest("hex");
const integration = process.env.NAPPLET_RUN_POSTGRES_ISOLATION === "1" ? test : test.skip;
integration("actual pinned CLI upload persists before PUT and recovers exact bytes on a fresh client without redispatch", async () => {
  const blobs = new Map<string, Uint8Array>();
  const requests: Array<{ method: string; path: string; authorization: string | null }> = [];
  let behavior: "lost-response" | "reject-authorization" | "normal" = "lost-response";
  const server = Bun.serve({ hostname: "127.0.0.1", port: 0, async fetch(request) {
    const path = new URL(request.url).pathname;
    requests.push({ method: request.method, path, authorization: request.headers.get("authorization") });
    if (request.method === "PUT" && path === "/upload") {
      if (behavior === "reject-authorization") return new Response("invalid auth signature", { status: 401 });
      const bytes = new Uint8Array(await request.arrayBuffer()); const sha256 = hash(bytes); blobs.set(sha256, bytes);
      if (behavior === "lost-response") return new Response("upstream acknowledgement lost", { status: 503 });
      return Response.json({ sha256 });
    }
    const bytes = blobs.get(path.slice(1)); return bytes ? new Response(new Uint8Array(bytes).buffer) : new Response(null, { status: 404 });
  } });
  const name = `napplet-cvm-upload-${crypto.randomUUID().replaceAll("-", "")}`;
  const docker = async (...args: string[]) => {
    const child = Bun.spawn(["docker", ...args], { stdout: "pipe", stderr: "pipe" });
    const timer = setTimeout(() => child.kill(), 15_000);
    try {
      const [code, output, error] = await Promise.all([child.exited, new Response(child.stdout).text(), new Response(child.stderr).text()]);
      if (code !== 0) throw new Error(`DOCKER_${args[0]}:${error.slice(0, 300)}`);
      return output.trim();
    } finally { clearTimeout(timer); }
  };
  const { Pool } = createRequire(import.meta.url)("pg");
  let admin: any, application: any;

  try {
    await docker("run", "--detach", "--rm", "--name", name, "--publish", "127.0.0.1::5432", "-e", "POSTGRES_HOST_AUTH_METHOD=trust", "postgres:17-alpine");
    const port = (await docker("port", name, "5432/tcp")).match(/127\.0\.0\.1:(\d+)/u)?.[1];
    if (!port) throw new Error("POSTGRES_PORT_MISSING");
    admin = new Pool({ connectionString: `postgresql://postgres@127.0.0.1:${port}/postgres`, connectionTimeoutMillis: 2_000 });
    for (let attempt = 0; attempt < 60; attempt++) {
      try { await admin.query("SELECT 1"); break; }
      catch (error) { if (attempt === 59) throw error; await Bun.sleep(250); }
    }
    for (const migration of ["phase-03/001_funding.sql", "phase-04/001_metered_generation.sql", "phase-04/002_action_budget_lifecycle.sql", "phase-05/001_continuation.sql", "phase-06/001_publication.sql", "phase-03/002_production_accounting.sql", "phase-03/003_cashu_custody_and_identities.sql", "phase-03/004_production_rail_material_scope.sql", "phase-07/001_production_operation_journal.sql"]) await admin.query(await Bun.file(`migrations/${migration}`).text());
    await admin.query("CREATE ROLE relay_test LOGIN");
    await admin.query("GRANT napplet_production_real TO relay_test");
    application = new Pool({ connectionString: `postgresql://relay_test@127.0.0.1:${port}/postgres`, connectionTimeoutMillis: 2_000 });
    const journal = () => new PostgresOperationJournal(application, { namespace: "cli-upload", scopeSha256: "a".repeat(64) });
    const key = generateSecretKey(); const ownerPubkey = getPublicKey(key); const targetReference = "candidate-blossom";
    const config = { journal: journal(), server: `http://127.0.0.1:${server.port}`, ownerPubkey, targetReference, timeoutMs: 2000 };
    const makeFile = (value: string) => { const bytes = new TextEncoder().encode(value); return { path: "/index.html", bytes, size: bytes.byteLength, sha256: hash(bytes), mimeType: "text/html" }; };
    const file = makeFile("<!doctype html><title>Verified exact CLI upload</title>");
    const scope = (operationId: string, selected = file) => ({ operationId, authorizationRequestSha256: "b".repeat(64), authorizationReceiptSha256: "c".repeat(64), candidateSha256: "d".repeat(64), sealedArtifactSha256: "e".repeat(64), aggregateSha256: canonicalSealedDeployAggregate([selected]), targetReference, retentionDays: 30 });
    const authorization = (selected = file) => { const created_at = Math.floor(Date.now()/1000); return finalizeEvent({ kind: 24242, created_at, content: "Upload blobs via napplet", tags: [["t","upload"],["x",selected.sha256],["expiration",String(created_at+3600)],["client","napplet"],["server","127.0.0.1"]] }, key); };
    const uploadPort = await createProductionCliUploadPort(config);
    await uploadPort.persist(scope("publish:lost"));
    expect(await uploadPort.observeOriginalUpload({ operationId: "publish:lost", targetReference })).toEqual({ status: "missing" });
    const upload = { operationId: "publish:lost", targetReference, retentionDays: 30, files: [file], authorization: authorization() };
    await expect(uploadPort.uploadExact(upload)).rejects.toThrow("UPLOAD_OUTCOME_REQUIRES_OBSERVATION");
    const put = requests.filter(request => request.method === "PUT"); expect(put).toHaveLength(1);
    expect(JSON.parse(Buffer.from(put[0]!.authorization!.slice(6), "base64url").toString())).toEqual(JSON.parse(JSON.stringify(upload.authorization)));
    const persisted = await journal().read(`cli-upload:${hash(upload.operationId)}`);
    expect(persisted?.value).toMatchObject({ state: "dispatching", files: [{ sha256: file.sha256 }], authorization: { id: upload.authorization.id } });
    const fresh = await createProductionCliUploadPort({ ...config, journal: journal() });
    await fresh.persist(scope(upload.operationId));
    expect(await fresh.observeOriginalUpload({ operationId: upload.operationId, targetReference })).toMatchObject({ status: "complete", fileChecksums: [file.sha256] });
    await expect(fresh.uploadExact(upload)).rejects.toThrow("UPLOAD_ORIGINAL_REQUIRES_OBSERVATION");
    expect(requests.filter(request => request.method === "PUT")).toHaveLength(1);
    blobs.set(file.sha256, new Uint8Array(file.size).fill(65));
    expect(await fresh.observeOriginalUpload({ operationId: upload.operationId, targetReference })).toMatchObject({ status: "unknown" });
    await expect(fresh.persist({ ...scope(upload.operationId), candidateSha256: "f".repeat(64) })).rejects.toThrow("OPERATION_IDENTITY_CONFLICT");
    await expect(fresh.uploadExact({ ...upload, files: [{ ...file, bytes: new Uint8Array(file.size) }] })).rejects.toThrow("UPLOAD_EXACT_BYTES_REQUIRED");

    behavior = "reject-authorization";
    const rejected = makeFile("rejected auth candidate"); await fresh.persist(scope("publish:rejected", rejected));
    await expect(fresh.uploadExact({ ...upload, operationId: "publish:rejected", files: [rejected], authorization: authorization(rejected) })).rejects.toThrow("UPLOAD_AUTH_SCOPE_DOWNGRADE_DENIED");
    expect(requests.filter(request => request.method === "PUT")).toHaveLength(2);
    expect(await fresh.observeOriginalUpload({ operationId: "publish:rejected", targetReference })).toMatchObject({ status: "unknown" });
    await expect(fresh.uploadExact({ ...upload, operationId: "publish:rejected", files: [rejected], authorization: authorization(rejected) })).rejects.toThrow("UPLOAD_ORIGINAL_REQUIRES_OBSERVATION");
    expect(requests.filter(request => request.method === "PUT")).toHaveLength(2);

    behavior = "normal";
    const valid = makeFile("second candidate"); await fresh.persist(scope("publish:normal", valid));
    const auth = authorization(valid);
    await expect(fresh.uploadExact({ ...upload, operationId: "publish:normal", files: [valid], authorization: { ...auth, content: "tampered" } })).rejects.toThrow("UPLOAD_OWNER_AUTHORIZATION_INVALID");
    expect(requests.filter(request => request.method === "PUT")).toHaveLength(2);
    await fresh.uploadExact({ ...upload, operationId: "publish:normal", files: [valid], authorization: auth });
    expect(await fresh.observeOriginalUpload({ operationId: "publish:normal", targetReference })).toMatchObject({ status: "complete" });
    expect(requests.filter(request => request.method === "PUT")).toHaveLength(3);
    // Existing correct content is hash-verified through GET before upstream skips PUT.
    await fresh.persist(scope("publish:existing", valid));
    await fresh.uploadExact({ ...upload, operationId: "publish:existing", files: [valid], authorization: auth });
    expect(requests.filter(request => request.method === "PUT")).toHaveLength(3);
    expect(await fresh.observeOriginalUpload({ operationId: "publish:existing", targetReference })).toMatchObject({ status: "complete" });
  } finally {
    server.stop(true); await application?.end(); await admin?.end(); await docker("rm", "--force", name).catch(() => undefined);
  }
}, 130000);
