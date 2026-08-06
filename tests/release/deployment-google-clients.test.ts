import { expect, test } from "bun:test";
import { createGoogleDeploymentClients } from "../../src/release/deployment/google-clients";

const digest = (letter: string) => letter.repeat(64);

function fixture(options: Readonly<{ status?: number; body?: unknown }> = {}) {
  const requests: Array<Readonly<{ url: string; method: string; body: unknown }>> = [];
  const client = createGoogleDeploymentClients({
    projectId: "napplet-cvm-run-1",
    quotaProjectId: "napplet-cvm-run-1",
    apiOrigin: "http://127.0.0.1:8787",
    tokenSource: { getAccessToken: async () => ({ token: "fixture-token", projectId: "napplet-cvm-run-1", quotaProjectId: "napplet-cvm-run-1", expiresAtMs: 2_000 }) },
    fetch: async (url, init) => {
      const body = init?.body ? JSON.parse(String(init.body)) : undefined;
      requests.push({ url: String(url), method: init?.method ?? "GET", body });
      return new Response(JSON.stringify(options.body ?? { name: "operations/run-op-1", done: true }), { status: options.status ?? 200, headers: { "content-type": "application/json" } });
    },
    now: () => 1_000,
  });
  return { client, requests };
}

test("shares one fixture ADC/project authority and emits a bounded Cloud Run Admin request", async () => {
  const { client, requests } = fixture();
  expect(client.projectId).toBe("napplet-cvm-run-1");
  expect(client.cloudRun.projectId).toBe(client.gcs.projectId);
  expect(client.gcs.projectId).toBe(client.cloudSqlPostgres.projectId);
  expect(client.vertex.projectId).toBe(client.collector.projectId);

  await client.cloudRun.deploy({
    operationId: "run-op-1", projectId: "napplet-cvm-run-1", region: "europe-west1", serviceName: "napplet-cvm-api", imageDigest: `sha256:${digest("a")}`,
    serviceAccountReference: "serviceAccounts/napplet-cvm-api@napplet-cvm-run-1.iam.gserviceaccount.com", environmentReferenceSha256: digest("b"),
    minimumInstances: 3, ingress: "internal-and-cloud-load-balancing", concurrency: 80, admissionRefusal: "capacity_unavailable",
  });

  expect(requests).toEqual([expect.objectContaining({
    url: "http://127.0.0.1:8787/v2/projects/napplet-cvm-run-1/locations/europe-west1/services/napplet-cvm-api",
    method: "PUT",
    body: expect.objectContaining({ operationId: "run-op-1", imageDigest: `sha256:${digest("a")}`, minimumInstances: 3 }),
  })]);
  expect(JSON.stringify(await client.cloudRun.observe({ operationId: "run-op-1", projectId: "napplet-cvm-run-1", region: "europe-west1", serviceName: "napplet-cvm-api" }))).not.toContain("fixture-token");
});

test("fails closed before non-loopback, expired/mismatched ADC, denied API, or ambiguous observations can cross a provider seam", async () => {
  expect(() => createGoogleDeploymentClients({
    projectId: "napplet-cvm-run-1", quotaProjectId: "napplet-cvm-run-1", apiOrigin: "https://run.googleapis.com",
    tokenSource: { getAccessToken: async () => ({ token: "fixture", projectId: "napplet-cvm-run-1", quotaProjectId: "napplet-cvm-run-1", expiresAtMs: 2_000 }) }, fetch,
  })).toThrow("GOOGLE_CLIENT_LOOPBACK_REQUIRED");

  const { client } = fixture({ status: 403, body: { error: { message: "do-not-leak" } } });
  await expect(client.cloudRun.observe({ operationId: "run-op-1", projectId: "napplet-cvm-run-1", region: "europe-west1", serviceName: "napplet-cvm-api" })).resolves.toEqual({ status: "blocked" });
});

test("validates the sole PostgreSQL authority, dual-region/versioned objects, and redacted collector contract", async () => {
  const { client, requests } = fixture({ body: { generation: "7", md5Hash: "checksum", name: "archive" } });
  await expect(client.gcs.writeArtifact({ operationId: "gcs-op-1", bucket: "napplet-cvm-artifacts", object: "checkpoints/a.tar.zst", bytesBase64: "YQ==", expectedGeneration: "7", checksum: "checksum", location: "nam4", versioning: true, retentionDays: 30 })).resolves.toEqual({ status: "completed", generation: "7", checksum: "checksum" });
  await expect(client.cloudSqlPostgres.provision({ operationId: "sql-op-1", instanceId: "napplet-cvm-sql-1", region: "europe-west1", databaseVersion: "POSTGRES_17", availabilityType: "REGIONAL", serializableProbe: true })).resolves.toEqual({ status: "completed" });
  await expect(client.collector.configure({ operationId: "collector-op-1", contractDigest: digest("c"), metricSeriesCount: 15, redacted: true })).resolves.toEqual({ status: "completed" });
  expect(requests).toHaveLength(3);
  await expect(client.cloudSqlPostgres.provision({ operationId: "sql-op-1", instanceId: "napplet-cvm-sql-1", region: "europe-west1", databaseVersion: "MYSQL_8_0", availabilityType: "REGIONAL", serializableProbe: true } as never)).rejects.toThrow("GOOGLE_CLOUD_SQL_AUTHORITY_INVALID");
});
