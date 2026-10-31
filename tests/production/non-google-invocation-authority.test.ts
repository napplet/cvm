import { expect, test } from "bun:test";

import { assertNonGoogleInvocationAuthority, createNonGoogleInvocationAuthorityVerifier } from "../../src/production/non-google-invocation-authority";
import { canonicalJson } from "../../src/promotion/schema";
import { createNonGoogleAuthorizationRequestV3 } from "../../src/release/contracts";

function ownedArrayBuffer(value: Uint8Array): ArrayBuffer {
  const copy = new ArrayBuffer(value.byteLength);
  new Uint8Array(copy).set(value);
  return copy;
}
const digest = async (value: string | Uint8Array) => { const source = typeof value === "string" ? new TextEncoder().encode(value) : value; return Array.from(new Uint8Array(await crypto.subtle.digest("SHA-256", ownedArrayBuffer(source))), byte => byte.toString(16).padStart(2, "0")).join(""); };
const hex = (value: string) => value.repeat(64);

async function fixture(now = 1_000_000, options: Readonly<{ expiresAtMs?: number; verificationNow?: number; expiredOriginalObservationScopes?: readonly string[]; originalOperations?: readonly { operationId: string; operationSha256: string; candidateSha256: string; topologySha256: string; roleCostBoundSha256: string }[] }> = {}) {
  const pair = await crypto.subtle.generateKey({ name: "Ed25519" }, true, ["sign", "verify"]);
  const publicKeySpkiDer = new Uint8Array(await crypto.subtle.exportKey("spki", pair.publicKey));
  const costBytes = new TextEncoder().encode("controller-cost-artifact");
  const scopes = ["edge.payment"], effects = ["edge.payment.model"];
  const request = await createNonGoogleAuthorizationRequestV3({
    identity: { candidateSha256: hex("a"), sourceSha256: hex("b"), configSha256: hex("c"), toolchainSha256: hex("d"), topologySha256: hex("e"), failureDomainSha256: hex("f"), retentionSha256: hex("0"), cleanupSha256: hex("1"), controllerStateSha256: hex("2") },
    binding: { providerGraphRevision: "non-google-v1", roleInventorySha256: hex("3"), roleCostBoundSha256: hex("4"), scopesSha256: await digest(canonicalJson(scopes)), effectsSha256: await digest(canonicalJson(effects)) },
  });
  const unsigned = { version: "non-google-invocation-envelope-v1" as const, issuerId: "controller-root-1", issuedAtMs: now - 1, expiresAtMs: options.expiresAtMs ?? now + 60_000, request, receipt: { kind: "release-authorization-receipt-v4" as const, version: 4 as const, requestSha256: request.requestSha256, candidateSha256: hex("a"), topologySha256: hex("e"), providerGraphRevision: "non-google-v1" as const, roleInventorySha256: hex("3"), roleCostBoundSha256: hex("4"), receiptSha256: hex("5") }, scopes, effects, costArtifactSha256: await digest(costBytes), ...(options.originalOperations ? { originalOperations: options.originalOperations } : {}) };
  const signature = Buffer.from(new Uint8Array(await crypto.subtle.sign({ name: "Ed25519" }, pair.privateKey, new TextEncoder().encode(canonicalJson(unsigned)))).buffer).toString("base64url");
  const verifier = createNonGoogleInvocationAuthorityVerifier({ trustedIssuers: [{ issuerId: unsigned.issuerId, publicKeySpkiDer }], allowedScopes: scopes, allowedEffects: effects, costArtifact: { bytes: costBytes, sha256: unsigned.costArtifactSha256 }, ...(options.expiredOriginalObservationScopes ? { expiredOriginalObservationScopes: options.expiredOriginalObservationScopes } : {}), now: () => options.verificationNow ?? now });
  return { verifier, envelope: { ...unsigned, signature }, now };
}

test("signed non-Google invocation authority rejects unsigned, forged, wrong-root, scope, cost, and expiry envelopes", async () => {
  const { verifier, envelope, now } = await fixture();
  await expect(verifier.verify({ ...envelope, signature: envelope.signature.slice(1) })).rejects.toThrow("NON_GOOGLE_INVOCATION_ENVELOPE_INVALID");
  await expect(verifier.verify({ ...envelope, receipt: { ...envelope.receipt, candidateSha256: hex("9") } })).rejects.toThrow("NON_GOOGLE_INVOCATION_SIGNATURE_INVALID");
  await expect(verifier.verify({ ...envelope, issuerId: "untrusted-root" })).rejects.toThrow("NON_GOOGLE_INVOCATION_ISSUER_UNTRUSTED");
  await expect(verifier.verify({ ...envelope, scopes: ["edge.publication"] })).rejects.toThrow("NON_GOOGLE_INVOCATION_SCOPE_DENIED");
  await expect(verifier.verify({ ...envelope, costArtifactSha256: hex("9") })).rejects.toThrow("NON_GOOGLE_INVOCATION_COST_ARTIFACT_INVALID");
  await expect(verifier.verify({ ...envelope, expiresAtMs: now })).rejects.toThrow("NON_GOOGLE_INVOCATION_EXPIRED");
});

