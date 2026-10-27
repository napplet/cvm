import { z } from "zod";
import {
  GcsObjectStoreAdapter,
  type ImmutableObjectReference,
  type ObjectStorePort,
  type VersionedObjectClientPort,
} from "../../continuity/object-store";
import { canonicalJson } from "../../promotion/schema";
import {
  validateAuthorizationReceipt,
  validateAuthorizationRequest,
  type ReleaseAuthorizationReceipt,
  type ReleaseAuthorizationRequest,
} from "../authorization";

const DigestSchema = z.string().regex(/^[a-f0-9]{64}$/iu).transform((value) => value.toLowerCase());
const OperationIdSchema = z.string().regex(/^[a-z][a-z0-9_-]{2,127}$/u);
const ProjectIdSchema = z.string().regex(/^[a-z][a-z0-9-]{4,28}[a-z0-9]$/u);
const BucketSchema = z.string().regex(/^[a-z0-9][a-z0-9._-]{1,220}[a-z0-9]$/u);
const DualRegionSchema = z.enum(["nam4", "eur4", "asia1"]);
const NamespaceSchema = z.string().regex(/^runs\/[a-z][a-z0-9-]{2,62}\/$/u);

const GcsConfigSchema = z.object({
  candidateSha256: DigestSchema,
  topologySha256: DigestSchema,
  effectPlanSha256: DigestSchema,
  accountScopeSha256: DigestSchema,
  projectScopeSha256: DigestSchema,
  projectId: ProjectIdSchema,
  bucket: BucketSchema,
  dualRegion: DualRegionSchema,
  versioning: z.literal(true),
  retentionDays: z.number().int().min(30).max(3_650),
  namespace: NamespaceSchema,
}).strict();
type GcsConfig = z.infer<typeof GcsConfigSchema>;

const BucketObservationSchema = z.union([
  z.object({ status: z.literal("completed"), projectId: ProjectIdSchema, bucket: BucketSchema, dualRegion: DualRegionSchema, versioning: z.literal(true), retentionDays: z.number().int().min(30).max(3_650) }).strict(),
  z.object({ status: z.enum(["missing", "pending", "unknown", "blocked"]) }).strict(),
]);
type BucketObservation = z.infer<typeof BucketObservationSchema>;

export type GcsControlPlanePort = Readonly<{
  persist(input: Readonly<{ operationId: string; kind: "configure" | "cleanup"; authorizationRequestSha256: string; authorizationReceiptSha256: string; projectScopeSha256: string }>): Promise<void>;
  observeBucket(input: Readonly<{ operationId: string; projectId: string; bucket: string }>): Promise<unknown>;
  createBucket(input: Readonly<{ operationId: string; projectId: string; bucket: string; dualRegion: "nam4" | "eur4" | "asia1"; versioning: true; retentionDays: number }>): Promise<void>;
} & VersionedObjectClientPort>;

export type GcsProviderInput = Readonly<{ request: unknown; receipt: unknown; operationId: string }>;
type Authorized = Readonly<{ request: ReleaseAuthorizationRequest; receipt: ReleaseAuthorizationReceipt; operationId: string }>;

async function sha256(value: Uint8Array | unknown): Promise<string> {
  const bytes = value instanceof Uint8Array ? value : new TextEncoder().encode(canonicalJson(value));
  const hash = await crypto.subtle.digest("SHA-256", bytes as BufferSource);
  return Array.from(new Uint8Array(hash), (byte) => byte.toString(16).padStart(2, "0")).join("");
}

function gcsScopeIsBound(request: ReleaseAuthorizationRequest, config: GcsConfig): boolean {
  const effects = request.orderedEffects.filter((effect) => effect.provider === "gcs");
  const scopes = request.providerScopes.filter((scope) => scope.provider === "gcs");
  return effects.length === 1 && effects[0]?.id === "gcs-retention" && effects[0]?.operation === "configure"
    && scopes.length === 1 && scopes[0]?.accountScopeSha256 === config.accountScopeSha256 && scopes[0]?.projectScopeSha256 === config.projectScopeSha256;
}

