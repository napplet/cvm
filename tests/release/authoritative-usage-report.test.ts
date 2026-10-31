import { expect, test } from "bun:test";
import { BillingObservationGrantSchema, decimalUsdToMicros, reportOnlyGrantAllows } from "../../src/release/authoritative-usage-report";

const digest = (letter: string) => letter.repeat(64);
const grant = BillingObservationGrantSchema.parse({
  version: 1, grantSha256: digest("a"),
  originalScope: { version: 1, provider: "cloud_run", operationId: "op-cloud-run-1", operationRecordSha256: digest("b"), authorizationRequestSha256: digest("c"), authorizationReceiptSha256: digest("d"), candidateSha256: digest("e"), resourceIdentitySha256: digest("f"), accountScopeSha256: digest("1"), projectScopeSha256: digest("2"), selectorSha256: digest("3"), intervalStartMs: 1, intervalEndMs: 2 },
  allowedReportOrigin: "https://bigquery.googleapis.com", projectId: "project-12345", detailedExportTable: "project12345.billing_export.gcp_billing_export_resource_v1_ABC", location: "US", maximumBytesBilled: "1000000", reportQueryMaximumCostMicros: 10, reportQueryPriceSourceSha256: digest("6"), reportQueryMicrosPerByteNumerator: "1", reportQueryMicrosPerByteDenominator: "1000000", collectorSha256: digest("4"), reportRequestSha256: digest("5"), expiresAtMs: 10,
});

test("report-only grants bind one original scope and never authorize resource mutations", () => {
  expect(() => reportOnlyGrantAllows(grant, "observe_usage_report", 10)).not.toThrow();
  for (const action of ["plan", "apply", "cleanup"] as const) expect(() => reportOnlyGrantAllows(grant, action, 1)).toThrow("BILLING_OBSERVATION_GRANT_DENIED");
  expect(() => reportOnlyGrantAllows(grant, "observe_usage_report", 11)).toThrow("BILLING_OBSERVATION_GRANT_DENIED");
});

test("authoritative USD decimal conversion rejects non-micro and unsafe values", () => {
  expect(decimalUsdToMicros("12.340001")).toBe(12_340_001);
  expect(decimalUsdToMicros("-0.000001")).toBe(-1);
  expect(() => decimalUsdToMicros("0.0000001")).toThrow("AUTHORITATIVE_USAGE_DECIMAL_PRECISION_UNSUPPORTED");
  expect(() => decimalUsdToMicros("9007199254.740992")).toThrow("AUTHORITATIVE_USAGE_DECIMAL_RANGE_INVALID");
});
