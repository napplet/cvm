import { expect, test } from "bun:test";

import { createNonGoogleInvocationAuthorityVerifier } from "../../src/production/non-google-invocation-authority";
import { canonicalJson } from "../../src/promotion/schema";
import { createNonGoogleAuthorizationRequestV3 } from "../../src/release/contracts";

function ownedArrayBuffer(value: Uint8Array): ArrayBuffer {
  const copy = new ArrayBuffer(value.byteLength);
  new Uint8Array(copy).set(value);
  return copy;
}
const digest = async (value: string | Uint8Array) => { const source = typeof value === "string" ? new TextEncoder().encode(value) : value; return Array.from(new Uint8Array(await crypto.subtle.digest("SHA-256", ownedArrayBuffer(source))), byte => byte.toString(16).padStart(2, "0")).join(""); };
const hex = (value: string) => value.repeat(64);

async function fixture(now = 1_000_000) {
  const pair = await crypto.subtle.generateKey({ name: "Ed25519" }, true, ["sign", "verify"]);
  const publicKeySpkiDer = new Uint8Array(await crypto.subtle.exportKey("spki", pair.publicKey));
  const costBytes = new TextEncoder().encode("controller-cost-artifact");
  const scopes = ["edge.payment"], effects = ["edge.payment.model"];
  const request = await createNonGoogleAuthorizationRequestV3({
    identity: { candidateSha256: hex("a"), sourceSha256: hex("b"), configSha256: hex("c"), toolchainSha256: hex("d"), topologySha256: hex("e"), failureDomainSha256: hex("f"), retentionSha256: hex("0"), cleanupSha256: hex("1"), controllerStateSha256: hex("2") },
    binding: { providerGraphRevision: "non-google-v1", roleInventorySha256: hex("3"), roleCostBoundSha256: hex("4"), scopesSha256: await digest(canonicalJson(scopes)), effectsSha256: await digest(canonicalJson(effects)) },
  });
  const unsigned = { version: "non-google-invocation-envelope-v1" as const, issuerId: "controller-root-1", issuedAtMs: now - 1, expiresAtMs: now + 60_000, request, receipt: { kind: "release-authorization-receipt-v4" as const, version: 4 as const, requestSha256: request.requestSha256, candidateSha256: hex("a"), topologySha256: hex("e"), providerGraphRevision: "non-google-v1" as const, roleInventorySha256: hex("3"), roleCostBoundSha256: hex("4"), receiptSha256: hex("5") }, scopes, effects, costArtifactSha256: await digest(costBytes) };
  const signature = Buffer.from(new Uint8Array(await crypto.subtle.sign({ name: "Ed25519" }, pair.privateKey, new TextEncoder().encode(canonicalJson(unsigned)))).buffer).toString("base64url");
  const verifier = createNonGoogleInvocationAuthorityVerifier({ trustedIssuers: [{ issuerId: unsigned.issuerId, publicKeySpkiDer }], allowedScopes: scopes, allowedEffects: effects, costArtifact: { bytes: costBytes, sha256: unsigned.costArtifactSha256 }, now: () => now });
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
