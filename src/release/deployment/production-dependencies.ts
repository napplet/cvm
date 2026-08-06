import {
  validateAuthorizationReceipt,
  validateAuthorizationRequest,
  type ReleaseAuthorizationReceipt,
  type ReleaseAuthorizationRequest,
} from "../authorization";
import type { AuthorizedLiveExecutionInput, ReleaseExecutionSession } from "../controller";
import { createNativeReleaseProviderRegistry, RELEASE_PRODUCTION_PROVIDER_IDS } from "../native-registry";
import type { ReleaseProviderId } from "../contracts";
import type { ReleaseProviderPort } from "../providers";
import {
  PRODUCTION_LIVE_PROTECTED_PORT_KEYS,
  type ProductionLiveProtectedCertificationPorts,
} from "../../certification/live/production-ports";

const OPERATIONAL_DEPENDENCIES = Symbol("production-operational-dependencies");
const BROKER_REFERENCE = /^[a-z][a-z0-9:._/-]{2,255}$/iu;

type ProjectOwned<T> = Readonly<{
  origin: "project-owned";
  evidenceClass: "real";
  brokerReference: string;
  port: T;
}>;

type ProjectOwnedProtectedPorts = Readonly<{
  [K in keyof ProductionLiveProtectedCertificationPorts]: ProductionLiveProtectedCertificationPorts[K] & Readonly<{ origin: "project-owned" }>;
}>;

type PreparedOperationalExecution = Omit<AuthorizedLiveExecutionInput, "registry" | "receipt" | "protected"> & Readonly<{
  protected: Omit<AuthorizedLiveExecutionInput["protected"], "ports">;
}>;

export type ProductionOperationalDependenciesInput = Readonly<{
  /** The structured consent receipt is revalidated when, and only when, the
   * controller asks to cross the authorized-execution boundary. */
  receipt: unknown;
  providers: Readonly<Record<ReleaseProviderId, ProjectOwned<ReleaseProviderPort>>>;
  protectedPorts: ProjectOwnedProtectedPorts;
  prepare(input: Readonly<{
    authorizationRequest: ReleaseAuthorizationRequest;
    receipt: ReleaseAuthorizationReceipt;
  }>): Promise<PreparedOperationalExecution>;
  now?: () => number;
}>;

export type ProductionOperationalDependencies = Readonly<{
  registry: ReturnType<typeof createNativeReleaseProviderRegistry>;
  prepareAuthorizedExecution: ReleaseExecutionSession["prepareAuthorizedExecution"];
  [OPERATIONAL_DEPENDENCIES]: true;
}>;

function hasExactKeys(value: object, expected: readonly string[]): boolean {
  const keys = Object.keys(value);
  return keys.length === expected.length && keys.every((key, index) => key === expected[index]);
}

function assertProviderPort(value: unknown): asserts value is ReleaseProviderPort {
  if (!value || typeof value !== "object"
    || ["discoverCapabilities", "discoverAuthentication", "plan", "apply", "observe", "cleanup"]
      .some((method) => typeof (value as Record<string, unknown>)[method] !== "function")) {
    throw new Error("PRODUCTION_DEPENDENCY_PROVIDER_PORT_REQUIRED");
  }
}

function assertProviderDependencies(input: ProductionOperationalDependenciesInput): Record<ReleaseProviderId, ReleaseProviderPort> {
  if (!hasExactKeys(input.providers, RELEASE_PRODUCTION_PROVIDER_IDS)) {
    throw new Error("PRODUCTION_DEPENDENCY_PROVIDER_SET_REQUIRED");
  }
  const descriptors = RELEASE_PRODUCTION_PROVIDER_IDS.map((id) => input.providers[id]);
  const ports = descriptors.map((descriptor) => descriptor?.port);
  if (new Set(descriptors).size !== descriptors.length || new Set(ports).size !== ports.length) {
    throw new Error("PRODUCTION_DEPENDENCY_PROVIDER_IDENTITY_REQUIRED");
  }
  for (const descriptor of descriptors) {
    if (!descriptor || descriptor.origin !== "project-owned" || descriptor.evidenceClass !== "real"
      || typeof descriptor.brokerReference !== "string" || !BROKER_REFERENCE.test(descriptor.brokerReference)) {
      throw new Error("PRODUCTION_DEPENDENCY_PROVIDER_ORIGIN_REQUIRED");
    }
    assertProviderPort(descriptor.port);
  }
  return Object.fromEntries(RELEASE_PRODUCTION_PROVIDER_IDS.map((id) => [id, input.providers[id].port])) as Record<ReleaseProviderId, ReleaseProviderPort>;
}

