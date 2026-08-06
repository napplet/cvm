import { z } from "zod";
import { canonicalJson } from "../promotion/schema";
import { OFFICIAL_APPROVAL_CHANNELS, type OfficialApprovalChannel } from "./deployment/consent";
import { pendingOperatorFundingReadiness, type OperatorFundingReadiness } from "./deployment/operator-funding";

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

const PriceLineSchema = z.object({
  provider: ProviderSchema,
  sourceId: z.string().regex(/^[a-z][a-z0-9._-]{2,127}$/u),
  sourceDocumentSha256: DigestSchema,
  quoteSha256: DigestSchema,
  currency: z.literal("USD"),
  unit: z.string().regex(/^[a-z][a-z0-9._/-]{1,63}$/u),
  quantityNanos: z.number().int().positive().max(Number.MAX_SAFE_INTEGER),
  observedAtMs: z.number().int().positive(),
  freshUntilMs: z.number().int().positive(),
  baseMicros: MicrosSchema,
  headroomBasisPoints: z.number().int().min(0).max(10_000),
  headroomMicros: MicrosSchema,
  maximumMicros: MicrosSchema,
}).strict();

const GcpEffectsSchema = z.object({
  projectBootstrap: z.boolean(),
  billing: z.boolean(),
  apiEnablement: z.array(z.string().regex(/^[a-z0-9.-]{3,128}$/u)).min(1).max(16),
}).strict();
const OperatorFundingReadinessSchema = z.object({
  version: z.literal(1),
  status: z.enum(["pending", "ready", "invalid"]),
  rails: z.array(z.object({
    rail: z.enum(["nwc_lightning", "cashu"]),
    secretReference: z.string().regex(/^os-secret-ref:[a-z][a-z0-9._-]{2,127}$/u),
    capabilitySha256: DigestSchema,
    accountScopeSha256: DigestSchema,
    expiresAtMs: z.number().int().positive(),
    status: z.enum(["ready", "revoked", "expired"]),
  }).strict()).max(2),
  readinessSha256: DigestSchema,
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
  /** Per-family price facts are the spend authority for controller-generated
   * requests. Older content-addressed requests legitimately lack them. */
  estimateSourceSha256: DigestSchema.optional(),
  priceLines: z.array(PriceLineSchema).length(16).optional(),
  operatorFundingReadiness: OperatorFundingReadinessSchema,
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
  version: z.literal(3),
  authorizationRequestSha256: DigestSchema,
  candidateSha256: DigestSchema,
  topologySha256: DigestSchema,
  effectPlanSha256: DigestSchema,
  controllerStateSha256: DigestSchema,
  currency: z.literal("USD"),
  maximumAuthorizedCostMicros: MicrosSchema.positive(),
  operatorFundingReadinessSha256: DigestSchema,
  approverPrincipalSha256: DigestSchema,
  approvalChannel: z.enum(OFFICIAL_APPROVAL_CHANNELS),
  consentSessionReferences: z.array(z.string().regex(/^[a-z][a-z0-9:._/-]{2,255}$/iu)).min(1).max(3),
  approvedAtMs: z.number().int().positive(),
  expiresAtMs: z.number().int().positive(),
  authorizationReceiptSha256: DigestSchema,
}).strict();
export type ReleaseAuthorizationReceipt = z.infer<typeof ReleaseAuthorizationReceiptSchema>;

export type AuthorizationRequestInput = Omit<ReleaseAuthorizationRequest, "version" | "currency" | "maximumAuthorizedCostMicros" | "estimateSourceId" | "estimateObservedAtMs" | "estimateFreshUntilMs" | "expectedReceiptSha256" | "authorizationRequestSha256" | "supersedesAuthorizationRequestSha256" | "operatorFundingReadiness"> & Readonly<{
  estimate: Readonly<{ currency: "USD"; maximumMicros: number; sourceId: string; observedAtMs: number; freshUntilMs: number; sourceSha256?: string }>;
  operatorFundingReadiness?: OperatorFundingReadiness;
  supersedesAuthorizationRequestSha256?: string | null;
}>;

type RequestInput = Omit<ReleaseAuthorizationRequest, "version" | "expectedReceiptSha256" | "authorizationRequestSha256">;

async function digest(value: unknown): Promise<string> {
  const hash = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(canonicalJson(value)));
  return Array.from(new Uint8Array(hash), (byte) => byte.toString(16).padStart(2, "0")).join("");
}

