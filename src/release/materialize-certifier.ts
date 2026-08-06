import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { basename, dirname, isAbsolute, join, relative, resolve, sep } from "node:path";
import { canonicalJson, parseReleaseCertificationManifest, type ReleaseCertificationManifest } from "../promotion/schema";

const HEX = /^[a-f0-9]{64}$/iu;
const REVISION = /^(?:[a-f0-9]{40}|[a-f0-9]{64})$/iu;
const allowedInputKeys = new Set(["workspace", "repositoryRoot", "candidateId", "releaseManifest", "topology", "authorization", "source", "secretReferences", "onProviderCall", "onProtectedRunnerCall"]);

type Digest = string;
type PinnedModule = Readonly<{ root: string; modulePath: string; sha256: Digest }>;
export type MaterializedCertifier = Readonly<{
  configPath: string;
  configSha256: Digest;
  releaseProfilePath: string;
  evidenceDirectory: string;
  secretReferencesPath: string;
  adapter: PinnedModule;
  manifestPath: string;
  env: Readonly<{ NAPPLET_CVM_CERTIFIER_CONFIG: string; NAPPLET_CVM_CERTIFIER_CONFIG_SHA256: Digest }>;
}>;
export type MaterializeProtectedCertifierInput = Readonly<{
  workspace: string;
  repositoryRoot: string;
  candidateId: string;
  releaseManifest: unknown;
  topology: Readonly<{ candidateSha256?: string; topologySha256: string; deployment?: unknown }>;
  authorization: Readonly<{ authorizationReceiptSha256: string; authorizationRequestSha256: string }>;
  source: Readonly<{ sourceRevision: string; sourceSha256: string }>;
  secretReferences: Readonly<Record<string, string>>;
  /** Test-only observation seams; production never supplies these callbacks. */
  onProviderCall?: () => void;
  onProtectedRunnerCall?: () => void;
}>;

async function sha256(value: string | Uint8Array): Promise<Digest> {
  const bytes = typeof value === "string" ? new TextEncoder().encode(value) : value;
  const digest = await crypto.subtle.digest("SHA-256", Uint8Array.from(bytes).buffer);
  return Array.from(new Uint8Array(digest), (byte) => byte.toString(16).padStart(2, "0")).join("");
}
const digestJson = (value: unknown) => sha256(canonicalJson(value));
const validDigest = (value: unknown): value is string => typeof value === "string" && HEX.test(value);
const under = (root: string, child: string) => {
  const value = relative(root, child);
  return value !== "" && value !== ".." && !value.startsWith(`..${sep}`) && !isAbsolute(value);
};
async function writeExclusiveCanonical(path: string, content: string): Promise<void> {
  await mkdir(dirname(path), { recursive: true, mode: 0o700 });
  try {
    const existing = await readFile(path, "utf8");
    if (existing !== content) throw new Error("MATERIALIZER_ARTIFACT_MUTATED");
    return;
  } catch (error) {
    if (error instanceof Error && error.message === "MATERIALIZER_ARTIFACT_MUTATED") throw error;
    if (!(error instanceof Error) || !("code" in error) || error.code !== "ENOENT") throw new Error("MATERIALIZER_ARTIFACT_IO_REJECTED");
  }
  const temporary = `${path}.${crypto.randomUUID()}.tmp`;
  try {
    await writeFile(temporary, content, { mode: 0o600, flag: "wx" });
    await rename(temporary, path);
  } catch (error) {
    try {
      const existing = await readFile(path, "utf8");
      if (existing === content) return;
    } catch { /* retain finite error below */ }
    throw error;
  }
}
async function rejectMutatedExistingConfig(configPath: string, adapterPath: string): Promise<void> {
  try {
    const config = JSON.parse(await readFile(configPath, "utf8")) as { adapter?: { sha256?: unknown } };
    if (!validDigest(config.adapter?.sha256) || await sha256(await readFile(adapterPath)) !== config.adapter.sha256.toLowerCase()) {
      throw new Error("MATERIALIZER_ARTIFACT_MUTATED");
    }
  } catch (error) {
    if (error instanceof Error && "code" in error && error.code === "ENOENT") return;
    if (error instanceof Error && error.message === "MATERIALIZER_ARTIFACT_MUTATED") throw error;
    throw new Error("MATERIALIZER_ARTIFACT_MUTATED");
  }
}
function assertInput(input: MaterializeProtectedCertifierInput): ReleaseCertificationManifest {
  if (!input || typeof input !== "object" || Object.keys(input).some((key) => !allowedInputKeys.has(key))) throw new Error("MATERIALIZER_OVERRIDE_REJECTED");
  if (!isAbsolute(input.workspace) || !isAbsolute(input.repositoryRoot) || !validDigest(input.candidateId) || !validDigest(input.topology?.topologySha256)
    || !validDigest(input.authorization?.authorizationReceiptSha256) || !validDigest(input.authorization?.authorizationRequestSha256)
    || !REVISION.test(input.source?.sourceRevision ?? "") || !validDigest(input.source?.sourceSha256)) throw new Error("MATERIALIZER_INPUT_INVALID");
  if (input.topology.candidateSha256 !== undefined && input.topology.candidateSha256.toLowerCase() !== input.candidateId.toLowerCase()) throw new Error("MATERIALIZER_TOPOLOGY_REJECTED");
  const manifest = parseReleaseCertificationManifest(input.releaseManifest);
  if (manifest.sourceRevision !== input.source.sourceRevision.toLowerCase() || manifest.sourceSha256 !== input.source.sourceSha256.toLowerCase()) throw new Error("MATERIALIZER_SOURCE_REJECTED");
  for (const [name, reference] of Object.entries(input.secretReferences ?? {})) {
    if (!/^[a-z][a-z0-9_.-]{0,127}$/u.test(name) || typeof reference !== "string" || !/^[a-z][a-z0-9+._:/-]{0,255}$/iu.test(reference)) throw new Error("MATERIALIZER_SECRET_REFERENCE_REJECTED");
  }
  return manifest;
}

