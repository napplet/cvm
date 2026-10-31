import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { dirname, isAbsolute, join, relative, resolve, sep } from "node:path";
import { canonicalJson } from "../promotion/schema";
import { ReleaseAuthorizationRequestSchema } from "./authorization";
import { NonGoogleAuthorizationRequestV3Schema } from "./contracts";
import {
  assertSuccessorGraphPreapprovalHeld,
  createProductSuccessorGraphInventory,
  createSuccessorRoleCostBound,
  type CostEvidenceArtifactResolver,
  type SuccessorGraphInventory,
  type SuccessorRoleCostFact,
  type SuccessorRoleCostBound,
} from "./costs/non-google-cost-bound";
import type { NonGoogleModelCostCatalogPort } from "./costs/production-catalog";
import { createNonGoogleDeploymentReviewConfig } from "./deployment/config";
import type { PreparedCollectorImage } from "./collector-image";

const DIGEST = /^[a-f0-9]{64}$/iu;
const REVISION = /^(?:[a-f0-9]{40}|[a-f0-9]{64})$/iu;
const REFERENCE = /^[a-z][a-z0-9_.-]{0,127}$/u;
const allowedInputKeys = new Set(["workspace", "repositoryRoot", "candidateId", "source", "topology", "catalog", "authorization", "publicSettings", "opaqueReferenceNames", "factory", "collector"]);

type Digest = string;
type PinnedFile = Readonly<{ path: string; sha256: Digest }>;
export type PreapprovalMaterialization = Readonly<{
  version: 1;
  materializationId: Digest;
  artifactPath: string;
  artifactSha256: Digest;
  factory: Readonly<{ root: string; module: PinnedFile; config: PinnedFile }>;
  collector: PreparedCollectorImage;
}>;
export type MaterializePreapprovalInput = Readonly<{
  workspace: string;
  repositoryRoot: string;
  candidateId: string;
  source: Readonly<{ sourceRevision: string; sourceSha256: string }>;
  topology: Readonly<{ candidateSha256: string; topologySha256: string }>;
  catalog: Readonly<{ catalogSha256: string; topologySha256: string }>;
  /** Immutable review facts from the controller's no-effect request. These
   * are hashes/bounds only: consent receipts and credentials never enter this
   * preapproval artifact. */
  authorization: Readonly<{
    authorizationRequestSha256: string;
    controllerStateSha256: string;
    effectPlanSha256: string;
    providerScopesSha256: string;
    maximumAuthorizedCostMicros: number;
    cleanupByMs: number;
    expiresAtMs: number;
  }>;
  publicSettings: Readonly<{ regions: readonly [string, string]; maximumRunDurationMs: number; retentionDays: number }>;
  opaqueReferenceNames: readonly string[];
  /** Local OCI bytes prepared before consent. This remains explicitly
   * `not_uploaded`; no preapproval record can assert registry availability. */
  collector: PreparedCollectorImage;
  factory: Readonly<{ root: string; modulePath: string; moduleSha256: string; configPath: string; configSha256: string }>;
}>;

/** Controller-owned input ports. The normal successor seam reads its facts
 * from this closure; callers can only present prior summaries for comparison. */
export type NonGooglePreapprovalControllerSource = Readonly<{
  readCostFacts(input: Readonly<{ candidateSha256: string; topologySha256: string }>): Promise<readonly SuccessorRoleCostFact[]>;
  modelCatalog?: NonGoogleModelCostCatalogPort;
  evidence: CostEvidenceArtifactResolver;
}>;

/** The successor graph is consumed here, at the same normal preapproval seam
 * that creates inert candidate bytes. It intentionally cannot materialize an
 * authorization request: it remeasures the supplied source artifacts and
 * then returns the specific Plan 67 hold before filesystem materialization,
 * credential lookup, client construction, or any provider call. */
