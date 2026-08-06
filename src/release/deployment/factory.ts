import type { AuthorizedLiveExecutionInput, ReleaseExecutionSession } from "../controller";
import type { ReleaseExecutionFactoryInput } from "../production-execution";
import { RELEASE_PRODUCTION_PROVIDER_IDS } from "../native-registry";
import type { ReleaseProviderRegistry } from "../providers";
import { createDeploymentProtectedPorts } from "./protected-ports";
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

/** The deployment session must use this complete registration, never a
 * partially-populated family map. It is a pure object assembly that preserves
 * distinct rail/key/client identity and causes no construction-time effects. */
export function registerCompleteDeploymentClientFamilies(input: Readonly<{
  contextvm: ReturnType<typeof createContextVmDeploymentClient>;
  payments: ReturnType<typeof createPaymentDeploymentClients>;
  vertex: ReturnType<typeof createVertexDeploymentClient>;
  host: ReturnType<typeof createCompatibleHostDeploymentClient>;
  signer: ReturnType<typeof createNip46DeploymentClient>;
  publication: ReturnType<typeof createCliUploadDeploymentClients>;
  relays: ReturnType<typeof createRelayDeploymentClients>;
}>) {
  const families = registerDeploymentClientFamilies(input);
  const expected = ["contextvm", "cep8_lightning", "cashu", "model", "compatible_host", "signer", "promoted_cli", "upload", "owner_relay", "attestation_relay"];
  if (Object.keys(families).join(",") !== expected.join(",")) throw new Error("DEPLOYMENT_FACTORY_PROVIDER_SET_REQUIRED");
  return families as Readonly<{
    contextvm: ReturnType<typeof createContextVmDeploymentClient>;
    cep8_lightning: ReturnType<typeof createPaymentDeploymentClients>["nwc"];
    cashu: ReturnType<typeof createPaymentDeploymentClients>["cashu"];
    model: ReturnType<typeof createVertexDeploymentClient>;
    compatible_host: ReturnType<typeof createCompatibleHostDeploymentClient>;
    signer: ReturnType<typeof createNip46DeploymentClient>;
    promoted_cli: ReturnType<typeof createCliUploadDeploymentClients>["promotedCli"];
    upload: ReturnType<typeof createCliUploadDeploymentClients>["upload"];
    owner_relay: ReturnType<typeof createRelayDeploymentClients>["owner"];
    attestation_relay: ReturnType<typeof createRelayDeploymentClients>["attestation"];
  }>;
}

export type DeploymentFactoryRuntime = Readonly<{
  registry: ReleaseProviderRegistry;
  prepareAuthorizedExecution: ReleaseExecutionSession["prepareAuthorizedExecution"];
}>;

function preparationReceiptMatches(
  prepared: Omit<AuthorizedLiveExecutionInput, "registry">,
  authorizationRequest: Parameters<ReleaseExecutionSession["prepareAuthorizedExecution"]>[0]["authorizationRequest"],
): boolean {
  if (!prepared.receipt || typeof prepared.receipt !== "object") return false;
  const receipt = prepared.receipt as Readonly<{ authorizationRequestSha256?: unknown; candidateSha256?: unknown; topologySha256?: unknown }>;
  return receipt.authorizationRequestSha256 === authorizationRequest.authorizationRequestSha256
    && receipt.candidateSha256 === authorizationRequest.candidateSha256
    && receipt.topologySha256 === authorizationRequest.topologySha256;
}

function assertPreparedExecution(
  input: ReleaseExecutionFactoryInput,
  authorizationRequest: Parameters<ReleaseExecutionSession["prepareAuthorizedExecution"]>[0]["authorizationRequest"],
  prepared: Omit<AuthorizedLiveExecutionInput, "registry">,
): Omit<AuthorizedLiveExecutionInput, "registry"> {
  if (authorizationRequest.candidateSha256 !== input.candidateSha256.toLowerCase()) {
    throw new Error("DEPLOYMENT_PREPARATION_CANDIDATE_BINDING_REQUIRED");
  }
  if (!preparationReceiptMatches(prepared, authorizationRequest)) {
    throw new Error("DEPLOYMENT_PREPARATION_RECEIPT_BINDING_REQUIRED");
  }
  if (!prepared.materialization || !prepared.workerSelection || !prepared.protected || !prepared.finalization || !prepared.protectedVerificationReferences) {
    throw new Error("DEPLOYMENT_PREPARATION_COMPLETE_INPUT_REQUIRED");
  }
  if (prepared.materialization.candidateId !== authorizationRequest.candidateSha256
    || prepared.materialization.topology?.topologySha256 !== authorizationRequest.topologySha256
    || prepared.protected.candidate?.id !== authorizationRequest.candidateSha256
    || prepared.protected.input?.topologySha256 !== authorizationRequest.topologySha256
    || prepared.workerSelection.candidateSha256 !== authorizationRequest.candidateSha256
    || prepared.workerSelection.topologySha256 !== authorizationRequest.topologySha256) {
    throw new Error("DEPLOYMENT_PREPARATION_BOUNDARY_MISMATCH");
  }
  createDeploymentProtectedPorts(prepared.protected.ports);
  return Object.freeze({ ...prepared, protected: Object.freeze({ ...prepared.protected, ports: createDeploymentProtectedPorts(prepared.protected.ports) }) });
}

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
      return assertPreparedExecution(input, authorizationInput.authorizationRequest, prepared);
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
