import { z } from "zod";
import { canonicalJson } from "../promotion/schema";

const DigestSchema = z.string().regex(/^[a-f0-9]{64}$/iu).transform((value) => value.toLowerCase());
const ProviderSchema = z.enum(["cloud_run", "gcs", "collector", "cloud_sql_postgres", "modal", "fly", "contextvm", "cep8_lightning", "cashu", "model", "compatible_host", "signer", "promoted_cli", "upload", "owner_relay", "attestation_relay"]);
const MicrosSchema = z.number().int().safe().nonnegative();

/** This scope is controller-derived from the durable original operation. It is
 * deliberately not a public request shape or a native-provider result. */
export const OriginalUsageScopeSchema = z.object({
  version: z.literal(1),
  provider: ProviderSchema,
  operationId: z.string().regex(/^[a-z][a-z0-9_-]{2,127}$/u),
  operationRecordSha256: DigestSchema,
  authorizationRequestSha256: DigestSchema,
  authorizationReceiptSha256: DigestSchema,
  candidateSha256: DigestSchema,
  /** Raw provider selector is derived only by the mounted authenticated
   * collector from its durable original-operation journal; it is never a CLI
   * or provider-port billing input. */
  resourceName: z.string().regex(/^[A-Za-z0-9_./:-]{1,1024}$/u),
  resourceIdentitySha256: DigestSchema,
  accountScopeSha256: DigestSchema,
  projectScopeSha256: DigestSchema,
  selectorSha256: DigestSchema,
  intervalStartMs: z.number().int().nonnegative(),
  intervalEndMs: z.number().int().positive(),
}).strict().superRefine((value, context) => {
  if (value.intervalEndMs <= value.intervalStartMs) context.addIssue({ code: "custom", message: "USAGE_REPORT_INTERVAL_INVALID" });
});
export type OriginalUsageScope = z.infer<typeof OriginalUsageScopeSchema>;

/** A report grant has no mutation authority. Its report request identity is
 * deterministic so timeout recovery can only read the original provider job. */
export const BillingObservationGrantSchema = z.object({
  version: z.literal(1),
  grantSha256: DigestSchema,
  originalScope: OriginalUsageScopeSchema,
  allowedReportOrigin: z.literal("https://bigquery.googleapis.com"),
  projectId: z.string().regex(/^[a-z][a-z0-9-]{4,28}[a-z0-9]$/u),
  detailedExportTable: z.string().regex(/^[A-Za-z_][A-Za-z0-9_]{0,1023}\.[A-Za-z_][A-Za-z0-9_]{0,1023}\.[A-Za-z_][A-Za-z0-9_]{0,1023}$/u),
  location: z.string().regex(/^[A-Za-z0-9_-]{2,32}$/u),
  maximumBytesBilled: z.string().regex(/^[1-9][0-9]{0,18}$/u),
  reportQueryMaximumCostMicros: MicrosSchema,
  reportQueryPriceSourceSha256: DigestSchema,
  reportQueryMicrosPerByteNumerator: z.string().regex(/^[1-9][0-9]{0,18}$/u),
  reportQueryMicrosPerByteDenominator: z.string().regex(/^[1-9][0-9]{0,18}$/u),
  collectorSha256: DigestSchema,
  reportRequestSha256: DigestSchema,
  expiresAtMs: z.number().int().positive(),
}).strict();
export type BillingObservationGrant = z.infer<typeof BillingObservationGrantSchema>;

export const AuthoritativeUsageReportEnvelopeSchema = z.object({
  version: z.literal(1),
  grantSha256: DigestSchema,
  reportRequestSha256: DigestSchema,
  providerJobId: z.string().regex(/^[A-Za-z0-9_-]{1,1024}$/u),
  rawReportSha256: DigestSchema,
  rawArtifact: z.object({ uri: z.string().regex(/^gs:\/\/[a-z0-9][a-z0-9._-]{1,220}[a-z0-9]\/[^\s]{1,1024}$/u), generation: z.string().regex(/^[1-9][0-9]{0,18}$/u), sha256: DigestSchema }).strict(),
  coverage: z.enum(["complete", "partial", "unknown"]),
  currency: z.literal("USD"),
  grossMeteredMicros: z.number().int().safe().nonnegative().nullable(),
  creditsMicros: z.number().int().safe().nullable(),
  adjustmentsMicros: z.number().int().safe().nullable(),
  netInvoiceMicros: z.number().int().safe().nullable(),
  observedAtMs: z.number().int().nonnegative(),
}).strict();
export type AuthoritativeUsageReportEnvelope = z.infer<typeof AuthoritativeUsageReportEnvelopeSchema>;

async function sha256(value: unknown): Promise<string> {
  const bytes = new TextEncoder().encode(canonicalJson(value));
  return Buffer.from(await crypto.subtle.digest("SHA-256", bytes)).toString("hex");
}

