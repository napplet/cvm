import { expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createGoogleAdcTokenSource, googleAccountScopeSha256 } from "../../src/release/deployment/google-auth";
import { createFileGoogleOperationJournal, createGoogleDeploymentClients, createMemoryGoogleOperationJournal, type GoogleOperationJournal } from "../../src/release/deployment/google-clients";

const projectId = "napplet-cvm-run-1";
const principal = "napplet-cvm-control@napplet-cvm-run-1.iam.gserviceaccount.com";
const token = "a".repeat(32);
const digest = (letter: string) => letter.repeat(64);
const json = (value: unknown, status = 200) => new Response(JSON.stringify(value), { status, headers: { "content-type": "application/json" } });

async function fixture(handler: (url: string, init: RequestInit) => Response | Promise<Response>, credential: Partial<Readonly<{ projectId: string; quotaProjectId: string; principal: string; scopes: readonly string[]; accountScopeSha256: string; expiresAtMs: number }>> = {}, savedJournal?: GoogleOperationJournal) {
  const calls: Array<Readonly<{ url: string; method: string; body: string; headers: Headers }>> = [];
  const scope = await googleAccountScopeSha256({ projectId, quotaProjectId: projectId, principal });
  const journal = savedJournal ?? createMemoryGoogleOperationJournal();
  const client = createGoogleDeploymentClients({ projectId, quotaProjectId: projectId, principal, journal, now: () => 1_000,
    tokenSource: { getAccessToken: async () => ({ token, projectId, quotaProjectId: projectId, principal, scopes: ["https://www.googleapis.com/auth/cloud-platform"], accountScopeSha256: scope, expiresAtMs: 120_000, ...credential }) },
    fetch: async (url, init) => { calls.push({ url: String(url), method: init.method ?? "GET", body: init.body ? await new Response(init.body).text() : "", headers: new Headers(init.headers) }); return handler(String(url), init); },
  });
  return { client, calls, journal };
}

test("ADC binds project, quota project, scope digest and expiry without exposing a token", async () => {
  const expected = await googleAccountScopeSha256({ projectId, quotaProjectId: projectId, principal });
  const source = createGoogleAdcTokenSource({ projectId, quotaProjectId: projectId, principal, accountScopeSha256: expected, now: () => 1_000, identity: async () => ({ projectId, principal }), command: async () => ({ exitCode: 0, stdout: `${token}\n` }) });
  const result = await source.getAccessToken();
  expect(result).toMatchObject({ projectId, quotaProjectId: projectId, principal, accountScopeSha256: expected, scopes: ["https://www.googleapis.com/auth/cloud-platform"] });
  expect(JSON.stringify({ projectId: result.projectId, accountScopeSha256: result.accountScopeSha256 })).not.toContain(token);
});

test("metadata fallback requires the attached Cloud Run project and principal before it reads a token", async () => {
  const expected = await googleAccountScopeSha256({ projectId, quotaProjectId: projectId, principal });
  const metadataCalls: string[] = [];
  const source = createGoogleAdcTokenSource({ projectId, quotaProjectId: projectId, principal, accountScopeSha256: expected, now: () => 1_000,
    command: async () => ({ exitCode: 127, stdout: "" }),
    fetch: async (url) => { metadataCalls.push(url); return url.includes("project-id") ? new Response("wrong-project-1") : url.includes("/email") ? new Response(principal) : json({ access_token: token, expires_in: 300, token_type: "Bearer" }); },
  });
  await expect(source.getAccessToken()).rejects.toThrow("GOOGLE_ADC_IDENTITY_INVALID");
  expect(metadataCalls).not.toContain("http://metadata.google.internal/computeMetadata/v1/instance/service-accounts/default/token");
});

test("metadata ADC verifies documented bearer type, scope, identity, and expiry", async () => {
  const expected = await googleAccountScopeSha256({ projectId, quotaProjectId: projectId, principal });
  const calls: string[] = [];
  const source = createGoogleAdcTokenSource({ projectId, quotaProjectId: projectId, principal, accountScopeSha256: expected, now: () => 1_000, command: async () => ({ exitCode: 127, stdout: "" }), fetch: async (url) => {
    calls.push(url);
    if (url.includes("project-id")) return new Response(projectId);
    if (url.endsWith("/email")) return new Response(principal);
    if (url.endsWith("/scopes")) return new Response("https://www.googleapis.com/auth/cloud-platform\n");
    return json({ access_token: token, expires_in: 300, token_type: "Bearer" });
  } });
  await expect(source.getAccessToken()).resolves.toMatchObject({ projectId, principal, expiresAtMs: 301_000 });
  expect(calls).toContain("http://metadata.google.internal/computeMetadata/v1/instance/service-accounts/default/token");
});

