import { DirectPublicationSourceObservationSchema, DirectPublicationSubmissionSchema, directPublicationOperationIds } from "../../src/certification/live/direct-publication-contract";
import { DIRECT_CLI_NETWORK_IDENTITY } from "../../src/production/pinned-direct-cli-network";
import { expect, spyOn, test } from "bun:test";

import { createProductionEdgeSuiteAdapters } from "../../src/release/deployment/production-edge-suite-adapters";
import { PostgresOperationJournal } from "../../src/release/deployment/postgres-operation-journal";
import { openContextVmCertificationClient } from "../../src/release/deployment/contextvm-client";
import { ProductionCoreControlClient } from "../../src/release/deployment/production-core-control";
import { CertificationEdgePayloadSchemas, ProductionCertificationEdgeService } from "../../src/production/certification-edge";
import { createProductionEdgeClients } from "../../src/production/edge-clients";
import { openProductionNip46Signer } from "../../src/production/nip46-signer";
import { createMountedNonGoogleEdgeClient } from "../../src/production/non-google-edge-material";
import { createNonGoogleAuthorizationRequestV3 } from "../../src/release/contracts";

const digest = (letter: string) => letter.repeat(64);

test("production edge suites reject descriptor-only controls before invoking an external operation", () => {
  let calls = 0;
  expect(() => createProductionEdgeSuiteAdapters({
    candidateId: digest("a"),
    control: { execute: async () => { calls += 1; return {}; } },
  })).toThrow("PRODUCTION_EDGE_CONTROL_CLIENT_REQUIRED");
  expect(calls).toBe(0);
});

function control(candidateId = digest("a")) {
  // The journal constructor is branded without I/O. This test never invokes a
  // suite and therefore cannot manufacture release evidence from this seam.
  const journal = new PostgresOperationJournal({ async connect() { throw new Error("test must not contact PostgreSQL"); } }, { namespace: "edge-suite-test", scopeSha256: digest("b") });
  return new ProductionCoreControlClient({ serviceUrl: "https://edge-control.run.app", candidateSha256: candidateId, topologySha256: digest("d"), request: {}, receipt: {}, journal, identity: { async token() { throw new Error("test must not authenticate"); } } });
}

test("production edge suites require one concrete private control for all four release boundaries", () => {
  const adapters = createProductionEdgeSuiteAdapters({ candidateId: digest("a"), control: control() });
  expect(Object.keys(adapters)).toEqual(["security-host", "supply-chain", "ContextVM-payment-model", "publication"]);
  expect(Object.values(adapters).every(port => port.evidenceClass === "real" && port.origin === "project-owned")).toBe(true);
  expect(() => createProductionEdgeSuiteAdapters({ candidateId: digest("b"), control: control() })).toThrow("PRODUCTION_EDGE_CANDIDATE_MISMATCH");
});

test("payment/model port binds a candidate before any signed ContextVM or rail operation", () => {
  const adapters = createProductionEdgeSuiteAdapters({ candidateId: digest("a"), control: control() });
  expect(() => adapters["ContextVM-payment-model"].exerciseSignedTransport({ candidateId: digest("b") })).toThrow("PRODUCTION_EDGE_CANDIDATE_MISMATCH");
  expect(typeof openContextVmCertificationClient).toBe("function");
});

test("edge backend accepts only sealed brokers and fixed production payloads", () => {
  expect(() => new ProductionCertificationEdgeService({ broker: {} })).toThrow("PRODUCTION_SESSION_BROKER_REQUIRED");
  const payload = CertificationEdgePayloadSchemas["edge.security.browser"].parse({
    candidateId: digest("a"), sealedArtifactSha256: digest("b"), aggregateSha256: digest("c"),
    requiredViewports: [1280, 768, 375], browser: "chromium",
  });
  expect(payload.browser).toBe("chromium");
  expect(() => CertificationEdgePayloadSchemas["edge.security.browser"].parse({ ...payload, requiredViewports: [1, 2, 3] })).toThrow();
});

