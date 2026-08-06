import { lstat, realpath, readFile, stat } from "node:fs/promises";
import { isAbsolute, relative, resolve, sep } from "node:path";
import { pathToFileURL } from "node:url";
import { ProtectedSuiteResultSchema, ProtectedSuiteSchema, type CertificationInputSchema, type ProtectedSuite, type ProtectedSuiteResult, type ReleaseObservationBindingSchema, type WorkerCandidateSchema } from "./contracts";

export { ProtectedSuiteResultSchema } from "./contracts";

export type ProtectedCertificationAdapter = (input: Readonly<{
  suite: ProtectedSuite;
  candidate: import("zod").infer<typeof WorkerCandidateSchema>;
  input: import("zod").infer<typeof CertificationInputSchema>;
  releaseBinding?: import("zod").infer<typeof ReleaseObservationBindingSchema>;
  credentialReference: "configured" | "unavailable";
  verificationDigests?: Readonly<{ reproducibilityEvidenceSha256: string; supplyChainEvidenceSha256: string }>;
}>) => Promise<unknown>;

export type ProtectedVerificationReference = Readonly<{ relativePath: string; evidenceSha256: string }>;
export type ProtectedVerificationReferences = Readonly<{
  root: string;
  reproducibility: ProtectedVerificationReference;
  supplyChain: ProtectedVerificationReference;
}>;

export type ProtectedCertificationAdapterRegistry = Readonly<{
  /** Fixture registries must use deterministic. Only digest-verified local modules may use protected_live. */
  evidenceClass: "deterministic" | "protected_live";
  adapters: Readonly<Partial<Record<ProtectedSuite, ProtectedCertificationAdapter>>>;
}>;

/** The materializer bundles this project-owned entrypoint.  It deliberately
 * contains no provider client: protected execution injects authenticated
 * adapters only after its independent profile and root checks have passed. */
export const protectedCertificationAdapters: ProtectedCertificationAdapterRegistry = Object.freeze({
  evidenceClass: "protected_live",
  adapters: Object.freeze({}),
});

const containment = (root: string, child: string): boolean => {
  const value = relative(root, child);
  return value !== "" && !value.startsWith(`..${sep}`) && value !== ".." && !isAbsolute(value);
};

async function assertNoSymlinkComponents(root: string, file: string): Promise<void> {
  const components = relative(root, file).split(sep);
  let current = root;
  for (const component of components) {
    current = resolve(current, component);
    if ((await lstat(current)).isSymbolicLink()) throw new Error("CERTIFICATION_ADAPTER_SYMLINK_REJECTED");
  }
}

async function sha256Bytes(value: Uint8Array): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", value);
  return Array.from(new Uint8Array(digest), (byte) => byte.toString(16).padStart(2, "0")).join("");
}

async function readProtectedRecord(root: string, reference: ProtectedVerificationReference): Promise<unknown> {
  if (!isAbsolute(root) || !/^[a-f0-9]{64}$/iu.test(reference.evidenceSha256)
    || !reference.relativePath || isAbsolute(reference.relativePath) || reference.relativePath.split(/[\\/]/u).includes("..")) {
    throw new Error("CERTIFICATION_RECORD_CONFIGURATION_INVALID");
  }
  const rawRoot = resolve(root);
  if ((await lstat(rawRoot)).isSymbolicLink()) throw new Error("CERTIFICATION_RECORD_SYMLINK_REJECTED");
  const canonicalRoot = await realpath(rawRoot);
  if (!(await stat(canonicalRoot)).isDirectory()) throw new Error("CERTIFICATION_RECORD_ROOT_INVALID");
  const rawCandidate = resolve(rawRoot, reference.relativePath);
  if (!containment(rawRoot, rawCandidate)) throw new Error("CERTIFICATION_RECORD_PATH_REJECTED");
  await assertNoSymlinkComponents(rawRoot, rawCandidate);
  const candidate = resolve(canonicalRoot, relative(rawRoot, rawCandidate));
  if (!containment(canonicalRoot, candidate) || !(await stat(candidate)).isFile()) throw new Error("CERTIFICATION_RECORD_PATH_REJECTED");
  const bytes = await readFile(candidate);
  if (await sha256Bytes(bytes) !== reference.evidenceSha256.toLowerCase()) throw new Error("CERTIFICATION_RECORD_DIGEST_INVALID");
  try { return JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(bytes)); }
  catch { throw new Error("CERTIFICATION_RECORD_JSON_INVALID"); }
}

