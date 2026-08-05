import { lstat, readFile, realpath, stat } from "node:fs/promises";
import { isAbsolute, relative, resolve, sep } from "node:path";
import { pathToFileURL } from "node:url";
import { canonicalJson } from "../promotion/schema";

/**
 * The promotion process never treats a candidate-provided digest as an
 * authority decision. Implementations are operator/protected-certifier
 * adapters that resolve and authenticate material from their protected store.
 * Returning anything other than `true` is a verification failure.
 */
export interface ReleaseCertificationTrustRoot {
  verifyManifest(manifest: unknown): Promise<boolean>;
  verifyObservation(observation: unknown): Promise<boolean>;
  verifyReproducibilityRecord(record: unknown): Promise<boolean>;
  verifySupplyChainRecord(record: unknown): Promise<boolean>;
  verifySourceMeasurement(measurement: unknown): Promise<boolean>;
}

export type PinnedProtectedSourceArchive = Readonly<{
  canonicalSourceReference: string;
  sourceRevision?: string;
  relativePath: string;
  sourceSha256: string;
}>;

/** A finite, manifest-derived source fact that a protected root must re-measure. */
export type ReleaseSourceMeasurement = Readonly<{
  version: 1;
  sourceRevision: string;
  sourceSha256: string;
}>;

export type PinnedReleaseCertificationTrustRoot = Readonly<{
  sourceArchiveRoot: string;
  sourceArchives: readonly PinnedProtectedSourceArchive[];
  manifest?: unknown;
  observations?: readonly unknown[];
  reproducibilityRecord?: unknown;
  supplyChainRecord?: unknown;
}>;

const sha256 = async (value: Uint8Array): Promise<string> => {
  const bytes = Uint8Array.from(value);
  const digest = await crypto.subtle.digest("SHA-256", bytes.buffer);
  return Array.from(new Uint8Array(digest), (byte) => byte.toString(16).padStart(2, "0")).join("");
};

const same = (left: unknown, right: unknown): boolean => canonicalJson(left) === canonicalJson(right);

export function releaseSourceMeasurement(source: Readonly<{ sourceRevision: string; sourceSha256: string }>): ReleaseSourceMeasurement {
  if (!/^(?:[a-f0-9]{40}|[a-f0-9]{64})$/iu.test(source.sourceRevision) || !/^[a-f0-9]{64}$/iu.test(source.sourceSha256)) {
    throw new Error("RELEASE_SOURCE_MEASUREMENT_INVALID");
  }
  return { version: 1, sourceRevision: source.sourceRevision.toLowerCase(), sourceSha256: source.sourceSha256.toLowerCase() };
}

const containedBy = (root: string, child: string): boolean => {
  const value = relative(root, child);
  return value !== "" && value !== ".." && !value.startsWith(`..${sep}`) && !isAbsolute(value);
};

async function assertNoSymlinkComponents(root: string, file: string): Promise<void> {
  let current = root;
  for (const component of relative(root, file).split(sep)) {
    current = resolve(current, component);
    if ((await lstat(current)).isSymbolicLink()) throw new Error("TRUST_ROOT_SOURCE_SYMLINK_REJECTED");
  }
}

async function sourceArchiveMatches(root: string, archive: PinnedProtectedSourceArchive, measurement: unknown): Promise<boolean> {
  try {
    if (!isAbsolute(root) || !archive.relativePath || isAbsolute(archive.relativePath) || archive.relativePath.split(/[\\/]/u).includes("..") || (archive.sourceRevision !== undefined && !/^(?:[a-f0-9]{40}|[a-f0-9]{64})$/iu.test(archive.sourceRevision)) || !/^[a-f0-9]{64}$/iu.test(archive.sourceSha256)) return false;
    if (!measurement || typeof measurement !== "object" || Array.isArray(measurement)) return false;
    const record = measurement as Record<string, unknown>;
    const releaseMeasurement = Object.keys(record).length === 3 && record.version === 1 && archive.sourceRevision !== undefined
      && record.sourceRevision === archive.sourceRevision.toLowerCase() && record.sourceSha256 === archive.sourceSha256.toLowerCase();
    const reproducibilityMeasurement = record.canonicalSourceReference === archive.canonicalSourceReference && record.sourceSha256 === archive.sourceSha256.toLowerCase();
    if (!releaseMeasurement && !reproducibilityMeasurement) return false;
    if ((await lstat(root)).isSymbolicLink()) return false;
    const rawRoot = resolve(root);
    const canonicalRoot = await realpath(rawRoot);
    if (!(await stat(canonicalRoot)).isDirectory()) return false;
    const rawSource = resolve(rawRoot, archive.relativePath);
    if (!containedBy(rawRoot, rawSource)) return false;
    await assertNoSymlinkComponents(rawRoot, rawSource);
    const source = resolve(canonicalRoot, relative(rawRoot, rawSource));
    if (!containedBy(canonicalRoot, source) || !(await stat(source)).isFile()) return false;
    return await sha256(await readFile(source)) === archive.sourceSha256.toLowerCase();
  } catch {
    return false;
  }
}

