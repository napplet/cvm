import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { basename, dirname, isAbsolute, join, relative, resolve, sep } from "node:path";
import { canonicalJson, parseReleaseCertificationManifest, type ReleaseCertificationManifest } from "../promotion/schema";

const HEX = /^[a-f0-9]{64}$/iu;
const REVISION = /^(?:[a-f0-9]{40}|[a-f0-9]{64})$/iu;
const allowedInputKeys = new Set(["workspace", "repositoryRoot", "candidateId", "releaseManifest", "topology", "authorization", "source", "secretReferences", "workerSelection", "nowMs", "onProviderCall", "onProtectedRunnerCall"]);

type Digest = string;
type PinnedModule = Readonly<{ root: string; modulePath: string; sha256: Digest }>;
export type MaterializedCertifier = Readonly<{
  configPath: string;
  configSha256: Digest;
  releaseProfilePath: string;
  evidenceDirectory: string;
  secretReferencesPath: string;
  adapter: PinnedModule;
  releaseExecution: Readonly<{ root: string; modulePath: string; sha256: Digest; configPath: string; configSha256: Digest }>;
  manifestPath: string;
  env: Readonly<{ NAPPLET_CVM_CERTIFIER_CONFIG: string; NAPPLET_CVM_CERTIFIER_CONFIG_SHA256: Digest }>;
}>;
export type FinalizedProtectedTrustRoot = Readonly<{
  configPath: string;
  configSha256: Digest;
  trustRoot: PinnedModule;
  materialPath: string;
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
  /** A controller may name a worker only after the same candidate/topology
   * comparison cohort has passed and remains fresh. */
  workerSelection?: Readonly<{
    provider: "modal" | "fly";
    status: "selected";
    candidateSha256: string;
    topologySha256: string;
    selectionEvidenceSha256: string;
    observedAtMs: number;
    expiresAtMs: number;
  }>;
  nowMs?: number;
  /** Test-only observation seams; production never supplies these callbacks. */
  onProviderCall?: () => void;
  onProtectedRunnerCall?: () => void;
}>;
export type FinalizeProtectedTrustRootInput = Readonly<{
  materialized: MaterializedCertifier;
  workspace: string;
  repositoryRoot: string;
  candidateId: string;
  releaseManifest: unknown;
  topologySha256: string;
  authorizationReceiptSha256: string;
  sourceArchive: Readonly<{ root: string; relativePath: string; canonicalSourceReference: string; sourceRevision: string; sourceSha256: string }>;
  observations: readonly unknown[];
  reproducibilityRecord: unknown;
  supplyChainRecord: unknown;
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
  if (input.workerSelection) {
    const selected = input.workerSelection;
    if (selected.status !== "selected" || !["modal", "fly"].includes(selected.provider)
      || !validDigest(selected.candidateSha256) || !validDigest(selected.topologySha256) || !validDigest(selected.selectionEvidenceSha256)
      || selected.candidateSha256.toLowerCase() !== input.candidateId.toLowerCase()
      || selected.topologySha256.toLowerCase() !== input.topology.topologySha256.toLowerCase()
      || !Number.isInteger(selected.observedAtMs) || !Number.isInteger(selected.expiresAtMs)
      || selected.expiresAtMs <= (input.nowMs ?? Date.now()) || selected.expiresAtMs <= selected.observedAtMs) {
      throw new Error("MATERIALIZER_WORKER_SELECTION_REJECTED");
    }
  }
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
  const executionRoot = join(root, "execution");
  const executionPath = join(executionRoot, "release-execution.mjs");
  const configPath = join(root, "certifier.json");
  const manifestPath = join(root, "materialization.json");
  await rejectMutatedExistingConfig(configPath, adapterPath);
  const releaseProfile = {
    version: 1,
    candidate: { id: input.candidateId.toLowerCase(), image: `napplet-cvm/worker@sha256:${manifest.inputs.workerImageDigest}`, sourceSha256: input.source.sourceSha256.toLowerCase() },
    // The worker identity is supplied only by fresh, passed, same-run evidence;
    // do not replace this with a provider default.
    worker: input.workerSelection
      ? { selection: "selected", provider: input.workerSelection.provider, evidenceSha256: input.workerSelection.selectionEvidenceSha256, observedAtMs: input.workerSelection.observedAtMs, expiresAtMs: input.workerSelection.expiresAtMs }
      : { selection: "unselected", reasonCode: "PROTECTED_EVIDENCE_REQUIRED" },
    datasetSha256: manifest.inputs.datasetSha256,
    topologySha256: input.topology.topologySha256.toLowerCase(),
    authorizationReceiptSha256: input.authorization.authorizationReceiptSha256.toLowerCase(),
    releaseBinding: manifest,
  };
  const secretReferences = { version: 1, candidateId: input.candidateId.toLowerCase(), references: Object.fromEntries(Object.entries(input.secretReferences).sort(([left], [right]) => left.localeCompare(right))) };
  await writeExclusiveCanonical(profilePath, `${canonicalJson(releaseProfile)}\n`);
  await writeExclusiveCanonical(secretReferencesPath, `${canonicalJson(secretReferences)}\n`);
  await mkdir(evidenceDirectory, { recursive: true, mode: 0o700 });
  const source = resolve(input.repositoryRoot, "src/certification/live/registry.ts");
  if (!under(resolve(input.repositoryRoot), source) || basename(source) !== "registry.ts") throw new Error("MATERIALIZER_ADAPTER_SOURCE_REJECTED");
  const build = await Bun.build({ entrypoints: [source], outdir: adapterRoot, target: "bun", format: "esm", naming: "protected-adapters.js", sourcemap: "none", minify: true, write: false });
  if (!build.success) throw new Error("MATERIALIZER_ADAPTER_BUNDLE_REJECTED");
  const output = build.outputs.find((candidate) => candidate.kind === "entry-point");
  if (!output) throw new Error("MATERIALIZER_ADAPTER_BUNDLE_REJECTED");
  const adapterBytes = new Uint8Array(await output.arrayBuffer());
  await writeExclusiveCanonical(adapterPath, new TextDecoder().decode(adapterBytes));
  const adapter: PinnedModule = { root: adapterRoot, modulePath: adapterPath, sha256: await sha256(adapterBytes) };
  const factoryPath = resolve(input.repositoryRoot, "src/release/deployment/factory.ts");
  const productionFactoryPath = resolve(input.repositoryRoot, "src/release/deployment/production-factory.ts");
  if (!under(resolve(input.repositoryRoot), factoryPath) || !under(resolve(input.repositoryRoot), productionFactoryPath)) throw new Error("MATERIALIZER_FACTORY_SOURCE_REJECTED");
  /** The generated module contains only repository-owned source locations and
   * inert config input. It never serializes credentials or provider payloads. */
  const executionSource = [
    `import { createReleaseExecutionSession as createSession } from ${JSON.stringify(factoryPath)};`,
    `export { releaseReadiness, assessProductionFactoryReadiness } from ${JSON.stringify(productionFactoryPath)};`,
    "export function createReleaseExecutionSession(input) { return createSession(input); }",
    "",
  ].join("\n");
  await writeExclusiveCanonical(executionPath, executionSource);
  const executionSha256 = await sha256(executionSource);
  const deploymentConfigPath = join(executionRoot, "deployment.json");
  const deploymentConfig = {
    version: 1, candidateSha256: input.candidateId.toLowerCase(), sourceRevision: input.source.sourceRevision.toLowerCase(), workspaceRoot: workspace,
    factoryModuleSha256: executionSha256, publicSettings: { regions: ["europe-west1", "us-central1"] }, secretReferences: Object.fromEntries(Object.entries(input.secretReferences).sort(([left], [right]) => left.localeCompare(right))),
  };
  const deploymentConfigText = `${canonicalJson(deploymentConfig)}\n`;
  await writeExclusiveCanonical(deploymentConfigPath, deploymentConfigText);
  const deploymentConfigSha256 = await sha256(deploymentConfigText);
  const releaseExecution = { root: executionRoot, modulePath: executionPath, sha256: executionSha256, configPath: deploymentConfigPath, configSha256: deploymentConfigSha256 } as const;
  const config = {
    version: 1, mode: "protected", releaseProfilePath: profilePath, evidenceDirectory, credentials: "configured", adapter,
    controller: { candidateId: input.candidateId.toLowerCase(), releaseId: manifest.releaseId, topologySha256: input.topology.topologySha256.toLowerCase(), authorizationReceiptSha256: input.authorization.authorizationReceiptSha256.toLowerCase(), sourceRevision: input.source.sourceRevision.toLowerCase(), sourceSha256: input.source.sourceSha256.toLowerCase() },
    secretReferences: { path: secretReferencesPath, sha256: await sha256(await readFile(secretReferencesPath)) },
    releaseExecution,
    generatedArtifacts: { version: 1, materializationId: identity, manifestPath },
  };
  const configText = `${canonicalJson(config)}\n`;
  await writeExclusiveCanonical(configPath, configText);
  const configSha256 = await sha256(configText);
  const artifactManifest = { version: 1, materializationId: identity, candidateId: input.candidateId.toLowerCase(), releaseId: manifest.releaseId, topologySha256: input.topology.topologySha256.toLowerCase(), authorizationReceiptSha256: input.authorization.authorizationReceiptSha256.toLowerCase(), source: input.source, profile: { path: profilePath, sha256: await sha256(await readFile(profilePath)) }, secretReferences: { path: secretReferencesPath, sha256: await sha256(await readFile(secretReferencesPath)) }, adapter, releaseExecution, config: { path: configPath, sha256: configSha256 }, evidenceDirectory };
  await writeExclusiveCanonical(manifestPath, `${canonicalJson(artifactManifest)}\n`);
  return Object.freeze({ configPath, configSha256, releaseProfilePath: profilePath, evidenceDirectory, secretReferencesPath, adapter, releaseExecution, manifestPath, env: Object.freeze({ NAPPLET_CVM_CERTIFIER_CONFIG: configPath, NAPPLET_CVM_CERTIFIER_CONFIG_SHA256: configSha256 }) });
}

