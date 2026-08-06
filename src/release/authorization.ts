import { z } from "zod";
import { canonicalJson } from "../promotion/schema";

const DigestSchema = z.string().regex(/^[a-f0-9]{64}$/iu).transform((value) => value.toLowerCase());
const MicrosSchema = z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER);
const ProviderSchema = z.enum([
  "cloud_run", "gcs", "collector", "cloud_sql_postgres", "modal", "fly",
  "contextvm", "cep8_lightning", "cashu", "model", "compatible_host", "signer",
  "promoted_cli", "upload", "owner_relay", "attestation_relay",
]);

const EffectSchema = z.object({
  id: z.string().regex(/^[a-z][a-z0-9_.-]{2,127}$/u),
  provider: ProviderSchema,
  operation: z.enum(["create_or_update", "benchmark", "configure", "verify_integration"]),
  estimatedCostMicros: MicrosSchema,
}).strict();

const ScopeSchema = z.object({
  provider: ProviderSchema,
  accountScopeSha256: DigestSchema,
  projectScopeSha256: DigestSchema,
}).strict();

const GcpEffectsSchema = z.object({
  projectBootstrap: z.boolean(),
  billing: z.boolean(),
  apiEnablement: z.array(z.string().regex(/^[a-z0-9.-]{3,128}$/u)).min(1).max(16),
}).strict();

export const ReleaseAuthorizationRequestSchema = z.object({
  version: z.literal(2),
  candidateSha256: DigestSchema,
  topologySha256: DigestSchema,
  effectPlanSha256: DigestSchema,
  controllerStateSha256: DigestSchema,
  providerCapabilitiesSha256: DigestSchema,
  orderedEffects: z.array(EffectSchema).min(1).max(16),
  providerScopes: z.array(ScopeSchema).min(1).max(16),
  currency: z.literal("USD"),
  maximumAuthorizedCostMicros: MicrosSchema.positive(),
  estimateSourceId: z.string().regex(/^[a-z][a-z0-9._-]{2,127}$/u),
  estimateObservedAtMs: z.number().int().positive(),
  estimateFreshUntilMs: z.number().int().positive(),
  maximumRunDurationMs: z.number().int().positive().max(86_400_000),
  cleanupByMs: z.number().int().positive(),
  evidenceRetentionDays: z.number().int().positive().max(3_650),
  artifactRetentionDays: z.number().int().positive().max(3_650),
  gcpEffects: GcpEffectsSchema,
  expiresAtMs: z.number().int().positive(),
  supersedesAuthorizationRequestSha256: DigestSchema.nullable(),
  expectedReceiptSha256: DigestSchema,
  authorizationRequestSha256: DigestSchema,
}).strict();
export type ReleaseAuthorizationRequest = z.infer<typeof ReleaseAuthorizationRequestSchema>;

export const ReleaseAuthorizationReceiptSchema = z.object({
  version: z.literal(2),
  authorizationRequestSha256: DigestSchema,
  candidateSha256: DigestSchema,
  topologySha256: DigestSchema,
  effectPlanSha256: DigestSchema,
  controllerStateSha256: DigestSchema,
  currency: z.literal("USD"),
  maximumAuthorizedCostMicros: MicrosSchema.positive(),
  expiresAtMs: z.number().int().positive(),
  authorizationReceiptSha256: DigestSchema,
}).strict();
export type ReleaseAuthorizationReceipt = z.infer<typeof ReleaseAuthorizationReceiptSchema>;

export type AuthorizationRequestInput = Omit<ReleaseAuthorizationRequest, "version" | "currency" | "maximumAuthorizedCostMicros" | "estimateSourceId" | "estimateObservedAtMs" | "estimateFreshUntilMs" | "expectedReceiptSha256" | "authorizationRequestSha256" | "supersedesAuthorizationRequestSha256"> & Readonly<{
  estimate: Readonly<{ currency: "USD"; maximumMicros: number; sourceId: string; observedAtMs: number; freshUntilMs: number }>;
  supersedesAuthorizationRequestSha256?: string | null;
}>;

type RequestInput = Omit<ReleaseAuthorizationRequest, "version" | "expectedReceiptSha256" | "authorizationRequestSha256">;

async function digest(value: unknown): Promise<string> {
  const hash = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(canonicalJson(value)));
  return Array.from(new Uint8Array(hash), (byte) => byte.toString(16).padStart(2, "0")).join("");
}

