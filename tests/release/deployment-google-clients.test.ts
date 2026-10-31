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

async function fixture(handler: (url: string, init: RequestInit) => Response | Promise<Response>, credential: Partial<Readonly<{ projectId: string; quotaProjectId: string; principal: string; scopes: readonly string[]; accountScopeSha256: string; expiresAtMs: number }>> = {}, savedJournal?: GoogleOperationJournal, timeoutMs?: number) {
  const calls: Array<Readonly<{ url: string; method: string; body: string; headers: Headers }>> = [];
  const scope = await googleAccountScopeSha256({ projectId, quotaProjectId: projectId, principal });
  const journal = savedJournal ?? createMemoryGoogleOperationJournal();
  const client = createGoogleDeploymentClients({ projectId, quotaProjectId: projectId, principal, journal, now: () => 1_000, ...(timeoutMs === undefined ? {} : { timeoutMs }),
    tokenSource: { getAccessToken: async () => ({ token, projectId, quotaProjectId: projectId, principal, scopes: ["https://www.googleapis.com/auth/cloud-platform"], accountScopeSha256: scope, expiresAtMs: 120_000, ...credential }) },
    fetch: async (url, init) => { calls.push({ url: String(url), method: init.method ?? "GET", body: init.body ? await new Response(init.body).text() : "", headers: new Headers(init.headers) }); return handler(String(url), init); },
  });
  return { client, calls, journal };
}

const cloudRunRequest = (operationId: string) => ({ operationId, projectId, region: "europe-west1", serviceName: "napplet-cvm-api", imageReference: `us-docker.pkg.dev/${projectId}/control/control@sha256:${digest("a")}`, serviceAccountReference: "svc@napplet-cvm-run-1.iam.gserviceaccount.com", environmentReferenceSha256: digest("b"), secretReferences: [{ name: "DATABASE_URL", secret: "control-database-url", version: "1" }], minimumInstances: 3 as const, ingress: "internal-and-cloud-load-balancing" as const, concurrency: 80, admissionRefusal: "capacity_unavailable" as const });
const cloudRunService = (operationId: string, overrides: Record<string, unknown> = {}) => ({ name: `projects/${projectId}/locations/europe-west1/services/napplet-cvm-api`, uid: "service-uid-1", createTime: "2026-01-01T00:00:00Z", generation: "3", observedGeneration: "3", reconciling: false, terminalCondition: { state: "CONDITION_SUCCEEDED" }, conditions: [{ type: "ConfigurationsReady", state: "CONDITION_SUCCEEDED" }, { type: "RoutesReady", state: "CONDITION_SUCCEEDED" }], labels: { "napplet-cvm-operation": operationId }, ingress: "INGRESS_TRAFFIC_INTERNAL_LOAD_BALANCER", scaling: { minInstanceCount: 3, maxInstanceCount: 3, scalingMode: "AUTOMATIC" }, template: { scaling: { minInstanceCount: 3, maxInstanceCount: 3 }, maxInstanceRequestConcurrency: 80, serviceAccount: "svc@napplet-cvm-run-1.iam.gserviceaccount.com", containers: [{ image: `us-docker.pkg.dev/${projectId}/control/control@sha256:${digest("a")}`, resources: { limits: { cpu: "1", memory: "512Mi" }, cpuIdle: false, startupCpuBoost: false }, env: [{ name: "GOOGLE_CLOUD_PROJECT", value: projectId }, { name: "NAPPLET_CVM_ENVIRONMENT_SHA256", value: digest("b") }, { name: "DATABASE_URL", valueSource: { secretKeyRef: { secret: "control-database-url", version: "1" } } }] }] }, ...overrides });
const sqlRequest = (operationId: string) => ({ operationId, instanceId: "napplet-cvm-sql-1", region: "europe-west1", databaseVersion: "POSTGRES_17" as const, availabilityType: "REGIONAL" as const, tier: "db-custom-2-7680", privateNetwork: `projects/${projectId}/global/networks/production`, requireSsl: true as const, serializablePolicy: true as const });

test("ADC binds project, quota project, scope digest and expiry without exposing a token", async () => {
  const expected = await googleAccountScopeSha256({ projectId, quotaProjectId: projectId, principal });
  const source = createGoogleAdcTokenSource({ projectId, quotaProjectId: projectId, principal, accountScopeSha256: expected, now: () => 1_000, auth: { getProjectId: async () => projectId, getCredentials: async () => ({ client_email: principal, quota_project_id: projectId }), getClient: async () => ({ credentials: { expiry_date: 301_000 }, getAccessToken: async () => ({ token }), getTokenInfo: async () => ({ scopes: ["https://www.googleapis.com/auth/cloud-platform"], expiry_date: 301_000, email: principal }) }) } });
  const result = await source.getAccessToken();
  expect(result).toMatchObject({ projectId, quotaProjectId: projectId, principal, accountScopeSha256: expected, scopes: ["https://www.googleapis.com/auth/cloud-platform"] });
  expect(JSON.stringify({ projectId: result.projectId, accountScopeSha256: result.accountScopeSha256 })).not.toContain(token);
});

test("authorized_user ADC binds token-info email and observed auxiliary scopes", async () => {
  const scopes = ["https://www.googleapis.com/auth/cloud-platform", "openid", "https://www.googleapis.com/auth/userinfo.email"];
  const expected = await googleAccountScopeSha256({ projectId, quotaProjectId: projectId, principal, scopes });
  const source = createGoogleAdcTokenSource({ projectId, quotaProjectId: projectId, principal, accountScopeSha256: expected, now: () => 1_000, auth: { getProjectId: async () => projectId, getCredentials: async () => ({ quota_project_id: projectId }), getClient: async () => ({ credentials: { expiry_date: 301_000 }, getAccessToken: async () => ({ token }), getTokenInfo: async () => ({ scopes, expiry_date: 301_000, email: principal }) }) } });
  await expect(source.getAccessToken()).resolves.toMatchObject({ principal, scopes, accountScopeSha256: expected });
});

test("metadata fallback requires the attached Cloud Run project and principal before it reads a token", async () => {
  const expected = await googleAccountScopeSha256({ projectId, quotaProjectId: projectId, principal });
  const metadataCalls: string[] = [];
  const source = createGoogleAdcTokenSource({ projectId, quotaProjectId: projectId, principal, accountScopeSha256: expected, now: () => 1_000,
    fetch: async (url) => { metadataCalls.push(url); return url.includes("project-id") ? new Response("wrong-project-1") : url.includes("/email") ? new Response(principal) : json({ access_token: token, expires_in: 300, token_type: "Bearer" }); },
  });
  await expect(source.getAccessToken()).rejects.toThrow("ADC_APPLICATION_DEFAULT_LOGIN_REQUIRED");
  expect(metadataCalls).not.toContain("http://metadata.google.internal/computeMetadata/v1/instance/service-accounts/default/token");
});

test("metadata ADC verifies documented bearer type, scope, identity, and expiry", async () => {
  const expected = await googleAccountScopeSha256({ projectId, quotaProjectId: projectId, principal });
  const calls: string[] = [];
  const source = createGoogleAdcTokenSource({ projectId, quotaProjectId: projectId, principal, accountScopeSha256: expected, now: () => 1_000, fetch: async (url) => {
    calls.push(url);
    if (url.includes("project-id")) return new Response(projectId);
    if (url.endsWith("/email")) return new Response(principal);
    if (url.endsWith("/scopes")) return new Response("https://www.googleapis.com/auth/cloud-platform\n");
    return json({ access_token: token, expires_in: 300, token_type: "Bearer" });
  } });
  await expect(source.getAccessToken()).resolves.toMatchObject({ projectId, principal, expiresAtMs: 301_000 });
  expect(calls).toContain("http://metadata.google.internal/computeMetadata/v1/instance/service-accounts/default/token");
});

