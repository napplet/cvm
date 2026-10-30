import { z } from "zod";
import { accountIdForPrincipal } from "../domain/account-command";
import { createDirectPublicationReview, DirectPublicationIntentSchema, DirectPublicationReviewSchema, directPublicationDigest,
  validateDirectPublicationIntent, verifyDirectPublicationOwnerEvent } from "../publication/direct-publication";
import { SignedOwnerManifestEventSchema } from "../publication/contracts";
import { assertPostgresOperationJournal, type PostgresOperationJournal } from "../release/deployment/postgres-operation-journal";
import { ProductionWorkerPublicationSchema } from "../worker-adapters/publication-metadata";
import { ProductionOwnedDirectArtifacts } from "./owned-direct-artifacts";

const Identifier = z.string().min(1).max(256);
const Principal = z.object({ pubkey: z.string().regex(/^[a-f0-9]{64}$/u) }).strict();
const Owned = z.object({ principal: Principal, idempotencyKey: Identifier }).strict();
const Artifact = z.object({ principal: Principal, sessionId: Identifier, artifactId: z.string().regex(/^artifact:[a-f0-9]{64}$/u) }).strict();
const Prepare = Artifact.extend({ idempotencyKey: Identifier, approval: z.object({ consent: z.literal("approved"), reviewSha256: z.string().regex(/^[a-f0-9]{64}$/u) }).strict() }).strict();
const IntentRecord = z.object({ accountId: z.string().regex(/^account:[a-f0-9]{64}$/u), requestSha256: z.string().regex(/^[a-f0-9]{64}$/u), intent: DirectPublicationIntentSchema }).strict();
const OwnerRecord = z.object({ version: z.literal("direct-publication-owner-v1"), intentId: DirectPublicationIntentSchema.shape.intentId,
  reviewSha256: DirectPublicationReviewSchema.shape.reviewSha256, event: SignedOwnerManifestEventSchema }).strict();

/** Ordinary owner publication preparation only. Durable original intents and
 * completed public signatures grant no upload, relay or service-signing effect. */
