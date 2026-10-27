import { lstat, readFile, realpath } from "node:fs/promises";
import { isAbsolute, relative, resolve, sep } from "node:path";
import { pathToFileURL } from "node:url";

import type { CertifierConfig, PinnedDeploymentExecution } from "../certification/config";
import { PRODUCTION_LIVE_PROTECTED_PORT_KEYS } from "../certification/live/production-ports";
import { PROTECTED_SUITES } from "../certification/runner";
import type { AuthorizedLiveExecutionInput, ReleaseExecutionSession } from "./controller";
import { validateAuthorizationReceipt, validateAuthorizationRequest } from "./authorization";
import { createDeploymentExecutionConfig, type DeploymentExecutionConfig } from "./deployment/config";
import { RELEASE_PRODUCTION_PROVIDER_IDS } from "./native-registry";
import type { SealedFundingFeePolicyProjection } from "./costs/funding-fees";
import { loadProductionConfig, type ProductionConfig } from "../production/config";
import { openProductionGenerationRuntime } from "../production/generation-runtime";
import { createMountedProductionAuthorization } from "../production/mounted-authorization";
import { assembleMountedProductionSession } from "../production/runtime";
import { MountedProductionSecretMaterial } from "../production/secret-material";
import { openProductionPostgresPool } from "../production/postgres";
import { loadPromotedVerificationAuthority, productionReleaseScope } from "../production/release-verification-authority";
import type { ProductionCertificationSessionMaterial } from "./deployment/production-session-material";

export type ReleaseExecutionFactoryInput = Readonly<{
  candidateSha256: string;
  workspace: string;
  deploymentConfig: DeploymentExecutionConfig;
  /** Present only on the live, receipt-bound path. It is supplied by the
   * controller after resolving its immutable receipt record, never by a
   * deployment JSON document or an environment variable. */
  authorization?: Readonly<{ request: unknown; receipt: unknown }>;
}>;

type ReleaseExecutionFactoryModule = Readonly<{
  createReleaseExecutionSession?: (input: ReleaseExecutionFactoryInput) => Promise<unknown> | unknown;
  /** Static, side-effect-free inventory. It proves the pinned factory has
   * every post-receipt input without constructing a provider client. */
  releaseReadiness?: unknown;
  assessProductionFactoryReadiness?: (input: ReleaseExecutionFactoryInput) => unknown;
  /** Sealed, read-only fee policy captured by the same pinned production
   * factory. It contains approved mint/keyset IDs and bounds, never wallet
   * material or a user-selected mint. */
  fundingFeePolicyProjection?: unknown;
}>;

/** Hash-pinned production material constructor. It sees only controller-pinned
 * configuration, the canonical receipt pair, and the mounted runtime—not CLI
 * JSON, raw secrets, or a generic provider callback bag. */
type ProductionRuntimeMaterialFactoryModule = Readonly<{
  createProductionCertificationSessionMaterial?: (input: Readonly<{
    config: ProductionConfig;
    deploymentConfig: DeploymentExecutionConfig;
    generation: Awaited<ReturnType<typeof openProductionGenerationRuntime>>;
    authorization: Readonly<{ request: unknown; receipt: unknown }>;
    secrets: MountedProductionSecretMaterial;
  }>) => Promise<ProductionCertificationSessionMaterial> | ProductionCertificationSessionMaterial;
}>;