test("wrong ADC project, quota, principal, expiry, or scope fails before any Google request", async () => {
  const variants = [
    { projectId: "wrong-project-1" }, { quotaProjectId: "wrong-project-1" }, { principal: "wrong@napplet-cvm-run-1.iam.gserviceaccount.com" },
    { expiresAtMs: 61_000 }, { scopes: ["https://www.googleapis.com/auth/devstorage.read_only"] },
  ];
  for (const credential of variants) {
    const { client, calls } = await fixture(() => json({ name: "ignored" }), credential);
    await expect(client.cloudRun.deploy({ operationId: "deploy-auth", projectId, region: "europe-west1", serviceName: "napplet-cvm-api", imageReference: `us-docker.pkg.dev/${projectId}/control/control@sha256:${digest("a")}`, serviceAccountReference: "svc@napplet-cvm-run-1.iam.gserviceaccount.com", environmentReferenceSha256: digest("b"), secretReferences: [{ name: "DATABASE_URL", secret: "control-database-url", version: "1" }], minimumInstances: 3, ingress: "internal-and-cloud-load-balancing", concurrency: 80, admissionRefusal: "capacity_unavailable" })).rejects.toThrow("GOOGLE_CLIENT_ADC_SCOPE_INVALID");
    expect(calls).toHaveLength(0);
  }
});

test("Cloud Run observes deterministic resource then uses official create serviceId without requestId", async () => {
  const { client, calls, journal } = await fixture((_url, init) => init.method === "GET" ? json({ error: { code: 404 } }, 404) : json({ name: `projects/${projectId}/locations/europe-west1/operations/deploy-1` }));
  await expect(client.cloudRun.deploy({ operationId: "deploy-1", projectId, region: "europe-west1", serviceName: "napplet-cvm-api", imageReference: `us-docker.pkg.dev/${projectId}/control/control@sha256:${digest("a")}`, serviceAccountReference: "svc@napplet-cvm-run-1.iam.gserviceaccount.com", environmentReferenceSha256: digest("b"), secretReferences: [{ name: "DATABASE_URL", secret: "control-database-url", version: "1" }], minimumInstances: 3, ingress: "internal-and-cloud-load-balancing", concurrency: 80, admissionRefusal: "capacity_unavailable" })).resolves.toEqual({ status: "pending" });
  expect(await journal.read("deploy-1")).toMatchObject({ state: "dispatched", operationName: `projects/${projectId}/locations/europe-west1/operations/deploy-1` });
  expect(calls.map((call) => call.url)).toEqual([`https://run.googleapis.com/v2/projects/${projectId}/locations/europe-west1/services/napplet-cvm-api`, `https://run.googleapis.com/v2/projects/${projectId}/locations/europe-west1/services?serviceId=napplet-cvm-api`]);
  expect(calls[1]!.url).not.toContain("requestId=");
  expect(JSON.parse(calls[1]!.body)).toMatchObject({ ingress: "INGRESS_TRAFFIC_INTERNAL_LOAD_BALANCER", template: { scaling: { minInstanceCount: 3 } } });
});

test("Cloud Run cleanup requires recorded ownership and sends the observed etag", async () => {
  let getCount = 0;
  const { client, calls } = await fixture((_url, init) => {
    if (init.method === "POST") return json({ name: `projects/${projectId}/locations/europe-west1/operations/create-1` });
    if (init.method === "DELETE") return json({ name: `projects/${projectId}/locations/europe-west1/operations/delete-1` });
    getCount += 1;
    return getCount === 1 ? json({ error: { code: 404 } }, 404) : getCount === 2 ? json({ name: `projects/${projectId}/locations/europe-west1/services/napplet-cvm-api`, etag: "service-etag-1" }) : json({ error: { code: 404 } }, 404);
  });
  const request = { operationId: "deploy-cleanup", projectId, region: "europe-west1", serviceName: "napplet-cvm-api", imageReference: `us-docker.pkg.dev/${projectId}/control/control@sha256:${digest("f")}`, serviceAccountReference: "svc@napplet-cvm-run-1.iam.gserviceaccount.com", environmentReferenceSha256: digest("e"), secretReferences: [{ name: "DATABASE_URL", secret: "control-database-url", version: "1" }], minimumInstances: 3 as const, ingress: "internal-and-cloud-load-balancing" as const, concurrency: 80, admissionRefusal: "capacity_unavailable" as const };
  await client.cloudRun.deploy(request);
  await expect(client.cloudRun.cleanup({ operationId: request.operationId, projectId, region: request.region, serviceName: request.serviceName })).resolves.toEqual({ status: "completed" });
  expect(calls.find((call) => call.method === "DELETE")?.url).toContain("etag=service-etag-1");
  await expect(client.cloudRun.cleanup({ operationId: "not-owned", projectId, region: request.region, serviceName: request.serviceName })).rejects.toThrow("GOOGLE_CLEANUP_RUN_OWNERSHIP_REQUIRED");
});

