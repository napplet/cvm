import { z } from "zod";
import { canonicalJson } from "../promotion/schema";
import { directPublicationDigest } from "../publication/direct-publication";
import { DirectUploadAuthorizationEventSchema } from "../publication/direct-upload-authorization";
import { ReleaseAuthorizationReceiptSchema, validateAuthorizationRequest, validateAuthorizationReceipt } from "../release/authorization";
import { assertPostgresOperationJournal, type PostgresOperationJournal } from "../release/deployment/postgres-operation-journal";
import { DirectUploadScopeSchema, createExactDirectSealedUploadAdapter } from "../release/native/direct-upload";
import { ProductionDirectPublicationIntents } from "./direct-publication-intents";
import { ProductionOwnedDirectArtifacts } from "./owned-direct-artifacts";
import { createProductionDirectCliUploadPort } from "./direct-cli-upload";

const Digest = z.string().regex(/^[a-f0-9]{64}$/u);
const Owner = z.object({ principal: z.object({ pubkey: Digest }).strict(), idempotencyKey: z.string().min(1).max(256) }).strict();
const Binding = z.object({ candidateSha256: Digest, topologySha256: Digest, effectPlanSha256: Digest, accountScopeSha256: Digest, projectScopeSha256: Digest }).strict();
const Context = z.object({ version: z.literal("direct-certification-upload-v1"), reviewSha256: Digest, binding: Binding,
  scope: DirectUploadScopeSchema, authorization: DirectUploadAuthorizationEventSchema }).strict();
const sha = (value: unknown) => new Bun.CryptoHasher("sha256").update(canonicalJson(value)).digest("hex");

/** Certification-only composition. Provider effects require the matching
 * controller receipt; ordinary user publication needs its approved actor.
 * All files, templates and signatures come from concrete owned originals. */