function assertProtectedDependencies(input: ProductionOperationalDependenciesInput): ProductionLiveProtectedCertificationPorts {
  const ports = input.protectedPorts as Record<string, unknown>;
  if (!hasExactKeys(ports, PRODUCTION_LIVE_PROTECTED_PORT_KEYS)) {
    throw new Error("PRODUCTION_DEPENDENCY_PROTECTED_SET_REQUIRED");
  }
  const values = PRODUCTION_LIVE_PROTECTED_PORT_KEYS.map((key) => ports[key]);
  if (new Set(values).size !== values.length) throw new Error("PRODUCTION_DEPENDENCY_PROTECTED_IDENTITY_REQUIRED");
  for (const port of values) {
    if (!port || typeof port !== "object" || (port as { origin?: unknown }).origin !== "project-owned"
      || (port as { evidenceClass?: unknown }).evidenceClass !== "real") {
      throw new Error("PRODUCTION_DEPENDENCY_PROTECTED_ORIGIN_REQUIRED");
    }
  }
  return Object.freeze({ ...input.protectedPorts });
}

function assertCanonicalRequest(request: ReleaseAuthorizationRequest): void {
  const effectProviders = request.orderedEffects.map((effect) => effect.provider);
  const scopeProviders = request.providerScopes.map((scope) => scope.provider);
  if (effectProviders.length !== RELEASE_PRODUCTION_PROVIDER_IDS.length
    || scopeProviders.length !== RELEASE_PRODUCTION_PROVIDER_IDS.length
    || effectProviders.some((provider, index) => provider !== RELEASE_PRODUCTION_PROVIDER_IDS[index])
    || scopeProviders.some((provider, index) => provider !== RELEASE_PRODUCTION_PROVIDER_IDS[index])) {
    throw new Error("PRODUCTION_DEPENDENCY_AUTHORIZATION_SET_REQUIRED");
  }
}

/** True only for values built by this module. It prevents a caller from
 * asserting a lookalike dependency graph after the project-owned origin and
 * exact-set checks have run. */
export function isProductionOperationalDependencies(value: unknown): value is ProductionOperationalDependencies {
  return !!value && typeof value === "object" && (value as Partial<ProductionOperationalDependencies>)[OPERATIONAL_DEPENDENCIES] === true;
}

/**
 * Compose the complete sixteen-family/eight-suite graph without contacting a
 * provider. The receipt is deliberately validated at the one execution gate;
 * malformed, stale, cross-request, or fixture inputs cannot reach `prepare`
 * or any operational adapter.
 */
export function createProductionOperationalDependencies(input: ProductionOperationalDependenciesInput): ProductionOperationalDependencies {
  if (typeof input.prepare !== "function") throw new Error("PRODUCTION_DEPENDENCY_PREPARATION_REQUIRED");
  const providers = assertProviderDependencies(input);
  const protectedPorts = assertProtectedDependencies(input);
  const registry = createNativeReleaseProviderRegistry({
    candidateSha256: "0".repeat(64),
    providers,
    now: input.now,
  });

  return Object.freeze({
    registry,
    async prepareAuthorizedExecution({ authorizationRequest }) {
      const request = await validateAuthorizationRequest(authorizationRequest);
      assertCanonicalRequest(request);
      const receipt = await validateAuthorizationReceipt({ request, receipt: input.receipt, nowMs: (input.now ?? Date.now)() });
      const prepared = await input.prepare({ authorizationRequest: request, receipt });
      return Object.freeze({
        ...prepared,
        receipt,
        protected: Object.freeze({ ...prepared.protected, ports: protectedPorts }),
      });
    },
    [OPERATIONAL_DEPENDENCIES]: true as const,
  });
}
