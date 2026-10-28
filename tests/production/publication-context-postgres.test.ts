import { Pool } from "pg";
import { expect, test } from "bun:test";
import { finalizeEvent, getPublicKey } from "nostr-tools/pure";
import { SignedOwnerManifestEventSchema } from "../../src/publication/contracts";
import { canonicalJson } from "../../src/promotion/schema";
import { DeterministicObjectStore, type ObjectStorePort } from "../../src/continuity/object-store";
import { createAuthorizationRequest, createAuthorizationReceipt } from "../../src/release/authorization";
import { PostgresOperationJournal } from "../../src/release/deployment/postgres-operation-journal";
import type { PostgresSqlPool } from "../../src/persistence/postgres-sql-funding-store";
import { materializeMountedSourceBuildPlan, bindMountedSourceBuildExecution } from "../../src/production/source-build-plan";
import { persistMountedSourceBuildEvidence, type MountedSourceBuildResult } from "../../src/production/source-build-verifier";
import { ProductionPublicationContextMaterializer } from "../../src/production/publication-context";
import { createProductionPublicationUpload } from "../../src/production/publication-upload";
import { ProductionEdgeContexts } from "../../src/production/edge-contexts";

const isolated = process.env.NAPPLET_RUN_POSTGRES_ISOLATION === "1" ? test : test.skip;
const hash = (value: string | Uint8Array) => new Bun.CryptoHasher("sha256").update(value).digest("hex");
async function docker(args: string[]) {
  const process = Bun.spawn(["docker", ...args], { stdout: "pipe", stderr: "pipe", stdin: "ignore" });
  const timer = setTimeout(() => process.kill(), 15_000);
  try {
    const [stdout, stderr, code] = await Promise.all([new Response(process.stdout).text(), new Response(process.stderr).text(), process.exited]);
    if (code !== 0) throw new Error(`DOCKER_FAILED:${args[0]}:${stderr.slice(0, 300)}`);
    return stdout.trim();
  } finally { clearTimeout(timer); }
}
function adapter(pool: Pool): PostgresSqlPool {
  return { async connect() { const client = await pool.connect(); return { async query<Row extends Record<string, unknown> = Record<string, unknown>>(sql: string, values?: readonly unknown[]) { return client.query<Row>(sql, values ? [...values] : undefined); }, release() { client.release(); } }; } };
}

