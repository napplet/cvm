import { z } from "zod";
import { canonicalJson } from "../promotion/schema";
import { SignedOwnerManifestEventSchema } from "../publication/contracts";
import { DirectUploadAuthorizationEventSchema } from "../publication/direct-upload-authorization";
import { DirectPublicationReferenceSchema, DirectPublicationSourceObservationSchema, DirectPublicationSubmissionSchema,
  DirectPublicationReconciliationSchema, directPublicationOperationIds } from "../certification/live/direct-publication-contract";
import { ProductionDirectPublicationFactory } from "./direct-publication-factory";

/** Real private-controller construction over owned originals. This produces
 * operation observations, never a release result or promoted-profile claim. */
export class ProductionDirectPublicationCertification {
  readonly #reference: z.infer<typeof DirectPublicationReferenceSchema>;
  constructor(private readonly factory: ProductionDirectPublicationFactory, original: unknown, private readonly candidateSha256: string, private readonly topologySha256: string) {
    if (!(factory instanceof ProductionDirectPublicationFactory)) throw new Error("DIRECT_PUBLICATION_FACTORY_REQUIRED");
    this.#reference = DirectPublicationReferenceSchema.parse(original);
  }
  async source() {
    const original = await this.factory.originalApproval(this.#reference), actor = await this.factory.open(original);
    try {
      const source = await actor.source();
      if (source.candidateSha256 !== this.candidateSha256 || source.topologySha256 !== this.topologySha256) throw new Error("DIRECT_PUBLICATION_CANDIDATE_REQUIRED");
      return DirectPublicationSourceObservationSchema.parse({ version: "direct-publication-observation-v1", ...source,
        original, operationIds: await directPublicationOperationIds(original.intentId) });
    } finally { await actor.close(); }
  }
  async #matchSource(value: unknown) {
    const source = DirectPublicationSourceObservationSchema.parse(value), actual = await this.source();
    if (canonicalJson(source) !== canonicalJson(actual)) throw new Error("DIRECT_PUBLICATION_SOURCE_BINDING_REQUIRED");
    return actual;
  }
  async submit(value: unknown) {
    const source = await this.#matchSource(value), actor = await this.factory.open(source.original);
    try {
      const owner = z.object({ event: SignedOwnerManifestEventSchema }).passthrough().parse(await actor.requestOwnerSignature());
      await actor.acceptOwnerEvent(owner.event);
      await actor.prepareUploadAuthorization();
      const upload = z.object({ event: DirectUploadAuthorizationEventSchema }).passthrough().parse(await actor.requestUploadSignature());
      await actor.acceptUploadAuthorization(upload.event);
      const result = await actor.publish();
      if (result.state !== "complete" || result.artifactHash !== source.artifactHash || result.archiveSha256 !== source.archiveSha256 || result.ownerEventId !== owner.event.id) throw new Error("DIRECT_PUBLICATION_ORIGINAL_UNRESOLVED");
      return this.#submission(source, result.ownerEventId, result.attestationEventId);
    } finally { await actor.close(); }
  }
  #submission(source: z.infer<typeof DirectPublicationSourceObservationSchema>, ownerEventId: string, attestationEventId: string) {
    return DirectPublicationSubmissionSchema.parse({ version: source.version, status: "submitted", artifactContract: source.artifactContract,
      candidateSha256: source.candidateSha256, topologySha256: source.topologySha256, artifactHash: source.artifactHash, archiveSha256: source.archiveSha256,
      original: source.original, operationIds: source.operationIds, ownerEventId, attestationEventId, userSigningExternal: true });
  }
  async observeSubmit(value: unknown) {
    const source = await this.#matchSource(value), actor = await this.factory.open(source.original);
    try {
      const owner = z.object({ event: SignedOwnerManifestEventSchema }).passthrough().parse(await actor.observeOwnerSignature());
      // This lookup cannot request a missing BUD-11 signature.
      await actor.observeUploadSignature();
      const result = await actor.reconcile();
      if (result.state !== "complete" || result.artifactHash !== source.artifactHash || result.archiveSha256 !== source.archiveSha256 || result.ownerEventId !== owner.event.id) throw new Error("DIRECT_PUBLICATION_ORIGINAL_UNRESOLVED");
      return this.#submission(source, result.ownerEventId, result.attestationEventId);
    } finally { await actor.close(); }
  }
  async reconcile(value: unknown) {
    const submitted = DirectPublicationSubmissionSchema.parse(value), source = await this.source();
    if (canonicalJson(submitted) !== canonicalJson(this.#submission(source, submitted.ownerEventId, submitted.attestationEventId))) throw new Error("DIRECT_PUBLICATION_ORIGINAL_BINDING_REQUIRED");
    const actor = await this.factory.open(source.original);
    try {
      const owner = z.object({ event: SignedOwnerManifestEventSchema }).passthrough().parse(await actor.observeOwnerSignature());
      await actor.observeUploadSignature();
      const result = await actor.reconcile();
      if (result.state !== "complete" || result.ownerEventId !== owner.event.id || result.ownerEventId !== submitted.ownerEventId || result.attestationEventId !== submitted.attestationEventId
        || result.artifactHash !== source.artifactHash || result.archiveSha256 !== source.archiveSha256) throw new Error("DIRECT_PUBLICATION_ORIGINAL_UNRESOLVED");
      return DirectPublicationReconciliationSchema.parse({ ...submitted, status: "complete", locationReference: result.locationReference, originalOperationsOnly: true });
    } finally { await actor.close(); }
  }
}
