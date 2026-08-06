import { z } from "zod";
import { canonicalJson } from "../../promotion/schema";
import {
  ModelDispatchObservationSchema,
  ModelLookupObservationSchema,
  NormalizedUsageReceiptSchema,
  ProviderOperationIntentSchema,
  type ModelDispatchObservation,
  type ModelGateway,
  type ModelLookupObservation,
  type NormalizedUsageReceipt,
  type ProviderOperationIntent,
} from "../../model/model-gateway";
import {
  validateAuthorizationReceipt,
  validateAuthorizationRequest,
  type ReleaseAuthorizationReceipt,
  type ReleaseAuthorizationRequest,
} from "../authorization";
import { emitLifecycleObservation, type LifecycleTelemetryPort } from "../../telemetry/contracts";

const DigestSchema = z.string().regex(/^[a-f0-9]{64}$/iu).transform((value) => value.toLowerCase());
const UrlSchema = z.string().url().refine((value) => {
  const protocol = new URL(value).protocol;
  return protocol === "https:" || protocol === "http:";
}, "model endpoint must use HTTP(S)");
const CapabilityBindingSchema = z.object({
  version: z.literal(1),
  candidateSha256: DigestSchema,
  endpointReference: z.string().min(1).max(256),
  endpointScopeSha256: DigestSchema,
  accountReference: z.string().min(1).max(256),
  accountScopeSha256: DigestSchema,
  dispatchUrl: UrlSchema,
  lookupUrl: UrlSchema,
  receiptSchemaVersion: z.literal("model-usage-v1"),
  model: z.string().min(1).max(256),
  modelVersion: z.string().min(1).max(128),
  profileId: z.string().min(1).max(256),
  priceCardId: z.string().min(1).max(256),
  priceCardSha256: DigestSchema,
  freshUntilMs: z.number().int().positive(),
}).strict();
const CapabilitySchema = CapabilityBindingSchema.extend({ authorizationRequestSha256: DigestSchema }).strict();
const CredentialReferenceSchema = z.string().min(1).max(256);
const UsageSchema = z.array(z.object({ dimension: z.enum(["input_tokens", "output_tokens", "cached_tokens", "reasoning_tokens"]), units: z.string().regex(/^(?:0|[1-9][0-9]*)$/u) }).strict()).min(1);
const ProviderReceiptSchema = z.object({
  operationId: z.string().min(1),
  providerRequestId: z.string().min(1),
  model: z.string().min(1),
  modelVersion: z.string().min(1),
  profileId: z.string().min(1),
  priceCardId: z.string().min(1),
  priceCardSha256: DigestSchema,
  completedAt: z.iso.datetime(),
  usage: UsageSchema,
}).strict();
const DispatchResponseSchema = z.discriminatedUnion("status", [
  z.object({ status: z.literal("completed"), operationId: z.string().min(1), providerRequestId: z.string().min(1), receipt: ProviderReceiptSchema }).strict(),
  z.object({ status: z.literal("failed"), operationId: z.string().min(1), providerRequestId: z.string().min(1), receipt: ProviderReceiptSchema }).strict(),
  z.object({ status: z.literal("definitive_not_accepted"), operationId: z.string().min(1), providerRequestId: z.string().min(1) }).strict(),
  z.object({ status: z.literal("usage_unknown"), operationId: z.string().min(1), providerRequestId: z.string().min(1) }).strict(),
]);
const LookupResponseSchema = z.discriminatedUnion("status", [
  z.object({ status: z.literal("pending"), operationId: z.string().min(1), providerRequestId: z.string().min(1) }).strict(),
  z.object({ status: z.literal("unresolved"), operationId: z.string().min(1), providerRequestId: z.string().min(1) }).strict(),
  z.object({ status: z.literal("definitive_not_accepted"), operationId: z.string().min(1), providerRequestId: z.string().min(1) }).strict(),
  z.object({ status: z.literal("receipt_found"), receipt: ProviderReceiptSchema }).strict(),
]);

export type NativeHttpModelCapability = Readonly<z.infer<typeof CapabilitySchema>>;
export type NativeModelCredentialResolver = Readonly<{ resolve(reference: string): Promise<string> }>;
export type NativeHttpModelGateway = ModelGateway & Readonly<{
  discovery(): Readonly<{ candidateSha256: string; capabilitySha256: string; endpointReference: string; accountReference: string; credentialReference: string; model: string; modelVersion: string; profileId: string; priceCardId: string; priceCardSha256: string; freshUntilMs: number; lookupPolicy: "authoritative_original_operation_only" }>;
  dispatchCount(operationId: string): number;
  lookupCount(operationId: string): number;
}>;

