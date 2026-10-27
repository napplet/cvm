import { createHash } from "node:crypto";
import { z } from "zod";
import { canonicalJson } from "../promotion/schema";
import { LifecycleObservationSchema, LifecycleStageSchema } from "../telemetry/contracts";
import { validateAuthorizationReceipt, validateAuthorizationRequest } from "../release/authorization";
import { assertPostgresOperationJournal, type PostgresOperationJournal } from "../release/deployment/postgres-operation-journal";
import type { GoogleTokenSource } from "../release/deployment/google-auth";
import type { PrivateControlIdentity } from "../release/deployment/production-core-control";
import type { ProductionCertificationServices } from "../release/deployment/production-core-suite-protocol";
import { assertCollectorAccepted, collectorLifecyclePackets, parseCollectorLifecycleWindow } from "./collector-wire";

const Digest = z.string().regex(/^[a-f0-9]{64}$/u);
const Binding = z.object({ candidateId: Digest, topologySha256: Digest, datasetSha256: Digest, profileSha256: Digest, collectorDigest: z.string().regex(/^sha256:[a-f0-9]{64}$/u), configSha256: Digest }).strict();
const Deployment = z.object({
  projectId: z.string().regex(/^[a-z][a-z0-9-]{4,28}[a-z0-9]$/u), region: z.string().regex(/^[a-z]+-[a-z]+[0-9]$/u),
  serviceName: z.string().regex(/^[a-z][a-z0-9-]{2,62}$/u), revisionName: z.string().regex(/^[a-z][a-z0-9-]{2,62}$/u),
  endpoint: z.string().url(), imageReference: z.string().regex(/^[a-z0-9.-]+(?:\/[a-z0-9._-]+)+@sha256:[a-f0-9]{64}$/u),
  accountScopeSha256: Digest, projectScopeSha256: Digest, principal: z.string().min(3).max(255),
}).strict();
const sha = (value: unknown) => createHash("sha256").update(canonicalJson(value)).digest("hex");
type Packet = ReturnType<typeof collectorLifecyclePackets>;
type Original = Readonly<{ operationId: string; windowSha256: string; packet: Packet }>;
type Input = Readonly<{
  binding: z.infer<typeof Binding>; deployment: z.infer<typeof Deployment>;
  authorization: Readonly<{ request: unknown; receipt: unknown }>;
  journal: PostgresOperationJournal; identity: PrivateControlIdentity; tokenSource: GoogleTokenSource;
  fetch?: (url: string, init: RequestInit) => Promise<Response>; now?: () => number;
}>;
const instances = new WeakSet<object>();
export function assertProductionTelemetryCertification(value: unknown): asserts value is ProductionTelemetryCertification {
  if (!value || typeof value !== "object" || !instances.has(value)) throw new Error("PRODUCTION_TELEMETRY_REQUIRED");
}

/** Private Cloud Run OTLP and authenticated Cloud Logging observations. Durable
 * intent is only the expected identity; actual collector output supplies facts.
 * Re-entry never re-emits an uncertain signal. */
