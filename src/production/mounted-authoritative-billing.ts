import { createHash } from "node:crypto";
import { z } from "zod";
import { canonicalJson } from "../promotion/schema";
import { createBillingObservationGrant } from "../release/authoritative-usage-report";
import { createBigQueryUsageReportCollector, type BigQueryUsageReportArtifactStore } from "../release/deployment/bigquery-usage-report";
import type { GoogleOperationJournal } from "../release/deployment/google-clients";
import { createPostgresBigQueryUsageReportJournal } from "../release/deployment/postgres-provider-journals";
import type { PostgresOperationJournal } from "../release/deployment/postgres-operation-journal";
import type { GoogleTokenSource } from "../release/deployment/google-auth";
import type { ObjectStorePort } from "../continuity/object-store";
import type { PostgresSqlPool } from "../persistence/postgres-sql-funding-store";

const Digest = z.string().regex(/^[a-f0-9]{64}$/iu).transform(value => value.toLowerCase());
const ProjectId = z.string().regex(/^[a-z][a-z0-9-]{4,28}[a-z0-9]$/u);
const ResourceName = z.string().regex(/^projects\/[a-z][a-z0-9-]{4,28}[a-z0-9]\/(?:locations\/[A-Za-z0-9_-]{2,63}\/(?:services|instances)\/[A-Za-z0-9._-]{1,255}|instances\/[A-Za-z0-9._-]{1,255})$/u);

/** These are preapproval facts in the sealed mounted record.  The schema has
 * no endpoint, credential, arbitrary query, finality flag, or report amount:
 * transport and SQL remain project-owned below. */
export const MountedBigQueryUsageReportConfigurationSchema = z.object({
  version: z.literal(1),
  detailedExportTable: z.string().regex(/^[a-z][a-z0-9-]{4,28}[a-z0-9]\.[A-Za-z_][A-Za-z0-9_]{0,1023}\.[A-Za-z_][A-Za-z0-9_]{0,1023}$/u),
  location: z.string().regex(/^[A-Za-z0-9_-]{2,32}$/u),
  maximumBytesBilled: z.string().regex(/^[1-9][0-9]{0,18}$/u),
  reportQueryMaximumCostMicros: z.number().int().safe().nonnegative(),
  reportQueryPriceSourceSha256: Digest,
  reportQueryMicrosPerByteNumerator: z.string().regex(/^[1-9][0-9]{0,18}$/u),
  reportQueryMicrosPerByteDenominator: z.string().regex(/^[1-9][0-9]{0,18}$/u),
  collectorSha256: Digest,
  maximumIntervalMs: z.number().int().min(1).max(90 * 24 * 60 * 60 * 1000),
  grantTtlMs: z.number().int().min(1_000).max(60 * 60 * 1000),
}).strict();
export type MountedBigQueryUsageReportConfiguration = z.infer<typeof MountedBigQueryUsageReportConfigurationSchema>;

type CaptureInput = Readonly<{
  operation: Readonly<{ provider: string; operationId: string }>;
  operationRecordSha256: string;
  resourceIdentitySha256: string;
  candidateSha256: string;
  authorizationRequestSha256: string;
  authorizationReceiptSha256: string;
  accountScopeSha256: string;
  projectScopeSha256: string;
}>;

function digest(value: unknown): string { return createHash("sha256").update(canonicalJson(value)).digest("hex"); }
function googleOperationId(operationId: string): string { return `g-${digest(operationId).slice(0, 52)}`; }
function parseCreatedAt(value: string | undefined): number | undefined {
  if (!value) return undefined;
  const parsed = Date.parse(value);
  return Number.isSafeInteger(parsed) && parsed > 0 ? parsed : undefined;
}

