import { z } from "zod";
import { SimplePool } from "nostr-tools/pool";
import { verifyEvent } from "nostr-tools/pure";
import { canonicalJson } from "../promotion/schema";
import { directPublicationDigest } from "../publication/direct-publication";
import { createDirectCvmBuildAttestation } from "../publication/direct-attestation";
import { SignedOwnerManifestEventSchema } from "../publication/contracts";
import { ReleaseAuthorizationReceiptSchema, validateAuthorizationRequest, validateAuthorizationReceipt } from "../release/authorization";
import { assertPostgresOperationJournal, type PostgresOperationJournal } from "../release/deployment/postgres-operation-journal";
import { ProductionDirectPublicationIntents } from "./direct-publication-intents";
import { ProductionDirectCertificationUpload } from "./direct-publication-upload";
import { ProductionBuildAttestationSigner } from "./attestation-signer";
import { DIRECT_CLI_NETWORK_IDENTITY, loadPinnedDirectCliNetworkHelpers } from "./pinned-direct-cli-network";

const Digest = z.string().regex(/^[a-f0-9]{64}$/u);
const Owner = z.object({ principal: z.object({ pubkey: Digest }).strict(), idempotencyKey: z.string().min(1).max(256) }).strict();
const Binding = z.object({ candidateSha256: Digest, topologySha256: Digest, effectPlanSha256: Digest,
  ownerAccountScopeSha256: Digest, ownerProjectScopeSha256: Digest, attestationAccountScopeSha256: Digest, attestationProjectScopeSha256: Digest }).strict();
const Purpose = z.enum(["owner", "attestation"]);
const Event = SignedOwnerManifestEventSchema.extend({ kind: z.union([z.literal(35129), z.literal(1)]) }).strict();
const Record = z.object({ version: z.literal("direct-certification-relay-v1"), state: z.enum(["prepared", "dispatching"]), purpose: Purpose,
  operationId: z.string().regex(/^direct-(?:owner|attestation)-relay:[a-f0-9]{64}$/u), intentId: z.string(), reviewSha256: Digest,
  artifactHash: Digest, archiveSha256: Digest, ownerEventId: Digest, servicePubkey: Digest, binding: Binding,
  authorizationRequestSha256: Digest, authorizationReceiptSha256: Digest, relays: z.array(z.string().url().max(512)).min(1).max(16),
  helperSha256: z.literal(DIRECT_CLI_NETWORK_IDENTITY.bundleSha256), event: Event }).strict();
const sha = (value: unknown) => new Bun.CryptoHasher("sha256").update(canonicalJson(value)).digest("hex");
const identity = (value: z.infer<typeof Record>) => { const { state: _state, ...body } = value; return sha(body); };

/** Concrete, receipt-gated direct certification publication. No caller event,
 * relay transport or arbitrary signing callback. Ordinary user actor policy
 * remains separate from expiring release authority. */
