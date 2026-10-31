import { expect, test } from "bun:test";
import { mkdir, mkdtemp, rm } from "node:fs/promises";
import { join } from "node:path";

import { canonicalJson } from "../../src/promotion/schema";
import { NonGoogleCertificationEdgeService, sealNonGoogleCertificationEdgeBroker } from "../../src/production/non-google-certification-edge";
import { CertificationEdgePayloadSchemas } from "../../src/production/certification-edge-protocol";
import { createNonGoogleInvocationAuthorityVerifier } from "../../src/production/non-google-invocation-authority";
import { NonGoogleSuccessorControl } from "../../src/production/non-google-successor-control";
import { createNonGoogleAuthorizationRequestV3 } from "../../src/release/contracts";
import { PostgresOperationJournal } from "../../src/release/deployment/postgres-operation-journal";
import { createOpenAiResponsesClient, type OpenAiResponsesJournalEntry, type OpenAiResponsesOperationJournal } from "../../src/release/deployment/openai-responses-client";
import { NonGooglePrivateControlClient, createNonGooglePrivateControlCapability, createNonGooglePrivateControlHandler } from "../../src/release/deployment/non-google-private-control";
import { createProductionEdgeSuiteAdapters } from "../../src/release/deployment/production-edge-suite-adapters";
import { createMountedProductionSessionMaterial } from "../../src/production/mounted-session-material";
import { mountedBillingRecoveryFixture } from "./helpers/mounted-billing-recovery-fixture";
import type { PostgresSqlPool } from "../../src/persistence/postgres-sql-funding-store";
import { DirectPublicationSourceObservationSchema, DirectPublicationSubmissionSchema } from "../../src/certification/live/direct-publication-contract";
import { DIRECT_CLI_NETWORK_IDENTITY } from "../../src/production/pinned-direct-cli-network";

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
async function sha256Text(value: string): Promise<string> { return Array.from(new Uint8Array(await crypto.subtle.digest("SHA-256", text.encode(value))), byte => byte.toString(16).padStart(2, "0")).join(""); }
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

function sealedModelEdge(now: number, responses: OpenAiResponsesJournalEntry, port: Readonly<{ create(): Promise<{ bytes: Uint8Array }>; get(id: string): Promise<{ bytes: Uint8Array }> }>, sourceBuild: (input: unknown) => Promise<unknown> = async () => ({ verified: true })) {
  const responseRows = new Map([[responses.operationId, responses]]);
  const responseJournal: OpenAiResponsesOperationJournal = Object.freeze({ async claim(entry) { return Object.freeze({ claimed: false, entry: responseRows.get(entry.operationId) ?? entry }); }, async read(operationId) { return responseRows.get(operationId); }, async write(entry) { responseRows.set(entry.operationId, entry); } });
  const openAi = createOpenAiResponsesClient({ candidateSha256: digest("a"), credentialReference: "openai:api-key:production-reference", model: responses.model, rate: responses.rate, maximumChargeMicros: responses.maximumChargeMicros, journal: responseJournal, port, now: () => now });
  const broker = sealNonGoogleCertificationEdgeBroker({
    candidateSha256: digest("a"),
    topologySha256: digest("e"),
    sourceBuild: { authority: "production-real", verify: sourceBuild },
    openAiResponses: openAi,
  });
  return new NonGoogleCertificationEdgeService({ broker });
}

