import type { AuthorizedLiveExecutionInput, ReleaseExecutionSession } from "../controller";
import type { ReleaseExecutionFactoryInput } from "../production-execution";
import { RELEASE_PRODUCTION_PROVIDER_IDS } from "../native-registry";
import type { ReleaseProviderRegistry } from "../providers";
import type { GoogleAccessToken, GoogleFetch, GoogleTokenSource } from "./google-clients";
import type { createContextVmDeploymentClient } from "./contextvm-client";
import type { createPaymentDeploymentClients } from "./payment-clients";
import type { createVertexDeploymentClient } from "./vertex-client";
import type { createCompatibleHostDeploymentClient } from "./compatible-host-client";
import type { createNip46DeploymentClient } from "./nip46-signer-client";
import type { createCliUploadDeploymentClients } from "./cli-upload-clients";
import type { createRelayDeploymentClients } from "./relay-clients";

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
  host?: ReturnType<typeof createCompatibleHostDeploymentClient>;
  signer?: ReturnType<typeof createNip46DeploymentClient>;
  publication?: ReturnType<typeof createCliUploadDeploymentClients>;
  relays?: ReturnType<typeof createRelayDeploymentClients>;
}>) {
  return Object.freeze({
    contextvm: input.contextvm,
    cep8_lightning: input.payments.nwc,
    cashu: input.payments.cashu,
    model: input.vertex,
    ...(input.host ? { compatible_host: input.host } : {}),
    ...(input.signer ? { signer: input.signer } : {}),
    ...(input.publication ? { promoted_cli: input.publication.promotedCli, upload: input.publication.upload } : {}),
    ...(input.relays ? { owner_relay: input.relays.owner, attestation_relay: input.relays.attestation } : {}),
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