function assertBounds(input: RequestInput): void {
  if (input.estimateFreshUntilMs <= input.estimateObservedAtMs || input.expiresAtMs >= input.estimateFreshUntilMs) throw new Error("RELEASE_AUTHORIZATION_ESTIMATE_STALE");
  if (input.cleanupByMs > input.expiresAtMs) throw new Error("RELEASE_AUTHORIZATION_CLEANUP_UNBOUNDED");
  if (input.maximumAuthorizedCostMicros !== input.orderedEffects.reduce((sum, effect) => {
    const next = sum + effect.estimatedCostMicros;
    if (!Number.isSafeInteger(next)) throw new Error("RELEASE_AUTHORIZATION_COST_OVERFLOW");
    return next;
  }, 0)) throw new Error("RELEASE_AUTHORIZATION_COST_MISMATCH");
  const providers = input.providerScopes.map((scope) => scope.provider);
  if (new Set(providers).size !== providers.length) throw new Error("RELEASE_AUTHORIZATION_SCOPE_INVALID");
  if (input.orderedEffects.some((effect) => !providers.includes(effect.provider))) throw new Error("RELEASE_AUTHORIZATION_SCOPE_INVALID");
  if (input.priceLines) {
    if (!input.estimateSourceSha256
      || input.priceLines.some((line, index) => line.provider !== input.orderedEffects[index]?.provider
        || line.observedAtMs > input.estimateObservedAtMs
        || line.freshUntilMs < input.estimateFreshUntilMs
        || line.maximumMicros !== input.orderedEffects[index]?.estimatedCostMicros
        || line.baseMicros + line.headroomMicros !== line.maximumMicros)) {
      throw new Error("RELEASE_AUTHORIZATION_PRICE_FACT_INVALID");
    }
  }
  if ((input.operatorFundingReadiness.status === "pending" && input.operatorFundingReadiness.rails.length !== 0)
    || (input.operatorFundingReadiness.status === "ready" && (input.operatorFundingReadiness.rails.length !== 2 || new Set(input.operatorFundingReadiness.rails.map((rail) => rail.rail)).size !== 2 || input.operatorFundingReadiness.rails.some((rail) => rail.status !== "ready" || rail.expiresAtMs <= input.expiresAtMs)))
    || (input.operatorFundingReadiness.status === "invalid" && input.operatorFundingReadiness.rails.length !== 2)) throw new Error("RELEASE_AUTHORIZATION_OPERATOR_FUNDING_INVALID");
}

type OfficialApproval = Readonly<{
  approvalChannel: OfficialApprovalChannel;
  approverPrincipalSha256: string;
  consentSessionReferences: readonly string[];
  approvedAtMs: number;
  expiresAtMs: number;
}>;

function receiptPayload(request: Omit<ReleaseAuthorizationRequest, "expectedReceiptSha256" | "authorizationRequestSha256"> & { authorizationRequestSha256: string }, approval: OfficialApproval): Omit<ReleaseAuthorizationReceipt, "authorizationReceiptSha256"> {
  return {
    version: 3,
    authorizationRequestSha256: request.authorizationRequestSha256,
    candidateSha256: request.candidateSha256,
    topologySha256: request.topologySha256,
    effectPlanSha256: request.effectPlanSha256,
    controllerStateSha256: request.controllerStateSha256,
    currency: "USD",
    maximumAuthorizedCostMicros: request.maximumAuthorizedCostMicros,
    operatorFundingReadinessSha256: request.operatorFundingReadiness.readinessSha256,
    approverPrincipalSha256: approval.approverPrincipalSha256,
    approvalChannel: approval.approvalChannel,
    consentSessionReferences: [...approval.consentSessionReferences],
    approvedAtMs: approval.approvedAtMs,
    expiresAtMs: approval.expiresAtMs,
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
    ...(estimate.sourceSha256 ? { estimateSourceSha256: estimate.sourceSha256 } : {}),
    operatorFundingReadiness: input.operatorFundingReadiness ?? await pendingOperatorFundingReadiness(),
    supersedesAuthorizationRequestSha256: input.supersedesAuthorizationRequestSha256 ?? null,
  };
  assertBounds(normalized);
  const base = {
    version: 2 as const,
    ...normalized,
    currency: "USD" as const,
  };
  const authorizationRequestSha256 = await digest(base);
  // Legacy request field retained for content-addressed v2 request records.
  // It is never accepted as approval authority; only a structured receipt is.
  const expectedReceiptSha256 = await digest({ version: 3, authorizationRequestSha256, authority: "official-consent-required" });
  return ReleaseAuthorizationRequestSchema.parse({ ...base, expectedReceiptSha256, authorizationRequestSha256 });
}

export async function createOfficialConsentReceipt(input: Readonly<{ request: unknown; approval: OfficialApproval }>): Promise<ReleaseAuthorizationReceipt> {
  const request = await validateAuthorizationRequest(input.request);
  const approval = {
    ...input.approval,
    consentSessionReferences: [...input.approval.consentSessionReferences],
  };
  const denyEffectsFixture = approval.approvalChannel === "loopback_fixture" && process.env.NAPPLET_CVM_TEST_EXTERNAL_EFFECTS === "deny";
  if ((!denyEffectsFixture && request.operatorFundingReadiness.status !== "ready") || approval.expiresAtMs !== request.expiresAtMs || approval.approvedAtMs > approval.expiresAtMs) throw new Error("RELEASE_AUTHORIZATION_APPROVAL_INVALID");
  const payload = receiptPayload(request, approval);
  return ReleaseAuthorizationReceiptSchema.parse({ ...payload, authorizationReceiptSha256: await digest(payload) });
}