/** A grant is controller-created immutable authority, never a caller supplied
 * report configuration.  Its two digests deliberately bind both the limited
 * query permission and the one deterministic provider report job. */
export async function createBillingObservationGrant(input: Omit<BillingObservationGrant, "grantSha256" | "reportRequestSha256">): Promise<BillingObservationGrant> {
  const reportRequestSha256 = await sha256({
    version: 1,
    origin: input.allowedReportOrigin,
    collectorSha256: input.collectorSha256,
    originalScope: input.originalScope,
    projectId: input.projectId,
    detailedExportTable: input.detailedExportTable,
    location: input.location,
    maximumBytesBilled: input.maximumBytesBilled,
    reportQueryMaximumCostMicros: input.reportQueryMaximumCostMicros,
    reportQueryPriceSourceSha256: input.reportQueryPriceSourceSha256,
    reportQueryMicrosPerByteNumerator: input.reportQueryMicrosPerByteNumerator,
    reportQueryMicrosPerByteDenominator: input.reportQueryMicrosPerByteDenominator,
    expiresAtMs: input.expiresAtMs,
  });
  const grantSha256 = await sha256({ ...input, reportRequestSha256 });
  return BillingObservationGrantSchema.parse({ ...input, reportRequestSha256, grantSha256 });
}

/** Reject a syntactically valid but caller-forged grant before any report
 * transport can run. */
export async function verifyBillingObservationGrant(value: unknown): Promise<BillingObservationGrant> {
  const grant = BillingObservationGrantSchema.parse(value);
  const rebuilt = await createBillingObservationGrant({
    version: grant.version,
    originalScope: grant.originalScope,
    allowedReportOrigin: grant.allowedReportOrigin,
    projectId: grant.projectId,
    detailedExportTable: grant.detailedExportTable,
    location: grant.location,
    maximumBytesBilled: grant.maximumBytesBilled,
    reportQueryMaximumCostMicros: grant.reportQueryMaximumCostMicros,
    reportQueryPriceSourceSha256: grant.reportQueryPriceSourceSha256,
    reportQueryMicrosPerByteNumerator: grant.reportQueryMicrosPerByteNumerator,
    reportQueryMicrosPerByteDenominator: grant.reportQueryMicrosPerByteDenominator,
    collectorSha256: grant.collectorSha256,
    expiresAtMs: grant.expiresAtMs,
  });
  if (rebuilt.grantSha256 !== grant.grantSha256 || rebuilt.reportRequestSha256 !== grant.reportRequestSha256) throw new Error("BILLING_OBSERVATION_GRANT_INVALID");
  return grant;
}

export async function createAuthoritativeUsageReportEnvelope(input: Omit<AuthoritativeUsageReportEnvelope, "rawReportSha256"> & Readonly<{ rawReport: unknown }>): Promise<AuthoritativeUsageReportEnvelope> {
  const { rawReport, ...base } = input;
  const rawReportSha256 = await sha256(rawReport);
  if (base.rawArtifact.sha256 !== rawReportSha256) throw new Error("AUTHORITATIVE_USAGE_ARTIFACT_DIGEST_INVALID");
  return AuthoritativeUsageReportEnvelopeSchema.parse({ ...base, rawReportSha256 });
}

/** BigQuery NUMERIC values remain strings until this bounded conversion. A
 * non-micro USD fraction is intentionally held rather than rounded. */
export function decimalUsdToMicros(value: string): number {
  const parsed = /^(-?)(0|[1-9][0-9]*)(?:\.([0-9]{1,9}))?$/u.exec(value);
  if (!parsed) throw new Error("AUTHORITATIVE_USAGE_DECIMAL_INVALID");
  const fraction = (parsed[3] ?? "").padEnd(6, "0");
  if (fraction.length > 6 && /[1-9]/u.test(fraction.slice(6))) throw new Error("AUTHORITATIVE_USAGE_DECIMAL_PRECISION_UNSUPPORTED");
  const whole = BigInt(parsed[2]!);
  const micros = whole * 1_000_000n + BigInt(fraction.slice(0, 6) || "0");
  const signed = parsed[1] === "-" ? -micros : micros;
  if (signed > BigInt(Number.MAX_SAFE_INTEGER) || signed < BigInt(Number.MIN_SAFE_INTEGER)) throw new Error("AUTHORITATIVE_USAGE_DECIMAL_RANGE_INVALID");
  return Number(signed);
}

export function reportOnlyGrantAllows(grant: BillingObservationGrant, action: "observe_usage_report" | "plan" | "apply" | "cleanup", nowMs: number): void {
  BillingObservationGrantSchema.parse(grant);
  if (!Number.isSafeInteger(nowMs) || nowMs > grant.expiresAtMs || action !== "observe_usage_report") throw new Error("BILLING_OBSERVATION_GRANT_DENIED");
}
