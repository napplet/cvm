import { expect, test } from "bun:test";
import { createBigQueryUsageReportCollector, createMemoryBigQueryUsageReportJournal, type BigQueryUsageReportArtifactStore } from "../../src/release/deployment/bigquery-usage-report";
import { createBillingObservationGrant } from "../../src/release/authoritative-usage-report";
import { googleAccountScopeSha256, GOOGLE_CONTROL_PLANE_SCOPES } from "../../src/release/deployment/google-auth";

const digest = (letter: string) => letter.repeat(64);
const grant = () => createBillingObservationGrant({ version: 1, originalScope: { version: 1, provider: "cloud_run", operationId: "op-cloud-run-1", operationRecordSha256: digest("b"), authorizationRequestSha256: digest("c"), authorizationReceiptSha256: digest("d"), candidateSha256: digest("e"), googleOperationLabel: `g-${"a".repeat(52)}`, resourceName: "projects/project-12345/locations/us/services/release", resourceIdentitySha256: digest("f"), accountScopeSha256: digest("1"), projectScopeSha256: digest("2"), selectorSha256: digest("3"), intervalStartMs: 1, intervalEndMs: 2 }, allowedReportOrigin: "https://bigquery.googleapis.com", projectId: "project-12345", detailedExportTable: "project12345.billing_export.gcp_billing_export_resource_v1_ABC", location: "US", maximumBytesBilled: "1000000", reportQueryMaximumCostMicros: 10, reportQueryPriceSourceSha256: digest("6"), reportQueryMicrosPerByteNumerator: "1", reportQueryMicrosPerByteDenominator: "1000000", collectorSha256: digest("4"), expiresAtMs: 100 });

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
      const submitted = typeof init.body === "string" ? JSON.parse(init.body) : undefined;
      const queryJobId = /\/queries\/([^?]+)/u.exec(url)?.[1];
      const payload = url.includes("/queries/") ? { kind: "bigquery#getQueryResultsResponse", schema: { fields: [{ name: "gross_cost", type: "NUMERIC" }, { name: "credits", type: "NUMERIC" }] }, cacheHit: false, jobComplete: true, jobReference: { jobId: queryJobId, location: "US" }, totalBytesProcessed: "10", rows: [{ f: [{ v: "1.000000" }, { v: "-0.100000" }] }] } : { jobReference: { jobId: submitted?.jobReference?.jobId, location: submitted?.jobReference?.location }, statistics: { query: { totalBytesProcessed: "10" } } };
      return new Response(JSON.stringify(payload), { headers: { "content-type": "application/json" } });
    },
  });
  await expect(collector.capture(await grant())).resolves.toEqual(expect.objectContaining({ status: "unknown", grossMeteredMicros: 1_000_000, creditsMicros: -100_000 }));
  expect(calls).toHaveLength(3);
  expect(calls.slice(0, 2).every((call) => call.url.endsWith("/bigquery/v2/projects/project-12345/jobs"))).toBeTrue();
  expect(calls[2]!.url).toContain("/queries/usage_");
  expect(calls[0]!.body).toContain('"dryRun":true');
  expect(calls[1]!.body).toContain('"dryRun":false');
  const dryRun = JSON.parse(calls[0]!.body!);
  const actual = JSON.parse(calls[1]!.body!);
  expect(dryRun.configuration.dryRun).toBeTrue();
  expect(dryRun.configuration.query.dryRun).toBeUndefined();
  expect(actual.configuration.dryRun).toBeFalse();
  expect(actual.configuration.query.queryParameters.find((value: { name: string }) => value.name === "operation_id")?.parameterValue.value).toBe((await grant()).originalScope.googleOperationLabel);
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