test("Cloud Run LRO observation requires terminal ready configuration before completing the journal", async () => {
  const imageReference = `us-docker.pkg.dev/${projectId}/control/control@sha256:${digest("9")}`;
  const service = { name: `projects/${projectId}/locations/europe-west1/services/napplet-cvm-api`, ingress: "INGRESS_TRAFFIC_INTERNAL_LOAD_BALANCER", template: { scaling: { minInstanceCount: 3 }, maxInstanceRequestConcurrency: 80, serviceAccount: "svc@napplet-cvm-run-1.iam.gserviceaccount.com", containers: [{ image: imageReference, env: [{ name: "GOOGLE_CLOUD_PROJECT", value: projectId }, { name: "NAPPLET_CVM_ENVIRONMENT_SHA256", value: digest("8") }, { name: "DATABASE_URL", valueSource: { secretKeyRef: { secret: "control-database-url", version: "1" } } }] }] } };
  let resourceGets = 0;
  const { client, journal } = await fixture((url, init) => {
    if (init.method === "POST") return json({ name: `projects/${projectId}/locations/europe-west1/operations/ready-1` });
    if (url.includes("/operations/ready-1")) return json({ done: true });
    resourceGets += 1; return resourceGets === 1 ? json({ error: { code: 404 } }, 404) : json(service);
  });
  const request = { operationId: "deploy-observe", projectId, region: "europe-west1", serviceName: "napplet-cvm-api", imageReference, serviceAccountReference: "svc@napplet-cvm-run-1.iam.gserviceaccount.com", environmentReferenceSha256: digest("8"), secretReferences: [{ name: "DATABASE_URL", secret: "control-database-url", version: "1" }], minimumInstances: 3 as const, ingress: "internal-and-cloud-load-balancing" as const, concurrency: 80, admissionRefusal: "capacity_unavailable" as const };
  await client.cloudRun.deploy(request);
  await expect(client.cloudRun.observe({ operationId: request.operationId, projectId, region: request.region, serviceName: request.serviceName, imageReference, serviceAccountReference: request.serviceAccountReference, environmentReferenceSha256: request.environmentReferenceSha256, secretReferences: request.secretReferences, concurrency: request.concurrency })).resolves.toEqual({ status: "completed" });
  expect(await journal.read(request.operationId)).toMatchObject({ state: "completed" });
});

test("concurrent or restarted Cloud Run callers reconcile a claimed ambiguous create instead of posting twice", async () => {
  let creates = 0;
  const handler = (_url: string, init: RequestInit) => {
    if (init.method === "GET") return json({ error: { code: 404 } }, 404);
    creates += 1;
    throw new Error("lost response after dispatch");
  };
  const { client, journal } = await fixture(handler);
  const request = { operationId: "deploy-2", projectId, region: "europe-west1", serviceName: "napplet-cvm-api", imageReference: `us-docker.pkg.dev/${projectId}/control/control@sha256:${digest("c")}`, serviceAccountReference: "svc@napplet-cvm-run-1.iam.gserviceaccount.com", environmentReferenceSha256: digest("d"), secretReferences: [{ name: "DATABASE_URL", secret: "control-database-url", version: "1" }], minimumInstances: 3 as const, ingress: "internal-and-cloud-load-balancing" as const, concurrency: 80, admissionRefusal: "capacity_unavailable" as const };
  await expect(client.cloudRun.deploy(request)).resolves.toEqual({ status: "unknown" });
  await expect(client.cloudRun.deploy(request)).resolves.toEqual({ status: "unknown" });
  const { client: restarted } = await fixture(handler, {}, journal);
  await expect(restarted.cloudRun.deploy(request)).resolves.toEqual({ status: "unknown" });
  expect(creates).toBe(1);
});

