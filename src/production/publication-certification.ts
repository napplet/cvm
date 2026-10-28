import type { PublicationIntent } from "../publication/contracts";
import type { ProductionConcreteClients } from "../release/deployment/production-session-runtime";

type Clients = Pick<ProductionConcreteClients, "publicationContext"> & Readonly<{ edge: Pick<ProductionConcreteClients["edge"], "signer" | "promotedCli" | "relays"> }>;
type Source = Readonly<{ candidateId: string; sealedArtifactSha256: string; aggregateSha256: string }>;
type Original = Readonly<{ candidateId: string; intentId: string; operationIds: Readonly<{ deploy: string; ownerManifest: string; attestation: string }> }>;

const submittedPublication = (intent: PublicationIntent) => Object.freeze({ status: "submitted" as const, intentId: intent.intentId, sealedArtifactSha256: intent.artifactSha256, userSigningExternal: true as const,
  operationIds: { deploy: `deploy:${intent.intentId}`, ownerManifest: `owner_manifest:${intent.intentId}`, attestation: `attestation:${intent.intentId}` } });


/** Runs the publication portion of the sealed edge service from its concrete
 * component graph. Recovery methods only observe already recorded originals. */
export class ProductionPublicationCertification {
  constructor(private readonly candidateSha256: string, private readonly clients: Clients) {}
  async source() {
    const source = await this.clients.publicationContext.source();
    if (source.candidateId !== this.candidateSha256) throw new Error("CERTIFICATION_EDGE_CANDIDATE_MISMATCH");
    return source;
  }
  async submit(value: Source) {
    if (value.candidateId !== this.candidateSha256) throw new Error("CERTIFICATION_EDGE_CANDIDATE_MISMATCH");
    const context = await this.clients.publicationContext.resolve({
      candidateSha256: this.candidateSha256,
      sealedArtifactSha256: value.sealedArtifactSha256,
      aggregateSha256: value.aggregateSha256,
    });
    if (context.artifact.sealedObjectSha256 !== value.sealedArtifactSha256 || context.artifact.aggregateSha256 !== value.aggregateSha256
      || context.intent.artifactSha256 !== value.sealedArtifactSha256 || context.intent.aggregateSha256 !== value.aggregateSha256) {
      throw new Error("CERTIFICATION_EDGE_PUBLICATION_CONTEXT_MISMATCH");
    }
    // NIP-46 signing is external-owner only. The CVM receives the public
    // result, never a user key. The source verifier owns byte hydration
    // and the exact promoted CLI upload/relay route for this sealed intent.
    const owner = await this.clients.edge.signer.signExactIntent({
      candidate: { sealedArtifactSha256: context.artifact.sealedObjectSha256, aggregateSha256: context.artifact.aggregateSha256 },
      intent: context.intent,
      requiredCapabilities: context.requiredSignerCapabilities,
    });
    const deployOperationId = `deploy:${context.intent.intentId}`;
    const deploy = await this.clients.publicationContext.deploy({
      candidateSha256: this.candidateSha256,
      sealedArtifactSha256: context.artifact.sealedObjectSha256,
      aggregateSha256: context.artifact.aggregateSha256,
      operationId: deployOperationId,
    });
    if (deploy.target.kind !== 35129 || deploy.target.dTag !== context.intent.dTag || !deploy.files.length || !deploy.servers.length) {
      throw new Error("CERTIFICATION_EDGE_PUBLICATION_DEPLOY_CONTEXT_INVALID");
    }
    // These are the actual reviewed CLI source operations. Both calls are
    // bounded by the sealed artifact bytes and the externally signed owner
    // event; no POST field can select a different target, file, relay, or
    // authorisation hash set.
    const upload = await this.clients.edge.promotedCli.port.uploadFilesToServers({
      operationId: deployOperationId,
      target: deploy.target,
      files: deploy.files,
      servers: deploy.servers,
      authorizeExactHashes: deploy.authorizeExactHashes,
    });
    if (upload.state !== "complete") throw new Error("CERTIFICATION_EDGE_PUBLICATION_UPLOAD_UNRESOLVED");
    const relay = await this.clients.edge.promotedCli.port.publishEventWithSimplePool({
      operationId: `owner_manifest:${context.intent.intentId}`,
      event: owner.signedEvent,
      relays: context.relaySet,
    });
    if (relay.state !== "complete") throw new Error("CERTIFICATION_EDGE_PUBLICATION_RELAY_UNRESOLVED");
    const attestation = await this.clients.edge.relays.attestationPort.publish({ operationId: `attestation:${context.intent.intentId}`, artifact: context.artifact, ownerEventId: owner.signedEvent.id });
    if (attestation.state !== "completed") throw new Error("CERTIFICATION_EDGE_PUBLICATION_ATTESTATION_UNRESOLVED");
    return submittedPublication(context.intent);
  }
  async observeSubmit(value: Source) {
    if (value.candidateId !== this.candidateSha256) throw new Error("CERTIFICATION_EDGE_CANDIDATE_MISMATCH");
    const context = await this.clients.publicationContext.original({ candidateSha256: this.candidateSha256, sealedArtifactSha256: value.sealedArtifactSha256, aggregateSha256: value.aggregateSha256 });
    const submitted = submittedPublication(context.intent);
    await this.#reconcilePublication(submitted.intentId, submitted.operationIds);
    return submitted;
  }
  async reconcile(value: Original) {
    if (value.candidateId !== this.candidateSha256) throw new Error("CERTIFICATION_EDGE_CANDIDATE_MISMATCH");
    return this.#reconcilePublication(value.intentId, value.operationIds);
  }
  async #reconcilePublication(intentId: string, operationIds: Readonly<{ deploy: string; ownerManifest: string; attestation: string }>) {
    const source = await this.clients.publicationContext.source();
    const context = await this.clients.publicationContext.original({ candidateSha256: source.candidateId, sealedArtifactSha256: source.sealedArtifactSha256, aggregateSha256: source.aggregateSha256 });
    if (intentId !== context.intent.intentId || operationIds.deploy !== `deploy:${intentId}` || operationIds.ownerManifest !== `owner_manifest:${intentId}` || operationIds.attestation !== `attestation:${intentId}`) throw new Error("CERTIFICATION_EDGE_PUBLICATION_OPERATION_MISMATCH");
    const [upload, owner, attestation] = await Promise.all([
      this.clients.publicationContext.observeUpload({ intentId, operationId: operationIds.deploy }),
      this.clients.edge.relays.reconcileOriginalEvent({ operationId: operationIds.ownerManifest }),
      this.clients.edge.relays.attestationPort.observe({ operationId: operationIds.attestation }),
    ]);
    if (upload.state !== "complete" || !upload.fullServerUploadId || owner.state !== "completed" || !owner.relayObservation || attestation.state !== "completed" || !attestation.relayObservation || !attestation.attestationId) throw new Error("CERTIFICATION_EDGE_PUBLICATION_ORIGINAL_UNRESOLVED");
    return Object.freeze({ status: "complete" as const, intentId, operationIds, originalOperationsOnly: true as const, deploymentObserved: true as const, ownerRelayObserved: true as const, attestationRelayObserved: true as const });
  }

}