test("only a verified signed envelope authorizes its exact candidate, topology, request, role, scope and effect", async () => {
  const { verifier, envelope, now } = await fixture();
  const authority = await verifier.verify(envelope);
  expect(() => authority.assertDispatch({ scope: "edge.payment", effect: "edge.payment.model", candidateSha256: hex("a"), topologySha256: hex("e"), requestSha256: envelope.request.requestSha256, roleCostBoundSha256: hex("4"), nowMs: now })).not.toThrow();
  expect(() => authority.assertDispatch({ scope: "edge.payment", effect: "edge.payment.model", candidateSha256: hex("a"), topologySha256: hex("e"), requestSha256: envelope.request.requestSha256, roleCostBoundSha256: hex("9"), nowMs: now })).toThrow("NON_GOOGLE_INVOCATION_BINDING_DENIED");
  expect(() => authority.assertOriginalObservation({ scope: "edge.payment", effect: "edge.payment.model", candidateSha256: hex("a"), topologySha256: hex("e"), requestSha256: envelope.request.requestSha256, roleCostBoundSha256: hex("4"), originalRecorded: false, nowMs: now })).toThrow("NON_GOOGLE_INVOCATION_ORIGINAL_REQUIRED");
});

test("verified authority exposes frozen signed binding metadata without granting an effect", async () => {
  const { verifier, envelope, now } = await fixture();
  const authority = await verifier.verify(envelope);
  const binding = authority.binding();
  expect(binding).toEqual({ candidateSha256: hex("a"), topologySha256: hex("e"), requestSha256: envelope.request.requestSha256, roleCostBoundSha256: hex("4"), costArtifactSha256: envelope.costArtifactSha256, issuedAtMs: now - 1, expiresAtMs: now + 60_000 });
  expect(Object.isFrozen(binding)).toBe(true);
  expect(() => Object.defineProperty(binding, "expiresAtMs", { value: binding.expiresAtMs + 1 })).toThrow();
  expect(() => authority.assertDispatch({ scope: "edge.payment", effect: "edge.payment.model", candidateSha256: binding.candidateSha256, topologySha256: binding.topologySha256, requestSha256: binding.requestSha256, roleCostBoundSha256: binding.roleCostBoundSha256, nowMs: binding.expiresAtMs })).toThrow("NON_GOOGLE_INVOCATION_EXPIRED");
  await expect(verifier.verify({ ...envelope, expiresAtMs: envelope.expiresAtMs + 1 })).rejects.toThrow("NON_GOOGLE_INVOCATION_SIGNATURE_INVALID");
});

test("only verifier-created authority instances cross the internal authority boundary", async () => {
  const { verifier, envelope } = await fixture();
  const authority = await verifier.verify(envelope);
  expect(() => assertNonGoogleInvocationAuthority(authority)).not.toThrow();
  expect(() => assertNonGoogleInvocationAuthority({ binding() { return authority.binding(); }, assertDispatch() {}, assertOriginalObservation() {} })).toThrow("NON_GOOGLE_INVOCATION_AUTHORITY_REQUIRED");
  expect(() => assertNonGoogleInvocationAuthority(new Proxy(authority, {}))).toThrow("NON_GOOGLE_INVOCATION_AUTHORITY_REQUIRED");
});

test("an expired signed wrapper is observation-only for its finite trusted original tuple", async () => {
  const now = 1_000_000;
  const original = { operationId: "model_original_operation", operationSha256: hex("6"), candidateSha256: hex("a"), topologySha256: hex("e"), roleCostBoundSha256: hex("4") };
  const { verifier, envelope } = await fixture(now - 2, { expiresAtMs: now - 1, verificationNow: now, expiredOriginalObservationScopes: ["edge.payment"], originalOperations: [original] });
  const authority = await verifier.verify(envelope);
  expect(() => authority.assertDispatch({ scope: "edge.payment", effect: "edge.payment.model", candidateSha256: hex("a"), topologySha256: hex("e"), requestSha256: envelope.request.requestSha256, roleCostBoundSha256: hex("4"), nowMs: now })).toThrow("NON_GOOGLE_INVOCATION_EXPIRED");
  expect(() => authority.assertOriginalObservation({ scope: "edge.payment", effect: "edge.payment.model", candidateSha256: hex("a"), topologySha256: hex("e"), requestSha256: envelope.request.requestSha256, roleCostBoundSha256: hex("4"), originalRecorded: true, operationId: original.operationId, operationSha256: original.operationSha256, nowMs: now })).not.toThrow();
  expect(() => authority.assertOriginalObservation({ scope: "edge.payment", effect: "edge.payment.model", candidateSha256: hex("a"), topologySha256: hex("e"), requestSha256: envelope.request.requestSha256, roleCostBoundSha256: hex("4"), originalRecorded: false, operationId: original.operationId, operationSha256: original.operationSha256, nowMs: now })).toThrow("NON_GOOGLE_INVOCATION_ORIGINAL_REQUIRED");
  expect(() => authority.assertOriginalObservation({ scope: "edge.payment", effect: "edge.payment.model", candidateSha256: hex("a"), topologySha256: hex("e"), requestSha256: envelope.request.requestSha256, roleCostBoundSha256: hex("4"), originalRecorded: true, operationId: "model_other_operation", operationSha256: original.operationSha256, nowMs: now })).toThrow("NON_GOOGLE_INVOCATION_ORIGINAL_DENIED");
  expect(() => authority.assertOriginalObservation({ scope: "edge.payment", effect: "edge.payment.model", candidateSha256: hex("a"), topologySha256: hex("e"), requestSha256: envelope.request.requestSha256, roleCostBoundSha256: hex("4"), originalRecorded: true, operationId: "model_other_operation", operationSha256: original.operationSha256, nowMs: now - 1 })).toThrow("NON_GOOGLE_INVOCATION_ORIGINAL_DENIED");
  const denied = await fixture(now - 2, { expiresAtMs: now - 1, verificationNow: now, originalOperations: [original] });
  await expect(denied.verifier.verify(denied.envelope)).rejects.toThrow("NON_GOOGLE_INVOCATION_EXPIRED");
});
