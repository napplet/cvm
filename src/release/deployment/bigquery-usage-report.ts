import { z } from "zod";
import { BillingObservationGrantSchema, decimalUsdToMicros, reportOnlyGrantAllows, type BillingObservationGrant } from "../authoritative-usage-report";
import { googleAccountScopeSha256, type GoogleTokenSource } from "./google-auth";

export type BigQueryFetch = (url: string, init: RequestInit) => Promise<Response>;

const JobIdSchema = z.string().regex(/^[A-Za-z0-9_-]{1,1024}$/u);
const BytesSchema = z.string().regex(/^[0-9]{1,18}$/u);
const QueryResultSchema = z.object({ jobComplete: z.boolean().optional(), jobReference: z.object({ jobId: JobIdSchema, location: z.string().min(1).max(32) }).strict(), totalBytesProcessed: BytesSchema.optional(), rows: z.array(z.object({ f: z.array(z.object({ v: z.string() }).strict()) }).strict()).optional(), pageToken: z.string().min(1).max(1_024).optional() }).strict();

export type BigQueryUsageReportJournalRecord = Readonly<{ reportRequestSha256: string; dryRunJobId: string; queryJobId: string; state: "claimed" | "query_submitted" | "query_complete" }>;
export type BigQueryUsageReportJournal = Readonly<{
  claim(input: BigQueryUsageReportJournalRecord): Promise<Readonly<{ claimed: boolean; record: BigQueryUsageReportJournalRecord }>>;
  mark(input: Readonly<{ reportRequestSha256: string; expected: BigQueryUsageReportJournalRecord["state"]; state: BigQueryUsageReportJournalRecord["state"] }>): Promise<BigQueryUsageReportJournalRecord>;
}>;

export function createMemoryBigQueryUsageReportJournal(seed: readonly BigQueryUsageReportJournalRecord[] = []): BigQueryUsageReportJournal {
  const records = new Map(seed.map((record) => [record.reportRequestSha256, Object.freeze({ ...record })]));
  return Object.freeze({
    async claim(input) { const prior = records.get(input.reportRequestSha256); if (prior) return Object.freeze({ claimed: false, record: prior }); const record = Object.freeze({ ...input }); records.set(record.reportRequestSha256, record); return Object.freeze({ claimed: true, record }); },
    async mark(input) { const current = records.get(input.reportRequestSha256); if (!current || current.state !== input.expected) throw new Error("BIGQUERY_USAGE_REPORT_JOURNAL_CONFLICT"); const next = Object.freeze({ ...current, state: input.state }); records.set(next.reportRequestSha256, next); return next; },
  });
}

function jobId(prefix: string, digest: string): string { return `${prefix}_${digest.slice(0, 48)}`; }
function queryText(grant: BillingObservationGrant): string {
  const [project, dataset, table] = grant.detailedExportTable.split(".");
  return `SELECT CAST(SUM(cost) AS STRING) AS gross_cost, CAST(SUM(IFNULL((SELECT SUM(c.amount) FROM UNNEST(credits) c), 0)) AS STRING) AS credits FROM \`${project}.${dataset}.${table}\` WHERE project.id = @project_id AND resource.name = @resource_name AND usage_start_time >= TIMESTAMP_MILLIS(@interval_start_ms) AND usage_end_time <= TIMESTAMP_MILLIS(@interval_end_ms) AND EXISTS (SELECT 1 FROM UNNEST(labels) label WHERE label.key = 'napplet-cvm-operation' AND label.value = @operation_id)`;
}
function queryPayload(grant: BillingObservationGrant, id: string, dryRun: boolean): unknown {
  return { jobReference: { projectId: grant.projectId, location: grant.location, jobId: id }, configuration: { query: { query: queryText(grant), useLegacySql: false, parameterMode: "NAMED", dryRun, maximumBytesBilled: grant.maximumBytesBilled, queryParameters: [
    { name: "project_id", parameterType: { type: "STRING" }, parameterValue: { value: grant.projectId } },
    { name: "resource_name", parameterType: { type: "STRING" }, parameterValue: { value: grant.originalScope.resourceIdentitySha256 } },
    { name: "operation_id", parameterType: { type: "STRING" }, parameterValue: { value: grant.originalScope.operationId } },
    { name: "interval_start_ms", parameterType: { type: "INT64" }, parameterValue: { value: String(grant.originalScope.intervalStartMs) } },
    { name: "interval_end_ms", parameterType: { type: "INT64" }, parameterValue: { value: String(grant.originalScope.intervalEndMs) } },
  ] } } };
}
function queryCostMicros(bytes: string, grant: BillingObservationGrant): number {
  const cost = (BigInt(bytes) * BigInt(grant.reportQueryMicrosPerByteNumerator) + BigInt(grant.reportQueryMicrosPerByteDenominator) - 1n) / BigInt(grant.reportQueryMicrosPerByteDenominator);
  if (cost > BigInt(grant.reportQueryMaximumCostMicros)) throw new Error("BIGQUERY_USAGE_REPORT_QUERY_COST_EXCEEDED");
  return Number(cost);
}

/** Official BigQuery REST collector. It only submits deterministic reporting
 * jobs and recovers the original job; it never creates/updates release
 * resources and deliberately returns unknown coverage until a separately
 * configured provider finality policy exists. */
