import { SignedOwnerManifestEventSchema } from "../../publication/contracts.js";
import { validatedAvailablePromotedCliSourceContract } from "../../publication/napplet-cli-source-contract.js";
import type { LivePublicationObservationPort } from "./publication.js";
import type { NativePromotedCliSource } from "../../release/native/promoted-cli.js";

type OriginalPublicationService = Readonly<{
  submitSignedManifest(input: Readonly<{ accountId: string; intentId: string; command: unknown; event: unknown }>): Promise<unknown>;
  reconcile(input: Readonly<{ accountId: string; intentId: string }>): Promise<unknown>;
}>;

function exactOperations(intentId: string, operationIds: Readonly<{ deploy: string; ownerManifest: string; attestation: string }>): boolean {
  return operationIds.deploy === `deploy:${intentId}` && operationIds.ownerManifest === `owner_manifest:${intentId}` && operationIds.attestation === `attestation:${intentId}`;
}

/**
 * Protected-suite bridge: it owns no CLI, signer, relay, storage, credentials,
 * evidence sink, or alternative evaluator. PublicationService remains the sole
 * durable authority for signed-event persistence and effect dispatch.
 */
export function createProtectedLivePublicationObservationPort(input: Readonly<{
  candidateId: string;
  sealedArtifactSha256: string;
  aggregateSha256: string;
  source: NativePromotedCliSource;
  submission: Readonly<{ accountId: string; intentId: string; command: unknown; event: unknown; signerPubkey: string }>;
  publication: OriginalPublicationService;
}>): LivePublicationObservationPort {
  const sourceValid = () => validatedAvailablePromotedCliSourceContract(input.source.contract);
  const event = SignedOwnerManifestEventSchema.parse(input.submission.event);
  const command = input.submission.command as { intentId?: unknown; operationIds?: unknown };
  const operationIds = command.operationIds as { deploy?: unknown; ownerManifest?: unknown; attestation?: unknown };
  if (command.intentId !== input.submission.intentId || !operationIds || typeof operationIds.deploy !== "string" || typeof operationIds.ownerManifest !== "string" || typeof operationIds.attestation !== "string" || !exactOperations(input.submission.intentId, operationIds as { deploy: string; ownerManifest: string; attestation: string }) || event.pubkey !== input.submission.signerPubkey) throw new Error("PUBLICATION_BRIDGE_INPUT_INVALID");
  const exactOperationIds = Object.freeze({ deploy: operationIds.deploy as string, ownerManifest: operationIds.ownerManifest as string, attestation: operationIds.attestation as string });

  return Object.freeze({
    evidenceClass: "protected_live" as const,
    async verifyPromotedSource(candidate) {
      if (candidate.candidateId !== input.candidateId || !sourceValid()) throw new Error("PROMOTED_SOURCE_UNAVAILABLE");
      return Object.freeze({ status: "passed" as const, candidateId: input.candidateId, sealedArtifactSha256: input.sealedArtifactSha256, aggregateSha256: input.aggregateSha256, promotedCliSourceVerified: true as const, promotedCliAssetVerified: true as const });
    },
    async submitOriginalPublication(source) {
      if (!sourceValid() || source.sealedArtifactSha256 !== input.sealedArtifactSha256 || source.aggregateSha256 !== input.aggregateSha256) throw new Error("PUBLICATION_BINDING_INVALID");
      await input.publication.submitSignedManifest({ accountId: input.submission.accountId, intentId: input.submission.intentId, command: input.submission.command, event });
      return Object.freeze({ status: "submitted" as const, intentId: input.submission.intentId, sealedArtifactSha256: input.sealedArtifactSha256, userSigningExternal: true as const, operationIds: exactOperationIds });
    },
    async reconcileOriginalPublication(operation) {
      if (!sourceValid() || operation.intentId !== input.submission.intentId || JSON.stringify(operation.operationIds) !== JSON.stringify(exactOperationIds)) throw new Error("PUBLICATION_ORIGINAL_OPERATION_INVALID");
      const status = await input.publication.reconcile({ accountId: input.submission.accountId, intentId: input.submission.intentId }) as Record<string, unknown>;
      if (status.status !== "complete" || status.intentId !== input.submission.intentId || typeof status.fullServerUploadId !== "string" || typeof status.ownerRelayObservation !== "string" || typeof status.attestationRelayObservation !== "string") throw new Error("PUBLICATION_RECONCILIATION_PENDING");
      return Object.freeze({ status: "complete" as const, intentId: input.submission.intentId, operationIds: exactOperationIds, originalOperationsOnly: true as const, deploymentObserved: true as const, ownerRelayObserved: true as const, attestationRelayObserved: true as const });
    },
  });
}
