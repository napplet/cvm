import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { expect } from "bun:test";
import { getPublicKey } from "nostr-tools/pure";
import { loadProductionConfig } from "../../../src/production/config";
import { openMountedProductionSession } from "../../../src/production/runtime";
import { MountedProductionSecretMaterial } from "../../../src/production/secret-material";
import { materializeMountedProductionSessionRecord } from "../../../src/production/mounted-session-record";
import { RELEASE_PRODUCTION_PROVIDER_IDS } from "../../../src/release/native-registry";
import { PRODUCTION_LIVE_PROTECTED_PORT_KEYS } from "../../../src/certification/live/production-ports";
import { mountedBillingRecoveryFixture } from "../../release/helpers/mounted-billing-recovery-fixture";

const database = process.env.NAPPLET_NORMAL_COMPOSITION_DATABASE;
if (!database) throw new Error("NORMAL_COMPOSITION_DATABASE_REQUIRED");

const nowMs = Date.now();
const sha256 = (value: string | Uint8Array) => createHash("sha256").update(value).digest("hex");
const bytes32 = (byte: number) => Buffer.alloc(32, byte).toString("base64");
const secretName = (reference: string) => reference.replaceAll(/[^a-z0-9._-]/giu, "_");

async function writeMountedSecret(secrets: MountedProductionSecretMaterial, binding: Parameters<MountedProductionSecretMaterial["path"]>[0], value: string): Promise<void> {
  await writeFile(secrets.path(binding), value, { mode: 0o600 });
}