function parseFundingFeePolicyProjection(value: unknown): SealedFundingFeePolicyProjection {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("FUNDING_FEE_POLICY_CONSENT_REQUIRED");
  const policy = value as Partial<SealedFundingFeePolicyProjection>;
  if (!Number.isSafeInteger(policy.observedAtMs) || !Number.isSafeInteger(policy.freshUntilMs) || policy.observedAtMs! <= 0 || policy.freshUntilMs! <= policy.observedAtMs!
    || !policy.nwc || !/^(?:0|[1-9][0-9]*)$/u.test(policy.nwc.maximumReceiverFeeSats) || !/^[a-f0-9]{64}$/u.test(policy.nwc.policySha256)
    || !policy.cashu || !Number.isSafeInteger(policy.cashu.maximumProofs) || policy.cashu.maximumProofs < 1 || policy.cashu.maximumProofs > 10_000 || !Array.isArray(policy.cashu.mints) || policy.cashu.mints.length === 0
    || policy.cashu.mints.some(mint => !mint || typeof mint.url !== "string" || !Array.isArray(mint.keysetIds) || mint.keysetIds.length === 0 || mint.keysetIds.some((id: unknown) => typeof id !== "string" || !id))) throw new Error("FUNDING_FEE_POLICY_CONSENT_REQUIRED");
  return Object.freeze({ observedAtMs: policy.observedAtMs!, freshUntilMs: policy.freshUntilMs!, nwc: Object.freeze({ maximumReceiverFeeSats: policy.nwc.maximumReceiverFeeSats, policySha256: policy.nwc.policySha256 }), cashu: Object.freeze({ maximumProofs: policy.cashu.maximumProofs, mints: Object.freeze(policy.cashu.mints.map(mint => Object.freeze({ url: mint.url, keysetIds: Object.freeze([...mint.keysetIds]) }))) }) });
}

export type ReleaseExecutionReadiness = Readonly<{
  providerFamilies: readonly string[];
  protectedSuites: readonly string[];
  materialization: true;
  workerSelection: true;
  protectedVerification: true;
  finalization: true;
  actualCost: true;
  cleanupOwnership: true;
  blockers?: readonly string[];
}>;

function containedBy(root: string, candidate: string): boolean {
  const value = relative(root, candidate);
  return value === "" || (!value.startsWith(`..${sep}`) && value !== "..");
}

async function sha256(bytes: Uint8Array): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", Uint8Array.from(bytes).buffer);
  return Array.from(new Uint8Array(digest), (byte) => byte.toString(16).padStart(2, "0")).join("");
}

function executionModule(config: CertifierConfig): PinnedDeploymentExecution {
  if (config.mode !== "protected" || config.credentials !== "configured" || !config.releaseExecution || !config.controller) {
    throw new Error("RELEASE_PRODUCTION_EXECUTION_CONFIG_REQUIRED");
  }
  return config.releaseExecution;
}

async function readPinnedFile(rootInput: string, pathInput: string, expectedSha256: string): Promise<Readonly<{ root: string; path: string; bytes: Uint8Array }>> {
  const root = resolve(rootInput);
  const path = resolve(pathInput);
  if (!isAbsolute(rootInput) || !isAbsolute(pathInput)) throw new Error("RELEASE_PRODUCTION_EXECUTION_CONFIG_INVALID");
  let actualRoot: string;
  let entry: Awaited<ReturnType<typeof lstat>>;
  try {
    actualRoot = await realpath(root);
    entry = await lstat(path);
  } catch { throw new Error("RELEASE_PRODUCTION_EXECUTION_CONFIG_INVALID"); }
  if (!entry.isFile() || entry.isSymbolicLink()) throw new Error("RELEASE_PRODUCTION_EXECUTION_CONFIG_INVALID");
  let actualPath: string;
  let bytes: Uint8Array;
  try {
    actualPath = await realpath(path);
    bytes = new Uint8Array(await readFile(actualPath));
  } catch { throw new Error("RELEASE_PRODUCTION_EXECUTION_CONFIG_INVALID"); }
  if (!containedBy(actualRoot, actualPath) || await sha256(bytes) !== expectedSha256.toLowerCase()) {
    throw new Error("RELEASE_PRODUCTION_EXECUTION_CONFIG_INVALID");
  }
  return { root: actualRoot, path: actualPath, bytes };
}

