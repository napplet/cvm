import { expect, test } from "bun:test";

import { RELEASE_PRODUCTION_PROVIDER_IDS } from "../../src/release/native-registry";
import { PRODUCTION_LIVE_PROTECTED_PORT_KEYS } from "../../src/certification/live/production-ports";
import { PostgresOperationJournal } from "../../src/release/deployment/postgres-operation-journal";
import {
  createProductionSessionDependencies,
  createReleaseExecutionSession,
  composeProductionProtectedPorts,
  productionSessionReadiness,
} from "../../src/release/deployment/production-session";
import { installSealedProductionSessionMaterial } from "../../src/release/deployment/production-session-material";

test("production session exposes the exact controller-owned sixteen-provider/eight-suite shape", () => {
  expect(productionSessionReadiness.providerFamilies).toEqual(RELEASE_PRODUCTION_PROVIDER_IDS);
  expect(productionSessionReadiness.protectedSuites).toEqual(PRODUCTION_LIVE_PROTECTED_PORT_KEYS);
  expect(() => createProductionSessionDependencies({} as never)).toThrow("PRODUCTION_SESSION_RUNTIME_REQUIRED");
});

test("protected-suite composition requires the core and edge adapters to supply every distinct suite", () => {
  expect(() => composeProductionProtectedPorts({ core: {} as never, edge: {} as never })).toThrow("PRODUCTION_SESSION_PROTECTED_PORT_SET_REQUIRED");
});

test("session composition rejects any non-PostgreSQL original-operation authority before a provider can run", () => {
  let calls = 0;
  const port = () => Object.freeze({
    async discoverCapabilities() { calls += 1; return { capability: "available" as const }; },
    async discoverAuthentication() { calls += 1; return { authentication: "authorized" as const }; },
    async plan() { calls += 1; return { status: "planned" as const, estimatedCostMicros: 0 }; },
    async apply() { calls += 1; return { status: "blocked" as const, actualCostMicros: 0 }; },
    async observe() { calls += 1; return { status: "blocked" as const, actualCostMicros: 0 }; },
    async cleanup() { calls += 1; return { status: "blocked" as const, actualCostMicros: 0 }; },
  });
  const runtime = {
    journal: new PostgresOperationJournal({ async connect() { throw new Error("SQL must not run at construction"); } }, { namespace: "production-session", scopeSha256: "a".repeat(64) }),
    receipt: {},
    providers: Object.fromEntries(RELEASE_PRODUCTION_PROVIDER_IDS.map((id) => [id, Object.freeze({ origin: "project-owned" as const, evidenceClass: "real" as const, brokerReference: `broker:${id}:real`, port: port() })])),
    protectedPorts: Object.fromEntries(PRODUCTION_LIVE_PROTECTED_PORT_KEYS.map((key) => [key, Object.freeze({ origin: "project-owned" as const, evidenceClass: "real" as const })])),
    async prepare() { return {} as never; },
  };
  expect(createProductionSessionDependencies(runtime as never).registry.providers()).toEqual(RELEASE_PRODUCTION_PROVIDER_IDS);
  expect(calls).toBe(0);
});

test("missing receipt material cannot construct an operational graph", () => {
  const runtime = {
    journal: new PostgresOperationJournal({ async connect() { throw new Error("SQL must not run at construction"); } }, { namespace: "production-session", scopeSha256: "b".repeat(64) }),
    providers: {}, protectedPorts: {}, async prepare() { return {} as never; },
  };
  expect(() => createProductionSessionDependencies(runtime as never)).toThrow("PRODUCTION_SESSION_RECEIPT_REQUIRED");
});

test("normal session factory rejects before broker construction when no controller receipt is bound", async () => {
  await expect(createReleaseExecutionSession({
    candidateSha256: "c".repeat(64),
    workspace: process.cwd(),
    deploymentConfig: { candidateSha256: "c".repeat(64) },
  } as never)).rejects.toThrow("PRODUCTION_SESSION_RECEIPT_REQUIRED");
});

test("only sealed complete production material can register the process broker", () => {
  expect(() => installSealedProductionSessionMaterial({})).toThrow("PRODUCTION_SESSION_MATERIAL_REQUIRED");
});