function assertBounds(input: RequestInput): void {
  if (input.estimateFreshUntilMs <= input.estimateObservedAtMs || input.expiresAtMs >= input.estimateFreshUntilMs) throw new Error("RELEASE_AUTHORIZATION_ESTIMATE_STALE");
  if (input.cleanupByMs > input.expiresAtMs + input.maximumRunDurationMs) throw new Error("RELEASE_AUTHORIZATION_CLEANUP_UNBOUNDED");
  if (input.maximumAuthorizedCostMicros !== input.orderedEffects.reduce((sum, effect) => {
    const next = sum + effect.estimatedCostMicros;
    if (!Number.isSafeInteger(next)) throw new Error("RELEASE_AUTHORIZATION_COST_OVERFLOW");
    return next;
  }, 0)) throw new Error("RELEASE_AUTHORIZATION_COST_MISMATCH");
  const providers = input.providerScopes.map((scope) => scope.provider);
  if (new Set(providers).size !== providers.length || providers.some((provider, index) => index > 0 && provider < providers[index - 1]!)) throw new Error("RELEASE_AUTHORIZATION_SCOPE_INVALID");
  if (input.orderedEffects.some((effect) => !providers.includes(effect.provider))) throw new Error("RELEASE_AUTHORIZATION_SCOPE_INVALID");
}

function receiptPayload(request: Omit<ReleaseAuthorizationRequest, "expectedReceiptSha256" | "authorizationRequestSha256"> & { authorizationRequestSha256: string }): Omit<ReleaseAuthorizationReceipt, "authorizationReceiptSha256"> {
  return {
    version: 2,
    authorizationRequestSha256: request.authorizationRequestSha256,
    candidateSha256: request.candidateSha256,
    topologySha256: request.topologySha256,
    effectPlanSha256: request.effectPlanSha256,
    controllerStateSha256: request.controllerStateSha256,
    currency: "USD",
    maximumAuthorizedCostMicros: request.maximumAuthorizedCostMicros,
    expiresAtMs: request.expiresAtMs,
  };
}

export async function createAuthorizationRequest(input: AuthorizationRequestInput): Promise<ReleaseAuthorizationRequest> {
  const { estimate, ...requestInput } = input;
  if (estimate.currency !== "USD") throw new Error("RELEASE_AUTHORIZATION_CURRENCY_INVALID");
  const normalized: RequestInput = {
    ...requestInput,
    version: 2,
    currency: estimate.currency,
    maximumAuthorizedCostMicros: estimate.maximumMicros,
    estimateSourceId: estimate.sourceId,
    estimateObservedAtMs: estimate.observedAtMs,
    estimateFreshUntilMs: estimate.freshUntilMs,
    supersedesAuthorizationRequestSha256: input.supersedesAuthorizationRequestSha256 ?? null,
  };
  assertBounds(normalized);
  const base = {
    version: 2 as const,
    ...normalized,
    currency: "USD" as const,
  };
  const authorizationRequestSha256 = await digest(base);
  const expectedReceiptSha256 = await digest(receiptPayload({ ...base, authorizationRequestSha256 }));
  return ReleaseAuthorizationRequestSchema.parse({ ...base, expectedReceiptSha256, authorizationRequestSha256 });
}

export async function createAuthorizationReceipt(requestInput: unknown): Promise<ReleaseAuthorizationReceipt> {
  const request = await validateAuthorizationRequest(requestInput);
  const payload = receiptPayload(request);
  return ReleaseAuthorizationReceiptSchema.parse({ ...payload, authorizationReceiptSha256: await digest(payload) });
}

export async function validateAuthorizationRequest(requestInput: unknown): Promise<ReleaseAuthorizationRequest> {
  const request = ReleaseAuthorizationRequestSchema.parse(requestInput);
  const { expectedReceiptSha256, authorizationRequestSha256, version: _version, currency, maximumAuthorizedCostMicros, estimateSourceId, estimateObservedAtMs, estimateFreshUntilMs, supersedesAuthorizationRequestSha256, ...input } = request;
  const expected = await createAuthorizationRequest({
    ...input,
    estimate: { currency, maximumMicros: maximumAuthorizedCostMicros, sourceId: estimateSourceId, observedAtMs: estimateObservedAtMs, freshUntilMs: estimateFreshUntilMs },
    supersedesAuthorizationRequestSha256,
  });
  if (canonicalJson(expected) !== canonicalJson(request)) throw new Error("RELEASE_AUTHORIZATION_REQUEST_INVALID");
  return request;
}

export async function validateAuthorizationReceipt(input: Readonly<{ request: unknown; receipt: unknown; nowMs: number }>): Promise<ReleaseAuthorizationReceipt> {
  const request = await validateAuthorizationRequest(input.request);
  if (!Number.isSafeInteger(input.nowMs) || input.nowMs >= request.expiresAtMs) throw new Error("RELEASE_AUTHORIZATION_RECEIPT_EXPIRED");
  const receipt = ReleaseAuthorizationReceiptSchema.parse(input.receipt);
  const expected = await createAuthorizationReceipt(request);
  if (canonicalJson(receipt) !== canonicalJson(expected) || receipt.authorizationReceiptSha256 !== request.expectedReceiptSha256) throw new Error("RELEASE_AUTHORIZATION_RECEIPT_INVALID");
  return receipt;
}
