import { Pool } from "pg";
import { expect, test } from "bun:test";
import { z } from "zod";
import * as nip44 from "nostr-tools/nip44";
import { matchFilters } from "nostr-tools/filter";
import { finalizeEvent, getPublicKey, verifyEvent, type Event } from "nostr-tools/pure";
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
import { ProductionBuildAttestationSigner } from "../../src/production/attestation-signer";
import { createProductionPublicationRelays } from "../../src/production/publication-relays";
import { createProductionNostrRelayPort } from "../../src/production/nostr-relay";
import type { CvmBuildAttestation } from "../../src/publication/contracts";
import { openProductionNip46Signer } from "../../src/production/nip46-signer";
import { createProductionCliUploadPort } from "../../src/production/cli-upload";
import { createProductionPublicationOperations } from "../../src/production/publication-operations";
import { ProductionPublicationCertification } from "../../src/production/publication-certification";
import { ExternalSignerBoundaryAdapter } from "../../src/release/native/external-signer";
import { createNativePromotedNappletCliSource } from "../../src/release/native/promoted-cli";
import { materializeReviewedSourceBuiltCliSnapshot } from "../../src/publication/napplet-cli-source-contract";
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
  let closeRelay = () => {}, closeOwnerClient = async () => {};
  const fixtureOwnerKey = new Uint8Array(32).fill(7), bunkerKey = new Uint8Array(32).fill(17);
  let retainedOwner: Event | undefined;
  const blobs = new Map<string, Uint8Array>(), nipRequests: string[] = [];
  let actualUploads = 0;
  const events = new Map<string, Event>(), publishes: string[] = [];
  let hideOwner = false, localSigns = 0;
  const serviceKey = new Uint8Array(32).fill(11);
  class MeasuredAttestationSigner extends ProductionBuildAttestationSigner {
    override signBuild(record: CvmBuildAttestation) { localSigns++; return super.signBuild(record); }
  }
  const serviceSigner = new MeasuredAttestationSigner(serviceKey);
  try {
    const cert = process.env.NAPPLET_PUBLICATION_TEST_TLS_CERT, key = process.env.NAPPLET_PUBLICATION_TEST_TLS_KEY;
    if (!cert || !key) throw new Error("RUN_BUN_SCRIPTS_TEST_PUBLICATION_CONTEXT_FOR_LOCAL_TLS");
    const relay = Bun.serve({ hostname: "127.0.0.1", port: 0, tls: { cert: Bun.file(cert), key: Bun.file(key) },
      async fetch(request, server) {
        if (server.upgrade(request)) return undefined;
        const path = new URL(request.url).pathname;
        if (request.method === "PUT" && path === "/upload") {
          const authorization = request.headers.get("authorization");
          if (!authorization?.startsWith("Nostr ")) return new Response("missing owner authorization", { status: 401 });
          const event = JSON.parse(Buffer.from(authorization.slice(6), "base64").toString("utf8"));
          expect(verifyEvent(event)).toBe(true);
          expect(event.pubkey).toBe(getPublicKey(fixtureOwnerKey));
          const bytes = new Uint8Array(await request.arrayBuffer());
          expect(event.tags).toContainEqual(["x", hash(bytes)]);
          blobs.set(hash(bytes), bytes); actualUploads++;
          return new Response("fixture lost upload acknowledgement", { status: 503 });
        }
        const bytes = blobs.get(path.slice(1));
        return bytes ? new Response(request.method === "HEAD" ? null : new Uint8Array(bytes).buffer) : new Response(null, { status: 404 });
      },
      websocket: { message(socket, bytes) {
        const wire = JSON.parse(String(bytes));
        if (wire[0] === "EVENT") {
          const event = SignedOwnerManifestEventSchema.extend({ kind: z.number().int().nonnegative() }).parse(wire[1]);
          if (!verifyEvent(event)) throw new Error("INVALID_LOCAL_RELAY_EVENT");
          events.set(event.id, event);
          if (event.kind === 24133) {
            const conversation = nip44.v2.utils.getConversationKey(bunkerKey, event.pubkey);
            const decoded = z.object({ id: z.string(), method: z.enum(["connect", "get_public_key", "sign_event"]), params: z.array(z.string()) }).strict().parse(JSON.parse(nip44.v2.decrypt(event.content, conversation)));
            nipRequests.push(decoded.method);
            let result: string;
            if (decoded.method === "connect") result = "ack";
            else if (decoded.method === "get_public_key") result = getPublicKey(fixtureOwnerKey);
            else {
              const template = JSON.parse(decoded.params[0]!);
              if (template.kind === 35129) {
                if (!retainedOwner) throw new Error("OWNER_FIXTURE_NOT_READY");
                expect(template).toEqual({ kind: retainedOwner.kind, content: retainedOwner.content, tags: retainedOwner.tags, created_at: retainedOwner.created_at });
                result = JSON.stringify(retainedOwner);
              } else result = JSON.stringify(finalizeEvent(template, fixtureOwnerKey));
            }
            const response = finalizeEvent({ kind: 24133, created_at: event.created_at, tags: [["p", event.pubkey]], content: nip44.v2.encrypt(JSON.stringify({ id: decoded.id, result }), conversation) }, bunkerKey);
            events.set(response.id, response);
          } else publishes.push(event.id);
          // Retain exact bytes but deliberately lose every EVENT acknowledgement.
          socket.close(1011, "fixture ack loss");
        } else if (wire[0] === "REQ") {
          const filters = z.array(z.object({ ids: z.array(z.string()).optional(), authors: z.array(z.string()).optional(), kinds: z.array(z.number()).optional(), "#p": z.array(z.string()).optional(), limit: z.number().optional() }).strict()).parse(wire.slice(2));
          for (const event of events.values()) if ((!hideOwner || event.kind !== 35129) && matchFilters(filters, event)) socket.send(JSON.stringify(["EVENT", wire[1], event]));
          socket.send(JSON.stringify(["EOSE", wire[1]]));
        }
      } },
    });
    closeRelay = () => { relay.stop(true); };
    const relaySet = [`wss://127.0.0.1:${relay.port}`];
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
    let now = Math.floor(Date.now() / 1000) * 1000;
    const providers = ["gcs", "signer", "promoted_cli", "upload", "owner_relay", "attestation_relay"] as const;
    const request = await createAuthorizationRequest({ candidateSha256: scope, topologySha256: "b".repeat(64), effectPlanSha256: "c".repeat(64), controllerStateSha256: "d".repeat(64), providerCapabilitiesSha256: "e".repeat(64),
      orderedEffects: providers.map(provider => ({ id: provider === "upload" ? "sealed-upload" : provider === "owner_relay" ? "owner-relay" : provider === "attestation_relay" ? "attestation-relay" : `verify-${provider}`, provider, operation: "verify_integration" as const, estimatedCostMicros: 1 })),
      providerScopes: providers.map(provider => ({ provider, accountScopeSha256: "f".repeat(64), projectScopeSha256: "0".repeat(64) })),
      estimate: { currency: "USD", maximumMicros: 6, sourceId: "fixture", observedAtMs: now - 1, freshUntilMs: now + 20_000 }, maximumRunDurationMs: 1000, cleanupByMs: now + 9000, evidenceRetentionDays: 30, artifactRetentionDays: 30,
      gcpEffects: { projectBootstrap: false, billing: false, apiEnablement: ["storage.googleapis.com"] }, expiresAtMs: now + 10_000 });
    const receipt = await createAuthorizationReceipt(request);
    const authorization = { request, receipt, authorizationRequestSha256: request.authorizationRequestSha256, authorizationReceiptSha256: receipt.authorizationReceiptSha256 };
    const plan = materializeMountedSourceBuildPlan({ candidateSha256: scope, topologySha256: request.topologySha256, provider: "modal", publication: { server: `https://127.0.0.1:${relay.port}` } });
    const run = bindMountedSourceBuildExecution(plan, { authorizationRequestSha256: request.authorizationRequestSha256 });
    const payload = new TextEncoder().encode(`<!doctype html><main>${"Fixture bytes ".repeat(800)}</main>`);
    const file = { path: "index.html", sha256: hash(payload), size: payload.length, bytesBase64: Buffer.from(payload).toString("base64") };
    const aggregate = hash(`${file.sha256} /index.html\n`), dTag = "cvm-actual-cli-shape";
    const template = { kind: 35129 as const, created_at: now / 1000, tags: [["d", dTag], ["path", "/index.html", file.sha256], ["x", aggregate, "aggregate"], ["server", `https://127.0.0.1:${relay.port}`], ["title", "Generated napplet"]], content: "" };
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
    const configuration = { candidateSha256: scope, topologySha256: request.topologySha256, ownerPubkey, policyVersion: "fixture-policy", toolchainIdentity: "5".repeat(64), compatibleHostReference: "host:fixture", compatibleHostSha256: "6".repeat(64), sourcePlan: plan, authorization, journal: journal(), sourceJournal: sourceJournal(), artifactStore: objects, relaySet, uploadServers: [`https://127.0.0.1:${relay.port}`], now: () => now };
    const open = () => new ProductionPublicationContextMaterializer({ ...configuration, journal: journal(), sourceJournal: sourceJournal() });
    expect(await open().source()).toEqual({ candidateId: scope, sealedArtifactSha256: result.sealedArtifactSha256, aggregateSha256: aggregate });
    expect(uploads).toBe(0);
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
    expect(upload.template).toEqual({ kind: 24242, created_at: template.created_at, content: "Upload blobs via napplet", tags: [["t", "upload"], ["x", file.sha256], ["expiration", String(template.created_at + 3600)], ["client", "napplet"], ["server", "127.0.0.1"]] });
    const signed = SignedOwnerManifestEventSchema.parse(finalizeEvent(structuredClone(template), secret));
    retainedOwner = signed;
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
    const relayJournal = () => new PostgresOperationJournal(pool, { namespace: "publication-relay-transport", scopeSha256: scope });
    const relayInput = { operationId: `owner_manifest:${context.intent.intentId}`, event: signed, relays: relaySet };
    const openRelays = (signer: ProductionBuildAttestationSigner = serviceSigner) => createProductionPublicationRelays({ materializer: open(), attestationSigner: signer, authorization,
      journal: journal(), port: createProductionNostrRelayPort({ relays: relaySet, journal: relayJournal(), timeoutMs: 500 }), relaySetReference: "relays:fixture", relaySetSha256: hash(canonicalJson(relaySet)), now: () => now });
    await expect(openRelays().publishOwnerManifest({ ...relayInput, operationId: "owner_manifest:replacement" })).rejects.toThrow("PRODUCTION_PUBLICATION_RELAY_OPERATION_REQUIRED");
    await expect(openRelays().publishOwnerManifest({ ...relayInput, event: { ...signed, content: "changed" } })).rejects.toThrow("PRODUCTION_PUBLICATION_RELAY_OWNER_INVALID");
    const sameKey = new ProductionBuildAttestationSigner(secret);
    await expect(openRelays(sameKey).publishOwnerManifest(relayInput)).rejects.toThrow("PRODUCTION_ATTESTATION_OWNER_KEY_REJECTED");
    sameKey.close();
    expect({ localSigns, sends: publishes.length }).toEqual({ localSigns: 0, sends: 0 });
    expect(await openRelays().publishOwnerManifest(relayInput)).toMatchObject({ state: "completed", relayObservation: signed.id });
    expect({ localSigns, sends: publishes.length }).toEqual({ localSigns: 1, sends: 1 });
    const attestationInput = { operationId: `attestation:${context.intent.intentId}`, artifact: context.artifact, ownerEventId: signed.id };
    hideOwner = true;
    await expect(openRelays().attestationPort.publish(attestationInput)).rejects.toThrow("PRODUCTION_PUBLICATION_OWNER_NOT_OBSERVED");
    expect(publishes).toHaveLength(1);
    hideOwner = false;
    expect(await openRelays().attestationPort.publish(attestationInput)).toMatchObject({ state: "completed" });
    expect(publishes).toHaveLength(2);
    const actualAttestation = [...events.values()].find(event => event.kind === 1)!;
    expect(verifyEvent(actualAttestation)).toBe(true);
    expect(actualAttestation.pubkey).toBe(serviceSigner.publicKey);
    expect(JSON.parse(actualAttestation.content)).toMatchObject({ type: "cvm_build_attestation", ownerEventId: signed.id, ownerPubkey, aggregateSha256: aggregate });
    expect(actualAttestation.pubkey).not.toBe(ownerPubkey);
    const ownerClient = await openProductionNip46Signer({ bunkerUri: `bunker://${getPublicKey(bunkerKey)}?relay=${encodeURIComponent(relaySet[0]!)}&secret=public-fixture-secret`,
      sessionKeyReference: "nostr:disposable-fixture", sessionKeyBroker: { async resolve() { return new Uint8Array(32).fill(13); } },
      authorization, now: () => now, context: contexts.signer, originalOperationContext: contexts.signer, journal: journal(), timeoutMs: 1_000 });
    closeOwnerClient = () => ownerClient.close();
    const actualPort = await createProductionCliUploadPort({ server: configuration.uploadServers[0]!, targetReference: "blossom:actual-fixture", ownerPubkey, journal: journal() });
    const actualUpload = createProductionPublicationUpload({ materializer: open(), authorization, targetReference: "blossom:actual-fixture", port: actualPort, now: () => now });
    const actualRelays = openRelays();
    const promoted = createNativePromotedNappletCliSource({ snapshot: materializeReviewedSourceBuiltCliSnapshot(), upload: actualUpload, relay: actualRelays.asPromotedCliSource() });
    const operations = createProductionPublicationOperations({ materializer: open(), context: contexts.publicationWithSigner(ownerClient), source: promoted, upload: actualUpload });
    const certification = new ProductionPublicationCertification(scope, { publicationContext: operations, edge: { signer: new ExternalSignerBoundaryAdapter({ signer: ownerClient, ownerEventVerifier: open().ownerEventVerifier }), promotedCli: promoted, relays: actualRelays } });
    const unavailableSource = createNativePromotedNappletCliSource({ snapshot: {}, upload: actualUpload, relay: actualRelays.asPromotedCliSource() });
    const unavailable = createProductionPublicationOperations({ materializer: open(), context: contexts.publicationWithSigner(ownerClient), source: unavailableSource, upload: actualUpload });
    await expect(unavailable.source()).rejects.toThrow("PRODUCTION_PUBLICATION_CLI_SOURCE_REQUIRED");
    await expect(operations.original({ candidateSha256: scope, sealedArtifactSha256: "9".repeat(64), aggregateSha256: aggregate })).rejects.toThrow("PRODUCTION_PUBLICATION_ORIGINAL_SOURCE_CHANGED");
    const actualSource = await certification.source();
    expect(actualSource).toMatchObject({ status: "passed", candidateId: scope, sealedArtifactSha256: result.sealedArtifactSha256, aggregateSha256: aggregate });
    const submitted = await certification.submit(actualSource);
    expect(submitted).toMatchObject({ status: "submitted", intentId: context.intent.intentId, userSigningExternal: true });
    expect(await certification.reconcile({ candidateId: scope, ...submitted })).toMatchObject({ status: "complete", deploymentObserved: true, ownerRelayObserved: true, attestationRelayObserved: true });
    const originalUploadOperation = `upload_authorization:${context.intent.intentId}`;
    const signedUpload = z.object({ pubkey: z.string(), intentDigest: z.string(), authorizationReceipt: z.string(), event: z.unknown() }).strict().parse(await ownerClient.signExactOperation({ operationId: originalUploadOperation, purpose: "upload_authorization" }));
    const badSigningContext = contexts.publicationWithSigner({ async signExactOperation() { return { ...signedUpload, pubkey: "0".repeat(64) }; } });
    const badDeploy = await badSigningContext.deploy(identity);
    await expect(badDeploy.authorizeExactHashes([file.sha256])).rejects.toThrow("PRODUCTION_EDGE_UPLOAD_SIGNATURE_INVALID");
    const actualDeploy = await contexts.publicationWithSigner(ownerClient).deploy(identity);
    expect(await actualDeploy.authorizeExactHashes([file.sha256])).toMatchObject({ kind: 24242, pubkey: ownerPubkey });
    const publishedOwner = events.get(signed.id)!;
    const publishedServer = publishedOwner.tags.find(tag => tag[0] === "server")![1]!;
    const publishedPath = publishedOwner.tags.find(tag => tag[0] === "path")!;
    const retrieval = await fetch(`${publishedServer}/${publishedPath[2]}`);
    expect(retrieval.status).toBe(200);
    expect(hash(new Uint8Array(await retrieval.arrayBuffer()))).toBe(publishedPath[2]);
    expect(publishedServer).toBe(configuration.uploadServers[0]);
    expect(actualUploads).toBe(1);
    expect(nipRequests).toEqual(["connect", "get_public_key", "sign_event", "sign_event"]);
    now += 100_000;
    await expect(uploadAdapter().reconcileOriginalUpload(send)).resolves.toMatchObject({ state: "complete", fullServerUploadId: "blossom:original" });
    await expect(uploadAdapter().uploadExact(send)).rejects.toThrow("SEALED_UPLOAD_AUTHORIZATION_INVALID");
    expect({ persists, sends }).toEqual({ persists: 1, sends: 1 });
    await ownerClient.close();
    const processSigner = new MeasuredAttestationSigner(serviceKey);
    const processRelays = openRelays(processSigner);
    const processUploadPort = await createProductionCliUploadPort({ server: configuration.uploadServers[0]!, targetReference: "blossom:actual-fixture", ownerPubkey, journal: journal() });
    const processUpload = createProductionPublicationUpload({ materializer: open(), authorization, targetReference: "blossom:actual-fixture", port: processUploadPort, now: () => now });
    const processSource = createNativePromotedNappletCliSource({ snapshot: materializeReviewedSourceBuiltCliSnapshot(), upload: processUpload, relay: processRelays.asPromotedCliSource() });
    const processOperations = createProductionPublicationOperations({ materializer: open(), context: contexts.publicationWithSigner(ownerClient), source: processSource, upload: processUpload });
    const recoveredCertification = new ProductionPublicationCertification(scope, { publicationContext: processOperations, edge: { signer: new ExternalSignerBoundaryAdapter({ signer: ownerClient, ownerEventVerifier: open().ownerEventVerifier }), promotedCli: processSource, relays: processRelays } });
    expect(await recoveredCertification.observeSubmit(actualSource)).toEqual(submitted);
    expect(await recoveredCertification.reconcile({ candidateId: scope, ...submitted })).toMatchObject({ status: "complete" });
    processSigner.close();
    expect(actualUploads).toBe(1);
    expect(nipRequests).toHaveLength(4);
    await expect(operations.observeUpload({ intentId: submitted.intentId, operationId: "deploy:replacement" })).rejects.toThrow("PRODUCTION_PUBLICATION_ORIGINAL_OPERATION_REQUIRED");
    expect(await open().materialize()).toEqual(context);
    expect(await open().ownerEventVerifier.verify({ event: signed, intent: context.intent })).toMatchObject({ valid: true });
    expect(uploads).toBe(1);
    const recoveredSigner = new MeasuredAttestationSigner(serviceKey);
    expect(await openRelays(recoveredSigner).reconcileOriginalEvent({ operationId: relayInput.operationId })).toMatchObject({ state: "completed", relayObservation: signed.id });
    expect(await openRelays(recoveredSigner).attestationPort.observe({ operationId: attestationInput.operationId })).toMatchObject({ state: "completed", relayObservation: actualAttestation.id });
    await expect(openRelays(recoveredSigner).publishOwnerManifest(relayInput)).rejects.toThrow("NOSTR_RELAY_AUTHORIZATION_INVALID");
    expect({ localSigns, sends: publishes.length }).toEqual({ localSigns: 1, sends: 2 });
    recoveredSigner.close();
    const savedRelay = (await admin.query("SELECT operation_id,identity_sha256,revision,value_json FROM production_real.release_operation_journal WHERE namespace='publication-context' AND operation_id LIKE 'publication-relays:%'")).rows[0]!;
    const { attestationEvent: _event, ...preparing } = savedRelay.value_json;
    await journal().compareAndSet(savedRelay.operation_id, savedRelay.identity_sha256, Number(savedRelay.revision), { ...preparing, state: "preparing" });
    await expect(openRelays().reconcileOriginalEvent({ operationId: relayInput.operationId })).rejects.toThrow("PRODUCTION_PUBLICATION_RELAY_SIGNING_UNKNOWN");
    expect({ localSigns, sends: publishes.length }).toEqual({ localSigns: 1, sends: 2 });
    expect(() => new ProductionPublicationContextMaterializer({ ...configuration, uploadServers: ["https://changed.example"] })).toThrow("PRODUCTION_PUBLICATION_APPROVED_SERVER_REQUIRED");
    const invalid = { ...authorization, receipt: { ...receipt, authorizationReceiptSha256: "9".repeat(64) } };
    await expect(new ProductionPublicationContextMaterializer({ ...configuration, authorization: invalid }).materialize()).rejects.toThrow();
    expect(uploads).toBe(1);
  } finally {
    await closeOwnerClient(); closeRelay(); serviceSigner.close();
    await application?.end(); await admin?.end();
    await docker(["rm", "--force", name]).catch(() => undefined);
  }
}, 120_000);
