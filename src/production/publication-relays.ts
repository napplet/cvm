import { verifyEvent } from "nostr-tools/pure";
import { z } from "zod";
import { canonicalJson } from "../promotion/schema";
import { SignedOwnerManifestEventSchema } from "../publication/contracts";
import { buildCvmAttestation } from "../publication/attestation-event";
import { ReleaseAuthorizationReceiptSchema, validateAuthorizationRequest, validateAuthorizationReceipt } from "../release/authorization";
import { createNostrRelayPublicationAdapter, type NostrRelayPublicationAdapter, type NostrRelayPort } from "../release/native/nostr-relay";
import { assertPostgresOperationJournal, type PostgresOperationJournal } from "../release/deployment/postgres-operation-journal";
import { ProductionPublicationContextMaterializer } from "./publication-context";
import { ProductionBuildAttestationSigner } from "./attestation-signer";
import type { ProductionGenerationRuntime } from "./generation-runtime";

const Digest = z.string().regex(/^[a-f0-9]{64}$/u);
const AttestationEvent = SignedOwnerManifestEventSchema.extend({ kind: z.literal(1) });
const RecordSchema = z.object({
  state: z.enum(["preparing", "signed"]), candidateSha256: Digest, topologySha256: Digest, authorizationRequestSha256: Digest,
  intentFingerprint: Digest, relaySetReference: z.string().min(1).max(256), relaySetSha256: Digest,
  ownerEvent: SignedOwnerManifestEventSchema, attestationEvent: AttestationEvent.optional(),
}).strict();
const sha = (value: unknown) => new Bun.CryptoHasher("sha256").update(canonicalJson(value)).digest("hex");

/** Defers event-dependent configuration until the actual owner signature is
 * available. SQL retains exact public events; recovery never signs or sends a
 * replacement. All network publication uses the existing pinned CLI port. */
