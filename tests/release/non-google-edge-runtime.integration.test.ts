import { expect, test } from "bun:test";
import { mkdir, mkdtemp, rm } from "node:fs/promises";
import { join } from "node:path";

import {
  NonGooglePrivateControlClient,
  createNonGooglePrivateControlCapability,
  consumeNonGooglePrivateControlAuthorization,
} from "../../src/release/deployment/non-google-private-control";
import { createNonGoogleAuthorizationRequestV3 } from "../../src/release/contracts";
import { createProductionEdgeSuiteAdapters } from "../../src/release/deployment/production-edge-suite-adapters";
import { createOpenAiResponsesClient, type OpenAiResponsesJournalEntry, type OpenAiResponsesOperationJournal } from "../../src/release/deployment/openai-responses-client";
import { createMountedProductionSessionMaterial } from "../../src/production/mounted-session-material";
import { mountedBillingRecoveryFixture } from "./helpers/mounted-billing-recovery-fixture";

const digest = (letter: string) => letter.repeat(64);

const rate = (now: number) => ({ version: 2 as const, sourceUrl: "https://developers.openai.com/api/docs/models/gpt-4.1" as const, sourceDocumentSha256: digest("9"), sourceArtifactSha256: digest("9"), quoteSha256: digest("8"), observedAtMs: now - 1_000, freshUntilMs: now + 60_000, model: "gpt-4.1-2025-04-14", currency: "USD" as const, inputMicrosPerMillion: 1, cachedInputMicrosPerMillion: 1, outputMicrosPerMillion: 1 });

async function shapedSuccessorMaterial() {
  const request = await createNonGoogleAuthorizationRequestV3({
    identity: { candidateSha256: digest("a"), sourceSha256: digest("b"), configSha256: digest("c"), toolchainSha256: digest("d"), topologySha256: digest("e"), failureDomainSha256: digest("f"), retentionSha256: digest("0"), cleanupSha256: digest("1"), controllerStateSha256: digest("2") },
    binding: { providerGraphRevision: "non-google-v1", roleInventorySha256: digest("3"), roleCostBoundSha256: digest("4"), scopesSha256: digest("5"), effectsSha256: digest("6") },
  });
  return { version: "non-google-edge-v1" as const, candidateSha256: digest("a"), topologySha256: digest("e"), successorAuthorization: { request, receipt: { kind: "release-authorization-receipt-v4" as const, version: 4 as const, requestSha256: request.requestSha256, candidateSha256: digest("a"), topologySha256: digest("e"), providerGraphRevision: "non-google-v1" as const, roleInventorySha256: digest("3"), roleCostBoundSha256: digest("4"), receiptSha256: digest("7") } }, openAiResponses: { credentialReference: "openai:api-key:production-reference", model: "gpt-4.1-2025-04-14", maximumChargeMicros: 1_000_000, rate: rate(Date.now()) } };
}