test("handler-backed native model recovery uses signed GET-only original observation", async () => {
  let now = 1_000_000, posts = 0, gets = 0;
  const known: OpenAiResponsesJournalEntry = { operationId: "model_original_operation", requestSha256: digest("a"), nonce: "napplet-cvm:model_original_operation", clientRequestId: `napplet-cvm-${digest("a")}`, request: { idea: "one idea", systemInstruction: "bounded instruction", maximumInputTokens: 100, maximumOutputTokens: 20 }, candidateSha256: digest("a"), credentialReference: "openai:api-key:production-reference", model: "gpt-4.1-2025-04-14", rate: rate(now), maximumChargeMicros: 10_000, responseId: "resp_known_response" };
  const edge = sealedModelEdge(now, known, { async create() { posts += 1; throw new Error("POST_MUST_NOT_RUN"); }, async get(id) { gets += 1; expect(id).toBe("resp_known_response"); if (gets === 1) throw new Error("TRANSIENT_GET"); return { bytes: text.encode(JSON.stringify({ id, model: known.model, status: "completed", output: [{ type: "message", role: "assistant", content: [{ type: "output_text", text: "verified output" }] }], usage: { input_tokens: 1, output_tokens: 1 } })) }; } });
  const payload = { candidateId: digest("a"), require: ["openai_responses_usage", "openai_price_digest", "cap", "exact_settlement", "cancellation", "known_id_get_only", "unknown_id_held", "one_dispatch", "one_debit"] as const };
  const operationSha256 = await sha256({ operationId: known.operationId, kind: "edge.payment.model", payload, candidateSha256: digest("a"), topologySha256: digest("e"), roleCostBoundSha256: digest("4") });
  const { authority, authorizationRequestSha256 } = await signedAuthority(() => now, ["edge.payment"], ["edge.payment.model"], { expiresAtMs: now + 1, expiredOriginalObservationScopes: ["edge.payment"], originalOperations: [{ operationId: known.operationId, operationSha256, candidateSha256: digest("a"), topologySha256: digest("e"), roleCostBoundSha256: digest("4") }] });
  const control = new NonGoogleSuccessorControl({ authority, journal: new PostgresOperationJournal(memoryPool(), { namespace: "edge:successor", scopeSha256: digest("c") }), edge, candidateSha256: digest("a"), topologySha256: digest("e"), roleCostBoundSha256: digest("4"), authorizationRequestSha256 });
  const capability = createNonGooglePrivateControlCapability({ keyId: "coolify-edge-control-v1", secret: text.encode("controller-owned-test-capability-material"), expiresAtMs: now + 60_000, now: () => now });
  const handler = createNonGooglePrivateControlHandler({ capability, control, now: () => now });
  const client = new NonGooglePrivateControlClient({ serviceUrl: "https://control.homelab.example", candidateSha256: digest("a"), topologySha256: digest("e"), roleCostBoundSha256: digest("4"), authorizationRequestSha256, capability, authority, journal: new PostgresOperationJournal(memoryPool(), { namespace: "edge:client", scopeSha256: digest("d") }), now: () => now, fetch: async (url, init) => handler.handle(new Request(url, init)) });
  expect((await client.execute({ operationId: known.operationId, kind: "edge.payment.model", payload })).state).toBe("unknown");
  now += 1;
  expect((await client.execute({ operationId: known.operationId, kind: "edge.payment.model", payload })).state).toBe("completed");
  await expect(client.execute({ operationId: "model_unrecorded_operation", kind: "edge.payment.model", payload })).rejects.toThrow("NON_GOOGLE_INVOCATION_EXPIRED");
  expect({ posts, gets }).toEqual({ posts: 0, gets: 2 });
});

