import { createHash } from "node:crypto";
import { z } from "zod";
import type { CheckpointCryptoPort } from "../continuity/checkpoint-envelope";
import type { ImmutableObjectReference, ObjectStorePort } from "../continuity/object-store";
import { canonicalJson } from "../promotion/schema";
import { DurabilitySubjectSchema } from "../resilience/fault-harness";

const Digest = z.string().regex(/^[a-f0-9]{64}$/u);
const Identity = z.string().min(1).max(256).regex(/^[A-Za-z0-9][A-Za-z0-9_.:/-]*$/u);
const sha = (value: Uint8Array | string) => createHash("sha256").update(value).digest("hex");
const bytes = (value: unknown) => new TextEncoder().encode(canonicalJson(value));

/** Mounted checkpoint crypto already supports server-derived companion custody
 * identities (pending commands).  This narrow extension keeps those custody
 * identities separate from source and workspace identities. */
export type RetainedSubjectCrypto = CheckpointCryptoPort & Readonly<{
  readSealed(checkpointId: string): Promise<Readonly<{ keyReference: string; nonce: Uint8Array; ciphertext: Uint8Array; ciphertextSha256: string; aadSha256: string; retentionUntil: string }> | undefined>;
}>;

export type RetainedSubjectSource = Readonly<{
  kind: z.infer<typeof DurabilitySubjectSchema>["kind"];
  sourceIdentity: string;
  bytes: Uint8Array;
}>;

const Source = z.object({ kind: z.enum(["sealed_artifact", "validation_evidence", "usage_receipt", "promotion_evidence", "owner_event", "attestation"]), sourceIdentity: Identity, bytes: z.instanceof(Uint8Array).refine(value => value.byteLength > 0 && value.byteLength <= 16 * 1024 * 1024) }).strict();

export function retainedSubjectCustodyId(input: Readonly<{ checkpointId: string; kind: z.infer<typeof DurabilitySubjectSchema>["kind"]; sourceIdentity: string }>): string {
  const checkpointId = Identity.parse(input.checkpointId), sourceIdentity = Identity.parse(input.sourceIdentity);
  if (input.kind === "checkpoint") throw new Error("RETAINED_SUBJECT_CHECKPOINT_CUSTODY_FORBIDDEN");
  return `durability-subject:${sha(canonicalJson({ checkpointId, kind: input.kind, sourceIdentity })).slice(0, 48)}`;
}

function aad(input: Readonly<{ custodyId: string; checkpointId: string; kind: string; sourceIdentity: string; sourceVersion: string; accountId: string; ownerId: string; sessionId: string; actionId: string; retentionUntil: string; payloadSha256: string }>): Uint8Array {
  return bytes({ schemaVersion: "durability-subject-custody-v1", ...input });
}

/** Explicit protected preparation primitive. Callers supply only bytes read
 * from an already-committed original authority; this primitive has no model,
 * signer, payment, relay, worker, or publication dispatch capability. */
