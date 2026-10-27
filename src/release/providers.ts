import { z } from "zod";
import { ReleaseProviderIdSchema, type ReleaseProviderId } from "./contracts";
import { ReleaseAuthorizationReceiptSchema as ExactReleaseAuthorizationReceiptSchema, type ReleaseAuthorizationReceipt as ExactReleaseAuthorizationReceipt } from "./authorization";

const DigestSchema = z.string().regex(/^[a-f0-9]{64}$/iu).transform((value) => value.toLowerCase());
const CostSchema = z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER);
const ProviderOperationKindSchema = z.enum(["create_or_update", "benchmark", "configure", "verify_integration"]);

const LegacyReleaseAuthorizationReceiptSchema = z.object({
  version: z.literal(1),
  authorizationRequestSha256: DigestSchema,
  authorizationReceiptSha256: DigestSchema,
  candidateSha256: DigestSchema,
  topologySha256: DigestSchema,
  effectPlanSha256: DigestSchema,
  maximumAuthorizedCostMicros: CostSchema.positive(),
  expiresAtMs: z.number().int().positive(),
}).strict();
/** Provider adapters retain this legacy parser only for historical operation tests.
 * The controller accepts exclusively the exact v2 receipt from authorization.ts. */
export const ReleaseAuthorizationReceiptSchema = z.union([ExactReleaseAuthorizationReceiptSchema, LegacyReleaseAuthorizationReceiptSchema]);
export type ReleaseAuthorizationReceipt = z.infer<typeof ReleaseAuthorizationReceiptSchema>;

export const ReleaseProviderOperationSchema = z.object({
  version: z.literal(1),
  operationId: z.string().regex(/^[a-z][a-z0-9_-]{2,127}$/u),
  provider: ReleaseProviderIdSchema,
  effectId: z.string().regex(/^[a-z][a-z0-9_.-]{2,127}$/u),
  operation: ProviderOperationKindSchema,
  region: z.string().min(1).max(64),
  desiredDigest: DigestSchema,
  candidateSha256: DigestSchema,
  authorizationRequestSha256: DigestSchema,
}).strict();
export type ReleaseProviderOperation = z.infer<typeof ReleaseProviderOperationSchema>;

export const ReleaseProviderDiscoverySchema = z.object({
  version: z.literal(1),
  provider: ReleaseProviderIdSchema,
  capability: z.enum(["available", "unavailable", "unsupported"]),
  authentication: z.enum(["authorized", "not_configured", "unavailable"]),
  accountScopeSha256: DigestSchema,
  costEstimateSha256: DigestSchema,
  secretReferenceNames: z.array(z.string().regex(/^[a-z][a-z0-9_.-]{0,127}$/u)).max(8),
  reasonCode: z.enum(["AVAILABLE", "AUTHORIZATION_REQUIRED", "CAPABILITY_UNAVAILABLE", "CREDENTIALS_UNAVAILABLE", "UNSUPPORTED_CAPABILITY"]),
}).strict();
export type ReleaseProviderDiscovery = z.infer<typeof ReleaseProviderDiscoverySchema>;

const RedactedDiscoveryMetadataSchema = z.object({
  accountScopeSha256: DigestSchema.optional(),
  costEstimateSha256: DigestSchema.optional(),
  secretReferenceNames: z.array(z.string().regex(/^[a-z][a-z0-9_.-]{0,127}$/u)).max(8).optional(),
}).strict();
const NativeDiscoverySchema = z.object({ capability: z.enum(["available", "unavailable", "unsupported"]) }).extend(RedactedDiscoveryMetadataSchema.shape).strict();
const NativeAuthenticationSchema = z.object({ authentication: z.enum(["authorized", "not_configured", "unavailable"]) }).extend(RedactedDiscoveryMetadataSchema.shape).strict();
const NativePlanSchema = z.object({ status: z.literal("planned"), estimatedCostMicros: CostSchema }).strict();
/* A mounted native adapter may already return the canonical identity digest
 * from the provider's observation. Keep that digest intact instead of
 * hashing a hash again while still supporting older opaque identities. */
const NativeMutationSchema = z.object({ status: z.enum(["applied", "unknown", "blocked"]), actualCostMicros: CostSchema.optional(), resourceIdentity: z.string().min(1).max(4_096).optional(), resourceIdentitySha256: DigestSchema.optional() }).strict();
const NativeObservationSchema = z.object({ status: z.enum(["completed", "pending", "unknown", "missing", "blocked"]), actualCostMicros: CostSchema.optional(), resourceIdentity: z.string().min(1).max(4_096).optional(), resourceIdentitySha256: DigestSchema.optional() }).strict();
const NativeCleanupSchema = z.object({ status: z.enum(["cleaned", "pending", "blocked"]), actualCostMicros: CostSchema }).strict();

