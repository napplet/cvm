import { expect, test } from "bun:test";

import {
  assertSuccessorGraphPreapprovalHeld,
  createSuccessorGraphInventory,
  createSuccessorRoleCostBound,
  type SuccessorRoleCostFact,
} from "../../src/release/costs/non-google-cost-bound";

const hex = (character: string) => character.repeat(64);
const candidateSha256 = hex("a");
const topologySha256 = hex("b");
const nowMs = 1_000_000;

const inventory = () => createSuccessorGraphInventory({
  graphRevision: "non-google-v1",
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
      constructor: { modulePath: "src/release/native/modal.ts", exportName: "createModalNativePort", purpose: "worker-sandbox", namespace: "modal:sandbox" },
      construction: "unconstructed",
    },
    {
      roleId: "object.postgres-bytea",
      effectId: "object.seal",
      costComponentId: "object.postgres-storage",
      suite: "restore",
      constructor: { modulePath: "src/continuity/postgres-bytea-object-store.ts", exportName: "PostgresByteaObjectStoreAdapter", purpose: "immutable-objects", namespace: "postgres:objects" },
      construction: "native",
    },
  ],
});

const evidence = (artifactReference: string, sourceUrl: string) => ({
  artifactReference,
  sourceUrl,
  sourceArtifactSha256: hex("c"),
  sourceDocumentSha256: hex("c"),
  observedAtMs: nowMs - 1,
  freshUntilMs: nowMs + 60_000,
  currency: "USD" as const,
  fx: { kind: "native_usd" as const, sourceDocumentSha256: hex("c"), numerator: 1 as const, denominator: 1 as const },
  unit: "operation",
  precision: 6,
  scope: "candidate-scoped successor role/effect fixture",
  candidateSha256,
  topologySha256,
});

test("successor graph refuses legacy identities, duplicate effects, and a label-shaped constructor", () => {
  expect(() => createSuccessorGraphInventory({
    graphRevision: "non-google-v1", candidateSha256, topologySha256,
    roles: [{ roleId: "cloud_run", effectId: "worker.start", costComponentId: "worker.modal-seconds", suite: "admission", constructor: { modulePath: "src/release/native/modal.ts", exportName: "createModalNativePort", purpose: "worker", namespace: "modal:sandbox" }, construction: "native" }],
  })).toThrow("SUCCESSOR_GRAPH_LEGACY_ROLE_REJECTED");
  expect(() => createSuccessorGraphInventory({
    graphRevision: "non-google-v1", candidateSha256, topologySha256,
    roles: [{ roleId: "worker.modal", effectId: "worker.start", costComponentId: "worker.modal-seconds", suite: "admission", constructor: { modulePath: "operator-provided", exportName: "port", purpose: "worker", namespace: "modal:sandbox" }, construction: "native" }],
  })).toThrow("SUCCESSOR_GRAPH_CONSTRUCTOR_PROVENANCE_REQUIRED");
  expect(() => createSuccessorGraphInventory({
    graphRevision: "non-google-v1", candidateSha256, topologySha256,
    roles: [
      { roleId: "worker.modal", effectId: "worker.start", costComponentId: "worker.modal-seconds", suite: "admission", constructor: { modulePath: "src/release/native/modal.ts", exportName: "createModalNativePort", purpose: "worker", namespace: "modal:sandbox" }, construction: "native" },
      { roleId: "worker.fly", effectId: "worker.start", costComponentId: "worker.fly-seconds", suite: "admission", constructor: { modulePath: "src/release/native/fly.ts", exportName: "createFlyNativePort", purpose: "worker", namespace: "fly:machines" }, construction: "native" },
    ],
  })).toThrow("SUCCESSOR_GRAPH_EFFECT_DUPLICATE");
});

test("every successor effect needs its own bound fact and non-model roles cannot reuse an OpenAI rate", () => {
  const graph = inventory();
  const facts: readonly SuccessorRoleCostFact[] = [
    { roleId: "model.openai-responses", effectId: "model.generate", costComponentId: "model.api-usage", constructorSha256: graph.roles[0]!.constructorSha256, disposition: "authoritative_native_usage", status: "available", provider: "openai_responses", evidence: evidence("evidence:openai", "https://developers.openai.com/api/docs/models/gpt-4.1") },
    { roleId: "worker.modal", effectId: "worker.start", costComponentId: "worker.modal-seconds", constructorSha256: graph.roles[1]!.constructorSha256, disposition: "unknown_held", status: "held", provider: "modal", holdReason: "worker placement and official candidate quote remain unselected", evidence: evidence("evidence:modal-held", "https://modal.com/pricing") },
    { roleId: "object.postgres-bytea", effectId: "object.seal", costComponentId: "object.postgres-storage", constructorSha256: graph.roles[2]!.constructorSha256, disposition: "unknown_held", status: "held", provider: "postgres", holdReason: "selected authority and backup scope remain unverified", evidence: evidence("evidence:postgres-held", "https://napplet-cvm.invalid/held/postgres") },
  ];
  const bound = createSuccessorRoleCostBound({ graph, facts });
  expect(bound.heldRoleIds).toEqual(["worker.modal", "object.postgres-bytea"]);
  expect(() => assertSuccessorGraphPreapprovalHeld({ graph, bound, nowMs })).toThrow("SUCCESSOR_GRAPH_BACKEND_UNCONSTRUCTED");
  expect(() => createSuccessorRoleCostBound({ graph, facts: facts.slice(0, 2) })).toThrow("SUCCESSOR_GRAPH_COST_COVERAGE_REQUIRED");
  expect(() => createSuccessorRoleCostBound({ graph, facts: [{ ...facts[0]!, roleId: "worker.modal", effectId: "worker.start", costComponentId: "worker.modal-seconds", constructorSha256: graph.roles[1]!.constructorSha256, provider: "openai_responses", disposition: "authoritative_native_usage" }, facts[1]!, facts[2]!] })).toThrow("SUCCESSOR_GRAPH_MODEL_RATE_REUSE_REJECTED");
});

test("held costs and missing native suite backends are typed zero-effect preapproval holds", () => {
  const graph = inventory();
  const facts: readonly SuccessorRoleCostFact[] = graph.roles.map((role) => ({
    roleId: role.roleId,
    effectId: role.effectId,
    costComponentId: role.costComponentId,
    constructorSha256: role.constructorSha256,
    disposition: role.roleId === "model.openai-responses" ? "authoritative_native_usage" : "unknown_held",
    status: role.roleId === "model.openai-responses" ? "available" : "held",
    provider: role.roleId === "model.openai-responses" ? "openai_responses" : role.roleId,
    ...(role.roleId === "model.openai-responses" ? {} : { holdReason: "later native backend and its own cost evidence are required" }),
    evidence: evidence(`evidence:${role.roleId.replace(/\./gu, "-")}`, role.roleId === "model.openai-responses" ? "https://developers.openai.com/api/docs/models/gpt-4.1" : "https://napplet-cvm.invalid/held"),
  }));
  const bound = createSuccessorRoleCostBound({ graph, facts });
  expect(() => assertSuccessorGraphPreapprovalHeld({ graph, bound, nowMs })).toThrow("SUCCESSOR_GRAPH_BACKEND_UNCONSTRUCTED");
});