/**
 * Builds a protected-certifier authority from operator-pinned facts. Source
 * measurements are accepted only after this root reads and hashes the exact
 * immutable archive held under its protected store; candidate input merely
 * names a measurement and cannot supply the source bytes or expected result.
 */
export function createPinnedReleaseCertificationTrustRoot(input: PinnedReleaseCertificationTrustRoot): ReleaseCertificationTrustRoot {
  return {
    verifyManifest: async (manifest) => input.manifest !== undefined && same(manifest, input.manifest),
    verifyObservation: async (observation) => input.observations?.some((expected) => same(observation, expected)) ?? false,
    verifyReproducibilityRecord: async (record) => input.reproducibilityRecord !== undefined && same(record, input.reproducibilityRecord),
    verifySupplyChainRecord: async (record) => input.supplyChainRecord !== undefined && same(record, input.supplyChainRecord),
    verifySourceMeasurement: async (measurement) => (await Promise.all(input.sourceArchives.map((archive) => sourceArchiveMatches(input.sourceArchiveRoot, archive, measurement)))).some(Boolean),
  };
}

function isTrustRoot(value: unknown): value is ReleaseCertificationTrustRoot {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const root = value as Record<string, unknown>;
  return ["verifyManifest", "verifyObservation", "verifyReproducibilityRecord", "verifySupplyChainRecord", "verifySourceMeasurement"].every((name) => typeof root[name] === "function");
}

/** Loads only a digest-pinned trust-root module held below an operator-controlled root. */
export async function loadPinnedReleaseCertificationTrustRoot(input: Readonly<{ root: string; modulePath: string; sha256: string }>): Promise<ReleaseCertificationTrustRoot> {
  try {
    if (!isAbsolute(input.root) || !isAbsolute(input.modulePath) || input.modulePath.split(sep).includes("..") || !/^[a-f0-9]{64}$/iu.test(input.sha256)) throw new Error("TRUST_ROOT_CONFIGURATION_INVALID");
    if ((await lstat(input.root)).isSymbolicLink()) throw new Error("TRUST_ROOT_SYMLINK_REJECTED");
    const rawRoot = resolve(input.root);
    const canonicalRoot = await realpath(rawRoot);
    if (!(await stat(canonicalRoot)).isDirectory()) throw new Error("TRUST_ROOT_ROOT_INVALID");
    const rawModule = resolve(input.modulePath);
    if (!containedBy(rawRoot, rawModule)) throw new Error("TRUST_ROOT_PATH_REJECTED");
    await assertNoSymlinkComponents(rawRoot, rawModule);
    const modulePath = resolve(canonicalRoot, relative(rawRoot, rawModule));
    if (!containedBy(canonicalRoot, modulePath) || !(await stat(modulePath)).isFile()) throw new Error("TRUST_ROOT_PATH_REJECTED");
    if (await sha256(await readFile(modulePath)) !== input.sha256.toLowerCase()) throw new Error("TRUST_ROOT_DIGEST_INVALID");
    const loaded = await import(`${pathToFileURL(modulePath).href}?sha256=${input.sha256.toLowerCase()}`) as {
      protectedReleaseCertificationTrustRoot?: unknown;
      protectedReproducibilityTrustRoot?: unknown;
    };
    const trustRoot = loaded.protectedReleaseCertificationTrustRoot ?? loaded.protectedReproducibilityTrustRoot;
    if (!isTrustRoot(trustRoot)) throw new Error("TRUST_ROOT_EXPORT_INVALID");
    return trustRoot;
  } catch (error) {
    if (error instanceof Error && /^TRUST_ROOT_[A-Z_]+$/u.test(error.message)) throw error;
    throw new Error("TRUST_ROOT_LOAD_REJECTED");
  }
}