export async function assertNonGooglePreapprovalHeld(input: Readonly<{
  request: unknown;
  deployment?: unknown;
  /** Observations from an earlier controller stage. They are compared with
   * recomputed values and never become successor authority. */
  graph?: SuccessorGraphInventory;
  bound?: SuccessorRoleCostBound;
  nowMs?: number;
  source?: NonGooglePreapprovalControllerSource;
}>): Promise<never> {
  const request = NonGoogleAuthorizationRequestV3Schema.safeParse(input.request);
  if (!request.success) {
    if (ReleaseAuthorizationRequestSchema.safeParse(input.request).success) throw new Error("SUCCESSOR_GRAPH_HISTORICAL_AUTHORITY_QUERY_ONLY");
    throw new Error("SUCCESSOR_GRAPH_REQUEST_INVALID");
  }
  if (!input.graph || !input.bound || !input.source || input.nowMs === undefined) throw new Error("SUCCESSOR_GRAPH_CONTROLLER_SOURCE_REQUIRED");
  const deployment = createNonGoogleDeploymentReviewConfig(input.deployment);
  const graph = await createProductSuccessorGraphInventory({ candidateSha256: request.data.identity.candidateSha256, topologySha256: request.data.identity.topologySha256 });
  const facts = await input.source.readCostFacts({ candidateSha256: graph.candidateSha256, topologySha256: graph.topologySha256 });
  const bound = await createSuccessorRoleCostBound({ graph, facts, modelCatalog: input.source.modelCatalog });
  if (canonicalJson(input.graph) !== canonicalJson(graph)
    || canonicalJson(input.bound) !== canonicalJson(bound)
    || canonicalJson(input.bound.heldRoleIds) !== canonicalJson(bound.heldRoleIds)
    || request.data.identity.candidateSha256 !== graph.candidateSha256
    || request.data.identity.topologySha256 !== graph.topologySha256
    || request.data.binding.roleInventorySha256 !== graph.inventorySha256
    || request.data.binding.roleCostBoundSha256 !== bound.boundSha256
    || deployment.candidateSha256 !== graph.candidateSha256
    || deployment.topologySha256 !== graph.topologySha256
    || deployment.sourceSha256 !== request.data.identity.sourceSha256
    || deployment.configSha256 !== request.data.identity.configSha256
    || deployment.toolchainSha256 !== request.data.identity.toolchainSha256
    || deployment.failureDomainSha256 !== request.data.identity.failureDomainSha256
    || deployment.retentionSha256 !== request.data.identity.retentionSha256
    || deployment.cleanupSha256 !== request.data.identity.cleanupSha256
    || deployment.controllerStateSha256 !== request.data.identity.controllerStateSha256) {
    throw new Error("SUCCESSOR_GRAPH_PREAPPROVAL_BINDING_INVALID");
  }
  return assertSuccessorGraphPreapprovalHeld({
    graph,
    bound,
    nowMs: input.nowMs,
    evidence: input.source.evidence,
  });
}

/** The normal successor materialization seam. The closure is assembled by
 * controller composition; it verifies canonical facts before delegating to
 * the historical byte writer, which remains readable for v2 authorities. */
export function createNonGooglePreapprovalMaterializer(source: NonGooglePreapprovalControllerSource): Readonly<{
  assertHeld(input: Readonly<{
    request: unknown;
    deployment: unknown;
    graph: SuccessorGraphInventory;
    bound: SuccessorRoleCostBound;
    nowMs: number;
  }>): Promise<never>;
  materialize(input: Readonly<{
    materialization: MaterializePreapprovalInput;
    request: unknown;
    deployment: unknown;
    graph: SuccessorGraphInventory;
    bound: SuccessorRoleCostBound;
    nowMs: number;
  }>): Promise<PreapprovalMaterialization>;
}> {
  const assertHeld = async (input: Readonly<{
    request: unknown;
    deployment: unknown;
    graph: SuccessorGraphInventory;
    bound: SuccessorRoleCostBound;
    nowMs: number;
  }>): Promise<never> => assertNonGooglePreapprovalHeld({ ...input, source });
  return Object.freeze({
    assertHeld,
    async materialize(input) {
      await assertHeld(input);
      return materializePreapproval(input.materialization);
    },
  });
}

