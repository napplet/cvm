import { expect, test } from "bun:test";
import { getPublicKey, verifyEvent } from "nostr-tools/pure";
import { ProductionBuildAttestationSigner } from "../../src/production/attestation-signer";
import { CvmBuildAttestationSchema } from "../../src/publication/contracts";
import { canonicalJson } from "../../src/promotion/schema";
import { createDirectCvmBuildAttestation } from "../../src/publication/direct-attestation";

// Public local-test keys and provenance fixture; not release evidence.
test("service signer signs only a typed owner-linked provenance note and closes its key", () => {
  const serviceKey = new Uint8Array(32).fill(11);
  const signer = new ProductionBuildAttestationSigner(serviceKey);
  const record = CvmBuildAttestationSchema.parse({ type: "cvm_build_attestation", attestationId: "attestation:fixture", ownerEventId: "a".repeat(64), ownerPubkey: getPublicKey(new Uint8Array(32).fill(7)),
    artifactId: "artifact:fixture", artifactSha256: "b".repeat(64), aggregateSha256: "b".repeat(64), sessionId: "session:fixture", sessionVersion: 1, artifactVersion: 1,
    policyVersion: "policy:fixture", toolchainIdentity: "toolchain:fixture", verificationEvidenceReference: "evidence:fixture", verificationEvidenceSha256: "c".repeat(64), createdAtMs: 1_000_000 });
  const event = signer.signBuild(record);
  expect(verifyEvent(event)).toBe(true);
  expect(event.kind).toBe(1);
  expect(event.content).toBe(canonicalJson(record));
  expect(event.tags).toEqual([["e", record.ownerEventId], ["p", record.ownerPubkey], ["x", record.aggregateSha256], ["t", "cvm_build_attestation"]]);
  expect(event.pubkey).toBe(signer.publicKey);
  expect(event.pubkey).not.toBe(record.ownerPubkey);
  expect(() => signer.signBuild({ ...record, ownerPubkey: signer.publicKey })).toThrow("PRODUCTION_ATTESTATION_OWNER_KEY_REJECTED");
  signer.close();
  expect(() => signer.signBuild(record)).toThrow("PRODUCTION_ATTESTATION_SIGNER_CLOSED");
  expect(serviceKey).toEqual(new Uint8Array(32).fill(11));
  expect(verifyEvent(event)).toBe(true);
});

test("direct service attestation keeps raw HTML and archive identities distinct and rejects altered authority", async () => {
  const key = new Uint8Array(32).fill(23), signer = new ProductionBuildAttestationSigner(key);
  const body = { version: "direct-cvm-build-attestation-v1" as const, intentId: `direct-publication:${"a".repeat(64)}`,
    reviewSha256: "b".repeat(64), ownerEventId: "c".repeat(64), ownerPubkey: getPublicKey(new Uint8Array(32).fill(7)),
    artifact: { sessionId: "session:direct", artifactId: `artifact:${"d".repeat(64)}`, artifactVersion: 2, artifactHash: "e".repeat(64), archiveSha256: "d".repeat(64),
      verificationEvidenceSha256: "f".repeat(64), conformanceReceiptSha256: "1".repeat(64), manifestReceiptSha256: "2".repeat(64), policyVersion: "policy:direct", toolchainSha256: "3".repeat(64) },
    capabilitiesSha256: "4".repeat(64), candidateSha256: "5".repeat(64), topologySha256: "6".repeat(64), effectPlanSha256: "7".repeat(64),
    uploadLocation: `https://publication.example/${"e".repeat(64)}`, createdAtMs: 1_000_000 };
  const record = await createDirectCvmBuildAttestation(body), event = await signer.signDirectBuild(record);
  expect(verifyEvent(event)).toBeTrue(); expect(event.pubkey).toBe(signer.publicKey);
  expect(event.content).toBe(canonicalJson(record)); expect(event.content).not.toContain("aggregate");
  expect(event.tags).toEqual([["e", record.ownerEventId], ["p", record.ownerPubkey], ["x", record.artifact.artifactHash], ["t", "cvm_build_attestation"], ["v", record.version]]);
  await expect(signer.signDirectBuild({ ...record, candidateSha256: "0".repeat(64) })).rejects.toThrow("DIGEST_REQUIRED");
  await expect(signer.signDirectBuild({ ...record, aggregateSha256: record.artifact.artifactHash })).rejects.toThrow();
  await expect(createDirectCvmBuildAttestation({ ...body, uploadLocation: `https://publication.example/${body.artifact.archiveSha256}` })).rejects.toThrow("BINDING_REQUIRED");
  await expect(signer.signDirectBuild(await createDirectCvmBuildAttestation({ ...body, ownerPubkey: signer.publicKey }))).rejects.toThrow("OWNER_KEY_REJECTED");
  const inFlight = signer.signDirectBuild(record); signer.close();
  await expect(inFlight).rejects.toThrow("SIGNER_CLOSED");
  await expect(signer.signDirectBuild(record)).rejects.toThrow("SIGNER_CLOSED");
  expect(key).toEqual(new Uint8Array(32).fill(23));
});
