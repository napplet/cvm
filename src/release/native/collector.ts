import { z } from "zod";
import {
  validateAuthorizationReceipt,
  validateAuthorizationRequest,
  type ReleaseAuthorizationReceipt,
  type ReleaseAuthorizationRequest,
} from "../authorization";
import type { LiveTelemetryObservationPort } from "../../certification/live/telemetry";
import { LifecycleObservationSchema, type LifecycleObservation } from "../../telemetry/contracts";
import { lifecycleCardinalityUpperBound } from "../../telemetry/redaction";
import { canonicalJson } from "../../promotion/schema";

const DigestSchema = z.string().regex(/^[a-f0-9]{64}$/iu).transform((value) => value.toLowerCase());
const CollectorDigestSchema = z.string().regex(/^sha256:[a-f0-9]{64}$/iu).transform((value) => value.toLowerCase());
const OperationIdSchema = z.string().regex(/^[a-z][a-z0-9_-]{2,127}$/u);
const ProjectIdSchema = z.string().regex(/^[a-z][a-z0-9-]{4,28}[a-z0-9]$/u);
const EndpointReferenceSchema = z.string().regex(/^collector\/[a-z0-9][a-z0-9._/-]{1,250}$/u);
const WindowBindingSchema = z.object({
  candidateId: DigestSchema, topologySha256: DigestSchema, datasetSha256: DigestSchema, profileSha256: DigestSchema,
  collectorDigest: CollectorDigestSchema, configSha256: DigestSchema,
}).strict();
const WindowSchema = z.object({
  status: z.literal("observed"), binding: WindowBindingSchema, observations: z.array(LifecycleObservationSchema),
  rejectedCanaries: z.literal(true), metricSeriesCount: z.number().int().nonnegative(),
}).strict();
const CollectorConfigSchema = z.object({
  candidateSha256: DigestSchema, topologySha256: DigestSchema, effectPlanSha256: DigestSchema,
  accountScopeSha256: DigestSchema, projectScopeSha256: DigestSchema, projectId: ProjectIdSchema,
  endpointReference: EndpointReferenceSchema, endpointReferenceSha256: DigestSchema,
  collectorDigest: CollectorDigestSchema, configSha256: DigestSchema,
}).strict();
type CollectorConfig = z.infer<typeof CollectorConfigSchema>;

const ProviderObservationSchema = z.union([
  z.object({ status: z.literal("completed"), endpointReferenceSha256: DigestSchema }).strict(),
  z.object({ status: z.enum(["missing", "pending", "unknown", "blocked"]) }).strict(),
]);
type ProviderObservation = z.infer<typeof ProviderObservationSchema>;
const CleanupObservationSchema = z.object({ status: z.enum(["cleaned", "missing", "pending", "unknown", "blocked"]) }).strict();

export type CollectorControlPlanePort = Readonly<{
  persist(input: Readonly<{ operationId: string; kind: "configure" | "cleanup"; authorizationRequestSha256: string; authorizationReceiptSha256: string; projectScopeSha256: string }>): Promise<void>;
  observe(input: Readonly<{ operationId: string; projectId: string; endpointReferenceSha256: string }>): Promise<unknown>;
  /** Query-only cleanup reconciliation; it must never issue a delete. */
  observeCleanup(input: Readonly<{ operationId: string; projectId: string; endpointReferenceSha256: string }>): Promise<unknown>;
  configure(input: Readonly<{ operationId: string; projectId: string; endpointReference: string; endpointReferenceSha256: string; collectorDigest: string; configSha256: string }>): Promise<void>;
  /** Resolves only after provider deletion is actually observed. */
  deleteCollector(input: Readonly<{ operationId: string; projectId: string; endpointReference: string; endpointReferenceSha256: string }>): Promise<void>;
  emit(input: Readonly<{ endpointReferenceSha256: string; observation: LifecycleObservation }>): Promise<void>;
  queryWindow(input: Readonly<{ endpointReferenceSha256: string; binding: z.infer<typeof WindowBindingSchema> }>): Promise<unknown>;
}>;

export type CollectorProviderInput = Readonly<{ request: unknown; receipt: unknown; operationId: string }>;
type Authorized = Readonly<{ request: ReleaseAuthorizationRequest; receipt: ReleaseAuthorizationReceipt; operationId: string }>;

