import { SignedOwnerManifestEventSchema, SignedPublicationCommandSchema, type AttestationPort, type CapabilityReview, type NappletDeploymentPort, type OwnerEventVerifierPort, type Phase06Clock, type PublicationIntent, type PublicationObservation, type SealedArtifactIdentity } from "./contracts.js";
import type { DurablePublicationStore, PublicationEffectKind, RecordPublicationObservationInput } from "../persistence/publication-store.js";
import { createPublicationIntent, isPublicationIntentExpired } from "./publication-intent.js";
import { projectPublicationStatus, type ProjectedPublicationStatus } from "./public-status.js";

const operation = (kind: PublicationEffectKind, intentId: string) => `${kind}:${intentId}`;
const durableState = (state: PublicationObservation["state"]): RecordPublicationObservationInput["state"] => state === "completed" ? "observed_complete" : state === "partial" ? "observed_partial" : state === "failed" ? "observed_failed" : "unknown";
export type PublicationServiceStatus = ProjectedPublicationStatus & Readonly<{
  status?: "partial" | "complete";
  artifact?: Readonly<{ aggregateSha256: string; normalizedDTag: string }>;
  capabilityDigest?: string;
  deploymentId?: string;
  fullServerUploadId?: string;
  ownerRelayObservation?: string;
  attestationRelayObservation?: string;
}>;

export class PublicationService {
  #submissions = new Map<string, Promise<PublicationServiceStatus>>();
  constructor(private readonly dependencies: Readonly<{ store: DurablePublicationStore; verifier: OwnerEventVerifierPort; deployment: NappletDeploymentPort; attestation: AttestationPort; clock: Phase06Clock }>) {}

  async createIntent(input: Readonly<{ accountId: string; sessionId: string; artifact: SealedArtifactIdentity; review: CapabilityReview; ownerPubkey: string; idempotencyKey: string; purpose: string; consent: "approved"; runtimeVariant: string; expiresAtMs?: number }>): Promise<PublicationIntent> {
    const createdAtMs = this.dependencies.clock.nowMs();
    const intent = createPublicationIntent({ ...input, createdAtMs, expiresAtMs: input.expiresAtMs ?? createdAtMs + 300_000 });
    if (isPublicationIntentExpired(intent, createdAtMs)) throw new Error("PUBLICATION_INTENT_EXPIRED");
    return this.dependencies.store.transact((tx) => tx.putIntent(intent));
  }

  async submitSignedManifest(input: Readonly<{ accountId: string; intentId: string; command: unknown; event: unknown }>): Promise<PublicationServiceStatus> {
    const active = this.#submissions.get(input.intentId);
    if (active) return active;
    const submission = this.#submit(input).finally(() => this.#submissions.delete(input.intentId));
    this.#submissions.set(input.intentId, submission);
    return submission;
  }