test("native control rejects Run origin and wrong signed role before journal, credential, or provider access", async () => {
  let accesses = 0; const now = () => 1_000_000;
  const { authority, authorizationRequestSha256 } = await signedAuthority(now, ["edge.payment"], ["edge.payment.contextvm"]);
  const capability = createNonGooglePrivateControlCapability({ keyId: "coolify-edge-control-v1", secret: text.encode("controller-owned-test-capability-material"), expiresAtMs: now() + 60_000, now });
  const journal = new PostgresOperationJournal({ async connect() { accesses += 1; throw new Error("JOURNAL_MUST_NOT_OPEN"); } }, { namespace: "edge:rejected", scopeSha256: digest("a") });
  expect(() => new NonGooglePrivateControlClient({ serviceUrl: "https://legacy.run.app", candidateSha256: digest("a"), topologySha256: digest("e"), roleCostBoundSha256: digest("4"), authorizationRequestSha256, capability, authority, journal })).toThrow("NON_GOOGLE_PRIVATE_CONTROL_ORIGIN_INVALID");
  const client = new NonGooglePrivateControlClient({ serviceUrl: "https://control.homelab.example", candidateSha256: digest("a"), topologySha256: digest("e"), roleCostBoundSha256: digest("4"), authorizationRequestSha256, capability, authority, journal, now, fetch: async () => { accesses += 1; throw new Error("NETWORK_MUST_NOT_OPEN"); } });
  const payload = { candidateId: digest("a"), require: ["openai_responses_usage", "openai_price_digest", "cap", "exact_settlement", "cancellation", "known_id_get_only", "unknown_id_held", "one_dispatch", "one_debit"] } as const;
  await expect(client.execute({ operationId: "model_rejected_operation", kind: "edge.payment.model", payload })).rejects.toThrow("NON_GOOGLE_INVOCATION_SCOPE_DENIED");
  const permitted = await signedAuthority(now, ["edge.payment"], ["edge.payment.model"]);
  const wrongCandidate = new NonGooglePrivateControlClient({ serviceUrl: "https://control.homelab.example", candidateSha256: digest("b"), topologySha256: digest("e"), roleCostBoundSha256: digest("4"), authorizationRequestSha256: permitted.authorizationRequestSha256, capability, authority: permitted.authority, journal, now, fetch: async () => { accesses += 1; throw new Error("NETWORK_MUST_NOT_OPEN"); } });
  await expect(wrongCandidate.execute({ operationId: "candidate_rejected_operation", kind: "edge.payment.model", payload })).rejects.toThrow("NON_GOOGLE_INVOCATION_BINDING_DENIED");
  const wrongCost = new NonGooglePrivateControlClient({ serviceUrl: "https://control.homelab.example", candidateSha256: digest("a"), topologySha256: digest("e"), roleCostBoundSha256: digest("5"), authorizationRequestSha256: permitted.authorizationRequestSha256, capability, authority: permitted.authority, journal, now, fetch: async () => { accesses += 1; throw new Error("NETWORK_MUST_NOT_OPEN"); } });
  await expect(wrongCost.execute({ operationId: "cost_rejected_operation", kind: "edge.payment.model", payload })).rejects.toThrow("NON_GOOGLE_INVOCATION_BINDING_DENIED");
  expect(accesses).toBe(0);
});

