import { expect, test } from "bun:test";
import { mkdir, mkdtemp, rm } from "node:fs/promises";
import { join } from "node:path";

import { canonicalJson } from "../../src/promotion/schema";
import { ProductionCertificationEdgeService } from "../../src/production/certification-edge";
import { createNonGoogleInvocationAuthorityVerifier } from "../../src/production/non-google-invocation-authority";
import { NonGoogleSuccessorControl } from "../../src/production/non-google-successor-control";
import { createNonGoogleAuthorizationRequestV3 } from "../../src/release/contracts";
import { RELEASE_PRODUCTION_PROVIDER_IDS } from "../../src/release/native-registry";
import { PostgresOperationJournal } from "../../src/release/deployment/postgres-operation-journal";
import { ProductionCoreControlClient } from "../../src/release/deployment/production-core-control";
import { sealProductionSessionBroker } from "../../src/release/deployment/production-session-runtime";
import { createOpenAiResponsesClient, type OpenAiResponsesJournalEntry, type OpenAiResponsesOperationJournal } from "../../src/release/deployment/openai-responses-client";
import { NonGooglePrivateControlClient, createNonGooglePrivateControlCapability, createNonGooglePrivateControlHandler } from "../../src/release/deployment/non-google-private-control";
import { createMountedProductionSessionMaterial } from "../../src/production/mounted-session-material";
import { mountedBillingRecoveryFixture } from "./helpers/mounted-billing-recovery-fixture";
import type { PostgresSqlPool } from "../../src/persistence/postgres-sql-funding-store";

const digest = (letter: string) => letter.repeat(64);
const text = new TextEncoder();
const rate = (now: number) => ({ version: 2 as const, sourceUrl: "https://developers.openai.com/api/docs/models/gpt-4.1" as const, sourceDocumentSha256: digest("9"), sourceArtifactSha256: digest("9"), quoteSha256: digest("8"), observedAtMs: now - 1_000, freshUntilMs: now + 60_000, model: "gpt-4.1-2025-04-14", currency: "USD" as const, inputMicrosPerMillion: 1, cachedInputMicrosPerMillion: 1, outputMicrosPerMillion: 1 });

function memoryPool(): PostgresSqlPool {
  const rows = new Map<string, Record<string, unknown>>();
  const key = (namespace: unknown, scope: unknown, operation: unknown) => `${namespace}:${scope}:${operation}`;
  return Object.freeze({ async connect() {
    return Object.freeze({
      async query<Row extends Record<string, unknown>>(sql: string, values: readonly unknown[] = []) {
        const result = (value: readonly Record<string, unknown>[]) => Object.freeze({ rows: value as readonly Row[] });
        if (sql.startsWith("SELECT current_user::text AS current_user, session_user")) return result([{ current_user: "edge_runtime_test", session_user: "edge_runtime_test", current_is_superuser: false, session_is_superuser: false }]);
        if (sql.startsWith("SELECT current_user::text AS current_user")) return result([{ current_user: "napplet_production_real" }]);
        if (/^(?:SET |RESET |BEGIN |COMMIT|ROLLBACK)/u.test(sql) || sql.startsWith("SELECT pg_advisory_xact_lock")) return result([]);
        if (sql.startsWith("SELECT count(*)::text")) return result([{ count: String([...rows.values()].filter(row => row.namespace === values[0] && row.scope_sha256 === values[1]).length) }]);
        if (sql.startsWith("SELECT * FROM production_real.release_operation_journal")) { const row = sql.includes("operation_id=$3") ? rows.get(key(values[0], values[1], values[2])) : undefined; return result(row ? [row] : []); }
        if (sql.startsWith("INSERT INTO production_real.release_operation_journal")) { const operationKey = key(values[0], values[1], values[2]), prior = rows.get(operationKey); if (prior) return result([]); const row = { namespace: values[0], scope_sha256: values[1], operation_id: values[2], identity_sha256: values[3], value_json: JSON.parse(String(values[4])), revision: 1 }; rows.set(operationKey, row); return result([row]); }
        if (sql.startsWith("UPDATE production_real.release_operation_journal")) { const operationKey = key(values[0], values[1], values[2]), prior = rows.get(operationKey); if (!prior || prior.identity_sha256 !== values[3] || prior.revision !== values[4]) return result([]); const row = { ...prior, value_json: JSON.parse(String(values[5])), revision: Number(prior.revision) + 1 }; rows.set(operationKey, row); return result([row]); }
        throw new Error(`UNEXPECTED_TEST_JOURNAL_SQL:${sql.slice(0, 80)}`);
      }, release() {},
    });
  } });
}
async function sha256(value: unknown): Promise<string> { return Array.from(new Uint8Array(await crypto.subtle.digest("SHA-256", text.encode(canonicalJson(value)))), value => value.toString(16).padStart(2, "0")).join(""); }
async function sha256Bytes(value: Uint8Array): Promise<string> { const owned = new ArrayBuffer(value.byteLength); new Uint8Array(owned).set(value); return Array.from(new Uint8Array(await crypto.subtle.digest("SHA-256", owned)), byte => byte.toString(16).padStart(2, "0")).join(""); }

