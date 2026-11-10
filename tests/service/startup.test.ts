import { expect, test } from "bun:test";
import { serviceStartupFailure } from "../../scripts/production";
import { parseServiceConfig } from "../../src/service/config";

test("missing service configuration reports the fixed mount required by the container", () => {
  expect(serviceStartupFailure(new Error("SERVICE_MOUNT_UNAVAILABLE:/etc/napplet-cvm/service.json"))).toEqual({
    ready: false,
    error: "SERVICE_MOUNT_UNAVAILABLE:/etc/napplet-cvm/service.json",
  });
  expect(serviceStartupFailure(new Error("SERVICE_CONFIG_INVALID_JSON"))).toEqual({ ready: false, error: "SERVICE_CONFIG_INVALID_JSON" });
});

test("startup diagnostics redact arbitrary messages, paths and appended secret values", () => {
  const secret = "sk-test-secret-value";
  for (const message of [
    `connection failed: postgresql://user:${secret}@database/service`,
    `SERVICE_MOUNT_UNAVAILABLE:/tmp/${secret}`,
    `SERVICE_MOUNT_UNAVAILABLE:/etc/napplet-cvm/service.json ${secret}`,
    `SERVICE_MOUNT_UNAVAILABLE:/etc/napplet-cvm/service.json\n${secret}`,
  ]) {
    expect(serviceStartupFailure(new Error(message))).toEqual({ ready: false, error: "SERVICE_START_FAILED", kind: "Error" });
  }
  expect(serviceStartupFailure(secret)).toEqual({ ready: false, error: "SERVICE_START_FAILED" });
});

test("validation diagnostics retain issue paths and codes without rejected values", () => {
  let error: unknown;
  try { parseServiceConfig({ realm: "sk-test-secret-value" }); } catch (caught) { error = caught; }
  const diagnostic = serviceStartupFailure(error);
  expect(diagnostic.error).toBe("SERVICE_START_FAILED");
  expect(diagnostic.validation).toContain("realm:invalid_value");
  expect(JSON.stringify(diagnostic)).not.toContain("sk-test-secret-value");
});

test("unexpected startup failures retain safe system codes without cause details", () => {
  expect(serviceStartupFailure(new Error("database password: secret", { cause: { code: "ECONNREFUSED", password: "secret" } }))).toEqual({
    ready: false, error: "SERVICE_START_FAILED", kind: "Error", code: "ECONNREFUSED",
  });
});
