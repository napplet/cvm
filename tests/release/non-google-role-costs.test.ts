import { expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { existsSync } from "node:fs";

import {
  assertSuccessorGraphPreapprovalHeld,
  createHeldSuccessorWorkerCostFact,
  createOpenAiResponsesRateSnapshot,
  createSuccessorRoleCostBound,
  type SuccessorRoleCostFact,
} from "../../src/release/costs/non-google-cost-bound";
import { OPENAI_RESPONSES_PRICING_URL } from "../../src/release/costs/official-sources";
import { createNonGoogleModelCostCatalog } from "../../src/release/costs/production-catalog";
import { assertNonGooglePreapprovalHeld, createNonGooglePreapprovalMaterializer, prepareNonGoogleSuccessorPreapprovalHold, type MaterializePreapprovalInput } from "../../src/release/preapproval-materializer";
import { prepareNonGoogleSuccessorInventory } from "../../src/release/providers";
import { NonGoogleAuthorizationReceiptV4Schema, createNonGoogleAuthorizationRequestV3, verifyNonGoogleAuthorizationReceiptV4 } from "../../src/release/contracts";

const hex = (character: string) => character.repeat(64);
const candidateSha256 = hex("a");
const topologySha256 = hex("b");
const nowMs = 1_000_000;

const openAiCards = `<div class="flex flex-col gap-2 md:flex-row"><div class="flex flex-1 flex-col gap-1 rounded-lg border border-solid border-default bg-surface-secondary px-3 py-4"><div>Input</div><div class="text-2xl font-semibold">$2.00</div></div><div class="flex flex-1 flex-col gap-1 rounded-lg border border-solid border-default bg-surface-secondary px-3 py-4"><div>Cached input</div><div class="text-2xl font-semibold">$0.50</div></div><div class="flex flex-1 flex-col gap-1 rounded-lg border border-solid border-default bg-surface-secondary px-3 py-4"><div>Output</div><div class="text-2xl font-semibold">$8.00</div></div></div>`;
const openAiModelView = (body: string) => `<astro-island component-export="ModelView" component-url="/_astro/ModelView.react.abc.js" props="{&quot;modelName&quot;:[0,&quot;gpt-4.1&quot;]}">${body}</astro-island>`;
const openAiPrimaryCards = `<div class="relative"><div class="relative mx-4 flex flex-col gap-4 overflow-hidden px-4 pt-8 pb-10 sm:mx-8 md:mx-auto md:w-full md:max-w-6xl md:px-12 xl:px-4"><div></div><div class="flex flex-col gap-8"><div></div><div></div><div></div><div></div><div class="flex flex-col gap-4 lg:flex-row"><div></div><div class="flex flex-1 flex-col gap-4"><div></div><div class="flex flex-col gap-4"><div></div>${openAiCards}</div></div></div></div></div></div>`;
const openAiSource = new TextEncoder().encode(`<!doctype html><html><body>${openAiModelView(`${openAiPrimaryCards}<code class="text-xs">gpt-4.1-2025-04-14</code>`)}</body></html>`);
const openAiDocument = Object.freeze({ sourceUrl: OPENAI_RESPONSES_PRICING_URL, bytes: openAiSource, observedAtMs: nowMs - 1, freshUntilMs: nowMs + 60_000 });
const openAiRate = () => createOpenAiResponsesRateSnapshot({ document: openAiDocument, model: "gpt-4.1-2025-04-14" });
const modelCatalog = (rate: Awaited<ReturnType<typeof openAiRate>>) => createNonGoogleModelCostCatalog({ rates: { async readOpenAiResponsesRate() { return rate; } }, now: () => nowMs });
const modelUsageIntent = Object.freeze({ maximumInputTokens: 1_000, maximumOutputTokens: 200, maximumChargeMicros: 10_000_000 });

const inventory = () => prepareNonGoogleSuccessorInventory({
  candidateSha256,
  topologySha256,
  roles: [
    {
      roleId: "model.openai-responses",
      effectId: "model.generate",
      costComponentId: "model.api-usage",
      suite: "contextvm-payment-model",
      constructor: { modulePath: "src/release/deployment/openai-responses-client.ts", exportName: "createOpenAiResponsesClient", purpose: "openai-responses", namespace: "openai:responses" },
      construction: "native",
    },
    {
      roleId: "worker.modal",
      effectId: "worker.start",
      costComponentId: "worker.modal-seconds",
      suite: "admission",
      constructor: { modulePath: "src/release/native/modal.ts", exportName: "createModalLiveWorkerProvider", purpose: "worker-sandbox", namespace: "modal:sandbox" },
      construction: "unconstructed",
    },
    {
      roleId: "object.postgres-bytea",
      effectId: "object.seal",
      costComponentId: "object.postgres-storage",
      suite: "restore",
      constructor: { modulePath: "src/continuity/postgres-bytea-object-store.ts", exportName: "PostgresByteaObjectStoreAdapter", purpose: "immutable-objects", namespace: "postgres:objects" },
      construction: "unconstructed",
    },
    { roleId: "telemetry.otlp", effectId: "telemetry.record", costComponentId: "telemetry.otlp", suite: "telemetry", constructor: { modulePath: "src/telemetry/redaction.ts", exportName: "redactLifecycleObservation", purpose: "telemetry", namespace: "otlp:collector" }, construction: "unconstructed" },
    { roleId: "chaos.fault-harness", effectId: "chaos.exercise", costComponentId: "chaos.harness", suite: "chaos", constructor: { modulePath: "src/resilience/fault-harness.ts", exportName: "runFaultScenario", purpose: "chaos", namespace: "fault:harness" }, construction: "unconstructed" },
    { roleId: "security.host", effectId: "security.inspect", costComponentId: "security.host", suite: "security-host", constructor: { modulePath: "src/certification/live/security-host.ts", exportName: "runLiveSecurityHostCertification", purpose: "security-host", namespace: "security:host" }, construction: "unconstructed" },
    { roleId: "supply.chain", effectId: "supply.verify", costComponentId: "supply.chain", suite: "supply-chain", constructor: { modulePath: "src/certification/supply-chain.ts", exportName: "verifySupplyChainCertification", purpose: "supply-chain", namespace: "supply:chain" }, construction: "unconstructed" },
    { roleId: "publication.napplet", effectId: "publication.verify", costComponentId: "publication.transport", suite: "publication", constructor: { modulePath: "src/publication/contracts.ts", exportName: "PublicationEffectIntentSchema", purpose: "publication", namespace: "napplet:publication" }, construction: "unconstructed" },
    { roleId: "worker.fly", effectId: "worker.reclaim", costComponentId: "worker.fly-seconds", suite: "admission", constructor: { modulePath: "src/release/native/fly.ts", exportName: "createFlyLiveWorkerProvider", purpose: "worker-sandbox", namespace: "fly:machines" }, construction: "unconstructed" },
  ],
});

const evidence = (artifactReference: string, sourceUrl: string, sourceDocumentSha256 = createHash("sha256").update(artifactReference).digest("hex")) => ({
  artifactReference,
  sourceKind: sourceUrl.startsWith("https://developers.openai.com/") ? "official_openai_model" as const : "unknown" as const,
  sourceUrl,
  sourceArtifactSha256: sourceDocumentSha256,
  sourceDocumentSha256,
  observedAtMs: nowMs - 1,
  freshUntilMs: nowMs + 60_000,
  currency: "USD" as const,
  fx: { kind: "native_usd" as const, sourceDocumentSha256, numerator: 1 as const, denominator: 1 as const },
  unit: "operation",
  precision: 6,
  scope: "candidate-scoped successor role/effect fixture",
  candidateSha256,
  topologySha256,
});

const evidenceResolver = (facts: readonly SuccessorRoleCostFact[]) => ({
  async read(reference: string) {
    const fact = facts.find((candidate) => candidate.evidence.artifactReference === reference);
    if (!fact) throw new Error("FIXTURE_EVIDENCE_MISSING");
    return { sourceUrl: fact.evidence.sourceUrl, bytes: fact.roleId === "model.openai-responses" ? openAiSource : new TextEncoder().encode(reference) };
  },
});

const successorRequest = async (graph: Awaited<ReturnType<typeof inventory>>, bound: Awaited<ReturnType<typeof createSuccessorRoleCostBound>>) => createNonGoogleAuthorizationRequestV3({
  identity: {
    candidateSha256, sourceSha256: hex("d"), configSha256: hex("e"), toolchainSha256: hex("f"), topologySha256,
    failureDomainSha256: hex("1"), retentionSha256: hex("2"), cleanupSha256: hex("3"), controllerStateSha256: hex("4"),
  },
  binding: { providerGraphRevision: "non-google-v1", roleInventorySha256: graph.inventorySha256, roleCostBoundSha256: bound.boundSha256, scopesSha256: hex("5"), effectsSha256: hex("6") },
});

const canonicalRecord = (label: string) => {
  const bytes = new TextEncoder().encode(label);
  return Object.freeze({ bytes, sha256: createHash("sha256").update(bytes).digest("hex") });
};

const canonicalRecords = () => Object.freeze({
  candidate: canonicalRecord("candidate-record"),
  source: canonicalRecord("source-record"),
  topology: canonicalRecord("topology-record"),
  config: canonicalRecord("config-record"),
  controllerState: canonicalRecord("controller-state-record"),
});

test("successor graph rejects forged constructor provenance and accepts only the product-owned registry", async () => {
  await expect(prepareNonGoogleSuccessorInventory({
    candidateSha256, topologySha256,
    roles: [{ roleId: "cloud_run", effectId: "worker.start", costComponentId: "worker.modal-seconds", suite: "admission", constructor: { modulePath: "src/release/native/modal.ts", exportName: "createModalNativePort", purpose: "worker", namespace: "modal:sandbox" }, construction: "native" }],
  })).rejects.toThrow("SUCCESSOR_GRAPH_LEGACY_ROLE_REJECTED");
  await expect(prepareNonGoogleSuccessorInventory({
    candidateSha256, topologySha256,
    roles: [{ roleId: "worker.modal", effectId: "worker.start", costComponentId: "worker.modal-seconds", suite: "admission", constructor: { modulePath: "operator-provided", exportName: "port", purpose: "worker", namespace: "modal:sandbox" }, construction: "native" }],
  })).rejects.toThrow("SUCCESSOR_GRAPH_CONSTRUCTOR_PROVENANCE_REQUIRED");
  await expect(prepareNonGoogleSuccessorInventory({
    candidateSha256, topologySha256,
    roles: [{ roleId: "worker.modal", effectId: "worker.start", costComponentId: "worker.modal-seconds", suite: "admission", constructor: { modulePath: "src/not-a-real-constructor.ts", exportName: "createModalLiveWorkerProvider", purpose: "worker-sandbox", namespace: "modal:sandbox" }, construction: "unconstructed" }],
  })).rejects.toThrow("SUCCESSOR_GRAPH_CONSTRUCTOR_PROVENANCE_REQUIRED");
  await expect(prepareNonGoogleSuccessorInventory({
    candidateSha256, topologySha256,
    roles: [{ roleId: "worker.modal", effectId: "worker.start", costComponentId: "worker.modal-seconds", suite: "admission", constructor: { modulePath: "src/release/native/modal.ts", exportName: "createFlyLiveWorkerProvider", purpose: "worker-sandbox", namespace: "modal:sandbox" }, construction: "unconstructed" }],
  })).rejects.toThrow("SUCCESSOR_GRAPH_CONSTRUCTOR_PROVENANCE_REQUIRED");
  await expect(prepareNonGoogleSuccessorInventory({
    candidateSha256, topologySha256,
    roles: [{ roleId: "worker.modal", effectId: "worker.reclaim", costComponentId: "worker.modal-seconds", suite: "admission", constructor: { modulePath: "src/release/native/modal.ts", exportName: "createModalLiveWorkerProvider", purpose: "worker-sandbox", namespace: "modal:sandbox" }, construction: "unconstructed" }],
  })).rejects.toThrow("SUCCESSOR_GRAPH_CONSTRUCTOR_PROVENANCE_REQUIRED");
  await expect(prepareNonGoogleSuccessorInventory({
    candidateSha256, topologySha256,
    roles: [
      { roleId: "worker.modal", effectId: "worker.start", costComponentId: "worker.modal-seconds", suite: "admission", constructor: { modulePath: "src/release/native/modal.ts", exportName: "createModalNativePort", purpose: "worker", namespace: "modal:sandbox" }, construction: "native" },
      { roleId: "worker.fly", effectId: "worker.start", costComponentId: "worker.fly-seconds", suite: "admission", constructor: { modulePath: "src/release/native/fly.ts", exportName: "createFlyNativePort", purpose: "worker", namespace: "fly:machines" }, construction: "native" },
    ],
  })).rejects.toThrow("SUCCESSOR_GRAPH_EFFECT_DUPLICATE");
});

test("every successor effect needs its own bound fact and non-model roles cannot reuse an OpenAI rate", async () => {
  const graph = await inventory();
  const rate = await openAiRate();
  const baseFacts: readonly SuccessorRoleCostFact[] = graph.roles.map((role) => ({
    roleId: role.roleId, effectId: role.effectId, costComponentId: role.costComponentId, constructorSha256: role.constructorSha256,
    disposition: role.roleId === "model.openai-responses" ? "authoritative_native_usage" : "unknown_held",
    status: role.roleId === "model.openai-responses" ? "available" : "held",
    provider: role.roleId === "model.openai-responses" ? "openai_responses" : role.roleId,
    ...(role.roleId === "model.openai-responses" ? {} : { holdReason: "role-specific source and selected native backend remain unverified" }),
    ...(role.roleId === "model.openai-responses" ? { rate, usageIntent: modelUsageIntent } : {}),
    evidence: role.roleId === "model.openai-responses"
      ? evidence(`evidence:${role.roleId.replace(/\./gu, "-")}`, OPENAI_RESPONSES_PRICING_URL, rate.sourceDocumentSha256)
      : evidence(`evidence:${role.roleId.replace(/\./gu, "-")}`, "https://napplet-cvm.invalid/held"),
  }));
  const facts: readonly SuccessorRoleCostFact[] = [
    { roleId: "model.openai-responses", effectId: "model.generate", costComponentId: "model.api-usage", constructorSha256: graph.roles[0]!.constructorSha256, disposition: "authoritative_native_usage", status: "available", provider: "openai_responses", rate, usageIntent: modelUsageIntent, evidence: evidence("evidence:openai", OPENAI_RESPONSES_PRICING_URL, rate.sourceDocumentSha256) },
    { roleId: "worker.modal", effectId: "worker.start", costComponentId: "worker.modal-seconds", constructorSha256: graph.roles[1]!.constructorSha256, disposition: "unknown_held", status: "held", provider: "modal", holdReason: "worker placement and official candidate quote remain unselected", evidence: evidence("evidence:modal-held", "https://modal.com/pricing") },
    { roleId: "object.postgres-bytea", effectId: "object.seal", costComponentId: "object.postgres-storage", constructorSha256: graph.roles[2]!.constructorSha256, disposition: "unknown_held", status: "held", provider: "postgres", holdReason: "selected authority and backup scope remain unverified", evidence: evidence("evidence:postgres-held", "https://napplet-cvm.invalid/held/postgres") },
    ...baseFacts.slice(3),
  ];
  const bound = await createSuccessorRoleCostBound({ graph, facts, modelCatalog: modelCatalog(rate) });
  expect(bound.heldRoleIds).toContain("worker.modal");
  expect(bound.heldRoleIds).toContain("object.postgres-bytea");
  await expect(assertSuccessorGraphPreapprovalHeld({ graph, bound, nowMs, evidence: evidenceResolver(facts) })).rejects.toThrow("SUCCESSOR_GRAPH_BACKEND_UNCONSTRUCTED");
  await expect(createSuccessorRoleCostBound({ graph, facts: facts.slice(0, 2), modelCatalog: modelCatalog(rate) })).rejects.toThrow("SUCCESSOR_GRAPH_COST_COVERAGE_REQUIRED");
  await expect(createSuccessorRoleCostBound({ graph, facts: facts.map((fact) => fact.roleId === "worker.modal" ? { ...fact, provider: "openai_responses", disposition: "authoritative_native_usage" as const, status: "available" as const, holdReason: undefined } : fact), modelCatalog: modelCatalog(rate) })).rejects.toThrow("SUCCESSOR_GRAPH_MODEL_RATE_REUSE_REJECTED");
  await expect(createSuccessorRoleCostBound({ graph, facts: facts.map((fact) => fact.roleId === "worker.modal" ? { ...fact, disposition: "documented_scoped_zero" as const, status: "available" as const, holdReason: undefined } : fact), modelCatalog: modelCatalog(rate) })).rejects.toThrow("SUCCESSOR_GRAPH_NONMODEL_AVAILABILITY_UNIMPLEMENTED");
  await expect(createSuccessorRoleCostBound({ graph, facts: facts.map((fact) => {
    if (fact.roleId !== "model.openai-responses") return fact;
    const { rate: _rate, ...withoutRate } = fact;
    return withoutRate;
  }), modelCatalog: modelCatalog(rate) })).rejects.toThrow("SUCCESSOR_GRAPH_MODEL_RATE_REQUIRED");
  await expect(createSuccessorRoleCostBound({ graph, facts: facts.map((fact) => fact.roleId === "model.openai-responses"
    ? { ...fact, evidence: { ...fact.evidence, sourceKind: "unknown", sourceUrl: "https://example.invalid/fake" } }
    : fact), modelCatalog: modelCatalog(rate) })).rejects.toThrow("SUCCESSOR_GRAPH_MODEL_RATE_EVIDENCE_UNBOUND");
  await expect(createSuccessorRoleCostBound({ graph, facts: facts.map((fact) => fact.roleId === "model.openai-responses"
    ? { ...fact, rate: { ...rate, model: "gpt-4.1-2025-05-14" } }
    : fact), modelCatalog: modelCatalog(rate) })).rejects.toThrow("SUCCESSOR_GRAPH_MODEL_RATE_UNBOUND");
  await expect(createSuccessorRoleCostBound({ graph, facts: facts.map((fact) => fact.roleId === "model.openai-responses"
    ? { ...fact, rate: { ...rate, quoteSha256: hex("f") } }
    : fact), modelCatalog: modelCatalog(rate) })).rejects.toThrow("SUCCESSOR_GRAPH_MODEL_RATE_UNBOUND");
});

test("Modal and Fly have separate bounded official-source producers that remain held without selected placement", async () => {
  const graph = await inventory();
  const source = {
    async readOfficialPricing(input: Readonly<{ provider: "modal" | "fly" }>) {
      const bytes = new TextEncoder().encode(`${input.provider}:official-worker-price`);
      return {
        sourceId: `${input.provider}-official-pricing`, bytes, observedAtMs: nowMs - 1, freshUntilMs: nowMs + 60_000,
        quotes: [{ provider: input.provider, componentId: `${input.provider}.candidate`, skuId: `${input.provider}-candidate`, region: "global", currency: "USD" as const, unit: "worker-100-seconds", priceMicros: 1 }],
      };
    },
  };
  const modal = await createHeldSuccessorWorkerCostFact({ graph, roleId: "worker.modal", source });
  const fly = await createHeldSuccessorWorkerCostFact({ graph, roleId: "worker.fly", source: {
    async readOfficialPricing(input) {
      const value = await source.readOfficialPricing(input);
      return { ...value, quotes: value.quotes.map((quote) => ({ ...quote, provider: "fly" as const, componentId: "fly.candidate", skuId: "fly-candidate" })) };
    },
  } });
  expect(modal).toMatchObject({ roleId: "worker.modal", provider: "modal", status: "held", evidence: { sourceKind: "official_modal_pricing", sourceUrl: "https://modal.com/pricing" } });
  expect(fly).toMatchObject({ roleId: "worker.fly", provider: "fly", status: "held", evidence: { sourceKind: "official_fly_pricing", sourceUrl: "https://docs.fly.io/about/pricing" } });
  await expect(createHeldSuccessorWorkerCostFact({ graph, roleId: "worker.modal", source: {
    async readOfficialPricing() { return { sourceId: "modal", bytes: new Uint8Array([1]), observedAtMs: nowMs - 1, freshUntilMs: nowMs + 60_000, quotes: [{ provider: "modal", componentId: "modal", skuId: "modal", region: "global", currency: "USD" as const, unit: "made-up-unit", priceMicros: 1 }] }; },
  } })).rejects.toThrow("SUCCESSOR_GRAPH_WORKER_SOURCE_INVALID");
});

test("held costs and missing native suite backends are typed zero-effect preapproval holds", async () => {
  const graph = await inventory();
  const rate = await openAiRate();
  const facts: readonly SuccessorRoleCostFact[] = graph.roles.map((role) => ({
    roleId: role.roleId,
    effectId: role.effectId,
    costComponentId: role.costComponentId,
    constructorSha256: role.constructorSha256,
    disposition: role.roleId === "model.openai-responses" ? "authoritative_native_usage" : "unknown_held",
    status: role.roleId === "model.openai-responses" ? "available" : "held",
    provider: role.roleId === "model.openai-responses" ? "openai_responses" : role.roleId,
    ...(role.roleId === "model.openai-responses" ? {} : { holdReason: "later native backend and its own cost evidence are required" }),
    ...(role.roleId === "model.openai-responses" ? { rate, usageIntent: modelUsageIntent } : {}),
    evidence: role.roleId === "model.openai-responses"
      ? evidence(`evidence:${role.roleId.replace(/\./gu, "-")}`, OPENAI_RESPONSES_PRICING_URL, rate.sourceDocumentSha256)
      : evidence(`evidence:${role.roleId.replace(/\./gu, "-")}`, "https://napplet-cvm.invalid/held"),
  }));
  const bound = await createSuccessorRoleCostBound({ graph, facts, modelCatalog: modelCatalog(rate) });
  await expect(assertSuccessorGraphPreapprovalHeld({ graph, bound, nowMs, evidence: evidenceResolver(facts) })).rejects.toThrow("SUCCESSOR_GRAPH_BACKEND_UNCONSTRUCTED");
  const request = await successorRequest(graph, bound);
  const deployment = { version: 1, providerGraphRevision: "non-google-v1", ...request.identity } as const;
  const source = { async readCostFacts() { return facts; }, modelCatalog: modelCatalog(rate), evidence: evidenceResolver(facts) };
  await expect(assertNonGooglePreapprovalHeld({ request, deployment, graph, bound, nowMs, source })).rejects.toThrow("SUCCESSOR_GRAPH_BACKEND_UNCONSTRUCTED");
  await expect(assertNonGooglePreapprovalHeld({ request: { ...request, requestSha256: hex("7") }, deployment, graph, bound, nowMs, source })).rejects.toThrow("SUCCESSOR_GRAPH_REQUEST_DIGEST_INVALID");
  await expect(assertNonGooglePreapprovalHeld({ request: { ...request, identity: { ...request.identity, configSha256: hex("8") } }, deployment, graph, bound, nowMs, source })).rejects.toThrow("SUCCESSOR_GRAPH_REQUEST_DIGEST_INVALID");
  await expect(assertNonGooglePreapprovalHeld({ request: { ...request, binding: { ...request.binding, effectsSha256: hex("9") } }, deployment, graph, bound, nowMs, source })).rejects.toThrow("SUCCESSOR_GRAPH_REQUEST_DIGEST_INVALID");
  await expect(assertNonGooglePreapprovalHeld({ request: { version: 2 }, deployment, graph, bound, nowMs, source })).rejects.toThrow("SUCCESSOR_GRAPH_REQUEST_INVALID");
});

test("normal successor materialization recomputes controller facts before any filesystem write", async () => {
  const graph = await inventory();
  const rate = await openAiRate();
  const facts: readonly SuccessorRoleCostFact[] = graph.roles.map((role) => ({
    roleId: role.roleId, effectId: role.effectId, costComponentId: role.costComponentId, constructorSha256: role.constructorSha256,
    disposition: role.roleId === "model.openai-responses" ? "authoritative_native_usage" : "unknown_held",
    status: role.roleId === "model.openai-responses" ? "available" : "held",
    provider: role.roleId === "model.openai-responses" ? "openai_responses" : role.roleId,
    ...(role.roleId === "model.openai-responses" ? { rate, usageIntent: modelUsageIntent } : { holdReason: "later native backend and its own cost evidence are required" }),
    evidence: role.roleId === "model.openai-responses"
      ? evidence(`evidence:${role.roleId.replace(/\./gu, "-")}`, OPENAI_RESPONSES_PRICING_URL, rate.sourceDocumentSha256)
      : evidence(`evidence:${role.roleId.replace(/\./gu, "-")}`, "https://napplet-cvm.invalid/held"),
  }));
  const bound = await createSuccessorRoleCostBound({ graph, facts, modelCatalog: modelCatalog(rate) });
  const request = await successorRequest(graph, bound);
  const deployment = { version: 1, providerGraphRevision: "non-google-v1", ...request.identity } as const;
  const controller = createNonGooglePreapprovalMaterializer({
    async readCostFacts() { return facts; }, modelCatalog: modelCatalog(rate), evidence: evidenceResolver(facts),
  });
  const workspace = `/tmp/napplet-cvm-successor-${crypto.randomUUID()}`;
  const materialization: MaterializePreapprovalInput = {
    workspace,
    repositoryRoot: process.cwd(),
    candidateId: candidateSha256,
    source: { sourceRevision: "a".repeat(40), sourceSha256: hex("a") },
    topology: { candidateSha256, topologySha256 },
    catalog: { catalogSha256: hex("c"), topologySha256 },
    authorization: { authorizationRequestSha256: hex("d"), controllerStateSha256: hex("e"), effectPlanSha256: hex("f"), providerScopesSha256: hex("1"), maximumAuthorizedCostMicros: 1, cleanupByMs: 1_000, expiresAtMs: 2_000 },
    publicSettings: { regions: ["europe-west1", "us-central1"], maximumRunDurationMs: 900_000, retentionDays: 30 },
    opaqueReferenceNames: ["modal"],
    collector: { plannedRegistryReference: `registry.example/napplet-cvm/collector@sha256:${hex("2")}`, registryAvailability: "not_uploaded", localOciManifestDigest: `sha256:${hex("2")}`, localOciConfigDigest: `sha256:${hex("3")}`, platform: { os: "linux", architecture: "amd64" }, baseImage: `otel/opentelemetry-collector@sha256:${hex("4")}`, dockerfileSha256: hex("5"), collectorConfigSha256: hex("6"), ociLayoutPath: `${workspace}/collector.oci`, ociLayoutSha256: hex("7") },
    factory: { root: process.cwd(), modulePath: `${process.cwd()}/src/release/deployment/production-factory.ts`, moduleSha256: hex("8"), configPath: `${process.cwd()}/src/release/deployment/factory.ts`, configSha256: hex("9") },
  };
  const normalInput = {
    materialization,
    request, deployment, graph, bound, nowMs,
  };
  await expect(controller.materialize(normalInput)).rejects.toThrow("SUCCESSOR_GRAPH_BACKEND_UNCONSTRUCTED");
  expect(existsSync(workspace)).toBe(false);
  await expect(controller.materialize({ ...normalInput, graph: { ...graph, inventorySha256: hex("9") } })).rejects.toThrow("SUCCESSOR_GRAPH_PREAPPROVAL_BINDING_INVALID");
  await expect(controller.materialize({ ...normalInput, graph: { ...graph, roles: graph.roles.map((role) => role.roleId === "worker.modal" ? { ...role, construction: "native" } : role) } })).rejects.toThrow("SUCCESSOR_GRAPH_PREAPPROVAL_BINDING_INVALID");
  await expect(controller.materialize({ ...normalInput, bound: { ...bound, heldRoleIds: [] } })).rejects.toThrow("SUCCESSOR_GRAPH_PREAPPROVAL_BINDING_INVALID");
  await expect(controller.materialize({ ...normalInput, bound: { ...bound, facts: bound.facts.map((fact) => fact.roleId === "worker.modal" ? { ...fact, holdReason: "tampered fact should never bind" } : fact) } })).rejects.toThrow("SUCCESSOR_GRAPH_PREAPPROVAL_BINDING_INVALID");
  const forgedBound = { ...bound, boundSha256: hex("8"), heldRoleIds: [] };
  const forgedRequest = await createNonGoogleAuthorizationRequestV3({ identity: request.identity, binding: { ...request.binding, roleCostBoundSha256: forgedBound.boundSha256 } });
  await expect(controller.materialize({ ...normalInput, request: forgedRequest, bound: forgedBound })).rejects.toThrow("SUCCESSOR_GRAPH_PREAPPROVAL_BINDING_INVALID");
  await expect(prepareNonGoogleSuccessorPreapprovalHold({ nowMs })).rejects.toThrow("SUCCESSOR_GRAPH_TOPOLOGY_OR_CONFIG_UNAVAILABLE");
  const records = canonicalRecords();
  await expect(prepareNonGoogleSuccessorPreapprovalHold({ nowMs, records: { ...records, candidate: { ...records.candidate, sha256: hex("a") } } })).rejects.toThrow("SUCCESSOR_GRAPH_CANONICAL_RECORD_DIGEST_INVALID");
  await expect(prepareNonGoogleSuccessorPreapprovalHold({ nowMs, records: { ...records, source: { ...records.source, bytes: new TextEncoder().encode("unrelated-source-bytes") } } })).rejects.toThrow("SUCCESSOR_GRAPH_CANONICAL_RECORD_DIGEST_INVALID");
  await expect(prepareNonGoogleSuccessorPreapprovalHold({ nowMs, records: { ...records, topology: { ...records.topology, sha256: hex("a") } } })).rejects.toThrow("SUCCESSOR_GRAPH_CANONICAL_RECORD_DIGEST_INVALID");
  await expect(prepareNonGoogleSuccessorPreapprovalHold({ nowMs, records: { ...records, config: { ...records.config, sha256: hex("a") } } })).rejects.toThrow("SUCCESSOR_GRAPH_CANONICAL_RECORD_DIGEST_INVALID");
  await expect(prepareNonGoogleSuccessorPreapprovalHold({ nowMs, records: { ...records, controllerState: { ...records.controllerState, sha256: hex("a") } } })).rejects.toThrow("SUCCESSOR_GRAPH_CANONICAL_RECORD_DIGEST_INVALID");
});

test("successor receipts use their disjoint v4 envelope and verify the v3 binding before consumption", async () => {
  const graph = await inventory();
  const facts: readonly SuccessorRoleCostFact[] = graph.roles.map((role) => ({
    roleId: role.roleId, effectId: role.effectId, costComponentId: role.costComponentId, constructorSha256: role.constructorSha256,
    disposition: "unknown_held", status: "held", provider: role.roleId, holdReason: "receipt remains closed", evidence: evidence(`evidence:${role.roleId}`, "https://napplet-cvm.invalid/held"),
  }));
  const bound = await createSuccessorRoleCostBound({ graph, facts });
  const request = await successorRequest(graph, bound);
  const receipt = { kind: "release-authorization-receipt-v4", version: 4, requestSha256: request.requestSha256, candidateSha256: request.identity.candidateSha256, topologySha256: request.identity.topologySha256,
    providerGraphRevision: "non-google-v1", roleInventorySha256: request.binding.roleInventorySha256, roleCostBoundSha256: request.binding.roleCostBoundSha256, receiptSha256: hex("f") } as const;
  expect(await verifyNonGoogleAuthorizationReceiptV4({ request, receipt })).toMatchObject({ version: 4, providerGraphRevision: "non-google-v1" });
  await expect(verifyNonGoogleAuthorizationReceiptV4({ request: { ...request, requestSha256: hex("a") }, receipt })).rejects.toThrow("SUCCESSOR_GRAPH_REQUEST_DIGEST_INVALID");
  await expect(verifyNonGoogleAuthorizationReceiptV4({ request, receipt: { ...receipt, requestSha256: hex("a") } })).rejects.toThrow("SUCCESSOR_GRAPH_RECEIPT_BINDING_INVALID");
  expect(() => NonGoogleAuthorizationReceiptV4Schema.parse({ kind: "release-authorization-receipt-v3", version: 3 })).toThrow();
});
