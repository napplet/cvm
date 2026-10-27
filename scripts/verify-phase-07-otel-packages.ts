import { createHash } from "node:crypto";
import { mkdtemp, mkdir, readFile, readdir, rename, rm, writeFile } from "node:fs/promises";
import { dirname, join, relative } from "node:path";
import { tmpdir } from "node:os";
import { z } from "zod";
import { canonicalJson } from "../src/promotion/schema";
import { measureProductionCollectorImage } from "../src/release/collector-image";

const REGISTRY = "https://registry.npmjs.org";
const OFFICIAL_REPOSITORY = "https://github.com/open-telemetry/opentelemetry-js";
const OFFICIAL_DOCUMENTATION = "https://opentelemetry.io/docs/languages/js/exporters/";
const CERTIFICATION_DIRECTORY = "evidence/certification";
const AUDIT_POINTER_PATH = `${CERTIFICATION_DIRECTORY}/phase-07-otel-package-audit.json`;
const APPROVAL_POINTER_PATH = `${CERTIFICATION_DIRECTORY}/phase-07-otel-package-approval.json`;
const RECORD_DIRECTORY = `${CERTIFICATION_DIRECTORY}/otel-package-audits`;
const APPROVAL_RECORD_DIRECTORY = `${CERTIFICATION_DIRECTORY}/otel-package-approvals`;
const SMOKE_DIRECTORY = `${CERTIFICATION_DIRECTORY}/otel-package-smokes`;
const RENEWAL_REVIEW_DIRECTORY = `${CERTIFICATION_DIRECTORY}/otel-package-renewal-reviews`;
const FORBIDDEN_LIFECYCLE_SCRIPTS = new Set(["preinstall", "install", "postinstall", "prepare"]);
const APPROVED_AUDIT_DIGEST = "d7fedf16f62e4088cf17442aa39786c33bb4af8f3377e8d121d76b108eaf22b3";
/** Immutable 2026-10-27 delegated-operator decision for the unchanged
 * six-package closure and current root inputs. The pending audit remains
 * separate and never gains approval authority. */
const APPROVED_OPERATOR_RECORD_DIGEST = "57ccba52b5fe5fb7455248e00fe9809031d63e495f2ada206f7947e1b71cc003";
const APPROVED_ROOT_INPUTS = Object.freeze({ packageJsonSha256: "dca9aebd2cbdb6a10b1dad1565667107807839545a98e10a76ff6e1bdd58891c", bunLockSha256: "2043b92ba436bba778d338bad0af0255abd61363535e06f72ae3f8a9a71630f6" });
/** The upstream base is only a recipe input. Smoke records bind the locally
 * measured derived collector image instead of mounting configuration into a
 * bare upstream container. */
export const COLLECTOR_BASE_IMAGE = "otel/opentelemetry-collector@sha256:6ed874ea083d67a3085acfc75343f2ad11d9abe6006d7ea4a16e2dba9af14e49";
const EXACT_NAMES = [
  "@opentelemetry/api",
  "@opentelemetry/resources",
  "@opentelemetry/sdk-trace-base",
  "@opentelemetry/sdk-metrics",
  "@opentelemetry/exporter-trace-otlp-proto",
  "@opentelemetry/exporter-metrics-otlp-proto",
] as const;

type ExpectedPackage = {
  readonly name: typeof EXACT_NAMES[number];
  readonly version: string;
  readonly integrity: string;
  readonly disposition: "APPROVED" | "SUS";
  readonly publishedOn: string;
  readonly requiredDependencies: Readonly<Record<string, string>>;
};

/** Exact pre-install identities observed from official npm metadata on 2026-08-05. */
export const OFFICIAL_OTEL_PACKAGES: readonly ExpectedPackage[] = [
  { name: "@opentelemetry/api", version: "1.9.1", integrity: "sha512-gLyJlPHPZYdAk1JENA9LeHejZe1Ti77/pTeFm/nMXmQH/HFZlcS/O2XJB+L8fkbrNSqhdtlvjBVjxwUYanNH5Q==", disposition: "APPROVED", publishedOn: "2026-03-25", requiredDependencies: {} },
  { name: "@opentelemetry/resources", version: "2.10.0", integrity: "sha512-q6MMm2zhggzsHVNbabYwut+a6nbuQQe3URUoxaojM/8K1IBfwwPzvxIjNi2/lI1TFe+fMHMW9MWhrtDLEXEnkA==", disposition: "SUS", publishedOn: "2026-07-21", requiredDependencies: { "@opentelemetry/core": "2.10.0" } },
  { name: "@opentelemetry/sdk-trace-base", version: "2.10.0", integrity: "sha512-GuYQQT7QD2EeO8lcZLRQzcbOyhqAzL+6WWTKTU9mSUBYBazkEDl+VrQcXQhbB08OWM9anD1aHleVadzulpOaUQ==", disposition: "SUS", publishedOn: "2026-07-21", requiredDependencies: { "@opentelemetry/core": "2.10.0", "@opentelemetry/resources": "2.10.0", "@opentelemetry/sdk-trace": "2.10.0" } },
  { name: "@opentelemetry/sdk-metrics", version: "2.10.0", integrity: "sha512-t6r1VSvXNtSDnPXU1FbZeetJb7yyovHmgu0wRSoftxtE0g2rSNhQZQUy69sRUCL+iioJpX8SN/S6wq6ZtvLySQ==", disposition: "SUS", publishedOn: "2026-07-21", requiredDependencies: { "@opentelemetry/core": "2.10.0", "@opentelemetry/resources": "2.10.0" } },
  { name: "@opentelemetry/exporter-trace-otlp-proto", version: "0.221.0", integrity: "sha512-Z9i2T7vgZbWe9rSLYxXVIbeW+XyzUq4rZanW3ZyVNwVDqCsh0EJKUgBWWQ0CZfeuUA+RQPzKgJQHMuWAUnKqXw==", disposition: "SUS", publishedOn: "2026-07-21", requiredDependencies: { "@opentelemetry/sdk-trace": "2.10.0", "@opentelemetry/otlp-transformer": "0.221.0", "@opentelemetry/otlp-exporter-base": "0.221.0" } },
  { name: "@opentelemetry/exporter-metrics-otlp-proto", version: "0.221.0", integrity: "sha512-YMF4LveY2I3yhw61rn6nmC9FE8U24IZHPeKU1Duc5+sbwjMd8FwZAwba318ImdThCg/HuVQvhm2y6bfgNPnfYg==", disposition: "SUS", publishedOn: "2026-07-21", requiredDependencies: { "@opentelemetry/otlp-transformer": "0.221.0", "@opentelemetry/otlp-exporter-base": "0.221.0", "@opentelemetry/exporter-metrics-otlp-http": "0.221.0" } },
];