test("every real edge adapter payload matches its server contract and rejects changed requirements", async () => {
  const client = control();
  const seen = new Set<string>();
  const execute = spyOn(client, "execute").mockImplementation(async command => {
    const schema = CertificationEdgePayloadSchemas[command.kind as keyof typeof CertificationEdgePayloadSchemas];
    const payload = schema.parse(command.payload);
    seen.add(command.kind);
    const requirements = "require" in payload ? "require" : "required" in payload ? "required" : undefined;
    if (requirements) {
      const values = (payload as Record<string, unknown>)[requirements] as string[];
      expect(schema.safeParse({ ...payload, [requirements]: values.map(() => values[0]) }).success).toBe(false);
      expect(schema.safeParse({ ...payload, [requirements]: values.slice(1) }).success).toBe(false);
    }
    return { operationId: command.operationId, kind: command.kind, requestSha256: digest("f"), state: "completed" as const, result: {} };
  });
  try {
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
    if (adapters.publication.artifactContract === "nip5d-direct-v1") throw new Error("LEGACY_DEFAULT_REQUIRED");
    await adapters.publication.submitOriginalPublication(source);
    await adapters.publication.reconcileOriginalPublication({ intentId: "intent-1", operationIds: { deploy: "deploy:intent-1", ownerManifest: "owner_manifest:intent-1", attestation: "attestation:intent-1" } });
    const reference = { principal: { pubkey: digest("a") }, idempotencyKey: "direct:certification" };
    const direct = createProductionEdgeSuiteAdapters({ candidateId: digest("a"), control: client, artifactContract: "nip5d-direct-v1", directPublicationReference: reference }).publication;
    if (direct.artifactContract !== "nip5d-direct-v1") throw new Error("DIRECT_VARIANT_REQUIRED");
    const original = { ...reference, intentId: `direct-publication:${digest("b")}`, reviewSha256: digest("c") };
    const directSource = DirectPublicationSourceObservationSchema.parse({ version: "direct-publication-observation-v1", status: "verified-source-bytes", artifactContract: "nip5d-direct-v1",
      candidateSha256: digest("a"), topologySha256: digest("b"), artifactHash: digest("c"), archiveSha256: digest("d"), toolchainSha256: digest("e"),
      toolchain: { version: 1, artifactContract: "nip5d-direct-v1", platform: "linux-arm64", cliBinarySha256: "2a78a97ae95f493a0c568366ede5a53ce99808fa2fe487572952b7f4f9770a26",
        workerPackageSha256: "ca0d5a088c7650407306899eaaaa535b2bd872d746d7aee10be471894944abbf", workerLockSha256: "f0ac025b6f79609a159702adedfbfebd8966b1c65f78cf1e0f75912ae54a567d",
        templatePackageSha256: "81f03e8b76b15cbc025b11a67117389b579ee1ca374ddb680971f91e7293a99f", templateLockSha256: "ec1eb261c06641decda0c8fbd3a96e5f121cddfcc6abdc8888f78556390e28e4" },
      server: "https://publication.example", helper: DIRECT_CLI_NETWORK_IDENTITY, productionPromotion: "not_asserted", original, operationIds: await directPublicationOperationIds(original.intentId) });
    const submitted = DirectPublicationSubmissionSchema.parse({ version: directSource.version, status: "submitted", artifactContract: directSource.artifactContract,
      candidateSha256: directSource.candidateSha256, topologySha256: directSource.topologySha256, artifactHash: directSource.artifactHash, archiveSha256: directSource.archiveSha256,
      original, operationIds: directSource.operationIds, ownerEventId: digest("f"), attestationEventId: digest("0"), userSigningExternal: true });
    await direct.verifyPromotedSource({ candidateId: digest("a") });
    await direct.submitOriginalPublication(directSource);
    await direct.reconcileOriginalPublication(submitted);
    expect([...seen].sort()).toEqual(Object.keys(CertificationEdgePayloadSchemas).sort());
  } finally { execute.mockRestore(); }
});

test("tracer: edge model operations require native OpenAI usage and never retain a Vertex receipt requirement", () => {
  const nativeModelPayload = {
    candidateId: digest("a"),
    require: ["openai_responses_usage", "openai_price_digest", "cap", "exact_settlement", "cancellation", "known_id_get_only", "unknown_id_held", "one_dispatch", "one_debit"] as ["openai_responses_usage", "openai_price_digest", "cap", "exact_settlement", "cancellation", "known_id_get_only", "unknown_id_held", "one_dispatch", "one_debit"],
  };
  expect(CertificationEdgePayloadSchemas["edge.payment.model"].parse(nativeModelPayload)).toEqual(nativeModelPayload);
  expect(CertificationEdgePayloadSchemas["edge.payment.model"].safeParse({ candidateId: digest("a"), require: ["vertex_receipt", "cap", "exact_settlement", "cancellation", "original_query_only", "one_dispatch", "one_debit"] }).success).toBe(false);
});

