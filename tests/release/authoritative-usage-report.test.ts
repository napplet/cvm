import { expect, test } from "bun:test";
import { createAuthoritativeUsageReportEnvelope, createBillingObservationGrant, decimalUsdToMicros, reportOnlyGrantAllows, verifyAuthoritativeUsageReportArtifact, verifyBillingObservationGrant } from "../../src/release/authoritative-usage-report";

const digest = (letter: string) => letter.repeat(64);
const grantInput = {
  version: 1 as const,
  originalScope: { version: 1 as const, provider: "cloud_run" as const, operationId: "op-cloud-run-1", operationRecordSha256: digest("b"), authorizationRequestSha256: digest("c"), authorizationReceiptSha256: digest("d"), candidateSha256: digest("e"), googleOperationLabel: `g-${"a".repeat(52)}`, resourceName: "projects/project-12345/locations/us/services/release", resourceIdentitySha256: digest("f"), accountScopeSha256: digest("1"), projectScopeSha256: digest("2"), selectorSha256: digest("3"), intervalStartMs: 1, intervalEndMs: 2 },
  allowedReportOrigin: "https://bigquery.googleapis.com" as const, projectId: "project-12345", detailedExportTable: "project12345.billing_export.gcp_billing_export_resource_v1_ABC", location: "US", maximumBytesBilled: "1000000", reportQueryMaximumCostMicros: 10, reportQueryPriceSourceSha256: digest("6"), reportQueryMicrosPerByteNumerator: "1", reportQueryMicrosPerByteDenominator: "1000000", collectorSha256: digest("4"), expiresAtMs: 10,
};

test("report-only grants bind one original scope and never authorize resource mutations", async () => {
  const grant = await createBillingObservationGrant(grantInput);
  expect(() => reportOnlyGrantAllows(grant, "observe_usage_report", 9)).not.toThrow();
  for (const action of ["plan", "apply", "cleanup"] as const) expect(() => reportOnlyGrantAllows(grant, action, 1)).toThrow("BILLING_OBSERVATION_GRANT_DENIED");
  expect(() => reportOnlyGrantAllows(grant, "observe_usage_report", 10)).toThrow("BILLING_OBSERVATION_GRANT_DENIED");
});

test("caller-forged grant digests are rejected before report transport", async () => {
  const grant = await createBillingObservationGrant(grantInput);
  await expect(verifyBillingObservationGrant({ ...grant, reportRequestSha256: digest("0") })).rejects.toThrow("BILLING_OBSERVATION_GRANT_INVALID");
});

test("captured report bytes must still match the immutable artifact digest", async () => {
  const bytes = new TextEncoder().encode('{"report":"original"}');
  const sha256 = new Bun.CryptoHasher("sha256").update(bytes).digest("hex");
  const envelope = await createAuthoritativeUsageReportEnvelope({ version: 1, grantSha256: digest("a"), reportRequestSha256: digest("b"), providerJobId: "usage_original", rawArtifact: { uri: "gs://billing-test/reports/original.json", generation: "1", sha256 }, coverage: "unknown", currency: "USD", grossMeteredMicros: null, creditsMicros: null, adjustmentsMicros: null, netInvoiceMicros: null, observedAtMs: 1, rawReportBytes: bytes });
  await expect(verifyAuthoritativeUsageReportArtifact(envelope, bytes)).resolves.toEqual(envelope);
  await expect(verifyAuthoritativeUsageReportArtifact(envelope, new TextEncoder().encode('{"report":"forged"}'))).rejects.toThrow("AUTHORITATIVE_USAGE_ARTIFACT_INVALID");
});

test("authoritative USD decimal conversion rejects non-micro and unsafe values", () => {
  expect(decimalUsdToMicros("12.340001")).toBe(12_340_001);
  expect(decimalUsdToMicros("-0.000001")).toBe(-1);
  expect(() => decimalUsdToMicros("0.0000001")).toThrow("AUTHORITATIVE_USAGE_DECIMAL_PRECISION_UNSUPPORTED");
  expect(() => decimalUsdToMicros("9007199254.740992")).toThrow("AUTHORITATIVE_USAGE_DECIMAL_RANGE_INVALID");
});