async function main(): Promise<void> {
  // The actual controller refuses an unanchored working directory; use its
  // normal durable project root even in this non-real hosted fixture.
  const fixtureRoot = resolve(import.meta.dir, "../../../.runtime/release-certification/native-discovery-v1");
  await mkdir(fixtureRoot, { recursive: true, mode: 0o700 });
  const root = await mkdtemp(join(fixtureRoot, "normal-composition-"));
  const workspace = join(root, "workspace");
  const mount = join(root, "mount");
  await Promise.all([mkdir(workspace, { recursive: true, mode: 0o700 }), mkdir(join(workspace, "states"), { recursive: true, mode: 0o700 }), mkdir(mount, { recursive: true, mode: 0o700 })]);
  try {
    const fixture = await mountedBillingRecoveryFixture(workspace, nowMs);
    // mountedBillingRecoveryFixture has already driven the real
    // ReleaseCertificationController.dryRun() over explicit read-only fixture
    // discovery transports and validates the returned receipt. Keep this
    // explicit in the trace output: it is the controller request construction
    // that the normal mounted factory later reads from its fixed secret mount.
    const stages = ["controller-request"];
    expect(fixture.request.candidateSha256).toBe(fixture.config.candidateSha256);
    expect(fixture.request.topologySha256).toBe(fixture.config.topologySha256);
    expect(fixture.receipt.authorizationRequestSha256).toBe(fixture.request.authorizationRequestSha256);
    const serviceKey = "2".repeat(64);
    const clientKey = "1".repeat(64);
    const sourceDocument = new TextEncoder().encode("deny-effects Vertex price source");
    const price = {
      sourceUrl: "https://cloud.google.com/vertex-ai/generative-ai/pricing",
      sourceDocumentBase64: Buffer.from(sourceDocument).toString("base64"),
      sourceDocumentSha256: sha256(sourceDocument),
      observedAtMs: nowMs - 1_000,
      freshUntilMs: nowMs + 60_000,
      effectiveFromMs: nowMs - 1_000,
      effectiveUntilMs: nowMs + 60_000,
      inputMicrosPerMillion: 1_000,
      cachedInputMicrosPerMillion: 500,
      outputAndThoughtMicrosPerMillion: 2_000,
    };
    const quote = {
      sourceUrl: price.sourceUrl, sourceDocumentSha256: price.sourceDocumentSha256,
      observedAtMs: price.observedAtMs, freshUntilMs: price.freshUntilMs,
      effectiveFromMs: price.effectiveFromMs, effectiveUntilMs: price.effectiveUntilMs,
      inputMicrosPerMillion: price.inputMicrosPerMillion,
      cachedInputMicrosPerMillion: price.cachedInputMicrosPerMillion,
      outputAndThoughtMicrosPerMillion: price.outputAndThoughtMicrosPerMillion,
    };
    const config = loadProductionConfig({
      ...fixture.config,
      contextvm: { ...fixture.config.contextvm, relay: "wss://127.0.0.1:65535", serviceKeyReference: "contextvm:service-fixture" },
      certification: { ...fixture.config.certification, serverPubkey: getPublicKey(new Uint8Array(Buffer.from(serviceKey, "hex"))), clientKeyReference: "cert:client-fixture" },
      funding: { ...fixture.config.funding, nwcConnectionReference: "nwc:fixture-connection", cashuConsentReference: "cashu:fixture-policy" },
      vertex: { ...fixture.config.vertex, credentialReference: "gcp:adc:fixture", priceSnapshotSha256: sha256(JSON.stringify(quote)) },
    });
    const record = materializeMountedProductionSessionRecord({ config, measured: fixture.measured });
    const secrets = new MountedProductionSecretMaterial(config, { root: mount });
    const nwcPolicy = {
      version: "fixture-v1", activeFrom: new Date(nowMs - 60_000).toISOString(), activeUntil: null,
      mints: [
        { url: "https://mint-one.example", unit: "sat", keysetIds: ["fixture-one"], maxInputFeePpk: 0, requireDleq: false, proofConditions: ["none"] },
        { url: "https://mint-two.example", unit: "sat", keysetIds: ["fixture-two"], maxInputFeePpk: 0, requireDleq: false, proofConditions: ["none"] },
      ],
    };
    const conversion = { source: { url: "https://cloud.google.com/fixture-fx", capturedBytesSha256: sha256("fx"), observedAt: new Date(nowMs - 1_000).toISOString(), effectiveAt: new Date(nowMs - 1_000).toISOString(), freshUntil: new Date(nowMs + 60_000).toISOString() }, satsPerUsd: { numerator: "1000", denominator: "1" } };
    await Promise.all([
      writeMountedSecret(secrets, "cloudSql.roleCredentialReference", JSON.stringify({ host: "10.0.0.9", port: 5432, user: "napplet_cvm_runtime", password: "fixture-runtime-password-which-is-long-enough", servername: "fixture.sql.internal" })),
      writeMountedSecret(secrets, "cloudSql.restoreRecoveredRoleCredentialReference", JSON.stringify({ host: "10.0.0.10", port: 5432, user: "napplet_cvm_runtime", password: "fixture-recovered-password-which-is-long-enough", servername: "fixture.sql.internal" })),
      writeMountedSecret(secrets, "cloudSql.restoreMigrationRoleCredentialReference", JSON.stringify({ host: "10.0.0.11", port: 5432, user: "napplet_cvm_runtime", password: "fixture-migration-password-which-is-long-enough", servername: "fixture.sql.internal" })),
      writeMountedSecret(secrets, "contextvm.serviceKeyReference", serviceKey),
      writeMountedSecret(secrets, "certification.clientKeyReference", clientKey),
      writeMountedSecret(secrets, "certification.authorizationRequestReference", JSON.stringify(fixture.request)),
      writeMountedSecret(secrets, "certification.authorizationReceiptReference", JSON.stringify(fixture.receipt)),
      writeMountedSecret(secrets, "certification.sessionMaterialReference", JSON.stringify(record)),
      writeMountedSecret(secrets, "funding.nwcConnectionReference", JSON.stringify({ connectionScopeDigest: sha256("nwc-scope"), walletPubkey: getPublicKey(new Uint8Array(32).fill(3)), relays: ["wss://127.0.0.1:65535"], consentedMethods: ["make_invoice", "lookup_invoice", "list_transactions"], privateKey: "4".repeat(64) })),
      writeMountedSecret(secrets, "funding.cashuConsentReference", JSON.stringify({ policy: nwcPolicy })),
      writeMountedSecret(secrets, "funding.protectedMaterialReference", bytes32(5)),
      writeMountedSecret(secrets, "funding.admissionReceiptReference", bytes32(6)),
      writeMountedSecret(secrets, "funding.statusCursorReference", bytes32(7)),
      writeMountedSecret(secrets, "vertex.credentialReference", JSON.stringify({ credentialReference: "gcp:adc:fixture", price: { ...price, quoteSha256: sha256(JSON.stringify(quote)) }, conversion })),
      writeMountedSecret(secrets, "worker.modalAccessReference", JSON.stringify({ tokenId: "fixture-modal-token-id", tokenSecret: "fixture-modal-token-secret", appName: "fixture-modal-app" })),
      writeMountedSecret(secrets, "worker.flyAccessReference", JSON.stringify({ token: "fixture-fly-token", appName: "fixture-fly-app", region: "ams" })),
      writeMountedSecret(secrets, "publication.signerSessionKeyReference", "8".repeat(64)),
      writeMountedSecret(secrets, "publication.signerBrokerReference", "bunker:fixture-disposable-signer-authority"),
      writeMountedSecret(secrets, "publication.attestationKeyReference", "9".repeat(64)),
      writeMountedSecret(secrets, "gcs.migrationBackupKeyReference", bytes32(10)),
      writeMountedSecret(secrets, "checkpoint.kekReference", bytes32(11)),
    ]);
    let handler: ((message: unknown) => void) | undefined;
    const constructionEvents: string[] = [];
    const session = await openMountedProductionSession({
      config,
      secrets,
      now: () => nowMs,
      postgresConstructionTransport: Object.freeze({
        async open(input) {
          assert.equal(input.credential.host, "10.0.0.9");
          assert.equal(input.credential.user, "napplet_cvm_runtime");
          const { Pool } = await import("pg");
          const pool = new Pool({ connectionString: database, connectionTimeoutMillis: 2_000 });
          await pool.query("SELECT current_user");
          return Object.freeze({ pool, close: () => pool.end() });
        },
      }),
      constructionTransport: Object.freeze({
        onMessage(value) { constructionEvents.push("handler"); handler = value; },
        async start() { constructionEvents.push("start"); },
        async send(value) {
          const message = value as { method?: string; id?: string };
          constructionEvents.push(message.method ?? "response");
          if (message.id === "cert:certification_bootstrap:1") handler?.({ jsonrpc: "2.0", id: message.id, result: {} });
        },
        async close() { constructionEvents.push("close"); },
      }),
    });
    stages.push("mounted-producer", "provenance-sealer", "contextvm-handshake");
    // A structural material stand-in cannot reach this point: the sealer's
    // private mounted-producer WeakSet assertion runs before broker assembly.
    expect(session.sealed.authorization.request).toMatchObject({
      candidateSha256: config.candidateSha256,
      topologySha256: config.topologySha256,
      authorizationRequestSha256: fixture.request.authorizationRequestSha256,
    });
    expect(session.sealed.authorization.receipt).toMatchObject({
      candidateSha256: config.candidateSha256,
      topologySha256: config.topologySha256,
      authorizationReceiptSha256: fixture.receipt.authorizationReceiptSha256,
    });
    expect(Object.isFrozen(session.sealed)).toBe(true);
    expect(Object.keys(session.session.providers)).toEqual([...RELEASE_PRODUCTION_PROVIDER_IDS]);
    expect(Object.keys(session.session.protectedPorts)).toEqual([...PRODUCTION_LIVE_PROTECTED_PORT_KEYS]);
    expect(constructionEvents).toEqual(["handler", "start", "initialize", "notifications/initialized"]);
    stages.push("sixteen-providers-eight-suites");
    await expect(session.session.prepare({ authorizationRequest: fixture.request, receipt: { ...fixture.receipt, authorizationReceiptSha256: "0".repeat(64) } })).rejects.toThrow();
    expect(session.effects).toEqual({ discoverCapabilities: 0, discoverAuthentication: 0, plan: 0, apply: 0, observe: 0, cleanup: 0, suites: 0 });
    stages.push("unapproved-zero-dispatch");
    await session.generation.close();
    console.log(JSON.stringify({ passed: true, stages, providers: Object.keys(session.session.providers).length, suites: Object.keys(session.session.protectedPorts).length, effects: session.effects }));
  } finally { await rm(root, { recursive: true, force: true }); }
}

await main();
