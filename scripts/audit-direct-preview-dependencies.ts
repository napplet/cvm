/** Read-only package inspection plus immutable review output. This command
 * never installs, executes package code, updates pins or issues approval. */
import { createHash } from "node:crypto";
import { gunzipSync } from "node:zlib";
import { lstat, mkdir, readFile, readdir, realpath, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { z } from "zod";
import { canonicalJson } from "../src/promotion/schema";

const BASE = "df8408f90635e7c80a73cc5acd6a03df4ff373d9";
const DIRECT = ["@kehto/runtime", "@kehto/shell", "@napplet/core", "@napplet/nap"];
const ADDED = [...DIRECT, "@kehto/acl", "@kehto/firewall"].sort();
const sha = (value: string | Uint8Array) => createHash("sha256").update(value).digest("hex");
const ObjectValue = z.record(z.string(), z.unknown());
const Manifest = z.object({ name: z.string(), version: z.string(), license: z.literal("MIT"),
  scripts: z.record(z.string(), z.string()).optional(), dependencies: z.record(z.string(), z.string()).optional(),
  peerDependencies: z.record(z.string(), z.string()).optional(), peerDependenciesMeta: ObjectValue.optional(),
  repository: z.object({ url: z.enum(["git+https://github.com/kehto/web.git", "git+https://github.com/sandwichfarm/napplet.git"]), type: z.literal("git"), directory: z.string() }).strict(),
}).passthrough();
const projection = (value: z.infer<typeof Manifest>) => ({ name: value.name, version: value.version, license: value.license, repository: value.repository,
  scripts: value.scripts ?? {}, dependencies: value.dependencies ?? {}, peerDependencies: value.peerDependencies ?? {}, peerDependenciesMeta: value.peerDependenciesMeta ?? {} });
const forbidden = new Set(["preinstall", "install", "postinstall", "prepare"]);
function original(path: "package.json" | "bun.lock") {
  const result = Bun.spawnSync(["git", "show", `${BASE}:${path}`], { stdout: "pipe", stderr: "pipe" });
  if (result.exitCode !== 0) throw new Error("PREVIEW_AUDIT_BASE_REQUIRED");
  return result.stdout.toString();
}
async function download(url: string, maximum: number) {
  const parsed = new URL(url);
  if (parsed.origin !== "https://registry.npmjs.org" || parsed.username || parsed.password || parsed.search || parsed.hash) throw new Error("PREVIEW_AUDIT_REGISTRY_REQUIRED");
  const response = await fetch(url, { redirect: "error", signal: AbortSignal.timeout(15_000) });
  if (!response.ok || !response.body) throw new Error(`PREVIEW_AUDIT_REGISTRY_${response.status}`);
  const reader = response.body.getReader(), parts: Uint8Array[] = []; let bytes = 0;
  try {
    for (;;) { const part = await reader.read(); if (part.done) break;
      bytes += part.value.byteLength; if (bytes > maximum) throw new Error("PREVIEW_AUDIT_DOWNLOAD_LIMIT"); parts.push(part.value); }
    return Buffer.concat(parts);
  } catch (error) { await reader.cancel().catch(() => undefined); throw error; }
  finally { reader.releaseLock(); }
}
export async function inspectDirectPreviewDependencyArchive(name: string, compressed: Uint8Array, installedRoot = join("node_modules", name)) {
  const bytes = gunzipSync(compressed, { maxOutputLength: 16 * 1024 * 1024 }), files = [];
  const root = await realpath(installedRoot);
  let manifest: z.infer<typeof Manifest> | undefined, offset = 0, members = 0;
  const names = new Set<string>();
  while (offset + 512 <= bytes.length) {
    const header = bytes.subarray(offset, offset + 512); offset += 512;
    if (header.every(byte => byte === 0)) break;
    if (++members > 2000) throw new Error("PREVIEW_AUDIT_MEMBER_LIMIT");
    const text = (start: number, length: number) => header.subarray(start, start + length).toString("utf8").replace(/\0.*$/su, "").trim();
    const path = text(0, 100), prefix = text(345, 155), sizeText = text(124, 12), checksumText = text(148, 8);
    if (prefix || !/^[0-7]+$/u.test(sizeText) || !/^[0-7]+$/u.test(checksumText)) throw new Error("PREVIEW_AUDIT_TAR_INVALID");
    const checksum = header.reduce((total, byte, index) => total + (index >= 148 && index < 156 ? 32 : byte), 0);
    const size = Number.parseInt(sizeText, 8);
    if (checksum !== Number.parseInt(checksumText, 8) || !Number.isSafeInteger(size) || size < 0 || size > 4 * 1024 * 1024 || offset + size > bytes.length) throw new Error("PREVIEW_AUDIT_TAR_INVALID");
    const content = bytes.subarray(offset, offset + size); offset += Math.ceil(size / 512) * 512;
    if (header[156] === 53) continue; // Directory entries are never materialized.
    if (![0, 48].includes(header[156]!) || !path.startsWith("package/") || path.includes("\\") || path.includes("\0")) throw new Error("PREVIEW_AUDIT_TAR_TYPE_OR_PATH");
    const relative = path.slice(8);
    if (relative.split("/").some(part => !part || part === "." || part === "..") || names.has(relative)) throw new Error("PREVIEW_AUDIT_TAR_PATH");
    names.add(relative);
    const installedPath = join(root, relative), resolved = await realpath(installedPath), stat = await lstat(installedPath);
    if (!resolved.startsWith(`${root}/`) || !stat.isFile() || stat.isSymbolicLink() || stat.size !== size || !content.equals(await readFile(installedPath))) throw new Error(`PREVIEW_AUDIT_INSTALLED_DRIFT:${name}:${relative}`);
    if (relative === "package.json") manifest = Manifest.parse(JSON.parse(content.toString("utf8")));
    files.push({ path: relative, bytes: size, sha256: sha(content) });
  }
  if (!manifest || !files.length) throw new Error("PREVIEW_AUDIT_MANIFEST_REQUIRED");
  let installedCount = 0;
  const inventory = async (directory: string, prefix = ""): Promise<void> => {
    for (const entry of await readdir(directory, { withFileTypes: true })) {
      if (++installedCount > 2000) throw new Error("PREVIEW_AUDIT_INSTALLED_LIMIT");
      const path = `${prefix}${entry.name}`;
      if (entry.isDirectory()) await inventory(join(directory, entry.name), `${path}/`);
      else if (!entry.isFile() || !names.has(path)) throw new Error(`PREVIEW_AUDIT_UNEXPECTED_INSTALLED_FILE:${name}:${path}`);
    }
  };
  await inventory(root);
  files.sort((a, b) => a.path.localeCompare(b.path));
  return { manifest, fileCount: files.length, installedTreeSha256: sha(canonicalJson(files)) };
}

async function audit() {
  const auditScript = await readFile(import.meta.path, "utf8");
  const currentPackage = await readFile("package.json", "utf8"), currentLock = await readFile("bun.lock", "utf8");
  const basePackage = original("package.json"), baseLock = original("bun.lock");
  const pkg = ObjectValue.parse(JSON.parse(currentPackage)), lock = ObjectValue.parse(Bun.JSONC.parse(currentLock));
  const baseline = ObjectValue.parse(Bun.JSONC.parse(baseLock));
  const dependencies = ObjectValue.parse(pkg.dependencies), workspaces = ObjectValue.parse(lock.workspaces), workspace = ObjectValue.parse(workspaces[""]);
  const rootDependencies = ObjectValue.parse(workspace.dependencies), packages = ObjectValue.parse(lock.packages), oldPackages = ObjectValue.parse(baseline.packages);
  const additions = Object.keys(packages).filter(name => !(name in oldPackages)).sort();
  if (canonicalJson(additions) !== canonicalJson(ADDED)) throw new Error("PREVIEW_AUDIT_UNEXPECTED_ADDITIONS");
  const strippedPackage = structuredClone(pkg), strippedDependencies = ObjectValue.parse(strippedPackage.dependencies);
  for (const name of DIRECT) delete strippedDependencies[name];
  strippedPackage.dependencies = strippedDependencies;
  const strippedLock = structuredClone(lock), strippedWorkspaces = ObjectValue.parse(strippedLock.workspaces), strippedRoot = ObjectValue.parse(strippedWorkspaces[""]), strippedRootDependencies = ObjectValue.parse(strippedRoot.dependencies), strippedPackages = ObjectValue.parse(strippedLock.packages);
  for (const name of DIRECT) delete strippedRootDependencies[name];
  for (const name of ADDED) delete strippedPackages[name];
  strippedRoot.dependencies = strippedRootDependencies; strippedWorkspaces[""] = strippedRoot; strippedLock.workspaces = strippedWorkspaces; strippedLock.packages = strippedPackages;
  if (canonicalJson(strippedPackage) !== canonicalJson(JSON.parse(basePackage)) || canonicalJson(strippedLock) !== canonicalJson(baseline)) throw new Error("PREVIEW_AUDIT_EXISTING_GRAPH_CHANGED");
  const observations = [];
  for (const name of ADDED) {
    const tuple = z.tuple([z.string(), z.literal(""), ObjectValue, z.string().regex(/^sha512-/u)]).parse(packages[name]);
    const version = tuple[0].slice(name.length + 1);
    if (tuple[0] !== `${name}@${version}` || !/^\d+\.\d+\.\d+$/u.test(version) || (DIRECT.includes(name) && (dependencies[name] !== version || rootDependencies[name] !== version))) throw new Error("PREVIEW_AUDIT_PIN_REQUIRED");
    const metadataUrl = `https://registry.npmjs.org/${encodeURIComponent(name)}/${version}`, metadataBytes = await download(metadataUrl, 2 * 1024 * 1024);
    const metadata = Manifest.extend({ dist: z.object({ integrity: z.literal(tuple[3]), tarball: z.literal(`https://registry.npmjs.org/${name}/-/${name.split("/")[1]}-${version}.tgz`) }).passthrough() }).parse(JSON.parse(metadataBytes.toString("utf8")));
    if (canonicalJson(metadata.dependencies ?? {}) !== canonicalJson(tuple[2].dependencies ?? {}) || canonicalJson(metadata.peerDependencies ?? {}) !== canonicalJson(tuple[2].peerDependencies ?? {})) throw new Error("PREVIEW_AUDIT_LOCK_METADATA_DRIFT");
    const archive = await download(metadata.dist.tarball, 4 * 1024 * 1024);
    if (`sha512-${createHash("sha512").update(archive).digest("base64")}` !== tuple[3]) throw new Error("PREVIEW_AUDIT_INTEGRITY_MISMATCH");
    const installed = await inspectDirectPreviewDependencyArchive(name, archive);
    if (metadata.name !== name || metadata.version !== version || canonicalJson(projection(metadata)) !== canonicalJson(projection(installed.manifest))) throw new Error("PREVIEW_AUDIT_METADATA_DRIFT");
    if (Object.keys(metadata.scripts ?? {}).some(script => forbidden.has(script))) throw new Error("PREVIEW_AUDIT_LIFECYCLE_REFUSED");
    observations.push({ direct: DIRECT.includes(name), integrity: tuple[3], metadataUrl, metadataSha256: sha(metadataBytes), tarballUrl: metadata.dist.tarball,
      tarballSha256: sha(archive), ...projection(metadata), fileCount: installed.fileCount, installedTreeSha256: installed.installedTreeSha256,
      lifecycleScripts: [], provenanceVerified: false });
  }
  if (currentPackage !== await readFile("package.json", "utf8") || currentLock !== await readFile("bun.lock", "utf8") || auditScript !== await readFile(import.meta.path, "utf8")) throw new Error("PREVIEW_AUDIT_INPUT_CHANGED");
  const report = { schemaVersion: 1, kind: "direct_preview_dependency_review", status: "measured_not_approved", observedAt: new Date().toISOString(), baseRevision: BASE,
    inputs: { auditScriptSha256: sha(auditScript), packageJsonSha256: sha(currentPackage), bunLockSha256: sha(currentLock), basePackageJsonSha256: sha(basePackage), baseBunLockSha256: sha(baseLock) },
    existingDependencyGraphUnchanged: true, observations,
    limitations: ["This is package identity, integrity, installed-byte and lifecycle review material, not approval or release certification.",
      "Registry signatures and source/provenance attestations were not verified; repository claims are recorded metadata.",
      "Installed dependency bytes were inspected without executing package code. This is not a complete vulnerability or security audit.",
      "Existing approval records, root pins, install policy and protected-effect gates remain unchanged."] };
  const evidenceSha256 = sha(canonicalJson(report)), path = `evidence/certification/direct-preview-dependency-reviews/${evidenceSha256}.json`, bytes = `${canonicalJson({ ...report, evidenceSha256 })}\n`;
  await mkdir("evidence/certification/direct-preview-dependency-reviews", { recursive: true });
  try { await writeFile(path, bytes, { flag: "wx" }); }
  catch (error) { if (!(error instanceof Error && "code" in error && error.code === "EEXIST") || await readFile(path, "utf8") !== bytes) throw error; }
  console.log(JSON.stringify({ status: report.status, evidenceSha256, path, packages: observations.length, installedFiles: observations.reduce((total, row) => total + row.fileCount, 0) }));
}
if (import.meta.main) await audit();