/** Revalidates all controller-produced bytes before a later protected command may use them. */
export async function verifyMaterializedCertifier(value: MaterializedCertifier): Promise<MaterializedCertifier> {
  if (!isAbsolute(value.configPath) || !isAbsolute(value.manifestPath) || !validDigest(value.configSha256) || !under(dirname(dirname(dirname(value.configPath))), value.configPath)) throw new Error("MATERIALIZER_VERIFICATION_REJECTED");
  if (await sha256(await readFile(value.configPath)) !== value.configSha256.toLowerCase()) throw new Error("MATERIALIZER_ARTIFACT_MUTATED");
  const manifest = JSON.parse(await readFile(value.manifestPath, "utf8")) as { config?: { sha256?: string }; adapter?: PinnedModule; releaseExecution?: { sha256?: string; configSha256?: string } };
  if (manifest.config?.sha256 !== value.configSha256 || !manifest.adapter || manifest.adapter.sha256 !== value.adapter.sha256 || await sha256(await readFile(value.adapter.modulePath)) !== value.adapter.sha256
    || manifest.releaseExecution?.sha256 !== value.releaseExecution.sha256 || manifest.releaseExecution.configSha256 !== value.releaseExecution.configSha256
    || await sha256(await readFile(value.releaseExecution.modulePath)) !== value.releaseExecution.sha256 || await sha256(await readFile(value.releaseExecution.configPath)) !== value.releaseExecution.configSha256) throw new Error("MATERIALIZER_ARTIFACT_MUTATED");
  return value;
}