export function createProductionPublicationRelays(input: Readonly<{
  materializer: ProductionPublicationContextMaterializer;
  attestationSigner: ProductionBuildAttestationSigner;
  authorization: ProductionGenerationRuntime["authorization"];
  journal: PostgresOperationJournal; port: NostrRelayPort;
  relaySetReference: string; relaySetSha256: string; now?: () => number;
}>): NostrRelayPublicationAdapter {
  if (!(input.materializer instanceof ProductionPublicationContextMaterializer) || !(input.attestationSigner instanceof ProductionBuildAttestationSigner)) throw new Error("PRODUCTION_PUBLICATION_RELAY_AUTHORITY_REQUIRED");
  assertPostgresOperationJournal(input.journal); Digest.parse(input.relaySetSha256);
  const now = input.now ?? Date.now;
  const resolve = async (ownerInput?: Parameters<NostrRelayPublicationAdapter["publishOwnerManifest"]>[0]) => {
    const context = await input.materializer.materialize();
    // This sealed certification source plan has one initial build. Revision
    // session versions must come from a future durable session contract.
    if (context.artifact.artifactVersion !== 1) throw new Error("PRODUCTION_PUBLICATION_INITIAL_BUILD_REQUIRED");
    if (ownerInput && (ownerInput.operationId !== `owner_manifest:${context.intent.intentId}` || canonicalJson([...ownerInput.relays].sort()) !== canonicalJson([...context.relaySet].sort()))) throw new Error("PRODUCTION_PUBLICATION_RELAY_OPERATION_REQUIRED");
    const request = await validateAuthorizationRequest(input.authorization.request);
    const receipt = ReleaseAuthorizationReceiptSchema.parse(input.authorization.receipt);
    const authorize = async (readOnly: boolean) => {
      const validated = await validateAuthorizationReceipt({ request, receipt, nowMs: readOnly ? Math.min(now(), receipt.expiresAtMs - 1) : now() });
      if (request.authorizationRequestSha256 !== input.authorization.authorizationRequestSha256 || validated.authorizationReceiptSha256 !== input.authorization.authorizationReceiptSha256
        || (!readOnly && now() >= context.intent.expiresAtMs)) throw new Error("PRODUCTION_PUBLICATION_RELAY_AUTHORIZATION_REQUIRED");
      for (const [provider, id] of [["owner_relay", "owner-relay"], ["attestation_relay", "attestation-relay"]] as const) {
        const effects = request.orderedEffects.filter(effect => effect.provider === provider);
        if (effects.length !== 1 || effects[0]!.id !== id || effects[0]!.operation !== "verify_integration" || request.providerScopes.filter(scope => scope.provider === provider).length !== 1) throw new Error("PRODUCTION_PUBLICATION_RELAY_SCOPE_REQUIRED");
      }
    };
    await authorize(true);
    const binding = { candidateSha256: request.candidateSha256, topologySha256: request.topologySha256,
      authorizationRequestSha256: request.authorizationRequestSha256, intentFingerprint: context.intentDigest,
      relaySetReference: input.relaySetReference, relaySetSha256: input.relaySetSha256 };
    const key = `publication-relays:${sha(binding)}`;
    let saved = await input.journal.read(key);
    const originalOwner = ownerInput === undefined ? saved && RecordSchema.parse(saved.value).ownerEvent : SignedOwnerManifestEventSchema.parse(ownerInput.event);
    if (!originalOwner) throw new Error("PRODUCTION_PUBLICATION_RELAY_ORIGINAL_UNAVAILABLE");
    const verified = await input.materializer.ownerEventVerifier.verify({ event: originalOwner, intent: context.intent });
    if (!verified.valid || verified.accepted === false || verified.eventId !== originalOwner.id) throw new Error("PRODUCTION_PUBLICATION_RELAY_OWNER_INVALID");
    if (originalOwner.pubkey === input.attestationSigner.publicKey) throw new Error("PRODUCTION_ATTESTATION_OWNER_KEY_REJECTED");
    const identity = sha({ ...binding, ownerEvent: originalOwner });
    if (!saved) {
      await authorize(false);
      const claimed = await input.journal.claim(key, identity, { ...binding, state: "preparing", ownerEvent: originalOwner });
      saved = claimed.record;
      if (claimed.claimed) {
        await authorize(false);
        const attestation = buildCvmAttestation({ ownerEventId: originalOwner.id, ownerPubkey: originalOwner.pubkey, artifact: context.artifact,
          sessionVersion: 1, policyVersion: context.artifact.policyIdentity, toolchainIdentity: context.artifact.toolchainIdentity,
          verificationEvidenceReference: `sha256:${context.artifact.verificationEvidenceSha256}`, createdAtMs: context.intent.createdAtMs });
        const attestationEvent = input.attestationSigner.signBuild(attestation);
        const completed = await input.journal.compareAndSet(key, identity, saved.revision, { ...binding, state: "signed", ownerEvent: originalOwner, attestationEvent });
        saved = completed ?? await input.journal.read(key);
      }
    }
    if (!saved || saved.identitySha256 !== identity) throw new Error("PRODUCTION_PUBLICATION_RELAY_ORIGINAL_CHANGED");
    const record = RecordSchema.parse(saved.value);
    const { state: _state, attestationEvent, ownerEvent, ...storedBinding } = record;
    if (canonicalJson(storedBinding) !== canonicalJson(binding) || canonicalJson(ownerEvent) !== canonicalJson(originalOwner)) throw new Error("PRODUCTION_PUBLICATION_RELAY_ORIGINAL_CHANGED");
    if (record.state !== "signed" || !attestationEvent) throw new Error("PRODUCTION_PUBLICATION_RELAY_SIGNING_UNKNOWN");
    const attestation = buildCvmAttestation({ ownerEventId: ownerEvent.id, ownerPubkey: ownerEvent.pubkey, artifact: context.artifact,
      sessionVersion: 1, policyVersion: context.artifact.policyIdentity, toolchainIdentity: context.artifact.toolchainIdentity,
      verificationEvidenceReference: `sha256:${context.artifact.verificationEvidenceSha256}`, createdAtMs: context.intent.createdAtMs });
    if (!verifyEvent(attestationEvent) || attestationEvent.pubkey !== input.attestationSigner.publicKey || attestationEvent.pubkey === ownerEvent.pubkey
      || attestationEvent.created_at !== Math.floor(attestation.createdAtMs / 1000) || attestationEvent.content !== canonicalJson(attestation)
      || canonicalJson(attestationEvent.tags) !== canonicalJson([["e", ownerEvent.id], ["p", ownerEvent.pubkey], ["x", context.artifact.aggregateSha256], ["t", "cvm_build_attestation"]])) throw new Error("PRODUCTION_PUBLICATION_ATTESTATION_INVALID");
    const ownerScope = request.providerScopes.find(scope => scope.provider === "owner_relay")!;
    const attestationScope = request.providerScopes.find(scope => scope.provider === "attestation_relay")!;
    const adapter = createNostrRelayPublicationAdapter({ request, receipt, port: input.port, now,
      config: { candidateSha256: request.candidateSha256, topologySha256: request.topologySha256, effectPlanSha256: request.effectPlanSha256,
        ownerAccountScopeSha256: ownerScope.accountScopeSha256, ownerProjectScopeSha256: ownerScope.projectScopeSha256,
        attestationAccountScopeSha256: attestationScope.accountScopeSha256, attestationProjectScopeSha256: attestationScope.projectScopeSha256,
        intentId: context.intent.intentId, sealedArtifactSha256: context.artifact.sealedObjectSha256, aggregateSha256: context.artifact.aggregateSha256,
        relaySetReference: input.relaySetReference, relaySetSha256: input.relaySetSha256, relays: context.relaySet, ownerEvent, attestationEvent,
        ownerSignerPubkey: ownerEvent.pubkey, attestationSignerPubkey: attestationEvent.pubkey, intentExpiresAtMs: context.intent.expiresAtMs } });
    return { adapter, context, ownerEvent, attestation };
  };
  const publication: NostrRelayPublicationAdapter = Object.freeze<NostrRelayPublicationAdapter>({
    async publishOwnerManifest(value) { return (await resolve(value)).adapter.publishOwnerManifest(value); },
    async publishAttestation(value) {
      const { adapter, context, attestation } = await resolve();
      const owner = await adapter.reconcileOriginalEvent({ operationId: `owner_manifest:${context.intent.intentId}` });
      if (owner.state !== "completed") throw new Error("PRODUCTION_PUBLICATION_OWNER_NOT_OBSERVED");
      const observed = await adapter.publishAttestation(value);
      return { ...observed, ...(observed.state === "completed" ? { attestationId: attestation.attestationId } : {}) };
    },
    async reconcileOriginalEvent(value) { return (await resolve()).adapter.reconcileOriginalEvent(value); },
    asPromotedCliSource() { return Object.freeze({
      async publishOriginalEvent(value: Parameters<NostrRelayPublicationAdapter["publishOwnerManifest"]>[0]) {
        const observed = await publication.publishOwnerManifest(value);
        return { operationId: observed.operationId, state: observed.state === "completed" ? "complete" as const : observed.state === "failed" ? "failed" as const : "unknown" as const, relayObservation: observed.relayObservation };
      },
      async reconcileOriginalEvent(value: Readonly<{ operationId: string }>) {
        const observed = await publication.reconcileOriginalEvent(value);
        return { operationId: observed.operationId, state: observed.state === "completed" ? "complete" as const : observed.state === "failed" ? "failed" as const : "unknown" as const, relayObservation: observed.relayObservation };
      },
    }); },
    attestationPort: Object.freeze<NostrRelayPublicationAdapter["attestationPort"]>({
      async publish(value) {
        const { adapter, context, attestation } = await resolve();
        const owner = await adapter.reconcileOriginalEvent({ operationId: `owner_manifest:${context.intent.intentId}` });
        if (owner.state !== "completed") throw new Error("PRODUCTION_PUBLICATION_OWNER_NOT_OBSERVED");
        const observed = await adapter.attestationPort.publish(value);
        return { ...observed, ...(observed.state === "completed" ? { attestationId: attestation.attestationId } : {}) };
      },
      async observe(value) {
        const { adapter, attestation } = await resolve();
        const observed = await adapter.attestationPort.observe(value);
        return { ...observed, ...(observed.state === "completed" ? { attestationId: attestation.attestationId } : {}) };
      },
    }),
  });
  return publication;
}