async function loadDeploymentConfig(module: PinnedDeploymentExecution, input: Readonly<{ candidateSha256: string; workspace: string; sourceRevision: string }>): Promise<DeploymentExecutionConfig> {
  const file = await readPinnedFile(module.root, module.configPath, module.configSha256);
  let config: DeploymentExecutionConfig;
  try { config = createDeploymentExecutionConfig(JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(file.bytes))); }
  catch { throw new Error("RELEASE_PRODUCTION_EXECUTION_CONFIG_INVALID"); }
  let workspace: string;
  let configWorkspace: string;
  try {
    workspace = await realpath(resolve(input.workspace));
    configWorkspace = await realpath(config.workspaceRoot);
  } catch { throw new Error("RELEASE_PRODUCTION_EXECUTION_CONFIG_INVALID"); }
  if (config.candidateSha256 !== input.candidateSha256.toLowerCase()
    || config.sourceRevision !== input.sourceRevision.toLowerCase()
    || configWorkspace !== workspace
    || config.factoryModuleSha256 !== module.sha256.toLowerCase()
    || !containedBy(configWorkspace, file.root)) {
    throw new Error("RELEASE_PRODUCTION_EXECUTION_CONFIG_INVALID");
  }
  return config;
}

async function importPinnedModule(module: PinnedDeploymentExecution, config: DeploymentExecutionConfig): Promise<ReleaseExecutionFactoryModule> {
  const file = await readPinnedFile(module.root, module.modulePath, module.sha256);
  let configWorkspace: string;
  try { configWorkspace = await realpath(config.workspaceRoot); }
  catch { throw new Error("RELEASE_PRODUCTION_EXECUTION_CONFIG_INVALID"); }
  if (!containedBy(configWorkspace, file.root)) throw new Error("RELEASE_PRODUCTION_EXECUTION_CONFIG_INVALID");
  try {
    return await import(`${pathToFileURL(file.path).href}?sha256=${module.sha256.toLowerCase()}`) as ReleaseExecutionFactoryModule;
  } catch {
    throw new Error("RELEASE_PRODUCTION_EXECUTION_FACTORY_INVALID");
  }
}

async function loadPinnedProductionRuntimeConfig(module: PinnedDeploymentExecution, input: Readonly<{
  candidateSha256: string;
  topologySha256: string;
  deploymentConfig: DeploymentExecutionConfig;
}>): Promise<ProductionConfig> {
  if (!module.runtime) throw new Error("RELEASE_PRODUCTION_RUNTIME_CLOSURE_REQUIRED");
  const closureBytes = new TextEncoder().encode(JSON.stringify({
    configSha256: module.runtime.configSha256.toLowerCase(),
    moduleSha256: module.runtime.sha256.toLowerCase(),
  }));
  const closureHash = await sha256(closureBytes);
  /* `runtimeClosureSha256` lives in the same candidate-bound deployment
   * document as the factory module. A receipt therefore cannot select a new
   * mounted config/module pair after preapproval. */
  if (!input.deploymentConfig.runtimeClosureSha256 || input.deploymentConfig.runtimeClosureSha256 !== closureHash) {
    throw new Error("RELEASE_PRODUCTION_RUNTIME_CLOSURE_BINDING_REQUIRED");
  }
  const file = await readPinnedFile(module.runtime.root, module.runtime.configPath, module.runtime.configSha256);
  let config: ProductionConfig;
  try { config = loadProductionConfig(JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(file.bytes))); }
  catch { throw new Error("RELEASE_PRODUCTION_RUNTIME_CONFIG_INVALID"); }
  if (config.candidateSha256 !== input.candidateSha256.toLowerCase() || config.topologySha256 !== input.topologySha256.toLowerCase()) {
    throw new Error("RELEASE_PRODUCTION_RUNTIME_BINDING_REQUIRED");
  }
  return config;
}