/** Actual Plan-67 CLI composition: derive an honest all-held successor record
 * from controller-owned bytes, remeasure that local record, and stop before a
 * historical readiness write. It neither selects a backend nor claims a rate. */
export async function prepareNonGoogleSuccessorPreapprovalHold(input: Readonly<{
  candidateSha256: string;
  topologySha256: string;
  sourceSha256: string;
  configSha256: string;
  controllerStateSha256: string;
  sourceBytes: Uint8Array;
  nowMs: number;
}>): Promise<never> {
  if (!validDigest(input.candidateSha256) || !validDigest(input.topologySha256) || !validDigest(input.sourceSha256)
    || !validDigest(input.configSha256) || !validDigest(input.controllerStateSha256)
    || !(input.sourceBytes instanceof Uint8Array) || input.sourceBytes.byteLength < 1 || input.sourceBytes.byteLength > 8 * 1024 * 1024
    || !Number.isSafeInteger(input.nowMs) || input.nowMs < 1) throw new Error("SUCCESSOR_GRAPH_CONTROLLER_INPUT_INVALID");
  const candidateSha256 = input.candidateSha256.toLowerCase();
  const topologySha256 = input.topologySha256.toLowerCase();
  const graph = await createProductSuccessorGraphInventory({ candidateSha256, topologySha256 });
  const sourceDocumentSha256 = await sha256(input.sourceBytes);
  const artifactReference = `evidence:successor-controller:${sourceDocumentSha256}`;
  const sourceUrl = "https://napplet-cvm.invalid/held/successor-controller";
  const evidence = Object.freeze({
    async read(reference: string) {
      if (reference !== artifactReference) throw new Error("SUCCESSOR_GRAPH_CONTROLLER_EVIDENCE_REQUIRED");
      return Object.freeze({ sourceUrl, bytes: new Uint8Array(input.sourceBytes) });
    },
  });
  const facts: readonly SuccessorRoleCostFact[] = graph.roles.map((role) => ({
    roleId: role.roleId,
    effectId: role.effectId,
    costComponentId: role.costComponentId,
    constructorSha256: role.constructorSha256,
    disposition: "unknown_held",
    status: "held",
    provider: role.roleId === "model.openai-responses" ? "openai_responses" : role.roleId,
    holdReason: "Plan 67 has no selected native backend or source-bound usage consumer for this role",
    evidence: {
      artifactReference,
      sourceKind: "unknown",
      sourceUrl,
      sourceArtifactSha256: sourceDocumentSha256,
      sourceDocumentSha256,
      observedAtMs: input.nowMs,
      freshUntilMs: input.nowMs + 60_000,
      currency: "USD",
      fx: { kind: "native_usd", sourceDocumentSha256, numerator: 1, denominator: 1 },
      unit: "controller-record",
      precision: 6,
      scope: "controller-owned successor preparation record; unavailable backend held",
      candidateSha256,
      topologySha256,
    },
  }));
  const source = Object.freeze({ async readCostFacts() { return facts; }, evidence });
  const bound = await createSuccessorRoleCostBound({ graph, facts });
  const toolchainSha256 = await digestJson({ sourceSha256: input.sourceSha256.toLowerCase(), configSha256: input.configSha256.toLowerCase() });
  const failureDomainSha256 = await digestJson({ topologySha256 });
  const retentionSha256 = await digestJson({ retentionDays: 30 });
  const cleanupSha256 = await digestJson({ cleanup: "held-no-backend" });
  const scopesSha256 = await digestJson(graph.roles.map((role) => ({ roleId: role.roleId, effectId: role.effectId })));
  const effectsSha256 = await digestJson({ mode: "held", graphRevision: graph.graphRevision });
  const identity = Object.freeze({ candidateSha256, sourceSha256: input.sourceSha256.toLowerCase(), configSha256: input.configSha256.toLowerCase(), toolchainSha256, topologySha256, failureDomainSha256, retentionSha256, cleanupSha256, controllerStateSha256: input.controllerStateSha256.toLowerCase() });
  const binding = Object.freeze({ providerGraphRevision: "non-google-v1" as const, roleInventorySha256: graph.inventorySha256, roleCostBoundSha256: bound.boundSha256, scopesSha256, effectsSha256 });
  const request = Object.freeze({ kind: "release-authorization-request-v3" as const, version: 3 as const, identity, binding, requestSha256: await digestJson({ identity, binding }) });
  const deployment = Object.freeze({ version: 1 as const, providerGraphRevision: "non-google-v1" as const, ...identity });
  return createNonGooglePreapprovalMaterializer(source).assertHeld({ request, deployment, graph, bound, nowMs: input.nowMs });
}