type AuthorizedCapability = Readonly<{ capability: NativeHttpModelCapability; capabilitySha256: string; request: ReleaseAuthorizationRequest; receipt: ReleaseAuthorizationReceipt }>;
type GatewayInput = Readonly<{
  capability: unknown;
  capabilitySha256: unknown;
  request: unknown;
  receipt: unknown;
  credentialReference: string;
  credentialResolver: NativeModelCredentialResolver;
  timeoutMs: number;
  now: () => number;
  telemetry?: LifecycleTelemetryPort;
}>;

function freeze<T>(value: T): T { return Object.freeze(structuredClone(value)); }

async function sha256(value: unknown): Promise<string> {
  const bytes = new TextEncoder().encode(canonicalJson(value));
  const digest = await crypto.subtle.digest("SHA-256", bytes);
  return Array.from(new Uint8Array(digest), (byte) => byte.toString(16).padStart(2, "0")).join("");
}

async function authorize(input: Readonly<{ capability: unknown; capabilitySha256: unknown; request: unknown; receipt: unknown }>, nowMs: number): Promise<AuthorizedCapability> {
  const capability = CapabilitySchema.parse(input.capability);
  const capabilitySha256 = DigestSchema.parse(input.capabilitySha256);
  if (nowMs >= capability.freshUntilMs) throw new Error("NATIVE_MODEL_CAPABILITY_STALE");
  const { authorizationRequestSha256: _authorizationRequestSha256, ...binding } = capability;
  if (await sha256(binding) !== capabilitySha256) throw new Error("NATIVE_MODEL_CAPABILITY_DIGEST_MISMATCH");
  let request: ReleaseAuthorizationRequest;
  let receipt: ReleaseAuthorizationReceipt;
  try {
    request = await validateAuthorizationRequest(input.request);
    receipt = await validateAuthorizationReceipt({ request, receipt: input.receipt, nowMs });
  } catch {
    throw new Error("NATIVE_MODEL_AUTHORIZATION_INVALID");
  }
  const scope = request.providerScopes.find((entry) => entry.provider === "model");
  if (request.candidateSha256 !== capability.candidateSha256
    || request.providerCapabilitiesSha256 !== capabilitySha256
    || request.authorizationRequestSha256 !== capability.authorizationRequestSha256
    || !scope
    || scope.accountScopeSha256 !== capability.accountScopeSha256
    || scope.projectScopeSha256 !== capability.endpointScopeSha256) {
    throw new Error("NATIVE_MODEL_AUTHORIZATION_MISMATCH");
  }
  return freeze({ capability, capabilitySha256, request, receipt });
}

/** A candidate-bound provider result is reduced before it can reach metering. */
function receiptFor(input: Readonly<{ receipt: unknown; intent: ProviderOperationIntent; authorized: AuthorizedCapability; stage: "dispatch" | "lookup" }>): Promise<NormalizedUsageReceipt> {
  return (async () => {
    const receipt = ProviderReceiptSchema.parse(input.receipt);
    const { capability } = input.authorized;
    if (receipt.operationId !== input.intent.operationId
      || receipt.providerRequestId !== input.intent.providerRequestId
      || receipt.model !== capability.model
      || receipt.modelVersion !== capability.modelVersion
      || receipt.profileId !== input.intent.profileId
      || receipt.profileId !== capability.profileId
      || receipt.priceCardId !== input.intent.priceCardId
      || receipt.priceCardId !== capability.priceCardId
      || receipt.priceCardSha256 !== capability.priceCardSha256) {
      throw new Error("NATIVE_MODEL_RECEIPT_MISMATCH");
    }
    return NormalizedUsageReceiptSchema.parse({
      operationId: receipt.operationId,
      providerRequestId: receipt.providerRequestId,
      // The existing exact-metering contract owns this normalized identifier.
      // Provider identity remains only in the candidate-bound capability digest.
      provider: "deterministic_fixture",
      model: receipt.model,
      profileId: receipt.profileId,
      priceCardId: receipt.priceCardId,
      selection: "unselected",
      completedAt: receipt.completedAt,
      provenance: {
        protectedEvidenceReference: `model-provider:${input.authorized.capabilitySha256}:${receipt.operationId}:${input.stage}`,
        protectedEvidenceDigest: await sha256({ capabilitySha256: input.authorized.capabilitySha256, operationId: receipt.operationId, providerRequestId: receipt.providerRequestId, stage: input.stage, status: "authoritative_receipt" }),
      },
      usage: receipt.usage,
    });
  })();
}