test("file journal persists a dispatch claim across process recreation", async () => {
  const root = await mkdtemp(join(tmpdir(), "napplet-google-journal-"));
  try {
    const first = createFileGoogleOperationJournal(root);
    const claimed = await first.claim({ operationId: "durable-1", resource: "projects/p/services/s", requestSha256: digest("a"), contentSha256: digest("b"), owned: true });
    expect(claimed.claimed).toBe(true);
    await first.markDispatching({ operationId: "durable-1", requestSha256: digest("a") });
    const restarted = createFileGoogleOperationJournal(root);
    await expect(restarted.claim({ operationId: "durable-1", resource: "projects/p/services/s", requestSha256: digest("a"), contentSha256: digest("b"), owned: true })).resolves.toMatchObject({ claimed: false, record: { state: "dispatching" } });
  } finally { await rm(root, { recursive: true, force: true }); }
});

test("GCS enforces policy then uploads create-only bytes with checksum and KMS reference", async () => {
  const checksum = "wdBDMA==";
  const { client, calls, journal } = await fixture((url, init) => {
    if (url.startsWith("https://storage.googleapis.com/storage/v1/b/napplet-cvm-artifacts") && !url.includes("/o/")) return json({ location: "NAM4", versioning: { enabled: true }, encryption: { defaultKmsKeyName: "projects/p/locations/us/keyRings/r/cryptoKeys/k" }, retentionPolicy: { retentionPeriod: "2592000" }, softDeletePolicy: { retentionDurationSeconds: "0" }, lifecycle: { rule: [{ action: { type: "Delete" }, condition: { age: 30 } }, { action: { type: "Delete" }, condition: { numNewerVersions: 1 } }] } });
    if (url.includes("?generation=9")) return json({ generation: "9", crc32c: checksum, kmsKeyName: "projects/p/locations/us/keyRings/r/cryptoKeys/k" });
    if (init.method === "GET") return json({ error: { code: 404 } }, 404);
    return json({ generation: "9", crc32c: checksum, kmsKeyName: "projects/p/locations/us/keyRings/r/cryptoKeys/k" });
  });
  await expect(client.gcs.writeArtifact({ operationId: "gcs-op-1", bucket: "napplet-cvm-artifacts", object: "checkpoints/a.tar.zst", bytesBase64: "YQ==", checksum, encryptionKeyReference: "projects/p/locations/us/keyRings/r/cryptoKeys/k", location: "nam4", versioning: true, retentionDays: 30 })).resolves.toEqual({ status: "completed", generation: "9", checksum });
  expect(await journal.read("gcs-op-1")).toMatchObject({ state: "completed", generation: "9" });
  const upload = calls.find((call) => call.method === "POST" && call.url.includes("/upload/storage/"))!;
  expect(upload.url).toContain("ifGenerationMatch=0");
  expect(upload.url).toContain("uploadType=multipart");
  expect(upload.url).toContain("kmsKeyName=projects%2Fp%2Flocations%2Fus%2FkeyRings%2Fr%2FcryptoKeys%2Fk");
  expect(upload.headers.get("content-type")).toContain("multipart/related");
  expect(upload.body).toContain('"crc32c":"wdBDMA=="');
  expect(upload.body).toContain("\r\n\r\na\r\n--napplet-cvm-google-json-upload--");
});

test("Cloud SQL observes its sole instance before official instances.insert", async () => {
  const { client, calls, journal } = await fixture((_url, init) => init.method === "GET" ? json({ error: { code: 404 } }, 404) : json({ name: "operation-1", status: "RUNNING" }));
  await expect(client.cloudSqlPostgres.provision({ operationId: "sql-op-1", instanceId: "napplet-cvm-sql-1", region: "europe-west1", databaseVersion: "POSTGRES_17", availabilityType: "REGIONAL", tier: "db-custom-2-7680", privateNetwork: "projects/napplet-cvm-run-1/global/networks/production", requireSsl: true, serializablePolicy: true })).resolves.toEqual({ status: "pending" });
  expect(await journal.read("sql-op-1")).toMatchObject({ state: "dispatched", operationName: "operation-1" });
  expect(calls.map((call) => call.url)).toEqual([`https://sqladmin.googleapis.com/v1/projects/${projectId}/instances/napplet-cvm-sql-1`, `https://sqladmin.googleapis.com/v1/projects/${projectId}/instances`]);
  expect(JSON.parse(calls[1]!.body)).toMatchObject({ databaseVersion: "POSTGRES_17", settings: { availabilityType: "REGIONAL", tier: "db-custom-2-7680", ipConfiguration: { privateNetwork: "projects/napplet-cvm-run-1/global/networks/production", ipv4Enabled: false, requireSsl: true } } });
});