export class ProductionDirectPublicationIntents {
  readonly #server: string;
  readonly #relays: readonly string[];
  constructor(private readonly input: Readonly<{ artifacts: ProductionOwnedDirectArtifacts; journal: PostgresOperationJournal; publication: z.input<typeof ProductionWorkerPublicationSchema>; relays: readonly string[]; now?: () => number }>) {
    if (!(input.artifacts instanceof ProductionOwnedDirectArtifacts)) throw new Error("PRODUCTION_OWNED_ARTIFACT_READER_REQUIRED");
    assertPostgresOperationJournal(input.journal);
    this.#server = ProductionWorkerPublicationSchema.parse(input.publication).server;
    this.#relays = Object.freeze(DirectPublicationReviewSchema.shape.relays.parse([...input.relays]));
    if (new Set(this.#relays).size !== this.#relays.length) throw new Error("DIRECT_PUBLICATION_RELAY_SET_REQUIRED");
  }
  async #key(command: z.infer<typeof Owned>) {
    const accountId = await accountIdForPrincipal(command.principal);
    return { accountId, operationId: `direct-publication-intent:v1:${await directPublicationDigest({ accountId, idempotencyKey: command.idempotencyKey })}` };
  }
  async #original(command: z.infer<typeof Owned>) {
    const key = await this.#key(command), row = await this.input.journal.read(key.operationId);
    if (!row) return undefined;
    const record = IntentRecord.parse(row.value), intent = await validateDirectPublicationIntent(record.intent);
    if (row.revision !== 1 || row.identitySha256 !== await directPublicationDigest(record) || record.accountId !== key.accountId
      || intent.review.ownerPubkey !== command.principal.pubkey || intent.idempotencyKey !== command.idempotencyKey || intent.requestSha256 !== record.requestSha256) throw new Error("DIRECT_PUBLICATION_ORIGINAL_MISMATCH");
    return record;
  }
  async review(value: unknown) {
    const command = Artifact.parse(value), owned = await this.input.artifacts.readVerified(command);
    if (!owned) throw new Error("DIRECT_PUBLICATION_ARTIFACT_NOT_FOUND_OR_DENIED");
    const file = owned.archive.files[0]!;
    return createDirectPublicationReview({ version: "direct-publication-review-v1", ownerPubkey: command.principal.pubkey,
      artifact: { sessionId: owned.sessionId, artifactId: owned.artifactId, artifactVersion: owned.artifactVersion,
        artifactHash: owned.archive.artifactHash, archiveSha256: owned.archive.checksum, verificationEvidenceSha256: owned.archive.verificationEvidenceSha256,
        conformanceReceiptSha256: owned.archive.receipts.conformance.sha256, manifestReceiptSha256: owned.archive.receipts.manifest.sha256,
        policyVersion: owned.policyVersion, toolchainSha256: owned.archive.build.toolchainSha256 },
      file: { path: "/index.html", mimeType: "text/html", sha256: file.sha256, size: file.bytes },
      capabilities: owned.archive.declaration, ownerManifestTemplate: owned.archive.manifest, servers: [this.#server], relays: [...this.#relays] });
  }
  async prepare(value: unknown) {
    const command = Prepare.parse(value), identity = Owned.parse({ principal: command.principal, idempotencyKey: command.idempotencyKey }), requestSha256 = await directPublicationDigest(command);
    const original = await this.#original(identity);
    if (original) {
      if (original.requestSha256 !== requestSha256) throw new Error("DIRECT_PUBLICATION_IDEMPOTENCY_CONFLICT");
      return original.intent;
    }
    const review = await this.review({ principal: command.principal, sessionId: command.sessionId, artifactId: command.artifactId });
    if (review.reviewSha256 !== command.approval.reviewSha256) throw new Error("DIRECT_PUBLICATION_APPROVAL_REQUIRED");
    const createdAtMs = (this.input.now ?? Date.now)(), seed = { version: "direct-publication-intent-v1", idempotencyKey: command.idempotencyKey, requestSha256, review, createdAtMs, expiresAtMs: createdAtMs + 1_800_000 };
    const intent = await validateDirectPublicationIntent({ ...seed, intentId: `direct-publication:${await directPublicationDigest(seed)}` }), key = await this.#key(identity);
    const record = IntentRecord.parse({ accountId: key.accountId, requestSha256, intent });
    try { await this.input.journal.claim(key.operationId, await directPublicationDigest(record), record); }
    catch (error) {
      // Concurrent claims and a lost COMMIT acknowledgement observe the exact
      // original winner; no signing/provider effect or replacement is issued.
      const winner = await this.#original(identity);
      if (!winner || winner.requestSha256 !== requestSha256) throw error;
      return winner.intent;
    }
    const winner = await this.#original(identity);
    if (!winner || winner.requestSha256 !== requestSha256) throw new Error("DIRECT_PUBLICATION_ORIGINAL_MISMATCH");
    return winner.intent;
  }
  async readOriginal(value: unknown) { return (await this.#original(Owned.parse(value)))?.intent; }
  async loadCurrentForSigning(value: unknown) {
    const command = Owned.parse(value), original = await this.#original(command);
    if (!original) throw new Error("DIRECT_PUBLICATION_INTENT_NOT_FOUND_OR_DENIED");
    const now = (this.input.now ?? Date.now)();
    if (now < original.intent.createdAtMs - 5000 || now >= original.intent.expiresAtMs) throw new Error("DIRECT_PUBLICATION_INTENT_EXPIRED");
    const review = await this.review({ principal: command.principal, sessionId: original.intent.review.artifact.sessionId, artifactId: original.intent.review.artifact.artifactId });
    if (review.reviewSha256 !== original.intent.review.reviewSha256) throw new Error("DIRECT_PUBLICATION_INTENT_STALE");
    return original.intent;
  }
  async #owner(intent: z.infer<typeof DirectPublicationIntentSchema>) {
    const key = `direct-publication-owner:v1:${await directPublicationDigest(intent.intentId)}`, row = await this.input.journal.read(key);
    if (!row) return undefined;
    const record = OwnerRecord.parse(row.value);
    if (row.revision !== 1 || row.identitySha256 !== await directPublicationDigest(record) || record.intentId !== intent.intentId || record.reviewSha256 !== intent.review.reviewSha256) throw new Error("DIRECT_PUBLICATION_OWNER_RECORD_MISMATCH");
    await verifyDirectPublicationOwnerEvent({ intent, event: record.event });
    return record;
  }
  async readAcceptedOwner(value: unknown) {
    const original = await this.#original(Owned.parse(value));
    return original ? this.#owner(original.intent) : undefined;
  }
  async acceptOwnerEvent(value: unknown) {
    const command = Owned.extend({ event: SignedOwnerManifestEventSchema }).strict().parse(value), owned = { principal: command.principal, idempotencyKey: command.idempotencyKey };
    const original = await this.#original(owned);
    if (!original) throw new Error("DIRECT_PUBLICATION_INTENT_NOT_FOUND_OR_DENIED");
    const event = await verifyDirectPublicationOwnerEvent({ intent: original.intent, event: command.event }), prior = await this.#owner(original.intent);
    if (prior) { if (prior.event.id !== event.id) throw new Error("DIRECT_PUBLICATION_OWNER_EVENT_CONFLICT"); return prior; }
    await this.loadCurrentForSigning(owned);
    const record = OwnerRecord.parse({ version: "direct-publication-owner-v1", intentId: original.intent.intentId, reviewSha256: original.intent.review.reviewSha256, event });
    const key = `direct-publication-owner:v1:${await directPublicationDigest(original.intent.intentId)}`;
    try { await this.input.journal.claim(key, await directPublicationDigest(record), record); }
    catch (error) { const winner = await this.#owner(original.intent); if (!winner || winner.event.id !== event.id) throw error; return winner; }
    const winner = await this.#owner(original.intent);
    if (!winner || winner.event.id !== event.id) throw new Error("DIRECT_PUBLICATION_OWNER_RECORD_MISMATCH");
    return winner;
  }
}