function artifacts(input: Readonly<{ bucket: string; objects: ObjectStorePort }>): BigQueryUsageReportArtifactStore {
  const bucket = z.string().regex(/^[a-z0-9][a-z0-9._-]{1,220}[a-z0-9]$/u).parse(input.bucket);
  const prefix = `gs://${bucket}/`;
  return Object.freeze({
    async createImmutable(value) {
      const created = await input.objects.createImmutable({ key: value.key, bytes: new Uint8Array(value.bytes) });
      if (created.checksum !== value.sha256) throw new Error("MOUNTED_BIGQUERY_ARTIFACT_DIGEST_INVALID");
      return Object.freeze({ uri: `${prefix}${created.key}`, generation: String(created.generation), sha256: created.checksum });
    },
    async readExact(value) {
      if (!value.uri.startsWith(prefix) || !/^[1-9][0-9]{0,18}$/u.test(value.generation)) return undefined;
      const generation = Number(value.generation);
      if (!Number.isSafeInteger(generation)) return undefined;
      return input.objects.readExact({ key: value.uri.slice(prefix.length), generation, checksum: value.sha256 });
    },
  });
}

async function persistCapture(input: Readonly<{ pool: PostgresSqlPool; grant: Awaited<ReturnType<typeof createBillingObservationGrant>>; envelope: unknown }>): Promise<void> {
  const envelope = z.object({ providerJobId: z.string(), rawArtifact: z.object({ uri: z.string(), generation: z.string(), sha256: Digest }).strict(), rawReportSha256: Digest }).passthrough().parse(input.envelope);
  const generation = Number(envelope.rawArtifact.generation);
  if (!Number.isSafeInteger(generation) || generation < 1) throw new Error("MOUNTED_BIGQUERY_CAPTURE_INVALID");
  const client = await input.pool.connect();
  try {
    await client.query("BEGIN ISOLATION LEVEL SERIALIZABLE");
    await client.query("SET LOCAL lock_timeout = '1s'");
    await client.query("SET LOCAL statement_timeout = '5s'");
    const inserted = await client.query("INSERT INTO production_real.authoritative_usage_report_capture(report_request_sha256,grant_sha256,operation_record_sha256,provider_job_id,artifact_uri,artifact_generation,raw_report_sha256,envelope_json) VALUES($1,$2,$3,$4,$5,$6,$7,$8::jsonb) ON CONFLICT DO NOTHING RETURNING report_request_sha256", [input.grant.reportRequestSha256, input.grant.grantSha256, input.grant.originalScope.operationRecordSha256, envelope.providerJobId, envelope.rawArtifact.uri, generation, envelope.rawReportSha256, canonicalJson(envelope)]);
    if (!inserted.rows.length) {
      const existing = (await client.query<Record<string, unknown>>("SELECT grant_sha256,operation_record_sha256,provider_job_id,artifact_uri,artifact_generation,raw_report_sha256,envelope_json FROM production_real.authoritative_usage_report_capture WHERE report_request_sha256=$1", [input.grant.reportRequestSha256])).rows[0];
      if (!existing || existing.grant_sha256 !== input.grant.grantSha256 || existing.operation_record_sha256 !== input.grant.originalScope.operationRecordSha256 || existing.provider_job_id !== envelope.providerJobId || existing.artifact_uri !== envelope.rawArtifact.uri || Number(existing.artifact_generation) !== generation || existing.raw_report_sha256 !== envelope.rawReportSha256 || canonicalJson(existing.envelope_json) !== canonicalJson(envelope)) throw new Error("MOUNTED_BIGQUERY_CAPTURE_CONFLICT");
    }
    await client.query("COMMIT");
  } catch (error) {
    await client.query("ROLLBACK").catch(() => undefined);
    throw error;
  } finally { client.release(); }
}

/** Builds the only mounted BigQuery report route. The raw provider resource is
 * selected from the original authenticated Google operation journal, never
 * from record configuration, a provider port, or a public command. */