test("expired private channel denies retained and manually signed requests before journal, edge, provider, or network work", async () => {
  let now = 2_000_000, journalReads = 0, networkCalls = 0, edgeCalls = 0;
  const payload = CertificationEdgePayloadSchemas["edge.payment.model"].parse({ candidateId: digest("a"), require: ["openai_responses_usage", "openai_price_digest", "cap", "exact_settlement", "cancellation", "known_id_get_only", "unknown_id_held", "one_dispatch", "one_debit"] });
  const operationId = "expired_channel_operation";
  const operationSha256 = await sha256({ operationId, kind: "edge.payment.model", payload, candidateSha256: digest("a"), topologySha256: digest("e"), roleCostBoundSha256: digest("4") });
  const { authority, authorizationRequestSha256 } = await signedAuthority(() => now, ["edge.payment"], ["edge.payment.model"], { originalOperations: [{ operationId, operationSha256, candidateSha256: digest("a"), topologySha256: digest("e"), roleCostBoundSha256: digest("4") }] });
  const response = { operationId, requestSha256: digest("b"), nonce: "napplet-cvm:expired_channel_operation", clientRequestId: `napplet-cvm-${digest("b")}`, request: { idea: "one idea", systemInstruction: "bounded instruction", maximumInputTokens: 100, maximumOutputTokens: 20 }, candidateSha256: digest("a"), credentialReference: "openai:api-key:production-reference", model: "gpt-4.1-2025-04-14", rate: rate(now), maximumChargeMicros: 10_000 } satisfies OpenAiResponsesJournalEntry;
  const edge = sealedModelEdge(now, response, { async create() { edgeCalls += 1; throw new Error("POST_MUST_NOT_RUN"); }, async get() { edgeCalls += 1; throw new Error("GET_MUST_NOT_RUN"); } }, async () => { edgeCalls += 1; throw new Error("SOURCE_BUILD_MUST_NOT_RUN"); });
  const expiry = now + 1;
  const secret = text.encode("controller-owned-test-capability-material");
  const capability = createNonGooglePrivateControlCapability({ keyId: "coolify-edge-control-v1", secret, expiresAtMs: expiry, now: () => now });
  const control = new NonGoogleSuccessorControl({ authority, journal: new PostgresOperationJournal({ async connect() { journalReads += 1; throw new Error("SUCCESSOR_JOURNAL_MUST_NOT_OPEN"); } }, { namespace: "edge:expired-successor", scopeSha256: digest("c") }), edge, candidateSha256: digest("a"), topologySha256: digest("e"), roleCostBoundSha256: digest("4"), authorizationRequestSha256 });
  const handler = createNonGooglePrivateControlHandler({ capability, control, now: () => now });
  const client = new NonGooglePrivateControlClient({ serviceUrl: "https://control.homelab.example", candidateSha256: digest("a"), topologySha256: digest("e"), roleCostBoundSha256: digest("4"), authorizationRequestSha256, capability, authority, journal: new PostgresOperationJournal({ async connect() { journalReads += 1; throw new Error("CLIENT_JOURNAL_MUST_NOT_OPEN"); } }, { namespace: "edge:expired-client", scopeSha256: digest("d") }), now: () => now, fetch: async () => { networkCalls += 1; throw new Error("NETWORK_MUST_NOT_OPEN"); } });
  now = expiry;
  await expect(client.execute({ operationId, kind: "edge.payment.model", payload })).rejects.toThrow("NON_GOOGLE_PRIVATE_CONTROL_CAPABILITY_EXPIRED");

  const command = { operationId, kind: "edge.payment.model" as const, payload, candidateSha256: digest("a"), topologySha256: digest("e"), roleCostBoundSha256: digest("4"), requestSha256: operationSha256 };
  const body = canonicalJson(command), bodySha256 = await sha256Text(body), timestampMs = now, nonce = "manual-expired-channel-nonce";
  const signed = canonicalJson({ keyId: capability.keyId, method: "POST" as const, path: "/internal/non-google-edge/operations", bodySha256, requestSha256: operationSha256, timestampMs, nonce, candidateSha256: digest("a"), topologySha256: digest("e"), roleCostBoundSha256: digest("4") });
  const signature = Buffer.from(new Uint8Array(await crypto.subtle.sign("HMAC", await crypto.subtle.importKey("raw", secret, { name: "HMAC", hash: "SHA-256" }, false, ["sign"]), text.encode(signed))).buffer).toString("base64url");
  const manual = await handler.handle(new Request("https://control.homelab.example/internal/non-google-edge/operations", { method: "POST", body, headers: { "x-napplet-private-control-key-id": capability.keyId, "x-napplet-private-control-timestamp": String(timestampMs), "x-napplet-private-control-nonce": nonce, "x-napplet-private-control-body-sha256": bodySha256, "x-napplet-private-control-request-sha256": operationSha256, "x-napplet-private-control-candidate-sha256": digest("a"), "x-napplet-private-control-topology-sha256": digest("e"), "x-napplet-private-control-role-cost-bound-sha256": digest("4"), "x-napplet-private-control-signature": signature } }));
  expect(manual.status).toBe(401);
  expect({ journalReads, networkCalls, edgeCalls }).toEqual({ journalReads: 0, networkCalls: 0, edgeCalls: 0 });
});

