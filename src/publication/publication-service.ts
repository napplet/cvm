import { PublicationResultSchema, SignedOwnerManifestEventSchema, SignedPublicationCommandSchema, type AttestationPort, type CapabilityReview, type NappletDeploymentPort, type OwnerEventVerifierPort, type Phase06Clock, type PublicationIntent, type PublicationObservation, type PublicationResult, type PublicationStatus, type SealedArtifactIdentity } from "./contracts.js";
import type { PublicationStore } from "../persistence/publication-store.js";
import { createPublicationIntent, isPublicationIntentExpired } from "./publication-intent.js";

const operation = (kind: "deploy" | "owner_manifest" | "attestation", intentId: string) => `${kind}:${intentId}`;

export class PublicationService {
  constructor(private readonly dependencies: Readonly<{ store: PublicationStore; verifier: OwnerEventVerifierPort; deployment: NappletDeploymentPort; attestation: AttestationPort; clock: Phase06Clock }>) {}

  async createIntent(input: Readonly<{ accountId: string; sessionId: string; artifact: SealedArtifactIdentity; review: CapabilityReview; ownerPubkey: string; idempotencyKey: string; purpose: string; consent: "approved"; runtimeVariant: string; expiresAtMs?: number }>): Promise<PublicationIntent> {
    const createdAtMs = this.dependencies.clock.nowMs();
    const intent = createPublicationIntent({ ...input, createdAtMs, expiresAtMs: input.expiresAtMs ?? createdAtMs + 300_000 });
    if (isPublicationIntentExpired(intent, createdAtMs)) throw new Error("PUBLICATION_INTENT_EXPIRED");
    return this.dependencies.store.transact((tx) => tx.putIntent(intent));
  }

  async submitSignedManifest(input: Readonly<{ accountId: string; intentId: string; command: unknown; event: unknown }>): Promise<PublicationResult> {
    const intent = await this.dependencies.store.getIntent(input.intentId);
    if (!intent || intent.accountId !== input.accountId) throw new Error("INVALID_MANIFEST");
    if (isPublicationIntentExpired(intent, this.dependencies.clock.nowMs())) throw new Error("INVALID_MANIFEST");
    const existing = await this.dependencies.store.getStatus(intent.intentId);
    if (existing && (existing.status === "complete" || existing.status === "partial")) return existing;
    let command;
    let event;
    try {
      command = SignedPublicationCommandSchema.parse(input.command);
      event = SignedOwnerManifestEventSchema.parse(input.event);
    } catch { throw new Error("INVALID_MANIFEST"); }
    if (command.intentId !== intent.intentId || command.intentFingerprint !== intent.fingerprint || command.operationIds.deploy !== operation("deploy", intent.intentId) || command.operationIds.ownerManifest !== operation("owner_manifest", intent.intentId) || command.operationIds.attestation !== operation("attestation", intent.intentId)) throw new Error("INVALID_MANIFEST");
    const verified = await this.dependencies.verifier.verify({ event, intent });
    if (verified.valid !== true || verified.eventId !== event.id) throw new Error("INVALID_MANIFEST");
    await this.dependencies.store.transact((tx) => tx.putSignedEvent(intent.intentId, event));
    const deploy = await this.#effect(intent, "deploy", () => this.dependencies.deployment.deployExact({ operationId: operation("deploy", intent.intentId), artifact: intent.artifact, signedOwnerManifest: event }));
    const owner = await this.#effect(intent, "owner_manifest", () => this.dependencies.deployment.publishOwnerManifest({ operationId: operation("owner_manifest", intent.intentId), event }));
    const attestation = await this.#effect(intent, "attestation", () => this.dependencies.attestation.publish({ operationId: operation("attestation", intent.intentId), artifact: intent.artifact, ownerEventId: event.id }));
    const complete = [deploy, owner, attestation].every((entry) => entry.state === "completed");
    const result = PublicationResultSchema.parse({ status: complete ? "complete" : "partial", intentId: intent.intentId, nextAction: complete ? "none" : "reconcile_publication", artifact: { aggregateSha256: intent.artifact.aggregateSha256, normalizedDTag: intent.artifact.normalizedDTag }, capabilityDigest: intent.capabilityDigest, ownerEventId: event.id, deploymentId: deploy.deploymentId, fullServerUploadId: deploy.fullServerUploadId, ownerRelayObservation: owner.relayObservation ?? verified.relayObservation, attestationId: attestation.attestationId, attestationRelayObservation: attestation.relayObservation });
    return this.dependencies.store.transact((tx) => tx.putCommandResult(intent.intentId, intent.fingerprint, result));
  }

  async reconcile(input: Readonly<{ accountId: string; intentId: string }>): Promise<PublicationStatus | PublicationResult> { return this.status(input); }
  async status(input: Readonly<{ accountId: string; intentId: string }>): Promise<PublicationStatus | PublicationResult> {
    const intent = await this.dependencies.store.getIntent(input.intentId); if (!intent || intent.accountId !== input.accountId) throw new Error("PUBLICATION_NOT_FOUND_OR_DENIED");
    return (await this.dependencies.store.getStatus(input.intentId))!;
  }

  async #effect(intent: PublicationIntent, kind: "deploy" | "owner_manifest" | "attestation", invoke: () => Promise<PublicationObservation>): Promise<PublicationObservation> {
    const operationId = operation(kind, intent.intentId);
    const claim = await this.dependencies.store.transact((tx) => tx.claimEffect({ operationId, intentId: intent.intentId, kind, aggregateSha256: intent.artifact.aggregateSha256 }));
    if (!claim.claimed) return (await this.dependencies.store.transact((tx) => tx.getObservation(operationId))) ?? { operationId, state: "unknown", observationId: `observation:${operationId}` };
    const rawObservation = await invoke();
    if (rawObservation.operationId && rawObservation.operationId !== operationId) throw new Error("PUBLICATION_OBSERVATION_OPERATION_MISMATCH");
    const observation = { ...rawObservation, operationId };
    return this.dependencies.store.transact((tx) => tx.recordObservation(observation));
  }
}
