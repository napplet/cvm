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

export type ReleaseExecutionFactoryInput = Readonly<{
  candidateSha256: string;
  workspace: string;
  deploymentConfig: DeploymentExecutionConfig;
}>;

type ReleaseExecutionFactoryModule = Readonly<{
  createReleaseExecutionSession?: (input: ReleaseExecutionFactoryInput) => Promise<unknown> | unknown;
  /** Static, side-effect-free inventory. It proves the pinned factory has
   * every post-receipt input without constructing a provider client. */
  releaseReadiness?: unknown;
  assessProductionFactoryReadiness?: (input: ReleaseExecutionFactoryInput) => unknown;
}>;

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

function isReleaseExecutionSession(value: unknown): value is ReleaseExecutionSession {
  if (!value || typeof value !== "object") return false;
  const session = value as Partial<ReleaseExecutionSession>;
  const keys = Object.keys(session).sort();
  if (keys.length !== 2 || keys[0] !== "prepareAuthorizedExecution" || keys[1] !== "registry") return false;
  if (typeof session.prepareAuthorizedExecution !== "function" || !session.registry || typeof session.registry !== "object") return false;
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
  if (typeof module.createReleaseExecutionSession !== "function") throw new Error("RELEASE_PRODUCTION_EXECUTION_FACTORY_INVALID");
  let session: unknown;
  try { session = await module.createReleaseExecutionSession({ candidateSha256: input.candidateSha256, workspace: input.workspace, deploymentConfig }); }
  catch { throw new Error("RELEASE_PRODUCTION_EXECUTION_READINESS_INVALID"); }
  if (!isReleaseExecutionSession(session)) throw new Error("RELEASE_PRODUCTION_EXECUTION_READINESS_INVALID");
  return readiness;
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
}>): Promise<ReleaseExecutionSession> {
  const modulePin = executionModule(input.config);
  if (input.config.controller!.candidateId !== input.candidateSha256.toLowerCase()) throw new Error("RELEASE_PRODUCTION_EXECUTION_CONFIG_INVALID");
  const deploymentConfig = await loadDeploymentConfig(modulePin, {
    candidateSha256: input.candidateSha256,
    workspace: input.workspace,
    sourceRevision: input.config.controller!.sourceRevision,
  });
  const module = await importPinnedModule(modulePin, deploymentConfig);
  if (typeof module.createReleaseExecutionSession !== "function") throw new Error("RELEASE_PRODUCTION_EXECUTION_FACTORY_INVALID");
  let session: unknown;
  try {
    session = await module.createReleaseExecutionSession({ candidateSha256: input.candidateSha256, workspace: input.workspace, deploymentConfig });
  } catch {
    throw new Error("RELEASE_PRODUCTION_EXECUTION_SESSION_INVALID");
  }
  if (!isReleaseExecutionSession(session)) throw new Error("RELEASE_PRODUCTION_EXECUTION_SESSION_INVALID");
  const completeSession = session;
  return Object.freeze({
    registry: completeSession.registry,
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
