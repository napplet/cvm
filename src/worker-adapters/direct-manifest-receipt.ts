import { z } from "zod";
import { ProductionCapabilityDeclarationSchema } from "./capability-receipt";

export const ProductionDirectManifestReceiptSchema = z.object({
  path: z.literal(".nip5a-manifest.json"),
  sha256: z.string().regex(/^[a-f0-9]{64}$/u),
  bytesBase64: z.string().min(1).max(87_384),
}).strict().superRefine((value, context) => {
  const bytes = Buffer.from(value.bytesBase64, "base64");
  if (!bytes.length || bytes.length > 65_536 || bytes.toString("base64") !== value.bytesBase64 || new Bun.CryptoHasher("sha256").update(bytes).digest("hex") !== value.sha256) context.addIssue({ code: "custom", message: "DIRECT_MANIFEST_RECEIPT_INVALID" });
  try { new TextDecoder("utf-8", { fatal: true }).decode(bytes); } catch { context.addIssue({ code: "custom", message: "DIRECT_MANIFEST_RECEIPT_ENCODING_INVALID" }); }
});

const Digest = z.string().regex(/^[a-f0-9]{64}$/u);
const Manifest = z.object({ kind: z.literal(35129), created_at: z.number().int().nonnegative(), tags: z.array(z.array(z.string().max(4096)).min(1).max(16)).max(128), content: z.string().min(1).max(4096), artifactHash: Digest }).strict();

/** Validate the plugin receipt independently of its filesystem location. This
 * does not construct an owner manifest or authorize any capability. */
export function verifyProductionDirectManifestReceipt(input: unknown, expected: Readonly<{ artifactHash: string; purpose: string; declaration: z.infer<typeof ProductionCapabilityDeclarationSchema> }>) {
  const receipt = ProductionDirectManifestReceiptSchema.parse(input);
  const manifest = Manifest.parse(JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(Buffer.from(receipt.bytesBase64, "base64"))));
  if (manifest.artifactHash !== expected.artifactHash || manifest.content !== expected.purpose || manifest.tags.some(tag => ["path", "requires"].includes(tag[0]!)) || JSON.stringify(manifest.tags.filter(tag => tag[0] === "x")) !== JSON.stringify([["x", expected.artifactHash]])) throw new Error("PRODUCTION_DIRECT_MANIFEST_RECEIPT_MISMATCH");
  for (const [name, domains] of [["R", expected.declaration.required], ["O", expected.declaration.optional]] as const) {
    const actual = manifest.tags.filter(tag => tag[0] === name);
    if (actual.some(tag => tag.length !== 2) || JSON.stringify(actual.map(tag => tag[1]!).sort()) !== JSON.stringify([...domains].sort())) throw new Error("PRODUCTION_DIRECT_MANIFEST_RECEIPT_MISMATCH");
  }
  return manifest;
}