export class ProductionDirectCertificationRelays {
  readonly #owner: z.infer<typeof Owner>;
  readonly #binding: z.infer<typeof Binding>;
  readonly #timeoutMs: number;
  constructor(private readonly input: Readonly<{ intents: ProductionDirectPublicationIntents; upload: ProductionDirectCertificationUpload;
    owner: z.input<typeof Owner>; binding: z.input<typeof Binding>; signer: ProductionBuildAttestationSigner;
    authorization: Readonly<{ request: unknown; receipt: unknown }>; journal: PostgresOperationJournal; now?: () => number; timeoutMs?: number }>) {
    if (!(input.intents instanceof ProductionDirectPublicationIntents) || !(input.upload instanceof ProductionDirectCertificationUpload)
      || !(input.signer instanceof ProductionBuildAttestationSigner)) throw new Error("DIRECT_RELAY_CONCRETE_PRODUCER_REQUIRED");
    assertPostgresOperationJournal(input.journal);
    this.#owner = Owner.parse(input.owner); this.#binding = Binding.parse(input.binding); this.#timeoutMs = input.timeoutMs ?? 10_000;
    if (!Number.isSafeInteger(this.#timeoutMs) || this.#timeoutMs < 50 || this.#timeoutMs > 60_000) throw new Error("DIRECT_RELAY_TIMEOUT_INVALID");
  }
  async #authority(purpose: z.infer<typeof Purpose>, readOnly: boolean) {
    const request = await validateAuthorizationRequest(this.input.authorization.request), original = ReleaseAuthorizationReceiptSchema.parse(this.input.authorization.receipt);
    const now = (this.input.now ?? Date.now)(), receipt = await validateAuthorizationReceipt({ request, receipt: original, nowMs: readOnly ? Math.min(now, original.expiresAtMs - 1) : now });
    const provider = purpose === "owner" ? "owner_relay" : "attestation_relay", scopes = request.providerScopes.filter(scope => scope.provider === provider), effects = request.orderedEffects.filter(effect => effect.provider === provider);
    if (request.candidateSha256 !== this.#binding.candidateSha256 || request.topologySha256 !== this.#binding.topologySha256 || request.effectPlanSha256 !== this.#binding.effectPlanSha256
      || scopes.length !== 1 || effects.length !== 1 || effects[0]!.id !== (purpose === "owner" ? "owner-relay" : "attestation-relay") || effects[0]!.operation !== "verify_integration"
      || scopes[0]!.accountScopeSha256 !== (purpose === "owner" ? this.#binding.ownerAccountScopeSha256 : this.#binding.attestationAccountScopeSha256)
      || scopes[0]!.projectScopeSha256 !== (purpose === "owner" ? this.#binding.ownerProjectScopeSha256 : this.#binding.attestationProjectScopeSha256)) throw new Error("DIRECT_RELAY_AUTHORIZATION_REQUIRED");
    return { request, receipt };
  }
  async #original(purpose: z.infer<typeof Purpose>) {
    const authority = await this.#authority(purpose, true), intent = await this.input.intents.readOriginal(this.#owner), upload = await this.input.upload.readOriginalBinding();
    if (!intent || !upload) throw new Error("DIRECT_RELAY_ORIGINAL_UPLOAD_REQUIRED");
    if (upload.scope.intentReference !== intent.intentId || upload.reviewSha256 !== intent.review.reviewSha256 || upload.scope.ownerManifest.pubkey !== this.#owner.principal.pubkey
      || upload.scope.authorizationRequestSha256 !== authority.request.authorizationRequestSha256 || upload.scope.authorizationReceiptSha256 !== authority.receipt.authorizationReceiptSha256
      || upload.scope.candidateSha256 !== this.#binding.candidateSha256 || upload.scope.topologySha256 !== this.#binding.topologySha256 || upload.scope.effectPlanSha256 !== this.#binding.effectPlanSha256) throw new Error("DIRECT_RELAY_ORIGINAL_BINDING_REQUIRED");
    const operationId = `direct-${purpose}-relay:${await directPublicationDigest(intent.intentId)}`;
    const body = { version: "direct-certification-relay-v1", purpose, operationId, intentId: intent.intentId, reviewSha256: intent.review.reviewSha256,
      artifactHash: upload.scope.artifactHash, archiveSha256: upload.scope.archiveSha256, ownerEventId: upload.scope.ownerManifest.id, servicePubkey: this.input.signer.publicKey, binding: this.#binding,
      authorizationRequestSha256: authority.request.authorizationRequestSha256, authorizationReceiptSha256: authority.receipt.authorizationReceiptSha256,
      relays: [...intent.review.relays], helperSha256: DIRECT_CLI_NETWORK_IDENTITY.bundleSha256 };
    const attestation = await createDirectCvmBuildAttestation({ version: "direct-cvm-build-attestation-v1", intentId: intent.intentId, reviewSha256: intent.review.reviewSha256,
      ownerEventId: upload.scope.ownerManifest.id, ownerPubkey: intent.review.ownerPubkey, artifact: intent.review.artifact,
      capabilitiesSha256: await directPublicationDigest(intent.review.capabilities), candidateSha256: this.#binding.candidateSha256, topologySha256: this.#binding.topologySha256,
      effectPlanSha256: this.#binding.effectPlanSha256, uploadLocation: `${upload.scope.server}/${upload.scope.artifactHash}`, createdAtMs: intent.createdAtMs });
    const read = async () => {
      const row = await this.input.journal.read(operationId); if (!row) return undefined;
      const record = Record.parse(row.value), { state: _state, event, ...savedBody } = record;
      if (row.identitySha256 !== identity(record) || canonicalJson(savedBody) !== canonicalJson(body) || !verifyEvent(event)) throw new Error("DIRECT_RELAY_ORIGINAL_MISMATCH");
      if (purpose === "owner" ? canonicalJson(event) !== canonicalJson(upload.scope.ownerManifest)
        : event.kind !== 1 || event.pubkey !== this.input.signer.publicKey || event.content !== canonicalJson(attestation) || event.created_at !== Math.floor(attestation.createdAtMs / 1000)
          || canonicalJson(event.tags) !== canonicalJson([["e", attestation.ownerEventId], ["p", attestation.ownerPubkey], ["x", attestation.artifact.artifactHash], ["t", "cvm_build_attestation"], ["v", attestation.version]])) throw new Error("DIRECT_RELAY_EVENT_BINDING_REQUIRED");
      return { row, record };
    };
    return { intent, upload, body, attestation, read };
  }
  async #observe(record: z.infer<typeof Record>) {
    const pool = new SimplePool(); let timer: ReturnType<typeof setTimeout> | undefined;
    try {
      const events = await Promise.race([pool.querySync(record.relays, { ids: [record.event.id], authors: [record.event.pubkey], limit: 1 }, { maxWait: this.#timeoutMs }),
        new Promise<never>((_, reject) => { timer = setTimeout(() => reject(new Error("DIRECT_RELAY_QUERY_TIMEOUT")), this.#timeoutMs); })]);
      return { operationId: record.operationId, eventId: record.event.id, state: events.some(event => event.id === record.event.id && verifyEvent(event)) ? "complete" as const : "unknown" as const };
    } catch { return { operationId: record.operationId, eventId: record.event.id, state: "unknown" as const }; }
    finally { clearTimeout(timer); pool.destroy(); }
  }
  async #prerequisites(purpose: z.infer<typeof Purpose>) {
    if ((await this.input.upload.reconcile()).state !== "complete") throw new Error("DIRECT_RELAY_VERIFIED_UPLOAD_REQUIRED");
    if (purpose === "attestation" && (await this.reconcileOwner()).state !== "complete") throw new Error("DIRECT_RELAY_OWNER_OBSERVATION_REQUIRED");
  }
  async #publish(purpose: z.infer<typeof Purpose>) {
    const original = await this.#original(purpose); let stored = await original.read();
    if (stored?.record.state === "dispatching") return this.#observe(stored.record);
    await this.#prerequisites(purpose);
    const fresh = async () => { await this.input.intents.loadCurrentForSigning(this.#owner); await this.#authority(purpose, false); };
    await fresh();
    if (!stored) {
      const event = purpose === "owner" ? original.upload.scope.ownerManifest : await this.input.signer.signDirectBuild(original.attestation);
      const record = Record.parse({ ...original.body, state: "prepared", event });
      await fresh();
      try { await this.input.journal.claim(record.operationId, identity(record), record); }
      catch (error) { if (!await original.read()) throw error; }
      stored = await original.read();
      if (!stored) throw new Error("DIRECT_RELAY_PERSISTENCE_REQUIRED");
    }
    const observed = await this.#observe(stored.record);
    if (observed.state === "complete" || stored.record.state === "dispatching") return observed;
    await fresh();
    const dispatch = await this.input.journal.compareAndSet(stored.record.operationId, stored.row.identitySha256, stored.row.revision, { ...stored.record, state: "dispatching" });
    if (!dispatch) return this.#observe(stored.record);
    const helper = await loadPinnedDirectCliNetworkHelpers();
    await fresh();
    // Await the actual helper's bounded lifecycle. An outer timeout would
    // leave an uncancelled publish running after the caller reported timeout.
    try { await helper.publishEventWithSimplePool(stored.record.relays, stored.record.event); }
    catch { /* original ID observation only; the dispatch fence is permanent */ }
    return this.#observe(stored.record);
  }
  async #reconcile(purpose: z.infer<typeof Purpose>) {
    const original = await this.#original(purpose), stored = await original.read();
    return stored ? this.#observe(stored.record) : { operationId: original.body.operationId, state: "unknown" as const };
  }
  publishOwner() { return this.#publish("owner"); }
  publishAttestation() { return this.#publish("attestation"); }
  reconcileOwner() { return this.#reconcile("owner"); }
  reconcileAttestation() { return this.#reconcile("attestation"); }
  async #run(readOnly: boolean) {
    const upload = await (readOnly ? this.input.upload.reconcile() : this.input.upload.upload());
    if (upload.state !== "complete") return { state: "partial" as const, stage: "upload" as const };
    const owner = await (readOnly ? this.reconcileOwner() : this.publishOwner());
    if (owner.state !== "complete") return { state: "partial" as const, stage: "owner" as const };
    const attestation = await (readOnly ? this.reconcileAttestation() : this.publishAttestation());
    if (attestation.state !== "complete") return { state: "partial" as const, stage: "attestation" as const };
    const original = await this.#original("owner");
    if (upload.fullServerUploadId !== `${original.upload.scope.server}/${original.upload.scope.artifactHash}` || owner.eventId !== original.upload.scope.ownerManifest.id) throw new Error("DIRECT_PUBLICATION_COMPLETION_BINDING_REQUIRED");
    return { state: "complete" as const, artifactHash: original.upload.scope.artifactHash, archiveSha256: original.upload.scope.archiveSha256,
      locationReference: upload.fullServerUploadId, ownerEventId: owner.eventId, attestationEventId: attestation.eventId };
  }
  /** These are publication-operation observations, never release certification. */
  publish() { return this.#run(false); }
  reconcile() { return this.#run(true); }
}