/** Creates only local, candidate-addressed, non-authoritative inputs. It never
 * constructs a provider client, invokes a protected runner, or writes evidence. */
export async function materializeProtectedCertifier(input: MaterializeProtectedCertifierInput): Promise<MaterializedCertifier> {
  const manifest = assertInput(input);
  const workspace = resolve(input.workspace);
  const identity = await digestJson({ candidateId: input.candidateId.toLowerCase(), releaseId: manifest.releaseId, topologySha256: input.topology.topologySha256.toLowerCase(), authorizationReceiptSha256: input.authorization.authorizationReceiptSha256.toLowerCase(), sourceSha256: input.source.sourceSha256.toLowerCase() });
  const root = join(workspace, "certifier-materializations", input.candidateId.toLowerCase(), identity);
  if (!under(workspace, root)) throw new Error("MATERIALIZER_WORKSPACE_REJECTED");
  const profilePath = join(root, "release-profile.json");
  const evidenceDirectory = join(root, "evidence");
  const secretReferencesPath = join(root, "secret-references.json");
  const adapterRoot = join(root, "adapters");
  const adapterPath = join(adapterRoot, "protected-adapters.js");
  const configPath = join(root, "certifier.json");
  const manifestPath = join(root, "materialization.json");
  await rejectMutatedExistingConfig(configPath, adapterPath);
  const releaseProfile = { version: 1, candidateId: input.candidateId.toLowerCase(), topologySha256: input.topology.topologySha256.toLowerCase(), authorizationReceiptSha256: input.authorization.authorizationReceiptSha256.toLowerCase(), releaseBinding: manifest };
  const secretReferences = { version: 1, candidateId: input.candidateId.toLowerCase(), references: Object.fromEntries(Object.entries(input.secretReferences).sort(([left], [right]) => left.localeCompare(right))) };
  await writeExclusiveCanonical(profilePath, `${canonicalJson(releaseProfile)}\n`);
  await writeExclusiveCanonical(secretReferencesPath, `${canonicalJson(secretReferences)}\n`);
  await mkdir(evidenceDirectory, { recursive: true, mode: 0o700 });
  const source = resolve(input.repositoryRoot, "src/certification/adapters.ts");
  if (!under(resolve(input.repositoryRoot), source) || basename(source) !== "adapters.ts") throw new Error("MATERIALIZER_ADAPTER_SOURCE_REJECTED");
  const build = await Bun.build({ entrypoints: [source], outdir: adapterRoot, target: "bun", format: "esm", naming: "protected-adapters.js", sourcemap: "none", minify: true, write: false });
  if (!build.success) throw new Error("MATERIALIZER_ADAPTER_BUNDLE_REJECTED");
  const output = build.outputs.find((candidate) => candidate.kind === "entry-point");
  if (!output) throw new Error("MATERIALIZER_ADAPTER_BUNDLE_REJECTED");
  const adapterBytes = new Uint8Array(await output.arrayBuffer());
  await writeExclusiveCanonical(adapterPath, new TextDecoder().decode(adapterBytes));
  const adapter: PinnedModule = { root: adapterRoot, modulePath: adapterPath, sha256: await sha256(adapterBytes) };
  const config = {
    version: 1, mode: "protected", releaseProfilePath: profilePath, evidenceDirectory, credentials: "configured", adapter,
    controller: { candidateId: input.candidateId.toLowerCase(), releaseId: manifest.releaseId, topologySha256: input.topology.topologySha256.toLowerCase(), authorizationReceiptSha256: input.authorization.authorizationReceiptSha256.toLowerCase(), sourceRevision: input.source.sourceRevision.toLowerCase(), sourceSha256: input.source.sourceSha256.toLowerCase() },
    secretReferences: { path: secretReferencesPath, sha256: await sha256(await readFile(secretReferencesPath)) },
    generatedArtifacts: { version: 1, materializationId: identity, manifestPath },
  };
  const configText = `${canonicalJson(config)}\n`;
  await writeExclusiveCanonical(configPath, configText);
  const configSha256 = await sha256(configText);
  const artifactManifest = { version: 1, materializationId: identity, candidateId: input.candidateId.toLowerCase(), releaseId: manifest.releaseId, topologySha256: input.topology.topologySha256.toLowerCase(), authorizationReceiptSha256: input.authorization.authorizationReceiptSha256.toLowerCase(), source: input.source, profile: { path: profilePath, sha256: await sha256(await readFile(profilePath)) }, secretReferences: { path: secretReferencesPath, sha256: await sha256(await readFile(secretReferencesPath)) }, adapter, config: { path: configPath, sha256: configSha256 }, evidenceDirectory };
  await writeExclusiveCanonical(manifestPath, `${canonicalJson(artifactManifest)}\n`);
  return Object.freeze({ configPath, configSha256, releaseProfilePath: profilePath, evidenceDirectory, secretReferencesPath, adapter, manifestPath, env: Object.freeze({ NAPPLET_CVM_CERTIFIER_CONFIG: configPath, NAPPLET_CVM_CERTIFIER_CONFIG_SHA256: configSha256 }) });
}

/** Revalidates all controller-produced bytes before a later protected command may use them. */
export async function verifyMaterializedCertifier(value: MaterializedCertifier): Promise<MaterializedCertifier> {
  if (!isAbsolute(value.configPath) || !isAbsolute(value.manifestPath) || !validDigest(value.configSha256) || !under(dirname(dirname(dirname(value.configPath))), value.configPath)) throw new Error("MATERIALIZER_VERIFICATION_REJECTED");
  if (await sha256(await readFile(value.configPath)) !== value.configSha256.toLowerCase()) throw new Error("MATERIALIZER_ARTIFACT_MUTATED");
  const manifest = JSON.parse(await readFile(value.manifestPath, "utf8")) as { config?: { sha256?: string }; adapter?: PinnedModule };
  if (manifest.config?.sha256 !== value.configSha256 || !manifest.adapter || manifest.adapter.sha256 !== value.adapter.sha256 || await sha256(await readFile(value.adapter.modulePath)) !== value.adapter.sha256) throw new Error("MATERIALIZER_ARTIFACT_MUTATED");
  return value;
}