function recordDigest(record: Record<string, unknown>): Promise<string> {
  const { evidenceSha256: _evidenceSha256, ...contents } = record;
  return digestJson(contents);
}
function expectedRecord(record: unknown, candidateId: string, binding: ReleaseCertificationManifest, status: "passed" | "verified"): record is Record<string, unknown> {
  if (!record || typeof record !== "object" || Array.isArray(record)) return false;
  const value = record as Record<string, unknown>;
  return value.version === 1 && value.evidenceClass === "protected_live" && value.status === status
    && value.candidateId === candidateId && validDigest(value.evidenceSha256)
    && (status !== "passed" || canonicalJson(value.releaseBinding) === canonicalJson(binding));
}
async function assertEvidence(input: FinalizeProtectedTrustRootInput, manifest: ReleaseCertificationManifest): Promise<void> {
  if (!Array.isArray(input.observations) || input.observations.length === 0
    || !input.observations.every((value) => expectedRecord(value, input.candidateId, manifest, "passed"))) throw new Error("MATERIALIZER_TRUST_EVIDENCE_REJECTED");
  const bindingSha256 = await digestJson(manifest);
  for (const record of [input.reproducibilityRecord, input.supplyChainRecord]) {
    if (!record || typeof record !== "object" || Array.isArray(record)) throw new Error("MATERIALIZER_TRUST_EVIDENCE_REJECTED");
    const value = record as Record<string, unknown>;
    if (!expectedRecord(value, input.candidateId, manifest, "verified") || value.releaseBindingSha256 !== bindingSha256 || await recordDigest(value) !== value.evidenceSha256) throw new Error("MATERIALIZER_TRUST_EVIDENCE_REJECTED");
  }
  for (const observation of input.observations as Record<string, unknown>[]) {
    if (await recordDigest(observation) !== observation.evidenceSha256) throw new Error("MATERIALIZER_TRUST_EVIDENCE_REJECTED");
  }
}
async function assertSourceArchive(input: FinalizeProtectedTrustRootInput, manifest: ReleaseCertificationManifest): Promise<void> {
  const archive = input.sourceArchive;
  if (!isAbsolute(archive.root) || !archive.relativePath || isAbsolute(archive.relativePath) || archive.relativePath.split(/[\\/]/u).includes("..")
    || !REVISION.test(archive.sourceRevision) || !validDigest(archive.sourceSha256) || archive.sourceRevision.toLowerCase() !== manifest.sourceRevision || archive.sourceSha256.toLowerCase() !== manifest.sourceSha256) throw new Error("MATERIALIZER_SOURCE_ARCHIVE_REJECTED");
  const root = resolve(archive.root); const path = resolve(root, archive.relativePath);
  if (!under(root, path) || await sha256(await readFile(path)) !== archive.sourceSha256.toLowerCase()) throw new Error("MATERIALIZER_SOURCE_ARCHIVE_REJECTED");
}