/** Test-only fixture helper. Production execution has no call site for this
 * function and must obtain receipt facts from OfficialConsentPort instead. */
export async function createAuthorizationReceipt(requestInput: unknown): Promise<ReleaseAuthorizationReceipt> {
  if (process.env.NAPPLET_CVM_TEST_EXTERNAL_EFFECTS !== "deny") throw new Error("RELEASE_AUTHORIZATION_OFFICIAL_CONSENT_REQUIRED");
  const request = await validateAuthorizationRequest(requestInput);
  /** The deny-effects fixture is intentionally not an operator approval path:
   * it supplies a deterministic receipt only to exercise downstream boundary
   * checks. Production OfficialConsentPort remains blocked until both rails are ready. */
  const approval = {
    approvalChannel: "loopback_fixture" as const,
    approverPrincipalSha256: await digest({ fixture: "official-consent", authorizationRequestSha256: request.authorizationRequestSha256 }),
    consentSessionReferences: [`loopback:fixture:${request.authorizationRequestSha256}`],
    approvedAtMs: request.estimateObservedAtMs,
    expiresAtMs: request.expiresAtMs,
  };
  const payload = receiptPayload(request, approval);
  return ReleaseAuthorizationReceiptSchema.parse({ ...payload, authorizationReceiptSha256: await digest(payload) });
}

export async function validateAuthorizationRequest(requestInput: unknown): Promise<ReleaseAuthorizationRequest> {
  const request = ReleaseAuthorizationRequestSchema.parse(requestInput);
  const { expectedReceiptSha256, authorizationRequestSha256, version: _version, currency, maximumAuthorizedCostMicros, estimateSourceId, estimateObservedAtMs, estimateFreshUntilMs, estimateSourceSha256, supersedesAuthorizationRequestSha256, ...input } = request;
  const expected = await createAuthorizationRequest({
    ...input,
    estimate: { currency, maximumMicros: maximumAuthorizedCostMicros, sourceId: estimateSourceId, observedAtMs: estimateObservedAtMs, freshUntilMs: estimateFreshUntilMs, sourceSha256: estimateSourceSha256 },
    supersedesAuthorizationRequestSha256,
  });
  if (canonicalJson(expected) !== canonicalJson(request)) throw new Error("RELEASE_AUTHORIZATION_REQUEST_INVALID");
  return request;
}

export async function validateAuthorizationReceipt(input: Readonly<{ request: unknown; receipt: unknown; nowMs: number }>): Promise<ReleaseAuthorizationReceipt> {
  const request = await validateAuthorizationRequest(input.request);
  if (!Number.isSafeInteger(input.nowMs) || input.nowMs >= request.expiresAtMs) throw new Error("RELEASE_AUTHORIZATION_RECEIPT_EXPIRED");
  const receipt = ReleaseAuthorizationReceiptSchema.parse(input.receipt);
  if (receipt.authorizationRequestSha256 !== request.authorizationRequestSha256
    || receipt.candidateSha256 !== request.candidateSha256
    || receipt.topologySha256 !== request.topologySha256
    || receipt.effectPlanSha256 !== request.effectPlanSha256
    || receipt.controllerStateSha256 !== request.controllerStateSha256
    || receipt.currency !== request.currency
    || receipt.maximumAuthorizedCostMicros !== request.maximumAuthorizedCostMicros
    || receipt.operatorFundingReadinessSha256 !== request.operatorFundingReadiness.readinessSha256
    || receipt.expiresAtMs !== request.expiresAtMs
    || receipt.approvedAtMs > input.nowMs
    || receipt.approvedAtMs > receipt.expiresAtMs) throw new Error("RELEASE_AUTHORIZATION_RECEIPT_INVALID");
  const approval = {
    approvalChannel: receipt.approvalChannel,
    approverPrincipalSha256: receipt.approverPrincipalSha256,
    consentSessionReferences: receipt.consentSessionReferences,
    approvedAtMs: receipt.approvedAtMs,
    expiresAtMs: receipt.expiresAtMs,
  };
  const expected = receipt.approvalChannel === "loopback_fixture" && process.env.NAPPLET_CVM_TEST_EXTERNAL_EFFECTS === "deny"
    ? ReleaseAuthorizationReceiptSchema.parse({ ...receiptPayload(request, approval), authorizationReceiptSha256: await digest(receiptPayload(request, approval)) })
    : await createOfficialConsentReceipt({ request, approval });
  if (canonicalJson(receipt) !== canonicalJson(expected)) throw new Error("RELEASE_AUTHORIZATION_RECEIPT_INVALID");
  return receipt;
}
