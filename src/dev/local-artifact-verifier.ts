import { constants } from "node:fs";
import { lstat, open, readdir, realpath } from "node:fs/promises";
import { join, relative, resolve, sep } from "node:path";
import { z } from "zod";

const Digest = z.string().regex(/^[a-f0-9]{64}$/u);
const stages = ["create", "init", "skills", "install", "build", "verify", "conformance", "dry-run"] as const;
const Command = z.object({ name: z.enum(stages), exitCode: z.number().int(), stdout: z.string().max(40_000).optional(), stderr: z.string().max(20_000).optional() }).strict();
const MAX_FILE_BYTES = 2_000_000;
const MAX_OUTPUT_BYTES = 8_000_000;
const MAX_ENTRIES = 256;
export const DEVELOPMENT_ARTIFACT_CSP = "default-src 'none'; script-src 'unsafe-inline'; style-src 'unsafe-inline'; img-src data: blob:; connect-src 'none'; object-src 'none'; base-uri 'none'; form-action 'none'; frame-src 'none'";
export const TrustedCoreArtifactFactsSchema = z.object({
  ownerId: z.string().regex(/^[a-f0-9]{64}$/u), accountId: z.string().min(1), sessionId: z.string().min(1), actionId: z.string().min(1), expectedVersion: z.number().int().nonnegative(),
  proposalSha256: Digest, toolchainSha256: Digest, distRoot: z.string().min(1), commandEvidence: z.array(Command).length(stages.length),
}).strict();
export type TrustedCoreArtifactFacts = z.infer<typeof TrustedCoreArtifactFactsSchema>;
export type ArtifactFileFacts = Readonly<{ path: string; sha256: string; bytes: number }>;
export type VerifiedArtifactFacts = Readonly<Omit<TrustedCoreArtifactFacts, "distRoot"> & { files: readonly ArtifactFileFacts[]; aggregateSha256: string; sealedObjectSha256: string; verificationEvidenceSha256: string; distRoot: string }>;

function digest(value: Uint8Array | string): string { return new Bun.CryptoHasher("sha256").update(value).digest("hex"); }
function validPath(path: string): boolean {
  return path.length <= 256 && /^[A-Za-z0-9._/-]+$/u.test(path) && path.split("/").every((part) => part !== "" && part !== "." && part !== "..");
}
async function boundedRead(absolute: string): Promise<Uint8Array> {
  const handle = await open(absolute, constants.O_RDONLY | constants.O_NOFOLLOW);
  try {
    const stat = await handle.stat();
    if (!stat.isFile() || stat.size > MAX_FILE_BYTES || stat.nlink !== 1) throw new Error("ARTIFACT_FILE_REJECTED");
    // Read at most the statted size plus one byte, even if a file grows during collection.
    const buffer = Buffer.alloc(stat.size + 1); let count = 0;
    while (count < buffer.length) {
      const read = await handle.read(buffer, count, buffer.length - count, count);
      if (read.bytesRead === 0) break;
      count += read.bytesRead;
    }
    if (count !== stat.size) throw new Error("ARTIFACT_FILE_CHANGED");
    return buffer.subarray(0, count);
  } finally { await handle.close(); }
}

/** Re-check immutable bytes at copy/serve boundaries; never serve a stale verified hash. */
export async function readVerifiedArtifactFile(root: string, file: ArtifactFileFacts): Promise<Uint8Array> {
  if (!validPath(file.path) || !Digest.safeParse(file.sha256).success || !Number.isSafeInteger(file.bytes) || file.bytes < 0 || file.bytes > MAX_FILE_BYTES) throw new Error("ARTIFACT_FILE_REJECTED");
  const authority = await realpath(root);
  const target = resolve(authority, file.path);
  const parent = await realpath(resolve(target, ".."));
  if (parent !== authority && !parent.startsWith(`${authority}${sep}`)) throw new Error("ARTIFACT_PATH_REJECTED");
  const body = await boundedRead(target);
  if (body.byteLength !== file.bytes || digest(body) !== file.sha256) throw new Error("ARTIFACT_FILE_HASH_MISMATCH");
  return body;
}

