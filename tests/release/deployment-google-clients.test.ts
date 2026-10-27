import { expect, test } from "bun:test";
import { createGoogleAdcTokenSource, googleAccountScopeSha256 } from "../../src/release/deployment/google-auth";
import { createGoogleDeploymentClients, type GoogleOperationJournal } from "../../src/release/deployment/google-clients";

const projectId = "napplet-cvm-run-1";
const principal = "napplet-cvm-control@napplet-cvm-run-1.iam.gserviceaccount.com";
const token = "a".repeat(32);
const digest = (letter: string) => letter.repeat(64);
const json = (value: unknown, status = 200) => new Response(JSON.stringify(value), { status, headers: { "content-type": "application/json" } });

async function fixture(handler: (url: string, init: RequestInit) => Response | Promise<Response>, credential: Partial<Readonly<{ projectId: string; quotaProjectId: string; principal: string; scopes: readonly string[]; accountScopeSha256: string; expiresAtMs: number }>> = {}) {
  const calls: Array<Readonly<{ url: string; method: string; body: string; headers: Headers }>> = [];
  const persisted: Array<Readonly<{ operationId: string; resource: string; requestSha256: string }>> = [];
  const scope = await googleAccountScopeSha256({ projectId, quotaProjectId: projectId, principal });
  const journal: GoogleOperationJournal = { persist: async (entry) => { persisted.push(entry); }, wasCreatedByRun: async () => true };
  const client = createGoogleDeploymentClients({ projectId, quotaProjectId: projectId, principal, journal, now: () => 1_000,
    tokenSource: { getAccessToken: async () => ({ token, projectId, quotaProjectId: projectId, principal, scopes: ["https://www.googleapis.com/auth/cloud-platform"], accountScopeSha256: scope, expiresAtMs: 120_000, ...credential }) },
    fetch: async (url, init) => { calls.push({ url: String(url), method: init.method ?? "GET", body: init.body ? await new Response(init.body).text() : "", headers: new Headers(init.headers) }); return handler(String(url), init); },
  });
  return { client, calls, persisted };
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
    fetch: async (url) => { metadataCalls.push(url); return url.includes("project-id") ? new Response("wrong-project-1") : url.includes("/email") ? new Response(principal) : json({ access_token: token, expires_in: 300 }); },
  });
  await expect(source.getAccessToken()).rejects.toThrow("GOOGLE_ADC_IDENTITY_INVALID");
  expect(metadataCalls).not.toContain("http://metadata.google.internal/computeMetadata/v1/instance/service-accounts/default/token");
});

test("wrong ADC project, quota, principal, expiry, or scope fails before any Google request", async () => {
  const variants = [
    { projectId: "wrong-project-1" }, { quotaProjectId: "wrong-project-1" }, { principal: "wrong@napplet-cvm-run-1.iam.gserviceaccount.com" },
    { expiresAtMs: 61_000 }, { scopes: ["https://www.googleapis.com/auth/devstorage.read_only"] },
  ];
  for (const credential of variants) {
    const { client, calls } = await fixture(() => json({ name: "ignored" }), credential);
    await expect(client.cloudRun.observe({ operationId: "deploy-1", projectId, region: "europe-west1", serviceName: "napplet-cvm-api" })).rejects.toThrow("GOOGLE_CLIENT_ADC_SCOPE_INVALID");
    expect(calls).toHaveLength(0);
  }
});