async function signedAuthority(now: () => number, scopes = ["edge.payment"], effects = ["edge.payment.model"], options: Readonly<{ expiresAtMs?: number; originalOperations?: readonly { operationId: string; operationSha256: string; candidateSha256: string; topologySha256: string; roleCostBoundSha256: string }[]; expiredOriginalObservationScopes?: readonly string[] }> = {}) {
  const pair = await crypto.subtle.generateKey({ name: "Ed25519" }, true, ["sign", "verify"]);
  const request = await createNonGoogleAuthorizationRequestV3({ identity: { candidateSha256: digest("a"), sourceSha256: digest("b"), configSha256: digest("c"), toolchainSha256: digest("d"), topologySha256: digest("e"), failureDomainSha256: digest("f"), retentionSha256: digest("0"), cleanupSha256: digest("1"), controllerStateSha256: digest("2") }, binding: { providerGraphRevision: "non-google-v1", roleInventorySha256: digest("3"), roleCostBoundSha256: digest("4"), scopesSha256: await sha256(scopes), effectsSha256: await sha256(effects) } });
  const costBytes = text.encode("controller-owned-cost-artifact");
  const unsigned = { version: "non-google-invocation-envelope-v1" as const, issuerId: "controller-root-1", issuedAtMs: now() - 2, expiresAtMs: options.expiresAtMs ?? now() + 60_000, request, receipt: { kind: "release-authorization-receipt-v4" as const, version: 4 as const, requestSha256: request.requestSha256, candidateSha256: digest("a"), topologySha256: digest("e"), providerGraphRevision: "non-google-v1" as const, roleInventorySha256: digest("3"), roleCostBoundSha256: digest("4"), receiptSha256: digest("5") }, scopes, effects, costArtifactSha256: await sha256Bytes(costBytes), ...(options.originalOperations ? { originalOperations: options.originalOperations } : {}) };
  const signature = Buffer.from(new Uint8Array(await crypto.subtle.sign({ name: "Ed25519" }, pair.privateKey, text.encode(canonicalJson(unsigned)))).buffer).toString("base64url");
  const verifier = createNonGoogleInvocationAuthorityVerifier({ trustedIssuers: [{ issuerId: unsigned.issuerId, publicKeySpkiDer: new Uint8Array(await crypto.subtle.exportKey("spki", pair.publicKey)) }], allowedScopes: scopes, allowedEffects: effects, costArtifact: { bytes: costBytes, sha256: unsigned.costArtifactSha256 }, ...(options.expiredOriginalObservationScopes ? { expiredOriginalObservationScopes: options.expiredOriginalObservationScopes } : {}), now });
  return { authority: await verifier.verify({ ...unsigned, signature }), authorizationRequestSha256: request.requestSha256 };
}

function sealedModelEdge(now: number, responses: OpenAiResponsesJournalEntry, port: Readonly<{ create(): Promise<{ bytes: Uint8Array }>; get(id: string): Promise<{ bytes: Uint8Array }> }>) {
  const responseRows = new Map([[responses.operationId, responses]]);
  const responseJournal: OpenAiResponsesOperationJournal = Object.freeze({ async claim(entry) { return Object.freeze({ claimed: false, entry: responseRows.get(entry.operationId) ?? entry }); }, async read(operationId) { return responseRows.get(operationId); }, async write(entry) { responseRows.set(entry.operationId, entry); } });
  const openAi = createOpenAiResponsesClient({ candidateSha256: digest("a"), credentialReference: "openai:api-key:production-reference", model: responses.model, rate: responses.rate, maximumChargeMicros: responses.maximumChargeMicros, journal: responseJournal, port, now: () => now });
  const journal = new PostgresOperationJournal(memoryPool(), { namespace: "edge:broker", scopeSha256: digest("b") });
  const control = new ProductionCoreControlClient({ serviceUrl: "https://legacy-control.run.app", candidateSha256: digest("a"), topologySha256: digest("e"), request: {}, receipt: {}, journal, identity: { async token() { throw new Error("ADC_MUST_NOT_RUN"); } } });
  const blocked = async () => { throw new Error("UNUSED_EDGE_PORT"); }, provider = Object.freeze({ discoverCapabilities: blocked, discoverAuthentication: blocked, plan: blocked, apply: blocked, observe: blocked, cleanup: blocked });
  const broker = sealProductionSessionBroker({ realm: "production-real", candidateSha256: digest("a"), topologySha256: digest("e"), journal, clients: { google: {}, workers: {}, contextvm: {}, contextvmCertification: {}, vertex: {}, descriptors: {}, edge: { compatibleHost: {}, signer: {}, cep8: {}, cashu: {}, promotedCli: {}, relays: {}, openAiResponses: { provenance: { module: "src/release/deployment/openai-responses-client.ts", export: "createOpenAiResponsesClient", purpose: "openai-responses", journalNamespace: "openai:responses", rateQuoteSha256: responses.rate.quoteSha256 }, client: openAi } }, publicationContext: { resolve: blocked, deploy: blocked, source: blocked, original: blocked, observeUpload: blocked }, paymentScenarioContext: { resolve: blocked }, sourceBuild: { authority: "production-real", verify: blocked } }, providers: Object.fromEntries(RELEASE_PRODUCTION_PROVIDER_IDS.map(id => [id, { origin: "project-owned", evidenceClass: "real", brokerReference: `test:${id}`, port: provider }])), workerCandidate: { id: digest("a"), provider: "modal", image: `registry.example/worker@sha256:${digest("b")}`, sourceSha256: digest("c") }, control, prepare: blocked } as never);
  return new ProductionCertificationEdgeService({ broker });
}