async function importPinnedProductionRuntimeFactory(module: PinnedDeploymentExecution): Promise<ProductionRuntimeMaterialFactoryModule> {
  if (!module.runtime) throw new Error("RELEASE_PRODUCTION_RUNTIME_CLOSURE_REQUIRED");
  const file = await readPinnedFile(module.runtime.root, module.runtime.modulePath, module.runtime.sha256);
  try { return await import(`${pathToFileURL(file.path).href}?sha256=${module.runtime.sha256.toLowerCase()}`) as ProductionRuntimeMaterialFactoryModule; }
  catch { throw new Error("RELEASE_PRODUCTION_RUNTIME_FACTORY_INVALID"); }
}

async function openPinnedMountedSession(input: Readonly<{
  module: PinnedDeploymentExecution;
  deploymentConfig: DeploymentExecutionConfig;
  authorization: Readonly<{ request: unknown; receipt: unknown }>;
  candidateSha256: string;
  topologySha256: string;
}>): Promise<void> {
  const [config, runtimeFactory] = await Promise.all([
    loadPinnedProductionRuntimeConfig(input.module, { candidateSha256: input.candidateSha256, topologySha256: input.topologySha256, deploymentConfig: input.deploymentConfig }),
    importPinnedProductionRuntimeFactory(input.module),
  ]);
  if (typeof runtimeFactory.createProductionCertificationSessionMaterial !== "function") throw new Error("RELEASE_PRODUCTION_RUNTIME_FACTORY_INVALID");
  /* The mounted pair is controller-owned material, but it is still a distinct
   * authority from the receipt record passed to this invocation.  Compare the
   * two before opening the relay, wallet, or other protected transports; a
   * valid receipt for a different mounted request must never activate them. */
  const secrets = new MountedProductionSecretMaterial(config);
  const mountedAuthorization = await createMountedProductionAuthorization({ config, secrets });
  const suppliedRequest = await validateAuthorizationRequest(input.authorization.request);
  const suppliedReceipt = await validateAuthorizationReceipt({ request: suppliedRequest, receipt: input.authorization.receipt, nowMs: Date.now() });
  if (mountedAuthorization.authorizationRequestSha256 !== suppliedRequest.authorizationRequestSha256
    || mountedAuthorization.authorizationReceiptSha256 !== suppliedReceipt.authorizationReceiptSha256) {
    throw new Error("RELEASE_PRODUCTION_RUNTIME_AUTHORIZATION_MOUNT_MISMATCH");
  }
  const authorization = Object.freeze({ request: mountedAuthorization.request, receipt: mountedAuthorization.receipt });
  const generation = await openProductionGenerationRuntime({ config, secrets });
  try {
    const material = await runtimeFactory.createProductionCertificationSessionMaterial({ config, deploymentConfig: input.deploymentConfig, generation, authorization, secrets });
    await assembleMountedProductionSession({ generation, material });
  } catch (error) {
    await generation.close().catch(() => undefined);
    throw error;
  }
}

function isReleaseExecutionSession(value: unknown): value is ReleaseExecutionSession {
  if (!value || typeof value !== "object") return false;
  const session = value as Partial<ReleaseExecutionSession>;
  const keys = Object.keys(session).sort();
  if (!((keys.length === 2 && keys[0] === "prepareAuthorizedExecution" && keys[1] === "registry") || (keys.length === 3 && keys[0] === "collectorImage" && keys[1] === "prepareAuthorizedExecution" && keys[2] === "registry"))) return false;
  if (typeof session.prepareAuthorizedExecution !== "function" || !session.registry || typeof session.registry !== "object" || (session.collectorImage !== undefined && typeof session.collectorImage.uploadAndObserve !== "function")) return false;
  const registry = session.registry as { providers?: unknown; discover?: unknown; plan?: unknown; apply?: unknown; observe?: unknown; cleanup?: unknown };
  if (typeof registry.providers !== "function" || typeof registry.discover !== "function" || typeof registry.plan !== "function" || typeof registry.apply !== "function" || typeof registry.observe !== "function" || typeof registry.cleanup !== "function") return false;
  try {
    const providers = registry.providers();
    return Array.isArray(providers)
      && providers.length === RELEASE_PRODUCTION_PROVIDER_IDS.length
      && providers.every((provider, index) => provider === RELEASE_PRODUCTION_PROVIDER_IDS[index]);
  } catch {
    return false;
  }
}

