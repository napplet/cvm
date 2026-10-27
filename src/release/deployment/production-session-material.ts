import { validateAuthorizationReceipt, validateAuthorizationRequest } from "../authorization";
import type { ReleaseProviderId } from "../contracts";
import type { ReleaseProviderPort } from "../providers";
import type { DeploymentExecutionConfig } from "./config";
import type { ProductionCoreControlClient } from "./production-core-control";
import type { PostgresOperationJournal } from "./postgres-operation-journal";
import {
  createProductionSessionBroker,
  installProductionSessionBroker,
  type ProductionConcreteClients,
  type ProductionSessionBroker,
} from "./production-session-runtime";
import type { ProductionSessionRuntime } from "./production-session";
import type { WorkerCandidate } from "../../certification/contracts";
import { assertProductionCheckpointCoordinator, type ProductionCheckpointCoordinator } from "../../production/checkpoint-coordinator";

/**
 * The only hand-off shape between the mounted production runtime and the
 * certification factory. It intentionally contains concrete project-owned
 * clients and provider descriptors, not user JSON, callback bags, or raw
 * credentials. The construction function below revalidates its controller
 * authorization pair before accepting even an in-process material object.
 */
export type ProductionCertificationSessionMaterial = Readonly<{
  realm: "production-real";
  deploymentConfig: DeploymentExecutionConfig;
  journal: PostgresOperationJournal;
  clients: ProductionConcreteClients;
  providers: Readonly<Record<ReleaseProviderId, Readonly<{
    origin: "project-owned";
    evidenceClass: "real";
    brokerReference: string;
    port: ReleaseProviderPort;
  }>>>;
  workerCandidate: WorkerCandidate;
  control: ProductionCoreControlClient;
  /** Concrete PostgreSQL/GCS/KEK coordinator. The bound preparation factory
   * consumes this server-owned object; it is never replaced by an envelope or
   * restore callback supplied by a certification request. */
  checkpointCoordinator: ProductionCheckpointCoordinator;
  prepare: ProductionSessionRuntime["prepare"];
}>;

export type ProductionSessionAuthorizationMaterial = Readonly<{
  request: unknown;
  receipt: unknown;
}>;

export type SealedProductionSessionMaterial = Readonly<{
  broker: ProductionSessionBroker;
  authorization: ProductionSessionAuthorizationMaterial;
}>;

const sealedMaterials = new WeakSet<object>();

/**
 * Construct the exact broker from mounted, project-owned material. This is
 * intentionally an assembly point—not a provider factory—so it cannot choose
 * a credential, synthesize a client, or replace a missing edge with a fake.
 * A final edge material provider must therefore deliver the complete sixteen
 * descriptors before this function can succeed.
 */
export async function sealProductionSessionMaterial(input: Readonly<{
  authorization: ProductionSessionAuthorizationMaterial;
  material: ProductionCertificationSessionMaterial;
}>): Promise<SealedProductionSessionMaterial> {
  if (!input.material || input.material.realm !== "production-real") {
    throw new Error("PRODUCTION_SESSION_MATERIAL_REQUIRED");
  }
  try { assertProductionCheckpointCoordinator(input.material.checkpointCoordinator); }
  catch { throw new Error("PRODUCTION_SESSION_MATERIAL_CHECKPOINT_REQUIRED"); }
  let request: Awaited<ReturnType<typeof validateAuthorizationRequest>>;
  let receipt: Awaited<ReturnType<typeof validateAuthorizationReceipt>>;
  try {
    request = await validateAuthorizationRequest(input.authorization.request);
    receipt = await validateAuthorizationReceipt({ request, receipt: input.authorization.receipt, nowMs: Date.now() });
  } catch {
    throw new Error("PRODUCTION_SESSION_MATERIAL_AUTHORIZATION_INVALID");
  }
  if (request.candidateSha256 !== input.material.deploymentConfig.candidateSha256
    || request.topologySha256 !== receipt.topologySha256
    || receipt.candidateSha256 !== input.material.deploymentConfig.candidateSha256) {
    throw new Error("PRODUCTION_SESSION_MATERIAL_BINDING_REQUIRED");
  }
  const broker = createProductionSessionBroker({
    deploymentConfig: input.material.deploymentConfig,
    topologySha256: request.topologySha256,
    journal: input.material.journal,
    clients: input.material.clients,
    providers: input.material.providers,
    workerCandidate: input.material.workerCandidate,
    control: input.material.control,
    prepare: input.material.prepare,
  });
  if (broker.candidateSha256 !== request.candidateSha256 || broker.topologySha256 !== request.topologySha256) {
    throw new Error("PRODUCTION_SESSION_MATERIAL_BINDING_REQUIRED");
  }
  const sealed = Object.freeze({
    broker,
    authorization: Object.freeze({ request, receipt }),
  });
  sealedMaterials.add(sealed);
  return sealed;
}

/** Only a sealed complete material graph may register the process-local
 * broker. Normal CLI/config callers have no path to manufacture this token. */
export function installSealedProductionSessionMaterial(value: unknown): SealedProductionSessionMaterial {
  if (!value || typeof value !== "object" || !sealedMaterials.has(value)) {
    throw new Error("PRODUCTION_SESSION_MATERIAL_REQUIRED");
  }
  const material = value as SealedProductionSessionMaterial;
  installProductionSessionBroker(material.broker);
  return material;
}
