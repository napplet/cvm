import { expect, test } from "bun:test";
import { unexecutedProtectedPorts } from "../fixtures/unexecuted-protected-ports";

import { createDeploymentProtectedPorts } from "../../src/release/deployment/protected-ports";

const ports = unexecutedProtectedPorts;

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
  expect(() => createDeploymentProtectedPorts({ admission: distinct.admission } as never)).toThrow("PRODUCTION_LIVE_PORT_EXACT_SET_REQUIRED");
});
