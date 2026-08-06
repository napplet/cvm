import type { AuthorizedLiveExecutionInput, ReleaseExecutionSession } from "../controller";
import type { ReleaseExecutionFactoryInput } from "../production-execution";
import { RELEASE_PRODUCTION_PROVIDER_IDS } from "../native-registry";
import type { ReleaseProviderRegistry } from "../providers";

export type DeploymentFactoryRuntime = Readonly<{
  registry: ReleaseProviderRegistry;
  prepareAuthorizedExecution: ReleaseExecutionSession["prepareAuthorizedExecution"];
}>;

function exactRegistry(registry: ReleaseProviderRegistry): ReleaseProviderRegistry {
  const providers = registry.providers();
  if (providers.length !== RELEASE_PRODUCTION_PROVIDER_IDS.length
    || providers.some((provider, index) => provider !== RELEASE_PRODUCTION_PROVIDER_IDS[index])) {
    throw new Error("DEPLOYMENT_FACTORY_PROVIDER_SET_REQUIRED");
  }
  return registry;
}

/**
 * Pure deployment composition seam. Concrete client constructors arrive from
 * project-owned modules in later plans; this module never discovers ambient
 * credentials and never fills absent clients with blocked/deterministic ports.
 */
export function createDeploymentReleaseExecutionSession(
  input: ReleaseExecutionFactoryInput,
  runtime: DeploymentFactoryRuntime,
): ReleaseExecutionSession {
  void input.deploymentConfig.secretReferences;
  const registry = exactRegistry(runtime.registry);
  return Object.freeze({
    registry,
    async prepareAuthorizedExecution(authorizationInput) {
      const prepared = await runtime.prepareAuthorizedExecution(authorizationInput);
      return prepared as Omit<AuthorizedLiveExecutionInput, "registry">;
    },
  });
}

/**
 * Dynamic production loading reaches this named entrypoint. Calling it without
 * explicit project-owned client constructors fails closed before any effect.
 */
export function createReleaseExecutionSession(_input: ReleaseExecutionFactoryInput): never {
  throw new Error("DEPLOYMENT_FACTORY_CLIENT_CONSTRUCTORS_REQUIRED");
}
