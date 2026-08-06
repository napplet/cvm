import type { AuthorizedLiveExecutionInput, ReleaseExecutionSession } from "../controller";
import type { ReleaseExecutionFactoryInput } from "../production-execution";
import { RELEASE_PRODUCTION_PROVIDER_IDS } from "../native-registry";
import type { ReleaseProviderRegistry } from "../providers";
import type { GoogleAccessToken, GoogleFetch, GoogleTokenSource } from "./google-clients";
import type { createContextVmDeploymentClient } from "./contextvm-client";
import type { createPaymentDeploymentClients } from "./payment-clients";
import type { createVertexDeploymentClient } from "./vertex-client";

/** Bounded dependency descriptors for the concrete provider modules.  They are
 * references only: the pinned factory must receive them explicitly and cannot
 * discover ambient ADC, metadata, or provider state during module loading. */
export type DeploymentClientDependencies = Readonly<{
  google?: Readonly<{ tokenSource: GoogleTokenSource; fetch: GoogleFetch; fixtureToken?: GoogleAccessToken }>;
}>;

/** Every constructed family is explicit.  This registration helper is pure:
 * it cannot trigger transport, payment, model, or provider discovery. */
export function registerDeploymentClientFamilies(input: Readonly<{
  contextvm: ReturnType<typeof createContextVmDeploymentClient>;
  payments: ReturnType<typeof createPaymentDeploymentClients>;
  vertex: ReturnType<typeof createVertexDeploymentClient>;
}>) {
  return Object.freeze({
    contextvm: input.contextvm,
    cep8_lightning: input.payments.nwc,
    cashu: input.payments.cashu,
    model: input.vertex,
  });
}

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