export class ProductionDirectCertificationUpload {
  readonly #owner: z.infer<typeof Owner>;
  readonly #binding: z.infer<typeof Binding>;
  constructor(private readonly input: Readonly<{ intents: ProductionDirectPublicationIntents; artifacts: ProductionOwnedDirectArtifacts;
    owner: z.input<typeof Owner>; binding: z.input<typeof Binding>; targetReference: string;
    authorization: Readonly<{ request: unknown; receipt: unknown }>; journal: PostgresOperationJournal; now?: () => number; timeoutMs?: number }>) {
    if (!(input.intents instanceof ProductionDirectPublicationIntents) || !(input.artifacts instanceof ProductionOwnedDirectArtifacts)) throw new Error("DIRECT_UPLOAD_OWNED_PRODUCER_REQUIRED");
    assertPostgresOperationJournal(input.journal);
    this.#owner = Owner.parse(input.owner); this.#binding = Binding.parse(input.binding);
    z.string().min(1).max(256).parse(input.targetReference);
  }
  async #authority(readOnly: boolean) {
    const request = await validateAuthorizationRequest(this.input.authorization.request), original = ReleaseAuthorizationReceiptSchema.parse(this.input.authorization.receipt);
    const now = (this.input.now ?? Date.now)();
    const receipt = await validateAuthorizationReceipt({ request, receipt: original, nowMs: readOnly ? Math.min(now, original.expiresAtMs - 1) : now });
    const scopes = request.providerScopes.filter(scope => scope.provider === "upload"), effects = request.orderedEffects.filter(effect => effect.provider === "upload");
    if (request.candidateSha256 !== this.#binding.candidateSha256 || request.topologySha256 !== this.#binding.topologySha256 || request.effectPlanSha256 !== this.#binding.effectPlanSha256
      || scopes.length !== 1 || scopes[0]!.accountScopeSha256 !== this.#binding.accountScopeSha256 || scopes[0]!.projectScopeSha256 !== this.#binding.projectScopeSha256
      || effects.length !== 1 || effects[0]!.id !== "sealed-upload" || effects[0]!.operation !== "verify_integration") throw new Error("DIRECT_UPLOAD_PRODUCER_AUTHORIZATION_REQUIRED");
    return { request, receipt };
  }
  async #original() {
    const intent = await this.input.intents.readOriginal(this.#owner);
    if (!intent) throw new Error("DIRECT_PUBLICATION_INTENT_NOT_FOUND_OR_DENIED");
    const owner = await this.input.intents.readAcceptedOwner(this.#owner), authorization = await this.input.intents.readAcceptedUploadAuthorization(this.#owner);
    if (!owner || !authorization) throw new Error("DIRECT_UPLOAD_ACCEPTED_SIGNATURES_REQUIRED");
    const authority = await this.#authority(true), operationId = `direct-upload:${await directPublicationDigest(intent.intentId)}`;
    const expected = Context.parse({ version: "direct-certification-upload-v1", reviewSha256: intent.review.reviewSha256, binding: this.#binding,
      scope: { version: "direct-sealed-upload-v1", operationId, intentReference: intent.intentId,
        candidateSha256: this.#binding.candidateSha256, topologySha256: this.#binding.topologySha256, effectPlanSha256: this.#binding.effectPlanSha256,
        artifactHash: intent.review.artifact.artifactHash, archiveSha256: intent.review.artifact.archiveSha256, ownerManifest: owner.event,
        server: intent.review.servers[0], targetReference: this.input.targetReference, retentionDays: authority.request.artifactRetentionDays, intentExpiresAtMs: intent.expiresAtMs,
        authorizationRequestSha256: authority.request.authorizationRequestSha256, authorizationReceiptSha256: authority.receipt.authorizationReceiptSha256 }, authorization: authorization.event });
    const key = `direct-certification-upload:v1:${await directPublicationDigest(intent.intentId)}`;
    const read = async () => {
      const row = await this.input.journal.read(key); if (!row) return undefined;
      const context = Context.parse(row.value);
      if (row.revision !== 1 || row.identitySha256 !== sha(context) || canonicalJson(context) !== canonicalJson(expected)) throw new Error("DIRECT_UPLOAD_PRODUCER_ORIGINAL_MISMATCH");
      return context;
    };
    return { intent, expected, key, read };
  }
  async #adapter(context: z.infer<typeof Context>) {
    const port = await createProductionDirectCliUploadPort({ server: context.scope.server, targetReference: context.scope.targetReference,
      ownerPubkey: context.scope.ownerManifest.pubkey, binding: context.binding, journal: this.input.journal, timeoutMs: this.input.timeoutMs, now: this.input.now });
    const { authorizationRequestSha256: _request, authorizationReceiptSha256: _receipt, ...base } = context.scope;
    return createExactDirectSealedUploadAdapter({ config: { ...base, accountScopeSha256: context.binding.accountScopeSha256, projectScopeSha256: context.binding.projectScopeSha256 },
      request: this.input.authorization.request, receipt: this.input.authorization.receipt, port, now: this.input.now });
  }
  async reconcile() {
    const original = await this.#original(), context = await original.read();
    if (!context) return { operationId: original.expected.scope.operationId, state: "unknown" as const };
    return (await this.#adapter(context)).reconcileOriginalUpload({ operationId: context.scope.operationId });
  }
  async upload() {
    await this.#authority(false);
    const original = await this.#original();
    await this.input.intents.loadUploadAuthorizationForSigning(this.#owner);
    const owned = await this.input.artifacts.readVerified({ principal: this.#owner.principal, sessionId: original.intent.review.artifact.sessionId, artifactId: original.intent.review.artifact.artifactId });
    if (!owned || owned.archive.checksum !== original.expected.scope.archiveSha256 || owned.archive.artifactHash !== original.expected.scope.artifactHash
      || owned.archive.files.length !== 1 || owned.artifactVersion !== original.intent.review.artifact.artifactVersion
      || owned.archive.verificationEvidenceSha256 !== original.intent.review.artifact.verificationEvidenceSha256) throw new Error("DIRECT_UPLOAD_VERIFIED_ARTIFACT_REQUIRED");
    const file = owned.archive.files[0]!, bytes = new Uint8Array(Buffer.from(file.bytesBase64, "base64"));
    if (file.path !== "index.html" || file.sha256 !== original.expected.scope.artifactHash || bytes.length !== original.intent.review.file.size) throw new Error("DIRECT_UPLOAD_VERIFIED_ARTIFACT_REQUIRED");
    let context = await original.read();
    if (!context) {
      await this.#authority(false);
      await this.input.intents.loadUploadAuthorizationForSigning(this.#owner);
      try { await this.input.journal.claim(original.key, sha(original.expected), original.expected); }
      catch (error) { if (!await original.read()) throw error; }
      context = await original.read();
      if (!context) throw new Error("DIRECT_UPLOAD_PRODUCER_ORIGINAL_MISMATCH");
    }
    return (await this.#adapter(context)).uploadExact({ operationId: context.scope.operationId,
      files: [{ path: "/index.html", mimeType: "text/html", sha256: file.sha256, size: bytes.length, bytes }], authorization: context.authorization });
  }
}