test("handler-backed native model recovery uses signed GET-only original observation", async () => {
  let now = 1_000_000, posts = 0, gets = 0;
  const known: OpenAiResponsesJournalEntry = { operationId: "model_original_operation", requestSha256: digest("a"), nonce: "napplet-cvm:model_original_operation", clientRequestId: `napplet-cvm-${digest("a")}`, request: { idea: "one idea", systemInstruction: "bounded instruction", maximumInputTokens: 100, maximumOutputTokens: 20 }, candidateSha256: digest("a"), credentialReference: "openai:api-key:production-reference", model: "gpt-4.1-2025-04-14", rate: rate(now), maximumChargeMicros: 10_000, responseId: "resp_known_response" };
  const edge = sealedModelEdge(now, known, { async create() { posts += 1; throw new Error("POST_MUST_NOT_RUN"); }, async get(id) { gets += 1; expect(id).toBe("resp_known_response"); if (gets === 1) throw new Error("TRANSIENT_GET"); return { bytes: text.encode(JSON.stringify({ id, model: known.model, status: "completed", output: [{ type: "message", role: "assistant", content: [{ type: "output_text", text: "verified output" }] }], usage: { input_tokens: 1, output_tokens: 1 } })) }; } });
  const payload = { candidateId: digest("a"), require: ["openai_responses_usage", "openai_price_digest", "cap", "exact_settlement", "cancellation", "known_id_get_only", "unknown_id_held", "one_dispatch", "one_debit"] as const };
  const operationSha256 = await sha256({ operationId: known.operationId, kind: "edge.payment.model", payload, candidateSha256: digest("a"), topologySha256: digest("e"), roleCostBoundSha256: digest("4") });
  const { authority, authorizationRequestSha256 } = await signedAuthority(() => now, ["edge.payment"], ["edge.payment.model"], { expiresAtMs: now + 1, expiredOriginalObservationScopes: ["edge.payment"], originalOperations: [{ operationId: known.operationId, operationSha256, candidateSha256: digest("a"), topologySha256: digest("e"), roleCostBoundSha256: digest("4") }] });
  const control = new NonGoogleSuccessorControl({ authority, journal: new PostgresOperationJournal(memoryPool(), { namespace: "edge:successor", scopeSha256: digest("c") }), edge, candidateSha256: digest("a"), topologySha256: digest("e"), roleCostBoundSha256: digest("4"), authorizationRequestSha256 });
  const capability = createNonGooglePrivateControlCapability({ keyId: "coolify-edge-control-v1", secret: text.encode("controller-owned-test-capability-material"), expiresAtMs: Date.now() + 60_000 });
  const handler = createNonGooglePrivateControlHandler({ capability, control, now: () => now });
  const client = new NonGooglePrivateControlClient({ serviceUrl: "https://control.homelab.example", candidateSha256: digest("a"), topologySha256: digest("e"), roleCostBoundSha256: digest("4"), authorizationRequestSha256, capability, authority, journal: new PostgresOperationJournal(memoryPool(), { namespace: "edge:client", scopeSha256: digest("d") }), now: () => now, fetch: async (url, init) => handler.handle(new Request(url, init)) });
  expect((await client.execute({ operationId: known.operationId, kind: "edge.payment.model", payload })).state).toBe("unknown");
  now += 2;
  expect((await client.execute({ operationId: known.operationId, kind: "edge.payment.model", payload })).state).toBe("completed");
  expect({ posts, gets }).toEqual({ posts: 0, gets: 2 });
});

