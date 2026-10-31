import { z } from "zod";

import { canonicalJson } from "../promotion/schema";
import { verifyNonGoogleAuthorizationReceiptV4, verifyNonGoogleAuthorizationRequestV3 } from "../release/contracts";

const Digest = z.string().regex(/^[a-f0-9]{64}$/iu).transform(value => value.toLowerCase());
const IssuerId = z.string().regex(/^[a-z][a-z0-9._-]{2,127}$/u);
const Scope = z.string().regex(/^[a-z][a-z0-9._-]{2,127}$/u);
const Effect = z.string().regex(/^[a-z][a-z0-9._-]{2,127}$/u);
const Signature = z.string().regex(/^[A-Za-z0-9_-]{86}$/u);
const BoundedMs = z.number().int().positive().max(Number.MAX_SAFE_INTEGER);
const authorities = new WeakSet<object>();
const OriginalOperation = z.object({ operationId: z.string().regex(/^[a-z][a-z0-9:_-]{2,127}$/u), operationSha256: Digest, candidateSha256: Digest, topologySha256: Digest, roleCostBoundSha256: Digest }).strict();

const UnsignedEnvelopeSchema = z.object({
  version: z.literal("non-google-invocation-envelope-v1"),
  issuerId: IssuerId,
  issuedAtMs: BoundedMs,
  expiresAtMs: BoundedMs,
  request: z.unknown(),
  receipt: z.unknown(),
  scopes: z.array(Scope).min(1).max(64),
  effects: z.array(Effect).min(1).max(64),
  costArtifactSha256: Digest,
  originalOperations: z.array(OriginalOperation).min(1).max(32).optional(),
}).strict().superRefine((value, context) => {
  if (value.expiresAtMs <= value.issuedAtMs) context.addIssue({ code: "custom", message: "NON_GOOGLE_INVOCATION_EXPIRY_INVALID" });
  if (new Set(value.scopes).size !== value.scopes.length || new Set(value.effects).size !== value.effects.length) context.addIssue({ code: "custom", message: "NON_GOOGLE_INVOCATION_PERMISSION_DUPLICATE" });
  if (value.originalOperations && new Set(value.originalOperations.map(operation => `${operation.operationId}:${operation.operationSha256}`)).size !== value.originalOperations.length) context.addIssue({ code: "custom", message: "NON_GOOGLE_INVOCATION_ORIGINAL_DUPLICATE" });
});
const EnvelopeSchema = UnsignedEnvelopeSchema.extend({ signature: Signature }).strict();

export type NonGoogleInvocationAuthority = Readonly<{
  assertDispatch(input: Readonly<{ scope: string; effect: string; candidateSha256: string; topologySha256: string; requestSha256: string; roleCostBoundSha256: string; nowMs?: number }>): void;
  assertOriginalObservation(input: Readonly<{ scope: string; effect: string; candidateSha256: string; topologySha256: string; requestSha256: string; roleCostBoundSha256: string; originalRecorded: boolean; operationId?: string; operationSha256?: string; nowMs?: number }>): void;
}>;

export function assertNonGoogleInvocationAuthority(value: unknown): asserts value is NonGoogleInvocationAuthority {
  if (!value || typeof value !== "object" || !authorities.has(value)) throw new Error("NON_GOOGLE_INVOCATION_AUTHORITY_REQUIRED");
}

type TrustedIssuer = Readonly<{ issuerId: string; publicKeySpkiDer: Uint8Array }>;
export type NonGoogleInvocationAuthorityPolicy = Readonly<{
  trustedIssuers: readonly TrustedIssuer[];
  allowedScopes: readonly string[];
  allowedEffects: readonly string[];
  costArtifact: Readonly<{ bytes: Uint8Array; sha256: string }>;
  maxLifetimeMs?: number;
  /** Controller policy, never request data. Expired envelopes remain denied
   * unless this finite allowlist is configured for exact journal recovery. */
  expiredOriginalObservationScopes?: readonly string[];
  now?: () => number;
}>;

function bytes(value: Uint8Array): ArrayBuffer { const copy = new Uint8Array(value.byteLength); copy.set(value); return copy.buffer; }
async function digest(value: string | Uint8Array): Promise<string> {
  const source = typeof value === "string" ? new TextEncoder().encode(value) : value;
  return Array.from(new Uint8Array(await crypto.subtle.digest("SHA-256", bytes(source))), byte => byte.toString(16).padStart(2, "0")).join("");
}
function exact(left: readonly string[], right: readonly string[]): boolean { return left.length === right.length && left.every((value, index) => value === right[index]); }
function sorted(input: readonly string[]): string[] { return [...input].sort((left, right) => left.localeCompare(right)); }