test("public successor adapters traverse the branded native handler for every fixed operation", async () => {
  let now = 3_000_000;
  const known: OpenAiResponsesJournalEntry = { operationId: "model_original_operation", requestSha256: digest("a"), nonce: "napplet-cvm:model_original_operation", clientRequestId: `napplet-cvm-${digest("a")}`, request: { idea: "one idea", systemInstruction: "bounded instruction", maximumInputTokens: 100, maximumOutputTokens: 20 }, candidateSha256: digest("a"), credentialReference: "openai:api-key:production-reference", model: "gpt-4.1-2025-04-14", rate: rate(now), maximumChargeMicros: 10_000, responseId: "resp_native_adapter" };
  const edge = sealedModelEdge(now, known, { async create() { throw new Error("MODEL_POST_MUST_NOT_RUN"); }, async get(id) { expect(id).toBe("resp_native_adapter"); return { bytes: text.encode(JSON.stringify({ id, model: known.model, status: "completed", output: [{ type: "message", role: "assistant", content: [{ type: "output_text", text: "verified output" }] }], usage: { input_tokens: 1, output_tokens: 1 } })) }; } }, async input => ({ input }));
  const effects = Object.keys(CertificationEdgePayloadSchemas);
  const { authority, authorizationRequestSha256 } = await signedAuthority(() => now, ["edge.payment", "edge.publication", "edge.security", "edge.supply"], effects.slice().sort());
  const control = new NonGoogleSuccessorControl({ authority, journal: new PostgresOperationJournal(memoryPool(), { namespace: "edge:public-successor", scopeSha256: digest("b") }), edge, candidateSha256: digest("a"), topologySha256: digest("e"), roleCostBoundSha256: digest("4"), authorizationRequestSha256 });
  const capability = createNonGooglePrivateControlCapability({ keyId: "coolify-edge-control-v1", secret: text.encode("controller-owned-test-capability-material"), expiresAtMs: now + 60_000, now: () => now });
  const handler = createNonGooglePrivateControlHandler({ capability, control, now: () => now });
  const seen: Array<Readonly<{ method: string; kind?: string; operationId?: string }>> = [];
  const client = new NonGooglePrivateControlClient({ serviceUrl: "https://control.homelab.example", candidateSha256: digest("a"), topologySha256: digest("e"), roleCostBoundSha256: digest("4"), authorizationRequestSha256, capability, authority, journal: new PostgresOperationJournal(memoryPool(), { namespace: "edge:public-client", scopeSha256: digest("c") }), now: () => now, fetch: async (url, init) => {
    const command = init.body === undefined ? undefined : JSON.parse(String(init.body)) as Readonly<{ kind: string; operationId: string }>;
    seen.push({ method: init.method ?? "GET", ...(command === undefined ? { operationId: new URL(url).pathname.split("/").at(-1) } : command) });
    return handler.handle(new Request(url, init));
  } });
  const adapters = createProductionEdgeSuiteAdapters({ candidateId: digest("a"), control: client });
  const source = { sealedArtifactSha256: digest("b"), aggregateSha256: digest("c") };
  await adapters["security-host"].runSealedBuild({ candidateId: digest("a"), image: `registry.example/worker@sha256:${digest("d")}` });
  await adapters["security-host"].runHostileMatrix({ ...source, manifestSha256: digest("d"), capabilitiesSha256: digest("e") });
  await adapters["security-host"].runBrowser(source);
  await adapters["security-host"].inspectSignerBoundary(source);
  await adapters["supply-chain"].runBuild("primary");
  await adapters["supply-chain"].runBuild("secondary");
  await adapters["supply-chain"].supplyChainInput();
  await adapters["ContextVM-payment-model"].exerciseSignedTransport({ candidateId: digest("a") });
  await adapters["ContextVM-payment-model"].exerciseCep8Settlement({ candidateId: digest("a") });
  await adapters["ContextVM-payment-model"].reconcileOriginalModelOperation({ candidateId: digest("a") });
  await adapters.publication.verifyPromotedSource({ candidateId: digest("a") });
  if (adapters.publication.artifactContract === "nip5d-direct-v1") throw new Error("DEFAULT_PUBLICATION_ADAPTER_REQUIRED");
  await adapters.publication.submitOriginalPublication(source);
  await adapters.publication.reconcileOriginalPublication({ intentId: "intent-1", operationIds: { deploy: "deploy:intent-1", ownerManifest: "owner_manifest:intent-1", attestation: "attestation:intent-1" } });

  const reference = { principal: { pubkey: digest("a") }, idempotencyKey: "direct:certification" };
  const direct = createProductionEdgeSuiteAdapters({ candidateId: digest("a"), control: client, artifactContract: "nip5d-direct-v1", directPublicationReference: reference }).publication;
  if (direct.artifactContract !== "nip5d-direct-v1") throw new Error("DIRECT_PUBLICATION_ADAPTER_REQUIRED");
  const original = { ...reference, intentId: `direct-publication:${digest("b")}`, reviewSha256: digest("c") };
  const directSource = DirectPublicationSourceObservationSchema.parse({ version: "direct-publication-observation-v1", status: "verified-source-bytes", artifactContract: "nip5d-direct-v1", candidateSha256: digest("a"), topologySha256: digest("b"), artifactHash: digest("c"), archiveSha256: digest("d"), toolchainSha256: digest("e"), toolchain: { version: 1, artifactContract: "nip5d-direct-v1", platform: "linux-arm64", cliBinarySha256: "2a78a97ae95f493a0c568366ede5a53ce99808fa2fe487572952b7f4f9770a26", workerPackageSha256: "ca0d5a088c7650407306899eaaaa535b2bd872d746d7aee10be471894944abbf", workerLockSha256: "f0ac025b6f79609a159702adedfbfebd8966b1c65f78cf1e0f75912ae54a567d", templatePackageSha256: "81f03e8b76b15cbc025b11a67117389b579ee1ca374ddb680971f91e7293a99f", templateLockSha256: "ec1eb261c06641decda0c8fbd3a96e5f121cddfcc6abdc8888f78556390e28e4" }, server: "https://publication.example", helper: DIRECT_CLI_NETWORK_IDENTITY, productionPromotion: "not_asserted", original, operationIds: { upload: `direct-upload:${digest("a")}`, owner: `direct-owner-relay:${digest("b")}`, attestation: `direct-attestation-relay:${digest("c")}` } });
  const submitted = DirectPublicationSubmissionSchema.parse({ version: directSource.version, status: "submitted", artifactContract: directSource.artifactContract, candidateSha256: directSource.candidateSha256, topologySha256: directSource.topologySha256, artifactHash: directSource.artifactHash, archiveSha256: directSource.archiveSha256, original, operationIds: directSource.operationIds, ownerEventId: digest("f"), attestationEventId: digest("0"), userSigningExternal: true });
  await direct.verifyPromotedSource({ candidateId: digest("a") });
  await direct.submitOriginalPublication(directSource);
  await direct.reconcileOriginalPublication(submitted);
  await adapters["security-host"].runSealedBuild({ candidateId: digest("a"), image: `registry.example/worker@sha256:${digest("d")}` });
  await expect(client.observe({ operationId: "unknown_original", kind: "edge.security.build", requestSha256: digest("f") })).rejects.toThrow("NON_GOOGLE_PRIVATE_CONTROL_RESPONSE_REJECTED");
  const posts = seen.filter(value => value.method === "POST");
  expect(posts.map(value => value.kind).sort()).toEqual(effects.sort());
  expect(seen.filter(value => value.method === "GET").map(value => value.operationId)).toEqual(["security_host_build", "unknown_original"]);
});