async function collect(root: string): Promise<readonly ArtifactFileFacts[]> {
  const rootStat = await lstat(root);
  if (!rootStat.isDirectory() || rootStat.isSymbolicLink()) throw new Error("ARTIFACT_ROOT_REJECTED");
  const files: ArtifactFileFacts[] = []; let total = 0; let entriesSeen = 0;
  async function visit(current: string, depth: number): Promise<void> {
    if (depth > 8) throw new Error("ARTIFACT_DEPTH_REJECTED");
    const entries = await readdir(current, { withFileTypes: true });
    entriesSeen += entries.length;
    if (entriesSeen > MAX_ENTRIES) throw new Error("ARTIFACT_FILE_COUNT_REJECTED");
    for (const entry of entries.sort((a, b) => a.name < b.name ? -1 : a.name > b.name ? 1 : 0)) {
      const absolute = join(current, entry.name); const stat = await lstat(absolute);
      if (stat.isSymbolicLink() || !(stat.isDirectory() || stat.isFile())) throw new Error("ARTIFACT_SPECIAL_FILE_REJECTED");
      if (stat.isDirectory()) { await visit(absolute, depth + 1); continue; }
      const path = relative(root, absolute).split(sep).join("/");
      if (!validPath(path) || stat.size > MAX_FILE_BYTES || stat.nlink !== 1) throw new Error("ARTIFACT_FILE_REJECTED");
      total += stat.size;
      if (total > MAX_OUTPUT_BYTES) throw new Error("ARTIFACT_OUTPUT_LIMIT_REJECTED");
      const body = await boundedRead(absolute);
      files.push(Object.freeze({ path, sha256: digest(body), bytes: body.byteLength }));
    }
  }
  await visit(root, 0);
  return Object.freeze(files);
}

/** Bounded byte inventory only; this does not confer artifact verification. */
export const collectArtifactFiles = collect;

async function verifyHtmlPolicy(index: string): Promise<void> {
  // The pinned template owns this prefix. Requiring the first real head node
  // prevents an inert comment/script string from masquerading as a CSP.
  const prefix = /^\s*<!doctype html>\s*<html lang="en">\s*<head>\s*/iu.exec(index);
  const meta = `<meta http-equiv="Content-Security-Policy" content="${DEVELOPMENT_ARTIFACT_CSP}">`;
  if (!prefix || !index.slice(prefix[0].length).startsWith(meta)) throw new Error("ARTIFACT_CSP_MISSING");
  let denied = false;
  const parser = new HTMLRewriter().on("*", { element(element) {
    const tag = element.tagName.toLowerCase();
    if (["base", "iframe", "frame", "object", "embed"].includes(tag)) denied = true;
    if (tag === "meta" && element.getAttribute("http-equiv")?.toLowerCase() === "refresh") denied = true;
    for (const [name, value] of element.attributes) {
      if (["src", "href", "srcset", "action", "formaction", "poster", "background", "data", "xlink:href"].includes(name.toLowerCase())) {
        const safeImage = tag === "img" && name === "src" && /^(?:data:image\/|blob:)/iu.test(value);
        const localAnchor = tag === "a" && name === "href" && value.startsWith("#");
        if (!safeImage && !localAnchor) denied = true;
      }
    }
  } });
  await parser.transform(new Response(index)).text();
  if (denied) throw new Error("ARTIFACT_HTML_POLICY_REJECTED");
}

const ManifestFile = z.object({ path: z.string().min(2).max(257), sha256: Digest }).strict();
const DryRunSchema = z.object({
  dryRun: z.literal(true), plan: z.object({ items: z.array(z.object({ kind: z.literal(15129), target: z.literal("root") })).length(1) }),
  manifests: z.array(z.object({ files: z.array(ManifestFile).min(1).max(MAX_ENTRIES), aggregateHash: Digest,
    template: z.object({ kind: z.literal(15129), content: z.string(), tags: z.array(z.array(z.string()).min(1)).max(512) }),
  })).length(1),
});

