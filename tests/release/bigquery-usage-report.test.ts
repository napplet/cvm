import { expect, test } from "bun:test";
import { createBigQueryUsageReportCollector, createMemoryBigQueryUsageReportJournal } from "../../src/release/deployment/bigquery-usage-report";
import { BillingObservationGrantSchema } from "../../src/release/authoritative-usage-report";
import { googleAccountScopeSha256, GOOGLE_CONTROL_PLANE_SCOPES } from "../../src/release/deployment/google-auth";

const digest = (letter: string) => letter.repeat(64);
const grant = BillingObservationGrantSchema.parse({ version: 1, grantSha256: digest("a"), originalScope: { version: 1, provider: "cloud_run", operationId: "op-cloud-run-1", operationRecordSha256: digest("b"), authorizationRequestSha256: digest("c"), authorizationReceiptSha256: digest("d"), candidateSha256: digest("e"), resourceIdentitySha256: digest("f"), accountScopeSha256: digest("1"), projectScopeSha256: digest("2"), selectorSha256: digest("3"), intervalStartMs: 1, intervalEndMs: 2 }, allowedReportOrigin: "https://bigquery.googleapis.com", projectId: "project-12345", detailedExportTable: "project12345.billing_export.gcp_billing_export_resource_v1_ABC", location: "US", maximumBytesBilled: "1000000", reportQueryMaximumCostMicros: 10, reportQueryPriceSourceSha256: digest("6"), reportQueryMicrosPerByteNumerator: "1", reportQueryMicrosPerByteDenominator: "1000000", collectorSha256: digest("4"), reportRequestSha256: digest("5"), expiresAtMs: 100 });

test("BigQuery reporting uses deterministic jobs.insert ids and only recovers the original query", async () => {
  const calls: Array<Readonly<{ url: string; body: string | undefined }>> = [];
  const accountScopeSha256 = await googleAccountScopeSha256({ projectId: "project-12345", quotaProjectId: "quota-project-1", principal: "release@example.com", scopes: GOOGLE_CONTROL_PLANE_SCOPES });
  const collector = createBigQueryUsageReportCollector({
    projectId: "project-12345", quotaProjectId: "quota-project-1", principal: "release@example.com", now: () => 10,
    tokenSource: { async getAccessToken() { return { token: "token", expiresAtMs: 70_001, projectId: "project-12345", quotaProjectId: "quota-project-1", principal: "release@example.com", scopes: GOOGLE_CONTROL_PLANE_SCOPES, accountScopeSha256 }; } },
    journal: createMemoryBigQueryUsageReportJournal(),
    fetch: async (url, init) => {
      calls.push({ url, body: typeof init.body === "string" ? init.body : undefined });
      const payload = url.includes("/queries/") ? { jobComplete: true, jobReference: { jobId: "usage_555555555555555555555555555555555555555555555555", location: "US" }, rows: [{ f: [{ v: "1.000000" }, { v: "-0.100000" }] }] } : { jobComplete: true, jobReference: { jobId: "job", location: "US" }, totalBytesProcessed: "10" };
      return new Response(JSON.stringify(payload), { headers: { "content-type": "application/json" } });
    },
  });
  await expect(collector.capture(grant)).resolves.toEqual(expect.objectContaining({ status: "unknown", grossMeteredMicros: 1_000_000, creditsMicros: -100_000 }));
  expect(calls).toHaveLength(3);
  expect(calls.slice(0, 2).every((call) => call.url.endsWith("/bigquery/v2/projects/project-12345/jobs"))).toBeTrue();
  expect(calls[2]!.url).toContain("/queries/usage_");
  expect(calls[0]!.body).toContain('"dryRun":true');
  expect(calls[1]!.body).toContain('"dryRun":false');
});