export async function sealRetainedSubject(input: Readonly<{
  crypto: RetainedSubjectCrypto;
  objectStore: ObjectStorePort;
  checkpointId: string;
  accountId: string;
  ownerId: string;
  sessionId: string;
  actionId: string;
  retentionUntil: string;
  source: RetainedSubjectSource;
}>): Promise<z.infer<typeof DurabilitySubjectSchema>> {
  const source = Source.parse(input.source);
  const checkpointId = Identity.parse(input.checkpointId), accountId = z.string().min(1).parse(input.accountId), ownerId = Identity.parse(input.ownerId), sessionId = Identity.parse(input.sessionId), actionId = Identity.parse(input.actionId);
  const retentionUntil = new Date(input.retentionUntil).toISOString();
  const payloadSha256 = sha(source.bytes), custodyId = retainedSubjectCustodyId({ checkpointId, kind: source.kind, sourceIdentity: source.sourceIdentity });
  const associatedData = aad({ custodyId, checkpointId, kind: source.kind, sourceIdentity: source.sourceIdentity, sourceVersion: payloadSha256, accountId, ownerId, sessionId, actionId, retentionUntil, payloadSha256 });
  const sealed = await input.crypto.seal({ checkpointId: custodyId, plaintext: new Uint8Array(source.bytes), additionalData: associatedData, binding: { accountId, sessionId, actionId, operationId: `durability-archive:${custodyId}`, retentionUntil } });
  const stored = await input.crypto.readSealed(custodyId);
  if (!stored || stored.keyReference !== sealed.keyReference || stored.ciphertextSha256 !== sha(sealed.ciphertext) || stored.aadSha256 !== sha(associatedData) || stored.retentionUntil !== retentionUntil) throw new Error("RETAINED_SUBJECT_CUSTODY_READBACK_REQUIRED");
  const object = await input.objectStore.createImmutable({ key: `durability-subjects/${custodyId}/${stored.ciphertextSha256}`, bytes: new Uint8Array(stored.ciphertext) });
  if (object.checksum !== stored.ciphertextSha256) throw new Error("RETAINED_SUBJECT_OBJECT_BINDING_REQUIRED");
  return DurabilitySubjectSchema.parse({ kind: source.kind, sourceIdentity: source.sourceIdentity, object, payloadSha256, ownerId, retentionUntil, deletionState: "retained" });
}

/** Opens one exact non-workspace archive from the cloned authority. Its
 * caller must validate the resulting source bytes against the kind-specific
 * recovered SQL/journal source before declaring reattachment. */
export async function openRetainedSubject(input: Readonly<{
  crypto: RetainedSubjectCrypto;
  objectStore: ObjectStorePort;
  checkpointId: string;
  accountId: string;
  sessionId: string;
  actionId: string;
  subject: z.infer<typeof DurabilitySubjectSchema>;
}>): Promise<Uint8Array> {
  const subject = DurabilitySubjectSchema.parse(input.subject);
  if (subject.kind === "checkpoint" || subject.deletionState !== "retained") throw new Error("RETAINED_SUBJECT_OPEN_KIND_REQUIRED");
  const checkpointId = Identity.parse(input.checkpointId), accountId = z.string().min(1).parse(input.accountId), sessionId = Identity.parse(input.sessionId), actionId = Identity.parse(input.actionId);
  const custodyId = retainedSubjectCustodyId({ checkpointId, kind: subject.kind, sourceIdentity: subject.sourceIdentity });
  const stored = await input.crypto.readSealed(custodyId);
  if (!stored || stored.ciphertextSha256 !== subject.object.checksum || stored.retentionUntil !== new Date(subject.retentionUntil).toISOString()) throw new Error("RETAINED_SUBJECT_CUSTODY_BINDING_REQUIRED");
  const exact = await input.objectStore.readExact(subject.object as ImmutableObjectReference);
  if (!exact || sha(exact) !== subject.object.checksum) throw new Error("RETAINED_SUBJECT_OBJECT_BINDING_REQUIRED");
  const associatedData = aad({ custodyId, checkpointId, kind: subject.kind, sourceIdentity: subject.sourceIdentity, sourceVersion: subject.payloadSha256, accountId, ownerId: subject.ownerId, sessionId, actionId, retentionUntil: subject.retentionUntil, payloadSha256: subject.payloadSha256 });
  if (stored.aadSha256 !== sha(associatedData)) throw new Error("RETAINED_SUBJECT_AAD_BINDING_REQUIRED");
  const plaintext = await input.crypto.open({ keyReference: stored.keyReference, nonce: stored.nonce, ciphertext: exact, additionalData: associatedData });
  if (sha(plaintext) !== subject.payloadSha256) throw new Error("RETAINED_SUBJECT_PAYLOAD_BINDING_REQUIRED");
  return plaintext;
}
