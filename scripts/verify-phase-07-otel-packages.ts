import { createHash } from "node:crypto";
import { mkdtemp, mkdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import { dirname, join, relative } from "node:path";
import { tmpdir } from "node:os";
import { z } from "zod";
import { canonicalJson } from "../src/promotion/schema";

const REGISTRY = "https://registry.npmjs.org";
const OFFICIAL_REPOSITORY = "https://github.com/open-telemetry/opentelemetry-js";
const OFFICIAL_DOCUMENTATION = "https://opentelemetry.io/docs/languages/js/exporters/";
const CERTIFICATION_DIRECTORY = "evidence/certification";
const POINTER_PATH = `${CERTIFICATION_DIRECTORY}/phase-07-otel-package-audit.json`;
const RECORD_DIRECTORY = `${CERTIFICATION_DIRECTORY}/otel-package-audits`;
const SMOKE_DIRECTORY = `${CERTIFICATION_DIRECTORY}/otel-package-smokes`;
const FORBIDDEN_LIFECYCLE_SCRIPTS = new Set(["preinstall", "install", "postinstall", "prepare"]);
const APPROVED_AUDIT_DIGEST = "d7fedf16f62e4088cf17442aa39786c33bb4af8f3377e8d121d76b108eaf22b3";
const COLLECTOR_IMAGE = "otel/opentelemetry-collector:latest";
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

const SmokeRecordSchema = z.object({
  schemaVersion: z.literal(1), status: z.enum(["passed", "failed", "blocked"]), mode: z.literal("bun-collector-smoke"),
  approvedAuditDigest: z.literal(APPROVED_AUDIT_DIGEST), bunVersion: z.string().min(1),
  packages: z.array(z.object({ name: z.string(), version: z.string() })).length(6),
  collectorImageDigest: z.string().regex(/^otel\/opentelemetry-collector@sha256:[a-f0-9]{64}$/u).optional(),
  collectorConfigSha256: z.string().regex(/^[a-f0-9]{64}$/u), otlpEndpoint: z.literal("http/protobuf /v1/traces,/v1/metrics"),
  outputSha256: z.string().regex(/^[a-f0-9]{64}$/u).optional(), limitations: z.array(z.string()).min(1),
  inputDigests: z.object({ packageJsonSha256: z.string().regex(/^[a-f0-9]{64}$/), bunLockSha256: z.string().regex(/^[a-f0-9]{64}$/) }),
  errorCode: z.string().regex(/^[A-Z0-9_]+$/u).optional(), evidenceSha256: z.string().regex(/^[a-f0-9]{64}$/).optional(),
}).strict();

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
async function rootPins(): Promise<Record<string, unknown>> { return safeJson(JSON.parse(await readFile("package.json", "utf8"))); }
async function exactRootPins(): Promise<boolean> {
  const dependencies = (await rootPins()).dependencies;
  if (!isRecord(dependencies)) return false;
  return OFFICIAL_OTEL_PACKAGES.every((item) => dependencies[item.name] === item.version);
}
async function approvedAudit(): Promise<void> {
  await verifyPointer();
  const pointer = safeJson(JSON.parse(await readFile(POINTER_PATH, "utf8")));
  if (pointer.evidenceSha256 !== APPROVED_AUDIT_DIGEST) throw new Error("APPROVAL_DIGEST_DRIFT");
  const record = safeJson(JSON.parse(await readFile(join(CERTIFICATION_DIRECTORY, String(pointer.record)), "utf8")));
  const packages = Array.isArray(record.packages) ? record.packages : [];
  if (packages.length !== OFFICIAL_OTEL_PACKAGES.length || OFFICIAL_OTEL_PACKAGES.some((expected) => !packages.some((value) => isRecord(value) && value.name === expected.name && value.version === expected.version && value.registryIntegrity === expected.integrity && value.verdict === "passed"))) throw new Error("APPROVED_PACKAGE_SET_DRIFT");
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
  const inputDigests = { packageJsonSha256: await snapshot(join(root, "package.json")), bunLockSha256: await snapshot(join(root, "bun.lock")) };
  const collectorConfigSha256 = await snapshot(join(root, "infra/otel/collector.yaml"));
  const base = { schemaVersion: 1 as const, mode: "bun-collector-smoke" as const, approvedAuditDigest: APPROVED_AUDIT_DIGEST, bunVersion: Bun.version, packages: OFFICIAL_OTEL_PACKAGES.map(({ name, version }) => ({ name, version })), collectorConfigSha256, otlpEndpoint: "http/protobuf /v1/traces,/v1/metrics" as const, inputDigests, limitations: ["Certification smoke sends only fixed finite attributes to a local Collector debug sink.", "This is package and protocol compatibility evidence, not live service certification."], };
  let temp = ""; let container = "";
  try {
    await approvedAudit();
    const dockerReady = await run(["docker", "info", "--format", "{{.ServerVersion}}"]);
    if (dockerReady.code !== 0) throw new Error("DOCKER_UNAVAILABLE");
    const pull = await run(["docker", "pull", COLLECTOR_IMAGE]);
    if (pull.code !== 0) throw new Error("COLLECTOR_PULL_FAILED");
    const digest = (await run(["docker", "image", "inspect", COLLECTOR_IMAGE, "--format", "{{index .RepoDigests 0}}"])) .stdout.trim();
    if (!/^otel\/opentelemetry-collector@sha256:[a-f0-9]{64}$/u.test(digest)) throw new Error("COLLECTOR_DIGEST_INVALID");
    const config = join(root, "infra/otel/collector.yaml");
    const started = await run(["docker", "run", "-d", "--rm", "-p", "127.0.0.1::4318", "-v", `${config}:/etc/otelcol/config.yaml:ro`, digest, "--config=/etc/otelcol/config.yaml"]);
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
    const record = await writeSmokeRecord({ ...base, status: "passed", collectorImageDigest: digest, outputSha256: sha256(output) });
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
  const pointerContent = `${canonicalJson(pointer)}\n`; const temporary = `${POINTER_PATH}.tmp`;
  await mkdir(dirname(POINTER_PATH), { recursive: true }); await writeFile(temporary, pointerContent, "utf8"); await rename(temporary, POINTER_PATH);
  await verifyPointer(); return { evidenceSha256, recordPath };
}

export async function verifyPointer(): Promise<void> {
  const pointer = safeJson(JSON.parse(await readFile(POINTER_PATH, "utf8")));
  if (pointer.schemaVersion !== 1 || pointer.approvalStatus !== "pending_human" || pointer.status !== "passed" || typeof pointer.evidenceSha256 !== "string" || !/^[a-f0-9]{64}$/u.test(pointer.evidenceSha256) || typeof pointer.record !== "string" || pointer.record.includes("..")) throw new Error("AUDIT_POINTER_INVALID");
  const recordPath = join(CERTIFICATION_DIRECTORY, pointer.record); const record = safeJson(JSON.parse(await readFile(recordPath, "utf8"))); const { evidenceSha256, ...audit } = record;
  if (evidenceSha256 !== pointer.evidenceSha256 || sha256(canonicalJson(audit)) !== pointer.evidenceSha256) throw new Error("AUDIT_POINTER_DIGEST_MISMATCH");
  const parsed = OtelPackageAuditSchema.parse(audit); if (parsed.status !== "passed" || parsed.approvalStatus !== "pending_human" || parsed.packages.some((entry) => entry.disposition === "SUS" && entry.verdict !== "passed")) throw new Error("AUDIT_POINTER_NONPASS");
}

async function main(): Promise<void> {
  const args = Bun.argv.slice(2); const offline = args.includes("--offline-fixture"); const pointerOnly = args.includes("--verify-pointer"); const preinstall = args.includes("--mode=preinstall"); const requireApproved = args.includes("--require-approved"); const verifyRootPins = args.includes("--verify-root-pins"); const runSmoke = args.includes("--bun-collector-smoke");
  if (args.length === 0 || args.some((argument) => !["--mode=preinstall", "--offline-fixture", "--verify-pointer", "--require-approved", "--verify-root-pins", "--bun-collector-smoke"].includes(argument)) || [offline, pointerOnly, preinstall, requireApproved, verifyRootPins, runSmoke].filter(Boolean).length > 1) throw new Error("usage: --mode=preinstall | --offline-fixture | --verify-pointer | --require-approved | --verify-root-pins | --bun-collector-smoke");
  if (requireApproved) { await approvedAudit(); console.log(JSON.stringify({ status: "passed", mode: "approved-audit", evidenceSha256: APPROVED_AUDIT_DIGEST })); return; }
  if (verifyRootPins) { await approvedAudit(); if (!await exactRootPins()) throw new Error("ROOT_PINS_INVALID"); console.log(JSON.stringify({ status: "passed", mode: "root-pins" })); return; }
  if (runSmoke) { console.log(JSON.stringify({ status: "passed", mode: "bun-collector-smoke", ...await smoke() })); return; }
  if (offline || pointerOnly) { await verifyPointer(); console.log(JSON.stringify({ status: "passed", mode: "offline-fixture", approvalStatus: "pending_human" })); return; }
  if (!preinstall) throw new Error("mode=preinstall is required");
  const audit = await verifyOfficialOtelPackageSet(); if (audit.status !== "passed") { console.error(JSON.stringify(audit)); process.exitCode = 1; return; }
  console.log(JSON.stringify({ ...await writeAuditEvidence(audit), status: audit.status, approvalStatus: audit.approvalStatus }));
}

if (import.meta.main) { try { await main(); } catch (error) { console.error(error instanceof Error ? error.message : "OTEL_AUDIT_FAILED"); process.exitCode = 1; } }