const PackageRowSchema = z.object({
  name: z.string(), version: z.string(), registryIntegrity: z.string().startsWith("sha512-"),
  tarballSha256: z.string().regex(/^[a-f0-9]{64}$/), metadataSha256: z.string().regex(/^[a-f0-9]{64}$/),
  publishMetadataSha256: z.string().regex(/^[a-f0-9]{64}$/), sourceRepository: z.literal(OFFICIAL_REPOSITORY),
  sourceUrls: z.array(z.string().url()).min(2), license: z.literal("Apache-2.0"), publisher: z.literal("GitHub Actions"),
  publishedAt: z.string().datetime(), lifecycleScripts: z.array(z.string()), requiredDependencies: z.record(z.string(), z.string()),
  disposition: z.enum(["APPROVED", "SUS"]), verdict: z.enum(["passed", "failed"]), errors: z.array(z.string()),
});

export const OtelPackageAuditSchema = z.object({
  schemaVersion: z.literal(1), status: z.enum(["passed", "failed", "blocked"]), approvalStatus: z.literal("pending_human"),
  mode: z.literal("preinstall"), packages: z.array(PackageRowSchema).length(6),
  limitations: z.array(z.string()).min(1), inputDigests: z.object({ packageJsonSha256: z.string().regex(/^[a-f0-9]{64}$/), bunLockSha256: z.string().regex(/^[a-f0-9]{64}$/) }),
});
export type OtelPackageAudit = z.infer<typeof OtelPackageAuditSchema>;

const DigestSchema = z.string().regex(/^[a-f0-9]{64}$/u);
const PackageIdentitySchema = z.object({
  name: z.enum(EXACT_NAMES), version: z.string().min(1), registryIntegrity: z.string().startsWith("sha512-"),
}).strict();
const InputDigestsSchema = z.object({ packageJsonSha256: DigestSchema, bunLockSha256: DigestSchema }).strict();
const ApprovalScopeSchema = z.tuple([
  z.literal("disposable_bun_collector_smoke"),
  z.literal("exact_root_package_pins"),
]);
const ApprovalLimitationsSchema = z.tuple([
  z.literal("This decision is not direct-human review or signer provenance."),
  z.literal("This decision authorizes only the exact package set's disposable Bun/Collector smoke and exact root package pins."),
  z.literal("This decision grants no release, live certification, telemetry-data, provider, promotion, or changed-package authority."),
]);

/** A delegated operator decision, deliberately distinct from the pending human audit pointer. */
export const OtelPackageApprovalSchema = z.object({
  schemaVersion: z.literal(1), approvalStatus: z.enum(["approved_operator", "rejected"]), authority: z.literal("delegated_operator"),
  auditEvidenceSha256: DigestSchema, packageSetSha256: DigestSchema, auditInputDigests: InputDigestsSchema,
  rootInputDigests: InputDigestsSchema, packages: z.array(PackageIdentitySchema).length(6), decidedAt: z.string().datetime(),
  expiresAt: z.string().datetime(), scope: ApprovalScopeSchema, limitations: ApprovalLimitationsSchema,
}).strict();
export type OtelPackageApproval = z.infer<typeof OtelPackageApprovalSchema>;

const ApprovalPointerSchema = z.object({
  schemaVersion: z.literal(1), approvalStatus: z.literal("approved_operator"), evidenceSha256: DigestSchema,
  auditEvidenceSha256: DigestSchema, packageSetSha256: DigestSchema, record: z.string().regex(/^otel-package-approvals\/[a-f0-9]{64}\.json$/u),
}).strict();

const SmokeRecordSchema = z.object({
  schemaVersion: z.literal(1), status: z.enum(["passed", "failed", "blocked"]), mode: z.literal("bun-collector-smoke"),
  approvedApprovalDigest: DigestSchema, approvedAuditDigest: DigestSchema, packageSetSha256: DigestSchema, bunVersion: z.string().min(1),
  packages: z.array(z.object({ name: z.string(), version: z.string() })).length(6),
  collectorImageDigest: z.string().regex(/^oci-layout@sha256:[a-f0-9]{64}$/u).optional(),
  collectorDockerfileSha256: z.string().regex(/^[a-f0-9]{64}$/u).optional(),
  collectorBaseImage: z.literal(COLLECTOR_BASE_IMAGE).optional(),
  collectorConfigSha256: z.string().regex(/^[a-f0-9]{64}$/u), otlpEndpoint: z.literal("http/protobuf /v1/traces,/v1/metrics"),
  outputSha256: z.string().regex(/^[a-f0-9]{64}$/u).optional(), limitations: z.array(z.string()).min(1),
  inputDigests: z.object({ packageJsonSha256: z.string().regex(/^[a-f0-9]{64}$/), bunLockSha256: z.string().regex(/^[a-f0-9]{64}$/) }),
  errorCode: z.string().regex(/^[A-Z0-9_]+$/u).optional(), evidenceSha256: z.string().regex(/^[a-f0-9]{64}$/).optional(),
}).strict();

/** A local preapproval fact for a changed root.  It is deliberately not an
 * approval record: it gives an operator the exact bounded inputs to review
 * without changing the historical decision, pointer, or smoke evidence. */