async function sha256(value: unknown): Promise<string> {
  const bytes = new TextEncoder().encode(canonicalJson(value));
  const hash = await crypto.subtle.digest("SHA-256", bytes);
  return Array.from(new Uint8Array(hash), (byte) => byte.toString(16).padStart(2, "0")).join("");
}

function hasSensitiveValue(value: unknown): boolean {
  const sensitive = /(?:prompt|revision|source|token|preimage|secret|credential|private|nsec|cashu|lightning|native receipt|contextvm|cli output|runtime message)/iu;
  if (typeof value === "string") return sensitive.test(value);
  if (Array.isArray(value)) return value.some(hasSensitiveValue);
  if (value && typeof value === "object") return Object.entries(value as Record<string, unknown>).some(([key, child]) => sensitive.test(key) || hasSensitiveValue(child));
  return false;
}

function collectorScopeIsBound(request: ReleaseAuthorizationRequest, config: CollectorConfig): boolean {
  const effects = request.orderedEffects.filter((effect) => effect.provider === "collector");
  const scopes = request.providerScopes.filter((scope) => scope.provider === "collector");
  return effects.length === 1 && effects[0]?.id === "collector" && effects[0]?.operation === "configure"
    && scopes.length === 1 && scopes[0]?.accountScopeSha256 === config.accountScopeSha256 && scopes[0]?.projectScopeSha256 === config.projectScopeSha256;
}

async function authorize(input: CollectorProviderInput, config: CollectorConfig, nowMs: number): Promise<Authorized> {
  try {
    const request = await validateAuthorizationRequest(input.request);
    const receipt = await validateAuthorizationReceipt({ request, receipt: input.receipt, nowMs });
    const operationId = OperationIdSchema.parse(input.operationId);
    if (request.candidateSha256 !== config.candidateSha256 || request.topologySha256 !== config.topologySha256 || request.effectPlanSha256 !== config.effectPlanSha256
      || receipt.candidateSha256 !== config.candidateSha256 || receipt.topologySha256 !== config.topologySha256 || receipt.effectPlanSha256 !== config.effectPlanSha256
      || !collectorScopeIsBound(request, config)) throw new Error("scope");
    return Object.freeze({ request, receipt, operationId });
  } catch {
    throw new Error("COLLECTOR_AUTHORIZATION_INVALID");
  }
}

/**
 * The collector boundary stores only a named endpoint reference and digests.
 * Its injected port is the sole place protected runners can hold credentials or
 * instantiate an OTLP client; lifecycle data is checked again before crossing it.
 */