export function createBigQueryUsageReportCollector(input: Readonly<{ projectId: string; quotaProjectId: string; principal: string; tokenSource: GoogleTokenSource; journal: BigQueryUsageReportJournal; fetch?: BigQueryFetch; now?: () => number }>) {
  const projectId = z.string().regex(/^[a-z][a-z0-9-]{4,28}[a-z0-9]$/u).parse(input.projectId);
  const quotaProjectId = z.string().regex(/^[a-z][a-z0-9-]{4,28}[a-z0-9]$/u).parse(input.quotaProjectId);
  const principal = z.string().regex(/^[A-Za-z0-9@._:/-]{3,255}$/u).parse(input.principal);
  const fetcher = input.fetch ?? fetch;
  const now = input.now ?? Date.now;
  async function request(path: string, method: "GET" | "POST", payload?: unknown): Promise<unknown> {
    const token = await input.tokenSource.getAccessToken();
    const scope = await googleAccountScopeSha256({ projectId, quotaProjectId, principal, scopes: token.scopes });
    if (token.projectId !== projectId || token.quotaProjectId !== quotaProjectId || token.principal !== principal || token.accountScopeSha256 !== scope || token.expiresAtMs - 60_000 <= now()) throw new Error("BIGQUERY_USAGE_REPORT_ADC_SCOPE_INVALID");
    const response = await fetcher(`https://bigquery.googleapis.com${path}`, { method, redirect: "error", headers: { authorization: `Bearer ${token.token}`, "x-goog-user-project": quotaProjectId, accept: "application/json", ...(payload === undefined ? {} : { "content-type": "application/json" }) }, ...(payload === undefined ? {} : { body: JSON.stringify(payload) }) });
    if (!response.ok || !response.headers.get("content-type")?.includes("application/json")) throw new Error("BIGQUERY_USAGE_REPORT_TRANSPORT_UNAVAILABLE");
    const bytes = new Uint8Array(await response.arrayBuffer());
    if (bytes.byteLength === 0 || bytes.byteLength > 1_000_000) throw new Error("BIGQUERY_USAGE_REPORT_RESPONSE_INVALID");
    try { return JSON.parse(new TextDecoder().decode(bytes)); } catch { throw new Error("BIGQUERY_USAGE_REPORT_RESPONSE_INVALID"); }
  }
  return Object.freeze({
    async capture(grantInput: unknown) {
      const grant = BillingObservationGrantSchema.parse(grantInput);
      reportOnlyGrantAllows(grant, "observe_usage_report", now());
      if (grant.projectId !== projectId || grant.allowedReportOrigin !== "https://bigquery.googleapis.com") throw new Error("BIGQUERY_USAGE_REPORT_SCOPE_INVALID");
      const dryRunJobId = jobId("usage_dry", grant.reportRequestSha256);
      const queryJobId = jobId("usage", grant.reportRequestSha256);
      const claim = await input.journal.claim({ reportRequestSha256: grant.reportRequestSha256, dryRunJobId, queryJobId, state: "claimed" });
      if (claim.record.dryRunJobId !== dryRunJobId || claim.record.queryJobId !== queryJobId) throw new Error("BIGQUERY_USAGE_REPORT_JOURNAL_CONFLICT");
      if (claim.record.state === "query_complete") return Object.freeze({ status: "unknown" as const, providerJobId: queryJobId, reportRequestSha256: grant.reportRequestSha256 });
      if (claim.record.state === "claimed") {
        const dry = QueryResultSchema.parse(await request(`/bigquery/v2/projects/${projectId}/jobs`, "POST", queryPayload(grant, dryRunJobId, true)));
        const bytes = dry.totalBytesProcessed ?? "0";
        if (BigInt(bytes) > BigInt(grant.maximumBytesBilled)) throw new Error("BIGQUERY_USAGE_REPORT_BYTE_CAP_EXCEEDED");
        queryCostMicros(bytes, grant);
        await input.journal.mark({ reportRequestSha256: grant.reportRequestSha256, expected: "claimed", state: "query_submitted" });
        await request(`/bigquery/v2/projects/${projectId}/jobs`, "POST", queryPayload(grant, queryJobId, false));
      }
      const results = QueryResultSchema.parse(await request(`/bigquery/v2/projects/${projectId}/queries/${queryJobId}?location=${encodeURIComponent(grant.location)}`, "GET"));
      if (!results.jobComplete) return Object.freeze({ status: "unknown" as const, providerJobId: queryJobId, reportRequestSha256: grant.reportRequestSha256 });
      await input.journal.mark({ reportRequestSha256: grant.reportRequestSha256, expected: "query_submitted", state: "query_complete" });
      const row = results.rows?.[0]?.f;
      if (!row || results.pageToken) return Object.freeze({ status: "unknown" as const, providerJobId: queryJobId, reportRequestSha256: grant.reportRequestSha256 });
      const grossMeteredMicros = decimalUsdToMicros(row[0]!.v);
      const creditsMicros = decimalUsdToMicros(row[1]!.v);
      return Object.freeze({ status: "unknown" as const, providerJobId: queryJobId, reportRequestSha256: grant.reportRequestSha256, grossMeteredMicros, creditsMicros });
    },
  });
}
