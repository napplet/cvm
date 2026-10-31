import { expect, test } from "bun:test";

import { canonicalJson } from "../../src/promotion/schema";
import { createNonGoogleInvocationAuthorityVerifier } from "../../src/production/non-google-invocation-authority";
import { createNonGoogleAuthorizationRequestV3 } from "../../src/release/contracts";
import { openNonGoogleContextVmCertificationClient } from "../../src/release/deployment/contextvm-client";
import { PostgresOperationJournal } from "../../src/release/deployment/postgres-operation-journal";

const text = new TextEncoder();
const digest = (letter: string) => letter.repeat(64);

async function sha256(value: string | Uint8Array): Promise<string> {
  const bytes = typeof value === "string" ? text.encode(value) : value;
  const owned = new Uint8Array(bytes.byteLength); owned.set(bytes);
  return Array.from(new Uint8Array(await crypto.subtle.digest("SHA-256", owned.buffer)), byte => byte.toString(16).padStart(2, "0")).join("");
}

async function authority(now: () => number, expiresAtMs: number) {
  const pair = await crypto.subtle.generateKey({ name: "Ed25519" }, true, ["sign", "verify"]);
  const request = await createNonGoogleAuthorizationRequestV3({
    identity: { candidateSha256: digest("a"), sourceSha256: digest("b"), configSha256: digest("c"), toolchainSha256: digest("d"), topologySha256: digest("e"), failureDomainSha256: digest("f"), retentionSha256: digest("0"), cleanupSha256: digest("1"), controllerStateSha256: digest("2") },
    binding: { providerGraphRevision: "non-google-v1", roleInventorySha256: digest("3"), roleCostBoundSha256: digest("4"), scopesSha256: await sha256(canonicalJson(["edge.payment"])), effectsSha256: await sha256(canonicalJson(["edge.payment.contextvm"])) },
  });
  const costBytes = text.encode("controller-owned-cost-artifact");
  const unsigned = { version: "non-google-invocation-envelope-v1" as const, issuerId: "controller-root-1", issuedAtMs: now() - 2, expiresAtMs, request, receipt: { kind: "release-authorization-receipt-v4" as const, version: 4 as const, requestSha256: request.requestSha256, candidateSha256: digest("a"), topologySha256: digest("e"), providerGraphRevision: "non-google-v1" as const, roleInventorySha256: digest("3"), roleCostBoundSha256: digest("4"), receiptSha256: digest("5") }, scopes: ["edge.payment"], effects: ["edge.payment.contextvm"], costArtifactSha256: await sha256(costBytes) };
  const signature = Buffer.from(new Uint8Array(await crypto.subtle.sign({ name: "Ed25519" }, pair.privateKey, text.encode(canonicalJson(unsigned)))).buffer).toString("base64url");
  const verifier = createNonGoogleInvocationAuthorityVerifier({ trustedIssuers: [{ issuerId: unsigned.issuerId, publicKeySpkiDer: new Uint8Array(await crypto.subtle.exportKey("spki", pair.publicKey)) }], allowedScopes: unsigned.scopes, allowedEffects: unsigned.effects, costArtifact: { bytes: costBytes, sha256: unsigned.costArtifactSha256 }, now });
  return Object.freeze({ authority: await verifier.verify({ ...unsigned, signature }), requestSha256: request.requestSha256 });
}

test("non-Google ContextVM factory rejects expiry before broker-key or journal access", async () => {
  let now = 1_000_000;
  const signed = await authority(() => now, now + 1);
  let signerCalls = 0;
  let journalConnections = 0;
  const journal = new PostgresOperationJournal({ async connect() { journalConnections += 1; throw new Error("JOURNAL_MUST_NOT_CONNECT"); } }, { namespace: "non-google-contextvm", scopeSha256: digest("a") });
  now += 1;
  await expect(openNonGoogleContextVmCertificationClient({
    certificationKeyReference: "nostr:contextvm-certification-test",
    serverPubkey: digest("b"),
    relays: ["wss://relay.example"],
    signerBroker: { async resolveContextVmCertificationSigner() { signerCalls += 1; throw new Error("SIGNER_MUST_NOT_RESOLVE"); } },
    journal,
    candidateSha256: digest("a"),
    topologySha256: digest("e"),
    authority: signed.authority,
    authorizationRequestSha256: signed.requestSha256,
    roleCostBoundSha256: digest("4"),
    now: () => now,
  })).rejects.toThrow("NON_GOOGLE_INVOCATION_EXPIRED");
  expect({ signerCalls, journalConnections }).toEqual({ signerCalls: 0, journalConnections: 0 });
});