export function createNativeCollectorProvider(input: Readonly<{ config: unknown; port: CollectorControlPlanePort; now?: () => number }>) {
  const config = Object.freeze(CollectorConfigSchema.parse(input.config));
  const now = input.now ?? Date.now;

  async function observeAuthorized(authorized: Authorized): Promise<ProviderObservation> {
    const observation = ProviderObservationSchema.parse(await input.port.observe({ operationId: authorized.operationId, projectId: config.projectId, endpointReferenceSha256: config.endpointReferenceSha256 }));
    if (observation.status === "completed" && observation.endpointReferenceSha256 !== config.endpointReferenceSha256) throw new Error("COLLECTOR_OBSERVATION_MISMATCH");
    return observation;
  }

  const telemetry: LiveTelemetryObservationPort = Object.freeze({
    evidenceClass: "protected_live",
    async emit(raw: LifecycleObservation) {
      const observation = LifecycleObservationSchema.safeParse(raw);
      if (!observation.success || hasSensitiveValue(raw)) throw new Error("COLLECTOR_OBSERVATION_INVALID");
      await input.port.emit({ endpointReferenceSha256: config.endpointReferenceSha256, observation: observation.data });
    },
    async queryWindow(rawBinding: unknown) {
      const binding = WindowBindingSchema.safeParse(rawBinding);
      if (!binding.success || binding.data.candidateId !== config.candidateSha256 || binding.data.topologySha256 !== config.topologySha256
        || binding.data.collectorDigest !== config.collectorDigest || binding.data.configSha256 !== config.configSha256) throw new Error("COLLECTOR_WINDOW_BINDING_INVALID");
      const windowRaw = await input.port.queryWindow({ endpointReferenceSha256: config.endpointReferenceSha256, binding: binding.data });
      if (hasSensitiveValue(windowRaw)) throw new Error("COLLECTOR_SENSITIVE_FIELD_DETECTED");
      const window = WindowSchema.safeParse(windowRaw);
      if (!window.success || canonicalJson(window.data.binding) !== canonicalJson(binding.data) || window.data.metricSeriesCount > lifecycleCardinalityUpperBound()) throw new Error("COLLECTOR_WINDOW_INVALID");
      return Object.freeze(window.data);
    },
  });

  return Object.freeze({
    telemetry,
    async plan(raw: CollectorProviderInput) {
      const authorized = await authorize(raw, config, now());
      return Object.freeze({ status: "planned" as const, operationId: authorized.operationId, candidateSha256: config.candidateSha256, topologySha256: config.topologySha256, endpointReferenceSha256: config.endpointReferenceSha256, collectorDigest: config.collectorDigest, configSha256: config.configSha256 });
    },
    async apply(raw: CollectorProviderInput) {
      const authorized = await authorize(raw, config, now());
      await input.port.persist({ operationId: authorized.operationId, kind: "configure", authorizationRequestSha256: authorized.request.authorizationRequestSha256, authorizationReceiptSha256: authorized.receipt.authorizationReceiptSha256, projectScopeSha256: config.projectScopeSha256 });
      const existing = await observeAuthorized(authorized);
      if (existing.status === "completed") return Object.freeze({ status: "completed" as const, reused: true as const, endpointReferenceSha256: config.endpointReferenceSha256 });
      if (existing.status !== "missing") throw new Error(existing.status === "blocked" ? "COLLECTOR_OPERATION_BLOCKED" : "COLLECTOR_RECONCILIATION_PENDING");
      // Exact v2 receipt validation is deliberately repeated immediately before configure.
      const immediate = await authorize(raw, config, now());
      await input.port.configure({ operationId: immediate.operationId, projectId: config.projectId, endpointReference: config.endpointReference, endpointReferenceSha256: config.endpointReferenceSha256, collectorDigest: config.collectorDigest, configSha256: config.configSha256 });
      return Object.freeze({ status: "applied" as const, reused: false as const, endpointReferenceSha256: config.endpointReferenceSha256 });
    },
    async observe(raw: CollectorProviderInput) {
      const authorized = await authorize(raw, config, now());
      const observation = await observeAuthorized(authorized);
      return Object.freeze({ status: observation.status, operationId: authorized.operationId, ...(observation.status === "completed" ? { endpointReferenceSha256: config.endpointReferenceSha256 } : {}) });
    },
    async cleanup(raw: CollectorProviderInput & Readonly<{ runOwnedEndpointReference: string }>) {
      const authorized = await authorize(raw, config, now());
      if (EndpointReferenceSchema.safeParse(raw.runOwnedEndpointReference).data !== config.endpointReference) throw new Error("COLLECTOR_CLEANUP_SCOPE_INVALID");
      const operationId = `${authorized.operationId}:cleanup`;
      await input.port.persist({ operationId, kind: "cleanup", authorizationRequestSha256: authorized.request.authorizationRequestSha256, authorizationReceiptSha256: authorized.receipt.authorizationReceiptSha256, projectScopeSha256: config.projectScopeSha256 });
      const existing = CleanupObservationSchema.parse(await input.port.observeCleanup({ operationId, projectId: config.projectId, endpointReferenceSha256: config.endpointReferenceSha256 }));
      if (existing.status === "cleaned") return Object.freeze({ status: "cleaned" as const, operationId, endpointReferenceSha256: config.endpointReferenceSha256, configBindingSha256: await sha256({ candidateSha256: config.candidateSha256, topologySha256: config.topologySha256, configSha256: config.configSha256 }) });
      if (existing.status !== "missing") throw new Error(existing.status === "blocked" ? "COLLECTOR_OPERATION_BLOCKED" : "COLLECTOR_RECONCILIATION_PENDING");
      const immediate = await authorize(raw, config, now());
      await input.port.deleteCollector({ operationId, projectId: config.projectId, endpointReference: config.endpointReference, endpointReferenceSha256: config.endpointReferenceSha256 });
      return Object.freeze({ status: "cleaned" as const, operationId, endpointReferenceSha256: config.endpointReferenceSha256, configBindingSha256: await sha256({ candidateSha256: config.candidateSha256, topologySha256: config.topologySha256, configSha256: config.configSha256 }) });
    },
  });
}
