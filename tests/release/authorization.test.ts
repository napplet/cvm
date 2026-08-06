import { expect, test } from "bun:test";
import {
  createAuthorizationReceipt,
  createAuthorizationRequest,
  validateAuthorizationReceipt,
} from "../../src/release/authorization";

const digest = (value: string) => value.repeat(64).slice(0, 64);

const input = (overrides: Record<string, unknown> = {}) => ({
  candidateSha256: digest("a"),
  topologySha256: digest("b"),
  effectPlanSha256: digest("c"),
  controllerStateSha256: digest("d"),
  providerCapabilitiesSha256: digest("e"),
  orderedEffects: [{ id: "cloud-run-ingress", provider: "cloud_run", operation: "create_or_update", estimatedCostMicros: 5_000_000 }],
  providerScopes: [{ provider: "cloud_run", accountScopeSha256: digest("f"), projectScopeSha256: digest("g") }],
  estimate: { currency: "USD", maximumMicros: 5_000_000, sourceId: "release-topology-v1", observedAtMs: 1_000, freshUntilMs: 2_000 },
  maximumRunDurationMs: 60_000,
  cleanupByMs: 61_000,
  evidenceRetentionDays: 30,
  artifactRetentionDays: 30,
  gcpEffects: { projectBootstrap: true, billing: true, apiEnablement: ["run.googleapis.com", "sqladmin.googleapis.com", "storage.googleapis.com"] },
  expiresAtMs: 1_500,
  ...overrides,
});

test("creates one canonical USD request and exact expected receipt", async () => {
  const request = await createAuthorizationRequest(input());
  const duplicate = await createAuthorizationRequest(input());
  const receipt = await createAuthorizationReceipt(request);

  expect(request.version).toBe(2);
  expect(request.currency).toBe("USD");
  expect(request.maximumAuthorizedCostMicros).toBe(5_000_000);
  expect(request.authorizationRequestSha256).toBe(duplicate.authorizationRequestSha256);
  expect(request.expectedReceiptSha256).toBe(receipt.authorizationReceiptSha256);
  await expect(validateAuthorizationReceipt({ request, receipt, nowMs: 1_499 })).resolves.toEqual(receipt);
});

test("rejects stale estimates, unitless costs, and tampered receipt inputs", async () => {
  await expect(createAuthorizationRequest(input({ estimate: { currency: "USD", maximumMicros: 5_000_000, sourceId: "release-topology-v1", observedAtMs: 1_000, freshUntilMs: 1_500 }, expiresAtMs: 1_500 }))).rejects.toThrow("RELEASE_AUTHORIZATION_ESTIMATE_STALE");
  await expect(createAuthorizationRequest(input({ estimate: { currency: "EUR", maximumMicros: 5_000_000, sourceId: "release-topology-v1", observedAtMs: 1_000, freshUntilMs: 2_000 } }))).rejects.toThrow();

  const request = await createAuthorizationRequest(input());
  const receipt = await createAuthorizationReceipt(request);
  await expect(validateAuthorizationReceipt({ request: { ...request, topologySha256: digest("9") }, receipt, nowMs: 1_499 })).rejects.toThrow("RELEASE_AUTHORIZATION_RECEIPT_INVALID");
  await expect(validateAuthorizationReceipt({ request, receipt, nowMs: 1_500 })).rejects.toThrow("RELEASE_AUTHORIZATION_RECEIPT_EXPIRED");
});

test("every bound authorization input changes the request digest", async () => {
  const base = await createAuthorizationRequest(input());
  const mutations = [
    { candidateSha256: digest("1") }, { topologySha256: digest("2") }, { effectPlanSha256: digest("3") },
    { controllerStateSha256: digest("4") }, { providerCapabilitiesSha256: digest("5") },
    { estimate: { currency: "USD", maximumMicros: 5_000_001, sourceId: "release-topology-v1", observedAtMs: 1_000, freshUntilMs: 2_000 } },
    { providerScopes: [{ provider: "cloud_run", accountScopeSha256: digest("6"), projectScopeSha256: digest("7") }] },
    { orderedEffects: [{ id: "cloud-run-ingress", provider: "cloud_run", operation: "create_or_update", estimatedCostMicros: 5_000_001 }] },
    { maximumRunDurationMs: 59_000 }, { cleanupByMs: 60_500 }, { evidenceRetentionDays: 29 }, { artifactRetentionDays: 29 },
    { gcpEffects: { projectBootstrap: false, billing: true, apiEnablement: ["run.googleapis.com", "sqladmin.googleapis.com", "storage.googleapis.com"] } },
    { expiresAtMs: 1_499 },
  ];

  for (const mutation of mutations) {
    expect((await createAuthorizationRequest(input(mutation))).authorizationRequestSha256).not.toBe(base.authorizationRequestSha256);
  }
});
