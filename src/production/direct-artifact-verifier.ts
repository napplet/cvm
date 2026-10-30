import { z } from "zod";
import { ProductionDirectManifestReceiptSchema, ProductionDirectManifestTemplateSchema as Template } from "../worker-adapters/direct-manifest-receipt";
export { ProductionCapabilityDeclarationSchema } from "../worker-adapters/capability-receipt";
export { ProductionDirectManifestReceiptSchema } from "../worker-adapters/direct-manifest-receipt";
import { canonicalJson } from "../promotion/schema";
import { ProductionCapabilityDeclarationSchema, ProductionCapabilityReceiptSchema } from "../worker-adapters/capability-receipt";
import { ProductionConformanceReceiptSchema, verifyProductionConformanceReceipt } from "../worker-adapters/conformance-receipt";
import { ProductionArtifactFactsSchema, inventoryProductionArtifactFiles, readVerifiedProductionArtifactFile } from "./artifact-verifier";
import { verifyDirectArtifactHtml } from "./direct-html-policy";

const Digest = z.string().regex(/^[a-f0-9]{64}$/u);
const Facts = ProductionArtifactFactsSchema.extend({
  artifactContract: z.literal("nip5d-direct-v1"),
  publication: ProductionArtifactFactsSchema.shape.publication.unwrap(),
  capabilityReceipt: ProductionCapabilityReceiptSchema,
  conformanceReceipt: ProductionConformanceReceiptSchema,
  manifestReceipt: ProductionDirectManifestReceiptSchema,
}).strict();
const Target = z.object({ target: z.literal("named"), kind: z.literal(35129), dTag: z.string().regex(/^[a-z0-9][a-z0-9-]{0,127}$/u) }).passthrough();
const Sidecar = Template.extend({ artifactHash: Digest }).strict();
const DryRun = z.object({ dryRun: z.literal(true), signing: z.object({ type: z.literal("none") }).passthrough(), plan: z.object({ items: z.array(Target).length(1) }).passthrough(), manifests: z.array(z.object({ item: Target, format: z.literal("current"), artifactHash: Digest, files: z.array(z.object({ path: z.literal("/index.html"), sha256: Digest }).strict()).length(1), template: Template }).passthrough()).length(1), blossomServers: z.array(z.string().url()).length(1), relays: z.array(z.string().url()).max(32) }).passthrough();
const sha = (value: string | Uint8Array) => new Bun.CryptoHasher("sha256").update(value).digest("hex");
const sorted = (values: readonly string[]) => [...values].sort();
const same = (left: unknown, right: unknown) => canonicalJson(left) === canonicalJson(right);
function verifyTags(template: z.infer<typeof Template>, artifactHash: string, declaration: z.infer<typeof ProductionCapabilityDeclarationSchema>): void {
  const tags = template.tags;
  if (tags.some(tag => ["path", "requires"].includes(tag[0]!)) || !same(tags.filter(tag => tag[0] === "x"), [["x", artifactHash]])) throw new Error("PRODUCTION_DIRECT_MANIFEST_TAG_MISMATCH");
  for (const [tagName, expected] of [["R", declaration.required], ["O", declaration.optional]] as const) {
    const observed = tags.filter(tag => tag[0] === tagName);
    if (observed.some(tag => tag.length !== 2) || !same(sorted(observed.map(tag => tag[1]!)), sorted(expected))) throw new Error("PRODUCTION_DIRECT_CAPABILITY_MISMATCH");
  }
}

/** Explicit direct-format verifier. It never interprets a direct hash as a
 * legacy aggregate, grants capabilities, signs events, or runs generated code. */
export class ProductionDirectArtifactVerifier {
  readonly authority = "production-real" as const;
  async verify(input: unknown) {
    const facts = Facts.parse(input);
    for (const [index, stage] of ["create", "init", "skills", "install", "build", "verify", "conformance", "dry-run"].entries()) if (facts.commandEvidence[index]!.name !== stage || facts.commandEvidence[index]!.exitCode !== 0) throw new Error("PRODUCTION_ARTIFACT_COMMAND_NOT_PASSED");
    const conformance = verifyProductionConformanceReceipt(facts.conformanceReceipt);
    if (facts.capabilityReceipt.state !== "present") throw new Error("PRODUCTION_DIRECT_CAPABILITY_DECLARATION_REQUIRED");
    const declaration = ProductionCapabilityDeclarationSchema.parse(JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(Buffer.from(facts.capabilityReceipt.bytesBase64, "base64"))));
    const sidecar = Sidecar.parse(JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(Buffer.from(facts.manifestReceipt.bytesBase64, "base64"))));
    const dryRun = DryRun.parse(JSON.parse(facts.commandEvidence[7]!.stdout ?? "null")), manifest = dryRun.manifests[0]!;
    if ("aggregateHash" in manifest) throw new Error("PRODUCTION_DIRECT_MANIFEST_TAG_MISMATCH");
    const inventory = await inventoryProductionArtifactFiles(facts.distRoot), receiptFile = inventory.find(file => file.path === ".nip5a-manifest.json");
    if (receiptFile && (receiptFile.sha256 !== facts.manifestReceipt.sha256 || Buffer.from(await readVerifiedProductionArtifactFile(facts.distRoot, receiptFile)).toString("base64") !== facts.manifestReceipt.bytesBase64)) throw new Error("PRODUCTION_DIRECT_SIDECAR_MISMATCH");
    const files = inventory.filter(file => file.path !== ".nip5a-manifest.json");
    if (files.length !== 1 || files[0]!.path !== "index.html") throw new Error("PRODUCTION_DIRECT_SINGLE_FILE_REQUIRED");
    const index = files[0]!, bytes = await readVerifiedProductionArtifactFile(facts.distRoot, index), artifactHash = sha(bytes);
    await verifyDirectArtifactHtml(new TextDecoder("utf-8", { fatal: true }).decode(bytes));
    if (manifest.artifactHash !== artifactHash || manifest.files[0]!.sha256 !== artifactHash || sidecar.artifactHash !== artifactHash) throw new Error("PRODUCTION_DIRECT_ARTIFACT_HASH_MISMATCH");
    verifyTags(manifest.template, artifactHash, declaration); verifyTags(sidecar, artifactHash, declaration);
    const target = dryRun.plan.items[0]!;
    if (manifest.item.dTag !== target.dTag || !same(manifest.template.tags.filter(tag => tag[0] === "d"), [["d", target.dTag]])) throw new Error("PRODUCTION_DIRECT_TARGET_MISMATCH");
    if (dryRun.blossomServers[0] !== facts.publication.server || !same(manifest.template.tags.filter(tag => tag[0] === "server"), [["server", facts.publication.server]])) throw new Error("PRODUCTION_ARTIFACT_PUBLICATION_SERVER_MISMATCH");
    const commands = facts.commandEvidence.map(command => ({ name: command.name, exitCode: command.exitCode, ...(command.stdout ? { stdout: sha(command.stdout) } : {}), ...(command.stderr ? { stderr: sha(command.stderr) } : {}) }));
    return Object.freeze({ ...facts, files: Object.freeze(files), artifactHash, declaration, manifest: manifest.template, sealedObjectSha256: sha(JSON.stringify(files)), verificationEvidenceSha256: sha(canonicalJson({ artifactContract: facts.artifactContract, commands, files, artifactHash, capabilityReceipt: facts.capabilityReceipt, conformanceReceipt: conformance.receipt, manifestReceipt: facts.manifestReceipt })) });
  }
}
export type VerifiedDirectProductionArtifact = Awaited<ReturnType<ProductionDirectArtifactVerifier["verify"]>>;
