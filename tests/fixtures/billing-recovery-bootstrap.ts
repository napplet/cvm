import { mock } from "bun:test";
import * as fs from "node:fs/promises";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { z } from "zod";

// This child is intentionally isolated: module substitutions affect only the
// filesystem mount and native SQL/HTTP/ADC drivers, never the production loader,
// mounted material parser, factory, controller, reporter, or journal classes.
const files = { ...fs };
const scenario = process.argv[2] ?? "completed";
const repositoryRoot = resolve(import.meta.dir, "../..");
const base = join(repositoryRoot, ".runtime/release-certification/native-discovery-v1");
await files.mkdir(base, { recursive: true });
const workspace = await files.mkdtemp(join(base, "mounted-recovery-proof-"));
let now = Date.now();
Date.now = () => now;
const effects = { pools: 0, closes: 0, adc: 0, queryGets: 0, queryPosts: 0, objectReads: 0, objectWrites: 0, journalWrites: 0, captures: 0, secretReads: [] as string[] };
const rows = new Map<string, Record<string, unknown>>();
const captures = new Map<string, Record<string, unknown>>();
const objects = new Map<string, Readonly<{ bytes: Uint8Array; sha256: string }>>();
const projectId = "napplet-cvm-01";
const principal = "release-runner@napplet-cvm-01.iam.gserviceaccount.com";
const key = (values: readonly unknown[]) => JSON.stringify(values.slice(0, 3));
const journalKeys = z.tuple([z.string(), z.string(), z.string()]);

mock.module("node:fs/promises", () => ({
  ...files,
  async readFile(path: unknown, encoding?: unknown) {
    let target = path instanceof URL ? fileURLToPath(path) : z.string().parse(path);
    if (target.startsWith("/var/run/secrets/napplet-cvm/")) {
      const name = target.slice("/var/run/secrets/napplet-cvm/".length);
      if (!["cert_request", "cert_receipt", "cert_session", "sql_runtime"].includes(name)) throw new Error("UNEXPECTED_SECRET_ACCESS");
      effects.secretReads.push(name);
      target = join(workspace, "fixture-mount", name);
    }
    if (encoding === undefined) return files.readFile(target);
    if (encoding === "utf8" || encoding === "utf-8") return files.readFile(target, "utf8");
    throw new Error("UNEXPECTED_FILE_ENCODING");
  },
}));