const validDigest = (value: unknown): value is Digest => typeof value === "string" && DIGEST.test(value);
const under = (root: string, child: string) => {
  const value = relative(root, child);
  return value !== "" && value !== ".." && !value.startsWith(`..${sep}`) && !isAbsolute(value);
};
async function sha256(value: string | Uint8Array): Promise<Digest> {
  const bytes = typeof value === "string" ? new TextEncoder().encode(value) : value;
  const digest = await crypto.subtle.digest("SHA-256", Uint8Array.from(bytes).buffer);
  return Array.from(new Uint8Array(digest), (byte) => byte.toString(16).padStart(2, "0")).join("");
}
const digestJson = (value: unknown) => sha256(canonicalJson(value));

async function writeExclusiveCanonical(path: string, content: string): Promise<void> {
  await mkdir(dirname(path), { recursive: true, mode: 0o700 });
  try {
    const existing = await readFile(path, "utf8");
    if (existing !== content) throw new Error("PREAPPROVAL_ARTIFACT_MUTATED");
    return;
  } catch (error) {
    if (error instanceof Error && error.message === "PREAPPROVAL_ARTIFACT_MUTATED") throw error;
    if (!(error instanceof Error) || !("code" in error) || error.code !== "ENOENT") throw new Error("PREAPPROVAL_ARTIFACT_IO_REJECTED");
  }
  const temporary = `${path}.${crypto.randomUUID()}.tmp`;
  try {
    await writeFile(temporary, content, { mode: 0o600, flag: "wx" });
    await rename(temporary, path);
  } catch (error) {
    try { if (await readFile(path, "utf8") === content) return; } catch { /* surface the bounded write failure */ }
    throw error;
  }
}