test("native private control rejects Cloud Run origins and authenticates only its fixed edge routes", async () => {
  const request = await createNonGoogleAuthorizationRequestV3({
    identity: { candidateSha256: digest("a"), sourceSha256: digest("e"), configSha256: digest("f"), toolchainSha256: digest("0"), topologySha256: digest("c"), failureDomainSha256: digest("1"), retentionSha256: digest("2"), cleanupSha256: digest("3"), controllerStateSha256: digest("4") },
    binding: { providerGraphRevision: "non-google-v1", roleInventorySha256: digest("5"), roleCostBoundSha256: digest("d"), scopesSha256: digest("6"), effectsSha256: digest("7") },
  });
  const authorization = await consumeNonGooglePrivateControlAuthorization({
    request,
    receipt: { kind: "release-authorization-receipt-v4", version: 4, requestSha256: request.requestSha256, candidateSha256: digest("a"), topologySha256: digest("c"), providerGraphRevision: "non-google-v1", roleInventorySha256: digest("5"), roleCostBoundSha256: digest("d"), receiptSha256: digest("8") },
    expiresAtMs: Date.now() + 60_000,
  });
  const capability = createNonGooglePrivateControlCapability({
    keyId: "coolify-edge-control-v1",
    secret: new TextEncoder().encode("controller-owned-test-capability-material"),
    expiresAtMs: Date.now() + 60_000,
  });
  let requestCount = 0;
  const fetch = async (url: string | URL | Request, init?: RequestInit) => {
    requestCount += 1;
    expect(String(url)).toBe(`https://control.homelab.example/internal/non-google-edge/operations`);
    expect(init?.method).toBe("POST");
    expect(init?.redirect).toBe("error");
    expect(init?.headers).toMatchObject({ "x-napplet-private-control-key-id": "coolify-edge-control-v1" });
    const command = JSON.parse(String(init?.body));
    return new Response(JSON.stringify({
      operationId: command.operationId,
      kind: command.kind,
      requestSha256: command.requestSha256,
      state: "completed",
      result: { state: "verified" },
    }), { status: 200, headers: { "content-type": "application/json" } });
  };
  expect(() => new NonGooglePrivateControlClient({
    serviceUrl: "https://legacy.run.app",
    candidateSha256: digest("a"), topologySha256: digest("c"),
    roleCostBoundSha256: digest("d"), capability, authorization, fetch,
  })).toThrow("NON_GOOGLE_PRIVATE_CONTROL_ORIGIN_INVALID");

  const client = new NonGooglePrivateControlClient({
    serviceUrl: "https://control.homelab.example",
    candidateSha256: digest("a"), topologySha256: digest("c"),
    roleCostBoundSha256: digest("d"), capability, authorization, fetch,
  });
  await client.execute({ operationId: "edge_security_hostile", kind: "edge.security.hostile", payload: {
    candidateId: digest("a"), sealedArtifactSha256: digest("e"), manifestSha256: digest("f"), capabilitiesSha256: digest("0"), aggregateSha256: digest("1"),
  } });
  const adapters = createProductionEdgeSuiteAdapters({ candidateId: digest("a"), control: client });
  await adapters["security-host"].runHostileMatrix({ sealedArtifactSha256: digest("e"), manifestSha256: digest("f"), capabilitiesSha256: digest("0"), aggregateSha256: digest("1") });
  await adapters["supply-chain"].runBuild("primary");
  await adapters["ContextVM-payment-model"].reconcileOriginalModelOperation({ candidateId: digest("a") });
  await adapters.publication.verifyPromotedSource({ candidateId: digest("a") });
  expect(requestCount).toBe(5);
});

test("known Responses IDs reconcile with GET only after a transient response and unknown IDs stay held", async () => {
  const now = 1_000_000;
  const known: OpenAiResponsesJournalEntry = {
    operationId: "model_original_operation", requestSha256: digest("a"), nonce: "napplet-cvm:model_original_operation", clientRequestId: `napplet-cvm-${digest("a")}`,
    request: { idea: "one idea", systemInstruction: "bounded instruction", maximumInputTokens: 100, maximumOutputTokens: 20 }, candidateSha256: digest("b"), credentialReference: "openai:api-key:production-reference", model: "gpt-4.1-2025-04-14", rate: rate(now), maximumChargeMicros: 10_000, responseId: "resp_known_response",
  };
  const missing: OpenAiResponsesJournalEntry = { ...known, operationId: "model_missing_operation", responseId: undefined };
  const rows = new Map<string, OpenAiResponsesJournalEntry>([[known.operationId, known], [missing.operationId, missing]]);
  let posts = 0; let gets = 0;
  const journal: OpenAiResponsesOperationJournal = {
    async claim(entry) { return { claimed: false, entry: rows.get(entry.operationId) ?? entry }; },
    async read(operationId: string) { return rows.get(operationId); },
    async write(entry) { rows.set(entry.operationId, entry); },
  };
  const client = createOpenAiResponsesClient({ candidateSha256: digest("b"), credentialReference: known.credentialReference, model: known.model, rate: known.rate, maximumChargeMicros: known.maximumChargeMicros, journal, now: () => now,
    port: {
      async create() { posts += 1; throw new Error("POST_MUST_NOT_RUN"); },
      async get() {
        gets += 1;
        if (gets === 1) throw new Error("TRANSIENT_GET");
        return { bytes: new TextEncoder().encode(JSON.stringify({ id: "resp_known_response", model: known.model, status: "completed", output: [{ type: "message", role: "assistant", content: [{ type: "output_text", text: "verified output" }] }], usage: { input_tokens: 1, output_tokens: 1 } })) };
      },
    },
  });
  expect(await client.reconcileOriginal({ operationId: known.operationId })).toMatchObject({ status: "unknown", reason: "response_pending" });
  expect(await client.reconcileOriginal({ operationId: known.operationId })).toMatchObject({ status: "completed", operationId: known.operationId });
  expect(await client.reconcileOriginal({ operationId: missing.operationId })).toMatchObject({ status: "unknown", reason: "response_id_unknown" });
  expect({ posts, gets }).toEqual({ posts: 0, gets: 2 });
});