test("the normal mounted entry rejects shaped successor material before secret, provider, database, or client access", async () => {
  const workspaceRoot = join(process.cwd(), ".runtime", "release-certification", "native-discovery-v1"); await mkdir(workspaceRoot, { recursive: true }); const workspace = await mkdtemp(join(workspaceRoot, "edge-runtime-"));
  const fixture = await mountedBillingRecoveryFixture(workspace, Date.now()); const request = await createNonGoogleAuthorizationRequestV3({ identity: { candidateSha256: fixture.candidateSha256, sourceSha256: digest("b"), configSha256: digest("c"), toolchainSha256: digest("d"), topologySha256: fixture.topologySha256, failureDomainSha256: digest("f"), retentionSha256: digest("0"), cleanupSha256: digest("1"), controllerStateSha256: digest("2") }, binding: { providerGraphRevision: "non-google-v1", roleInventorySha256: digest("3"), roleCostBoundSha256: digest("4"), scopesSha256: digest("5"), effectsSha256: digest("6") } });
  const material = { version: "non-google-edge-v1" as const, candidateSha256: fixture.candidateSha256, topologySha256: fixture.topologySha256, successorAuthorization: { request, receipt: { kind: "release-authorization-receipt-v4" as const, version: 4 as const, requestSha256: request.requestSha256, candidateSha256: fixture.candidateSha256, topologySha256: fixture.topologySha256, providerGraphRevision: "non-google-v1" as const, roleInventorySha256: digest("3"), roleCostBoundSha256: digest("4"), receiptSha256: digest("7") } }, openAiResponses: { credentialReference: "openai:api-key:production-reference", model: "gpt-4.1-2025-04-14", maximumChargeMicros: 1_000_000, rate: rate(Date.now()) } };
  let effects = 0; const generation = { config: fixture.config, get dependencies() { effects += 1; throw new Error("DEPENDENCIES_MUST_NOT_OPEN"); }, get authorization() { effects += 1; throw new Error("AUTHORIZATION_MUST_NOT_OPEN"); } };
  await expect(createMountedProductionSessionMaterial({ config: fixture.config, generation: generation as never, resolved: { workerCandidate: { id: fixture.candidateSha256 }, nonGoogleEdge: material } as never, secrets: new Proxy({}, { get() { effects += 1; throw new Error("SECRETS_MUST_NOT_OPEN"); } }) as never })).rejects.toThrow("SUCCESSOR_GRAPH_ARCHITECTURE_GUARD_ACTIVE");
  expect(effects).toBe(0); await rm(workspace, { recursive: true, force: true });
});