async function assertInput(input: MaterializePreapprovalInput): Promise<Readonly<{ workspace: string; repositoryRoot: string; factory: PreapprovalMaterialization["factory"]; collector: PreparedCollectorImage }>> {
  if (!input || typeof input !== "object" || Object.keys(input).some((key) => !allowedInputKeys.has(key))) throw new Error("PREAPPROVAL_INPUT_REJECTED");
  if (!isAbsolute(input.workspace) || !isAbsolute(input.repositoryRoot) || !validDigest(input.candidateId)
    || !REVISION.test(input.source?.sourceRevision ?? "") || !validDigest(input.source?.sourceSha256)
    || !validDigest(input.topology?.candidateSha256) || !validDigest(input.topology?.topologySha256)
    || !validDigest(input.catalog?.catalogSha256) || !validDigest(input.catalog?.topologySha256)
    || !validDigest(input.authorization?.authorizationRequestSha256) || !validDigest(input.authorization?.controllerStateSha256)
    || !validDigest(input.authorization?.effectPlanSha256) || !validDigest(input.authorization?.providerScopesSha256)
    || !Number.isSafeInteger(input.authorization?.maximumAuthorizedCostMicros) || input.authorization.maximumAuthorizedCostMicros <= 0
    || !Number.isSafeInteger(input.authorization?.cleanupByMs) || !Number.isSafeInteger(input.authorization?.expiresAtMs)
    || input.authorization.cleanupByMs <= 0 || input.authorization.expiresAtMs <= input.authorization.cleanupByMs
    || input.topology.candidateSha256.toLowerCase() !== input.candidateId.toLowerCase()
    || input.catalog.topologySha256.toLowerCase() !== input.topology.topologySha256.toLowerCase()) throw new Error("PREAPPROVAL_BINDING_REJECTED");
  const settings = input.publicSettings;
  if (!settings || !Array.isArray(settings.regions) || settings.regions.length !== 2 || settings.regions[0] === settings.regions[1]
    || settings.regions.some((region) => typeof region !== "string" || !/^[a-z][a-z0-9-]{2,63}$/u.test(region))
    || !Number.isSafeInteger(settings.maximumRunDurationMs) || settings.maximumRunDurationMs <= 0 || settings.maximumRunDurationMs > 15 * 60 * 1000
    || settings.retentionDays !== 30) throw new Error("PREAPPROVAL_SETTINGS_REJECTED");
  if (!Array.isArray(input.opaqueReferenceNames) || input.opaqueReferenceNames.length === 0 || input.opaqueReferenceNames.length > 16
    || input.opaqueReferenceNames.some((name) => !REFERENCE.test(name)) || new Set(input.opaqueReferenceNames).size !== input.opaqueReferenceNames.length) throw new Error("PREAPPROVAL_REFERENCE_REJECTED");
  const workspace = resolve(input.workspace); const repositoryRoot = resolve(input.repositoryRoot); const factoryRoot = resolve(input.factory?.root ?? "");
  const modulePath = resolve(input.factory?.modulePath ?? ""); const configPath = resolve(input.factory?.configPath ?? "");
  if (factoryRoot !== repositoryRoot || !under(factoryRoot, modulePath) || !under(factoryRoot, configPath)
    || !validDigest(input.factory?.moduleSha256) || !validDigest(input.factory?.configSha256)
    || await sha256(await readFile(modulePath)) !== input.factory.moduleSha256.toLowerCase()
    || await sha256(await readFile(configPath)) !== input.factory.configSha256.toLowerCase()) throw new Error("PREAPPROVAL_FACTORY_REJECTED");
  const collector = input.collector;
  if (!collector || collector.registryAvailability !== "not_uploaded"
    || typeof collector.plannedRegistryReference !== "string" || !/^[a-z0-9.-]+(?:\/[a-z0-9._-]+)+@sha256:[a-f0-9]{64}$/iu.test(collector.plannedRegistryReference)
    || typeof collector.localOciManifestDigest !== "string" || !/^sha256:[a-f0-9]{64}$/iu.test(collector.localOciManifestDigest)
    || typeof collector.localOciConfigDigest !== "string" || !/^sha256:[a-f0-9]{64}$/iu.test(collector.localOciConfigDigest)
    || !collector.plannedRegistryReference.endsWith(`@${collector.localOciManifestDigest}`)
    || collector.platform?.os !== "linux" || collector.platform.architecture !== "amd64"
    || !validDigest(collector.dockerfileSha256) || !validDigest(collector.collectorConfigSha256) || !validDigest(collector.ociLayoutSha256)
    || !isAbsolute(collector.ociLayoutPath) || !under(workspace, resolve(collector.ociLayoutPath))
    || await sha256(await readFile(collector.ociLayoutPath)) !== collector.ociLayoutSha256.toLowerCase()) throw new Error("PREAPPROVAL_COLLECTOR_REJECTED");
  return Object.freeze({ workspace, repositoryRoot, factory: Object.freeze({ root: factoryRoot, module: Object.freeze({ path: modulePath, sha256: input.factory.moduleSha256.toLowerCase() }), config: Object.freeze({ path: configPath, sha256: input.factory.configSha256.toLowerCase() }) }), collector: Object.freeze({ ...collector, platform: Object.freeze({ ...collector.platform }) }) });
}

