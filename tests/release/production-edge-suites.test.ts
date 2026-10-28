import { expect, spyOn, test } from "bun:test";

import { createProductionEdgeSuiteAdapters } from "../../src/release/deployment/production-edge-suite-adapters";
import { PostgresOperationJournal } from "../../src/release/deployment/postgres-operation-journal";
import { openContextVmCertificationClient } from "../../src/release/deployment/contextvm-client";
import { ProductionCoreControlClient } from "../../src/release/deployment/production-core-control";
import { CertificationEdgePayloadSchemas, ProductionCertificationEdgeService } from "../../src/production/certification-edge";
import { createProductionEdgeClients } from "../../src/production/edge-clients";
import { openProductionNip46Signer } from "../../src/production/nip46-signer";

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
    await adapters.publication.submitOriginalPublication(source);
    await adapters.publication.reconcileOriginalPublication({ intentId: "intent-1", operationIds: { deploy: "deploy:intent-1", ownerManifest: "owner_manifest:intent-1", attestation: "attestation:intent-1" } });
    expect([...seen].sort()).toEqual(Object.keys(CertificationEdgePayloadSchemas).sort());
  } finally { execute.mockRestore(); }
});

test("native edge factory rejects a non-Chromium mounted browser before any provider construction", () => {
  expect(() => createProductionEdgeClients({ host: { packageHost: {} as never, chromium: { kind: "webkit" } as never } } as never)).toThrow("PRODUCTION_EDGE_CHROMIUM_REQUIRED");
});

test("NIP-46 signer rejects non-bunker references before resolving any session key", async () => {
  await expect(openProductionNip46Signer({ bunkerUri: "https://invalid", sessionKeyReference: "nostr:session", sessionKeyBroker: {} as never, context: {} as never, journal: {} as never })).rejects.toThrow("NIP46_REFERENCE_INVALID");
});