/** Independently checks final bytes against the actual pinned CLI output. */
export class LocalArtifactVerifier {
  async verify(input: TrustedCoreArtifactFacts): Promise<VerifiedArtifactFacts> {
    const facts = TrustedCoreArtifactFactsSchema.parse(input);
    for (const [index, required] of stages.entries()) {
      const command = facts.commandEvidence[index]!;
      if (command.name !== required || command.exitCode !== 0) throw new Error(`ARTIFACT_COMMAND_NOT_PASSED:${required}`);
    }
    const conformance = facts.commandEvidence[6]!.stdout ?? "";
    if (!/\b[1-9][0-9]* passed, 0 failed, [0-9]+ skipped\b/u.test(conformance) || !/\bRESULT: CONFORMANT\b/u.test(conformance)) throw new Error("ARTIFACT_CONFORMANCE_NOT_PASSED");
    const dry = DryRunSchema.parse(JSON.parse(facts.commandEvidence[7]!.stdout ?? "null"));
    const files = await collect(facts.distRoot);
    const indexFile = files.find((file) => file.path === "index.html");
    if (!indexFile) throw new Error("ARTIFACT_OUTPUT_EMPTY");
    await verifyHtmlPolicy(new TextDecoder("utf-8", { fatal: true }).decode(await readVerifiedArtifactFile(facts.distRoot, indexFile)));
    const manifest = dry.manifests[0]!;
    const listed = manifest.files;
    if (listed.length !== files.length || new Set(listed.map((file) => file.path)).size !== listed.length) throw new Error("ARTIFACT_MANIFEST_FILE_SET_MISMATCH");
    for (const file of listed) {
      if (!file.path.startsWith("/") || !validPath(file.path.slice(1))) throw new Error("ARTIFACT_MANIFEST_FILE_INVALID");
      const actual = files.find((candidate) => `/${candidate.path}` === file.path);
      if (!actual || actual.sha256 !== file.sha256) throw new Error("ARTIFACT_MANIFEST_HASH_MISMATCH");
    }
    // Official @napplet/cli 0.5.2 legacy path-hash algorithm, verified against
    // real dry-run output. No manifest is constructed or published here.
    const aggregateSha256 = digest(listed.map((file) => `${file.sha256} ${file.path}\n`).sort().join(""));
    if (aggregateSha256 !== manifest.aggregateHash) throw new Error("ARTIFACT_AGGREGATE_MISMATCH");
    const pathTags = manifest.template.tags.filter((tag) => tag[0] === "path");
    const aggregateTags = manifest.template.tags.filter((tag) => tag[0] === "x");
    if (pathTags.length !== listed.length || pathTags.some((tag) => tag.length !== 3 || !listed.some((file) => tag[1] === file.path && tag[2] === file.sha256)) || new Set(pathTags.map((tag) => tag[1])).size !== pathTags.length || aggregateTags.length !== 1 || aggregateTags[0]!.length !== 3 || aggregateTags[0]![1] !== aggregateSha256 || aggregateTags[0]![2] !== "aggregate") throw new Error("ARTIFACT_MANIFEST_TAG_MISMATCH");
    const sealedObjectSha256 = digest(JSON.stringify(files));
    const commands = facts.commandEvidence.map((command) => ({ name: command.name, exitCode: command.exitCode, ...(command.stdout ? { stdout: digest(command.stdout) } : {}), ...(command.stderr ? { stderr: digest(command.stderr) } : {}) }));
    const verificationEvidenceSha256 = digest(JSON.stringify({ commands, files, aggregateSha256 }));
    return Object.freeze({ ...facts, files, aggregateSha256, sealedObjectSha256, verificationEvidenceSha256 });
  }
}