/** Creates only inert controller-owned readiness bytes. This intentionally has
 * no authorization, worker, protected-record, evaluator, or terminal-result field. */
export async function materializePreapproval(input: MaterializePreapprovalInput): Promise<PreapprovalMaterialization> {
  const checked = await assertInput(input);
  const identity = await digestJson({
    candidateId: input.candidateId.toLowerCase(), source: { sourceRevision: input.source.sourceRevision.toLowerCase(), sourceSha256: input.source.sourceSha256.toLowerCase() },
    topologySha256: input.topology.topologySha256.toLowerCase(), catalogSha256: input.catalog.catalogSha256.toLowerCase(),
    authorization: input.authorization,
    publicSettings: input.publicSettings, opaqueReferenceNames: [...input.opaqueReferenceNames].sort(),
    factory: { moduleSha256: checked.factory.module.sha256, configSha256: checked.factory.config.sha256 },
    collector: checked.collector,
  });
  const root = join(checked.workspace, "preapproval-materializations", input.candidateId.toLowerCase(), identity);
  if (!under(checked.workspace, root)) throw new Error("PREAPPROVAL_WORKSPACE_REJECTED");
  const artifactPath = join(root, "execution-readiness.json");
  const artifact = {
    version: 1 as const, kind: "execution-readiness" as const, materializationId: identity, candidateId: input.candidateId.toLowerCase(),
    source: { sourceRevision: input.source.sourceRevision.toLowerCase(), sourceSha256: input.source.sourceSha256.toLowerCase() },
    topologySha256: input.topology.topologySha256.toLowerCase(), catalogSha256: input.catalog.catalogSha256.toLowerCase(),
    authorization: { ...input.authorization },
    publicSettings: { regions: [...input.publicSettings.regions], maximumRunDurationMs: input.publicSettings.maximumRunDurationMs, retentionDays: input.publicSettings.retentionDays },
    opaqueReferenceNames: [...input.opaqueReferenceNames].sort(),
    factory: { moduleSha256: checked.factory.module.sha256, configSha256: checked.factory.config.sha256 },
    collector: checked.collector,
  };
  const text = `${canonicalJson(artifact)}\n`;
  await writeExclusiveCanonical(artifactPath, text);
  const materialization = Object.freeze({ version: 1 as const, materializationId: identity, artifactPath, artifactSha256: await sha256(text), factory: checked.factory, collector: checked.collector });
  const requestPath = join(checked.workspace, "preapproval-materializations", input.candidateId.toLowerCase(), "requests", `${input.authorization.authorizationRequestSha256.toLowerCase()}.json`);
  await writeExclusiveCanonical(requestPath, `${canonicalJson({ version: 1, materializationId: materialization.materializationId, artifactPath: materialization.artifactPath, artifactSha256: materialization.artifactSha256 })}\n`);
  return materialization;
}

/** Remeasures the artifact plus its pinned local source files before another
 * controller stage may use the readiness fact. */