test("ADC rejects missing, null, invalid and marginal SDK credential expiries without releasing a token", async () => {
  for (const expiry of [undefined, null, NaN, Infinity, 61_000]) {
    let metadataCalls=0;
    const source=createGoogleAdcTokenSource({projectId,quotaProjectId:projectId,principal,now:()=>1_000,
      auth:{getProjectId:async()=>projectId,getCredentials:async()=>({client_email:principal,quota_project_id:projectId}),getClient:async()=>({credentials:{expiry_date:expiry},getAccessToken:async()=>({token}),getTokenInfo:async()=>({scopes:["https://www.googleapis.com/auth/cloud-platform"],expiry_date:301_000,email:principal})})},
      fetch:async()=>{metadataCalls++;return new Response("fixture metadata unavailable",{status:404});}});
    await expect(source.getAccessToken()).rejects.toThrow("ADC_APPLICATION_DEFAULT_LOGIN_REQUIRED");
    expect(metadataCalls).toBe(3);
  }
  const source=createGoogleAdcTokenSource({projectId,quotaProjectId:projectId,principal,now:()=>1_000,
    auth:{getProjectId:async()=>projectId,getCredentials:async()=>({client_email:principal}),getClient:async()=>({credentials:{expiry_date:301_000},getAccessToken:async()=>({token:null})})},
    fetch:async()=>new Response("fixture metadata unavailable",{status:404})});
  await expect(source.getAccessToken()).rejects.toThrow("ADC_APPLICATION_DEFAULT_LOGIN_REQUIRED");
});

test("ADC metadata hangs are bounded and never release a token", async () => {
  const source = createGoogleAdcTokenSource({ projectId, quotaProjectId: projectId, principal, timeoutMs: 1, fetch: async () => new Promise<Response>(() => {}) });
  await expect(source.getAccessToken()).rejects.toThrow("ADC_APPLICATION_DEFAULT_LOGIN_REQUIRED");
});

test("wrong ADC project, quota, principal, expiry, or scope fails before any Google request", async () => {
  const variants = [
    { projectId: "wrong-project-1" }, { quotaProjectId: "wrong-project-1" }, { principal: "wrong@napplet-cvm-run-1.iam.gserviceaccount.com" },
    { expiresAtMs: 61_000 }, { scopes: ["https://www.googleapis.com/auth/devstorage.read_only"] },
  ];
  for (const credential of variants) {
    const { client, calls } = await fixture(() => json({ name: "ignored" }), credential);
    await expect(client.cloudRun.deploy({ operationId: "deploy-auth", projectId, region: "europe-west1", serviceName: "napplet-cvm-api", imageReference: `us-docker.pkg.dev/${projectId}/control/control@sha256:${digest("a")}`, serviceAccountReference: "svc@napplet-cvm-run-1.iam.gserviceaccount.com", environmentReferenceSha256: digest("b"), secretReferences: [{ name: "DATABASE_URL", secret: "control-database-url", version: "1" }], minimumInstances: 3, ingress: "internal-and-cloud-load-balancing", concurrency: 80, admissionRefusal: "capacity_unavailable" })).rejects.toThrow(credential.scopes ? "GOOGLE_ADC_SCOPE_INVALID" : "GOOGLE_CLIENT_ADC_SCOPE_INVALID");
    expect(calls).toHaveLength(0);
  }
});

function collectorFixture() {
  const bytes = new TextEncoder().encode(JSON.stringify({ os: "linux", architecture: "amd64" }));
  const configDigest = `sha256:${new Bun.CryptoHasher("sha256").update(bytes).digest("hex")}`;
  const manifest = new TextEncoder().encode(JSON.stringify({ schemaVersion: 2, mediaType: "application/vnd.oci.image.manifest.v1+json", config: { mediaType: "application/vnd.oci.image.config.v1+json", digest: configDigest, size: bytes.byteLength }, layers: [] }));
  const manifestDigest = `sha256:${new Bun.CryptoHasher("sha256").update(manifest).digest("hex")}`;
  return { bytes, configDigest, manifest, manifestDigest, imageReference: `us-docker.pkg.dev/${projectId}/control/collector@${manifestDigest}` };
}

test("collector registry observation uses authenticated immutable manifest and config GETs only", async () => {
  const { bytes, manifest, manifestDigest, configDigest, imageReference } = collectorFixture();
  const { client, calls } = await fixture((url) => {
    if (url.includes("/manifests/")) return new Response(manifest, { headers: { "content-type": "application/vnd.oci.image.manifest.v1+json", "docker-content-digest": manifestDigest } });
    return new Response(bytes, { headers: { "content-type": "application/vnd.oci.image.config.v1+json", "docker-content-digest": configDigest } });
  });
  const observed = await client.collector.observeUploadedManifest({ imageReference, manifestDigest, configDigest, platform: { os: "linux", architecture: "amd64" } });
  expect(observed).toMatchObject({ imageReference, manifestDigest, configDigest, platform: { os: "linux", architecture: "amd64" } });
  expect(calls.map(call => call.method)).toEqual(["GET", "GET"]);
  expect(calls.map(call => call.url)).toEqual([
    `https://us-docker.pkg.dev/v2/${projectId}/control/collector/manifests/${manifestDigest}`,
    `https://us-docker.pkg.dev/v2/${projectId}/control/collector/blobs/${configDigest}`,
  ]);
  expect(calls.every(call => call.headers.get("authorization") === `Bearer ${token}` && call.headers.get("x-goog-user-project") === projectId)).toBe(true);
});

test("collector upload journals one original operation and observes the uploaded manifest", async () => {
  const { bytes, manifest, manifestDigest, configDigest, imageReference } = collectorFixture();
  let posts = 0, puts = 0;
  const { client, journal } = await fixture((url, init) => {
    if (init.method === "HEAD") return new Response(null, { status: 404 });
    if (init.method === "POST") { posts += 1; return new Response(null, { status: 202, headers: { location: "/upload/original" } }); }
    if (init.method === "PUT" && url.includes("/upload/original")) { puts += 1; return new Response(null, { status: 201, headers: { "docker-content-digest": configDigest } }); }
    if (init.method === "PUT") { puts += 1; return new Response(null, { status: 201, headers: { "docker-content-digest": manifestDigest } }); }
    if (url.includes("/manifests/")) return new Response(manifest, { headers: { "docker-content-digest": manifestDigest } });
    return new Response(bytes, { headers: { "docker-content-digest": configDigest } });
  });
  const image = { imageReference, manifestDigest, manifestMediaType: "application/vnd.oci.image.manifest.v1+json" as const, manifest, configDigest, platform: { os: "linux" as const, architecture: "amd64" as const }, blobs: [{ digest: configDigest, mediaType: "application/vnd.oci.image.config.v1+json", bytes }] };
  await expect(client.collector.uploadOciImage({ operationId: "collector-upload-original", image, expiresAtMs: 10_000 })).resolves.toEqual({ status: "completed" });
  expect(posts).toBe(1); expect(puts).toBe(2);
  expect(await journal.read("collector-upload-original")).toMatchObject({ state: "completed", owned: true, resourceUid: manifestDigest });
  await expect(client.collector.uploadOciImage({ operationId: "collector-upload-original", image, expiresAtMs: 10_000 })).resolves.toEqual({ status: "completed" });
  expect(posts).toBe(1);
});

test("collector rejects altered registry bytes even when digest headers match", async () => {
  const image = collectorFixture();
  for (const corrupt of ["manifest", "config"] as const) {
    const { client } = await fixture(url => url.includes("/manifests/")
      ? new Response(corrupt === "manifest" ? "{}" : image.manifest, { headers: { "docker-content-digest": image.manifestDigest } })
      : new Response(corrupt === "config" ? "{}" : image.bytes, { headers: { "docker-content-digest": image.configDigest } }));
    await expect(client.collector.observeUploadedManifest({ ...image, platform: { os: "linux", architecture: "amd64" } })).rejects.toThrow("GOOGLE_ARTIFACT_REGISTRY_OBSERVATION_INVALID");
  }
});

