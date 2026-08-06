import { readFile } from "node:fs/promises";
import { isAbsolute, relative, resolve, sep } from "node:path";
import { pathToFileURL } from "node:url";

import type { CertifierConfig, PinnedCertifierModule } from "../certification/config";
import type { ReleaseExecutionSession } from "./controller";
import { RELEASE_PRODUCTION_PROVIDER_IDS } from "./native-registry";

export type ReleaseExecutionFactoryInput = Readonly<{
  candidateSha256: string;
  workspace: string;
}>;

type ReleaseExecutionFactoryModule = Readonly<{
  createReleaseExecutionSession?: (input: ReleaseExecutionFactoryInput) => Promise<unknown> | unknown;
}>;

function containedBy(root: string, candidate: string): boolean {
  const value = relative(root, candidate);
  return value === "" || (!value.startsWith(`..${sep}`) && value !== "..");
}

async function sha256(bytes: Uint8Array): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", Uint8Array.from(bytes).buffer);
  return Array.from(new Uint8Array(digest), (byte) => byte.toString(16).padStart(2, "0")).join("");
}

function executionModule(config: CertifierConfig): PinnedCertifierModule {
  if (config.mode !== "protected" || config.credentials !== "configured" || !config.releaseExecution) {
    throw new Error("RELEASE_PRODUCTION_EXECUTION_CONFIG_REQUIRED");
  }
  return config.releaseExecution;
}

async function importPinnedModule(module: PinnedCertifierModule): Promise<ReleaseExecutionFactoryModule> {
  const root = resolve(module.root);
  const modulePath = resolve(module.modulePath);
  if (!isAbsolute(module.root) || !isAbsolute(module.modulePath) || !containedBy(root, modulePath)) {
    throw new Error("RELEASE_PRODUCTION_EXECUTION_CONFIG_INVALID");
  }
  let bytes: Uint8Array;
  try { bytes = new Uint8Array(await readFile(modulePath)); }
  catch { throw new Error("RELEASE_PRODUCTION_EXECUTION_CONFIG_INVALID"); }
  if (await sha256(bytes) !== module.sha256.toLowerCase()) {
    throw new Error("RELEASE_PRODUCTION_EXECUTION_CONFIG_INVALID");
  }
  try {
    return await import(`${pathToFileURL(modulePath).href}?sha256=${module.sha256.toLowerCase()}`) as ReleaseExecutionFactoryModule;
  } catch {
    throw new Error("RELEASE_PRODUCTION_EXECUTION_FACTORY_INVALID");
  }
}

function isReleaseExecutionSession(value: unknown): value is ReleaseExecutionSession {
  if (!value || typeof value !== "object") return false;
  const session = value as Partial<ReleaseExecutionSession>;
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

/**
 * Loads the single deployment-owned release execution boundary. The bridge is
 * deliberately incapable of creating a receipt, client, credential, or
 * evidence port: the pinned module must supply the complete same-run session.
 */
export async function loadReleaseExecutionSession(input: Readonly<{
  config: CertifierConfig;
  candidateSha256: string;
  workspace: string;
}>): Promise<ReleaseExecutionSession> {
  const module = await importPinnedModule(executionModule(input.config));
  if (typeof module.createReleaseExecutionSession !== "function") {
    throw new Error("RELEASE_PRODUCTION_EXECUTION_FACTORY_INVALID");
  }
  let session: unknown;
  try {
    session = await module.createReleaseExecutionSession({ candidateSha256: input.candidateSha256, workspace: input.workspace });
  } catch {
    throw new Error("RELEASE_PRODUCTION_EXECUTION_SESSION_INVALID");
  }
  if (!isReleaseExecutionSession(session)) {
    throw new Error("RELEASE_PRODUCTION_EXECUTION_SESSION_INVALID");
  }
  return session;
}