function client() {
  let role = "napplet_cvm_runtime";
  return {
    async query(text: string, values: readonly unknown[] = []) {
      if (text.startsWith("SELECT current_user")) return { rows: [{ current_user: role, session_user: "napplet_cvm_runtime", current_is_superuser: false, session_is_superuser: false, current_schema: "production_real" }], rowCount: 1 };
      if (text === "SET ROLE napplet_production_real") { role = "napplet_production_real"; return { rows: [], rowCount: 0 }; }
      if (/^(?:BEGIN|COMMIT|ROLLBACK|SET LOCAL|SET search_path)/u.test(text)) return { rows: [], rowCount: 0 };
      if (text.startsWith("INSERT INTO production_real.release_operation_journal")) {
        const [namespace, scope, operation] = journalKeys.parse(values.slice(0, 3));
        const identity = z.string().parse(values[3]);
        const value = JSON.parse(z.string().parse(values[4]));
        const id = key(values);
        if (rows.has(id)) return { rows: [], rowCount: 0 };
        const row = { namespace, scope_sha256: scope, operation_id: operation, identity_sha256: identity, revision: 1, value_json: value };
        rows.set(id, row); effects.journalWrites++;
        return { rows: [structuredClone(row)], rowCount: 1 };
      }
      if (text.startsWith("SELECT * FROM production_real.release_operation_journal")) {
        const row = rows.get(key(values));
        return { rows: row ? [structuredClone(row)] : [], rowCount: row ? 1 : 0 };
      }
      if (text.startsWith("UPDATE production_real.release_operation_journal")) {
        const row = rows.get(key(values));
        if (!row || row.identity_sha256 !== values[3] || Number(row.revision) !== values[4]) return { rows: [], rowCount: 0 };
        row.revision = Number(row.revision) + 1; row.value_json = JSON.parse(z.string().parse(values[5])); effects.journalWrites++;
        return { rows: [structuredClone(row)], rowCount: 1 };
      }
      if (text.startsWith("INSERT INTO production_real.authoritative_usage_report_capture")) {
        const request = z.string().parse(values[0]);
        if (captures.has(request)) return { rows: [], rowCount: 0 };
        captures.set(request, { report_request_sha256: request, grant_sha256: values[1], operation_record_sha256: values[2], provider_job_id: values[3], artifact_uri: values[4], artifact_generation: values[5], raw_report_sha256: values[6], envelope_json: JSON.parse(z.string().parse(values[7])) });
        effects.captures++;
        return { rows: [{ report_request_sha256: request }], rowCount: 1 };
      }
      if (text.startsWith("SELECT grant_sha256,operation_record_sha256")) {
        const row = captures.get(z.string().parse(values[0]));
        return { rows: row ? [structuredClone(row)] : [], rowCount: row ? 1 : 0 };
      }
      throw new Error(`UNEXPECTED_RECOVERY_SQL:${text.split(" ").slice(0, 4).join(" ")}`);
    },
    release() {},
  };
}
const nativePg = await import("pg");
mock.module("pg", () => ({ ...nativePg, Pool: class {
  #closed = false;
  constructor(options: unknown) {
    const parsed = z.object({ host: z.literal("10.0.0.9"), user: z.literal("napplet_cvm_runtime"), database: z.literal("production_real"), ssl: z.object({ rejectUnauthorized: z.literal(true), servername: z.literal("release-sql.internal") }).strict() }).passthrough().parse(options);
    if (parsed.host !== "10.0.0.9") throw new Error("INVALID_SQL_FIXTURE");
    effects.pools++;
  }
  async connect() { if (this.#closed) throw new Error("CLOSED_POOL"); return client(); }
  async end() { if (this.#closed) throw new Error("POOL_CLOSED_TWICE"); this.#closed = true; effects.closes++; }
} }));
const nativeAuth = await import("google-auth-library");
mock.module("google-auth-library", () => ({ ...nativeAuth, GoogleAuth: class {
  async getProjectId() { effects.adc++; return projectId; }
  async getCredentials() { effects.adc++; return { client_email: principal, quota_project_id: projectId }; }
  async getClient() {
    effects.adc++;
    return { credentials: { expiry_date: now + 3_600_000 },
      async getAccessToken() { effects.adc++; return { token: "offline-report-token-never-logged" }; },
      async getTokenInfo() { effects.adc++; return { scopes: ["https://www.googleapis.com/auth/cloud-platform"], expiry_date: now + 3_600_000, email: principal }; },
    };
  }
} }));

let seed = true;
const observedFetch = mock(async (input: string | URL | Request, init: RequestInit = {}) => {
  const url = new URL(input instanceof Request ? input.url : input.toString());
  const method = init.method ?? "GET";
  if (url.origin === "https://bigquery.googleapis.com") {
    if (method === "POST") {
      effects.queryPosts++;
      if (!seed) throw new Error("RECOVERY_ATTEMPTED_PAID_QUERY");
      const body = z.object({ jobReference: z.object({ projectId: z.string(), jobId: z.string(), location: z.string() }), configuration: z.object({ dryRun: z.boolean(), query: z.object({}).passthrough() }) }).parse(JSON.parse(z.string().parse(init.body)));
      return Response.json({ jobReference: body.jobReference, statistics: { totalBytesProcessed: "10" } });
    }
    if (method !== "GET" || !url.pathname.includes("/queries/")) throw new Error("UNEXPECTED_QUERY_EFFECT");
    effects.queryGets++;
    return Response.json({ kind: "bigquery#getQueryResultsResponse", jobComplete: !seed, jobReference: { projectId, jobId: url.pathname.split("/").at(-1), location: "US" }, totalRows: "1", totalBytesProcessed: "10", rows: [{ f: [{ v: "1.000000" }, { v: "0.000000" }] }] });
  }
  if (url.origin !== "https://storage.googleapis.com") throw new Error(`UNEXPECTED_NETWORK_ORIGIN:${url.origin}`);
  if (method === "POST" && url.pathname.startsWith("/upload/")) {
    effects.objectWrites++;
    if (url.searchParams.get("ifGenerationMatch") !== "0" || !(init.body instanceof Uint8Array)) throw new Error("UNBOUNDED_OBJECT_WRITE");
    const boundary = new Headers(init.headers).get("content-type")?.split("boundary=")[1];
    if (!boundary) throw new Error("MULTIPART_BOUNDARY_REQUIRED");
    const text = new TextDecoder().decode(init.body);
    const metadataStart = text.indexOf("\r\n\r\n") + 4;
    const metadataEnd = text.indexOf(`\r\n--${boundary}`, metadataStart);
    const metadata = z.object({ name: z.string(), metadata: z.object({ sha256: z.string() }) }).parse(JSON.parse(text.slice(metadataStart, metadataEnd)));
    const bytesStart = text.indexOf("\r\n\r\n", metadataEnd) + 4;
    const bytesEnd = text.lastIndexOf(`\r\n--${boundary}--`);
    if (objects.has(metadata.name)) return new Response(null, { status: 412 });
    objects.set(metadata.name, { bytes: new TextEncoder().encode(text.slice(bytesStart, bytesEnd)), sha256: metadata.metadata.sha256 });
    return Response.json({ generation: "1", metadata: metadata.metadata });
  }
  if (method !== "GET") throw new Error("RECOVERY_ATTEMPTED_OBJECT_MUTATION");
  effects.objectReads++;
  const object = objects.get(decodeURIComponent(url.pathname.split("/o/")[1] ?? ""));
  if (!object || (url.searchParams.has("generation") && url.searchParams.get("generation") !== "1")) return new Response(null, { status: 404 });
  return url.searchParams.get("alt") === "media"
    ? new Response(new Uint8Array(object.bytes), { headers: { "x-goog-generation": "1" } })
    : Response.json({ generation: "1", metadata: { sha256: object.sha256 } });
});
const originalFetch = globalThis.fetch;
globalThis.fetch = Object.assign(observedFetch, { preconnect: originalFetch.preconnect });

try {
  const { mountedBillingRecoveryFixture, recoveryFixtureDigest: digest } = await import("../release/helpers/mounted-billing-recovery-fixture");
  const fixture = await mountedBillingRecoveryFixture(workspace, now);
  const { PostgresOperationJournal } = await import("../../src/release/deployment/postgres-operation-journal");
  const { createPostgresGoogleOperationJournal } = await import("../../src/release/deployment/postgres-provider-journals");
  const { createMountedBigQueryUsageReporter } = await import("../../src/production/mounted-authoritative-billing");
  const { createGoogleAdcTokenSource } = await import("../../src/release/deployment/google-auth");
  const { GcsObjectStoreAdapter } = await import("../../src/continuity/object-store");
  const { createProductionGcsObjectClient } = await import("../../src/production/gcs-object-client");
  const { googleOperationLabel } = await import("../../src/release/deployment/google-operation-id");
  const { loadCertifierConfig } = await import("../../src/certification/config");
  const { loadReleaseAuthoritativeUsageRecoverySession } = await import("../../src/release/production-execution");
  const { ReleaseProviderOperationSchema } = await import("../../src/release/providers");
  const { RELEASE_WORKSPACE_ENV } = await import("../../src/release/controller");
  const { scriptedSqlPool } = await import("./scripted-sql-pool");
  const recordSchema = z.object({ operation: ReleaseProviderOperationSchema, recordSha256: z.string(), resourceIdentitySha256: z.string(), accountScopeSha256: z.string(), projectScopeSha256: z.string() }).passthrough();
  const records = await Promise.all((fixture.state.providerOperationRecordSha256s ?? []).map(async sha => recordSchema.parse(JSON.parse(await files.readFile(join(workspace, "provider-operation-records", `${sha}.json`), "utf8")))));
  const record = records.find(value => value.operation.provider === "cloud_run");
  if (!record) throw new Error("COMPLETED_OPERATION_REQUIRED");
  const captureInput = { operation: record.operation, operationRecordSha256: record.recordSha256, resourceIdentitySha256: record.resourceIdentitySha256, candidateSha256: fixture.candidateSha256, authorizationRequestSha256: fixture.request.authorizationRequestSha256, authorizationReceiptSha256: fixture.receipt.authorizationReceiptSha256, accountScopeSha256: record.accountScopeSha256, projectScopeSha256: record.projectScopeSha256, billingObservation: fixture.report };
  const seedClient = client();
  const pool = scriptedSqlPool((text, values) => seedClient.query(text, values));
  const googleJournal = createPostgresGoogleOperationJournal(new PostgresOperationJournal(pool, { namespace: "production-google-control", scopeSha256: fixture.topologySha256 }));
  const operationId = googleOperationLabel(record.operation.operationId);
  await googleJournal.claim({ operationId, resource: `projects/${projectId}/locations/us-central1/services/release`, requestSha256: digest("native-request"), contentSha256: digest("native-content"), owned: false });
  await googleJournal.markCompleted({ operationId, requestSha256: digest("native-request"), createTime: new Date(now - 60_000).toISOString(), resourceUid: "release-uid", owned: true });
  const tokenSource = createGoogleAdcTokenSource({ projectId, quotaProjectId: projectId, principal, accountScopeSha256: fixture.accountScopeSha256 });
  const { allowedReportOrigin: _origin, expiresAtMs: _expires, ...reportConfiguration } = fixture.report;
  const reporter = createMountedBigQueryUsageReporter({ configuration: reportConfiguration, projectId, quotaProjectId: projectId, principal, accountScopeSha256: fixture.accountScopeSha256, tokenSource, googleJournal, billingJournal: new PostgresOperationJournal(pool, { namespace: "production-authoritative-usage", scopeSha256: fixture.topologySha256 }), pool, objects: new GcsObjectStoreAdapter({ config: { bucket: fixture.config.gcs.bucket, projectId }, client: createProductionGcsObjectClient({ bucket: fixture.config.gcs.bucket, tokenSource }) }), bucket: fixture.config.gcs.bucket });
  await reporter.capture(captureInput);
  if (effects.queryPosts !== 2) throw new Error("ORIGINAL_QUERY_SEED_REQUIRED");
  seed = false;
  now = fixture.request.expiresAtMs + 1_000;
  effects.pools = effects.closes = effects.adc = effects.queryGets = effects.queryPosts = effects.objectReads = effects.objectWrites = effects.journalWrites = effects.captures = 0;
  effects.secretReads.length = 0;
  if (["missing-grant", "mode-override"].includes(scenario)) for (const [id, row] of rows) if (String(row.operation_id).startsWith("authoritative-usage-grant:")) rows.delete(id);
  if (scenario === "missing-job") for (const [id, row] of rows) if (String(row.operation_id).startsWith("authoritative-usage:")) rows.delete(id);
  if (scenario === "grant-tampered") for (const row of rows.values()) if (String(row.operation_id).startsWith("authoritative-usage-grant:")) {
    const value = z.object({ version: z.literal(1), grant: z.record(z.string(), z.unknown()) }).parse(row.value_json);
    row.value_json = { ...value, grant: { ...value.grant, grantSha256: digest("tampered-grant") } };
  }
  if (scenario === "expired-grant") now = fixture.report.expiresAtMs;
  if (scenario === "receipt-integrity") await files.writeFile(join(workspace, "fixture-mount/cert_receipt"), JSON.stringify({ ...fixture.receipt, authorizationReceiptSha256: digest("tampered-receipt") }));
  if (scenario === "account") await files.writeFile(join(workspace, "fixture-mount/cert_session"), JSON.stringify({ ...fixture.measured, discoveries: { ...fixture.measured.discoveries, cloud_run: { ...fixture.measured.discoveries.cloud_run, accountScopeSha256: digest("other-account") }, cloud_sql_postgres: { ...fixture.measured.discoveries.cloud_sql_postgres, accountScopeSha256: digest("other-account") } } }));
  if (scenario === "configuration") await files.appendFile(fixture.runtimeConfigPath, " ");
  if (scenario === "candidate") {
    const config = JSON.parse(await files.readFile(fixture.certifierPath, "utf8"));
    config.controller.candidateId = digest("other-candidate");
    const bytes = JSON.stringify(config);
    await files.writeFile(fixture.certifierPath, bytes); fixture.certifierSha256 = digest(bytes);
  }
  process.env.NAPPLET_CVM_CERTIFIER_CONFIG = fixture.certifierPath;
  process.env.NAPPLET_CVM_CERTIFIER_CONFIG_SHA256 = fixture.certifierSha256;
  process.env[RELEASE_WORKSPACE_ENV] = workspace;
  if (scenario === "completed" || scenario === "mode-override") {
    const configuration = await loadCertifierConfig();
    const session = await loadReleaseAuthoritativeUsageRecoverySession({ config: configuration, candidateSha256: fixture.candidateSha256, workspace });
    const prepared = await session.prepareAuthoritativeUsageRecovery({ authorizationRequest: fixture.request });
    if (Reflect.has(prepared.reporter, "capture") || Object.keys(prepared.reporter).sort().join(",") !== "readArtifact,recover") throw new Error("RECOVERY_EXPOSED_DISPATCH");
    if (scenario === "mode-override") {
      const malicious = { ...captureInput, mode: "dispatch" };
      if ((await prepared.reporter.recover(malicious)).status !== "held") throw new Error("RECOVERY_MODE_ESCALATED");
    }
    await prepared.close?.();
  }
  process.argv = [process.execPath, join(repositoryRoot, "scripts/certify-release.ts"), "--candidate", fixture.candidatePath];
  await import("../../scripts/certify-release");
  const cliExitCode = Number(process.exitCode ?? 0);
  const storedCaptures = await files.readdir(join(workspace, "billing-report-captures")).catch(() => []);
  console.log(`BOOTSTRAP_PROOF_RESULT=${JSON.stringify({ scenario, cliExitCode, effects, captureFiles: storedCaptures.length, captureRows: captures.size })}`);
  process.exitCode = 0;
} finally {
  globalThis.fetch = originalFetch;
  await files.rm(workspace, { recursive: true, force: true });
}