test("expired collector authorization cannot dispatch a new upload", async () => {
  const source = collectorFixture();
  const image = { ...source, manifestMediaType: "application/vnd.oci.image.manifest.v1+json" as const, platform: { os: "linux" as const, architecture: "amd64" as const }, blobs: [{ digest: source.configDigest, mediaType: "application/vnd.oci.image.config.v1+json", bytes: source.bytes }] };
  const { client, calls } = await fixture(() => { throw new Error("UNEXPECTED_NETWORK"); });
  await expect(client.collector.uploadOciImage({ operationId: "collector-expired", image, expiresAtMs: 1000 })).rejects.toThrow("COLLECTOR_UPLOAD_AUTHORIZATION_EXPIRED");
  expect(calls).toHaveLength(0);
});

test("collector upload lost acknowledgement is reconciled by GET without a second POST", async () => {
  const { bytes, manifest, manifestDigest, configDigest, imageReference } = collectorFixture();
  let posts = 0;
  const { client } = await fixture((_url, init) => {
    if (init.method === "HEAD" || init.method === "GET") return new Response(null, { status: 404 });
    if (init.method === "POST") { posts += 1; return new Response(null, { status: 202, headers: { location: "/upload/lost-ack" } }); }
    throw new Error("lost acknowledgement");
  });
  const image = { imageReference, manifestDigest, manifestMediaType: "application/vnd.oci.image.manifest.v1+json" as const, manifest, configDigest, platform: { os: "linux" as const, architecture: "amd64" as const }, blobs: [{ digest: configDigest, mediaType: "application/vnd.oci.image.config.v1+json", bytes }] };
  await expect(client.collector.uploadOciImage({ operationId: "collector-upload-lost", image, expiresAtMs: 10_000 })).resolves.toEqual({ status: "unknown" });
  await expect(client.collector.uploadOciImage({ operationId: "collector-upload-lost", image, expiresAtMs: 1000 })).resolves.toEqual({ status: "unknown" });
  expect(posts).toBe(1);
});

test("Cloud Run observes deterministic resource then uses official create serviceId without requestId", async () => {
  const { client, calls, journal } = await fixture((_url, init) => init.method === "GET" ? json({ error: { code: 404 } }, 404) : json({ name: `projects/${projectId}/locations/europe-west1/operations/deploy-1` }));
  await expect(client.cloudRun.deploy({ operationId: "deploy-1", projectId, region: "europe-west1", serviceName: "napplet-cvm-api", imageReference: `us-docker.pkg.dev/${projectId}/control/control@sha256:${digest("a")}`, serviceAccountReference: "svc@napplet-cvm-run-1.iam.gserviceaccount.com", environmentReferenceSha256: digest("b"), secretReferences: [{ name: "DATABASE_URL", secret: "control-database-url", version: "1" }], minimumInstances: 3, ingress: "internal-and-cloud-load-balancing", concurrency: 80, admissionRefusal: "capacity_unavailable" })).resolves.toEqual({ status: "pending" });
  expect(await journal.read("deploy-1")).toMatchObject({ state: "dispatched", operationName: `projects/${projectId}/locations/europe-west1/operations/deploy-1` });
  expect(calls.map((call) => call.url)).toEqual([`https://run.googleapis.com/v2/projects/${projectId}/locations/europe-west1/services/napplet-cvm-api`, `https://run.googleapis.com/v2/projects/${projectId}/locations/europe-west1/services?serviceId=napplet-cvm-api`]);
  expect(calls[1]!.url).not.toContain("requestId=");
  expect(JSON.parse(calls[1]!.body)).toMatchObject({ ingress: "INGRESS_TRAFFIC_INTERNAL_LOAD_BALANCER", scaling: { minInstanceCount: 3, maxInstanceCount: 3, scalingMode: "AUTOMATIC" }, template: { scaling: { minInstanceCount: 3, maxInstanceCount: 3 }, containers: [{ resources: { limits: { cpu: "1", memory: "512Mi" }, cpuIdle: false, startupCpuBoost: false } }] } });
});

test("Cloud Run never adopts a same-owner lookalike with missing or changed resource bounds", async () => {
  const base = cloudRunService("bounded-lookalike");
  const container = base.template.containers[0]!;
  const variations = [
    { ...base, scaling: { minInstanceCount: 3 } },
    { ...base, scaling: { ...base.scaling, maxInstanceCount: 30 } },
    { ...base, scaling: { ...base.scaling, scalingMode: "MANUAL", manualInstanceCount: 30 } },
    { ...base, template: { ...base.template, scaling: { minInstanceCount: 3, maxInstanceCount: 30 } } },
    ...[
      undefined,
      { ...container.resources, limits: { cpu: "2", memory: "512Mi" } },
      { ...container.resources, limits: { cpu: "1", memory: "1Gi" } },
      { ...container.resources, cpuIdle: true },
      { ...container.resources, startupCpuBoost: true },
    ].map(resources => ({ ...base, template: { ...base.template, containers: [{ ...container, resources }] } })),
  ];
  for (const observed of variations) {
    let created = false;
    const { client, calls, journal } = await fixture((url, init) => {
      if (init.method === "POST") { created = true; return json({ name: `projects/${projectId}/locations/europe-west1/operations/bounded-lookalike` }); }
      if (url.includes("/operations/")) return json({ done: true });
      return created ? json(observed) : json({ error: { code: 404 } }, 404);
    });
    const request = cloudRunRequest("bounded-lookalike");
    await expect(client.cloudRun.deploy(request)).resolves.toEqual({ status: "pending" });
    await expect(client.cloudRun.observe(request)).resolves.toEqual({ status: "unknown" });
    expect((await journal.read(request.operationId))?.state).toBe("dispatched");
    expect((await journal.read(request.operationId))?.owned).not.toBe(true);
    expect(calls.filter(call => call.method === "POST")).toHaveLength(1);
  }
});

test("Cloud Run pins an explicitly mounted collector port in create and observation", async () => {
  const request = { ...cloudRunRequest("collector-otel"), containerPort: 4318 };
  const { client, calls } = await fixture((_url, init) => init.method === "GET" ? json({ error: { code: 404 } }, 404) : json({ name: `projects/${projectId}/locations/europe-west1/operations/collector-otel` }));
  await expect(client.cloudRun.deploy(request)).resolves.toEqual({ status: "pending" });
  expect(JSON.parse(calls[1]!.body)).toMatchObject({ template: { containers: [{ ports: [{ containerPort: 4318 }] }] } });
  const observed = cloudRunService("collector-otel", { template: { ...cloudRunService("collector-otel").template, containers: [{ ...cloudRunService("collector-otel").template.containers[0], ports: [{ containerPort: 4318 }] }] } });
  const completed = await fixture(() => json(observed));
  await expect(completed.client.cloudRun.deploy(request)).resolves.toEqual({ status: "completed" });
  const wrongPort = await fixture(() => json({ ...observed, template: { ...observed.template, containers: [{ ...observed.template.containers[0], ports: [{ containerPort: 4317 }] }] } }));
  await expect(wrongPort.client.cloudRun.deploy(request)).resolves.not.toEqual({ status: "completed" });
});

