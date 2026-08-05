import type { PublicationIntent, SignedOwnerManifestEvent } from "./contracts.js";
import type { PublicationRecord } from "../persistence/publication-store.js";

export type ProjectedPublicationStatus = Readonly<{
  state: "intent_ready" | "publication_reconciliation_pending" | "partial" | "complete";
  intentId: string;
  artifactId: string;
  ownerEventId?: string;
  attestationId?: string;
  deployOperationId: string;
  safeServerEvidenceCount: number;
  safeRelayEvidenceCount: number;
  nextAction: "sign_manifest" | "publish" | "reconcile_publication" | "none";
}>;

export function publicationCompletionPredicate(record: PublicationRecord, event?: SignedOwnerManifestEvent): boolean {
  const deploy = record.effects.deploy.observation;
  const owner = record.effects.owner_manifest.observation;
  const attestation = record.effects.attestation.observation;
  return event !== undefined && deploy?.state === "completed" && Boolean(deploy.fullServerUploadId) && owner?.state === "completed" && Boolean(owner.relayObservation) && attestation?.state === "completed" && Boolean(attestation.attestationId) && Boolean(attestation.relayObservation);
}

/** Projects only stored identities and evidence references; provider payloads never cross this boundary. */
export function projectPublicationStatus(input: Readonly<{ intent: PublicationIntent; record: PublicationRecord; event?: SignedOwnerManifestEvent }>): ProjectedPublicationStatus {
  const deploy = input.record.effects.deploy;
  const owner = input.record.effects.owner_manifest;
  const attestation = input.record.effects.attestation;
  const complete = publicationCompletionPredicate(input.record, input.event);
  const unresolved = [deploy, owner, attestation].some((effect) => ["created", "dispatching", "unknown"].includes(effect.state));
  const state = complete ? "complete" : !input.event ? "intent_ready" : unresolved ? "publication_reconciliation_pending" : "partial";
  const relayCount = Number(Boolean(owner.observation?.relayObservation)) + Number(Boolean(attestation.observation?.relayObservation));
  return Object.freeze({
    state,
    intentId: input.intent.intentId,
    artifactId: input.intent.artifact.artifactId,
    ...(input.event ? { ownerEventId: input.event.id } : {}),
    ...(attestation.observation?.attestationId ? { attestationId: attestation.observation.attestationId } : {}),
    deployOperationId: deploy.operationId,
    safeServerEvidenceCount: Number(Boolean(deploy.observation?.fullServerUploadId)),
    safeRelayEvidenceCount: relayCount,
    nextAction: state === "complete" ? "none" : state === "intent_ready" ? "sign_manifest" : state === "partial" || state === "publication_reconciliation_pending" ? "reconcile_publication" : "publish",
  });
}