export type ReleaseProviderPort = Readonly<{
  discoverCapabilities(): Promise<z.input<typeof NativeDiscoverySchema>>;
  discoverAuthentication(): Promise<z.input<typeof NativeAuthenticationSchema>>;
  plan(input: Readonly<{ operationId: string; effectId: string; region: string; desiredDigest: string }>): Promise<z.input<typeof NativePlanSchema>>;
  apply(input: Readonly<{ operationId: string; effectId: string; region: string; desiredDigest: string }>): Promise<z.input<typeof NativeMutationSchema>>;
  observe(input: Readonly<{ operationId: string }>): Promise<z.input<typeof NativeObservationSchema>>;
  cleanup(input: Readonly<{ operationId: string; resourceIdentitySha256?: string }>): Promise<z.input<typeof NativeCleanupSchema>>;
}>;

export type ReleaseProviderPlanResult = z.infer<typeof NativePlanSchema>;
export type ReleaseProviderMutationResult = Readonly<{ status: "applied" | "unknown" | "blocked"; actualCostMicros: number; resourceIdentitySha256?: string }>;
export type ReleaseProviderObservationResult = Readonly<{ status: "completed" | "pending" | "unknown" | "missing" | "blocked"; actualCostMicros: number; resourceIdentitySha256?: string }>;
export type ReleaseProviderCleanupResult = z.infer<typeof NativeCleanupSchema>;

const PROVIDERS = [
  "cloud_run", "gcs", "collector", "cloud_sql_postgres", "modal", "fly",
  "contextvm", "cep8_lightning", "cashu", "model", "compatible_host", "signer",
  "promoted_cli", "upload", "owner_relay", "attestation_relay",
] as const satisfies readonly ReleaseProviderId[];

const EFFECT_OWNER: Readonly<Record<ReleaseProviderId, readonly string[]>> = Object.freeze({
  cloud_run: ["cloud-run-ingress"], gcs: ["gcs-retention"], collector: ["collector"], cloud_sql_postgres: ["database"],
  modal: ["modal-benchmark"], fly: ["fly-benchmark"], contextvm: ["contextvm-rails"], cep8_lightning: ["payments"],
  cashu: ["cashu"], model: ["model"], compatible_host: ["host-signer"], signer: ["signer"],
  promoted_cli: ["cli-asset"], upload: ["publication"], owner_relay: ["owner-relay"], attestation_relay: ["attestation-relay"],
});

async function sha256(value: string): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(value));
  return Array.from(new Uint8Array(digest), (byte) => byte.toString(16).padStart(2, "0")).join("");
}

function unavailable(provider: ReleaseProviderId, reasonCode: ReleaseProviderDiscovery["reasonCode"] = "CREDENTIALS_UNAVAILABLE"): ReleaseProviderDiscovery {
  return ReleaseProviderDiscoverySchema.parse({
    version: 1, provider, capability: "unavailable", authentication: "unavailable",
    accountScopeSha256: "0".repeat(64), costEstimateSha256: "0".repeat(64), secretReferenceNames: [], reasonCode,
  });
}

function sameMetadata(left: string | undefined, right: string | undefined): string | undefined {
  if (left && right && left !== right) throw new Error("RELEASE_PROVIDER_DISCOVERY_METADATA_INVALID");
  return left ?? right;
}

function authorize(input: Readonly<{ receipt: unknown; operation: unknown; approvedMaximumCostMicros: unknown }>, now: number): { receipt: ReleaseAuthorizationReceipt; operation: ReleaseProviderOperation; approvedMaximumCostMicros: number } {
  const receipt = ReleaseAuthorizationReceiptSchema.safeParse(input.receipt);
  const operation = ReleaseProviderOperationSchema.safeParse(input.operation);
  const approvedMaximumCostMicros = CostSchema.safeParse(input.approvedMaximumCostMicros);
  if (!receipt.success || !operation.success || !approvedMaximumCostMicros.success
    || receipt.data.expiresAtMs <= now
    || receipt.data.candidateSha256 !== operation.data.candidateSha256
    || receipt.data.authorizationRequestSha256 !== operation.data.authorizationRequestSha256
    || receipt.data.maximumAuthorizedCostMicros !== approvedMaximumCostMicros.data
    || !EFFECT_OWNER[operation.data.provider].includes(operation.data.effectId)) throw new Error("RELEASE_PROVIDER_AUTHORIZATION_INVALID");
  return { receipt: receipt.data, operation: operation.data, approvedMaximumCostMicros: approvedMaximumCostMicros.data };
}

function checkedCost(cost: number | undefined, maximum: number): number {
  const actual = cost ?? 0;
  if (actual > maximum) throw new Error("RELEASE_PROVIDER_COST_EXCEEDED");
  return actual;
}

function effectInput(operation: ReleaseProviderOperation): Readonly<{ operationId: string; effectId: string; region: string; desiredDigest: string }> {
  return Object.freeze({ operationId: operation.operationId, effectId: operation.effectId, region: operation.region, desiredDigest: operation.desiredDigest });
}

/** Closed, project-owned adapter composition. Native clients are injected by the protected
 * runner; this module never creates clients, authenticates, opens a socket, or writes evidence. */
export class ReleaseProviderRegistry {
  readonly #ports: Partial<Record<ReleaseProviderId, ReleaseProviderPort>>;
  readonly #now: () => number;