export async function verifyPreapprovalMaterialization(value: PreapprovalMaterialization): Promise<PreapprovalMaterialization> {
  if (!value || value.version !== 1 || !validDigest(value.materializationId) || !validDigest(value.artifactSha256)
    || !isAbsolute(value.artifactPath) || !isAbsolute(value.factory?.root) || !under(value.factory.root, value.factory.module.path) || !under(value.factory.root, value.factory.config.path)
    || !validDigest(value.factory.module.sha256) || !validDigest(value.factory.config.sha256)
    || !value.collector || value.collector.registryAvailability !== "not_uploaded" || !validDigest(value.collector.ociLayoutSha256)
    || !isAbsolute(value.collector.ociLayoutPath)) throw new Error("PREAPPROVAL_VERIFICATION_REJECTED");
  const text = await readFile(value.artifactPath, "utf8");
  if (await sha256(text) !== value.artifactSha256.toLowerCase()
    || await sha256(await readFile(value.factory.module.path)) !== value.factory.module.sha256.toLowerCase()
    || await sha256(await readFile(value.factory.config.path)) !== value.factory.config.sha256.toLowerCase()
    || await sha256(await readFile(value.collector.ociLayoutPath)) !== value.collector.ociLayoutSha256.toLowerCase()) throw new Error("PREAPPROVAL_ARTIFACT_MUTATED");
  let artifact: unknown;
  try { artifact = JSON.parse(text); } catch { throw new Error("PREAPPROVAL_ARTIFACT_MUTATED"); }
  if (!artifact || typeof artifact !== "object" || Array.isArray(artifact)) throw new Error("PREAPPROVAL_ARTIFACT_MUTATED");
  const record = artifact as Record<string, unknown>;
  if (record.version !== 1 || record.kind !== "execution-readiness" || record.materializationId !== value.materializationId
    || !(record.factory instanceof Object) || (record.factory as Record<string, unknown>).moduleSha256 !== value.factory.module.sha256 || (record.factory as Record<string, unknown>).configSha256 !== value.factory.config.sha256
    || canonicalJson(record.collector) !== canonicalJson(value.collector)) throw new Error("PREAPPROVAL_ARTIFACT_MUTATED");
  return value;
}

/** Restores the exact local OCI fact selected by the immutable request. A
 * receipt path reads these bytes; it never invokes Docker to recreate them. */
export async function loadPreparedCollectorPreapproval(input: Readonly<{ workspace: string; candidateId: string; authorizationRequestSha256: string }>): Promise<PreparedCollectorImage> {
  if (!isAbsolute(input.workspace) || !validDigest(input.candidateId) || !validDigest(input.authorizationRequestSha256)) throw new Error("PREAPPROVAL_VERIFICATION_REJECTED");
  const workspace = resolve(input.workspace);
  const pointerPath = join(workspace, "preapproval-materializations", input.candidateId.toLowerCase(), "requests", `${input.authorizationRequestSha256.toLowerCase()}.json`);
  let pointer: { version?: unknown; artifactPath?: unknown; artifactSha256?: unknown };
  try { pointer = JSON.parse(await readFile(pointerPath, "utf8")); } catch { throw new Error("PREAPPROVAL_ARTIFACT_UNAVAILABLE"); }
  if (pointer.version !== 1 || typeof pointer.artifactPath !== "string" || !under(workspace, resolve(pointer.artifactPath)) || !validDigest(pointer.artifactSha256)) throw new Error("PREAPPROVAL_ARTIFACT_MUTATED");
  const text = await readFile(pointer.artifactPath, "utf8");
  if (await sha256(text) !== pointer.artifactSha256.toLowerCase()) throw new Error("PREAPPROVAL_ARTIFACT_MUTATED");
  let artifact: { collector?: PreparedCollectorImage; candidateId?: unknown; authorization?: { authorizationRequestSha256?: unknown } };
  try { artifact = JSON.parse(text); } catch { throw new Error("PREAPPROVAL_ARTIFACT_MUTATED"); }
  const collector = artifact.collector;
  if (artifact.candidateId !== input.candidateId.toLowerCase() || artifact.authorization?.authorizationRequestSha256 !== input.authorizationRequestSha256.toLowerCase()
    || !collector || collector.registryAvailability !== "not_uploaded" || !isAbsolute(collector.ociLayoutPath) || !under(workspace, resolve(collector.ociLayoutPath))
    || !validDigest(collector.ociLayoutSha256) || await sha256(await readFile(collector.ociLayoutPath)) !== collector.ociLayoutSha256.toLowerCase()) throw new Error("PREAPPROVAL_ARTIFACT_MUTATED");
  return Object.freeze({ ...collector, platform: Object.freeze({ ...collector.platform }) });
}