export class ProductionTelemetryCertification implements Pick<ProductionCertificationServices, "emitTelemetry" | "telemetryWindow"> {
  readonly #binding: z.infer<typeof Binding>;
  readonly #deployment: z.infer<typeof Deployment>;
  readonly #window: string;
  constructor(private readonly input: Input) {
    assertPostgresOperationJournal(input.journal);
    this.#binding = Object.freeze(Binding.parse(input.binding));
    this.#deployment = Object.freeze(Deployment.parse(input.deployment));
    const url = new URL(this.#deployment.endpoint);
    if (url.protocol !== "https:" || !/^[a-z0-9-]+\.run\.app$/u.test(url.hostname) || url.port || url.username || url.password || url.pathname !== "/" || url.search || url.hash) throw new Error("COLLECTOR_ORIGIN_INVALID");
    if (!this.#deployment.imageReference.endsWith(`@${this.#binding.collectorDigest}`)) throw new Error("COLLECTOR_IMAGE_BINDING_INVALID");
    this.#window = sha({ binding: this.#binding, authorization: input.authorization.request }); instances.add(this);
  }
  #now() { return (this.input.now ?? Date.now)(); }
  async #authorize(readOnly = false) {
    const request = await validateAuthorizationRequest(this.input.authorization.request);
    await validateAuthorizationReceipt({ ...this.input.authorization, request, nowMs: readOnly ? Math.min(this.#now(), request.expiresAtMs - 1) : this.#now() });
    if (request.candidateSha256 !== this.#binding.candidateId || request.topologySha256 !== this.#binding.topologySha256
      || !request.orderedEffects.some(effect => effect.provider === "collector")
      || !request.providerScopes.some(scope => scope.provider === "collector" && scope.accountScopeSha256 === this.#deployment.accountScopeSha256 && scope.projectScopeSha256 === this.#deployment.projectScopeSha256)) throw new Error("COLLECTOR_AUTHORIZATION_BINDING_INVALID");
    return request;
  }
  async #json(url: string, init: RequestInit, limit: number): Promise<unknown> {
    const controller = new AbortController(); const timer = setTimeout(() => controller.abort(), 10_000);
    try {
      const response = await (this.input.fetch ?? fetch)(url, { ...init, redirect: "error", signal: controller.signal });
      if (!response.ok || !response.body) throw new Error("COLLECTOR_HTTP_UNAVAILABLE");
      const reader = response.body.getReader(); const chunks: Uint8Array[] = []; let length = 0; let done = false;
      try { for (;;) { const part = await reader.read(); if (part.done) { done = true; break; } length += part.value.byteLength; if (length > limit) throw new Error("COLLECTOR_RESPONSE_TOO_LARGE"); chunks.push(part.value); } }
      finally { if (!done) void reader.cancel(); reader.releaseLock(); }
      return JSON.parse(Buffer.concat(chunks).toString("utf8"));
    } finally { controller.abort(); clearTimeout(timer); }
  }
  async #bounded<T>(promise: Promise<T>): Promise<T> {
    let timer: ReturnType<typeof setTimeout> | undefined;
    try { return await Promise.race([promise, new Promise<never>((_, reject) => { timer = setTimeout(() => reject(new Error("COLLECTOR_AUTH_TIMEOUT")), 5_000); })]); }
    finally { clearTimeout(timer); }
  }
  async #google(url: string, body?: unknown): Promise<unknown> {
    await this.#authorize(true);
    const token = await this.#bounded(this.input.tokenSource.getAccessToken());
    if (token.projectId !== this.#deployment.projectId || token.quotaProjectId !== this.#deployment.projectId || token.principal !== this.#deployment.principal || token.accountScopeSha256 !== this.#deployment.accountScopeSha256 || token.expiresAtMs <= this.#now() + 10_000) throw new Error("COLLECTOR_ADC_BINDING_INVALID");
    return this.#json(url, { method: body === undefined ? "GET" : "POST", headers: { authorization: `Bearer ${token.token}`, "content-type": "application/json", "x-goog-user-project": token.quotaProjectId }, ...(body === undefined ? {} : { body: canonicalJson(body) }) }, 8_388_608);
  }
  #stageKey(stage: string) { return `collector:${this.#window}:${stage}`; }
  #canaries() {
    const base = { version: "admission-lifecycle-v1", correlationDigest: `sha256:${this.#binding.candidateId}`, stage: "generation", monotonicMs: 1 };
    const invalid = [{ ...base, prompt: "cvm-private-canary" }, { ...base, stage: "cvm-private-canary" }, { ...base, correlationDigest: "cvm-private-canary" }, { ...base, outcome: "cvm-private-canary" }];
    for (const observation of invalid) {
      let rejected = false;
      try { collectorLifecyclePackets({ operationId: "canary", windowSha256: this.#window, observation, nowMs: this.#now() }); } catch { rejected = true; }
      if (!rejected) throw new Error("COLLECTOR_CANARY_ACCEPTED");
    }
  }
  async emitTelemetry(input: Parameters<ProductionCertificationServices["emitTelemetry"]>[0]) {
    await this.#authorize(); this.#canaries();
    const observation = LifecycleObservationSchema.parse(input.observation);
    if (observation.correlationDigest !== `sha256:${this.#binding.candidateId}`) throw new Error("COLLECTOR_CORRELATION_MISMATCH");
    const identity = sha({ operationId: input.operationId, observation, windowSha256: this.#window });
    const packet = collectorLifecyclePackets({ ...input, observation, windowSha256: this.#window, nowMs: this.#now() });
    const claim = await this.input.journal.claim<Original>(this.#stageKey(observation.stage), identity, { operationId: input.operationId, windowSha256: this.#window, packet });
    if (!claim.claimed) return this.observeEmission(input);
    const original = claim.record.value;
    await this.#assertDeployment();
    for (const signal of ["traces", "metrics"] as const) {
      // Claim before authentication or network. Failure remains query-only.
      const dispatch = await this.input.journal.claim(`${this.#stageKey(observation.stage)}:${signal}`, identity, { state: "attempted" });
      if (!dispatch.claimed) throw new Error("COLLECTOR_ORIGINAL_QUERY_REQUIRED");
      await this.#authorize();
      const token = await this.#bounded(this.input.identity.token(this.#deployment.endpoint));
      if (!/^[A-Za-z0-9_.-]{20,16384}$/u.test(token)) throw new Error("COLLECTOR_IDENTITY_INVALID");
      await this.#authorize();
      assertCollectorAccepted(await this.#json(`${this.#deployment.endpoint.replace(/\/$/u, "")}/v1/${signal}`, { method: "POST", headers: { authorization: `Bearer ${token}`, "content-type": "application/json" }, body: canonicalJson(original.packet[signal]) }, 16_384));
    }
    return Object.freeze({ status: "accepted" as const });
  }
  async #assertDeployment() {
    const d = this.#deployment;
    const resource = `projects/${d.projectId}/locations/${d.region}/services/${d.serviceName}`;
    const revisionName = `${resource}/revisions/${d.revisionName}`;
    const revision = z.object({ name: z.literal(revisionName), service: z.literal(resource), reconciling: z.literal(false).optional(), containers: z.array(z.object({ image: z.literal(d.imageReference), ports: z.array(z.object({ containerPort: z.literal(4318) }).passthrough()).length(1) }).passthrough()).length(1), conditions: z.array(z.object({ type: z.string(), state: z.string() }).passthrough()) }).passthrough().parse(await this.#google(`https://run.googleapis.com/v2/${revisionName}`));
    if (!revision.conditions.some(value => value.type === "Ready" && value.state === "CONDITION_SUCCEEDED")) throw new Error("COLLECTOR_REVISION_NOT_READY");
    const service = z.object({ name: z.literal(resource), uri: z.literal(d.endpoint.replace(/\/$/u, "")), ingress: z.literal("INGRESS_TRAFFIC_INTERNAL_LOAD_BALANCER"), reconciling: z.literal(false).optional(), invokerIamDisabled: z.literal(false).optional(), terminalCondition: z.object({ state: z.literal("CONDITION_SUCCEEDED") }).passthrough(), trafficStatuses: z.array(z.object({ revision: z.literal(d.revisionName), percent: z.literal(100) }).passthrough()).length(1) }).passthrough().parse(await this.#google(`https://run.googleapis.com/v2/${resource}`));
    const policy = z.object({ bindings: z.array(z.object({ role: z.string(), members: z.array(z.string()).max(1000) }).passthrough()).max(1000).optional() }).passthrough().parse(await this.#google(`https://run.googleapis.com/v2/${resource}:getIamPolicy`));
    if (policy.bindings?.some(binding => binding.members.some(member => member === "allUsers" || member === "allAuthenticatedUsers"))) throw new Error("COLLECTOR_PUBLIC_INVOKER_DENIED");
    return service;
  }
  async #entries() {
    const request = await this.#authorize(true); const d = this.#deployment;
    await this.#assertDeployment();
    const filter = [
      'resource.type="cloud_run_revision"', `resource.labels.project_id="${d.projectId}"`, `resource.labels.location="${d.region}"`, `resource.labels.service_name="${d.serviceName}"`, `resource.labels.revision_name="${d.revisionName}"`,
      `timestamp>="${new Date(request.estimateObservedAtMs).toISOString()}"`, `timestamp<="${new Date(request.expiresAtMs).toISOString()}"`, 'jsonPayload."otelcol.component.id"="debug"',
    ].join(" AND ");
    const entries: unknown[] = []; const tokens = new Set<string>(); let pageToken: string | undefined;
    for (let page = 0; page < 20; page++) {
      const result = z.object({ entries: z.array(z.object({ resource: z.object({ type: z.literal("cloud_run_revision"), labels: z.object({ project_id: z.literal(d.projectId), location: z.literal(d.region), service_name: z.literal(d.serviceName), revision_name: z.literal(d.revisionName) }).passthrough() }).passthrough(), timestamp: z.string().datetime({ offset: true }), jsonPayload: z.record(z.string(), z.unknown()) }).passthrough()).max(100).optional(), nextPageToken: z.string().min(1).max(4096).optional() }).passthrough().parse(await this.#google("https://logging.googleapis.com/v2/entries:list", { resourceNames: [`projects/${d.projectId}`], filter, orderBy: "timestamp asc", pageSize: 100, ...(pageToken ? { pageToken } : {}) }));
      for (const entry of result.entries ?? []) {
        const time = Date.parse(entry.timestamp);
        if (time < request.estimateObservedAtMs || time > request.expiresAtMs) throw new Error("COLLECTOR_ENTRY_OUTSIDE_WINDOW");
        entries.push(entry.jsonPayload);
      }
      if (!result.nextPageToken) return entries;
      if (tokens.has(result.nextPageToken)) throw new Error("COLLECTOR_PAGE_CYCLE");
      tokens.add(result.nextPageToken); pageToken = result.nextPageToken;
    }
    throw new Error("COLLECTOR_WINDOW_BOUND_EXCEEDED");
  }
  async observeEmission(input: Parameters<ProductionCertificationServices["emitTelemetry"]>[0]) {
    await this.#authorize(true);
    const observation = LifecycleObservationSchema.parse(input.observation);
    const original = await this.input.journal.read<Original>(this.#stageKey(observation.stage));
    if (!original || original.identitySha256 !== sha({ operationId: input.operationId, observation, windowSha256: this.#window })) throw new Error("COLLECTOR_ORIGINAL_REQUIRED");
    const expected: Packet[] = [];
    for (const stage of LifecycleStageSchema.options) {
      const record = await this.input.journal.read<Original>(this.#stageKey(stage));
      if (record) expected.push(record.value.packet);
    }
    parseCollectorLifecycleWindow({ windowSha256: this.#window, entries: await this.#entries(), expected });
    return Object.freeze({ status: "observed" as const });
  }
  async telemetryWindow(input: Parameters<ProductionCertificationServices["telemetryWindow"]>[0]) {
    if (canonicalJson(Binding.parse(input.binding)) !== canonicalJson(this.#binding)) throw new Error("COLLECTOR_WINDOW_BINDING_INVALID");
    await this.#authorize(true); this.#canaries();
    const expected: Packet[] = [];
    for (const stage of LifecycleStageSchema.options) {
      const original = await this.input.journal.read<Original>(this.#stageKey(stage));
      if (!original || original.value.windowSha256 !== this.#window) throw new Error("COLLECTOR_ORIGINAL_REQUIRED");
      expected.push(original.value.packet);
    }
    const window = parseCollectorLifecycleWindow({ windowSha256: this.#window, entries: await this.#entries(), expected });
    return Object.freeze({ status: "observed" as const, binding: this.#binding, ...window, rejectedCanaries: true as const });
  }
}