test("Cloud Run cleanup requires recorded ownership and sends the observed etag", async () => {
  let getCount = 0;
  const { client, calls, journal } = await fixture((_url, init) => {
    if (init.method === "POST") return json({ name: `projects/${projectId}/locations/europe-west1/operations/create-1` });
    if (init.method === "DELETE") return json({ name: `projects/${projectId}/locations/europe-west1/operations/delete-1` });
    getCount += 1;
    return getCount === 1 ? json({ error: { code: 404 } }, 404) : getCount === 2 ? json({ name: `projects/${projectId}/locations/europe-west1/services/napplet-cvm-api`, etag: "service-etag-1", uid: "uid-1", createTime: "2026-01-01T00:00:00Z", labels: { "napplet-cvm-operation": "deploy-cleanup" } }) : json({ error: { code: 404 } }, 404);
  });
  const request = { operationId: "deploy-cleanup", projectId, region: "europe-west1", serviceName: "napplet-cvm-api", imageReference: `us-docker.pkg.dev/${projectId}/control/control@sha256:${digest("f")}`, serviceAccountReference: "svc@napplet-cvm-run-1.iam.gserviceaccount.com", environmentReferenceSha256: digest("e"), secretReferences: [{ name: "DATABASE_URL", secret: "control-database-url", version: "1" }], minimumInstances: 3 as const, ingress: "internal-and-cloud-load-balancing" as const, concurrency: 80, admissionRefusal: "capacity_unavailable" as const };
  await client.cloudRun.deploy(request);
  const dispatched = await journal.read(request.operationId); await journal.markCompleted({ operationId: request.operationId, requestSha256: dispatched!.requestSha256, resourceUid: "uid-1", createTime: "2026-01-01T00:00:00Z", owned: true });
  await expect(client.cloudRun.cleanup({ operationId: request.operationId, projectId, region: request.region, serviceName: request.serviceName })).resolves.toEqual({ status: "completed" });
  expect(calls.find((call) => call.method === "DELETE")?.url).toContain("etag=service-etag-1");
  await expect(client.cloudRun.cleanup({ operationId: "not-owned", projectId, region: request.region, serviceName: request.serviceName })).rejects.toThrow("GOOGLE_CLEANUP_RUN_OWNERSHIP_REQUIRED");
});