// Local contract fixture with actual restricted PostgreSQL. The CLI-shaped
// receipt below is not protected build, signing, funding or release evidence.
isolated("publication contexts derive exact CLI and BUD templates, recover original bundle only, and retain scoped historical reads", async () => {
  const name = `napplet-cvm-publication-context-${crypto.randomUUID().replaceAll("-", "")}`;
  let admin: Pool | undefined, application: Pool | undefined;
  try {
    await docker(["run", "--detach", "--rm", "--name", name, "--network", "bridge", "--publish", "127.0.0.1::5432", "-e", "POSTGRES_HOST_AUTH_METHOD=trust", "postgres:17-alpine"]);
    const port = (await docker(["port", name, "5432/tcp"])).match(/127\.0\.0\.1:(\d+)/u)?.[1];
    if (!port) throw new Error("POSTGRES_PORT_UNAVAILABLE");
    admin = new Pool({ connectionString: `postgresql://postgres@127.0.0.1:${port}/postgres`, connectionTimeoutMillis: 2000 });
    for (let attempt = 0; attempt < 90; attempt++) {
      try { await admin.query("SELECT 1"); break; } catch (error) { if (attempt === 89) throw error; await Bun.sleep(100); }
    }
    for (const migration of ["phase-03/001_funding.sql", "phase-04/001_metered_generation.sql", "phase-04/002_action_budget_lifecycle.sql", "phase-03/002_production_accounting.sql", "phase-07/001_production_operation_journal.sql"]) await admin.query(await Bun.file(`migrations/${migration}`).text());
    await admin.query("CREATE ROLE publication_context_test LOGIN");
    await admin.query("GRANT napplet_production_real TO publication_context_test");
    application = new Pool({ connectionString: `postgresql://publication_context_test@127.0.0.1:${port}/postgres`, connectionTimeoutMillis: 2000 });
    const pool = adapter(application), scope = "a".repeat(64);
    const journal = () => new PostgresOperationJournal(pool, { namespace: "publication-context", scopeSha256: scope });
    const sourceJournal = () => new PostgresOperationJournal(pool, { namespace: "publication-source", scopeSha256: scope });
    let now = 1_000_000;
    const providers = ["gcs", "signer", "promoted_cli", "upload", "owner_relay", "attestation_relay"] as const;
    const request = await createAuthorizationRequest({ candidateSha256: scope, topologySha256: "b".repeat(64), effectPlanSha256: "c".repeat(64), controllerStateSha256: "d".repeat(64), providerCapabilitiesSha256: "e".repeat(64),
      orderedEffects: providers.map(provider => ({ id: provider === "upload" ? "sealed-upload" : `verify-${provider}`, provider, operation: "verify_integration" as const, estimatedCostMicros: 1 })),
      providerScopes: providers.map(provider => ({ provider, accountScopeSha256: "f".repeat(64), projectScopeSha256: "0".repeat(64) })),
      estimate: { currency: "USD", maximumMicros: 6, sourceId: "fixture", observedAtMs: now - 1, freshUntilMs: now + 20_000 }, maximumRunDurationMs: 1000, cleanupByMs: now + 9000, evidenceRetentionDays: 30, artifactRetentionDays: 30,
      gcpEffects: { projectBootstrap: false, billing: false, apiEnablement: ["storage.googleapis.com"] }, expiresAtMs: now + 10_000 });
    const receipt = await createAuthorizationReceipt(request);
    const authorization = { request, receipt, authorizationRequestSha256: request.authorizationRequestSha256, authorizationReceiptSha256: receipt.authorizationReceiptSha256 };
    const plan = materializeMountedSourceBuildPlan({ candidateSha256: scope, topologySha256: request.topologySha256, provider: "modal" });
    const run = bindMountedSourceBuildExecution(plan, { authorizationRequestSha256: request.authorizationRequestSha256 });
    const payload = new TextEncoder().encode(`<!doctype html><main>${"Fixture bytes ".repeat(800)}</main>`);
    const file = { path: "index.html", sha256: hash(payload), size: payload.length, bytesBase64: Buffer.from(payload).toString("base64") };
    const aggregate = hash(`${file.sha256} /index.html\n`), dTag = "cvm-actual-cli-shape";
    const template = { kind: 35129 as const, created_at: now / 1000, tags: [["d", dTag], ["path", "/index.html", file.sha256], ["x", aggregate, "aggregate"], ["title", "Generated napplet"]], content: "" };
    const manifest = { item: { kind: 35129, target: "named", dTag }, files: [{ path: "/index.html", sha256: file.sha256 }], aggregateHash: aggregate, template };
    const capabilities = '{"required":[],"optional":[]}';
    const result: MountedSourceBuildResult = { candidateId: scope, sealedArtifactSha256: hash(JSON.stringify([{ path: file.path, sha256: file.sha256, bytes: file.size }])), manifestSha256: hash(canonicalJson(manifest)), capabilitiesSha256: hash(capabilities), aggregateSha256: aggregate, jobId: "1".repeat(64), workerOperationId: run.workerOperationId, capacityReference: `capacity:${"2".repeat(64)}` };
    const source = { version: 1, artifact: { sealedObjectSha256: result.sealedArtifactSha256, aggregateSha256: aggregate, files: [file] }, receipts: { manifest, manifestSha256: result.manifestSha256, capabilities: { content: capabilities, capabilitiesSha256: result.capabilitiesSha256 }, workerArtifactSha256: "3".repeat(64), commandEvidenceSha256: "4".repeat(64) }, operation: { operationId: run.operationId, planJobId: plan.jobId, authorizationRequestSha256: request.authorizationRequestSha256, topologySha256: request.topologySha256, ...result } };
    const bytes = new TextEncoder().encode(canonicalJson(source)), base = new DeterministicObjectStore();
    await persistMountedSourceBuildEvidence({ journal: sourceJournal(), artifactStore: base, run, bytes, value: { key: `certification/source-build/${scope}/${run.jobId}/evidence.json`, checksum: hash(bytes), result } });
    let uploads = 0, hideBundle = true, corruptBundle = false;
    const objects: ObjectStorePort = {
      async createImmutable(value) { uploads++; await base.createImmutable(value); throw new Error("BUNDLE_ACK_LOST"); },
      async observeExactByKey(value) { return hideBundle && value.key.includes("/publication/") ? undefined : base.observeExactByKey(value); },
      async readExact(value) { return corruptBundle && value.key.includes("/publication/") ? new TextEncoder().encode("changed") : base.readExact(value); },
      scheduleExactDeletion: (value, after) => base.scheduleExactDeletion(value, after),
    };
    const secret = new Uint8Array(32).fill(7), ownerPubkey = getPublicKey(secret);
    const configuration = { candidateSha256: scope, topologySha256: request.topologySha256, ownerPubkey, policyVersion: "fixture-policy", toolchainIdentity: "5".repeat(64), compatibleHostReference: "host:fixture", compatibleHostSha256: "6".repeat(64), sourcePlan: plan, authorization, journal: journal(), sourceJournal: sourceJournal(), artifactStore: objects, relaySet: ["wss://relay.example"], uploadServers: ["https://uploads.example"], now: () => now };
    const open = () => new ProductionPublicationContextMaterializer({ ...configuration, journal: journal(), sourceJournal: sourceJournal() });
    await expect(open().materialize()).rejects.toThrow("PRODUCTION_PUBLICATION_BUNDLE_UNAVAILABLE");
    expect(uploads).toBe(1);
    hideBundle = false;
    const context = await open().materialize();
    expect(uploads).toBe(1);
    expect(context.intentDigest).toBe(context.intent.fingerprint);
    expect(context.intent.dTag).toBe(dTag);
    expect(context.intent.manifestTemplateDigest).toBe(hash(canonicalJson(template)));
    const contexts = new ProductionEdgeContexts({ journal: journal(), artifactStore: objects, candidateSha256: scope, topologySha256: request.topologySha256, authorizationRequestSha256: request.authorizationRequestSha256 });
    expect(await contexts.signer.resolve({ intentDigest: context.intentDigest })).toMatchObject({ ownerPubkey, template });
    const upload = await contexts.signer.resolveOriginal({ operationId: `upload_authorization:${context.intent.intentId}`, purpose: "upload_authorization" });
    expect(upload.template).toEqual({ kind: 24242, created_at: template.created_at, content: "Upload blobs via napplet", tags: [["t", "upload"], ["x", file.sha256], ["expiration", String(template.created_at + 3600)], ["client", "napplet"], ["server", "uploads.example"]] });
    const signed = SignedOwnerManifestEventSchema.parse(finalizeEvent(structuredClone(template), secret));
    expect(await open().ownerEventVerifier.verify({ event: signed, intent: context.intent })).toEqual({ valid: true, accepted: true, eventId: signed.id });
    expect(await open().ownerEventVerifier.verify({ event: { ...signed, content: "changed" }, intent: context.intent })).toMatchObject({ valid: false });
    expect(await open().ownerEventVerifier.verify({ event: SignedOwnerManifestEventSchema.parse(finalizeEvent(structuredClone(template), new Uint8Array(32).fill(8))), intent: context.intent })).toMatchObject({ valid: false });
    const identity = { candidateSha256: scope, sealedArtifactSha256: result.sealedArtifactSha256, aggregateSha256: aggregate, operationId: `deploy:${context.intent.intentId}` };
    const deployment = await contexts.publication.deploy(identity);
    expect(deployment.files[0]).toMatchObject({ path: "/index.html", mimeType: "text/html", sha256: file.sha256 });
    expect(deployment.files[0]!.bytes).toEqual(payload);
    // The deferred adapter resolves source facts itself; no future artifact
    // hashes or manually constructed upload config are supplied by the caller.
    let persists = 0, sends = 0, uploaded = false;
    const uploadAdapter = () => createProductionPublicationUpload({ materializer: open(), authorization, targetReference: "blossom:fixture", now: () => now, port: {
      async persist(value) { persists++; expect(value).toMatchObject({ operationId: identity.operationId, sealedArtifactSha256: result.sealedArtifactSha256, aggregateSha256: aggregate, authorizationRequestSha256: request.authorizationRequestSha256 }); },
      async observeOriginalUpload({ operationId }) { return uploaded ? { status: "complete", operationId, targetReference: "blossom:fixture", retentionDays: 30, fileChecksums: [file.sha256], locationReference: "blossom:original" } : { status: "missing" }; },
      async uploadExact(value) { sends++; expect(value.files).toEqual(deployment.files); uploaded = true; throw new Error("LOST_UPLOAD_ACK"); },
    } });
    const send = { operationId: identity.operationId, files: deployment.files, authorizeExactHashes: async (hashes: readonly string[]) => { expect(hashes).toEqual([file.sha256]); return signed; } };
    await expect(uploadAdapter().uploadExact({ ...send, operationId: "deploy:replacement" })).rejects.toThrow("PRODUCTION_PUBLICATION_UPLOAD_OPERATION_REQUIRED");
    await expect(uploadAdapter().uploadExact({ ...send, files: [{ ...deployment.files[0]!, mimeType: "changed/type" }] })).rejects.toThrow("PRODUCTION_PUBLICATION_UPLOAD_FILES_REQUIRED");
    await expect(uploadAdapter().uploadExact({ ...send, files: [{ ...deployment.files[0]!, bytes: new Uint8Array(payload.length) }] })).rejects.toThrow("SEALED_UPLOAD_BYTES_INVALID");
    expect({ persists, sends }).toEqual({ persists: 0, sends: 0 });
    expect(await uploadAdapter().uploadExact(send)).toMatchObject({ state: "complete", fullServerUploadId: "blossom:original" });
    expect({ persists, sends }).toEqual({ persists: 1, sends: 1 });
    corruptBundle = true;
    await expect(contexts.publication.deploy(identity)).rejects.toThrow("PRODUCTION_EDGE_DEPLOY_BYTES_UNAVAILABLE");
    corruptBundle = false;
    const rows = (await admin.query("SELECT value_json FROM production_real.release_operation_journal WHERE namespace='publication-context'")).rows;
    expect(rows).toHaveLength(4);
    expect(JSON.stringify(rows)).not.toContain(Buffer.from(payload).toString("base64url"));
    const other = new ProductionEdgeContexts({ journal: journal(), artifactStore: objects, candidateSha256: scope, topologySha256: request.topologySha256, authorizationRequestSha256: "9".repeat(64) });
    await expect(other.publication.resolve(identity)).rejects.toThrow("PRODUCTION_EDGE_PUBLICATION_CONTEXT_UNAVAILABLE");
    now += 100_000;
    await expect(uploadAdapter().reconcileOriginalUpload(send)).resolves.toMatchObject({ state: "complete", fullServerUploadId: "blossom:original" });
    await expect(uploadAdapter().uploadExact(send)).rejects.toThrow("SEALED_UPLOAD_AUTHORIZATION_INVALID");
    expect({ persists, sends }).toEqual({ persists: 1, sends: 1 });
    expect(await open().materialize()).toEqual(context);
    expect(await open().ownerEventVerifier.verify({ event: signed, intent: context.intent })).toMatchObject({ valid: true });
    expect(uploads).toBe(1);
    await expect(new ProductionPublicationContextMaterializer({ ...configuration, uploadServers: ["https://changed.example"] }).materialize()).rejects.toThrow("PRODUCTION_PUBLICATION_CONTEXT_BINDING_REQUIRED");
    const invalid = { ...authorization, receipt: { ...receipt, authorizationReceiptSha256: "9".repeat(64) } };
    await expect(new ProductionPublicationContextMaterializer({ ...configuration, authorization: invalid }).materialize()).rejects.toThrow();
    expect(uploads).toBe(1);
  } finally {
    await application?.end(); await admin?.end();
    await docker(["rm", "--force", name]).catch(() => undefined);
  }
}, 120_000);
