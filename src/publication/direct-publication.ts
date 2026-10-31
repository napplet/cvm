import { z } from "zod";
import { verifyEvent, type Event, type EventTemplate } from "nostr-tools/pure";
import { DirectArtifactDeliverySchema } from "./direct-delivery";
import { SignedOwnerManifestEventSchema } from "./contracts";
import { ProductionDirectManifestTemplateSchema } from "../worker-adapters/direct-manifest-receipt";
import { ProductionCapabilityDeclarationSchema } from "../worker-adapters/capability-receipt";
import { ProductionWorkerPublicationSchema } from "../worker-adapters/publication-metadata";

const Digest = z.string().regex(/^[a-f0-9]{64}$/u);
const Identifier = z.string().min(1).max(256);
const Relay = z.string().url().max(512).refine(value => { const url = new URL(value); return url.protocol === "wss:" && !url.username && !url.password && !url.search && !url.hash; });
const ReviewBody = z.object({ version: z.literal("direct-publication-review-v1"), ownerPubkey: Digest,
  artifact: DirectArtifactDeliverySchema.shape.artifact,
  file: DirectArtifactDeliverySchema.shape.entrypoint.omit({ bytesBase64: true }),
  capabilities: ProductionCapabilityDeclarationSchema, ownerManifestTemplate: ProductionDirectManifestTemplateSchema,
  servers: z.array(ProductionWorkerPublicationSchema.shape.server).length(1), relays: z.array(Relay).min(1).max(16),
}).strict();
export const DirectPublicationReviewSchema = ReviewBody.extend({ reviewSha256: Digest }).strict();
export const DirectPublicationIntentSchema = z.object({ version: z.literal("direct-publication-intent-v1"), intentId: z.string().regex(/^direct-publication:[a-f0-9]{64}$/u),
  idempotencyKey: Identifier, requestSha256: Digest, review: DirectPublicationReviewSchema,
  createdAtMs: z.number().int().positive().safe(), expiresAtMs: z.number().int().positive().safe(),
}).strict();
export const directPublicationDigest = async (value: unknown) => Array.from(new Uint8Array(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(JSON.stringify(value)))), byte => byte.toString(16).padStart(2, "0")).join("");

/** No event template is constructed here: preserve the actual CLI result. */
export async function createDirectPublicationReview(input: z.input<typeof ReviewBody>) {
  const body = ReviewBody.parse(input), tags = body.ownerManifestTemplate.tags, artifact = body.artifact;
  if (artifact.artifactId !== `artifact:${artifact.archiveSha256}` || body.file.sha256 !== artifact.artifactHash
    || JSON.stringify(tags.filter(tag => tag[0] === "x")) !== JSON.stringify([["x", artifact.artifactHash]])
    || JSON.stringify(tags.filter(tag => tag[0] === "server")) !== JSON.stringify([["server", body.servers[0]]])
    || tags.some(tag => ["path", "requires"].includes(tag[0]!)) || new Set(body.relays).size !== body.relays.length) throw new Error("DIRECT_PUBLICATION_REVIEW_MISMATCH");
  const names = tags.filter(tag => tag[0] === "d");
  if (names.length !== 1 || names[0]!.length !== 2 || !/^[a-z0-9][a-z0-9-]{0,127}$/u.test(names[0]![1]!)) throw new Error("DIRECT_PUBLICATION_REVIEW_MISMATCH");
  for (const [name, domains] of [["R", body.capabilities.required], ["O", body.capabilities.optional]] as const) {
    const observed = tags.filter(tag => tag[0] === name);
    if (observed.some(tag => tag.length !== 2) || JSON.stringify(observed.map(tag => tag[1]!).sort()) !== JSON.stringify([...domains].sort())) throw new Error("DIRECT_PUBLICATION_REVIEW_MISMATCH");
  }
  return DirectPublicationReviewSchema.parse({ ...body, reviewSha256: await directPublicationDigest(body) });
}

export async function validateDirectPublicationIntent(input: unknown) {
  const intent = DirectPublicationIntentSchema.parse(input), { reviewSha256, ...body } = intent.review;
  if ((await createDirectPublicationReview(body)).reviewSha256 !== reviewSha256 || intent.expiresAtMs <= intent.createdAtMs || intent.expiresAtMs > intent.createdAtMs + 1_800_000
    || intent.review.ownerManifestTemplate.created_at * 1000 > intent.createdAtMs + 30_000) throw new Error("DIRECT_PUBLICATION_INTENT_MISMATCH");
  const { intentId, ...seed } = intent;
  if (intentId !== `direct-publication:${await directPublicationDigest(seed)}`) throw new Error("DIRECT_PUBLICATION_INTENT_MISMATCH");
  return intent;
}

/** Completed public event verification only; no signer/key enters this API. */
export async function verifyDirectPublicationOwnerEvent(input: Readonly<{ intent: unknown; event: unknown }>) {
  const intent = await validateDirectPublicationIntent(input.intent), event = SignedOwnerManifestEventSchema.parse(input.event), template = intent.review.ownerManifestTemplate;
  if (event.pubkey !== intent.review.ownerPubkey || !verifyEvent(event)
    || JSON.stringify({ kind: event.kind, created_at: event.created_at, tags: event.tags, content: event.content }) !== JSON.stringify(template)) throw new Error("DIRECT_PUBLICATION_OWNER_EVENT_REQUIRED");
  return event;
}

/** The callback is the owner's existing NIP-07/NIP-46 signer. This helper
 * signs no replacement manifest, uploads nothing and receives no private key. */
export async function signDirectPublicationIntent(input: Readonly<{ intent: unknown;
  expected: Readonly<{ intentId: string; reviewSha256: string; ownerPubkey: string }>;
  sign: (event: EventTemplate) => Event | Promise<Event> }>) {
  const intent = await validateDirectPublicationIntent(input.intent), now = Date.now();
  const expected = z.object({ intentId: DirectPublicationIntentSchema.shape.intentId, reviewSha256: Digest, ownerPubkey: Digest }).strict().parse(input.expected);
  if (intent.intentId !== expected.intentId || intent.review.reviewSha256 !== expected.reviewSha256 || intent.review.ownerPubkey !== expected.ownerPubkey) throw new Error("DIRECT_PUBLICATION_APPROVED_INTENT_REQUIRED");
  if (now < intent.createdAtMs - 5000 || now >= intent.expiresAtMs) throw new Error("DIRECT_PUBLICATION_INTENT_EXPIRED");
  return verifyDirectPublicationOwnerEvent({ intent, event: await input.sign(structuredClone(intent.review.ownerManifestTemplate)) });
}