/** Reads only two profile-named immutable records. This is deliberately not a
 * directory scanner: a generic adapter cannot discover or replace release inputs. */
export async function loadProtectedVerificationRecords(references: ProtectedVerificationReferences): Promise<Readonly<{ reproducibility: unknown; supplyChain: unknown }>> {
  try {
    return { reproducibility: await readProtectedRecord(references.root, references.reproducibility), supplyChain: await readProtectedRecord(references.root, references.supplyChain) };
  } catch (error) {
    if (error instanceof Error && /^CERTIFICATION_RECORD_[A-Z_]+$/u.test(error.message)) throw error;
    throw new Error("CERTIFICATION_RECORD_LOAD_REJECTED");
  }
}

/** Loads only a profile-pinned, regular module under a non-symlink trusted
 * root. Error values are intentionally finite: callers never receive a path
 * or the module bytes to log or persist. */
export async function loadProtectedCertificationAdapterRegistry(input: Readonly<{ root: string; modulePath: string; sha256: string }>): Promise<ProtectedCertificationAdapterRegistry> {
  try {
    if (!isAbsolute(input.root) || !isAbsolute(input.modulePath) || input.modulePath.split(sep).includes("..") || !/^[a-f0-9]{64}$/iu.test(input.sha256)) throw new Error("CERTIFICATION_ADAPTER_CONFIGURATION_INVALID");
    if ((await lstat(input.root)).isSymbolicLink()) throw new Error("CERTIFICATION_ADAPTER_SYMLINK_REJECTED");
    const rawRoot = resolve(input.root);
    const canonicalRoot = await realpath(input.root);
    if (!(await stat(canonicalRoot)).isDirectory()) throw new Error("CERTIFICATION_ADAPTER_ROOT_INVALID");
    const rawCandidate = resolve(input.modulePath);
    if (!containment(rawRoot, rawCandidate)) throw new Error("CERTIFICATION_ADAPTER_PATH_REJECTED");
    await assertNoSymlinkComponents(rawRoot, rawCandidate);
    const candidate = resolve(canonicalRoot, relative(rawRoot, rawCandidate));
    if (!containment(canonicalRoot, candidate)) throw new Error("CERTIFICATION_ADAPTER_PATH_REJECTED");
    if (!(await stat(candidate)).isFile()) throw new Error("CERTIFICATION_ADAPTER_FILE_INVALID");
    const bytes = await readFile(candidate);
    if (await sha256Bytes(bytes) !== input.sha256.toLowerCase()) throw new Error("CERTIFICATION_ADAPTER_DIGEST_INVALID");
    let imported: { protectedCertificationAdapters?: unknown };
    try { imported = await import(`${pathToFileURL(candidate).href}?sha256=${input.sha256.toLowerCase()}`) as { protectedCertificationAdapters?: unknown }; }
    catch { throw new Error("CERTIFICATION_ADAPTER_EXPORT_INVALID"); }
    const registry = imported.protectedCertificationAdapters;
    if (!registry || typeof registry !== "object" || Array.isArray(registry)) throw new Error("CERTIFICATION_ADAPTER_EXPORT_INVALID");
    const record = registry as Record<string, unknown>;
    if (record.evidenceClass !== "protected_live" || !record.adapters || typeof record.adapters !== "object" || Array.isArray(record.adapters)) throw new Error("CERTIFICATION_ADAPTER_EXPORT_INVALID");
    for (const [suite, adapter] of Object.entries(record.adapters)) {
      ProtectedSuiteSchema.parse(suite);
      if (typeof adapter !== "function") throw new Error("CERTIFICATION_ADAPTER_EXPORT_INVALID");
    }
    return { evidenceClass: "protected_live", adapters: record.adapters as ProtectedCertificationAdapterRegistry["adapters"] };
  } catch (error) {
    if (error instanceof Error && /^CERTIFICATION_ADAPTER_[A-Z_]+$/u.test(error.message)) throw error;
    throw new Error("CERTIFICATION_ADAPTER_LOAD_REJECTED");
  }
}

export function parseProtectedSuiteResult(value: unknown): ProtectedSuiteResult {
  return ProtectedSuiteResultSchema.parse(value);
}