/** Finalization remains local and authority-free: it validates supplied,
 * content-addressed records, remeasures the archive, and emits data for the
 * repository-owned root constructor. It never invokes a provider or suite. */
export async function finalizeProtectedTrustRoot(input: FinalizeProtectedTrustRootInput): Promise<FinalizedProtectedTrustRoot> {
  if (!input || typeof input !== "object" || !isAbsolute(input.workspace) || !isAbsolute(input.repositoryRoot) || !validDigest(input.candidateId)
    || !validDigest(input.topologySha256) || !validDigest(input.authorizationReceiptSha256)) throw new Error("MATERIALIZER_TRUST_INPUT_INVALID");
  const materialized = await verifyMaterializedCertifier(input.materialized);
  const manifest = parseReleaseCertificationManifest(input.releaseManifest);
  const initialConfig = JSON.parse(await readFile(materialized.configPath, "utf8")) as { controller?: Record<string, unknown>; adapter?: PinnedModule; secretReferences?: unknown; releaseProfilePath?: unknown; evidenceDirectory?: unknown; credentials?: unknown };
  if (initialConfig.controller?.candidateId !== input.candidateId.toLowerCase() || initialConfig.controller?.topologySha256 !== input.topologySha256.toLowerCase() || initialConfig.controller?.authorizationReceiptSha256 !== input.authorizationReceiptSha256.toLowerCase() || initialConfig.controller?.releaseId !== manifest.releaseId) throw new Error("MATERIALIZER_TRUST_BINDING_REJECTED");
  await assertEvidence(input, manifest);
  await assertSourceArchive(input, manifest);
  const workspace = resolve(input.workspace);
  const finalId = await digestJson({ preConfigSha256: materialized.configSha256, candidateId: input.candidateId.toLowerCase(), releaseId: manifest.releaseId, topologySha256: input.topologySha256.toLowerCase(), authorizationReceiptSha256: input.authorizationReceiptSha256.toLowerCase(), sourceSha256: manifest.sourceSha256, observations: input.observations, reproducibilityRecord: input.reproducibilityRecord, supplyChainRecord: input.supplyChainRecord });
  const root = join(workspace, "certifier-materializations", input.candidateId.toLowerCase(), finalId, "final");
  if (!under(workspace, root)) throw new Error("MATERIALIZER_WORKSPACE_REJECTED");
  const materialPath = join(root, "trust-material.json");
  const trustRoot = join(root, "trust-root");
  const trustSourcePath = join(root, "trust-root-source.ts");
  const modulePath = join(trustRoot, "release-trust-root.js");
  const configPath = join(root, "certifier.json");
  const manifestPath = join(root, "finalization.json");
  const material = {
    sourceArchiveRoot: resolve(input.sourceArchive.root),
    sourceArchives: [{ canonicalSourceReference: input.sourceArchive.canonicalSourceReference, sourceRevision: input.sourceArchive.sourceRevision.toLowerCase(), relativePath: input.sourceArchive.relativePath, sourceSha256: input.sourceArchive.sourceSha256.toLowerCase() }],
    manifest,
    observations: input.observations,
    reproducibilityRecord: input.reproducibilityRecord,
    supplyChainRecord: input.supplyChainRecord,
  };
  await writeExclusiveCanonical(materialPath, `${canonicalJson(material)}\n`);
  const trustSource = `import { createMaterialBackedReleaseCertificationTrustRoot } from ${JSON.stringify(resolve(input.repositoryRoot, "src/certification/trust.ts"))};\nconst material = ${canonicalJson(material)};\nexport const protectedReleaseCertificationTrustRoot = createMaterialBackedReleaseCertificationTrustRoot(material);\n`;
  await writeExclusiveCanonical(trustSourcePath, trustSource);
  const build = await Bun.build({ entrypoints: [trustSourcePath], outdir: trustRoot, target: "bun", format: "esm", naming: "release-trust-root.js", sourcemap: "none", minify: true, write: false });
  const output = build.outputs.find((candidate) => candidate.kind === "entry-point");
  if (!build.success || !output) throw new Error("MATERIALIZER_TRUST_BUNDLE_REJECTED");
  await writeExclusiveCanonical(modulePath, new TextDecoder().decode(new Uint8Array(await output.arrayBuffer())));
  const pinnedRoot: PinnedModule = { root: trustRoot, modulePath, sha256: await sha256(await readFile(modulePath)) };
  const finalConfig = { version: 1, mode: "protected", releaseProfilePath: initialConfig.releaseProfilePath, evidenceDirectory: initialConfig.evidenceDirectory, credentials: initialConfig.credentials, adapter: initialConfig.adapter, trustRoot: pinnedRoot, controller: initialConfig.controller, secretReferences: initialConfig.secretReferences, generatedArtifacts: { version: 1, materializationId: finalId, manifestPath } };
  const configText = `${canonicalJson(finalConfig)}\n`;
  await writeExclusiveCanonical(configPath, configText);
  const configSha256 = await sha256(configText);
  const finalManifest = { version: 1, finalizationId: finalId, preConfigSha256: materialized.configSha256, material: { path: materialPath, sha256: await sha256(await readFile(materialPath)) }, trustRoot: pinnedRoot, config: { path: configPath, sha256: configSha256 } };
  await writeExclusiveCanonical(manifestPath, `${canonicalJson(finalManifest)}\n`);
  return Object.freeze({ configPath, configSha256, trustRoot: pinnedRoot, materialPath, manifestPath, env: Object.freeze({ NAPPLET_CVM_CERTIFIER_CONFIG: configPath, NAPPLET_CVM_CERTIFIER_CONFIG_SHA256: configSha256 }) });
}