const RenewalReviewSchema = z.object({
  schemaVersion: z.literal(1), kind: z.literal("otel_approval_renewal_preapproval"), status: z.literal("approval_required"),
  historicalApprovalDigest: DigestSchema, auditDigest: DigestSchema, packageSetSha256: DigestSchema,
  historicalRootInputDigests: InputDigestsSchema, currentRootInputDigests: InputDigestsSchema,
  collector: z.object({ imageReference: z.string().regex(/^oci-layout@sha256:[a-f0-9]{64}$/u), imageDigest: DigestSchema, baseImage: z.literal(COLLECTOR_BASE_IMAGE), dockerfileSha256: DigestSchema, collectorConfigSha256: DigestSchema }).strict(),
  limitations: z.tuple([
    z.literal("This artifact is review input only and does not authorize package installation, smoke, or release."),
    z.literal("The historical delegated decision remains immutable and is not valid for these current root input digests."),
    z.literal("A new delegated operator approval is required before any approval-dependent command may proceed."),
  ]),
}).strict();
export type OtelApprovalRenewalReview = z.infer<typeof RenewalReviewSchema>;

function sha256(value: Uint8Array | string): string { return createHash("sha256").update(value).digest("hex"); }
function sriMatches(bytes: Uint8Array, integrity: string): boolean {
  return integrity.split(/\s+/u).some((item) => item === `sha512-${createHash("sha512").update(bytes).digest("base64")}`);
}
function normalizeRepository(value: unknown): string | null {
  const url = typeof value === "string" ? value : value && typeof value === "object" && "url" in value ? (value as { url?: unknown }).url : null;
  if (typeof url !== "string") return null;
  if (url === "open-telemetry/opentelemetry-js") return OFFICIAL_REPOSITORY;
  return url.replace(/^git\+/, "").replace(/^git:\/\//, "https://").replace(/\.git$/, "").replace(/\/$/, "");
}
function isRecord(value: unknown): value is Record<string, unknown> { return typeof value === "object" && value !== null && !Array.isArray(value); }
function scriptNames(value: unknown): string[] { return isRecord(value) ? Object.keys(value).filter((name) => FORBIDDEN_LIFECYCLE_SCRIPTS.has(name)).sort() : []; }
function safeJson(value: unknown): Record<string, unknown> { return isRecord(value) ? value : {}; }
function exactSet(expected: readonly ExpectedPackage[]): boolean {
  return expected.length === EXACT_NAMES.length && new Set(expected.map((item) => item.name)).size === EXACT_NAMES.length && EXACT_NAMES.every((name) => expected.some((item) => item.name === name));
}
function tarPackageJson(bytes: Uint8Array): Record<string, unknown> {
  const tar = new Uint8Array(Bun.gunzipSync(bytes));
  for (let offset = 0; offset + 512 <= tar.length; ) {
    const header = tar.subarray(offset, offset + 512);
    const name = new TextDecoder().decode(header.subarray(0, 100)).replace(/\0.*$/u, "");
    if (!name) break;
    const sizeText = new TextDecoder().decode(header.subarray(124, 136)).replace(/\0.*$/u, "").trim();
    const size = Number.parseInt(sizeText || "0", 8);
    if (!Number.isSafeInteger(size) || size < 0) throw new Error("TARBALL_INVALID_SIZE");
    const content = tar.subarray(offset + 512, offset + 512 + size);
    if (name === "package/package.json") return safeJson(JSON.parse(new TextDecoder().decode(content)));
    offset += 512 + Math.ceil(size / 512) * 512;
  }
  throw new Error("TARBALL_PACKAGE_JSON_MISSING");
}
async function responseJson(fetcher: typeof fetch, url: string): Promise<{ value: Record<string, unknown>; sha256: string }> {
  const response = await fetcher(url, { headers: { accept: "application/json" } });
  if (!response.ok) throw new Error(`REGISTRY_REQUEST_FAILED:${response.status}`);
  const bytes = new Uint8Array(await response.arrayBuffer());
  return { value: safeJson(JSON.parse(new TextDecoder().decode(bytes))), sha256: sha256(bytes) };
}
async function snapshot(path: string): Promise<string> { return sha256(await readFile(path)); }
async function run(command: string[], cwd?: string): Promise<{ readonly code: number; readonly stdout: string; readonly stderr: string }> {
  const process = Bun.spawn(command, { cwd, stdout: "pipe", stderr: "pipe" });
  const [code, stdout, stderr] = await Promise.all([process.exited, new Response(process.stdout).text(), new Response(process.stderr).text()]);
  return { code, stdout, stderr };
}
function packageSetDigest(packages: readonly { readonly name: string; readonly version: string; readonly registryIntegrity: string }[]): string {
  return sha256(canonicalJson([...packages].map(({ name, version, registryIntegrity }) => ({ name, version, registryIntegrity })).sort((left, right) => left.name.localeCompare(right.name))));
}
function samePackageSet(packages: readonly { readonly name: string; readonly version: string; readonly registryIntegrity: string }[]): boolean {
  return packages.length === OFFICIAL_OTEL_PACKAGES.length
    && packageSetDigest(packages) === packageSetDigest(OFFICIAL_OTEL_PACKAGES.map(({ name, version, integrity }) => ({ name, version, registryIntegrity: integrity })))
    && new Set(packages.map((entry) => entry.name)).size === OFFICIAL_OTEL_PACKAGES.length;
}
function certificationPaths(root: string) {
  const directory = join(root, CERTIFICATION_DIRECTORY);
  return { directory, auditPointer: join(root, AUDIT_POINTER_PATH), approvalPointer: join(root, APPROVAL_POINTER_PATH) };
}
async function rootPins(root = process.cwd()): Promise<Record<string, unknown>> { return safeJson(JSON.parse(await readFile(join(root, "package.json"), "utf8"))); }
async function exactRootPins(root = process.cwd()): Promise<boolean> {
  const dependencies = (await rootPins(root)).dependencies;
  if (!isRecord(dependencies)) return false;
  return OFFICIAL_OTEL_PACKAGES.every((item) => dependencies[item.name] === item.version);
}
function approvedRootInputs(recorded: z.infer<typeof InputDigestsSchema>, current: z.infer<typeof InputDigestsSchema>): boolean {
  return recorded.packageJsonSha256 === APPROVED_ROOT_INPUTS.packageJsonSha256
    && recorded.bunLockSha256 === APPROVED_ROOT_INPUTS.bunLockSha256
    && current.packageJsonSha256 === APPROVED_ROOT_INPUTS.packageJsonSha256
    && current.bunLockSha256 === APPROVED_ROOT_INPUTS.bunLockSha256;
}

export async function verifyApprovedOtelPackageSet(options: { readonly repositoryRoot?: string } = {}): Promise<{ readonly approvalDigest: string; readonly auditDigest: string; readonly packageSetSha256: string }> {
  const approved = await readHistoricalApproval(options);
  const root = options.repositoryRoot ?? process.cwd();
  const rootInputs = { packageJsonSha256: await snapshot(join(root, "package.json")), bunLockSha256: await snapshot(join(root, "bun.lock")) };
  if (!approvedRootInputs(approved.approval.rootInputDigests, rootInputs)) throw new Error("APPROVAL_INPUT_DIGEST_DRIFT");
  return { approvalDigest: approved.pointer.evidenceSha256, auditDigest: approved.pointer.auditEvidenceSha256, packageSetSha256: approved.pointer.packageSetSha256 };
}

async function readHistoricalApproval(options: { readonly repositoryRoot?: string } = {}) {
  const root = options.repositoryRoot ?? process.cwd();
  const paths = certificationPaths(root);
  await verifyPointer({ repositoryRoot: root });
  const auditPointer = safeJson(JSON.parse(await readFile(paths.auditPointer, "utf8")));
  if (auditPointer.evidenceSha256 !== APPROVED_AUDIT_DIGEST) throw new Error("APPROVAL_AUDIT_DIGEST_DRIFT");
  let pointer: z.infer<typeof ApprovalPointerSchema>;
  try { pointer = ApprovalPointerSchema.parse(JSON.parse(await readFile(paths.approvalPointer, "utf8"))); }
  catch (error) {
    if (error instanceof Error && (error as NodeJS.ErrnoException).code === "ENOENT") throw new Error("APPROVAL_POINTER_REQUIRED");
    throw new Error("APPROVAL_POINTER_INVALID");
  }
  if (pointer.evidenceSha256 !== APPROVED_OPERATOR_RECORD_DIGEST) throw new Error("APPROVAL_DECISION_DIGEST_DRIFT");
  if (pointer.auditEvidenceSha256 !== auditPointer.evidenceSha256 || pointer.auditEvidenceSha256 !== APPROVED_AUDIT_DIGEST) throw new Error("APPROVAL_POINTER_AUDIT_DRIFT");
  const expectedPackageSetSha256 = packageSetDigest(OFFICIAL_OTEL_PACKAGES.map(({ name, version, integrity }) => ({ name, version, registryIntegrity: integrity })));
  if (pointer.packageSetSha256 !== expectedPackageSetSha256) throw new Error("APPROVAL_POINTER_PACKAGE_SET_DRIFT");
  let record: Record<string, unknown>;
  try { record = safeJson(JSON.parse(await readFile(join(paths.directory, pointer.record), "utf8"))); }
  catch { throw new Error("APPROVAL_RECORD_REQUIRED"); }
  const { evidenceSha256, ...approvalPayload } = record;
  if (evidenceSha256 !== pointer.evidenceSha256 || sha256(canonicalJson(approvalPayload)) !== pointer.evidenceSha256) throw new Error("APPROVAL_RECORD_DIGEST_MISMATCH");
  const approval = OtelPackageApprovalSchema.parse(approvalPayload);
  if (approval.approvalStatus !== "approved_operator") throw new Error("APPROVAL_RECORD_NOT_APPROVED");
  if (approval.auditEvidenceSha256 !== pointer.auditEvidenceSha256 || approval.packageSetSha256 !== pointer.packageSetSha256) throw new Error("APPROVAL_RECORD_POINTER_DRIFT");
  if (approval.expiresAt <= new Date().toISOString()) throw new Error("APPROVAL_RECORD_EXPIRED");
  if (!samePackageSet(approval.packages) || approval.packageSetSha256 !== packageSetDigest(approval.packages)) throw new Error("APPROVAL_PACKAGE_SET_DRIFT");
  const auditRecord = safeJson(JSON.parse(await readFile(join(paths.directory, String(auditPointer.record)), "utf8")));
  const { evidenceSha256: auditEvidenceSha256, ...auditPayload } = auditRecord;
  if (auditEvidenceSha256 !== auditPointer.evidenceSha256 || sha256(canonicalJson(auditPayload)) !== auditPointer.evidenceSha256) throw new Error("APPROVAL_AUDIT_RECORD_DRIFT");
  const audit = OtelPackageAuditSchema.parse(auditPayload);
  if (audit.status !== "passed" || audit.approvalStatus !== "pending_human" || packageSetDigest(audit.packages) !== pointer.packageSetSha256) throw new Error("APPROVAL_AUDIT_PACKAGE_SET_DRIFT");
  if (canonicalJson(audit.inputDigests) !== canonicalJson(approval.auditInputDigests)) throw new Error("APPROVAL_AUDIT_INPUT_DRIFT");
  return Object.freeze({ root, pointer, approval });
}

/**
 * Writes a content-addressed, no-effect renewal-review artifact when the
 * current dependency graph is outside the historical delegated decision.
 * It never changes the approval pointer or treats this review artifact as an
 * authorization token.
 */
export async function writeOtelApprovalRenewalReview(options: { readonly repositoryRoot?: string } = {}): Promise<Readonly<{ evidenceSha256: string; recordPath: string; review: OtelApprovalRenewalReview }>> {
  const approved = await readHistoricalApproval(options);
  const currentRootInputDigests = { packageJsonSha256: await snapshot(join(approved.root, "package.json")), bunLockSha256: await snapshot(join(approved.root, "bun.lock")) };
  if (approvedRootInputs(approved.approval.rootInputDigests, currentRootInputDigests)) throw new Error("APPROVAL_RENEWAL_NOT_REQUIRED");
  const measured = await measureProductionCollectorImage({ repositoryRoot: approved.root });
  const review = RenewalReviewSchema.parse({
    schemaVersion: 1, kind: "otel_approval_renewal_preapproval", status: "approval_required",
    historicalApprovalDigest: approved.pointer.evidenceSha256, auditDigest: approved.pointer.auditEvidenceSha256, packageSetSha256: approved.pointer.packageSetSha256,
    historicalRootInputDigests: approved.approval.rootInputDigests, currentRootInputDigests,
    collector: { imageReference: measured.imageReference, imageDigest: measured.imageDigest, baseImage: measured.baseImage, dockerfileSha256: measured.dockerfileSha256, collectorConfigSha256: measured.collectorConfigSha256 },
    limitations: [
      "This artifact is review input only and does not authorize package installation, smoke, or release.",
      "The historical delegated decision remains immutable and is not valid for these current root input digests.",
      "A new delegated operator approval is required before any approval-dependent command may proceed.",
    ],
  });
  const evidenceSha256 = sha256(canonicalJson(review));
  const recordPath = join(approved.root, RENEWAL_REVIEW_DIRECTORY, `${evidenceSha256}.json`);
  const content = `${canonicalJson({ ...review, evidenceSha256 })}\n`;
  await mkdir(dirname(recordPath), { recursive: true });
  try { await writeFile(recordPath, content, { encoding: "utf8", flag: "wx" }); }
  catch (error) { if (!(error instanceof Error) || !((error as NodeJS.ErrnoException).code === "EEXIST") || await readFile(recordPath, "utf8") !== content) throw new Error("IMMUTABLE_RENEWAL_REVIEW_COLLISION"); }
  return Object.freeze({ evidenceSha256, recordPath, review });
}
async function verifyCurrentSmokeRecord(approval: { readonly approvalDigest: string; readonly auditDigest: string; readonly packageSetSha256: string }): Promise<void> {
  const root = process.cwd();
  const collector = await measureProductionCollectorImage({ repositoryRoot: root });
  const expectedInputs = { packageJsonSha256: await snapshot(join(root, "package.json")), bunLockSha256: await snapshot(join(root, "bun.lock")) };
  const expectedConfig = await snapshot(join(root, "infra/otel/collector.yaml"));
  let names: string[];
  try { names = await readdir(SMOKE_DIRECTORY); } catch { throw new Error("COLLECTOR_SMOKE_RECORD_REQUIRED"); }
  for (const name of names.filter((value) => value.endsWith(".json"))) {
    try {
      const value = SmokeRecordSchema.parse(JSON.parse(await readFile(join(SMOKE_DIRECTORY, name), "utf8")));
      const { evidenceSha256, ...payload } = value;
      if (value.status !== "passed" || !evidenceSha256 || sha256(canonicalJson(payload)) !== evidenceSha256) continue;
      if (value.approvedApprovalDigest !== approval.approvalDigest || value.approvedAuditDigest !== approval.auditDigest || value.packageSetSha256 !== approval.packageSetSha256) continue;
      if (value.collectorImageDigest !== collector.imageReference || value.collectorDockerfileSha256 !== collector.dockerfileSha256 || value.collectorBaseImage !== collector.baseImage || !value.outputSha256 || value.bunVersion !== Bun.version || value.collectorConfigSha256 !== expectedConfig) continue;
      if (!approvedRootInputs(value.inputDigests, expectedInputs)) continue;
      if (value.packages.length !== OFFICIAL_OTEL_PACKAGES.length || OFFICIAL_OTEL_PACKAGES.some((expected) => !value.packages.some((item) => item.name === expected.name && item.version === expected.version))) continue;
      return;
    } catch { /* Invalid or unrelated immutable records cannot authorize pins. */ }
  }
  throw new Error("COLLECTOR_SMOKE_RECORD_REQUIRED");
}
async function writeSmokeRecord(record: z.input<typeof SmokeRecordSchema>): Promise<{ readonly evidenceSha256: string; readonly recordPath: string }> {
  const withoutDigest = SmokeRecordSchema.omit({ evidenceSha256: true }).parse(record);
  const evidenceSha256 = sha256(canonicalJson(withoutDigest));
  const content = `${canonicalJson({ ...withoutDigest, evidenceSha256 })}\n`;
  const recordPath = join(SMOKE_DIRECTORY, `${evidenceSha256}.json`);
  await mkdir(SMOKE_DIRECTORY, { recursive: true });
  try { await writeFile(recordPath, content, { encoding: "utf8", flag: "wx" }); }
  catch (error) { if (!(error instanceof Error) || !((error as NodeJS.ErrnoException).code === "EEXIST") || await readFile(recordPath, "utf8") !== content) throw new Error("IMMUTABLE_SMOKE_COLLISION"); }
  return { evidenceSha256, recordPath };
}
async function smoke(): Promise<{ readonly evidenceSha256: string; readonly recordPath: string }> {
  const root = process.cwd();
  const approval = await verifyApprovedOtelPackageSet();
  const collector = await measureProductionCollectorImage({ repositoryRoot: root });
  const inputDigests = { packageJsonSha256: await snapshot(join(root, "package.json")), bunLockSha256: await snapshot(join(root, "bun.lock")) };
  const collectorConfigSha256 = await snapshot(join(root, "infra/otel/collector.yaml"));
  const base = { schemaVersion: 1 as const, mode: "bun-collector-smoke" as const, approvedApprovalDigest: approval.approvalDigest, approvedAuditDigest: approval.auditDigest, packageSetSha256: approval.packageSetSha256, bunVersion: Bun.version, packages: OFFICIAL_OTEL_PACKAGES.map(({ name, version }) => ({ name, version })), collectorConfigSha256, otlpEndpoint: "http/protobuf /v1/traces,/v1/metrics" as const, inputDigests, limitations: ["Certification smoke sends only fixed finite attributes to a local Collector debug sink.", "This is package and protocol compatibility evidence, not live service certification."], };
  let temp = ""; let container = "";
  try {
    const dockerReady = await run(["docker", "info", "--format", "{{.ServerVersion}}"]);
    if (dockerReady.code !== 0) throw new Error("DOCKER_UNAVAILABLE");
    const started = await run(["docker", "run", "-d", "--rm", "-p", "127.0.0.1::4318", collector.buildTag]);
    if (started.code !== 0 || !/^[a-f0-9]{12,}$/u.test(started.stdout.trim())) throw new Error("COLLECTOR_START_FAILED");
    container = started.stdout.trim();
    const port = (await run(["docker", "port", container, "4318/tcp"])).stdout.trim().match(/127\.0\.0\.1:(\d+)/u)?.[1];
    if (!port) throw new Error("COLLECTOR_PORT_UNAVAILABLE");
    await Bun.sleep(500);
    temp = await mkdtemp(join(tmpdir(), "napplet-cvm-otel-smoke-"));
    await writeFile(join(temp, "package.json"), `${JSON.stringify({ private: true, type: "module", dependencies: Object.fromEntries(OFFICIAL_OTEL_PACKAGES.map(({ name, version }) => [name, version])) })}\n`, "utf8");
    const smokeCorrelation = `sha256:${"a".repeat(64)}`;
    await writeFile(join(temp, "smoke.ts"), `import { metrics, trace } from "@opentelemetry/api";\nimport "@opentelemetry/resources";\nimport { OTLPTraceExporter } from "@opentelemetry/exporter-trace-otlp-proto";\nimport { OTLPMetricExporter } from "@opentelemetry/exporter-metrics-otlp-proto";\nimport { BasicTracerProvider, SimpleSpanProcessor } from "@opentelemetry/sdk-trace-base";\nimport { MeterProvider, PeriodicExportingMetricReader } from "@opentelemetry/sdk-metrics";\nconst base = process.env.OTLP_ENDPOINT!; const attrs = { "cvm.lifecycle.version": "v1", "cvm.lifecycle.stage": "exact_session_ready", "cvm.lifecycle.outcome": "accepted", "cvm.correlation.digest": "${smokeCorrelation}" };\nconst tracerProvider = new BasicTracerProvider({ spanProcessors: [new SimpleSpanProcessor(new OTLPTraceExporter({ url: base + "/v1/traces" }))] }); trace.setGlobalTracerProvider(tracerProvider); const meterProvider = new MeterProvider({ readers: [new PeriodicExportingMetricReader({ exporter: new OTLPMetricExporter({ url: base + "/v1/metrics" }), exportIntervalMillis: 20 })] }); metrics.setGlobalMeterProvider(meterProvider); const span = trace.getTracer("cvm.lifecycle.v1").startSpan("cvm.lifecycle.exact_session_ready", { attributes: attrs }); span.end(); metrics.getMeter("cvm.lifecycle.v1").createCounter("cvm.lifecycle.observations").add(1, { "cvm.lifecycle.version": "v1", "cvm.lifecycle.stage": "exact_session_ready", "cvm.lifecycle.outcome": "accepted" }); await tracerProvider.forceFlush(); await meterProvider.forceFlush(); await new Promise((resolve) => setTimeout(resolve, 100));\n`, "utf8");
    const install = await run(["bun", "install", "--ignore-scripts", "--exact"], temp);
    if (install.code !== 0) throw new Error("DISPOSABLE_INSTALL_FAILED");
    const imported = await run(["env", `OTLP_ENDPOINT=http://127.0.0.1:${port}`, "bun", "run", "smoke.ts"], temp);
    if (imported.code !== 0) throw new Error("BUN_IMPORT_OR_OTLP_FAILED");
    await Bun.sleep(1_500);
    const collectorLogs = await run(["docker", "logs", container]);
    const output = `${collectorLogs.stdout}${collectorLogs.stderr}`;
    if (!output.includes("cvm.lifecycle.exact_session_ready")) throw new Error("COLLECTOR_TRACE_MISSING");
    if (!output.includes("cvm.lifecycle.observations")) throw new Error("COLLECTOR_METRIC_MISSING");
    for (const expected of ["exact_session_ready", "accepted", smokeCorrelation]) if (!output.includes(expected)) throw new Error("COLLECTOR_SAFE_ATTRIBUTE_MISSING");
    const record = await writeSmokeRecord({ ...base, status: "passed", collectorImageDigest: collector.imageReference, collectorDockerfileSha256: collector.dockerfileSha256, collectorBaseImage: collector.baseImage, outputSha256: sha256(output) });
    const after = { packageJsonSha256: await snapshot(join(root, "package.json")), bunLockSha256: await snapshot(join(root, "bun.lock")) };
    if (after.packageJsonSha256 !== inputDigests.packageJsonSha256 || after.bunLockSha256 !== inputDigests.bunLockSha256) throw new Error("ROOT_DEPENDENCY_GRAPH_MUTATED");
    return record;
  } catch (error) {
    const code = error instanceof Error && /^[A-Z0-9_]+$/u.test(error.message) ? error.message : "SMOKE_FAILED";
    const record = await writeSmokeRecord({ ...base, status: code === "DOCKER_UNAVAILABLE" ? "blocked" : "failed", errorCode: code });
    throw new Error(`${code}:${record.evidenceSha256}`);
  } finally {
    if (container) await run(["docker", "rm", "-f", container]);
    if (temp) await rm(temp, { recursive: true, force: true });
  }
}
function failedRow(expected: ExpectedPackage, errors: string[], digests: Partial<z.infer<typeof PackageRowSchema>> = {}) {
  return { name: expected.name, version: expected.version, registryIntegrity: expected.integrity, tarballSha256: digests.tarballSha256 ?? "0".repeat(64), metadataSha256: digests.metadataSha256 ?? "0".repeat(64), publishMetadataSha256: digests.publishMetadataSha256 ?? "0".repeat(64), sourceRepository: OFFICIAL_REPOSITORY, sourceUrls: [OFFICIAL_REPOSITORY, OFFICIAL_DOCUMENTATION], license: "Apache-2.0", publisher: "GitHub Actions", publishedAt: `${expected.publishedOn}T00:00:00.000Z`, lifecycleScripts: [], requiredDependencies: expected.requiredDependencies, disposition: expected.disposition, verdict: "failed" as const, errors };
}

export async function verifyOfficialOtelPackageSet(options: { readonly fetch?: typeof fetch; readonly expectedPackages?: readonly ExpectedPackage[]; readonly repositoryRoot?: string } = {}): Promise<OtelPackageAudit> {
  const fetcher = options.fetch ?? fetch;
  const expected = options.expectedPackages ?? OFFICIAL_OTEL_PACKAGES;
  const root = options.repositoryRoot ?? process.cwd();
  const before = { packageJsonSha256: await snapshot(join(root, "package.json")), bunLockSha256: await snapshot(join(root, "bun.lock")) };
  const rows: z.infer<typeof PackageRowSchema>[] = [];
  if (!exactSet(expected)) {
    for (const item of OFFICIAL_OTEL_PACKAGES) rows.push(failedRow(item, ["EXPECTED_PACKAGE_SET_INVALID"]));
  } else for (const item of expected) {
    let metadataSha256 = "0".repeat(64); let publishMetadataSha256 = "0".repeat(64); let tarballSha256 = "0".repeat(64);
    try {
      const metadataUrl = `${REGISTRY}/${encodeURIComponent(item.name)}/${item.version}`;
      const publishedUrl = `${REGISTRY}/${encodeURIComponent(item.name)}`;
      const [{ value: metadata, sha256: metadataDigest }, { value: publishMetadata, sha256: publishDigest }] = await Promise.all([responseJson(fetcher, metadataUrl), responseJson(fetcher, publishedUrl)]);
      metadataSha256 = metadataDigest; publishMetadataSha256 = publishDigest;
      const dist = safeJson(metadata.dist); const tarball = dist.tarball;
      if (typeof tarball !== "string" || !tarball.startsWith(`${REGISTRY}/`)) throw new Error("TARBALL_ORIGIN_INVALID");
      const response = await fetcher(tarball);
      if (!response.ok) throw new Error(`TARBALL_FETCH_FAILED:${response.status}`);
      const bytes = new Uint8Array(await response.arrayBuffer()); tarballSha256 = sha256(bytes);
      const tarManifest = tarPackageJson(bytes); const errors: string[] = [];
      if (metadata.name !== item.name || tarManifest.name !== item.name) errors.push("IDENTITY_MISMATCH");
      if (metadata.version !== item.version || tarManifest.version !== item.version) errors.push("VERSION_MISMATCH");
      if (dist.integrity !== item.integrity || !sriMatches(bytes, item.integrity)) errors.push("INTEGRITY_MISMATCH");
      if (normalizeRepository(metadata.repository) !== OFFICIAL_REPOSITORY || normalizeRepository(tarManifest.repository) !== OFFICIAL_REPOSITORY) errors.push("SOURCE_MISMATCH");
      if (metadata.license !== "Apache-2.0" || tarManifest.license !== "Apache-2.0") errors.push("LICENSE_MISMATCH");
      if (!isRecord(metadata._npmUser) || metadata._npmUser.name !== "GitHub Actions") errors.push("PUBLISHER_MISMATCH");
      const publishedAt = safeJson(publishMetadata.time)[item.version];
      if (typeof publishedAt !== "string" || !publishedAt.startsWith(`${item.publishedOn}T`)) errors.push("PUBLISH_TIME_MISMATCH");
      const lifecycleScripts = [...new Set([...scriptNames(metadata.scripts), ...scriptNames(tarManifest.scripts)])];
      if (lifecycleScripts.length) errors.push(`UNSAFE_LIFECYCLE:${lifecycleScripts.join(",")}`);
      const dependencies = safeJson(metadata.dependencies);
      for (const [name, version] of Object.entries(item.requiredDependencies)) if (dependencies[name] !== version || /[~^*]|latest/u.test(version)) errors.push(`DEPENDENCY_RANGE_MISMATCH:${name}`);
      if (Object.entries(dependencies).some(([name, version]) => name.startsWith("@opentelemetry/") && (typeof version !== "string" || version === "latest"))) errors.push("FLOATING_OPENTELEMETRY_DEPENDENCY");
      rows.push({ name: item.name, version: item.version, registryIntegrity: item.integrity, tarballSha256, metadataSha256, publishMetadataSha256, sourceRepository: OFFICIAL_REPOSITORY, sourceUrls: [metadataUrl, publishedUrl, OFFICIAL_REPOSITORY, OFFICIAL_DOCUMENTATION], license: "Apache-2.0", publisher: "GitHub Actions", publishedAt: typeof publishedAt === "string" ? publishedAt : `${item.publishedOn}T00:00:00.000Z`, lifecycleScripts, requiredDependencies: item.requiredDependencies, disposition: item.disposition, verdict: errors.length === 0 ? "passed" : "failed", errors });
    } catch (error) { rows.push(failedRow(item, [error instanceof Error ? error.message : "REGISTRY_AUDIT_FAILED"], { metadataSha256, publishMetadataSha256, tarballSha256 })); }
  }
  const after = { packageJsonSha256: await snapshot(join(root, "package.json")), bunLockSha256: await snapshot(join(root, "bun.lock")) };
  const errors = before.packageJsonSha256 !== after.packageJsonSha256 || before.bunLockSha256 !== after.bunLockSha256;
  if (errors) for (const row of rows) { row.verdict = "failed"; row.errors.push("DEPENDENCY_GRAPH_MUTATED"); }
  return OtelPackageAuditSchema.parse({ schemaVersion: 1, status: rows.every((row) => row.verdict === "passed") ? "passed" : "failed", approvalStatus: "pending_human", mode: "preinstall", packages: rows, limitations: ["Registry and tarball metadata validation is not installation approval.", "Bun and Collector runtime compatibility is pending execution.", "All non-API packages remain SUS pending the blocking human approval in Plan 07-03."], inputDigests: before });
}

async function writeAuditEvidence(audit: OtelPackageAudit): Promise<{ readonly evidenceSha256: string; readonly recordPath: string }> {
  const evidenceSha256 = sha256(canonicalJson(audit)); const recordPath = `${RECORD_DIRECTORY}/${evidenceSha256}.json`; const content = `${canonicalJson({ ...audit, evidenceSha256 })}\n`;
  await mkdir(RECORD_DIRECTORY, { recursive: true });
  try { await writeFile(recordPath, content, { encoding: "utf8", flag: "wx" }); }
  catch (error) { if (!(error instanceof Error) || !((error as NodeJS.ErrnoException).code === "EEXIST") || await readFile(recordPath, "utf8") !== content) throw new Error("IMMUTABLE_AUDIT_COLLISION"); }
  const pointer = { schemaVersion: 1, approvalStatus: "pending_human", evidenceSha256, record: relative(CERTIFICATION_DIRECTORY, recordPath), status: audit.status };
  const pointerContent = `${canonicalJson(pointer)}\n`; const temporary = `${AUDIT_POINTER_PATH}.tmp`;
  await mkdir(dirname(AUDIT_POINTER_PATH), { recursive: true }); await writeFile(temporary, pointerContent, "utf8"); await rename(temporary, AUDIT_POINTER_PATH);
  await verifyPointer(); return { evidenceSha256, recordPath };
}

export async function verifyPointer(options: { readonly repositoryRoot?: string } = {}): Promise<void> {
  const root = options.repositoryRoot ?? process.cwd();
  const paths = certificationPaths(root);
  const pointer = safeJson(JSON.parse(await readFile(paths.auditPointer, "utf8")));
  if (pointer.schemaVersion !== 1 || pointer.approvalStatus !== "pending_human" || pointer.status !== "passed" || typeof pointer.evidenceSha256 !== "string" || !/^[a-f0-9]{64}$/u.test(pointer.evidenceSha256) || typeof pointer.record !== "string" || pointer.record.includes("..")) throw new Error("AUDIT_POINTER_INVALID");
  const recordPath = join(paths.directory, pointer.record); const record = safeJson(JSON.parse(await readFile(recordPath, "utf8"))); const { evidenceSha256, ...audit } = record;
  if (evidenceSha256 !== pointer.evidenceSha256 || sha256(canonicalJson(audit)) !== pointer.evidenceSha256) throw new Error("AUDIT_POINTER_DIGEST_MISMATCH");
  const parsed = OtelPackageAuditSchema.parse(audit); if (parsed.status !== "passed" || parsed.approvalStatus !== "pending_human" || parsed.packages.some((entry) => entry.verdict !== "passed")) throw new Error("AUDIT_POINTER_NONPASS");
}

async function main(): Promise<void> {
  const args = Bun.argv.slice(2); const offline = args.includes("--offline-fixture"); const pointerOnly = args.includes("--verify-pointer"); const preinstall = args.includes("--mode=preinstall"); const requireApproved = args.includes("--require-approved"); const verifyRootPins = args.includes("--verify-root-pins"); const runSmoke = args.includes("--bun-collector-smoke"); const renewalReview = args.includes("--write-renewal-review");
  if (args.length === 0 || args.some((argument) => !["--mode=preinstall", "--offline-fixture", "--verify-pointer", "--require-approved", "--verify-root-pins", "--bun-collector-smoke", "--write-renewal-review"].includes(argument)) || [offline, pointerOnly, preinstall, requireApproved, verifyRootPins, runSmoke, renewalReview].filter(Boolean).length > 1) throw new Error("usage: --mode=preinstall | --offline-fixture | --verify-pointer | --require-approved | --verify-root-pins | --bun-collector-smoke | --write-renewal-review");
  if (renewalReview) { const review = await writeOtelApprovalRenewalReview(); console.log(JSON.stringify({ status: "approval_required", mode: "renewal-review", evidenceSha256: review.evidenceSha256, recordPath: relative(process.cwd(), review.recordPath) })); return; }
  if (requireApproved) { const approval = await verifyApprovedOtelPackageSet(); console.log(JSON.stringify({ status: "passed", mode: "approved-operator", ...approval })); return; }
  if (verifyRootPins) { const approval = await verifyApprovedOtelPackageSet(); if (!await exactRootPins()) throw new Error("ROOT_PINS_INVALID"); await verifyCurrentSmokeRecord(approval); console.log(JSON.stringify({ status: "passed", mode: "root-pins", ...approval })); return; }
  if (runSmoke) { console.log(JSON.stringify({ status: "passed", mode: "bun-collector-smoke", ...await smoke() })); return; }
  if (offline || pointerOnly) { await verifyPointer(); console.log(JSON.stringify({ status: "passed", mode: "offline-fixture", approvalStatus: "pending_human" })); return; }
  if (!preinstall) throw new Error("mode=preinstall is required");
  const audit = await verifyOfficialOtelPackageSet(); if (audit.status !== "passed") { console.error(JSON.stringify(audit)); process.exitCode = 1; return; }
  console.log(JSON.stringify({ ...await writeAuditEvidence(audit), status: audit.status, approvalStatus: audit.approvalStatus }));
}

if (import.meta.main) { try { await main(); } catch (error) { console.error(error instanceof Error ? error.message : "OTEL_AUDIT_FAILED"); process.exitCode = 1; } }