test("tracer: successor edge material rejects legacy authority and holds before credential or database effects", async () => {
  const request = await createNonGoogleAuthorizationRequestV3({
    identity: { candidateSha256: digest("a"), sourceSha256: digest("b"), configSha256: digest("c"), toolchainSha256: digest("d"), topologySha256: digest("e"), failureDomainSha256: digest("f"), retentionSha256: digest("0"), cleanupSha256: digest("1"), controllerStateSha256: digest("2") },
    binding: { providerGraphRevision: "non-google-v1", roleInventorySha256: digest("3"), roleCostBoundSha256: digest("4"), scopesSha256: digest("5"), effectsSha256: digest("6") },
  });
  const receipt = { kind: "release-authorization-receipt-v4", version: 4, requestSha256: request.requestSha256, candidateSha256: digest("a"), topologySha256: digest("e"), providerGraphRevision: "non-google-v1", roleInventorySha256: digest("3"), roleCostBoundSha256: digest("4"), receiptSha256: digest("7") } as const;
  let effects = 0;
  const material = { version: "non-google-edge-v1", candidateSha256: digest("a"), topologySha256: digest("e"), successorAuthorization: { request, receipt }, openAiResponses: {
    credentialReference: "openai:api-key:production-reference", model: "gpt-4.1-2025-04-14", maximumChargeMicros: 1_000_000,
    rate: { version: 2, sourceUrl: "https://developers.openai.com/api/docs/models/gpt-4.1", sourceDocumentSha256: digest("8"), sourceArtifactSha256: digest("8"), quoteSha256: digest("9"), observedAtMs: 1, freshUntilMs: 2, model: "gpt-4.1-2025-04-14", currency: "USD", inputMicrosPerMillion: 1, cachedInputMicrosPerMillion: 1, outputMicrosPerMillion: 1 },
  }} as const;
  const pool = { async connect() { effects += 1; throw new Error("DATABASE_MUST_NOT_CONNECT"); } } as never;
  await expect(createMountedNonGoogleEdgeClient({ material, pool })).rejects.toThrow("SUCCESSOR_GRAPH_ARCHITECTURE_GUARD_ACTIVE");
  await expect(createMountedNonGoogleEdgeClient({ material, authority: { candidateSha256: material.candidateSha256 }, pool })).rejects.toThrow("NON_GOOGLE_EDGE_CONTROLLER_AUTHORITY_REQUIRED");
  expect(effects).toBe(0);
});

test("tracer: construction has no credential, provider, client, network, payment, signing, publication, resource, or report effect", () => {
  let effects = 0;
  const explosive = new Proxy({}, {
    get() { effects += 1; throw new Error("EDGE_CONSTRUCTION_EFFECT"); },
  });
  expect(() => createProductionEdgeClients({
    host: { packageHost: explosive as never, chromium: { kind: "chromium" } as never },
    ownerSigner: { signer: explosive as never, verifier: explosive as never },
    lightning: { config: explosive, receiver: explosive as never, coordinator: explosive as never },
    cashu: { config: explosive, settlement: explosive as never, walletOperations: explosive as never, coordinator: explosive as never },
    publication: { upload: { config: explosive, port: explosive as never }, relay: { config: explosive, port: explosive as never }, promotedSnapshot: explosive },
    publicationContext: { resolve: async () => { throw new Error("EDGE_EXECUTION_EFFECT"); } } as never,
    paymentScenarioContext: { resolve: async () => { throw new Error("EDGE_EXECUTION_EFFECT"); } } as never,
    sourceBuild: { authority: "production-real", verify: async () => { throw new Error("EDGE_EXECUTION_EFFECT"); } } as never,
    authorizationRequest: {}, authorizationReceipt: {},
  } as never)).not.toThrow();
  expect(effects).toBe(0);
});

test("native edge factory rejects a non-Chromium mounted browser before any provider construction", () => {
  expect(() => createProductionEdgeClients({ host: { packageHost: {} as never, chromium: { kind: "webkit" } as never } } as never)).toThrow("PRODUCTION_EDGE_CHROMIUM_REQUIRED");
});

test("NIP-46 signer rejects non-bunker references before resolving any session key", async () => {
  await expect(openProductionNip46Signer({ authorization: {} as never, bunkerUri: "https://invalid", sessionKeyReference: "nostr:session", sessionKeyBroker: {} as never, context: {} as never, journal: {} as never })).rejects.toThrow("NIP46_REFERENCE_INVALID");
});