function parseReleaseExecutionReadiness(value: unknown): ReleaseExecutionReadiness {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("RELEASE_PRODUCTION_EXECUTION_READINESS_INVALID");
  const readiness = value as Partial<ReleaseExecutionReadiness>;
  const providerFamilies = readiness.providerFamilies;
  const protectedSuites = readiness.protectedSuites;
  if (!Array.isArray(providerFamilies) || providerFamilies.length !== RELEASE_PRODUCTION_PROVIDER_IDS.length
    || providerFamilies.some((provider, index) => provider !== RELEASE_PRODUCTION_PROVIDER_IDS[index])
    || !Array.isArray(protectedSuites) || protectedSuites.length !== PROTECTED_SUITES.length
    || protectedSuites.some((suite, index) => suite !== PROTECTED_SUITES[index])
    || readiness.materialization !== true || readiness.workerSelection !== true
    || readiness.protectedVerification !== true || readiness.finalization !== true
    || readiness.actualCost !== true || readiness.cleanupOwnership !== true) {
    throw new Error("RELEASE_PRODUCTION_EXECUTION_READINESS_INVALID");
  }
  return Object.freeze({
    providerFamilies: Object.freeze([...providerFamilies]),
    protectedSuites: Object.freeze([...protectedSuites]),
    materialization: true, workerSelection: true, protectedVerification: true,
    finalization: true, actualCost: true, cleanupOwnership: true,
  });
}

/** Read the static inventory from the same config and module pins later used
 * for receipt-bound execution. This intentionally does not call a factory,
 * construct clients, or invoke any provider/suite/finalizer method. */
export async function loadReleaseExecutionReadiness(input: Readonly<{
  config: CertifierConfig;
  candidateSha256: string;
  workspace: string;
}>): Promise<ReleaseExecutionReadiness> {
  const modulePin = executionModule(input.config);
  if (input.config.mode !== "protected") throw new Error("RELEASE_PRODUCTION_EXECUTION_CONFIG_INVALID");
  if (input.config.controller!.candidateId !== input.candidateSha256.toLowerCase()) throw new Error("RELEASE_PRODUCTION_EXECUTION_CONFIG_INVALID");
  const deploymentConfig = await loadDeploymentConfig(modulePin, {
    candidateSha256: input.candidateSha256,
    workspace: input.workspace,
    sourceRevision: input.config.controller!.sourceRevision,
  });
  const module = await importPinnedModule(modulePin, deploymentConfig);
  const readiness = parseReleaseExecutionReadiness(module.releaseReadiness);
  if (typeof module.assessProductionFactoryReadiness === "function") {
    const assessed = module.assessProductionFactoryReadiness({ candidateSha256: input.candidateSha256, workspace: input.workspace, deploymentConfig });
    if (!assessed || typeof assessed !== "object" || typeof (assessed as { ready?: unknown }).ready !== "boolean" || !Array.isArray((assessed as { blockers?: unknown }).blockers)
      || !(assessed as { blockers: unknown[] }).blockers.every((blocker) => typeof blocker === "string" && blocker.length > 0 && blocker.length <= 160)) {
      throw new Error("RELEASE_PRODUCTION_EXECUTION_READINESS_INVALID");
    }
    const blockers = (assessed as { blockers: string[] }).blockers;
    if ((assessed as { ready: boolean }).ready !== (blockers.length === 0)) throw new Error("RELEASE_PRODUCTION_EXECUTION_READINESS_INVALID");
    if (blockers.length) return Object.freeze({ ...readiness, blockers: Object.freeze([...blockers]) });
  }
  if (!modulePin.runtime) {
    return Object.freeze({ ...readiness, blockers: Object.freeze(["PRODUCTION_RUNTIME_CLOSURE_REQUIRED"]) });
  }
  /* Readiness intentionally proves the same sealed bundle/config that later
   * executes, but does not construct the receipt-bound graph. Construction
   * requires an installed controller capability and is therefore unavailable
   * during preapproval rather than replaced with a fake runtime. */
  if (typeof module.createReleaseExecutionSession !== "function") throw new Error("RELEASE_PRODUCTION_EXECUTION_FACTORY_INVALID");
  return readiness;
}