test("a documented empty aggregate response stays unknown instead of becoming a zero cost", async () => {
  const accountScopeSha256 = await googleAccountScopeSha256({ projectId: "project-12345", quotaProjectId: "quota-project-1", principal: "release@example.com", scopes: GOOGLE_CONTROL_PLANE_SCOPES });
  const collector = createBigQueryUsageReportCollector({
    projectId: "project-12345", quotaProjectId: "quota-project-1", principal: "release@example.com", now: () => 10,
    tokenSource: { async getAccessToken() { return { token: "token", expiresAtMs: 70_001, projectId: "project-12345", quotaProjectId: "quota-project-1", principal: "release@example.com", scopes: GOOGLE_CONTROL_PLANE_SCOPES, accountScopeSha256 }; } },
    journal: createMemoryBigQueryUsageReportJournal(),
    fetch: async (url, init) => {
      const submitted = typeof init.body === "string" ? JSON.parse(init.body) : undefined;
      if (!url.includes("/queries/")) return new Response(JSON.stringify({ jobReference: submitted.jobReference, statistics: { query: { totalBytesProcessed: "10" } } }), { headers: { "content-type": "application/json" } });
      const jobId = /\/queries\/([^?]+)/u.exec(url)?.[1];
      return new Response(JSON.stringify({ kind: "bigquery#getQueryResultsResponse", schema: { fields: [] }, cacheHit: false, jobComplete: true, jobReference: { jobId, location: "US" }, totalBytesProcessed: "10", rows: [{ f: [{ v: null }, { v: null }] }] }), { headers: { "content-type": "application/json" } });
    },
  });
  const result = await collector.capture(await grant());
  expect(result).toEqual(expect.objectContaining({ status: "unknown" }));
});

test("recovery without a durable report job performs no token request or POST", async () => {
  let tokens = 0;
  let requests = 0;
  const collector = createBigQueryUsageReportCollector({
    projectId: "project-12345", quotaProjectId: "quota-project-1", principal: "release@example.com", now: () => 10,
    tokenSource: { async getAccessToken() { tokens += 1; throw new Error("TOKEN_MUST_NOT_BE_REQUESTED"); } },
    journal: createMemoryBigQueryUsageReportJournal(),
    fetch: async () => { requests += 1; throw new Error("HTTP_MUST_NOT_BE_REQUESTED"); },
  });
  await expect(collector.recover(await grant())).resolves.toEqual(expect.objectContaining({ status: "unknown" }));
  expect(tokens).toBe(0);
  expect(requests).toBe(0);
});

test("GET-only recovery captures the original completed job and reuses its immutable bytes after restart", async () => {
  const value = await grant();
  const queryJobId = `usage_${value.reportRequestSha256.slice(0, 48)}`;
  const journal = createMemoryBigQueryUsageReportJournal([{
    reportRequestSha256: value.reportRequestSha256, dryRunJobId: `usage_dry_${value.reportRequestSha256.slice(0, 48)}`,
    queryJobId, state: "query_dispatch_intent", dryRunBytes: "10",
  }]);
  const store = artifacts();
  const calls: string[] = [];
  const accountScopeSha256 = await googleAccountScopeSha256({ projectId: "project-12345", quotaProjectId: "quota-project-1", principal: "release@example.com" });
  const raw = JSON.stringify({
    kind: "bigquery#getQueryResultsResponse", jobComplete: true,
    jobReference: { projectId: "project-12345", jobId: queryJobId, location: "US" },
    schema: { fields: [{ name: "gross_cost", type: "STRING" }, { name: "credits", type: "STRING" }] },
    totalRows: "1", totalBytesProcessed: "10", cacheHit: false,
    rows: [{ f: [{ v: "1.000000" }, { v: "-0.100000" }] }],
  });
  const options = {
    projectId: "project-12345", quotaProjectId: "quota-project-1", principal: "release@example.com", journal, artifacts: store, now: () => 10,
    tokenSource: { async getAccessToken() { return { token: "token", expiresAtMs: 70_001, projectId: "project-12345", quotaProjectId: "quota-project-1", principal: "release@example.com", scopes: GOOGLE_CONTROL_PLANE_SCOPES, accountScopeSha256 }; } },
    fetch: async (url: string, init: RequestInit) => {
      calls.push(init.method ?? "GET");
      expect(url).toContain(`/queries/${queryJobId}`);
      return new Response(raw, { headers: { "content-type": "application/json" } });
    },
  };
  const result = await createBigQueryUsageReportCollector(options).recover(value);
  expect(result.envelope).toBeDefined();
  expect(result.envelope?.providerJobId).toBe(queryJobId);
  expect(result.envelope?.coverage).toBe("unknown");
  if (!result.envelope) throw new Error("RECOVERY_CAPTURE_REQUIRED");
  expect(await store.readExact(result.envelope.rawArtifact)).toEqual(new TextEncoder().encode(raw));
  expect(await createBigQueryUsageReportCollector({ ...options, now: () => 20 }).recover(value)).toEqual(result);
  expect(calls).toEqual(["GET"]);
});

