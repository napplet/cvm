import { expect, test } from "bun:test";
import { getPublicKey, verifyEvent } from "nostr-tools/pure";
import { ProductionBuildAttestationSigner } from "../../src/production/attestation-signer";
import { CvmBuildAttestationSchema } from "../../src/publication/contracts";
import { canonicalJson } from "../../src/promotion/schema";

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