/** Reads the fee policy from the exact pinned production module, without
 * invoking its session constructor or opening a wallet/secret surface. */
export async function loadReleaseFundingFeePolicyProjection(input: Readonly<{ config: CertifierConfig; candidateSha256: string; workspace: string }>): Promise<SealedFundingFeePolicyProjection> {
  const modulePin = executionModule(input.config);
  if (input.config.mode !== "protected") throw new Error("RELEASE_PRODUCTION_EXECUTION_CONFIG_INVALID");
  if (input.config.controller!.candidateId !== input.candidateSha256.toLowerCase()) throw new Error("RELEASE_PRODUCTION_EXECUTION_CONFIG_INVALID");
  const deploymentConfig = await loadDeploymentConfig(modulePin, { candidateSha256: input.candidateSha256, workspace: input.workspace, sourceRevision: input.config.controller!.sourceRevision });
  const module = await importPinnedModule(modulePin, deploymentConfig);
  return parseFundingFeePolicyProjection(module.fundingFeePolicyProjection);
}

function isCompletePreparedExecution(value: unknown): value is Omit<AuthorizedLiveExecutionInput, "registry"> {
  if (!value || typeof value !== "object") return false;
  const prepared = value as Partial<Omit<AuthorizedLiveExecutionInput, "registry">>;
  if (!prepared.receipt || !prepared.materialization || !prepared.workerSelection || !prepared.protected || !prepared.finalization || !prepared.protectedVerificationReferences) return false;
  const ports = prepared.protected.ports as unknown;
  if (!ports || typeof ports !== "object") return false;
  const actual = Object.keys(ports as Record<string, unknown>).sort();
  const expected = [...PRODUCTION_LIVE_PROTECTED_PORT_KEYS].sort();
  return actual.length === expected.length && actual.every((key, index) => key === expected[index])
    && Object.values(ports as Record<string, unknown>).every((port) => !!port && typeof port === "object" && (port as { evidenceClass?: unknown }).evidenceClass === "real");
}

/**
 * Loads the one controller-generated, containment-checked release execution
 * boundary. It parses no ambient credentials and cannot substitute a blocked
 * or deterministic client: a pinned deployment module must supply the exact
 * immutable sixteen-family session.
 */
