import { z } from "zod";

const ProjectIdSchema = z.string().regex(/^[a-z][a-z0-9-]{4,28}[a-z0-9]$/u);
const OperationIdSchema = z.string().regex(/^[a-z][a-z0-9_-]{2,127}$/u);
const RegionSchema = z.string().regex(/^[a-z]+-[a-z]+[0-9]$/u);
const DigestSchema = z.string().regex(/^[a-f0-9]{64}$/iu).transform((value) => value.toLowerCase());
const ImageDigestSchema = z.string().regex(/^sha256:[a-f0-9]{64}$/iu).transform((value) => value.toLowerCase());
const LoopbackOriginSchema = z.string().url().refine((value) => {
  const origin = new URL(value);
  return origin.protocol === "http:" && (origin.hostname === "127.0.0.1" || origin.hostname === "localhost");
}, "loopback origin required");

export type GoogleAccessToken = Readonly<{ token: string; projectId: string; quotaProjectId: string; expiresAtMs: number }>;
export type GoogleTokenSource = Readonly<{ getAccessToken(): Promise<GoogleAccessToken> }>;
export type GoogleFetch = (url: string, init: RequestInit) => Promise<Response>;

type GoogleClientOptions = Readonly<{
  projectId: string;
  quotaProjectId: string;
  apiOrigin: string;
  tokenSource: GoogleTokenSource;
  fetch: GoogleFetch;
  now?: () => number;
}>;

type SafeStatus = Readonly<{ status: "completed" | "missing" | "pending" | "unknown" | "blocked" }>;

function safeStatus(status: number): SafeStatus {
  if (status === 404) return Object.freeze({ status: "missing" });
  if (status === 401 || status === 403) return Object.freeze({ status: "blocked" });
  if (status >= 500 || status === 408 || status === 429) return Object.freeze({ status: "unknown" });
  return Object.freeze({ status: "blocked" });
}

function boundedJson(response: Response): Promise<unknown> {
  const type = response.headers.get("content-type") ?? "";
  if (!type.includes("application/json")) throw new Error("GOOGLE_CLIENT_RESPONSE_INVALID");
  return response.json();
}

function noNativeError(): never { throw new Error("GOOGLE_CLIENT_RESPONSE_INVALID"); }

/**
 * Creates a single bounded, injectable Google authority.  This constructor does
 * not discover ADC, read the metadata server, or make a request; 07-26 supplies
 * a protected token source and a non-loopback transport only after authorization.
 */