test("concurrent recovery clocks converge on one persisted capture without submitting a query", async () => {
  const value = await grant();
  const queryJobId = `usage_${value.reportRequestSha256.slice(0, 48)}`;
  const journal = createMemoryBigQueryUsageReportJournal([{
    reportRequestSha256: value.reportRequestSha256, dryRunJobId: `usage_dry_${value.reportRequestSha256.slice(0, 48)}`,
    queryJobId, state: "query_submitted", dryRunBytes: "10",
  }]);
  const store = artifacts();
  const accountScopeSha256 = await googleAccountScopeSha256({ projectId: "project-12345", quotaProjectId: "quota-project-1", principal: "release@example.com" });
  let clock = 10;
  const calls: string[] = [];
  const options = {
    projectId: "project-12345", quotaProjectId: "quota-project-1", principal: "release@example.com", journal, artifacts: store, now: () => clock++,
    tokenSource: { async getAccessToken() { return { token: "token", expiresAtMs: 70_001, projectId: "project-12345", quotaProjectId: "quota-project-1", principal: "release@example.com", scopes: GOOGLE_CONTROL_PLANE_SCOPES, accountScopeSha256 }; } },
    fetch: async (_url: string, init: RequestInit) => {
      calls.push(init.method ?? "GET");
      return new Response(JSON.stringify({ jobComplete: true, jobReference: { jobId: queryJobId, location: "US" }, totalBytesProcessed: "10", rows: [{ f: [{ v: "1.000000" }, { v: "0.000000" }] }] }), { headers: { "content-type": "application/json" } });
    },
  };
  const [first, second] = await Promise.all([createBigQueryUsageReportCollector(options).recover(value), createBigQueryUsageReportCollector(options).recover(value)]);
  expect(first.envelope).toBeDefined();
  expect(first).toEqual(second);
  expect(calls).toEqual(["GET", "GET"]);
  expect(await createBigQueryUsageReportCollector(options).recover(value)).toEqual(first);
  expect(calls).toHaveLength(2);
});

test("a report journal without original query dispatch intent cannot acquire ADC or read a nonexistent job", async () => {
  const value = await grant();
  for (const state of ["claimed", "dry_run_dispatch_intent", "dry_run_complete"] as const) {
    const journal = createMemoryBigQueryUsageReportJournal([{
      reportRequestSha256: value.reportRequestSha256, dryRunJobId: `usage_dry_${value.reportRequestSha256.slice(0, 48)}`,
      queryJobId: `usage_${value.reportRequestSha256.slice(0, 48)}`, state,
    }]);
    let effects = 0;
    const collector = createBigQueryUsageReportCollector({ projectId: "project-12345", quotaProjectId: "quota-project-1", principal: "release@example.com", now: () => 10, journal,
      tokenSource: { async getAccessToken() { effects++; throw new Error("UNEXPECTED_ADC"); } },
      fetch: async () => { effects++; throw new Error("UNEXPECTED_HTTP"); },
    });
    expect((await collector.recover(value)).envelope).toBeUndefined();
    expect(effects).toBe(0);
  }
});

test("report authority expiring during ADC cannot submit a query", async () => {
  const value = await grant();
  let clock = 10;
  let posts = 0;
  const accountScopeSha256 = await googleAccountScopeSha256({ projectId: "project-12345", quotaProjectId: "quota-project-1", principal: "release@example.com" });
  const collector = createBigQueryUsageReportCollector({ projectId: "project-12345", quotaProjectId: "quota-project-1", principal: "release@example.com", now: () => clock, journal: createMemoryBigQueryUsageReportJournal(),
    tokenSource: { async getAccessToken() { clock = value.expiresAtMs; return { token: "token", expiresAtMs: 70_001, projectId: "project-12345", quotaProjectId: "quota-project-1", principal: "release@example.com", scopes: GOOGLE_CONTROL_PLANE_SCOPES, accountScopeSha256 }; } },
    fetch: async () => { posts++; throw new Error("EXPIRED_AUTHORITY_REACHED_HTTP"); },
  });
  await expect(collector.capture(value)).rejects.toThrow("BILLING_OBSERVATION_GRANT_DENIED");
  expect(posts).toBe(0);
});