export async function loadReleaseExecutionSession(input: Readonly<{
  config: CertifierConfig;
  candidateSha256: string;
  workspace: string;
  /** A structured receipt is accepted only after the caller has resolved it
   * from the controller's digest-addressed record. Factory modules receive
   * the validated, canonical value rather than a user-provided blob. */
  authorization?: Readonly<{ request: unknown; receipt: unknown }>;
}>): Promise<ReleaseExecutionSession> {
  const modulePin = executionModule(input.config);
  if (input.config.mode !== "protected") throw new Error("RELEASE_PRODUCTION_EXECUTION_CONFIG_INVALID");
  if (input.config.controller!.candidateId !== input.candidateSha256.toLowerCase()) throw new Error("RELEASE_PRODUCTION_EXECUTION_CONFIG_INVALID");
  const deploymentConfig = await loadDeploymentConfig(modulePin, {
    candidateSha256: input.candidateSha256,
    workspace: input.workspace,
    sourceRevision: input.config.controller!.sourceRevision,
  });
  const module = await importPinnedModule(modulePin, deploymentConfig);
  if (typeof module.createReleaseExecutionSession !== "function") throw new Error("RELEASE_PRODUCTION_EXECUTION_FACTORY_INVALID");
  let authorization: Readonly<{ request: unknown; receipt: unknown }> | undefined;
  if (input.authorization) {
    try {
      const request = await validateAuthorizationRequest(input.authorization.request);
      const receipt = await validateAuthorizationReceipt({ request, receipt: input.authorization.receipt, nowMs: Date.now() });
      if (request.candidateSha256 !== input.candidateSha256.toLowerCase()) throw new Error("binding");
      authorization = Object.freeze({ request, receipt });
    } catch {
      throw new Error("RELEASE_PRODUCTION_EXECUTION_AUTHORIZATION_INVALID");
    }
  }
  let session: unknown;
  try {
    /* The receipt path has already passed canonical validation above. Only
     * now may the pinned production closure resolve mounted references and
     * construct its concrete 16-provider/8-suite graph. */
    if (authorization) {
      const runtimeRequest = await validateAuthorizationRequest(authorization.request);
      await openPinnedMountedSession({
        module: modulePin,
        deploymentConfig,
        authorization,
        candidateSha256: input.candidateSha256,
        topologySha256: runtimeRequest.topologySha256,
      });
    }
    session = await module.createReleaseExecutionSession({
      candidateSha256: input.candidateSha256,
      workspace: input.workspace,
      deploymentConfig,
      ...(authorization ? { authorization } : {}),
    });
  } catch {
    throw new Error("RELEASE_PRODUCTION_EXECUTION_SESSION_INVALID");
  }
  if (!isReleaseExecutionSession(session)) throw new Error("RELEASE_PRODUCTION_EXECUTION_SESSION_INVALID");
  const completeSession = session;
  return Object.freeze({
    registry: completeSession.registry,
    ...(completeSession.collectorImage ? { collectorImage: completeSession.collectorImage } : {}),
    async prepareAuthorizedExecution(authorizedInput) {
      const prepared = await completeSession.prepareAuthorizedExecution(authorizedInput);
      if (!isCompletePreparedExecution(prepared)) throw new Error("RELEASE_PRODUCTION_EXECUTION_PREPARATION_INVALID");
      try {
        const request = await validateAuthorizationRequest(authorizedInput.authorizationRequest);
        await validateAuthorizationReceipt({ request, receipt: prepared.receipt, nowMs: Date.now() });
      } catch {
        throw new Error("RELEASE_PRODUCTION_EXECUTION_PREPARATION_INVALID");
      }
      return prepared;
    },
  });
}

/** Resolve a final config pin through the mounted SQL authority without opening
 * the generation graph. Expired execution receipts do not authorize new work;
 * reading an already promoted original remains possible. */
export async function loadFinalizedReleaseVerificationAuthority(input: Readonly<{
  config: CertifierConfig; workspace: string; bundleSha256: string;
}>) {
  if (!/^[a-f0-9]{64}$/u.test(input.bundleSha256) || input.config.mode !== "protected" || !input.config.controller) throw new Error("RELEASE_VERIFICATION_AUTHORITY_REQUIRED");
  const module = executionModule(input.config);
  const deploymentConfig = await loadDeploymentConfig(module, { candidateSha256: input.config.controller.candidateId, workspace: input.workspace, sourceRevision: input.config.controller.sourceRevision });
  const runtime = await loadPinnedProductionRuntimeConfig(module, { candidateSha256: input.config.controller.candidateId, topologySha256: input.config.controller.topologySha256, deploymentConfig });
  const postgres = await openProductionPostgresPool(runtime, new MountedProductionSecretMaterial(runtime));
  try {
    return await loadPromotedVerificationAuthority({ pool: postgres.pool, deploymentScopeSha256: productionReleaseScope(runtime), workspace: input.workspace, bundleSha256: input.bundleSha256 });
  } finally { await postgres.close(); }
}
