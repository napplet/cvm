import { expect, test } from "bun:test";
import { finalizeEvent, getPublicKey } from "nostr-tools/pure";
import { createDirectPublicationReview, directPublicationDigest, signDirectPublicationIntent, validateDirectPublicationIntent, verifyDirectPublicationOwnerEvent } from "../../src/publication/direct-publication";
import cli from "../fixtures/direct-artifact/cli-current.json";
import { ProductionDirectManifestTemplateSchema } from "../../src/worker-adapters/direct-manifest-receipt";

const key = new Uint8Array(32).fill(41);
async function intent(at = Date.now()) {
  const hash = cli.manifests[0]!.artifactHash, archive = "f".repeat(64);
  const review = await createDirectPublicationReview({ version: "direct-publication-review-v1", ownerPubkey: getPublicKey(key),
    artifact: { sessionId: "unit:session", artifactId: `artifact:${archive}`, artifactVersion: 2, artifactHash: hash, archiveSha256: archive,
      verificationEvidenceSha256: "a".repeat(64), conformanceReceiptSha256: "b".repeat(64), manifestReceiptSha256: "c".repeat(64), policyVersion: "unit:policy", toolchainSha256: "d".repeat(64) },
    file: { path: "/index.html", mimeType: "text/html", size: 1, sha256: hash }, capabilities: { required: ["storage"], optional: ["intent"] },
    ownerManifestTemplate: ProductionDirectManifestTemplateSchema.parse(cli.manifests[0]!.template), servers: ["https://publication.example"], relays: ["wss://relay.example"] });
  const seed = { version: "direct-publication-intent-v1", idempotencyKey: "unit:publish", requestSha256: "e".repeat(64), review, createdAtMs: at, expiresAtMs: at + 1_800_000 };
  return validateDirectPublicationIntent({ ...seed, intentId: `direct-publication:${await directPublicationDigest(seed)}` });
}

test("direct owner signs the exact retained CLI template, preserving direct identity and ordered tags", async () => {
  const original = await intent(); let calls = 0;
  const expected = { intentId: original.intentId, reviewSha256: original.review.reviewSha256, ownerPubkey: original.review.ownerPubkey };
  const signed = await signDirectPublicationIntent({ intent: original, expected, sign(template) { calls++; expect(template).toEqual(cli.manifests[0]!.template); return finalizeEvent(template, key); } });
  expect(calls).toBe(1); expect(signed.pubkey).toBe(getPublicKey(key));
  expect(await verifyDirectPublicationOwnerEvent({ intent: original, event: signed })).toEqual(signed);
  expect(original).not.toHaveProperty("aggregateSha256"); expect(original.review).not.toHaveProperty("aggregateSha256");
  for (const event of [finalizeEvent({ ...original.review.ownerManifestTemplate, content: "substituted" }, key),
    finalizeEvent({ ...original.review.ownerManifestTemplate, tags: [...original.review.ownerManifestTemplate.tags].reverse() }, key),
    finalizeEvent(structuredClone(original.review.ownerManifestTemplate), new Uint8Array(32).fill(42)), { ...signed, sig: "0".repeat(128) }, { ...signed, privateKey: "refused" }]) {
    await expect(verifyDirectPublicationOwnerEvent({ intent: original, event })).rejects.toThrow();
  }
  expect(original.review.ownerManifestTemplate).toEqual(ProductionDirectManifestTemplateSchema.parse(cli.manifests[0]!.template));
});

test("intent, review, cap and target substitutions refuse; expired signing never invokes the signer", async () => {
  const original = await intent();
  const mutations: Array<(value: typeof original) => void> = [
    value => { value.review.artifact.artifactHash = "0".repeat(64); },
    value => { value.review.artifact.archiveSha256 = "0".repeat(64); },
    value => { value.review.capabilities.required = []; },
    value => { value.review.servers = ["https://other.example"]; },
    value => { value.review.relays = ["wss://other.example"]; },
    value => { value.review.ownerPubkey = "0".repeat(64); },
    value => { value.expiresAtMs++; },
    value => { value.requestSha256 = "0".repeat(64); },
    value => { value.idempotencyKey = "unit:other"; },
  ];
  for (const mutate of mutations) { const changed = structuredClone(original); mutate(changed); await expect(validateDirectPublicationIntent(changed)).rejects.toThrow(); }
  const expired = await intent(Date.now() - 1_800_001); let calls = 0;
  await expect(signDirectPublicationIntent({ intent: expired, expected: { intentId: expired.intentId, reviewSha256: expired.review.reviewSha256, ownerPubkey: expired.review.ownerPubkey }, sign(template) { calls++; return finalizeEvent(template, key); } })).rejects.toThrow("INTENT_EXPIRED");
  await expect(signDirectPublicationIntent({ intent: original, expected: { intentId: original.intentId, reviewSha256: "0".repeat(64), ownerPubkey: original.review.ownerPubkey }, sign(template) { calls++; return finalizeEvent(template, key); } })).rejects.toThrow("APPROVED_INTENT_REQUIRED");
  expect(calls).toBe(0);
  // Reading an already accepted public signature remains possible after expiry.
  expect((await verifyDirectPublicationOwnerEvent({ intent: expired, event: finalizeEvent(structuredClone(expired.review.ownerManifestTemplate), key) })).pubkey).toBe(getPublicKey(key));
  const { reviewSha256: _sha, ...body } = original.review;
  await expect(createDirectPublicationReview({ ...body, relays: ["wss://relay.example", "wss://relay.example"] })).rejects.toThrow();
  await expect(createDirectPublicationReview({ ...body, relays: ["wss://relay.example?token=refused"] })).rejects.toThrow();
});