test("Cloud Run LRO observation requires terminal ready configuration before completing the journal", async () => {
  const imageReference = `us-docker.pkg.dev/${projectId}/control/control@sha256:${digest("9")}`;
  const service = { name: `projects/${projectId}/locations/europe-west1/services/napplet-cvm-api`, uid: "uid-observe", createTime: "2026-01-01T00:00:00Z", generation: "3", observedGeneration: "3", reconciling: false, terminalCondition: { state: "CONDITION_SUCCEEDED" }, conditions: [{ type: "ConfigurationsReady", state: "CONDITION_SUCCEEDED" }], labels: { "napplet-cvm-operation": "deploy-observe" }, ingress: "INGRESS_TRAFFIC_INTERNAL_LOAD_BALANCER", scaling: { minInstanceCount: 3, maxInstanceCount: 3, scalingMode: "AUTOMATIC" }, template: { scaling: { minInstanceCount: 3, maxInstanceCount: 3 }, maxInstanceRequestConcurrency: 80, serviceAccount: "svc@napplet-cvm-run-1.iam.gserviceaccount.com", containers: [{ image: imageReference, resources: { limits: { cpu: "1", memory: "512Mi" }, cpuIdle: false, startupCpuBoost: false }, env: [{ name: "GOOGLE_CLOUD_PROJECT", value: projectId }, { name: "NAPPLET_CVM_ENVIRONMENT_SHA256", value: digest("8") }, { name: "DATABASE_URL", valueSource: { secretKeyRef: { secret: "control-database-url", version: "1" } } }] }] } };
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

test("Cloud Run conflict never grants cleanup ownership of a rival service", async () => {
  const { client } = await fixture((_url, init) => init.method === "POST" ? json({ error: { code: 409 } }, 409) : json({ error: { code: 404 } }, 404));
  const request = { operationId: "deploy-rival", projectId, region: "europe-west1", serviceName: "napplet-cvm-api", imageReference: `us-docker.pkg.dev/${projectId}/control/control@sha256:${digest("7")}`, serviceAccountReference: "svc@napplet-cvm-run-1.iam.gserviceaccount.com", environmentReferenceSha256: digest("6"), secretReferences: [{ name: "DATABASE_URL", secret: "control-database-url", version: "1" }], minimumInstances: 3 as const, ingress: "internal-and-cloud-load-balancing" as const, concurrency: 80, admissionRefusal: "capacity_unavailable" as const };
  await expect(client.cloudRun.deploy(request)).resolves.toEqual({ status: "blocked" });
  await expect(client.cloudRun.cleanup({ operationId: request.operationId, projectId, region: request.region, serviceName: request.serviceName })).rejects.toThrow("GOOGLE_CLEANUP_RUN_OWNERSHIP_REQUIRED");
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
    if (url.includes("?generation=9")) return json({ generation: "9", crc32c: checksum, kmsKeyName: "projects/p/locations/us/keyRings/r/cryptoKeys/k", metadata: { "napplet-cvm-content-sha256": "05080dc082c6df88129efbbe3f2c5a354e5348c963564f889914d0252f48b17d", "napplet-cvm-operation": "gcs-op-1" } });
    if (init.method === "GET") return json({ error: { code: 404 } }, 404);
    return json({ generation: "9", crc32c: checksum, kmsKeyName: "projects/p/locations/us/keyRings/r/cryptoKeys/k", metadata: { "napplet-cvm-content-sha256": "05080dc082c6df88129efbbe3f2c5a354e5348c963564f889914d0252f48b17d", "napplet-cvm-operation": "gcs-op-1" } });
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

test("GCS generation cleanup accepts documented bodyless 204 then verifies absence", async () => {
  const journal = createMemoryGoogleOperationJournal([{ operationId: "gcs-delete", resource: "b/napplet-cvm-artifacts/o/checkpoints/a.tar.zst", requestSha256: digest("a"), contentSha256: digest("b"), state: "completed", generation: "9", owned: true }]);
  let gets = 0;
  const { client, calls } = await fixture((_url, init) => {
    if (init.method === "DELETE") return new Response(null, { status: 204 });
    gets += 1; return gets === 1 ? json({ generation: "9" }) : json({ error: { code: 404 } }, 404);
  }, {}, journal);
  await expect(client.gcs.cleanupArtifact({ operationId: "gcs-delete", bucket: "napplet-cvm-artifacts", object: "checkpoints/a.tar.zst", generation: "9" })).resolves.toEqual({ status: "completed" });
  expect(calls.find((call) => call.method === "DELETE")?.url).toContain("ifGenerationMatch=9");
});

test("Cloud SQL observes its sole instance before official instances.insert", async () => {
  const { client, calls, journal } = await fixture((_url, init) => init.method === "GET" ? json({ error: { code: 404 } }, 404) : json({ name: "operation-1", status: "RUNNING" }));
  await expect(client.cloudSqlPostgres.provision({ operationId: "sql-op-1", instanceId: "napplet-cvm-sql-1", region: "europe-west1", databaseVersion: "POSTGRES_17", availabilityType: "REGIONAL", tier: "db-custom-2-7680", privateNetwork: "projects/napplet-cvm-run-1/global/networks/production", requireSsl: true, serializablePolicy: true })).resolves.toEqual({ status: "pending" });
  expect(await journal.read("sql-op-1")).toMatchObject({ state: "dispatched", operationName: "operation-1" });
  expect(calls.map((call) => call.url)).toEqual([`https://sqladmin.googleapis.com/v1/projects/${projectId}/instances/napplet-cvm-sql-1`, `https://sqladmin.googleapis.com/v1/projects/${projectId}/instances`]);
  expect(JSON.parse(calls[1]!.body)).toMatchObject({ databaseVersion: "POSTGRES_17", settings: { availabilityType: "REGIONAL", tier: "db-custom-2-7680", ipConfiguration: { privateNetwork: "projects/napplet-cvm-run-1/global/networks/production", ipv4Enabled: false, requireSsl: true } } });
});

test("Cloud SQL pins mounted storage size in both create intent and exact observation", async () => {
  const request = { ...sqlRequest("sql-storage"), storageGb: 20 };
  let reads = 0;
  const instance = (storageGb: number) => ({ name: request.instanceId, createTime: "2026-10-27T00:00:00Z", region: request.region, databaseVersion: "POSTGRES_17", state: "RUNNABLE", settings: { availabilityType: "REGIONAL", tier: request.tier, dataDiskSizeGb: storageGb, userLabels: { "napplet-cvm-operation": request.operationId }, backupConfiguration: { enabled: true }, ipConfiguration: { privateNetwork: request.privateNetwork, ipv4Enabled: false, requireSsl: true }, databaseFlags: [{ name: "default_transaction_isolation", value: "serializable" }] } });
  const { client, calls } = await fixture((url, init) => {
    if (init.method === "POST") return json({ name: "storage-operation", status: "PENDING" });
    if (url.includes("/operations/storage-operation")) return json({ status: "DONE" });
    reads += 1; return reads === 1 ? json({ error: { code: 404 } }, 404) : json(instance(20));
  });
  await expect(client.cloudSqlPostgres.provision(request)).resolves.toEqual({ status: "pending" });
  expect(JSON.parse(calls[1]!.body)).toMatchObject({ settings: { dataDiskSizeGb: 20 } });
  await expect(client.cloudSqlPostgres.observe({ operationId: request.operationId, instanceId: request.instanceId, region: request.region, tier: request.tier, privateNetwork: request.privateNetwork, storageGb: 20 })).resolves.toEqual({ status: "completed" });
  const wrong = await fixture(() => json(instance(21)));
  await expect(wrong.client.cloudSqlPostgres.provision(request)).resolves.not.toEqual({ status: "completed" });
});

test("Cloud SQL clone records the original source/destination operation and only observes its LRO", async () => {
  const input = { operationId: "restore-clone-1", sourceInstanceId: "napplet-cvm-sql-1", destinationInstanceId: "napplet-cvm-restore-1" };
  let destinationReads = 0;
  const { client, calls, journal } = await fixture((url, init) => {
    if (init.method === "POST") return json({ name: "clone-operation-1", status: "PENDING" });
    if (url.includes("/operations/clone-operation-1")) return json({ status: "DONE" });
    destinationReads += 1;
    return destinationReads === 1 ? json({ error: { code: 404 } }, 404) : json({ name: input.destinationInstanceId, createTime: "2026-10-27T00:00:00Z", state: "RUNNABLE" });
  });
  await expect(client.cloudSqlPostgres.clone(input)).resolves.toEqual({ status: "pending" });
  expect(calls.map(call => call.url)).toEqual([
    `https://sqladmin.googleapis.com/v1/projects/${projectId}/instances/${input.destinationInstanceId}`,
    `https://sqladmin.googleapis.com/v1/projects/${projectId}/instances/${input.sourceInstanceId}/clone`,
  ]);
  expect(JSON.parse(calls[1]!.body)).toEqual({ cloneContext: { kind: "sql#cloneContext", destinationInstanceName: input.destinationInstanceId } });
  expect(await journal.read(input.operationId)).toMatchObject({ state: "dispatched", operationName: "clone-operation-1" });
  await expect(client.cloudSqlPostgres.observeClone(input)).resolves.toEqual({ status: "completed" });
  expect(calls.filter(call => call.method === "POST")).toHaveLength(1);
});

test("Cloud SQL fresh-pool address is an observed unique private address", async () => {
  const { client } = await fixture(() => json({ name: "napplet-cvm-restore-1", state: "RUNNABLE", ipAddresses: [{ type: "PRIVATE", ipAddress: "10.12.1.7" }] }));
  await expect(client.cloudSqlPostgres.observePrivateAddress({ instanceId: "napplet-cvm-restore-1" })).resolves.toEqual({ status: "completed", privateAddress: "10.12.1.7" });
  const ambiguous = await fixture(() => json({ name: "napplet-cvm-restore-1", state: "RUNNABLE", ipAddresses: [{ type: "PRIVATE", ipAddress: "10.12.1.7" }, { type: "PRIVATE", ipAddress: "10.12.1.8" }] }));
  await expect(ambiguous.client.cloudSqlPostgres.observePrivateAddress({ instanceId: "napplet-cvm-restore-1" })).resolves.toEqual({ status: "unknown" });
});

test("ADC total deadline cancels a dribbling metadata body and aborts its requests", async () => {
  const expected = await googleAccountScopeSha256({ projectId, quotaProjectId: projectId, principal });
  let cancelled = false; const signals: AbortSignal[] = [];
  const source = createGoogleAdcTokenSource({ projectId, quotaProjectId: projectId, principal, accountScopeSha256: expected, timeoutMs: 20, fetch: async (url, init) => {
    signals.push(init.signal!);
    if (url.includes("project-id")) return new Response(projectId);
    if (url.endsWith("/email")) return new Response(principal);
    if (url.endsWith("/scopes")) { let timer: ReturnType<typeof setInterval> | undefined; return new Response(new ReadableStream<Uint8Array>({ start(controller) { timer = setInterval(() => controller.enqueue(new TextEncoder().encode("scope ")), 1); }, cancel() { if (timer !== undefined) clearInterval(timer); cancelled = true; } })); }
    return json({ access_token: token, expires_in: 300, token_type: "Bearer" });
  } });
  await expect(source.getAccessToken()).rejects.toThrow("ADC_APPLICATION_DEFAULT_LOGIN_REQUIRED");
  expect(cancelled).toBe(true);
  expect(signals.every((signal) => signal.aborted)).toBe(true);
});

test("provider response total deadline aborts fetch and cancels a never-ending JSON body", async () => {
  let cancelled = false; let signal: AbortSignal | undefined;
  const { client } = await fixture((_url, init) => {
    signal = init.signal!;
    let timer: ReturnType<typeof setInterval> | undefined;
    return new Response(new ReadableStream<Uint8Array>({ start(controller) { timer = setInterval(() => controller.enqueue(new TextEncoder().encode('{"partial":')), 1); }, cancel() { if (timer !== undefined) clearInterval(timer); cancelled = true; } }), { headers: { "content-type": "application/json" } });
  }, {}, undefined, 20);
  await expect(client.cloudRun.deploy(cloudRunRequest("body-timeout"))).resolves.toEqual({ status: "unknown" });
  expect(cancelled).toBe(true);
  expect(signal?.aborted).toBe(true);
});

test("provider fetch deadline aborts a never-resolving request without leaving a mutation in flight", async () => {
  let signal: AbortSignal | undefined;
  const { client } = await fixture((_url, init) => { signal = init.signal!; return new Promise<Response>(() => {}); }, {}, undefined, 5);
  await expect(client.cloudRun.deploy(cloudRunRequest("fetch-timeout"))).resolves.toEqual({ status: "unknown" });
  expect(signal?.aborted).toBe(true);
});

test("Cloud Run refuses replacement and only queries an already-dispatched cleanup LRO", async () => {
  const operationId = "run-cleanup"; const resource = `projects/${projectId}/locations/europe-west1/services/napplet-cvm-api`;
  const journal = createMemoryGoogleOperationJournal([
    { operationId, resource, requestSha256: digest("a"), contentSha256: digest("b"), state: "completed", owned: true, resourceUid: "service-uid-1", createTime: "2026-01-01T00:00:00Z" },
    { operationId: `${operationId}-cleanup`, resource, requestSha256: digest("c"), contentSha256: digest("d"), state: "dispatched", owned: false, operationName: `projects/${projectId}/locations/europe-west1/operations/delete-1` },
  ]);
  const { client, calls } = await fixture((url, init) => url.includes("/operations/delete-1") ? json({ done: false }) : json({ name: resource, etag: "changed-etag", uid: "service-uid-1", createTime: "2026-01-01T00:00:00Z", labels: { "napplet-cvm-operation": operationId } }), {}, journal);
  await expect(client.cloudRun.cleanup({ operationId, projectId, region: "europe-west1", serviceName: "napplet-cvm-api" })).resolves.toEqual({ status: "pending" });
  expect(calls.filter((call) => call.method === "DELETE")).toHaveLength(0);
  const replacement = await fixture((_url, _init) => json({ name: resource, etag: "etag", uid: "replacement-uid", createTime: "2026-02-01T00:00:00Z", labels: { "napplet-cvm-operation": operationId } }), {}, createMemoryGoogleOperationJournal([{ operationId, resource, requestSha256: digest("a"), contentSha256: digest("b"), state: "completed", owned: true, resourceUid: "service-uid-1", createTime: "2026-01-01T00:00:00Z" }]));
  await expect(replacement.client.cloudRun.cleanup({ operationId, projectId, region: "europe-west1", serviceName: "napplet-cvm-api" })).resolves.toEqual({ status: "unknown" });
  expect(replacement.calls.filter((call) => call.method === "DELETE")).toHaveLength(0);
});

test("Cloud Run never treats a completed cleanup journal as deletion while the service exists", async () => {
  const operationId = "run-done"; const resource = `projects/${projectId}/locations/europe-west1/services/napplet-cvm-api`;
  const journal = createMemoryGoogleOperationJournal([{ operationId, resource, requestSha256: digest("a"), contentSha256: digest("b"), state: "completed", owned: true, resourceUid: "service-uid-1", createTime: "2026-01-01T00:00:00Z" }, { operationId: `${operationId}-cleanup`, resource, requestSha256: digest("c"), contentSha256: digest("d"), state: "completed", owned: false }]);
  const { client, calls } = await fixture(() => json({ name: resource, etag: "etag", uid: "service-uid-1", createTime: "2026-01-01T00:00:00Z", labels: { "napplet-cvm-operation": operationId } }), {}, journal);
  await expect(client.cloudRun.cleanup({ operationId, projectId, region: "europe-west1", serviceName: "napplet-cvm-api" })).resolves.toEqual({ status: "pending" });
  expect(calls.filter((call) => call.method === "DELETE")).toHaveLength(0);
});

test("Cloud Run cleanup recovery reads a durable lost-ack journal and never sends a second DELETE", async () => {
  const operationId = "run-lost-cleanup"; const resource = `projects/${projectId}/locations/europe-west1/services/napplet-cvm-api`;
  const root = await mkdtemp(join(tmpdir(), "napplet-google-cleanup-recovery-"));
  let deleted = false; let deletes = 0;
  const service = { name: resource, etag: "service-etag-1", uid: "service-uid-1", createTime: "2026-01-01T00:00:00Z", labels: { "napplet-cvm-operation": operationId } };
  const handler = (_url: string, init: RequestInit) => {
    if (init.method === "DELETE") { deletes += 1; deleted = true; throw new Error("lost acknowledgement after delete"); }
    return deleted ? json({ error: { code: 404 } }, 404) : json(service);
  };
  try {
    const firstJournal = createFileGoogleOperationJournal(root);
    const original = await firstJournal.claim({ operationId, resource, requestSha256: digest("a"), contentSha256: digest("b"), owned: false });
    await firstJournal.markCompleted({ operationId, requestSha256: original.record.requestSha256, resourceUid: service.uid, createTime: service.createTime, owned: true });
    const first = await fixture(handler, {}, firstJournal);
    await expect(first.client.cloudRun.cleanup({ operationId, projectId, region: "europe-west1", serviceName: "napplet-cvm-api" })).resolves.toEqual({ status: "unknown" });
    expect(deletes).toBe(1);
    const fresh = await fixture(handler, {}, createFileGoogleOperationJournal(root));
    await expect(fresh.client.cloudRun.observeCleanup({ operationId, projectId, region: "europe-west1", serviceName: "napplet-cvm-api" })).resolves.toEqual({ status: "completed" });
    expect(deletes).toBe(1);
    expect(fresh.calls.filter((call) => call.method === "DELETE")).toHaveLength(0);
  } finally { await rm(root, { recursive: true, force: true }); }
});

test("Cloud Run query-only cleanup refuses a same-name replacement without claiming completion or deleting it", async () => {
  const operationId = "run-cleanup-replacement"; const resource = `projects/${projectId}/locations/europe-west1/services/napplet-cvm-api`;
  const journal = createMemoryGoogleOperationJournal([{ operationId, resource, requestSha256: digest("a"), contentSha256: digest("b"), state: "completed", owned: true, resourceUid: "original-uid", createTime: "2026-01-01T00:00:00Z" }]);
  const replacement = await fixture(() => json({ name: resource, etag: "replacement-etag", uid: "replacement-uid", createTime: "2026-02-01T00:00:00Z", labels: { "napplet-cvm-operation": operationId } }), {}, journal);
  await expect(replacement.client.cloudRun.observeCleanup({ operationId, projectId, region: "europe-west1", serviceName: "napplet-cvm-api" })).resolves.toEqual({ status: "unknown" });
  expect(replacement.calls.filter((call) => call.method === "DELETE")).toHaveLength(0);
  expect(await journal.read(`${operationId}-cleanup`)).toBeUndefined();
});

test("Cloud Run accepts actual v2 terminal success but rejects unsafe reconciliation variants", async () => {
  const valid = await fixture(() => json(cloudRunService("run-v2")));
  await expect(valid.client.cloudRun.deploy(cloudRunRequest("run-v2"))).resolves.toEqual({ status: "completed" });
  for (const [operationId, overrides] of [["run-failed", { terminalCondition: { state: "CONDITION_FAILED" } }], ["run-reconciling", { reconciling: true }], ["run-generation", { observedGeneration: "2" }], ["run-env", { template: { ...cloudRunService("run-env").template, containers: [{ ...cloudRunService("run-env").template.containers[0], env: [...cloudRunService("run-env").template.containers[0].env, { name: "EXTRA", value: "no" }] }] } }], ["run-duplicate", { template: { ...cloudRunService("run-duplicate").template, containers: [{ ...cloudRunService("run-duplicate").template.containers[0], env: [...cloudRunService("run-duplicate").template.containers[0].env, { name: "DATABASE_URL", value: "duplicate" }] }] } }], ["run-container", { template: { ...cloudRunService("run-container").template, containers: [...cloudRunService("run-container").template.containers, cloudRunService("run-container").template.containers[0]] } }]] as const) {
    const { client } = await fixture(() => json(cloudRunService(operationId, overrides)));
    await expect(client.cloudRun.deploy(cloudRunRequest(operationId))).resolves.not.toEqual({ status: "completed" });
  }
});

test("Cloud SQL binds stored intent before its existing-instance fast path and requires backups", async () => {
  const request = sqlRequest("sql-intent"); const resource = `projects/${projectId}/instances/${request.instanceId}`;
  const conflicting = await fixture(() => { throw new Error("must not observe after journal identity conflict"); }, {}, createMemoryGoogleOperationJournal([{ operationId: request.operationId, resource, requestSha256: digest("f"), contentSha256: digest("e"), state: "dispatched", owned: false }]));
  await expect(conflicting.client.cloudSqlPostgres.provision(request)).rejects.toThrow("GOOGLE_JOURNAL_IDENTITY_CONFLICT");
  let phase = 0;
  const { client } = await fixture((url, init) => {
    if (init.method === "POST") return json({ name: "operation-1", status: "RUNNING" });
    if (url.includes("/operations/operation-1")) return json({ status: "DONE" });
    phase += 1;
    if (phase === 1) return json({ error: { code: 404 } }, 404);
    return json({ name: request.instanceId, createTime: "2026-01-01T00:00:00Z", region: request.region, databaseVersion: "POSTGRES_17", state: "RUNNABLE", settings: { availabilityType: "REGIONAL", tier: request.tier, userLabels: { "napplet-cvm-operation": request.operationId }, backupConfiguration: { enabled: false }, ipConfiguration: { privateNetwork: request.privateNetwork, ipv4Enabled: false, requireSsl: true }, databaseFlags: [{ name: "default_transaction_isolation", value: "serializable" }] } });
  });
  await expect(client.cloudSqlPostgres.provision(request)).resolves.toEqual({ status: "pending" });
  await expect(client.cloudSqlPostgres.observe({ operationId: request.operationId, instanceId: request.instanceId, region: request.region, tier: request.tier, privateNetwork: request.privateNetwork })).resolves.toEqual({ status: "unknown" });
});

test("Cloud SQL cleanup rejects a same-label replacement with a different immutable createTime", async () => {
  const request = sqlRequest("sql-cleanup"); const resource = `projects/${projectId}/instances/${request.instanceId}`;
  const { client, calls } = await fixture(() => json({ name: request.instanceId, createTime: "2026-02-01T00:00:00Z", settings: { userLabels: { "napplet-cvm-operation": request.operationId } } }), {}, createMemoryGoogleOperationJournal([{ operationId: request.operationId, resource, requestSha256: digest("a"), contentSha256: digest("b"), state: "completed", owned: true, createTime: "2026-01-01T00:00:00Z" }]));
  await expect(client.cloudSqlPostgres.cleanup({ operationId: request.operationId, instanceId: request.instanceId })).resolves.toEqual({ status: "unknown" });
  expect(calls.filter((call) => call.method === "DELETE")).toHaveLength(0);
});

test("Cloud SQL cleanup observation reads only original ownership, deletion LRO and actual absence", async () => {
  const request = sqlRequest("sql-cleanup-read"), resource = `projects/${projectId}/instances/${request.instanceId}`;
  for (const scenario of ["absent", "replacement", "running", "done-still-present", "done-absent", "wrong-cleanup-resource"] as const) {
    const original = { operationId: request.operationId, resource, requestSha256: digest("a"), contentSha256: digest("b"), state: "completed" as const, owned: true, createTime: "2026-01-01T00:00:00Z" };
    const cleanup = { operationId: `${request.operationId}-cleanup`, resource: scenario === "wrong-cleanup-resource" ? "different-resource" : resource, requestSha256: digest("c"), contentSha256: digest("d"), state: "dispatched" as const, owned: false, operationName: "delete-original" };
    const journal = createMemoryGoogleOperationJournal([original, cleanup]);
    let reads = 0;
    const { client, calls } = await fixture(url => {
      if (url.endsWith("/operations/delete-original")) return json({ status: scenario === "running" ? "RUNNING" : "DONE" });
      reads++;
      if (scenario === "absent" || scenario === "done-absent" && reads === 2) return json({}, 404);
      return json({ name: request.instanceId, createTime: scenario === "replacement" ? "2026-02-01T00:00:00Z" : original.createTime, settings: { userLabels: { "napplet-cvm-operation": request.operationId } } });
    }, {}, journal);
    expect(await client.cloudSqlPostgres.observeCleanup({ operationId: request.operationId, instanceId: request.instanceId })).toEqual({ status: scenario === "absent" || scenario === "done-absent" ? "completed" : scenario === "replacement" || scenario === "wrong-cleanup-resource" ? "unknown" : "pending" });
    expect(calls.every(call => call.method === "GET")).toBe(true);
    expect(await journal.read(cleanup.operationId)).toEqual(cleanup);
  }
  const { client, calls } = await fixture(() => json({}, 404));
  await expect(client.cloudSqlPostgres.observeCleanup({ operationId: request.operationId, instanceId: request.instanceId })).rejects.toThrow("GOOGLE_CLEANUP_RUN_OWNERSHIP_REQUIRED");
  expect(calls).toHaveLength(0);
});

test("Cloud SQL never adopts a same-label replacement during provision or observe", async () => {
  const request = sqlRequest("sql-immutable"); const resource = `projects/${projectId}/instances/${request.instanceId}`; let currentCreateTime = "2026-01-01T00:00:00Z"; let instanceReads = 0; let posts = 0; let deletes = 0;
  const instance = () => ({ name: request.instanceId, createTime: currentCreateTime, region: request.region, databaseVersion: "POSTGRES_17", state: "RUNNABLE", settings: { availabilityType: "REGIONAL", tier: request.tier, userLabels: { "napplet-cvm-operation": request.operationId }, backupConfiguration: { enabled: true }, ipConfiguration: { privateNetwork: request.privateNetwork, ipv4Enabled: false, requireSsl: true }, databaseFlags: [{ name: "default_transaction_isolation", value: "serializable" }] } });
  const { client, journal } = await fixture((url, init) => {
    if (init.method === "POST") { posts += 1; return json({ name: "operation-immutable", status: "RUNNING" }); }
    if (init.method === "DELETE") { deletes += 1; return json({ name: "delete-immutable", status: "RUNNING" }); }
    if (url.includes("/operations/operation-immutable")) return json({ status: "DONE" });
    instanceReads += 1; return instanceReads === 1 ? json({ error: { code: 404 } }, 404) : json(instance());
  });
  await expect(client.cloudSqlPostgres.provision(request)).resolves.toEqual({ status: "pending" });
  await expect(client.cloudSqlPostgres.observe({ operationId: request.operationId, instanceId: request.instanceId, region: request.region, tier: request.tier, privateNetwork: request.privateNetwork })).resolves.toEqual({ status: "completed" });
  currentCreateTime = "2026-02-01T00:00:00Z";
  await expect(client.cloudSqlPostgres.provision(request)).resolves.toEqual({ status: "unknown" });
  await expect(client.cloudSqlPostgres.observe({ operationId: request.operationId, instanceId: request.instanceId, region: request.region, tier: request.tier, privateNetwork: request.privateNetwork })).resolves.toEqual({ status: "unknown" });
  await expect(client.cloudSqlPostgres.cleanup({ operationId: request.operationId, instanceId: request.instanceId })).resolves.toEqual({ status: "unknown" });
  expect(await journal.read(request.operationId)).toMatchObject({ owned: true, createTime: "2026-01-01T00:00:00Z" });
  expect(posts).toBe(1);
  expect(deletes).toBe(0);
});

test("Cloud Run cleanup requires persisted uid and createTime ownership proof", async () => {
  const operationId = "run-missing-proof"; const resource = `projects/${projectId}/locations/europe-west1/services/napplet-cvm-api`;
  const { client, calls } = await fixture(() => json({ name: resource }), {}, createMemoryGoogleOperationJournal([{ operationId, resource, requestSha256: digest("a"), contentSha256: digest("b"), state: "completed", owned: true }]));
  await expect(client.cloudRun.cleanup({ operationId, projectId, region: "europe-west1", serviceName: "napplet-cvm-api" })).rejects.toThrow("GOOGLE_CLEANUP_RUN_OWNERSHIP_REQUIRED");
  expect(calls).toHaveLength(0);
});

test("Cloud Run observe never adopts a same-label replacement before cleanup", async () => {
  const request = cloudRunRequest("run-immutable"); let current = cloudRunService(request.operationId); let serviceReads = 0; let deletes = 0;
  const { client, journal } = await fixture((url, init) => {
    if (init.method === "POST") return json({ name: `projects/${projectId}/locations/europe-west1/operations/run-immutable` });
    if (init.method === "DELETE") { deletes += 1; return json({ name: `projects/${projectId}/locations/europe-west1/operations/delete-immutable` }); }
    if (url.includes("/operations/run-immutable")) return json({ done: true });
    serviceReads += 1; return serviceReads === 1 ? json({ error: { code: 404 } }, 404) : json(current);
  });
  await expect(client.cloudRun.deploy(request)).resolves.toEqual({ status: "pending" });
  await expect(client.cloudRun.observe({ operationId: request.operationId, projectId, region: request.region, serviceName: request.serviceName, imageReference: request.imageReference, serviceAccountReference: request.serviceAccountReference, environmentReferenceSha256: request.environmentReferenceSha256, secretReferences: request.secretReferences, concurrency: request.concurrency })).resolves.toEqual({ status: "completed" });
  current = cloudRunService(request.operationId, { uid: "replacement-uid", createTime: "2026-02-01T00:00:00Z" });
  await expect(client.cloudRun.deploy(request)).resolves.toEqual({ status: "unknown" });
  await expect(client.cloudRun.observe({ operationId: request.operationId, projectId, region: request.region, serviceName: request.serviceName, imageReference: request.imageReference, serviceAccountReference: request.serviceAccountReference, environmentReferenceSha256: request.environmentReferenceSha256, secretReferences: request.secretReferences, concurrency: request.concurrency })).resolves.toEqual({ status: "unknown" });
  await expect(client.cloudRun.cleanup({ operationId: request.operationId, projectId, region: request.region, serviceName: request.serviceName })).resolves.toEqual({ status: "unknown" });
  expect(await journal.read(request.operationId)).toMatchObject({ owned: true, resourceUid: "service-uid-1", createTime: "2026-01-01T00:00:00Z" });
  expect(deletes).toBe(0);
});

test("GCS recovered bucket creation binds provider identity without a second POST", async () => {
  const operationId = "bucket-lost"; let gets = 0; let posts = 0;
  const bucket = { timeCreated: "2026-01-01T00:00:00Z", labels: { "napplet-cvm-operation": operationId }, location: "NAM4", versioning: { enabled: true }, encryption: { defaultKmsKeyName: "projects/p/locations/us/keyRings/r/cryptoKeys/k" }, retentionPolicy: { retentionPeriod: "2592000" }, softDeletePolicy: { retentionDurationSeconds: "0" }, lifecycle: { rule: [{ action: { type: "Delete" }, condition: { age: 30 } }, { action: { type: "Delete" }, condition: { numNewerVersions: 1 } }] } };
  const { client, journal } = await fixture((_url, init) => {
    if (init.method === "POST") { posts += 1; throw new Error("lost create response"); }
    gets += 1; return gets === 1 ? json({ error: { code: 404 } }, 404) : json(bucket);
  });
  const request = { operationId, bucket: "napplet-cvm-artifacts", encryptionKeyReference: "projects/p/locations/us/keyRings/r/cryptoKeys/k" };
  await expect(client.gcs.provisionBucket(request)).resolves.toEqual({ status: "unknown" });
  await expect(client.gcs.provisionBucket(request)).resolves.toEqual({ status: "completed" });
  expect(posts).toBe(1);
  expect(await journal.read(operationId)).toMatchObject({ owned: true, createTime: "2026-01-01T00:00:00Z" });
});

test("GCS refuses missing completed buckets, changed labels or keys, and replacement cleanup", async () => {
  const completed = createMemoryGoogleOperationJournal(); const bucketPolicy = { timeCreated: "2026-01-01T00:00:00Z", labels: { "napplet-cvm-operation": "bucket-done" }, location: "NAM4", versioning: { enabled: true }, encryption: { defaultKmsKeyName: "projects/p/locations/us/keyRings/r/cryptoKeys/k" }, retentionPolicy: { retentionPeriod: "2592000" }, softDeletePolicy: { retentionDurationSeconds: "0" }, lifecycle: { rule: [{ action: { type: "Delete" }, condition: { age: 30 } }, { action: { type: "Delete" }, condition: { numNewerVersions: 1 } }] } };
  let setupGets = 0;
  const setup = await fixture((_url, init) => { if (init.method === "POST") return json(bucketPolicy); setupGets += 1; return setupGets === 1 ? json({ error: { code: 404 } }, 404) : json(bucketPolicy); }, {}, completed);
  await expect(setup.client.gcs.provisionBucket({ operationId: "bucket-done", bucket: "napplet-cvm-artifacts", encryptionKeyReference: "projects/p/locations/us/keyRings/r/cryptoKeys/k" })).resolves.toEqual({ status: "completed" });
  const absent = await fixture((_url, init) => init.method === "POST" ? json({}) : json({ error: { code: 404 } }, 404), {}, completed);
  await expect(absent.client.gcs.provisionBucket({ operationId: "bucket-done", bucket: "napplet-cvm-artifacts", encryptionKeyReference: "projects/p/locations/us/keyRings/r/cryptoKeys/k" })).resolves.toEqual({ status: "unknown" });
  expect(absent.calls.filter((call) => call.method === "POST")).toHaveLength(0);
  const replacementProvision = await fixture(() => json({ ...bucketPolicy, timeCreated: "2026-02-01T00:00:00Z" }), {}, completed);
  await expect(replacementProvision.client.gcs.provisionBucket({ operationId: "bucket-done", bucket: "napplet-cvm-artifacts", encryptionKeyReference: "projects/p/locations/us/keyRings/r/cryptoKeys/k" })).resolves.toEqual({ status: "unknown" });
  expect(await completed.read("bucket-done")).toMatchObject({ owned: true, createTime: "2026-01-01T00:00:00Z" });
  expect(replacementProvision.calls.filter((call) => call.method === "POST" || call.method === "DELETE")).toHaveLength(0);
  const changed = await fixture(() => json({ timeCreated: "2026-01-01T00:00:00Z", labels: { "napplet-cvm-operation": "someone-else" }, location: "NAM4", versioning: { enabled: true }, encryption: { defaultKmsKeyName: "projects/p/locations/us/keyRings/r/cryptoKeys/other" }, retentionPolicy: { retentionPeriod: "2592000" }, softDeletePolicy: { retentionDurationSeconds: "0" }, lifecycle: { rule: [{ action: { type: "Delete" }, condition: { age: 30 } }, { action: { type: "Delete" }, condition: { numNewerVersions: 1 } }] } }));
  await expect(changed.client.gcs.provisionBucket({ operationId: "bucket-changed", bucket: "napplet-cvm-artifacts", encryptionKeyReference: "projects/p/locations/us/keyRings/r/cryptoKeys/k" })).resolves.toEqual({ status: "blocked" });
  const cleanup = await fixture(() => json({ timeCreated: "2026-02-01T00:00:00Z", metageneration: "1", labels: { "napplet-cvm-operation": "bucket-done" } }), {}, completed);
  await expect(cleanup.client.gcs.cleanupBucket({ operationId: "bucket-done", bucket: "napplet-cvm-artifacts" })).resolves.toEqual({ status: "unknown" });
  expect(cleanup.calls.filter((call) => call.method === "DELETE")).toHaveLength(0);
});

test("GCS never reports completed cleanup from its journal while the bucket still exists", async () => {
  const operationId = "bucket-cleanup"; const resource = "b/napplet-cvm-artifacts";
  const journal = createMemoryGoogleOperationJournal([{ operationId, resource, requestSha256: digest("a"), contentSha256: digest("b"), state: "completed", owned: true, createTime: "2026-01-01T00:00:00Z" }]);
  const bucket = { timeCreated: "2026-01-01T00:00:00Z", metageneration: "1", labels: { "napplet-cvm-operation": operationId } };
  let initialGets = 0;
  const first = await fixture((_url, init) => { if (init.method === "DELETE") return json({ error: { code: 404 } }, 404); initialGets += 1; return initialGets === 1 ? json(bucket) : json({ error: { code: 404 } }, 404); }, {}, journal);
  await expect(first.client.gcs.cleanupBucket({ operationId, bucket: "napplet-cvm-artifacts" })).resolves.toEqual({ status: "completed" });
  const retry = await fixture(() => json(bucket), {}, journal);
  await expect(retry.client.gcs.cleanupBucket({ operationId, bucket: "napplet-cvm-artifacts" })).resolves.toEqual({ status: "pending" });
  expect(retry.calls.filter((call) => call.method === "DELETE")).toHaveLength(0);
});

test("a 55-character operation ID can persist its 63-character cleanup ID in the file journal", async () => {
  const operationId = `a${"b".repeat(54)}`; const resource = `projects/${projectId}/locations/europe-west1/services/napplet-cvm-api`; const root = await mkdtemp(join(tmpdir(), "napplet-google-cleanup-id-"));
  try {
    const journal = createFileGoogleOperationJournal(root); const initial = await journal.claim({ operationId, resource, requestSha256: digest("a"), contentSha256: digest("b"), owned: true });
    await journal.markCompleted({ operationId, requestSha256: initial.record.requestSha256, resourceUid: "uid", createTime: "2026-01-01T00:00:00Z", owned: true });
    let gets = 0;
    const { client } = await fixture((_url, init) => { if (init.method === "DELETE") return json({ name: `projects/${projectId}/locations/europe-west1/operations/delete-1` }); gets += 1; return gets === 1 ? json({ name: resource, etag: "etag", uid: "uid", createTime: "2026-01-01T00:00:00Z", labels: { "napplet-cvm-operation": operationId } }) : json({ error: { code: 404 } }, 404); }, {}, journal);
    await expect(client.cloudRun.cleanup({ operationId, projectId, region: "europe-west1", serviceName: "napplet-cvm-api" })).resolves.toEqual({ status: "completed" });
    expect((await journal.read(`${operationId}-cleanup`))?.state).toBe("completed");
  } finally { await rm(root, { recursive: true, force: true }); }
});