class VerifiedAuthority implements NonGoogleInvocationAuthority {
  constructor(private readonly input: Readonly<{ candidateSha256: string; topologySha256: string; requestSha256: string; roleCostBoundSha256: string; scopes: readonly string[]; effects: readonly string[]; issuedAtMs: number; expiresAtMs: number; expiredObservationScopes: readonly string[]; originalOperations: readonly z.infer<typeof OriginalOperation>[]; now: () => number }>) {}
  assertDispatch(input: Readonly<{ scope: string; effect: string; candidateSha256: string; topologySha256: string; requestSha256: string; roleCostBoundSha256: string; nowMs?: number }>): void {
    this.#assert(input, false);
  }
  assertOriginalObservation(input: Readonly<{ scope: string; effect: string; candidateSha256: string; topologySha256: string; requestSha256: string; roleCostBoundSha256: string; originalRecorded: boolean; operationId?: string; operationSha256?: string; nowMs?: number }>): void {
    if (!input.originalRecorded) throw new Error("NON_GOOGLE_INVOCATION_ORIGINAL_REQUIRED");
    const now = input.nowMs ?? this.input.now();
    if (now >= this.input.expiresAtMs) {
      if (!this.input.expiredObservationScopes.includes(Scope.parse(input.scope)) || !input.operationId || !input.operationSha256 || !this.input.originalOperations.some(operation => operation.operationId === input.operationId && operation.operationSha256 === input.operationSha256 && operation.candidateSha256 === this.input.candidateSha256 && operation.topologySha256 === this.input.topologySha256 && operation.roleCostBoundSha256 === this.input.roleCostBoundSha256)) throw new Error("NON_GOOGLE_INVOCATION_ORIGINAL_DENIED");
    }
    this.#assert(input, true);
  }
  #assert(input: Readonly<{ scope: string; effect: string; candidateSha256: string; topologySha256: string; requestSha256: string; roleCostBoundSha256: string; nowMs?: number }>, observation: boolean): void {
    const now = input.nowMs ?? this.input.now();
    if (!Number.isSafeInteger(now) || now < this.input.issuedAtMs) throw new Error("NON_GOOGLE_INVOCATION_CLOCK_INVALID");
    if ((!observation && now >= this.input.expiresAtMs) || (observation && now >= this.input.expiresAtMs && this.input.expiredObservationScopes.length === 0)) throw new Error("NON_GOOGLE_INVOCATION_EXPIRED");
    if (!this.input.scopes.includes(Scope.parse(input.scope)) || !this.input.effects.includes(Effect.parse(input.effect))) throw new Error("NON_GOOGLE_INVOCATION_SCOPE_DENIED");
    if (Digest.parse(input.candidateSha256) !== this.input.candidateSha256 || Digest.parse(input.topologySha256) !== this.input.topologySha256 || Digest.parse(input.requestSha256) !== this.input.requestSha256 || Digest.parse(input.roleCostBoundSha256) !== this.input.roleCostBoundSha256) throw new Error("NON_GOOGLE_INVOCATION_BINDING_DENIED");
  }
}

/** Verifies a controller-signed successor invocation envelope against roots and
 * policy supplied by the controller, never by the envelope. It has no signing
 * API: production issuance stays outside this module. */
