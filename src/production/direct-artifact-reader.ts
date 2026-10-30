import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { z } from "zod";
import { canonicalJson } from "../promotion/schema";
import { ProductionCapabilityReceiptSchema } from "../worker-adapters/capability-receipt";
import { ProductionConformanceReceiptSchema } from "../worker-adapters/conformance-receipt";
import { ProductionDirectManifestReceiptSchema, verifyProductionDirectManifestReceipt } from "../worker-adapters/direct-manifest-receipt";
import { ProductionArtifactFactsSchema } from "./artifact-verifier";
import { ProductionDirectArtifactVerifier } from "./direct-artifact-verifier";
import { ProductionDirectToolchainReceiptSchema } from "../worker-adapters/direct-toolchain-receipt";

const Digest = z.string().regex(/^[a-f0-9]{64}$/u);
const Build = ProductionArtifactFactsSchema.omit({ distRoot: true, commandEvidence: true, capabilityReceipt: true }).extend({ publication: ProductionArtifactFactsSchema.shape.publication.unwrap() }).strict();
const Archive = z.object({
  version: z.literal(3), artifactContract: z.literal("nip5d-direct-v1"), artifactHash: Digest,
  build: Build,
  receipts: z.object({ capability: ProductionCapabilityReceiptSchema, conformance: ProductionConformanceReceiptSchema, manifest: ProductionDirectManifestReceiptSchema, commands: ProductionArtifactFactsSchema.shape.commandEvidence, toolchain: ProductionDirectToolchainReceiptSchema.optional() }).strict(),
  sealedObjectSha256: Digest, verificationEvidenceSha256: Digest,
  files: z.array(z.object({ path: z.literal("index.html"), sha256: Digest, bytesBase64: z.string().min(1).max(2_666_668) }).strict()).length(1),
}).strict();
const Binding = z.object({ checksum: Digest, build: Build, purpose: z.string().trim().min(1).max(4096) }).strict();
const sha = (value: Uint8Array) => new Bun.CryptoHasher("sha256").update(value).digest("hex");

/** Validation only. The caller must obtain ownership, original build facts and
 * exact object checksum independently. No artifact ID or archive field grants
 * access. Legacy archives and public publication identities stay unchanged. */
export async function readVerifiedDirectWorkerArchive(bytes: Uint8Array, expected: z.input<typeof Binding>) {
  const binding = Binding.parse(expected);
  if (bytes.byteLength > 24 * 1024 * 1024 || sha(bytes) !== binding.checksum) throw new Error("PRODUCTION_DIRECT_ARCHIVE_CHECKSUM_MISMATCH");
  const archive = Archive.parse(JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(bytes)));
  if (canonicalJson(archive.build) !== canonicalJson(binding.build)) throw new Error("PRODUCTION_DIRECT_ARCHIVE_BUILD_MISMATCH");
  const file = archive.files[0]!, html = Buffer.from(file.bytesBase64, "base64");
  if (!html.length || html.length > 2_000_000 || html.toString("base64") !== file.bytesBase64 || sha(html) !== file.sha256) throw new Error("PRODUCTION_DIRECT_ARCHIVE_FILE_MISMATCH");
  // Only a literal index.html is materialized, never an archive-controlled path.
  // This reuses the actual build verifier without executing any stored code.
  const directory = await mkdtemp(join(tmpdir(), "cvm-direct-read-"));
  try {
    await writeFile(join(directory, "index.html"), html, { flag: "wx", mode: 0o600 });
    const verified = await new ProductionDirectArtifactVerifier().verify({ ...archive.build, artifactContract: archive.artifactContract, distRoot: directory, capabilityReceipt: archive.receipts.capability, conformanceReceipt: archive.receipts.conformance, manifestReceipt: archive.receipts.manifest, commandEvidence: archive.receipts.commands, ...(archive.receipts.toolchain ? { toolchainReceipt: archive.receipts.toolchain } : {}) });
    if (verified.artifactHash !== archive.artifactHash || verified.sealedObjectSha256 !== archive.sealedObjectSha256 || verified.verificationEvidenceSha256 !== archive.verificationEvidenceSha256
      || verified.manifest.content !== binding.purpose) throw new Error("PRODUCTION_DIRECT_ARCHIVE_EVIDENCE_MISMATCH");
    verifyProductionDirectManifestReceipt(archive.receipts.manifest, { artifactHash: verified.artifactHash, purpose: binding.purpose, declaration: verified.declaration });
    return Object.freeze({ ...archive, checksum: binding.checksum, files: Object.freeze(verified.files.map(file => Object.freeze({ ...file, bytesBase64: archive.files[0]!.bytesBase64 }))), declaration: verified.declaration, manifest: verified.manifest });
  } finally { await rm(directory, { recursive: true, force: true }); }
}