export function createGoogleDeploymentClients(options: GoogleClientOptions) {
  const projectId = ProjectIdSchema.parse(options.projectId);
  const quotaProjectId = ProjectIdSchema.parse(options.quotaProjectId);
  let apiOrigin: string;
  try { apiOrigin = LoopbackOriginSchema.parse(options.apiOrigin).replace(/\/$/u, ""); }
  catch { throw new Error("GOOGLE_CLIENT_LOOPBACK_REQUIRED"); }
  const now = options.now ?? Date.now;

  async function request(path: string, method: "GET" | "PUT" | "POST" | "DELETE", body?: unknown): Promise<Readonly<{ response: Response; body?: unknown }>> {
    const token = await options.tokenSource.getAccessToken();
    if (!token.token || token.expiresAtMs <= now() || token.projectId !== projectId || token.quotaProjectId !== quotaProjectId) {
      throw new Error("GOOGLE_CLIENT_ADC_SCOPE_INVALID");
    }
    let response: Response;
    try {
      response = await options.fetch(`${apiOrigin}${path}`, {
        method,
        headers: Object.freeze({ authorization: `Bearer ${token.token}`, "x-goog-user-project": quotaProjectId, "content-type": "application/json" }),
        ...(body === undefined ? {} : { body: JSON.stringify(body) }),
      });
    } catch { return Object.freeze({ response: new Response(null, { status: 503 }) }); }
    if (!response.ok) return Object.freeze({ response });
    try { return Object.freeze({ response, body: await boundedJson(response) }); }
    catch { return noNativeError(); }
  }

  const cloudRun = Object.freeze({
    projectId,
    async deploy(input: Readonly<{ operationId: string; projectId: string; region: string; serviceName: string; imageDigest: string; serviceAccountReference: string; environmentReferenceSha256: string; minimumInstances: 3; ingress: "internal-and-cloud-load-balancing"; concurrency: number; admissionRefusal: "capacity_unavailable" }>): Promise<void> {
      const operationId = OperationIdSchema.parse(input.operationId);
      if (ProjectIdSchema.parse(input.projectId) !== projectId) throw new Error("GOOGLE_CLIENT_PROJECT_SCOPE_INVALID");
      const region = RegionSchema.parse(input.region);
      const serviceName = z.string().regex(/^[a-z][a-z0-9-]{2,62}$/u).parse(input.serviceName);
      const imageDigest = ImageDigestSchema.parse(input.imageDigest);
      const response = await request(`/v2/projects/${projectId}/locations/${region}/services/${serviceName}`, "PUT", { operationId, imageDigest, serviceAccountReference: input.serviceAccountReference, environmentReferenceSha256: DigestSchema.parse(input.environmentReferenceSha256), minimumInstances: z.literal(3).parse(input.minimumInstances), ingress: z.literal("internal-and-cloud-load-balancing").parse(input.ingress), concurrency: z.number().int().min(1).max(1_000).parse(input.concurrency), admissionRefusal: z.literal("capacity_unavailable").parse(input.admissionRefusal) });
      if (!response.response.ok) throw new Error("GOOGLE_CLOUD_RUN_REQUEST_BLOCKED");
    },
    async observe(input: Readonly<{ operationId: string; projectId: string; region: string; serviceName: string }>): Promise<SafeStatus> {
      try {
        const operationId = OperationIdSchema.parse(input.operationId);
        if (ProjectIdSchema.parse(input.projectId) !== projectId) return Object.freeze({ status: "blocked" });
        const response = await request(`/v2/projects/${projectId}/locations/${RegionSchema.parse(input.region)}/operations/${operationId}`, "GET");
        if (!response.response.ok) return safeStatus(response.response.status);
        const payload = z.object({ name: z.string().max(512), done: z.boolean().optional() }).passthrough().safeParse(response.body);
        if (!payload.success || !payload.data.name.endsWith(operationId)) return Object.freeze({ status: "unknown" });
        return Object.freeze({ status: payload.data.done ? "completed" : "pending" });
      } catch { return Object.freeze({ status: "blocked" }); }
    },
  });

  const gcs = Object.freeze({
    projectId,
    async writeArtifact(input: Readonly<{ operationId: string; bucket: string; object: string; bytesBase64: string; expectedGeneration: string; checksum: string; location: "nam4"; versioning: true; retentionDays: number }>) {
      OperationIdSchema.parse(input.operationId);
      if (input.location !== "nam4" || input.versioning !== true || !Number.isInteger(input.retentionDays) || input.retentionDays < 30) throw new Error("GOOGLE_GCS_POLICY_INVALID");
      const response = await request(`/storage/v1/b/${encodeURIComponent(input.bucket)}/o/${encodeURIComponent(input.object)}`, "PUT", { operationId: input.operationId, data: input.bytesBase64, ifGenerationMatch: input.expectedGeneration, checksum: input.checksum, location: input.location, versioning: input.versioning, retentionDays: input.retentionDays });
      if (!response.response.ok) throw new Error("GOOGLE_GCS_REQUEST_BLOCKED");
      const payload = z.object({ generation: z.string(), md5Hash: z.string() }).passthrough().safeParse(response.body);
      if (!payload.success || payload.data.generation !== input.expectedGeneration || payload.data.md5Hash !== input.checksum) throw new Error("GOOGLE_GCS_OBSERVATION_INVALID");
      return Object.freeze({ status: "completed" as const, generation: payload.data.generation, checksum: payload.data.md5Hash });
    },
  });

  const cloudSqlPostgres = Object.freeze({
    projectId,
    async provision(input: Readonly<{ operationId: string; instanceId: string; region: string; databaseVersion: "POSTGRES_17"; availabilityType: "REGIONAL"; serializableProbe: true }>) {
      OperationIdSchema.parse(input.operationId);
      if (input.databaseVersion !== "POSTGRES_17" || input.availabilityType !== "REGIONAL" || input.serializableProbe !== true) throw new Error("GOOGLE_CLOUD_SQL_AUTHORITY_INVALID");
      const response = await request(`/sql/v1beta4/projects/${projectId}/instances`, "POST", { operationId: input.operationId, name: input.instanceId, region: RegionSchema.parse(input.region), databaseVersion: input.databaseVersion, settings: { availabilityType: input.availabilityType, transactionMode: "SERIALIZABLE" } });
      if (!response.response.ok) throw new Error("GOOGLE_CLOUD_SQL_REQUEST_BLOCKED");
      return Object.freeze({ status: "completed" as const });
    },
  });

  const collector = Object.freeze({
    projectId,
    async configure(input: Readonly<{ operationId: string; contractDigest: string; metricSeriesCount: number; redacted: true }>) {
      OperationIdSchema.parse(input.operationId);
      if (input.redacted !== true || input.metricSeriesCount < 1 || input.metricSeriesCount > 16) throw new Error("GOOGLE_COLLECTOR_CONTRACT_INVALID");
      const response = await request(`/collector/v1/projects/${projectId}/contracts`, "PUT", { operationId: input.operationId, contractDigest: DigestSchema.parse(input.contractDigest), metricSeriesCount: input.metricSeriesCount, redacted: true });
      if (!response.response.ok) throw new Error("GOOGLE_COLLECTOR_REQUEST_BLOCKED");
      return Object.freeze({ status: "completed" as const });
    },
  });

  const vertex = Object.freeze({
    projectId,
    async predict(input: Readonly<{ operationId: string; region: string; modelReference: string; requestDigest: string }>): Promise<SafeStatus> {
      try {
        const response = await request(`/v1/projects/${projectId}/locations/${RegionSchema.parse(input.region)}/publishers/google/models/${encodeURIComponent(input.modelReference)}:predict`, "POST", { operationId: OperationIdSchema.parse(input.operationId), requestDigest: DigestSchema.parse(input.requestDigest) });
        return response.response.ok ? Object.freeze({ status: "completed" }) : safeStatus(response.response.status);
      } catch { return Object.freeze({ status: "blocked" }); }
    },
  });

  return Object.freeze({ projectId, quotaProjectId, cloudRun, gcs, cloudSqlPostgres, collector, vertex });
}