test("a report response is stopped at its byte ceiling rather than buffered without bounds", async () => {
  const value = await grant();
  const queryJobId = `usage_${value.reportRequestSha256.slice(0, 48)}`;
  let pulls = 0;
  let canceled = false;
  const accountScopeSha256 = await googleAccountScopeSha256({ projectId: "project-12345", quotaProjectId: "quota-project-1", principal: "release@example.com" });
  const collector = createBigQueryUsageReportCollector({ projectId: "project-12345", quotaProjectId: "quota-project-1", principal: "release@example.com", now: () => 10,
    journal: createMemoryBigQueryUsageReportJournal([{ reportRequestSha256: value.reportRequestSha256, dryRunJobId: `usage_dry_${value.reportRequestSha256.slice(0, 48)}`, queryJobId, state: "query_submitted" }]),
    tokenSource: { async getAccessToken() { return { token: "token", expiresAtMs: 70_001, projectId: "project-12345", quotaProjectId: "quota-project-1", principal: "release@example.com", scopes: GOOGLE_CONTROL_PLANE_SCOPES, accountScopeSha256 }; } },
    fetch: async () => new Response(new ReadableStream<Uint8Array>({
      pull(controller) { pulls++; if (pulls > 3) controller.close(); else controller.enqueue(new Uint8Array(600_000)); },
      cancel() { canceled = true; },
    }, { highWaterMark: 0 }), { headers: { "content-type": "application/json" } }),
  });
  await expect(collector.recover(value)).rejects.toThrow("BIGQUERY_USAGE_REPORT_RESPONSE_INVALID");
  expect(canceled).toBeTrue();
  expect(pulls).toBe(2);
});

test("a stalled response body times out and cancels its stream without redispatch", async () => {
  const value = await grant();
  const queryJobId = `usage_${value.reportRequestSha256.slice(0, 48)}`;
  let canceled = false;
  let requests = 0;
  const accountScopeSha256 = await googleAccountScopeSha256({ projectId: "project-12345", quotaProjectId: "quota-project-1", principal: "release@example.com" });
  const collector = createBigQueryUsageReportCollector({ projectId: "project-12345", quotaProjectId: "quota-project-1", principal: "release@example.com", now: () => 10,
    journal: createMemoryBigQueryUsageReportJournal([{ reportRequestSha256: value.reportRequestSha256, dryRunJobId: `usage_dry_${value.reportRequestSha256.slice(0, 48)}`, queryJobId, state: "query_submitted" }]),
    tokenSource: { async getAccessToken() { return { token: "token", expiresAtMs: 70_001, projectId: "project-12345", quotaProjectId: "quota-project-1", principal: "release@example.com", scopes: GOOGLE_CONTROL_PLANE_SCOPES, accountScopeSha256 }; } },
    fetch: async (_url, init) => {
      requests++;
      expect(init.method).toBe("GET");
      return new Response(new ReadableStream<Uint8Array>({ cancel() { canceled = true; } }), { headers: { "content-type": "application/json" } });
    },
  });
  await expect(collector.recover(value)).rejects.toThrow("BIGQUERY_USAGE_REPORT_TIMEOUT");
  expect(canceled).toBeTrue();
  expect(requests).toBe(1);
}, 10_000);

test("report authority expiring while consuming results prevents artifact writes", async () => {
  const value = await grant();
  const queryJobId = `usage_${value.reportRequestSha256.slice(0, 48)}`;
  let clock = 10;
  let writes = 0;
  const accountScopeSha256 = await googleAccountScopeSha256({ projectId: "project-12345", quotaProjectId: "quota-project-1", principal: "release@example.com" });
  const collector = createBigQueryUsageReportCollector({ projectId: "project-12345", quotaProjectId: "quota-project-1", principal: "release@example.com", now: () => clock,
    journal: createMemoryBigQueryUsageReportJournal([{ reportRequestSha256: value.reportRequestSha256, dryRunJobId: `usage_dry_${value.reportRequestSha256.slice(0, 48)}`, queryJobId, state: "query_submitted" }]),
    artifacts: { async createImmutable() { writes++; throw new Error("EXPIRED_AUTHORITY_REACHED_ARTIFACTS"); }, async readExact() { return undefined; } },
    tokenSource: { async getAccessToken() { return { token: "token", expiresAtMs: 70_001, projectId: "project-12345", quotaProjectId: "quota-project-1", principal: "release@example.com", scopes: GOOGLE_CONTROL_PLANE_SCOPES, accountScopeSha256 }; } },
    fetch: async () => new Response(new ReadableStream<Uint8Array>({ pull(controller) {
      clock = value.expiresAtMs;
      controller.enqueue(new TextEncoder().encode(JSON.stringify({ jobComplete: true, jobReference: { jobId: queryJobId, location: "US" }, totalBytesProcessed: "10", rows: [{ f: [{ v: "1.000000" }, { v: "0.000000" }] }] })));
      controller.close();
    } }, { highWaterMark: 0 }), { headers: { "content-type": "application/json" } }),
  });
  await expect(collector.recover(value)).rejects.toThrow("BILLING_OBSERVATION_GRANT_DENIED");
  expect(writes).toBe(0);
});
