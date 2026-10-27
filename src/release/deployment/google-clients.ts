import { z } from "zod";
import { createGoogleAdcTokenSource, googleAccountScopeSha256, type GoogleAccessToken, type GoogleTokenSource } from "./google-auth";

export type { GoogleAccessToken, GoogleTokenSource } from "./google-auth";
export type GoogleFetch = (url: string, init: RequestInit) => Promise<Response>;

const ProjectIdSchema = z.string().regex(/^[a-z][a-z0-9-]{4,28}[a-z0-9]$/u);
const OperationIdSchema = z.string().regex(/^[a-z][a-z0-9_-]{2,127}$/u);
const RegionSchema = z.string().regex(/^[a-z]+-[a-z]+[0-9]$/u);
const ServiceNameSchema = z.string().regex(/^[a-z][a-z0-9-]{2,48}[a-z0-9]$/u);
const DigestSchema = z.string().regex(/^[a-f0-9]{64}$/iu).transform((value) => value.toLowerCase());
const ImageDigestSchema = z.string().regex(/^sha256:[a-f0-9]{64}$/iu).transform((value) => value.toLowerCase());
const BucketSchema = z.string().regex(/^[a-z0-9][a-z0-9._-]{1,220}[a-z0-9]$/u);
const ObjectSchema = z.string().min(1).max(1024).refine((value) => !value.startsWith("/") && !value.includes(".."), "object path required");
const InstanceSchema = z.string().regex(/^[a-z][a-z0-9-]{2,96}[a-z0-9]$/u);

export const GOOGLE_API_ORIGINS = Object.freeze({ cloudRun: "https://run.googleapis.com", storage: "https://storage.googleapis.com", cloudSql: "https://sqladmin.googleapis.com", collector: "https://run.googleapis.com", vertex: "https://aiplatform.googleapis.com" } as const);
type ApiName = keyof typeof GOOGLE_API_ORIGINS;
type SafeStatus = Readonly<{ status: "completed" | "missing" | "pending" | "unknown" | "blocked" }>;
export type GoogleOperationJournal = Readonly<{
  /** Persist original resource/request identity before the sole mutation. */
  persist(input: Readonly<{ operationId: string; resource: string; requestSha256: string }>): Promise<void>;
  /** Cleanup may affect only a resource created in this authorized run. */
  wasCreatedByRun(input: Readonly<{ operationId: string; resource: string }>): Promise<boolean>;
}>;

type GoogleClientOptions = Readonly<{
  projectId: string; quotaProjectId: string; principal: string; accountScopeSha256?: string;
  tokenSource?: GoogleTokenSource; fetch?: GoogleFetch; origins?: Partial<Record<ApiName, string>>;
  journal: GoogleOperationJournal; now?: () => number;
}>;

function statusFor(status: number): SafeStatus {
  if (status === 404) return Object.freeze({ status: "missing" });
  if ([401, 403, 400, 409, 412].includes(status)) return Object.freeze({ status: "blocked" });
  if (status === 408 || status === 429 || status >= 500) return Object.freeze({ status: "unknown" });
  return Object.freeze({ status: "blocked" });
}
function origin(value: string, expected: string): string {
  const parsed = new URL(value);
  if (parsed.protocol !== "https:" || parsed.origin !== expected) throw new Error("GOOGLE_CLIENT_ORIGIN_INVALID");
  return parsed.origin;
}
async function sha256(value: unknown): Promise<string> {
  const hash = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(JSON.stringify(value)));
  return Array.from(new Uint8Array(hash), (byte) => byte.toString(16).padStart(2, "0")).join("");
}
async function body(response: Response): Promise<unknown> {
  const claimed = Number(response.headers.get("content-length") ?? "0");
  if (!Number.isSafeInteger(claimed) || claimed < 0 || claimed > 1_000_000 || !response.headers.get("content-type")?.includes("application/json")) throw new Error("GOOGLE_CLIENT_RESPONSE_INVALID");
  const bytes = new Uint8Array(await response.arrayBuffer());
  if (bytes.byteLength === 0 || bytes.byteLength > 1_000_000) throw new Error("GOOGLE_CLIENT_RESPONSE_INVALID");
  try { return JSON.parse(new TextDecoder().decode(bytes)); } catch { throw new Error("GOOGLE_CLIENT_RESPONSE_INVALID"); }
}