  async #submit(input: Readonly<{ accountId: string; intentId: string; command: unknown; event: unknown }>): Promise<PublicationServiceStatus> {
    const intent = await this.#intentForOwner(input.accountId, input.intentId);
    let command;
    let event;
    try { command = SignedPublicationCommandSchema.parse(input.command); event = SignedOwnerManifestEventSchema.parse(input.event); } catch { throw new Error("INVALID_MANIFEST"); }
    if (command.intentId !== intent.intentId || command.intentFingerprint !== intent.fingerprint || command.operationIds.deploy !== operation("deploy", intent.intentId) || command.operationIds.ownerManifest !== operation("owner_manifest", intent.intentId) || command.operationIds.attestation !== operation("attestation", intent.intentId)) throw new Error("INVALID_MANIFEST");
    const recorded = await this.dependencies.store.transact((tx) => tx.getSignedEvent(intent.intentId));
    if (recorded) {
      if (JSON.stringify(recorded) !== JSON.stringify(event)) throw new Error("INVALID_MANIFEST");
      return this.#status(intent);
    }
    const verified = await this.dependencies.verifier.verify({ event, intent });
    if (verified.valid !== true || verified.eventId !== event.id) throw new Error("INVALID_MANIFEST");
    await this.dependencies.store.transact((tx) => tx.putSignedEvent(intent.intentId, event));
    await this.dispatchClaimedPublicationEffects({ intent, event });
    return this.#status(intent);
  }

  async dispatchClaimedPublicationEffects(input: Readonly<{ intent: PublicationIntent; event: Parameters<OwnerEventVerifierPort["verify"]>[0]["event"] }>): Promise<void> {
    await this.#effect(input.intent, "deploy", () => this.dependencies.deployment.deployExact({ operationId: operation("deploy", input.intent.intentId), artifact: input.intent.artifact, signedOwnerManifest: input.event }));
    await this.#effect(input.intent, "owner_manifest", () => this.dependencies.deployment.publishOwnerManifest({ operationId: operation("owner_manifest", input.intent.intentId), event: input.event }));
    await this.#effect(input.intent, "attestation", () => this.dependencies.attestation.publish({ operationId: operation("attestation", input.intent.intentId), artifact: input.intent.artifact, ownerEventId: input.event.id }));
  }

  async observeOriginalPublicationEffects(input: Readonly<{ accountId: string; intentId: string }>): Promise<PublicationServiceStatus> {
    const intent = await this.#intentForOwner(input.accountId, input.intentId);
    const record = await this.dependencies.store.readPublicationStatus(intent.intentId);
    await Promise.all((["deploy", "owner_manifest", "attestation"] as const).map(async (kind) => {
      const effect = record.effects[kind];
      if (!["dispatching", "unknown"].includes(effect.state)) return;
      const observation = kind === "attestation" ? await this.dependencies.attestation.observe?.({ operationId: effect.operationId }) : await this.dependencies.deployment.observe?.({ operationId: effect.operationId });
      if (observation) await this.#recordObserved(kind, effect.operationId, observation);
    }));
    return this.#status(intent);
  }

  async reconcile(input: Readonly<{ accountId: string; intentId: string }>): Promise<PublicationServiceStatus> { return this.observeOriginalPublicationEffects(input); }
  async status(input: Readonly<{ accountId: string; intentId: string }>): Promise<PublicationServiceStatus> { return this.#status(await this.#intentForOwner(input.accountId, input.intentId)); }

  async #effect(intent: PublicationIntent, kind: PublicationEffectKind, invoke: () => Promise<PublicationObservation>): Promise<void> {
    const operationId = operation(kind, intent.intentId);
    const claim = await this.dependencies.store.claimPublicationEffect({ intentId: intent.intentId, effectKind: kind, operationId, requestFingerprintSha256: intent.aggregateSha256 });
    if (!claim.claimed) return;
    try { await this.#recordObserved(kind, operationId, await invoke()); }
    catch { await this.dependencies.store.recordPublicationObservation({ operationId, effectKind: kind, state: "unknown", observationId: `observation:${operationId}:unknown` }); }
  }

  async #recordObserved(kind: PublicationEffectKind, operationId: string, observation: PublicationObservation): Promise<void> {
    if (observation.operationId && observation.operationId !== operationId) throw new Error("PUBLICATION_OBSERVATION_OPERATION_MISMATCH");
    await this.dependencies.store.recordPublicationObservation({ operationId, effectKind: kind, state: durableState(observation.state), observationId: observation.observationId, ...(observation.deploymentId ? { deploymentId: observation.deploymentId } : {}), ...(observation.fullServerUploadId ? { fullServerUploadId: observation.fullServerUploadId } : {}), ...(observation.relayObservation ? { relayObservation: observation.relayObservation } : {}), ...(observation.attestationId ? { attestationId: observation.attestationId } : {}) });
  }

  async #intentForOwner(accountId: string, intentId: string): Promise<PublicationIntent> {
    const intent = await this.dependencies.store.getIntent(intentId);
    if (!intent || intent.accountId !== accountId) throw new Error("PUBLICATION_NOT_FOUND_OR_DENIED");
    if (isPublicationIntentExpired(intent, this.dependencies.clock.nowMs())) throw new Error("INVALID_MANIFEST");
    return intent;
  }

  async #status(intent: PublicationIntent): Promise<PublicationServiceStatus> {
    const [record, event] = await Promise.all([this.dependencies.store.readPublicationStatus(intent.intentId), this.dependencies.store.transact((tx) => tx.getSignedEvent(intent.intentId))]);
    const projected = projectPublicationStatus({ intent, record, ...(event ? { event } : {}) });
    if (!event || (projected.state !== "complete" && projected.state !== "partial")) return projected;
    const deploy = record.effects.deploy.observation;
    const owner = record.effects.owner_manifest.observation;
    const attestation = record.effects.attestation.observation;
    return Object.freeze({
      ...projected,
      status: projected.state,
      artifact: { aggregateSha256: intent.artifact.aggregateSha256, normalizedDTag: intent.artifact.normalizedDTag },
      capabilityDigest: intent.capabilityDigest,
      deploymentId: deploy?.deploymentId,
      fullServerUploadId: deploy?.fullServerUploadId,
      ownerRelayObservation: owner?.relayObservation,
      attestationRelayObservation: attestation?.relayObservation,
    });
  }
}
