import { z } from "zod";
import { verifyEvent, type Event, type EventTemplate } from "nostr-tools/pure";
import { SignedOwnerManifestEventSchema } from "./contracts";
import { DirectPublicationIntentSchema, directPublicationDigest, validateDirectPublicationIntent } from "./direct-publication";

const Digest = z.string().regex(/^[a-f0-9]{64}$/u);
export const DirectUploadAuthorizationTemplateSchema = z.object({ kind: z.literal(24242), created_at: z.number().int().positive().safe(),
  content: z.literal("Upload blobs via napplet"), tags: z.array(z.array(z.string().max(1024)).length(2)).length(5) }).strict();
const Body = z.object({ version: z.literal("direct-upload-authorization-v1"), intentId: DirectPublicationIntentSchema.shape.intentId,
  reviewSha256: Digest, ownerPubkey: Digest, ownerEventId: Digest, artifactHash: Digest, archiveSha256: Digest,
  server: z.string().url().max(512), helperSha256: Digest, template: DirectUploadAuthorizationTemplateSchema,
  expiresAtMs: z.number().int().positive().safe() }).strict();
export const DirectUploadAuthorizationSchema = Body.extend({ authorizationSha256: Digest, operationId: z.string().regex(/^direct-upload-authorization:[a-f0-9]{64}$/u) }).strict();
export const DirectUploadAuthorizationEventSchema = SignedOwnerManifestEventSchema.extend({ kind: z.literal(24242), content: z.literal("Upload blobs via napplet") }).strict();

/** Validate the captured upstream template; never construct a replacement. */
export async function validateDirectUploadAuthorization(input: Readonly<{ intent: unknown; authorization: unknown }>) {
  const intent = await validateDirectPublicationIntent(input.intent), value = DirectUploadAuthorizationSchema.parse(input.authorization);
  const { authorizationSha256, operationId, ...body } = value;
  if (authorizationSha256 !== await directPublicationDigest(body) || operationId !== `direct-upload-authorization:${authorizationSha256}`
    || value.intentId !== intent.intentId || value.reviewSha256 !== intent.review.reviewSha256 || value.ownerPubkey !== intent.review.ownerPubkey
    || value.artifactHash !== intent.review.artifact.artifactHash || value.archiveSha256 !== intent.review.artifact.archiveSha256 || value.server !== intent.review.servers[0]
    || value.template.created_at * 1000 < intent.createdAtMs - 1000 || value.template.created_at * 1000 >= intent.expiresAtMs
    || value.expiresAtMs !== Math.min(intent.expiresAtMs, (value.template.created_at + 3600) * 1000)
    || JSON.stringify(value.template.tags) !== JSON.stringify([["t", "upload"], ["x", value.artifactHash], ["expiration", String(value.template.created_at + 3600)], ["client", "napplet"], ["server", new URL(value.server).hostname]])) throw new Error("DIRECT_UPLOAD_AUTHORIZATION_MISMATCH");
  return value;
}
export async function verifyDirectUploadAuthorizationEvent(input: Readonly<{ intent: unknown; authorization: unknown; event: unknown }>) {
  const authorization = await validateDirectUploadAuthorization(input), event = DirectUploadAuthorizationEventSchema.parse(input.event);
  if (event.pubkey !== authorization.ownerPubkey || !verifyEvent(event)
    || JSON.stringify({ kind: event.kind, created_at: event.created_at, content: event.content, tags: event.tags }) !== JSON.stringify(authorization.template)) throw new Error("DIRECT_UPLOAD_AUTHORIZATION_EVENT_REQUIRED");
  return event;
}
/** Existing owner NIP-07/NIP-46 signer only. Authenticated presentation must
 * supply the expected digest; this consistency check is not transport trust. */
export async function signDirectUploadAuthorization(input: Readonly<{ intent: unknown; authorization: unknown;
  expected: Readonly<{ authorizationSha256: string; intentId: string; reviewSha256: string; ownerPubkey: string }>;
  sign(template: EventTemplate): Event | Promise<Event> }>) {
  const authorization = await validateDirectUploadAuthorization(input);
  const expected = z.object({ authorizationSha256: Digest, intentId: DirectPublicationIntentSchema.shape.intentId, reviewSha256: Digest, ownerPubkey: Digest }).strict().parse(input.expected);
  if (Object.entries(expected).some(([field, value]) => Reflect.get(authorization, field) !== value)) throw new Error("DIRECT_UPLOAD_APPROVED_AUTHORIZATION_REQUIRED");
  if (Date.now() < authorization.template.created_at * 1000 - 5000 || Date.now() >= authorization.expiresAtMs) throw new Error("DIRECT_UPLOAD_AUTHORIZATION_EXPIRED");
  return verifyDirectUploadAuthorizationEvent({ ...input, event: await input.sign(structuredClone(authorization.template)) });
}
