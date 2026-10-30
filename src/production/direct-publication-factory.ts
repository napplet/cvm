import { z } from "zod";
import { canonicalJson } from "../promotion/schema";
import { DirectPublicationIntentSchema } from "../publication/direct-publication";
import { ReleaseAuthorizationReceiptSchema, validateAuthorizationRequest, validateAuthorizationReceipt } from "../release/authorization";
import { assertPostgresOperationJournal, type PostgresOperationJournal } from "../release/deployment/postgres-operation-journal";
import { ProductionWorkerPublicationSchema } from "../worker-adapters/publication-metadata";
import { ProductionDirectPublicationIntents } from "./direct-publication-intents";
import { ProductionOwnedDirectArtifacts } from "./owned-direct-artifacts";
import { ProductionDirectCertificationUpload } from "./direct-publication-upload";
import { ProductionDirectCertificationRelays } from "./direct-publication-relays";
import { openProductionDirectCertificationNip46Signer } from "./direct-nip46-signer";
import type { createMountedProductionEdgeMaterial } from "./mounted-edge-material";
import { requireDirectToolchainReceipt } from "../worker-adapters/direct-toolchain-receipt";
import { loadPinnedDirectCliNetworkHelpers } from "./pinned-direct-cli-network";

const Digest = z.string().regex(/^[a-f0-9]{64}$/u);
const Settings = z.object({ artifactContract: z.literal("nip5d-direct-v1"), candidateSha256: Digest, topologySha256: Digest,
  ownerPubkey: Digest, toolchainSha256: Digest, policyVersion: z.string().min(1).max(256),
  server: ProductionWorkerPublicationSchema.shape.server, relays: DirectPublicationIntentSchema.shape.review.shape.relays,
  targetReference: z.string().min(1).max(256), sessionKeyReference: z.string().min(1).max(256) }).strict();
const Open = z.object({ principal: z.object({ pubkey: Digest }).strict(), idempotencyKey: z.string().min(1).max(256),
  intentId: DirectPublicationIntentSchema.shape.intentId, reviewSha256: Digest }).strict();
type Input = Readonly<{ settings: z.input<typeof Settings>; intents: ProductionDirectPublicationIntents; artifacts: ProductionOwnedDirectArtifacts;
  journals: Readonly<{ signer: PostgresOperationJournal; upload: PostgresOperationJournal; relay: PostgresOperationJournal }>;
  material: Pick<Awaited<ReturnType<typeof createMountedProductionEdgeMaterial>>, "bunkerUri" | "nip46SessionKeyBroker" | "attestationSigner">;
  authorization: Readonly<{ request: unknown; receipt: unknown; authorizationRequestSha256: string; authorizationReceiptSha256: string }>;
  now?: () => number; timeoutMs?: number }>;

/** Mounted certification graph only. Existing owner consent prepares the
 * original intent elsewhere; opening never invents consent or signs/publishes.
 * Real private material stays behind capabilities and private class fields. */
