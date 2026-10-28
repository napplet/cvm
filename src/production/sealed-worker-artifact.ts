import { canonicalJson } from "../promotion/schema";
import { readVerifiedProductionArtifactFile, type VerifiedProductionArtifact } from "./artifact-verifier";
import type { VerifiedDirectProductionArtifact } from "./direct-artifact-verifier";

/** Preserve legacy bytes; new worker receipts retain the actual CLI output and
 * capability-file observation for the future owner-scoped artifact reader. */
export async function sealProductionWorkerArtifact(verified: VerifiedProductionArtifact): Promise<Uint8Array> {
  const files = await Promise.all(verified.files.map(async file => ({ path: file.path, sha256: file.sha256, bytesBase64: Buffer.from(await readVerifiedProductionArtifactFile(verified.distRoot, file)).toString("base64") })));
  const receipt = verified.capabilityReceipt;
  const format = receipt === undefined ? { version: 1 } : {
    version: 2,
    build: { accountId: verified.accountId, ownerId: verified.ownerId, sessionId: verified.sessionId, actionId: verified.actionId, expectedVersion: verified.expectedVersion, proposalSha256: verified.proposalSha256, toolchainSha256: verified.toolchainSha256, ...(verified.publication ? { publication: verified.publication } : {}) },
    receipts: { capability: receipt, commands: verified.commandEvidence },
  };
  return new TextEncoder().encode(canonicalJson({ ...format, aggregateSha256: verified.aggregateSha256, sealedObjectSha256: verified.sealedObjectSha256, verificationEvidenceSha256: verified.verificationEvidenceSha256, files }));
}

/** A distinct archive contract preserves direct HTML identity and structured
 * receipts. Historical versions retain their original aggregate encoding. */
export async function sealDirectProductionWorkerArtifact(verified: VerifiedDirectProductionArtifact): Promise<Uint8Array> {
  const files = await Promise.all(verified.files.map(async file => ({ path: file.path, sha256: file.sha256, bytesBase64: Buffer.from(await readVerifiedProductionArtifactFile(verified.distRoot, file)).toString("base64") })));
  return new TextEncoder().encode(canonicalJson({
    version: 3, artifactContract: verified.artifactContract, artifactHash: verified.artifactHash,
    build: { accountId: verified.accountId, ownerId: verified.ownerId, sessionId: verified.sessionId, actionId: verified.actionId, expectedVersion: verified.expectedVersion, proposalSha256: verified.proposalSha256, toolchainSha256: verified.toolchainSha256, publication: verified.publication },
    receipts: { capability: verified.capabilityReceipt, conformance: verified.conformanceReceipt, manifest: verified.manifestReceipt, commands: verified.commandEvidence },
    sealedObjectSha256: verified.sealedObjectSha256, verificationEvidenceSha256: verified.verificationEvidenceSha256, files,
  }));
}