async function authorize(input: GcsProviderInput, config: GcsConfig, nowMs: number): Promise<Authorized> {
  try {
    const request = await validateAuthorizationRequest(input.request);
    const receipt = await validateAuthorizationReceipt({ request, receipt: input.receipt, nowMs });
    const operationId = OperationIdSchema.parse(input.operationId);
    if (request.candidateSha256 !== config.candidateSha256 || request.topologySha256 !== config.topologySha256 || request.effectPlanSha256 !== config.effectPlanSha256
      || receipt.candidateSha256 !== config.candidateSha256 || receipt.topologySha256 !== config.topologySha256 || receipt.effectPlanSha256 !== config.effectPlanSha256
      || !gcsScopeIsBound(request, config)) throw new Error("scope");
    return Object.freeze({ request, receipt, operationId });
  } catch {
    throw new Error("GCS_AUTHORIZATION_INVALID");
  }
}

function bucketMatches(observation: BucketObservation, config: GcsConfig): observation is Extract<BucketObservation, { status: "completed" }> {
  return observation.status === "completed" && observation.projectId === config.projectId && observation.bucket === config.bucket
    && observation.dualRegion === config.dualRegion && observation.versioning && observation.retentionDays === config.retentionDays;
}

/**
 * Receipt-gated GCS composition. The protected runner injects the official client;
 * this adapter never reads credentials, discovers buckets, or uses latest-object APIs.
 */