/** Official HTTPS control-plane transports. Defaults are actual ADC and fetch;
 * callers may inject deterministic ports only for local contract tests. */
export function createGoogleDeploymentClients(options: GoogleClientOptions) {
  const projectId = ProjectIdSchema.parse(options.projectId); const quotaProjectId = ProjectIdSchema.parse(options.quotaProjectId); const principal = z.string().regex(/^[A-Za-z0-9@._:/-]{3,255}$/u).parse(options.principal);
  const now = options.now ?? Date.now; const fetcher = options.fetch ?? fetch;
  const origins = Object.freeze(Object.fromEntries((Object.keys(GOOGLE_API_ORIGINS) as ApiName[]).map((name) => [name, origin(options.origins?.[name] ?? GOOGLE_API_ORIGINS[name], GOOGLE_API_ORIGINS[name])])) as Record<ApiName, string>);
  const tokenSource = options.tokenSource ?? createGoogleAdcTokenSource({ projectId, quotaProjectId, principal, accountScopeSha256: options.accountScopeSha256, fetch: fetcher, now });
  async function request(api: ApiName, path: string, method: "GET" | "POST" | "DELETE", payload?: unknown, headers: Record<string, string> = {}, rawBody?: BodyInit): Promise<Readonly<{ response: Response; payload?: unknown }>> {
    const token = await tokenSource.getAccessToken(); const scope = await googleAccountScopeSha256({ projectId, quotaProjectId, principal });
    if (token.projectId !== projectId || token.quotaProjectId !== quotaProjectId || token.principal !== principal || token.accountScopeSha256 !== scope || token.expiresAtMs - 60_000 <= now() || token.scopes.length !== 1 || token.scopes[0] !== "https://www.googleapis.com/auth/cloud-platform") throw new Error("GOOGLE_CLIENT_ADC_SCOPE_INVALID");
    let response: Response;
    try { response = await fetcher(`${origins[api]}${path}`, { method, redirect: "error", headers: { authorization: `Bearer ${token.token}`, "x-goog-user-project": quotaProjectId, accept: "application/json", ...(payload === undefined && rawBody === undefined ? {} : { "content-type": "application/json" }), ...headers }, ...(rawBody !== undefined ? { body: rawBody } : payload === undefined ? {} : { body: JSON.stringify(payload) }) }); }
    catch { return Object.freeze({ response: new Response(null, { status: 503 }) }); }
    return response.ok ? Object.freeze({ response, payload: await body(response) }) : Object.freeze({ response });
  }
  async function persist(operationId: string, resource: string, payload: unknown): Promise<void> { await options.journal.persist({ operationId, resource, requestSha256: await sha256(payload) }); }

  const cloudRun = Object.freeze({ projectId,
    async deploy(input: Readonly<{ operationId: string; projectId: string; region: string; serviceName: string; imageDigest: string; serviceAccountReference: string; environmentReferenceSha256: string; minimumInstances: 3; ingress: "internal-and-cloud-load-balancing"; concurrency: number; admissionRefusal: "capacity_unavailable" }>): Promise<SafeStatus> {
      const operationId = OperationIdSchema.parse(input.operationId); if (ProjectIdSchema.parse(input.projectId) !== projectId) throw new Error("GOOGLE_CLIENT_PROJECT_SCOPE_INVALID");
      const region = RegionSchema.parse(input.region); const serviceName = ServiceNameSchema.parse(input.serviceName); const resource = `projects/${projectId}/locations/${region}/services/${serviceName}`;
      const service = { ingress: "INGRESS_TRAFFIC_INTERNAL_LOAD_BALANCER", template: { scaling: { minInstanceCount: z.literal(3).parse(input.minimumInstances) }, maxInstanceRequestConcurrency: z.number().int().min(1).max(1000).parse(input.concurrency), serviceAccount: z.string().min(3).max(255).parse(input.serviceAccountReference), containers: [{ image: ImageDigestSchema.parse(input.imageDigest), env: [{ name: "NAPPLET_CVM_ENVIRONMENT_SHA256", value: DigestSchema.parse(input.environmentReferenceSha256) }] }] } };
      const observed = await request("cloudRun", `/v2/${resource}`, "GET");
      if (observed.response.ok) {
        const matching = z.object({ name: z.literal(resource), template: z.object({ scaling: z.object({ minInstanceCount: z.literal(3) }), maxInstanceRequestConcurrency: z.literal(input.concurrency), serviceAccount: z.literal(input.serviceAccountReference), containers: z.array(z.object({ image: z.literal(input.imageDigest) }).passthrough()).min(1) }).passthrough() }).passthrough().safeParse(observed.payload);
        return matching.success ? Object.freeze({ status: "completed" }) : Object.freeze({ status: "unknown" });
      }
      if (observed.response.status !== 404) return statusFor(observed.response.status);
      await persist(operationId, resource, service);
      const created = await request("cloudRun", `/v2/projects/${projectId}/locations/${region}/services?serviceId=${encodeURIComponent(serviceName)}`, "POST", service);
      if (!created.response.ok) return statusFor(created.response.status);
      return z.object({ name: z.string().startsWith(`projects/${projectId}/locations/${region}/operations/`) }).passthrough().safeParse(created.payload).success ? Object.freeze({ status: "pending" }) : Object.freeze({ status: "unknown" });
    },
    async observe(input: Readonly<{ operationId: string; projectId: string; region: string; serviceName: string }>): Promise<SafeStatus> {
      OperationIdSchema.parse(input.operationId); if (ProjectIdSchema.safeParse(input.projectId).data !== projectId) return Object.freeze({ status: "blocked" });
      const region = RegionSchema.safeParse(input.region); const serviceName = ServiceNameSchema.safeParse(input.serviceName); if (!region.success || !serviceName.success) return Object.freeze({ status: "blocked" });
      const response = await request("cloudRun", `/v2/projects/${projectId}/locations/${region.data}/services/${serviceName.data}`, "GET"); if (!response.response.ok) return statusFor(response.response.status);
      return z.object({ name: z.literal(`projects/${projectId}/locations/${region.data}/services/${serviceName.data}`) }).passthrough().safeParse(response.payload).success ? Object.freeze({ status: "completed" }) : Object.freeze({ status: "unknown" });
    },
    async cleanup(input: Readonly<{ operationId: string; projectId: string; region: string; serviceName: string }>): Promise<SafeStatus> {
      const operationId = OperationIdSchema.parse(input.operationId); const region = RegionSchema.parse(input.region); const serviceName = ServiceNameSchema.parse(input.serviceName); if (ProjectIdSchema.parse(input.projectId) !== projectId) throw new Error("GOOGLE_CLIENT_PROJECT_SCOPE_INVALID");
      const resource = `projects/${projectId}/locations/${region}/services/${serviceName}`; if (!await options.journal.wasCreatedByRun({ operationId, resource })) throw new Error("GOOGLE_CLEANUP_RUN_OWNERSHIP_REQUIRED");
      const before = await request("cloudRun", `/v2/${resource}`, "GET"); if (before.response.status === 404) return Object.freeze({ status: "completed" }); if (!before.response.ok) return statusFor(before.response.status);
      await persist(`${operationId}-cleanup`, resource, { method: "delete" }); const deleted = await request("cloudRun", `/v2/${resource}`, "DELETE");
      if (!deleted.response.ok) return statusFor(deleted.response.status);
      const observed = await request("cloudRun", `/v2/${resource}`, "GET");
      return observed.response.status === 404 ? Object.freeze({ status: "completed" }) : observed.response.ok ? Object.freeze({ status: "pending" }) : statusFor(observed.response.status);
    },
  });

  const gcs = Object.freeze({ projectId,
    async observeBucketPolicy(input: Readonly<{ bucket: string; encryptionKeyReference: string }>): Promise<SafeStatus> {
      const bucket = BucketSchema.parse(input.bucket); const response = await request("storage", `/storage/v1/b/${encodeURIComponent(bucket)}`, "GET"); if (!response.response.ok) return statusFor(response.response.status);
      const policy = z.object({ location: z.literal("NAM4"), versioning: z.object({ enabled: z.literal(true) }), encryption: z.object({ defaultKmsKeyName: z.literal(input.encryptionKeyReference) }), retentionPolicy: z.object({ retentionPeriod: z.literal("2592000"), isLocked: z.boolean().optional() }), softDeletePolicy: z.object({ retentionDurationSeconds: z.string().regex(/^\d+$/u) }), lifecycle: z.object({ rule: z.array(z.object({ action: z.object({ type: z.literal("Delete") }), condition: z.object({ age: z.number().int().min(30).optional(), numNewerVersions: z.number().int().positive().optional() }).passthrough() }).passthrough()).min(2) }) }).passthrough().safeParse(response.payload);
      if (!policy.success || policy.data.retentionPolicy.isLocked === true) return Object.freeze({ status: "blocked" });
      const rules = policy.data.lifecycle.rule;
      const hasExpiry = rules.some((rule) => rule.condition.age !== undefined);
      const hasOldVersionExpiry = rules.some((rule) => rule.condition.numNewerVersions !== undefined);
      return hasExpiry && hasOldVersionExpiry && Number(policy.data.softDeletePolicy.retentionDurationSeconds) >= 2_592_000 ? Object.freeze({ status: "completed" }) : Object.freeze({ status: "blocked" });
    },
    async writeArtifact(input: Readonly<{ operationId: string; bucket: string; object: string; bytesBase64: string; checksum: string; encryptionKeyReference: string; location: "nam4"; versioning: true; retentionDays: 30 }>) {
      const operationId = OperationIdSchema.parse(input.operationId); const bucket = BucketSchema.parse(input.bucket); const object = ObjectSchema.parse(input.object);
      if (input.location !== "nam4" || input.versioning !== true || input.retentionDays !== 30 || !/^[A-Za-z0-9+/]{8,}={0,2}$/u.test(input.checksum)) throw new Error("GOOGLE_GCS_POLICY_INVALID");
      if ((await gcs.observeBucketPolicy({ bucket, encryptionKeyReference: input.encryptionKeyReference })).status !== "completed") throw new Error("GOOGLE_GCS_BUCKET_POLICY_INVALID");
      const resource = `b/${bucket}/o/${object}`; const existing = await request("storage", `/storage/v1/b/${encodeURIComponent(bucket)}/o/${encodeURIComponent(object)}`, "GET");
      if (existing.response.ok) { const observed = z.object({ generation: z.string(), crc32c: z.literal(input.checksum), kmsKeyName: z.literal(input.encryptionKeyReference) }).passthrough().safeParse(existing.payload); return observed.success ? Object.freeze({ status: "completed" as const, generation: observed.data.generation, checksum: observed.data.crc32c }) : Object.freeze({ status: "blocked" as const }); }
      if (existing.response.status !== 404) return Object.freeze(statusFor(existing.response.status));
      let bytes: Uint8Array;
      try { bytes = Uint8Array.from(atob(input.bytesBase64), (character) => character.charCodeAt(0)); } catch { throw new Error("GOOGLE_GCS_BYTES_INVALID"); }
      if (bytes.byteLength === 0 || bytes.byteLength > 1_000_000) throw new Error("GOOGLE_GCS_BYTES_INVALID");
      await persist(operationId, resource, { object, checksum: input.checksum, encryptionKeyReference: input.encryptionKeyReference });
      const uploaded = await request("storage", `/upload/storage/v1/b/${encodeURIComponent(bucket)}/o?uploadType=media&name=${encodeURIComponent(object)}&ifGenerationMatch=0&kmsKeyName=${encodeURIComponent(input.encryptionKeyReference)}`, "POST", undefined, { "content-type": "application/octet-stream", "x-goog-hash": `crc32c=${input.checksum}` }, bytes);
      if (!uploaded.response.ok) return Object.freeze(statusFor(uploaded.response.status)); const stored = z.object({ generation: z.string().regex(/^\d+$/u), crc32c: z.literal(input.checksum), kmsKeyName: z.literal(input.encryptionKeyReference) }).passthrough().safeParse(uploaded.payload);
      if (!stored.success) return Object.freeze({ status: "unknown" as const });
      const exact = await request("storage", `/storage/v1/b/${encodeURIComponent(bucket)}/o/${encodeURIComponent(object)}?generation=${encodeURIComponent(stored.data.generation)}`, "GET");
      if (!exact.response.ok) return Object.freeze(statusFor(exact.response.status));
      const observed = z.object({ generation: z.literal(stored.data.generation), crc32c: z.literal(input.checksum), kmsKeyName: z.literal(input.encryptionKeyReference) }).passthrough().safeParse(exact.payload);
      return observed.success ? Object.freeze({ status: "completed" as const, generation: observed.data.generation, checksum: observed.data.crc32c }) : Object.freeze({ status: "unknown" as const });
    },
  });

  const cloudSqlPostgres = Object.freeze({ projectId,
    async provision(input: Readonly<{ operationId: string; instanceId: string; region: string; databaseVersion: "POSTGRES_17"; availabilityType: "REGIONAL"; serializableProbe: true }>): Promise<SafeStatus> {
      const operationId = OperationIdSchema.parse(input.operationId); const instanceId = InstanceSchema.parse(input.instanceId); const region = RegionSchema.parse(input.region); if (input.databaseVersion !== "POSTGRES_17" || input.availabilityType !== "REGIONAL" || input.serializableProbe !== true) throw new Error("GOOGLE_CLOUD_SQL_AUTHORITY_INVALID");
      const resource = `projects/${projectId}/instances/${instanceId}`; const existing = await request("cloudSql", `/v1/projects/${projectId}/instances/${instanceId}`, "GET");
      if (existing.response.ok) {
        const matching = z.object({ name: z.literal(instanceId), region: z.literal(region), databaseVersion: z.literal("POSTGRES_17"), settings: z.object({ availabilityType: z.literal("REGIONAL") }).passthrough() }).passthrough().safeParse(existing.payload);
        return matching.success ? Object.freeze({ status: "completed" }) : Object.freeze({ status: "unknown" });
      }
      if (existing.response.status !== 404) return statusFor(existing.response.status);
      const instance = { name: instanceId, region, databaseVersion: "POSTGRES_17", settings: { availabilityType: "REGIONAL", backupConfiguration: { enabled: true }, databaseFlags: [{ name: "default_transaction_isolation", value: "serializable" }] } }; await persist(operationId, resource, instance);
      const created = await request("cloudSql", `/v1/projects/${projectId}/instances`, "POST", instance); if (!created.response.ok) return statusFor(created.response.status); return z.object({ name: z.string().min(1) }).passthrough().safeParse(created.payload).success ? Object.freeze({ status: "pending" }) : Object.freeze({ status: "unknown" });
    },
  });
  /* Collector deployment is Cloud Run. Vertex generation has no durable
   * operation lookup: Plan 65 owns its query-only reconciliation, so this
   * lower-level boundary deliberately returns unknown instead of inventing one. */
  const collector = Object.freeze({ projectId, deploy: cloudRun.deploy });
  const vertex = Object.freeze({ projectId, async predict(_input: Readonly<{ operationId: string; region: string; modelReference: string; requestDigest: string }>): Promise<SafeStatus> { return Object.freeze({ status: "unknown" }); } });
  return Object.freeze({ projectId, quotaProjectId, cloudRun, gcs, cloudSqlPostgres, collector, vertex });
}
