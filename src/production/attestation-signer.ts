import { finalizeEvent, getPublicKey } from "nostr-tools/pure";
import { CvmBuildAttestationSchema, type CvmBuildAttestation } from "../publication/contracts";
import { canonicalJson } from "../promotion/schema";
import { validateDirectCvmBuildAttestation } from "../publication/direct-attestation";

/** Service-key capability with no generic event-signing method. The owner key
 * is never resolved here; the mounted service key stays private to this object. */
export class ProductionBuildAttestationSigner {
  readonly #key: Uint8Array;
  #closed = false;
  readonly publicKey: string;
  constructor(key: Uint8Array) {
    if (!(key instanceof Uint8Array) || key.byteLength !== 32) throw new Error("PRODUCTION_ATTESTATION_KEY_INVALID");
    this.#key = new Uint8Array(key);
    this.publicKey = getPublicKey(this.#key);
    Object.freeze(this);
  }
  signBuild(raw: CvmBuildAttestation) {
    if (this.#closed) throw new Error("PRODUCTION_ATTESTATION_SIGNER_CLOSED");
    const record = CvmBuildAttestationSchema.parse(raw);
    if (record.ownerPubkey === this.publicKey) throw new Error("PRODUCTION_ATTESTATION_OWNER_KEY_REJECTED");
    return finalizeEvent({ kind: 1, created_at: Math.floor(record.createdAtMs / 1000), content: canonicalJson(record),
      tags: [["e", record.ownerEventId], ["p", record.ownerPubkey], ["x", record.aggregateSha256], ["t", "cvm_build_attestation"]] }, this.#key);
  }
  async signDirectBuild(raw: unknown) {
    if (this.#closed) throw new Error("PRODUCTION_ATTESTATION_SIGNER_CLOSED");
    const record = await validateDirectCvmBuildAttestation(raw);
    if (this.#closed) throw new Error("PRODUCTION_ATTESTATION_SIGNER_CLOSED");
    if (record.ownerPubkey === this.publicKey) throw new Error("PRODUCTION_ATTESTATION_OWNER_KEY_REJECTED");
    return finalizeEvent({ kind: 1, created_at: Math.floor(record.createdAtMs / 1000), content: canonicalJson(record),
      tags: [["e", record.ownerEventId], ["p", record.ownerPubkey], ["x", record.artifact.artifactHash], ["t", "cvm_build_attestation"], ["v", record.version]] }, this.#key);
  }
  close() { this.#closed = true; this.#key.fill(0); }
}