export function createMountedBigQueryUsageReporter(input: Readonly<{
  configuration: unknown;
  projectId: string;
  quotaProjectId: string;
  principal: string;
  accountScopeSha256: string;
  tokenSource: GoogleTokenSource;
  googleJournal: GoogleOperationJournal;
  billingJournal: PostgresOperationJournal;
  pool: PostgresSqlPool;
  objects: ObjectStorePort;
  bucket: string;
  now?: () => number;
}>) {
  const configuration = MountedBigQueryUsageReportConfigurationSchema.parse(input.configuration);
  const projectId = ProjectId.parse(input.projectId);
  const quotaProjectId = ProjectId.parse(input.quotaProjectId);
  const principal = z.string().regex(/^[A-Za-z0-9@._:/-]{3,255}$/u).parse(input.principal);
  const accountScopeSha256 = Digest.parse(input.accountScopeSha256);
  const now = input.now ?? Date.now;
  const [tableProject] = configuration.detailedExportTable.split(".");
  if (tableProject !== projectId) throw new Error("MOUNTED_BIGQUERY_EXPORT_PROJECT_REQUIRED");
  const collector = createBigQueryUsageReportCollector({
    projectId, quotaProjectId, principal, tokenSource: input.tokenSource,
    journal: createPostgresBigQueryUsageReportJournal(input.billingJournal),
    artifacts: artifacts({ bucket: input.bucket, objects: input.objects }), now,
  });
  return Object.freeze({
    async capture(value: CaptureInput) {
      if (value.operation.provider !== "cloud_run" && value.operation.provider !== "cloud_sql_postgres") return Object.freeze({ status: "held" as const });
      const original = await input.googleJournal.read(googleOperationId(value.operation.operationId));
      const intervalStartMs = parseCreatedAt(original?.createTime);
      const intervalEndMs = now();
      if (!original || original.state !== "completed" || !original.owned || !intervalStartMs
        || intervalEndMs <= intervalStartMs || intervalEndMs - intervalStartMs > configuration.maximumIntervalMs) {
        return Object.freeze({ status: "held" as const });
      }
      const resourceName = ResourceName.safeParse(original.resource);
      if (!resourceName.success || !resourceName.data.startsWith(`projects/${projectId}/`)) return Object.freeze({ status: "held" as const });
      const grant = await createBillingObservationGrant({
        version: 1,
        originalScope: {
          version: 1, provider: value.operation.provider, operationId: value.operation.operationId,
          operationRecordSha256: Digest.parse(value.operationRecordSha256),
          authorizationRequestSha256: Digest.parse(value.authorizationRequestSha256),
          authorizationReceiptSha256: Digest.parse(value.authorizationReceiptSha256),
          candidateSha256: Digest.parse(value.candidateSha256), resourceName: resourceName.data,
          resourceIdentitySha256: Digest.parse(value.resourceIdentitySha256),
          accountScopeSha256: Digest.parse(value.accountScopeSha256), projectScopeSha256: Digest.parse(value.projectScopeSha256),
          selectorSha256: digest({ provider: value.operation.provider, operationId: value.operation.operationId, resourceName: resourceName.data }),
          intervalStartMs, intervalEndMs,
        },
        allowedReportOrigin: "https://bigquery.googleapis.com", projectId, detailedExportTable: configuration.detailedExportTable, location: configuration.location,
        maximumBytesBilled: configuration.maximumBytesBilled, reportQueryMaximumCostMicros: configuration.reportQueryMaximumCostMicros,
        reportQueryPriceSourceSha256: configuration.reportQueryPriceSourceSha256,
        reportQueryMicrosPerByteNumerator: configuration.reportQueryMicrosPerByteNumerator, reportQueryMicrosPerByteDenominator: configuration.reportQueryMicrosPerByteDenominator,
        collectorSha256: configuration.collectorSha256, expiresAtMs: intervalEndMs + configuration.grantTtlMs,
      });
      const captured = await collector.capture(grant);
      if (!captured.envelope) return Object.freeze({ status: "held" as const });
      await persistCapture({ pool: input.pool, grant, envelope: captured.envelope });
      return Object.freeze({ status: "captured" as const, grant, envelope: captured.envelope });
    },
    async readArtifact(value: Readonly<{ uri: string; generation: string; sha256: string }>) {
      return artifacts({ bucket: input.bucket, objects: input.objects }).readExact(value);
    },
    accountScopeSha256,
  });
}