test("Cloud Run observes deterministic resource then uses official create serviceId without requestId", async () => {
  const { client, calls, persisted } = await fixture((_url, init) => init.method === "GET" ? json({ error: { code: 404 } }, 404) : json({ name: `projects/${projectId}/locations/europe-west1/operations/deploy-1` }));
  await expect(client.cloudRun.deploy({ operationId: "deploy-1", projectId, region: "europe-west1", serviceName: "napplet-cvm-api", imageDigest: `sha256:${digest("a")}`, serviceAccountReference: "svc@napplet-cvm-run-1.iam.gserviceaccount.com", environmentReferenceSha256: digest("b"), minimumInstances: 3, ingress: "internal-and-cloud-load-balancing", concurrency: 80, admissionRefusal: "capacity_unavailable" })).resolves.toEqual({ status: "pending" });
  expect(persisted).toHaveLength(1);
  expect(calls.map((call) => call.url)).toEqual([`https://run.googleapis.com/v2/projects/${projectId}/locations/europe-west1/services/napplet-cvm-api`, `https://run.googleapis.com/v2/projects/${projectId}/locations/europe-west1/services?serviceId=napplet-cvm-api`]);
  expect(calls[1]!.url).not.toContain("requestId=");
  expect(JSON.parse(calls[1]!.body)).toMatchObject({ ingress: "INGRESS_TRAFFIC_INTERNAL_LOAD_BALANCER", template: { scaling: { minInstanceCount: 3 } } });
});

test("GCS enforces policy then uploads create-only bytes with checksum and KMS reference", async () => {
  const checksum = "AAAAAAAA";
  const { client, calls, persisted } = await fixture((url, init) => {
    if (url.startsWith("https://storage.googleapis.com/storage/v1/b/napplet-cvm-artifacts") && !url.includes("/o/")) return json({ location: "NAM4", versioning: { enabled: true }, encryption: { defaultKmsKeyName: "projects/p/locations/us/keyRings/r/cryptoKeys/k" }, retentionPolicy: { retentionPeriod: "2592000" }, softDeletePolicy: { retentionDurationSeconds: "2592000" }, lifecycle: { rule: [{ action: { type: "Delete" }, condition: { age: 30 } }, { action: { type: "Delete" }, condition: { numNewerVersions: 1 } }] } });
    if (url.includes("?generation=9")) return json({ generation: "9", crc32c: checksum, kmsKeyName: "projects/p/locations/us/keyRings/r/cryptoKeys/k" });
    if (init.method === "GET") return json({ error: { code: 404 } }, 404);
    return json({ generation: "9", crc32c: checksum, kmsKeyName: "projects/p/locations/us/keyRings/r/cryptoKeys/k" });
  });
  await expect(client.gcs.writeArtifact({ operationId: "gcs-op-1", bucket: "napplet-cvm-artifacts", object: "checkpoints/a.tar.zst", bytesBase64: "YQ==", checksum, encryptionKeyReference: "projects/p/locations/us/keyRings/r/cryptoKeys/k", location: "nam4", versioning: true, retentionDays: 30 })).resolves.toEqual({ status: "completed", generation: "9", checksum });
  expect(persisted).toHaveLength(1);
  const upload = calls.find((call) => call.method === "POST" && call.url.includes("/upload/storage/"))!;
  expect(upload.url).toContain("ifGenerationMatch=0");
  expect(upload.url).toContain("kmsKeyName=projects%2Fp%2Flocations%2Fus%2FkeyRings%2Fr%2FcryptoKeys%2Fk");
  expect(upload.body).toBe("a");
});

test("Cloud SQL observes its sole instance before official instances.insert", async () => {
  const { client, calls, persisted } = await fixture((_url, init) => init.method === "GET" ? json({ error: { code: 404 } }, 404) : json({ name: "operation-1", status: "RUNNING" }));
  await expect(client.cloudSqlPostgres.provision({ operationId: "sql-op-1", instanceId: "napplet-cvm-sql-1", region: "europe-west1", databaseVersion: "POSTGRES_17", availabilityType: "REGIONAL", serializableProbe: true })).resolves.toEqual({ status: "pending" });
  expect(persisted).toHaveLength(1);
  expect(calls.map((call) => call.url)).toEqual([`https://sqladmin.googleapis.com/v1/projects/${projectId}/instances/napplet-cvm-sql-1`, `https://sqladmin.googleapis.com/v1/projects/${projectId}/instances`]);
  expect(JSON.parse(calls[1]!.body)).toMatchObject({ databaseVersion: "POSTGRES_17", settings: { availabilityType: "REGIONAL" } });
});
