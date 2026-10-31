import { constants } from "node:fs";
import { lstat, open, readdir, realpath } from "node:fs/promises";
import { join, relative, resolve, sep } from "node:path";
import { z } from "zod";
import { ProductionWorkerPublicationSchema } from "../worker-adapters/publication-metadata";
import { ProductionCapabilityReceiptSchema } from "../worker-adapters/capability-receipt";

const Digest = z.string().regex(/^[a-f0-9]{64}$/u);
const Stage = z.enum(["create", "init", "skills", "install", "build", "verify", "conformance", "dry-run"]);
const Command = z.object({ name: Stage, exitCode: z.number().int(), stdout: z.string().max(40_000).optional(), stderr: z.string().max(20_000).optional() }).strict();
const EdgeCertification = z.object({ version: z.literal(2), candidateSha256: Digest, topologySha256: Digest, hostile: z.object({ filesystemDenied: z.literal(true), networkDenied: z.literal(true), noInboundPorts: z.literal(true), nonRoot: z.literal(true), minimalCapabilities: z.literal(true) }).strict(), cgroup: z.object({ cpuQuotaMicros: z.number().int().positive(), cpuPeriodMicros: z.number().int().positive(), memoryMaxBytes: z.number().int().positive().max(2_048 * 1024 * 1024), pidsMax: z.number().int().positive().max(256) }).strict(), imageToolchain: z.object({ format: z.literal("immutable-image-files-v1"), sha256: Digest, files: z.array(z.object({ path: z.string().regex(/^\/toolchain\//u), sha256: Digest }).strict()).length(6) }).strict(), provider: z.object({ state: z.literal("verified"), originalOperationId: z.string().min(1), resourceId: z.string().min(1), image: z.string().regex(/^.+@sha256:[a-f0-9]{64}$/iu), sessionLeaseSha256: Digest, toolchainMeasurementSha256: Digest, expiresAtEpochMs: z.number().int().positive(), observedAtEpochMs: z.number().int().positive(), hardStop: z.object({ kind: z.literal("provider-enforced"), policyVersion: z.string().min(1), maximumLifetimeMs: z.number().int().positive().max(1_200_000) }).strict(), observedTermination: z.object({ state: z.enum(["not-observed", "observed"]), observedAtEpochMs: z.number().int().positive().optional() }).strict() }).strict(), supply: z.object({ format: z.literal("installed-package-inventory-v1"), primary: z.object({ aggregateSha256: Digest, lockSha256: Digest, commandEvidenceSha256: Digest, installed: z.object({ format: z.literal("installed-package-inventory-v1"), sha256: Digest, packages: z.array(z.object({ name: z.string().min(1), version: z.string().min(1), packageJsonSha256: Digest }).strict()).min(1) }).strict() }).strict(), secondary: z.object({ aggregateSha256: Digest, lockSha256: Digest, commandEvidenceSha256: Digest, installed: z.object({ format: z.literal("installed-package-inventory-v1"), sha256: Digest, packages: z.array(z.object({ name: z.string().min(1), version: z.string().min(1), packageJsonSha256: Digest }).strict()).min(1) }).strict() }).strict() }).strict() }).strict();
const Facts = z.object({
  ownerId: z.string().regex(/^[a-f0-9]{64}$/u), accountId: z.string().min(1), sessionId: z.string().min(1), actionId: z.string().min(1),
  expectedVersion: z.number().int().nonnegative(), proposalSha256: Digest, toolchainSha256: Digest, distRoot: z.string().min(1),
  commandEvidence: z.array(Command).length(8),
  publication: ProductionWorkerPublicationSchema.optional(),
  capabilityReceipt: ProductionCapabilityReceiptSchema.optional(),
  edgeCertification: EdgeCertification.optional(),
}).strict();
const ManifestFile = z.object({ path: z.string().min(2).max(257), sha256: Digest }).strict();
/** The pinned @napplet/cli dry-run report includes signing, relay, and
 * Blossom diagnostics in addition to the deploy plan. Parse its security
 * facts while permitting those documented report extras. */
const DeployTarget = z.discriminatedUnion("target", [
  z.object({ target: z.literal("root"), kind: z.literal(15129) }).passthrough(),
  z.object({ target: z.literal("named"), kind: z.literal(35129), dTag: z.string().regex(/^[a-z0-9][a-z0-9-]{0,127}$/u) }).passthrough(),
]);
const DryRun = z.object({
  dryRun: z.literal(true),
  signing: z.object({ type: z.string().min(1) }).passthrough(),
  plan: z.object({ items: z.array(DeployTarget).length(1) }).passthrough(),
  manifests: z.array(z.object({ item: DeployTarget, files: z.array(ManifestFile).min(1).max(256), aggregateHash: Digest,
    template: z.object({ kind: z.union([z.literal(15129), z.literal(35129)]), tags: z.array(z.array(z.string()).min(1)).max(512) }).passthrough(),
  }).passthrough()).length(1),
  relays: z.array(z.string().url()).max(32),
  blossomServers: z.array(z.string().url()).max(32),
}).passthrough();

const MAX_FILE_BYTES = 2_000_000;
const MAX_OUTPUT_BYTES = 8_000_000;
const MAX_ENTRIES = 256;

export type ProductionArtifactFile = Readonly<{ path: string; sha256: string; bytes: number }>;
export type VerifiedProductionArtifact = Readonly<z.infer<typeof Facts> & { files: readonly ProductionArtifactFile[]; aggregateSha256: string; sealedObjectSha256: string; verificationEvidenceSha256: string }>;

function sha256(value: string | Uint8Array): string { return new Bun.CryptoHasher("sha256").update(value).digest("hex"); }
function safePath(path: string): boolean { return path.length <= 256 && /^[A-Za-z0-9._/-]+$/u.test(path) && path.split("/").every(part => part !== "" && part !== "." && part !== ".."); }

async function readRegularFile(path: string): Promise<Uint8Array> {
  const handle = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW);
  try {
    const stat = await handle.stat();
    if (!stat.isFile() || stat.size > MAX_FILE_BYTES || stat.nlink !== 1) throw new Error("PRODUCTION_ARTIFACT_FILE_REJECTED");
    const bytes = Buffer.alloc(stat.size + 1); let offset = 0;
    while (offset < bytes.length) { const result = await handle.read(bytes, offset, bytes.length - offset, offset); if (result.bytesRead === 0) break; offset += result.bytesRead; }
    if (offset !== stat.size) throw new Error("PRODUCTION_ARTIFACT_FILE_CHANGED");
    return bytes.subarray(0, offset);
  } finally { await handle.close(); }
}

async function inventory(root: string): Promise<readonly ProductionArtifactFile[]> {
  const rootStat = await lstat(root);
  if (!rootStat.isDirectory() || rootStat.isSymbolicLink()) throw new Error("PRODUCTION_ARTIFACT_ROOT_REJECTED");
  const files: ProductionArtifactFile[] = []; let total = 0; let entries = 0;
  async function visit(directory: string, depth: number): Promise<void> {
    if (depth > 8) throw new Error("PRODUCTION_ARTIFACT_DEPTH_REJECTED");
    const children = await readdir(directory, { withFileTypes: true }); entries += children.length;
    if (entries > MAX_ENTRIES) throw new Error("PRODUCTION_ARTIFACT_FILE_COUNT_REJECTED");
    for (const child of children.sort((a, b) => a.name.localeCompare(b.name))) {
      const absolute = join(directory, child.name); const stat = await lstat(absolute);
      if (stat.isSymbolicLink() || (!stat.isDirectory() && !stat.isFile())) throw new Error("PRODUCTION_ARTIFACT_SPECIAL_FILE_REJECTED");
      if (stat.isDirectory()) { await visit(absolute, depth + 1); continue; }
      const path = relative(root, absolute).split(sep).join("/");
      if (!safePath(path) || stat.size > MAX_FILE_BYTES || stat.nlink !== 1) throw new Error("PRODUCTION_ARTIFACT_FILE_REJECTED");
      total += stat.size; if (total > MAX_OUTPUT_BYTES) throw new Error("PRODUCTION_ARTIFACT_OUTPUT_LIMIT_REJECTED");
      const bytes = await readRegularFile(absolute); files.push(Object.freeze({ path, sha256: sha256(bytes), bytes: bytes.byteLength }));
    }
  }
  await visit(root, 0); return Object.freeze(files);
}

export async function readVerifiedProductionArtifactFile(root: string, file: ProductionArtifactFile): Promise<Uint8Array> {
  const authority = await realpath(root); const target = resolve(authority, file.path); const parent = await realpath(resolve(target, ".."));
  if (!safePath(file.path) || !Digest.safeParse(file.sha256).success || parent !== authority && !parent.startsWith(`${authority}${sep}`)) throw new Error("PRODUCTION_ARTIFACT_PATH_REJECTED");
  const bytes = await readRegularFile(target);
  if (bytes.byteLength !== file.bytes || sha256(bytes) !== file.sha256) throw new Error("PRODUCTION_ARTIFACT_FILE_HASH_MISMATCH");
  return bytes;
}

async function verifyHtml(root: string, index: ProductionArtifactFile): Promise<void> {
  const html = new TextDecoder("utf-8", { fatal: true }).decode(await readVerifiedProductionArtifactFile(root, index));
  if (!/^\s*<!doctype html>/iu.test(html)) throw new Error("PRODUCTION_ARTIFACT_HTML_DOCTYPE_REQUIRED");
  let denied = false;
  const parser = new HTMLRewriter().on("*", { element(element) {
    const tag = element.tagName.toLowerCase();
    if (["base", "iframe", "frame", "object", "embed"].includes(tag) || tag === "meta" && element.getAttribute("http-equiv")?.toLowerCase() === "refresh") denied = true;
    for (const [name, value] of element.attributes) {
      if (["src", "href", "srcset", "action", "formaction", "poster", "background", "data", "xlink:href"].includes(name.toLowerCase())) {
        const image = tag === "img" && name === "src" && /^(?:data:image\/|blob:)/iu.test(value);
        const anchor = tag === "a" && name === "href" && value.startsWith("#");
        const localAsset = /^(?:\.\/)?(?:assets\/)?[A-Za-z0-9._/-]+(?:[?#][A-Za-z0-9._~!$&'()*+,;=:@%/?-]*)?$/u.test(value)
          && !value.includes("//") && !value.split(/[?#]/u)[0]!.split("/").some((part) => part === "." || part === "..");
        if (!image && !anchor && !localAsset) denied = true;
      }
    }
  } });
  await parser.transform(new Response(html)).text();
  if (denied) throw new Error("PRODUCTION_ARTIFACT_HTML_POLICY_REJECTED");
}

/** Validates the worker-returned, real CLI/conformance evidence against the
 * immutable dist bytes.  It accepts no caller-supplied pass/fail flags and
 * performs no generation, publication, or filesystem writes. */
export class ProductionArtifactVerifier {
  readonly authority = "production-real" as const;

  async verify(input: unknown): Promise<VerifiedProductionArtifact> {
    const facts = Facts.parse(input);
    for (const [index, stage] of Stage.options.entries()) {
      const command = facts.commandEvidence[index]!;
      if (command.name !== stage || command.exitCode !== 0) throw new Error(`PRODUCTION_ARTIFACT_COMMAND_NOT_PASSED:${stage}`);
    }
    const conformance = facts.commandEvidence[6]!.stdout ?? "";
    if (!/\b[1-9][0-9]* passed, 0 failed, [0-9]+ skipped\b/u.test(conformance) || !/\bRESULT: CONFORMANT\b/u.test(conformance)) throw new Error("PRODUCTION_ARTIFACT_CONFORMANCE_REJECTED");
    const dryRun = DryRun.parse(JSON.parse(facts.commandEvidence[7]!.stdout ?? "null"));
    if (dryRun.manifests.some(manifest => manifest.format === "current" || "artifactHash" in manifest)) throw new Error("PRODUCTION_ARTIFACT_CONTRACT_MISMATCH");
    if (facts.publication) {
      const servers = dryRun.manifests[0]!.template.tags.filter(tag => tag[0] === "server");
      if (dryRun.blossomServers.length !== 1 || dryRun.blossomServers[0] !== facts.publication.server || servers.length !== 1 || servers[0]!.length !== 2 || servers[0]![1] !== facts.publication.server) throw new Error("PRODUCTION_ARTIFACT_PUBLICATION_SERVER_MISMATCH");
    }
    const files = await inventory(facts.distRoot); const index = files.find(file => file.path === "index.html");
    if (!index) throw new Error("PRODUCTION_ARTIFACT_OUTPUT_EMPTY");
    await verifyHtml(facts.distRoot, index);
    const manifest = dryRun.manifests[0]!;
    const target = dryRun.plan.items[0]!;
    const names = manifest.template.tags.filter(tag => tag[0] === "d");
    if (manifest.item.target !== target.target || manifest.item.kind !== target.kind || manifest.template.kind !== target.kind
      || (target.target === "root" ? names.length !== 0 : manifest.item.target !== "named" || manifest.item.dTag !== target.dTag || names.length !== 1 || names[0]!.length !== 2 || names[0]![1] !== target.dTag)) throw new Error("PRODUCTION_ARTIFACT_MANIFEST_TARGET_MISMATCH");
    if (manifest.files.length !== files.length || new Set(manifest.files.map(file => file.path)).size !== manifest.files.length) throw new Error("PRODUCTION_ARTIFACT_MANIFEST_FILE_SET_MISMATCH");
    for (const listed of manifest.files) {
      if (!listed.path.startsWith("/") || !safePath(listed.path.slice(1))) throw new Error("PRODUCTION_ARTIFACT_MANIFEST_FILE_INVALID");
      const actual = files.find(file => `/${file.path}` === listed.path); if (!actual || actual.sha256 !== listed.sha256) throw new Error("PRODUCTION_ARTIFACT_MANIFEST_HASH_MISMATCH");
    }
    const aggregateSha256 = sha256(manifest.files.map(file => `${file.sha256} ${file.path}\n`).sort().join(""));
    if (aggregateSha256 !== manifest.aggregateHash) throw new Error("PRODUCTION_ARTIFACT_AGGREGATE_MISMATCH");
    const paths = manifest.template.tags.filter(tag => tag[0] === "path"); const aggregates = manifest.template.tags.filter(tag => tag[0] === "x");
    if (paths.length !== manifest.files.length || paths.some(tag => tag.length !== 3 || !manifest.files.some(file => tag[1] === file.path && tag[2] === file.sha256)) || new Set(paths.map(tag => tag[1])).size !== paths.length || aggregates.length !== 1 || aggregates[0]!.length !== 3 || aggregates[0]![1] !== aggregateSha256 || aggregates[0]![2] !== "aggregate") throw new Error("PRODUCTION_ARTIFACT_MANIFEST_TAG_MISMATCH");
    const sealedObjectSha256 = sha256(JSON.stringify(files));
    const commands = facts.commandEvidence.map(command => ({ name: command.name, exitCode: command.exitCode, ...(command.stdout ? { stdout: sha256(command.stdout) } : {}), ...(command.stderr ? { stderr: sha256(command.stderr) } : {}) }));
    if (facts.edgeCertification && (facts.edgeCertification.provider.toolchainMeasurementSha256 !== facts.edgeCertification.imageToolchain.sha256 || facts.edgeCertification.provider.expiresAtEpochMs <= facts.edgeCertification.provider.observedAtEpochMs || facts.edgeCertification.cgroup.cpuQuotaMicros > facts.edgeCertification.cgroup.cpuPeriodMicros * 2 || facts.edgeCertification.supply.primary.aggregateSha256 !== facts.edgeCertification.supply.secondary.aggregateSha256 || facts.edgeCertification.supply.primary.lockSha256 !== facts.edgeCertification.supply.secondary.lockSha256 || facts.edgeCertification.supply.primary.installed.sha256 !== facts.edgeCertification.supply.secondary.installed.sha256)) throw new Error("PRODUCTION_ARTIFACT_EDGE_CERTIFICATION_REJECTED");
    return Object.freeze({ ...facts, files, aggregateSha256, sealedObjectSha256, verificationEvidenceSha256: sha256(JSON.stringify({ commands, files, aggregateSha256, ...(facts.capabilityReceipt ? { capabilityReceipt: facts.capabilityReceipt } : {}), ...(facts.edgeCertification ? { edgeCertification: facts.edgeCertification } : {}) })) });
  }
}

export { Facts as ProductionArtifactFactsSchema, inventory as inventoryProductionArtifactFiles };