export function createNativeGcsProvider(input: Readonly<{ config: unknown; port: GcsControlPlanePort; now?: () => number }>) {
  const config = Object.freeze(GcsConfigSchema.parse(input.config));
  const now = input.now ?? Date.now;
  const client: VersionedObjectClientPort = Object.freeze({
    createIfAbsent: (value: Parameters<VersionedObjectClientPort["createIfAbsent"]>[0]) => input.port.createIfAbsent(value),
    findExactByKey: (value: Parameters<VersionedObjectClientPort["findExactByKey"]>[0]) => input.port.findExactByKey(value),
    readGeneration: (value: Parameters<VersionedObjectClientPort["readGeneration"]>[0]) => input.port.readGeneration(value),
    scheduleGenerationDeletion: (value: Parameters<VersionedObjectClientPort["scheduleGenerationDeletion"]>[0]) => input.port.scheduleGenerationDeletion(value),
  });
  const rawObjectStore = new GcsObjectStoreAdapter({ config: { projectId: config.projectId, bucket: config.bucket }, client });
  const configSha256 = sha256(config);

  function assertRunObject(reference: Readonly<{ key: string; checksum: string }>): void {
    if (reference.key !== `${config.namespace}${reference.checksum}`) throw new Error("GCS_OBJECT_NAMESPACE_OR_ADDRESS_INVALID");
  }

  async function observeBucket(authorized: Authorized): Promise<BucketObservation> {
    const observation = BucketObservationSchema.parse(await input.port.observeBucket({ operationId: authorized.operationId, projectId: config.projectId, bucket: config.bucket }));
    if (observation.status === "completed" && !bucketMatches(observation, config)) throw new Error("GCS_BUCKET_OBSERVATION_MISMATCH");
    return observation;
  }

  /** Read-only restore bridge; all writes and deletion schedules remain receipt-gated below. */
  const objectStore: ObjectStorePort = Object.freeze({
    createImmutable: async () => { throw new Error("GCS_OBJECT_WRITE_REQUIRES_AUTHORIZED_OPERATION"); },
    async observeExactByKey(value: Readonly<{ key: string; checksum: string }>) {
      try {
        assertRunObject(value);
        const observed = await input.port.findExactByKey(value);
        return observed?.checksum === value.checksum ? { key: value.key, generation: observed.generation, checksum: observed.checksum } : undefined;
      } catch { return undefined; }
    },
    async readExact(reference: ImmutableObjectReference) {
      try {
        assertRunObject(reference);
        const response = await input.port.readGeneration({ key: reference.key, generation: reference.generation, expectedChecksum: reference.checksum });
        if (!response || response.generation !== reference.generation || response.checksum !== reference.checksum || await sha256(response.bytes) !== reference.checksum) return undefined;
        return new Uint8Array(response.bytes);
      } catch { return undefined; }
    },
    scheduleExactDeletion: async () => { throw new Error("GCS_OBJECT_DELETE_REQUIRES_AUTHORIZED_CLEANUP"); },
  });

  return Object.freeze({
    objectStore,
    async plan(raw: GcsProviderInput) {
      const authorized = await authorize(raw, config, now());
      return Object.freeze({ status: "planned" as const, operationId: authorized.operationId, candidateSha256: config.candidateSha256, topologySha256: config.topologySha256, configSha256: await configSha256, bucket: config.bucket, dualRegion: config.dualRegion, versioning: true as const, retentionDays: config.retentionDays, namespace: config.namespace });
    },
    async createObject(raw: GcsProviderInput & Readonly<{ bytes: Uint8Array }>): Promise<ImmutableObjectReference> {
      const authorized = await authorize(raw, config, now());
      if (!(raw.bytes instanceof Uint8Array)) throw new Error("GCS_OBJECT_INVALID");
      await input.port.persist({ operationId: authorized.operationId, kind: "configure", authorizationRequestSha256: authorized.request.authorizationRequestSha256, authorizationReceiptSha256: authorized.receipt.authorizationReceiptSha256, projectScopeSha256: config.projectScopeSha256 });
      const existing = await observeBucket(authorized);
      if (existing.status === "missing") {
        // Revalidate immediately before the managed bucket mutation.
        const immediate = await authorize(raw, config, now());
        await input.port.createBucket({ operationId: immediate.operationId, projectId: config.projectId, bucket: config.bucket, dualRegion: config.dualRegion, versioning: true, retentionDays: config.retentionDays });
      } else if (existing.status !== "completed") {
        throw new Error(existing.status === "blocked" ? "GCS_OPERATION_BLOCKED" : "GCS_RECONCILIATION_PENDING");
      }
      const checksum = await sha256(raw.bytes);
      const key = `${config.namespace}${checksum}`;
      // Revalidate again immediately before the exact content-addressed object write.
      await authorize(raw, config, now());
      const reference = await rawObjectStore.createImmutable({ key, bytes: new Uint8Array(raw.bytes) });
      assertRunObject(reference);
      return Object.freeze(reference);
    },
    async observe(raw: GcsProviderInput) {
      const authorized = await authorize(raw, config, now());
      const observation = await observeBucket(authorized);
      return Object.freeze({ status: observation.status, operationId: authorized.operationId, ...(observation.status === "completed" ? { resourceIdentitySha256: await sha256({ projectId: config.projectId, bucket: config.bucket, dualRegion: config.dualRegion, versioning: config.versioning, retentionDays: config.retentionDays, namespace: config.namespace, configSha256: await configSha256 }) } : {}) });
    },
    async cleanup(raw: GcsProviderInput & Readonly<{ runOwnedNamespace: string; objects: readonly ImmutableObjectReference[] }>) {
      const authorized = await authorize(raw, config, now());
      if (NamespaceSchema.safeParse(raw.runOwnedNamespace).data !== config.namespace) throw new Error("GCS_CLEANUP_SCOPE_INVALID");
      const operationId = `${authorized.operationId}:cleanup`;
      await input.port.persist({ operationId, kind: "cleanup", authorizationRequestSha256: authorized.request.authorizationRequestSha256, authorizationReceiptSha256: authorized.receipt.authorizationReceiptSha256, projectScopeSha256: config.projectScopeSha256 });
      for (const reference of raw.objects) {
        assertRunObject(reference);
        await authorize(raw, config, now());
        await rawObjectStore.scheduleExactDeletion(reference, new Date(authorized.request.cleanupByMs).toISOString());
      }
      return Object.freeze({ status: "cleaned" as const, operationId, objects: raw.objects.length });
    },
  });
}
