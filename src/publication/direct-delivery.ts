import { z } from "zod";
import { getToken } from "nostr-tools/nip98";
import type { Event, EventTemplate } from "nostr-tools/pure";
import { ProductionCapabilityDeclarationSchema } from "../worker-adapters/capability-receipt";
import { ProductionDirectManifestTemplateSchema } from "../worker-adapters/direct-manifest-receipt";

const Digest = z.string().regex(/^[a-f0-9]{64}$/u);
const Identifier = z.string().min(1).max(256);
/** A distinct delivery contract. This is source for a compatible sandboxed
 * host, not a host grant, publication intent or legacy aggregate identity. */
export const DirectArtifactDeliverySchema = z.object({
  version: z.literal("direct-artifact-delivery-v1"), artifactContract: z.literal("nip5d-direct-v1"),
  artifact: z.object({ sessionId: Identifier, artifactId: z.string().regex(/^artifact:[a-f0-9]{64}$/u), artifactVersion: z.number().int().positive(),
    artifactHash: Digest, archiveSha256: Digest, verificationEvidenceSha256: Digest, conformanceReceiptSha256: Digest, manifestReceiptSha256: Digest,
    policyVersion: Identifier, toolchainSha256: Digest }).strict(),
  entrypoint: z.object({ path: z.literal("/index.html"), mimeType: z.literal("text/html"), sha256: Digest, size: z.number().int().min(1).max(2_000_000),
    bytesBase64: z.string().min(1).max(2_666_668).regex(/^[A-Za-z0-9+/]*={0,2}$/u) }).strict(),
  capabilities: ProductionCapabilityDeclarationSchema, ownerManifestTemplate: ProductionDirectManifestTemplateSchema,
}).strict();

/** Browser-compatible verification; neither a signer secret nor a coordinator
 * credential is needed. Actual sandbox/host capability consent happens later. */
export async function verifyDirectArtifactDelivery(value: unknown, expected: Readonly<{ sessionId: string; artifactId: string }>) {
  const delivery = DirectArtifactDeliverySchema.parse(value), entry = delivery.entrypoint;
  const raw = atob(entry.bytesBase64), bytes = Uint8Array.from(raw, character => character.charCodeAt(0));
  const hash = Array.from(new Uint8Array(await crypto.subtle.digest("SHA-256", bytes)), byte => byte.toString(16).padStart(2, "0")).join("");
  if (btoa(raw) !== entry.bytesBase64 || bytes.length !== entry.size || hash !== entry.sha256 || hash !== delivery.artifact.artifactHash
    || delivery.artifact.sessionId !== expected.sessionId || delivery.artifact.artifactId !== expected.artifactId
    || delivery.artifact.artifactId !== `artifact:${delivery.artifact.archiveSha256}`) throw new Error("DIRECT_ARTIFACT_DELIVERY_MISMATCH");
  const tags = delivery.ownerManifestTemplate.tags;
  if (JSON.stringify(tags.filter(tag => tag[0] === "x")) !== JSON.stringify([["x", hash]]) || tags.some(tag => ["path", "requires"].includes(tag[0]!))) throw new Error("DIRECT_ARTIFACT_DELIVERY_MISMATCH");
  for (const [name, domains] of [["R", delivery.capabilities.required], ["O", delivery.capabilities.optional]] as const) {
    const observed = tags.filter(tag => tag[0] === name);
    if (observed.some(tag => tag.length !== 2) || JSON.stringify(observed.map(tag => tag[1]!).sort()) !== JSON.stringify([...domains].sort())) throw new Error("DIRECT_ARTIFACT_DELIVERY_MISMATCH");
  }
  return Object.freeze({ delivery, bytes });
}

/** Owner's existing NIP-07/NIP-46 signEvent callback signs an ordinary NIP-98
 * request. This helper never handles a private key or publishes an event. */
export async function createDirectArtifactReadRequest(input: Readonly<{ url: string; sign: (event: EventTemplate) => Promise<Event> | Event }>) {
  const url = new URL(input.url);
  if (url.protocol !== "https:" || url.username || url.password || url.hash || url.search) throw new Error("DIRECT_ARTIFACT_READ_URL_INVALID");
  return new Request(url, { method: "GET", headers: { authorization: await getToken(url.toString(), "GET", input.sign, true) }, redirect: "error", cache: "no-store", credentials: "omit", referrerPolicy: "no-referrer" });
}