test("native control rejects Run origin and wrong signed role before journal, credential, or provider access", async () => {
  let accesses = 0; const now = () => 1_000_000;
  const { authority, authorizationRequestSha256 } = await signedAuthority(now, ["edge.payment"], ["edge.payment.contextvm"]);
  const capability = createNonGooglePrivateControlCapability({ keyId: "coolify-edge-control-v1", secret: text.encode("controller-owned-test-capability-material"), expiresAtMs: Date.now() + 60_000 });
  const journal = new PostgresOperationJournal({ async connect() { accesses += 1; throw new Error("JOURNAL_MUST_NOT_OPEN"); } }, { namespace: "edge:rejected", scopeSha256: digest("a") });
  expect(() => new NonGooglePrivateControlClient({ serviceUrl: "https://legacy.run.app", candidateSha256: digest("a"), topologySha256: digest("e"), roleCostBoundSha256: digest("4"), authorizationRequestSha256, capability, authority, journal })).toThrow("NON_GOOGLE_PRIVATE_CONTROL_ORIGIN_INVALID");
  const client = new NonGooglePrivateControlClient({ serviceUrl: "https://control.homelab.example", candidateSha256: digest("a"), topologySha256: digest("e"), roleCostBoundSha256: digest("4"), authorizationRequestSha256, capability, authority, journal, now, fetch: async () => { accesses += 1; throw new Error("NETWORK_MUST_NOT_OPEN"); } });
  await expect(client.execute({ operationId: "model_rejected_operation", kind: "edge.payment.model", payload: { candidateId: digest("a"), require: ["openai_responses_usage", "openai_price_digest", "cap", "exact_settlement", "cancellation", "known_id_get_only", "unknown_id_held", "one_dispatch", "one_debit"] } })).rejects.toThrow("NON_GOOGLE_INVOCATION_SCOPE_DENIED");
  expect(accesses).toBe(0);
});

test("the normal mounted entry rejects shaped successor material before secret, provider, database, or client access", async () => {
  const workspaceRoot = join(process.cwd(), ".runtime", "release-certification", "native-discovery-v1"); await mkdir(workspaceRoot, { recursive: true }); const workspace = await mkdtemp(join(workspaceRoot, "edge-runtime-"));
  const fixture = await mountedBillingRecoveryFixture(workspace, Date.now()); const request = await createNonGoogleAuthorizationRequestV3({ identity: { candidateSha256: fixture.candidateSha256, sourceSha256: digest("b"), configSha256: digest("c"), toolchainSha256: digest("d"), topologySha256: fixture.topologySha256, failureDomainSha256: digest("f"), retentionSha256: digest("0"), cleanupSha256: digest("1"), controllerStateSha256: digest("2") }, binding: { providerGraphRevision: "non-google-v1", roleInventorySha256: digest("3"), roleCostBoundSha256: digest("4"), scopesSha256: digest("5"), effectsSha256: digest("6") } });
  const material = { version: "non-google-edge-v1" as const, candidateSha256: fixture.candidateSha256, topologySha256: fixture.topologySha256, successorAuthorization: { request, receipt: { kind: "release-authorization-receipt-v4" as const, version: 4 as const, requestSha256: request.requestSha256, candidateSha256: fixture.candidateSha256, topologySha256: fixture.topologySha256, providerGraphRevision: "non-google-v1" as const, roleInventorySha256: digest("3"), roleCostBoundSha256: digest("4"), receiptSha256: digest("7") } }, openAiResponses: { credentialReference: "openai:api-key:production-reference", model: "gpt-4.1-2025-04-14", maximumChargeMicros: 1_000_000, rate: rate(Date.now()) } };
  let effects = 0; const generation = { config: fixture.config, get dependencies() { effects += 1; throw new Error("DEPENDENCIES_MUST_NOT_OPEN"); }, get authorization() { effects += 1; throw new Error("AUTHORIZATION_MUST_NOT_OPEN"); } };
  await expect(createMountedProductionSessionMaterial({ config: fixture.config, generation: generation as never, resolved: { workerCandidate: { id: fixture.candidateSha256 }, nonGoogleEdge: material } as never, secrets: new Proxy({}, { get() { effects += 1; throw new Error("SECRETS_MUST_NOT_OPEN"); } }) as never })).rejects.toThrow("SUCCESSOR_GRAPH_ARCHITECTURE_GUARD_ACTIVE");
  expect(effects).toBe(0); await rm(workspace, { recursive: true, force: true });
});
