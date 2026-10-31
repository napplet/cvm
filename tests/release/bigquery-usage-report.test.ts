import { expect, test } from "bun:test";
import { createBigQueryUsageReportCollector, createMemoryBigQueryUsageReportJournal, type BigQueryUsageReportArtifactStore } from "../../src/release/deployment/bigquery-usage-report";
import { createBillingObservationGrant } from "../../src/release/authoritative-usage-report";
import { googleAccountScopeSha256, GOOGLE_CONTROL_PLANE_SCOPES } from "../../src/release/deployment/google-auth";

const digest = (letter: string) => letter.repeat(64);
const grant = () => createBillingObservationGrant({ version: 1, originalScope: { version: 1, provider: "cloud_run", operationId: "op-cloud-run-1", operationRecordSha256: digest("b"), authorizationRequestSha256: digest("c"), authorizationReceiptSha256: digest("d"), candidateSha256: digest("e"), resourceName: "projects/project-12345/locations/us/services/release", resourceIdentitySha256: digest("f"), accountScopeSha256: digest("1"), projectScopeSha256: digest("2"), selectorSha256: digest("3"), intervalStartMs: 1, intervalEndMs: 2 }, allowedReportOrigin: "https://bigquery.googleapis.com", projectId: "project-12345", detailedExportTable: "project12345.billing_export.gcp_billing_export_resource_v1_ABC", location: "US", maximumBytesBilled: "1000000", reportQueryMaximumCostMicros: 10, reportQueryPriceSourceSha256: digest("6"), reportQueryMicrosPerByteNumerator: "1", reportQueryMicrosPerByteDenominator: "1000000", collectorSha256: digest("4"), expiresAtMs: 100 });

function artifacts(): BigQueryUsageReportArtifactStore {
  const values = new Map<string, Uint8Array>();
  return {
    async createImmutable(input) { values.set(`${input.key}:${input.sha256}`, input.bytes); return { uri: `gs://billing-test/${input.key}`, generation: "1", sha256: input.sha256 }; },
    async readExact(input) { return values.get(`${input.uri.slice("gs://billing-test/".length)}:${input.sha256}`); },
  };
}

test("BigQuery reporting uses deterministic jobs.insert ids and only recovers the original query", async () => {
  const calls: Array<Readonly<{ url: string; body: string | undefined }>> = [];
  const accountScopeSha256 = await googleAccountScopeSha256({ projectId: "project-12345", quotaProjectId: "quota-project-1", principal: "release@example.com", scopes: GOOGLE_CONTROL_PLANE_SCOPES });
  const collector = createBigQueryUsageReportCollector({
    projectId: "project-12345", quotaProjectId: "quota-project-1", principal: "release@example.com", now: () => 10,
    tokenSource: { async getAccessToken() { return { token: "token", expiresAtMs: 70_001, projectId: "project-12345", quotaProjectId: "quota-project-1", principal: "release@example.com", scopes: GOOGLE_CONTROL_PLANE_SCOPES, accountScopeSha256 }; } },
    journal: createMemoryBigQueryUsageReportJournal(), artifacts: artifacts(),
    fetch: async (url, init) => {
      calls.push({ url, body: typeof init.body === "string" ? init.body : undefined });
      const payload = url.includes("/queries/") ? { jobComplete: true, jobReference: { jobId: "usage_555555555555555555555555555555555555555555555555", location: "US" }, rows: [{ f: [{ v: "1.000000" }, { v: "-0.100000" }] }] } : { jobComplete: true, jobReference: { jobId: "job", location: "US" }, totalBytesProcessed: "10" };
      return new Response(JSON.stringify(payload), { headers: { "content-type": "application/json" } });
    },
  });
  await expect(collector.capture(await grant())).resolves.toEqual(expect.objectContaining({ status: "unknown", grossMeteredMicros: 1_000_000, creditsMicros: -100_000 }));
  expect(calls).toHaveLength(3);
  expect(calls.slice(0, 2).every((call) => call.url.endsWith("/bigquery/v2/projects/project-12345/jobs"))).toBeTrue();
  expect(calls[2]!.url).toContain("/queries/usage_");
  expect(calls[0]!.body).toContain('"dryRun":true');
  expect(calls[1]!.body).toContain('"dryRun":false');
});

test("a lost jobs.insert acknowledgement observes the deterministic original job without redispatch", async () => {
  const journal = createMemoryBigQueryUsageReportJournal();
  const value = await grant();
  await journal.claim({ reportRequestSha256: value.reportRequestSha256, dryRunJobId: `usage_dry_${value.reportRequestSha256.slice(0, 48)}`, queryJobId: `usage_${value.reportRequestSha256.slice(0, 48)}`, state: "query_dispatch_intent", dryRunBytes: "1" });
  const calls: Array<Readonly<{ url: string; method: string }>> = [];
  const accountScopeSha256 = await googleAccountScopeSha256({ projectId: "project-12345", quotaProjectId: "quota-project-1", principal: "release@example.com", scopes: GOOGLE_CONTROL_PLANE_SCOPES });
  const collector = createBigQueryUsageReportCollector({ projectId: "project-12345", quotaProjectId: "quota-project-1", principal: "release@example.com", now: () => 10, journal, tokenSource: { async getAccessToken() { return { token: "token", expiresAtMs: 70_001, projectId: "project-12345", quotaProjectId: "quota-project-1", principal: "release@example.com", scopes: GOOGLE_CONTROL_PLANE_SCOPES, accountScopeSha256 }; } }, fetch: async (url, init) => { calls.push({ url, method: init.method ?? "GET" }); return new Response(JSON.stringify({ jobComplete: false, jobReference: { jobId: `usage_${value.reportRequestSha256.slice(0, 48)}`, location: "US" } }), { headers: { "content-type": "application/json" } }); } });
  await expect(collector.capture(value)).resolves.toEqual(expect.objectContaining({ status: "unknown", providerJobId: expect.stringContaining("usage_") }));
  expect(calls).toEqual([{ url: expect.stringContaining(`/queries/usage_${value.reportRequestSha256.slice(0, 48)}`), method: "GET" }]);
});