export class ProductionDirectPublicationFactory {
  readonly #input: Input;
  readonly #settings: z.infer<typeof Settings>;
  readonly #actors = new Set<{ close(): Promise<void> }>();
  #opening = 0;
  #closed = false;
  constructor(input: Input) {
    if (!(input.intents instanceof ProductionDirectPublicationIntents) || !(input.artifacts instanceof ProductionOwnedDirectArtifacts)) throw new Error("DIRECT_PUBLICATION_CONCRETE_DEPENDENCIES_REQUIRED");
    for (const journal of Object.values(input.journals)) assertPostgresOperationJournal(journal);
    this.#settings = Settings.parse(input.settings); this.#input = input;
  }
  async open(value: unknown) {
    if (this.#closed) throw new Error("DIRECT_PUBLICATION_FACTORY_CLOSED");
    if (this.#actors.size + this.#opening >= 32) throw new Error("DIRECT_PUBLICATION_ACTOR_LIMIT");
    const command = Open.parse(value), owner = { principal: command.principal, idempotencyKey: command.idempotencyKey };
    if (command.principal.pubkey !== this.#settings.ownerPubkey) throw new Error("DIRECT_PUBLICATION_CONFIGURED_OWNER_REQUIRED");
    this.#opening++;
    try {
      const request = await validateAuthorizationRequest(this.#input.authorization.request), original = ReleaseAuthorizationReceiptSchema.parse(this.#input.authorization.receipt);
      const receipt = await validateAuthorizationReceipt({ request, receipt: original, nowMs: Math.min((this.#input.now ?? Date.now)(), original.expiresAtMs - 1) });
      if (request.authorizationRequestSha256 !== this.#input.authorization.authorizationRequestSha256 || receipt.authorizationReceiptSha256 !== this.#input.authorization.authorizationReceiptSha256
        || request.candidateSha256 !== this.#settings.candidateSha256 || request.topologySha256 !== this.#settings.topologySha256) throw new Error("DIRECT_PUBLICATION_FACTORY_AUTHORIZATION_REQUIRED");
      const scope = (provider: "signer" | "upload" | "owner_relay" | "attestation_relay") => {
        const scopes = request.providerScopes.filter(item => item.provider === provider);
        if (scopes.length !== 1) throw new Error("DIRECT_PUBLICATION_FACTORY_SCOPE_REQUIRED");
        return scopes[0]!;
      };
      scope("signer"); const uploadScope = scope("upload"), ownerScope = scope("owner_relay"), attestationScope = scope("attestation_relay");
      const intent = await this.#input.intents.readOriginal(owner);
      if (!intent || intent.intentId !== command.intentId || intent.review.reviewSha256 !== command.reviewSha256) throw new Error("DIRECT_PUBLICATION_APPROVED_ORIGINAL_REQUIRED");
      if (intent.review.ownerPubkey !== this.#settings.ownerPubkey || intent.review.artifact.toolchainSha256 !== this.#settings.toolchainSha256 || intent.review.artifact.policyVersion !== this.#settings.policyVersion
        || intent.review.servers[0] !== this.#settings.server || canonicalJson(intent.review.relays) !== canonicalJson(this.#settings.relays)) throw new Error("DIRECT_PUBLICATION_CONFIGURED_ARTIFACT_REQUIRED");
      const base = { candidateSha256: request.candidateSha256, topologySha256: request.topologySha256, effectPlanSha256: request.effectPlanSha256 };
      const upload = new ProductionDirectCertificationUpload({ intents: this.#input.intents, artifacts: this.#input.artifacts, owner,
        binding: { ...base, accountScopeSha256: uploadScope.accountScopeSha256, projectScopeSha256: uploadScope.projectScopeSha256 },
        targetReference: this.#settings.targetReference, authorization: this.#input.authorization, journal: this.#input.journals.upload, now: this.#input.now, timeoutMs: this.#input.timeoutMs });
      const relays = new ProductionDirectCertificationRelays({ intents: this.#input.intents, upload, owner,
        binding: { ...base, ownerAccountScopeSha256: ownerScope.accountScopeSha256, ownerProjectScopeSha256: ownerScope.projectScopeSha256,
          attestationAccountScopeSha256: attestationScope.accountScopeSha256, attestationProjectScopeSha256: attestationScope.projectScopeSha256 },
        signer: this.#input.material.attestationSigner, authorization: this.#input.authorization, journal: this.#input.journals.relay, now: this.#input.now, timeoutMs: this.#input.timeoutMs });
      const signer = await openProductionDirectCertificationNip46Signer({ intents: this.#input.intents, owner, bunkerUri: this.#input.material.bunkerUri,
        sessionKeyReference: this.#settings.sessionKeyReference, sessionKeyBroker: this.#input.material.nip46SessionKeyBroker, journal: this.#input.journals.signer,
        authorization: this.#input.authorization, now: this.#input.now, timeoutMs: this.#input.timeoutMs });
      if (this.#closed) { await signer.close(); throw new Error("DIRECT_PUBLICATION_FACTORY_CLOSED"); }
      let closed = false;
      const check = () => { if (closed || this.#closed) throw new Error("DIRECT_PUBLICATION_ACTOR_CLOSED"); };
      const actor = Object.freeze({
        source: async () => {
          check();
          const owned = await this.#input.artifacts.readVerified({ principal: owner.principal, sessionId: intent.review.artifact.sessionId, artifactId: intent.review.artifact.artifactId });
          if (!owned || owned.archive.checksum !== intent.review.artifact.archiveSha256 || owned.archive.artifactHash !== intent.review.artifact.artifactHash
            || owned.archive.build.toolchainSha256 !== intent.review.artifact.toolchainSha256 || owned.archive.verificationEvidenceSha256 !== intent.review.artifact.verificationEvidenceSha256) throw new Error("DIRECT_PUBLICATION_SOURCE_ARTIFACT_REQUIRED");
          const toolchain = requireDirectToolchainReceipt(owned.archive.receipts.toolchain), helper = await loadPinnedDirectCliNetworkHelpers();
          return Object.freeze({ status: "verified-source-bytes" as const, artifactContract: "nip5d-direct-v1" as const,
            candidateSha256: request.candidateSha256, topologySha256: request.topologySha256, artifactHash: owned.archive.artifactHash,
            archiveSha256: owned.archive.checksum, toolchainSha256: owned.archive.build.toolchainSha256,
            toolchain, helper: helper.identity, productionPromotion: "not_asserted" as const });
        },
        async requestOwnerSignature() { check(); return signer.signOwnerManifest(); },
        async requestUploadSignature() { check(); return signer.signUploadAuthorization(); },
        async observeOwnerSignature() { check(); return signer.observeOwnerSignature(); },
        async observeUploadSignature() { check(); return signer.observeUploadSignature(); },
        prepareUploadAuthorization: async () => { check(); return this.#input.intents.prepareUploadAuthorization(owner); },
        acceptOwnerEvent: async (event: unknown) => { check(); return this.#input.intents.acceptOwnerEvent({ ...owner, event }); },
        acceptUploadAuthorization: async (event: unknown) => { check(); return this.#input.intents.acceptUploadAuthorization({ ...owner, event }); },
        async publishOwner() { check(); return relays.publishOwner(); },
        async publishAttestation() { check(); return relays.publishAttestation(); },
        async publish() { check(); return relays.publish(); },
        async reconcile() { check(); return relays.reconcile(); },
        close: async () => { if (closed) return; closed = true; this.#actors.delete(actor); await signer.close(); },
      });
      this.#actors.add(actor); return actor;
    } finally { this.#opening--; }
  }
  async close() { this.#closed = true; await Promise.all([...this.#actors].map(actor => actor.close())); }
}
