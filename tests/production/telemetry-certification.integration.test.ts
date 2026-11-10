import { expect, test } from "bun:test";
import { createRequire } from "node:module";
import { ProductionTelemetryCertification } from "../../src/production/telemetry-certification";
import { PostgresOperationJournal } from "../../src/release/deployment/postgres-operation-journal";
import { createAuthorizationRequest, createAuthorizationReceipt } from "../../src/release/authorization";
import { LifecycleStageSchema } from "../../src/telemetry/contracts";

const digest = "a".repeat(64), scope = "b".repeat(64);
const binding = { candidateId: digest, topologySha256: scope, datasetSha256: "c".repeat(64), profileSha256: "d".repeat(64), collectorDigest: `sha256:${"e".repeat(64)}`, configSha256: "f".repeat(64) };
const deployment = { projectId: "collector-project", region: "europe-west1", serviceName: "cvm-collector", revisionName: "cvm-collector-00001-abc", endpoint: "https://cvm-collector-example.run.app", imageReference: `registry.example/collector@${binding.collectorDigest}`, accountScopeSha256: scope, projectScopeSha256: scope, principal: "cvm@collector-project.iam.gserviceaccount.com" };
const deny = async () => { throw new Error("UNEXPECTED_IO"); };
test("telemetry rejects invalid authority and origin before SQL, token or network", async () => {
  let calls = 0;
  const journal = new PostgresOperationJournal({ async connect() { calls++; return deny(); } }, { namespace: "collector-test", scopeSha256: scope });
  const input = { binding, deployment, journal, authorization: { request: {}, receipt: {} }, identity: { async token() { calls++; return deny(); } }, tokenSource: { async getAccessToken() { calls++; return deny(); } }, fetch: async () => { calls++; return deny(); } };
  const service = new ProductionTelemetryCertification(input);
  await expect(service.emitTelemetry({ operationId: "emit-one", observation: {} })).rejects.toThrow();
  expect(calls).toBe(0);
  expect(() => new ProductionTelemetryCertification({ ...input, deployment: { ...deployment, endpoint: "http://localhost:4318" } })).toThrow("COLLECTOR_ORIGIN_INVALID");
  expect(calls).toBe(0);
});

