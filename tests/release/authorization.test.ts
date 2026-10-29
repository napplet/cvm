import { expect, test } from "bun:test";
import {
  type AuthorizationRequestInput,
  createOfficialConsentReceipt,
  createAuthorizationReceipt,
  createAuthorizationRequest,
  validateAuthorizationReceipt,
} from "../../src/release/authorization";

const digest = (value: string) => value.repeat(64).slice(0, 64);

const operatorFundingReadiness = {
  version: 1 as const,
  status: "ready" as const,
  rails: [
    { rail: "nwc_lightning" as const, secretReference: "os-secret-ref:release-nwc-01", capabilitySha256: digest("a"), accountScopeSha256: digest("b"), expiresAtMs: 2_000, status: "ready" as const },
    { rail: "cashu" as const, secretReference: "os-secret-ref:release-cashu-01", capabilitySha256: digest("c"), accountScopeSha256: digest("d"), expiresAtMs: 2_000, status: "ready" as const },
  ],
  readinessSha256: digest("e"),
};
const cashuOnlyOperatorFundingReadiness = {
  version: 1 as const,
  status: "ready" as const,
  rails: [
    { rail: "cashu" as const, secretReference: "os-secret-ref:release-cashu-01", capabilitySha256: digest("c"), accountScopeSha256: digest("d"), expiresAtMs: 2_000, status: "ready" as const },
  ],
  readinessSha256: digest("9"),
};

const input = (overrides: Record<string, unknown> = {}) => ({
  candidateSha256: digest("a"),
  topologySha256: digest("b"),
  effectPlanSha256: digest("c"),
  controllerStateSha256: digest("d"),
  providerCapabilitiesSha256: digest("e"),
  orderedEffects: [{ id: "cloud-run-ingress", provider: "cloud_run", operation: "create_or_update", estimatedCostMicros: 5_000_000 }],
  providerScopes: [{ provider: "cloud_run", accountScopeSha256: digest("f"), projectScopeSha256: digest("1") }],
  estimate: { currency: "USD", maximumMicros: 5_000_000, sourceId: "release-topology-v1", observedAtMs: 1_000, freshUntilMs: 2_000 },
  maximumRunDurationMs: 60_000,
  cleanupByMs: 1_400,
  evidenceRetentionDays: 30,
  artifactRetentionDays: 30,
  operatorFundingReadiness,
  gcpEffects: { projectBootstrap: true, billing: true, apiEnablement: ["run.googleapis.com", "sqladmin.googleapis.com", "storage.googleapis.com"] },
  expiresAtMs: 1_500,
  ...overrides,
} satisfies AuthorizationRequestInput);

test("creates one canonical USD request and exact expected receipt", async () => {
  const request = await createAuthorizationRequest(input());
  const duplicate = await createAuthorizationRequest(input());
  const receipt = await createAuthorizationReceipt(request);

  expect(request.version).toBe(2);
  expect(request.currency).toBe("USD");
  expect(request.maximumAuthorizedCostMicros).toBe(5_000_000);
  expect(request.authorizationRequestSha256).toBe(duplicate.authorizationRequestSha256);
  expect(request.expectedReceiptSha256).not.toBe(receipt.authorizationReceiptSha256);
  await expect(validateAuthorizationReceipt({ request, receipt, nowMs: 1_499 })).resolves.toEqual(receipt);
});

test("requires structured official approval provenance instead of a bare receipt digest", async () => {
  const request = await createAuthorizationRequest(input());
  const receipt = await createOfficialConsentReceipt({
    request,
    approval: {
      approvalChannel: "loopback_fixture",
      approverPrincipalSha256: digest("f"),
      consentSessionReferences: ["loopback:consent:session-01"],
      approvedAtMs: 1_001,
      expiresAtMs: request.expiresAtMs,
    },
  });

  await expect(validateAuthorizationReceipt({ request, receipt, nowMs: 1_200 })).resolves.toEqual(receipt);
  await expect(validateAuthorizationReceipt({ request, receipt: request.expectedReceiptSha256, nowMs: 1_200 })).rejects.toThrow();
  await expect(validateAuthorizationReceipt({ request, receipt: { ...receipt, approvalChannel: "environment" }, nowMs: 1_200 })).rejects.toThrow();
});

test("rejects stale estimates, unitless costs, and tampered receipt inputs", async () => {
  await expect(createAuthorizationRequest(input({ estimate: { currency: "USD", maximumMicros: 5_000_000, sourceId: "release-topology-v1", observedAtMs: 1_000, freshUntilMs: 1_500 }, expiresAtMs: 1_500 }))).rejects.toThrow("RELEASE_AUTHORIZATION_ESTIMATE_STALE");
  await expect(createAuthorizationRequest(input({ estimate: { currency: "EUR", maximumMicros: 5_000_000, sourceId: "release-topology-v1", observedAtMs: 1_000, freshUntilMs: 2_000 } }))).rejects.toThrow();

  const request = await createAuthorizationRequest(input());
  const receipt = await createAuthorizationReceipt(request);
  await expect(validateAuthorizationReceipt({ request: { ...request, topologySha256: digest("9") }, receipt, nowMs: 1_499 })).rejects.toThrow("RELEASE_AUTHORIZATION_REQUEST_INVALID");
  await expect(validateAuthorizationReceipt({ request, receipt, nowMs: 1_500 })).rejects.toThrow("RELEASE_AUTHORIZATION_RECEIPT_EXPIRED");
});

test("rejects cleanup that outlives the exact authorization expiry", async () => {
  await expect(createAuthorizationRequest(input({ cleanupByMs: 1_501 }))).rejects.toThrow("RELEASE_AUTHORIZATION_CLEANUP_UNBOUNDED");
});

test("accepts Cashu-only operator funding for release certification authorization", async () => {
  const request = await createAuthorizationRequest(input({ operatorFundingReadiness: cashuOnlyOperatorFundingReadiness }));
  expect(request.operatorFundingReadiness).toMatchObject({ status: "ready", rails: [{ rail: "cashu" }] });
});

test("every bound authorization input changes the request digest", async () => {
  const base = await createAuthorizationRequest(input());
  const mutations = [
    { candidateSha256: digest("1") }, { topologySha256: digest("2") }, { effectPlanSha256: digest("3") },
    { controllerStateSha256: digest("4") }, { providerCapabilitiesSha256: digest("5") },
    { estimate: { currency: "USD", maximumMicros: 5_000_000, sourceId: "release-topology-v2", observedAtMs: 1_000, freshUntilMs: 2_000 } },
    { providerScopes: [{ provider: "cloud_run", accountScopeSha256: digest("6"), projectScopeSha256: digest("7") }] },
    { orderedEffects: [{ id: "cloud-run-ingress", provider: "cloud_run", operation: "create_or_update", estimatedCostMicros: 5_000_001 }], estimate: { currency: "USD", maximumMicros: 5_000_001, sourceId: "release-topology-v1", observedAtMs: 1_000, freshUntilMs: 2_000 } },
    { maximumRunDurationMs: 59_500 }, { cleanupByMs: 1_401 }, { evidenceRetentionDays: 29 }, { artifactRetentionDays: 29 },
    { gcpEffects: { projectBootstrap: false, billing: true, apiEnablement: ["run.googleapis.com", "sqladmin.googleapis.com", "storage.googleapis.com"] } },
    { expiresAtMs: 1_499 },
  ];

  for (const mutation of mutations) {
    expect((await createAuthorizationRequest(input(mutation))).authorizationRequestSha256).not.toBe(base.authorizationRequestSha256);
  }
});