export function createNonGoogleInvocationAuthorityVerifier(policyInput: NonGoogleInvocationAuthorityPolicy) {
  const policy = Object.freeze({
    trustedIssuers: policyInput.trustedIssuers.map(root => Object.freeze({ issuerId: IssuerId.parse(root.issuerId), publicKeySpkiDer: new Uint8Array(root.publicKeySpkiDer) })),
    allowedScopes: sorted(policyInput.allowedScopes.map(value => Scope.parse(value))),
    allowedEffects: sorted(policyInput.allowedEffects.map(value => Effect.parse(value))),
    costArtifact: Object.freeze({ bytes: new Uint8Array(policyInput.costArtifact.bytes), sha256: Digest.parse(policyInput.costArtifact.sha256) }),
    maxLifetimeMs: policyInput.maxLifetimeMs ?? 15 * 60_000,
    expiredObservationScopes: sorted((policyInput.expiredOriginalObservationScopes ?? []).map(value => Scope.parse(value))),
    now: policyInput.now ?? Date.now,
  });
  if (policy.trustedIssuers.length === 0 || new Set(policy.trustedIssuers.map(root => root.issuerId)).size !== policy.trustedIssuers.length || policy.allowedScopes.length === 0 || policy.allowedEffects.length === 0 || policy.expiredObservationScopes.some(scope => !policy.allowedScopes.includes(scope)) || !Number.isSafeInteger(policy.maxLifetimeMs) || policy.maxLifetimeMs < 1 || policy.maxLifetimeMs > 24 * 60 * 60_000) throw new Error("NON_GOOGLE_INVOCATION_POLICY_INVALID");

  return Object.freeze({ async verify(input: unknown): Promise<NonGoogleInvocationAuthority> {
    const envelope = EnvelopeSchema.safeParse(input); if (!envelope.success) throw new Error("NON_GOOGLE_INVOCATION_ENVELOPE_INVALID");
    const value = envelope.data; const root = policy.trustedIssuers.find(candidate => candidate.issuerId === value.issuerId);
    if (!root) throw new Error("NON_GOOGLE_INVOCATION_ISSUER_UNTRUSTED");
    const now = policy.now();
    const expired = value.expiresAtMs <= now;
    if (!Number.isSafeInteger(now) || value.issuedAtMs > now || (expired && policy.expiredObservationScopes.length === 0) || value.expiresAtMs - value.issuedAtMs > policy.maxLifetimeMs) throw new Error("NON_GOOGLE_INVOCATION_EXPIRED");
    if (!exact(sorted(value.scopes), policy.allowedScopes) || !exact(sorted(value.effects), policy.allowedEffects)) throw new Error("NON_GOOGLE_INVOCATION_SCOPE_DENIED");
    if (await digest(policy.costArtifact.bytes) !== policy.costArtifact.sha256 || value.costArtifactSha256 !== policy.costArtifact.sha256) throw new Error("NON_GOOGLE_INVOCATION_COST_ARTIFACT_INVALID");
    const { signature, ...unsigned } = value;
    let publicKey: CryptoKey; let signatureBytes: Uint8Array;
    try { publicKey = await crypto.subtle.importKey("spki", bytes(root.publicKeySpkiDer), { name: "Ed25519" }, false, ["verify"]); signatureBytes = new Uint8Array(Buffer.from(signature, "base64url")); }
    catch { throw new Error("NON_GOOGLE_INVOCATION_SIGNATURE_INVALID"); }
    if (!(await crypto.subtle.verify({ name: "Ed25519" }, publicKey, bytes(signatureBytes), new TextEncoder().encode(canonicalJson(unsigned))))) throw new Error("NON_GOOGLE_INVOCATION_SIGNATURE_INVALID");
    const request = await verifyNonGoogleAuthorizationRequestV3(value.request);
    const receipt = await verifyNonGoogleAuthorizationReceiptV4({ request, receipt: value.receipt });
    if (request.binding.scopesSha256 !== await digest(canonicalJson(sorted(value.scopes))) || request.binding.effectsSha256 !== await digest(canonicalJson(sorted(value.effects))) || receipt.candidateSha256 !== request.identity.candidateSha256 || receipt.topologySha256 !== request.identity.topologySha256 || receipt.roleCostBoundSha256 !== request.binding.roleCostBoundSha256) throw new Error("NON_GOOGLE_INVOCATION_BINDING_DENIED");
    const originalOperations = value.originalOperations ?? [];
    if (expired && (originalOperations.length === 0 || policy.expiredObservationScopes.some(scope => !value.scopes.includes(scope)) || originalOperations.some(operation => operation.candidateSha256 !== receipt.candidateSha256 || operation.topologySha256 !== receipt.topologySha256 || operation.roleCostBoundSha256 !== receipt.roleCostBoundSha256))) throw new Error("NON_GOOGLE_INVOCATION_ORIGINAL_DENIED");
    const authority = Object.freeze(new VerifiedAuthority({ candidateSha256: receipt.candidateSha256, topologySha256: receipt.topologySha256, requestSha256: request.requestSha256, roleCostBoundSha256: receipt.roleCostBoundSha256, scopes: Object.freeze(sorted(value.scopes)), effects: Object.freeze(sorted(value.effects)), issuedAtMs: value.issuedAtMs, expiresAtMs: value.expiresAtMs, expiredObservationScopes: Object.freeze(policy.expiredObservationScopes), originalOperations: Object.freeze(originalOperations), now: policy.now }));
    authorities.add(authority);
    return authority;
  } });
}