class NativeHttpModelGatewayImpl implements NativeHttpModelGateway {
  readonly #input: GatewayInput;
  readonly #authorized: AuthorizedCapability;
  readonly #dispatches = new Map<string, Promise<ModelDispatchObservation>>();
  readonly #dispatchCounts = new Map<string, number>();
  readonly #lookupCounts = new Map<string, number>();

  constructor(input: GatewayInput, authorized: AuthorizedCapability) {
    this.#input = input;
    this.#authorized = authorized;
  }

  discovery() {
    const { capability } = this.#authorized;
    return freeze({ candidateSha256: capability.candidateSha256, capabilitySha256: this.#authorized.capabilitySha256, endpointReference: capability.endpointReference, accountReference: capability.accountReference, credentialReference: this.#input.credentialReference, model: capability.model, modelVersion: capability.modelVersion, profileId: capability.profileId, priceCardId: capability.priceCardId, priceCardSha256: capability.priceCardSha256, freshUntilMs: capability.freshUntilMs, lookupPolicy: "authoritative_original_operation_only" as const });
  }
  dispatchCount(operationId: string): number { return this.#dispatchCounts.get(operationId) ?? 0; }
  lookupCount(operationId: string): number { return this.#lookupCounts.get(operationId) ?? 0; }

  async dispatch(input: ProviderOperationIntent, signal: AbortSignal): Promise<ModelDispatchObservation> {
    const intent = ProviderOperationIntentSchema.parse(input);
    const existing = this.#dispatches.get(intent.operationId);
    if (existing) return existing;
    const operation = this.dispatchOnce(intent, signal);
    this.#dispatches.set(intent.operationId, operation);
    return operation;
  }

  async lookup(input: ProviderOperationIntent, signal: AbortSignal): Promise<ModelLookupObservation> {
    const intent = ProviderOperationIntentSchema.parse(input);
    this.#lookupCounts.set(intent.operationId, this.lookupCount(intent.operationId) + 1);
    let authorized: AuthorizedCapability;
    try { authorized = await authorize(this.#input, this.#input.now()); }
    catch { return ModelLookupObservationSchema.parse({ status: "unresolved", ...await this.correlation(intent, "lookup", this.#authorized) }); }
    try {
      const response = LookupResponseSchema.parse(await this.request(authorized.capability.lookupUrl, { operationId: intent.operationId, providerRequestId: intent.providerRequestId }, signal));
      if (response.status === "receipt_found") return ModelLookupObservationSchema.parse({ status: "receipt_found", receipt: await receiptFor({ receipt: response.receipt, intent, authorized, stage: "lookup" }) });
      const correlation = await this.correlation(intent, "lookup", authorized);
      if (response.operationId !== intent.operationId || response.providerRequestId !== intent.providerRequestId) throw new Error("NATIVE_MODEL_LOOKUP_MISMATCH");
      return ModelLookupObservationSchema.parse({ status: response.status, ...correlation, ...(response.status === "definitive_not_accepted" ? { reason: "pre_dispatch_rejected" as const } : {}) });
    } catch {
      return ModelLookupObservationSchema.parse({ status: "unresolved", ...await this.correlation(intent, "lookup", authorized) });
    }
  }

  private async dispatchOnce(intent: ProviderOperationIntent, signal: AbortSignal): Promise<ModelDispatchObservation> {
    this.#dispatchCounts.set(intent.operationId, this.dispatchCount(intent.operationId) + 1);
    let authorized: AuthorizedCapability;
    try { authorized = await authorize(this.#input, this.#input.now()); }
    catch {
      const result = ModelDispatchObservationSchema.parse({ status: "definitive_not_accepted", ...await this.correlation(intent, "dispatch", this.#authorized), reason: "pre_dispatch_rejected" });
      await emitLifecycleObservation(this.#input.telemetry, [intent.accountId, intent.sessionId, intent.operationId], "generation", "blocked");
      return result;
    }
    try {
      const response = DispatchResponseSchema.parse(await this.request(authorized.capability.dispatchUrl, { operationId: intent.operationId, providerRequestId: intent.providerRequestId, actionId: intent.actionId, model: authorized.capability.model, modelVersion: authorized.capability.modelVersion, profileId: intent.profileId, priceCardId: intent.priceCardId, maximumUnits: intent.maximumUnits }, signal));
      const correlation = await this.correlation(intent, "dispatch", authorized);
      if (response.status === "completed" || response.status === "failed") {
        if (response.operationId !== intent.operationId || response.providerRequestId !== intent.providerRequestId) throw new Error("NATIVE_MODEL_DISPATCH_MISMATCH");
        const result = ModelDispatchObservationSchema.parse({ status: response.status, receipt: await receiptFor({ receipt: response.receipt, intent, authorized, stage: "dispatch" }) });
        await emitLifecycleObservation(this.#input.telemetry, [intent.accountId, intent.sessionId, intent.operationId], "generation", "succeeded");
        return result;
      }
      if (response.operationId !== intent.operationId || response.providerRequestId !== intent.providerRequestId) throw new Error("NATIVE_MODEL_DISPATCH_MISMATCH");
      const result = ModelDispatchObservationSchema.parse({ status: response.status, ...correlation, ...(response.status === "definitive_not_accepted" ? { reason: "pre_dispatch_rejected" as const } : { reason: signal.aborted ? "aborted" as const : "uncertain_acceptance" as const }) });
      await emitLifecycleObservation(this.#input.telemetry, [intent.accountId, intent.sessionId, intent.operationId], "generation", result.status === "usage_unknown" ? "pending" : "blocked");
      return result;
    } catch (error) {
      if (error instanceof Error && error.message === "NATIVE_MODEL_AUTH_UNAVAILABLE") {
        const result = ModelDispatchObservationSchema.parse({ status: "definitive_not_accepted", ...await this.correlation(intent, "dispatch", authorized), reason: "pre_dispatch_rejected" });
        await emitLifecycleObservation(this.#input.telemetry, [intent.accountId, intent.sessionId, intent.operationId], "generation", "blocked");
        return result;
      }
      const result = ModelDispatchObservationSchema.parse({ status: "usage_unknown", ...await this.correlation(intent, "dispatch", authorized), reason: signal.aborted ? "aborted" : "malformed_receipt" });
      await emitLifecycleObservation(this.#input.telemetry, [intent.accountId, intent.sessionId, intent.operationId], "generation", "pending");
      return result;
    }
  }

  private async correlation(intent: ProviderOperationIntent, stage: "dispatch" | "lookup", authorized: AuthorizedCapability) {
    return {
      operationId: intent.operationId,
      providerRequestId: intent.providerRequestId,
      provenance: {
        protectedEvidenceReference: `model-provider:${authorized.capabilitySha256}:${intent.operationId}:${stage}`,
        protectedEvidenceDigest: await sha256({ capabilitySha256: authorized.capabilitySha256, operationId: intent.operationId, providerRequestId: intent.providerRequestId, stage, status: "nonterminal" }),
      },
    };
  }

  private async request(url: string, body: unknown, signal: AbortSignal): Promise<unknown> {
    const credential = await this.#input.credentialResolver.resolve(this.#input.credentialReference);
    if (typeof credential !== "string" || credential.length === 0) throw new Error("NATIVE_MODEL_AUTH_UNAVAILABLE");
    const timeout = AbortSignal.timeout(this.#input.timeoutMs);
    const response = await fetch(url, { method: "POST", headers: { "content-type": "application/json", authorization: `Bearer ${credential}` }, body: JSON.stringify(body), signal: AbortSignal.any([signal, timeout]) });
    if (!response.ok) throw new Error("NATIVE_MODEL_HTTP_UNAVAILABLE");
    return response.json();
  }
}

/**
 * Creates the injected, provider-neutral HTTP boundary. Capability discovery
 * is controller-owned; this constructor rejects stale or receipt-unbound
 * documents before a credential can be resolved or network request made.
 */
export async function createNativeHttpModelGateway(input: Readonly<{
  capability: unknown;
  capabilitySha256: unknown;
  request: unknown;
  receipt: unknown;
  credentialReference: unknown;
  credentialResolver: NativeModelCredentialResolver;
  timeoutMs?: number;
  now?: () => number;
  telemetry?: LifecycleTelemetryPort;
}>): Promise<NativeHttpModelGateway> {
  const credentialReference = CredentialReferenceSchema.parse(input.credentialReference);
  if (!input.credentialResolver || typeof input.credentialResolver.resolve !== "function") throw new Error("NATIVE_MODEL_CREDENTIAL_RESOLVER_REQUIRED");
  const timeoutMs = z.number().int().positive().max(60_000).parse(input.timeoutMs ?? 10_000);
  const now = input.now ?? Date.now;
  const authorized = await authorize(input, now());
  return new NativeHttpModelGatewayImpl({ ...input, credentialReference, timeoutMs, now }, authorized);
}
