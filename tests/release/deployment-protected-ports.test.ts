import { expect, test } from "bun:test";

import { createDeploymentProtectedPorts } from "../../src/release/deployment/protected-ports";

const real = <T extends Record<string, unknown>>(port: T) => Object.freeze({ ...port, evidenceClass: "real" as const });

function ports() {
  return {
    admission: real({ executeSample: async () => ({}) }),
    telemetry: real({ emit: async () => {}, queryWindow: async () => ({}) }),
    chaos: real({ executeFault: async () => ({}), observeOriginal: async () => ({}), observeTopology: async () => ({}) }),
    durability: real({ inventory: async () => [], loseLocalState: async () => ({ status: "lost" }), createFreshInstance: async () => ({}) }),
    "security-host": real({ runSealedBuild: async () => ({}), runHostileMatrix: async () => ({}), runBrowser: async () => ({}), inspectSignerBoundary: async () => ({}) }),
    "supply-chain": real({ runBuild: async () => ({}), supplyChainInput: async () => ({}) }),
    "ContextVM-payment-model": real({ exerciseSignedTransport: async () => ({}), exerciseCep8Settlement: async () => ({}), reconcileOriginalModelOperation: async () => ({}) }),
    publication: real({ verifyPromotedSource: async () => ({}), submitOriginalPublication: async () => ({}), reconcileOriginalPublication: async () => ({}) }),
  } as const;
}

test("deployment protected factory returns exactly eight distinct real suite ports without effects", () => {
  const constructed = createDeploymentProtectedPorts(ports());

  expect(Object.keys(constructed).sort()).toEqual([
    "ContextVM-payment-model", "admission", "chaos", "durability", "publication", "security-host", "supply-chain", "telemetry",
  ]);
  expect(Object.values(constructed).every((port) => port.evidenceClass === "real")).toBe(true);
  expect(new Set(Object.values(constructed)).size).toBe(8);
  expect(Object.isFrozen(constructed)).toBe(true);
});

test("deployment protected factory rejects duplicate, fixture, and incomplete suite ports before dispatch", () => {
  const distinct = ports();
  expect(() => createDeploymentProtectedPorts({ ...distinct, telemetry: distinct.admission } as never)).toThrow("DEPLOYMENT_PROTECTED_PORT_IDENTITY_REQUIRED");
  expect(() => createDeploymentProtectedPorts({ ...distinct, admission: { ...distinct.admission, evidenceClass: "deterministic" } } as never)).toThrow("PRODUCTION_LIVE_PORT_REAL_EVIDENCE_REQUIRED");
  expect(() => createDeploymentProtectedPorts({ admission: distinct.admission } as never)).toThrow("PRODUCTION_LIVE_PORT_REAL_EVIDENCE_REQUIRED");
});