const integration = process.env.NAPPLET_RUN_COLLECTOR_INTEGRATION === "1" ? test : test.skip;
integration("actual collector + restricted PostgreSQL recover lost ACK by authenticated query without redispatch", async () => {
  const previous = process.env.NAPPLET_CVM_TEST_EXTERNAL_EFFECTS;
  process.env.NAPPLET_CVM_TEST_EXTERNAL_EFFECTS = "deny";
  const name = `cvm-telemetry-${process.pid}-${Date.now()}`, pgName = `${name}-pg`, tag = `${name}:test`;
  const docker = async (...args: string[]) => {
    const child = Bun.spawn(["docker", ...args], { stdout: "pipe", stderr: "pipe" });
    const timer = setTimeout(() => child.kill(), 60_000);
    try { const [code, out, err] = await Promise.all([child.exited, new Response(child.stdout).text(), new Response(child.stderr).text()]); if (code) throw new Error(`DOCKER_${args[0]}:${err.slice(-1000)}`); return `${out}\n${err}`.trim(); }
    finally { clearTimeout(timer); }
  };
  const { Pool } = createRequire(import.meta.url)("pg");
  let admin: any, application: any, collectorStarted = false, pgStarted = false;
  try {
    await docker("build", "-f", "infra/production/collector.Dockerfile", "-t", tag, ".");
    await docker("run", "-d", "--name", name, "--read-only", "--cap-drop=ALL", "--security-opt=no-new-privileges", "--memory=128m", "--cpus=1", "-p", "127.0.0.1::4318", tag); collectorStarted = true;
    const collector = `http://${await docker("port", name, "4318/tcp")}`;
    await docker("run", "-d", "--name", pgName, "--publish", "127.0.0.1::5432", "-e", "POSTGRES_HOST_AUTH_METHOD=trust", "postgres:17-alpine"); pgStarted = true;
    const port = (await docker("port", pgName, "5432/tcp")).match(/127\.0\.0\.1:(\d+)/u)![1];
    admin = new Pool({ connectionString: `postgresql://postgres@127.0.0.1:${port}/postgres`, connectionTimeoutMillis: 2000 });
    for (let attempt = 0; ; attempt++) { try { await admin.query("SELECT 1"); break; } catch (error) { if (attempt === 59) throw error; await Bun.sleep(100); } }
    for (const path of ["phase-03/001_funding.sql", "phase-04/001_metered_generation.sql", "phase-04/002_action_budget_lifecycle.sql", "phase-05/001_continuation.sql", "phase-06/001_publication.sql", "phase-03/002_production_accounting.sql", "phase-03/003_cashu_custody_and_identities.sql", "phase-03/004_production_rail_material_scope.sql", "phase-07/001_production_operation_journal.sql"]) await admin.query(await Bun.file(`migrations/${path}`).text());
    await admin.query("CREATE ROLE collector_test LOGIN"); await admin.query("GRANT napplet_production_real TO collector_test");
    application = new Pool({ connectionString: `postgresql://collector_test@127.0.0.1:${port}/postgres`, connectionTimeoutMillis: 2000 });
    const now = Date.now(); let clock = now;
    const request = await createAuthorizationRequest({ candidateSha256: digest, topologySha256: scope, effectPlanSha256: scope, controllerStateSha256: scope, providerCapabilitiesSha256: scope,
      orderedEffects: [{ id: "collector-window", provider: "collector", operation: "configure", estimatedCostMicros: 1 }], providerScopes: [{ provider: "collector", accountScopeSha256: scope, projectScopeSha256: scope }],
      estimate: { currency: "USD", maximumMicros: 1, sourceId: "contract-test", observedAtMs: now - 1000, freshUntilMs: now + 120_000 }, maximumRunDurationMs: 60_000, cleanupByMs: now + 55_000, evidenceRetentionDays: 30, artifactRetentionDays: 30, gcpEffects: { projectBootstrap: false, billing: false, apiEnablement: ["run.googleapis.com", "logging.googleapis.com"] }, expiresAtMs: now + 60_000 });
    const receipt = await createAuthorizationReceipt(request);
    let posts = 0, lostAck = true, logReads = 0, invalidRevision = false, wrongLogResource = false;
    const revisionResource = `projects/${deployment.projectId}/locations/${deployment.region}/services/${deployment.serviceName}`;
    // Google API protocol fixture wraps actual exported collector JSON. This
    // tests the mechanism, and is deliberately not live-cloud certification.
    const transport = async (url: string, init: RequestInit) => {
      expect(init.redirect).toBe("error");
      if (url.startsWith(deployment.endpoint + "/v1/")) {
        expect(new Headers(init.headers).get("authorization")).toBe(`Bearer ${"i".repeat(32)}`);
        posts++;
        const response = await fetch(url.replace(deployment.endpoint, collector), init);
        if (posts === 30 && lostAck) { lostAck = false; await response.text(); throw new Error("ACK_LOST_AFTER_COLLECTOR_ACCEPTED"); }
        return response;
      }
      expect(new Headers(init.headers).get("authorization")).toBe(`Bearer ${"g".repeat(32)}`);
      if (url === `https://run.googleapis.com/v2/${revisionResource}/revisions/${deployment.revisionName}`) return Response.json({ name: `${revisionResource}/revisions/${deployment.revisionName}`, service: revisionResource, reconciling: false, containers: [{ image: invalidRevision ? "registry.example/other@sha256:" + scope : deployment.imageReference, ports: [{ containerPort: 4318 }] }], conditions: [{ type: "Ready", state: "CONDITION_SUCCEEDED" }] });
      if (url === `https://run.googleapis.com/v2/${revisionResource}`) return Response.json({ name: revisionResource, uri: deployment.endpoint, ingress: "INGRESS_TRAFFIC_INTERNAL_LOAD_BALANCER", reconciling: false, terminalCondition: { state: "CONDITION_SUCCEEDED" }, trafficStatuses: [{ revision: deployment.revisionName, percent: 100 }] });
      if (url === `https://run.googleapis.com/v2/${revisionResource}:getIamPolicy`) return Response.json({ bindings: [{ role: "roles/run.invoker", members: [`serviceAccount:${deployment.principal}`] }] });
      if (url === "https://logging.googleapis.com/v2/entries:list") {
        logReads++; const body = JSON.parse(String(init.body));
        expect(body.resourceNames).toEqual([`projects/${deployment.projectId}`]);
        expect(body.filter).toContain(`resource.labels.revision_name="${deployment.revisionName}"`);
        if (!body.pageToken) return Response.json({ entries: [], nextPageToken: "empty-first-page" });
        expect(body.pageToken).toBe("empty-first-page");
        const logs = (await docker("logs", name)).split("\n").filter(line => line.startsWith("{")).map(line => JSON.parse(line)).filter(entry => entry["otelcol.component.id"] === "debug" && (entry.ts === undefined || Date.parse(entry.ts) >= request.estimateObservedAtMs));
        return Response.json({ entries: logs.map(jsonPayload => ({ jsonPayload, timestamp: jsonPayload.ts ?? new Date().toISOString(), resource: { type: "cloud_run_revision", labels: { project_id: deployment.projectId, location: deployment.region, service_name: deployment.serviceName, revision_name: wrongLogResource ? "wrong-revision" : deployment.revisionName } } })) });
      }
      throw new Error("UNEXPECTED_ORIGIN");
    };
    const open = () => new ProductionTelemetryCertification({ binding, deployment, authorization: { request, receipt }, journal: new PostgresOperationJournal(application, { namespace: "collector-original", scopeSha256: scope }), identity: { async token(audience) { expect(audience).toBe(deployment.endpoint); return "i".repeat(32); } }, tokenSource: { async getAccessToken() { return { token: "g".repeat(32), projectId: deployment.projectId, quotaProjectId: deployment.projectId, principal: deployment.principal, accountScopeSha256: scope, scopes: ["https://www.googleapis.com/auth/cloud-platform"], expiresAtMs: clock + 120_000 }; } }, fetch: transport, now: () => clock });
    const observations = LifecycleStageSchema.options.map((stage, i) => ({ operationId: `original-${stage}`, observation: { version: "admission-lifecycle-v1", correlationDigest: `sha256:${digest}`, stage, outcome: "succeeded", monotonicMs: i + 1 } }));
    for (const observation of observations.slice(0, -1)) await open().emitTelemetry(observation);
    await expect(open().emitTelemetry(observations.at(-1)!)).rejects.toThrow("ACK_LOST");
    expect(posts).toBe(30);
    const rowsBefore = (await admin.query("SELECT count(*)::int AS count FROM production_real.release_operation_audit")).rows[0].count;
    let result: any;
    for (let attempt = 0; ; attempt++) { try { result = await open().telemetryWindow({ operationId: "window-original", binding }); break; } catch (error) { if (attempt === 30) throw error; await Bun.sleep(100); } }
    expect(result.status).toBe("observed"); expect(result.observations).toHaveLength(15); expect(result.metricSeriesCount).toBe(15); expect(result.rejectedCanaries).toBe(true);
    // Fresh constructor reconciles original data, including after expiry.
    clock = request.expiresAtMs + 1;
    expect(await open().observeEmission(observations.at(-1)!)).toEqual({ status: "observed" });
    await expect(open().emitTelemetry(observations.at(-1)!)).rejects.toThrow("EXPIRED");
    expect(posts).toBe(30); expect(logReads).toBeGreaterThanOrEqual(4);
    expect((await admin.query("SELECT count(*)::int AS count FROM production_real.release_operation_audit")).rows[0].count).toBe(rowsBefore);
    invalidRevision = true;
    await expect(open().telemetryWindow({ operationId: "window-original", binding })).rejects.toThrow();
    invalidRevision = false; wrongLogResource = true;
    await expect(open().telemetryWindow({ operationId: "window-original", binding })).rejects.toThrow();
    expect(posts).toBe(30);
  } finally {
    await application?.end(); await admin?.end();
    if (pgStarted) await docker("rm", "-f", pgName);
    if (collectorStarted) await docker("rm", "-f", name);
    await docker("image", "rm", tag).catch(() => undefined);
    if (previous === undefined) delete process.env.NAPPLET_CVM_TEST_EXTERNAL_EFFECTS; else process.env.NAPPLET_CVM_TEST_EXTERNAL_EFFECTS = previous;
  }
}, 120_000);