  constructor(options: Readonly<{ ports?: Partial<Record<ReleaseProviderId, ReleaseProviderPort>>; now?: () => number }> = {}) {
    this.#ports = Object.freeze({ ...(options.ports ?? {}) });
    this.#now = options.now ?? Date.now;
  }

  providers(): readonly ReleaseProviderId[] { return PROVIDERS; }

  async discover(provider: ReleaseProviderId): Promise<ReleaseProviderDiscovery> {
    const port = this.#ports[ReleaseProviderIdSchema.parse(provider)];
    if (!port) return unavailable(provider);
    try {
      const [capability, authentication] = await Promise.all([
        port.discoverCapabilities().then((result) => NativeDiscoverySchema.parse(result)),
        port.discoverAuthentication().then((result) => NativeAuthenticationSchema.parse(result)),
      ]);
      const accountScopeSha256 = sameMetadata(capability.accountScopeSha256, authentication.accountScopeSha256) ?? "0".repeat(64);
      const costEstimateSha256 = sameMetadata(capability.costEstimateSha256, authentication.costEstimateSha256) ?? "0".repeat(64);
      const secretReferenceNames = [...new Set([...(capability.secretReferenceNames ?? []), ...(authentication.secretReferenceNames ?? [])])].sort();
      return ReleaseProviderDiscoverySchema.parse({
        version: 1, provider, capability: capability.capability, authentication: authentication.authentication,
        accountScopeSha256, costEstimateSha256, secretReferenceNames,
        reasonCode: capability.capability === "available" && authentication.authentication === "authorized" ? "AVAILABLE" : "AUTHORIZATION_REQUIRED",
      });
    } catch { return unavailable(provider, "CAPABILITY_UNAVAILABLE"); }
  }

  async plan(input: Readonly<{ receipt: unknown; operation: unknown }>): Promise<ReleaseProviderPlanResult> {
    const authorized = authorize({ ...input, approvedMaximumCostMicros: ReleaseAuthorizationReceiptSchema.parse(input.receipt).maximumAuthorizedCostMicros }, this.#now());
    const port = this.#ports[authorized.operation.provider];
    if (!port) throw new Error("RELEASE_PROVIDER_UNAVAILABLE");
    const result = NativePlanSchema.parse(await port.plan(effectInput(authorized.operation)));
    checkedCost(result.estimatedCostMicros, authorized.approvedMaximumCostMicros);
    return Object.freeze(result);
  }

  async apply(input: Readonly<{ receipt: unknown; operation: unknown; approvedMaximumCostMicros: unknown }>): Promise<ReleaseProviderMutationResult> {
    const authorized = authorize(input, this.#now());
    const port = this.#ports[authorized.operation.provider];
    if (!port) throw new Error("RELEASE_PROVIDER_UNAVAILABLE");
    const result = NativeMutationSchema.parse(await port.apply(effectInput(authorized.operation)));
    const actualCostMicros = checkedCost(result.actualCostMicros, authorized.approvedMaximumCostMicros);
    return Object.freeze({ status: result.status, actualCostMicros, ...(result.resourceIdentitySha256 ? { resourceIdentitySha256: result.resourceIdentitySha256 } : result.resourceIdentity ? { resourceIdentitySha256: await sha256(result.resourceIdentity) } : {}) });
  }

  async observe(input: Readonly<{ receipt: unknown; operation: unknown; approvedMaximumCostMicros: unknown }>): Promise<ReleaseProviderObservationResult> {
    const authorized = authorize(input, this.#now());
    const port = this.#ports[authorized.operation.provider];
    if (!port) throw new Error("RELEASE_PROVIDER_UNAVAILABLE");
    const result = NativeObservationSchema.parse(await port.observe({ operationId: authorized.operation.operationId }));
    const actualCostMicros = checkedCost(result.actualCostMicros, authorized.approvedMaximumCostMicros);
    return Object.freeze({ status: result.status, actualCostMicros, ...(result.resourceIdentitySha256 ? { resourceIdentitySha256: result.resourceIdentitySha256 } : result.resourceIdentity ? { resourceIdentitySha256: await sha256(result.resourceIdentity) } : {}) });
  }

  async cleanup(input: Readonly<{ receipt: unknown; operation: unknown; approvedMaximumCostMicros: unknown; resourceIdentitySha256?: string }>): Promise<ReleaseProviderCleanupResult> {
    const authorized = authorize(input, this.#now());
    const port = this.#ports[authorized.operation.provider];
    if (!port) throw new Error("RELEASE_PROVIDER_UNAVAILABLE");
    const result = NativeCleanupSchema.parse(await port.cleanup({ operationId: authorized.operation.operationId, ...(input.resourceIdentitySha256 ? { resourceIdentitySha256: DigestSchema.parse(input.resourceIdentitySha256) } : {}) }));
    checkedCost(result.actualCostMicros, authorized.approvedMaximumCostMicros);
    return Object.freeze(result);
  }
}

export function createReleaseProviderRegistry(options: Readonly<{ ports?: Partial<Record<ReleaseProviderId, ReleaseProviderPort>>; now?: () => number }> = {}): ReleaseProviderRegistry {
  return new ReleaseProviderRegistry(options);
}