test("the normal mounted entry rejects shaped successor material before secret, provider, database, or client access", async () => {
  const workspaceRoot = join(process.cwd(), ".runtime", "release-certification", "native-discovery-v1");
  await mkdir(workspaceRoot, { recursive: true });
  const workspace = await mkdtemp(join(workspaceRoot, "edge-runtime-"));
  const fixture = await mountedBillingRecoveryFixture(workspace, Date.now());
  const request = await createNonGoogleAuthorizationRequestV3({
    identity: { candidateSha256: fixture.candidateSha256, sourceSha256: digest("b"), configSha256: digest("c"), toolchainSha256: digest("d"), topologySha256: fixture.topologySha256, failureDomainSha256: digest("f"), retentionSha256: digest("0"), cleanupSha256: digest("1"), controllerStateSha256: digest("2") },
    binding: { providerGraphRevision: "non-google-v1", roleInventorySha256: digest("3"), roleCostBoundSha256: digest("4"), scopesSha256: digest("5"), effectsSha256: digest("6") },
  });
  const material = { version: "non-google-edge-v1" as const, candidateSha256: fixture.candidateSha256, topologySha256: fixture.topologySha256, successorAuthorization: { request, receipt: { kind: "release-authorization-receipt-v4" as const, version: 4 as const, requestSha256: request.requestSha256, candidateSha256: fixture.candidateSha256, topologySha256: fixture.topologySha256, providerGraphRevision: "non-google-v1" as const, roleInventorySha256: digest("3"), roleCostBoundSha256: digest("4"), receiptSha256: digest("7") } }, openAiResponses: { credentialReference: "openai:api-key:production-reference", model: "gpt-4.1-2025-04-14", maximumChargeMicros: 1_000_000, rate: rate(Date.now()) } };
  let effects = 0;
  const generation = {
    config: fixture.config,
    get dependencies() { effects += 1; throw new Error("DEPENDENCIES_MUST_NOT_OPEN"); },
    get authorization() { effects += 1; throw new Error("AUTHORIZATION_MUST_NOT_OPEN"); },
  };
  await expect(createMountedProductionSessionMaterial({
    config: fixture.config,
    generation: generation as never,
    resolved: { workerCandidate: { id: fixture.candidateSha256 }, nonGoogleEdge: material } as never,
    secrets: new Proxy({}, { get() { effects += 1; throw new Error("SECRETS_MUST_NOT_OPEN"); } }) as never,
  })).rejects.toThrow("SUCCESSOR_GRAPH_ARCHITECTURE_GUARD_ACTIVE");
  expect(effects).toBe(0);
  await rm(workspace, { recursive: true, force: true });
});
