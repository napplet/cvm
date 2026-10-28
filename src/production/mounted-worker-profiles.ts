import type { PostgresOperationJournal } from "../release/deployment/postgres-operation-journal";
import { createPostgresWorkerOperationJournal } from "../release/deployment/postgres-provider-journals";
import type { ProductionConfig } from "./config";
import type { MountedProductionSecretMaterial } from "./secret-material";
import { createMountedProductionWorkerClients } from "./mounted-worker-clients";
import { ProductionWorkerJobRouter } from "./worker-job-router";

/** Retained legacy aggregate executables are explicitly approved in mounted
 * candidate configuration. Credentials stay on the coordinator and original
 * app bindings must still match. This does not select a new artifact contract. */
export async function createMountedProductionWorkerJobRouter(input: Readonly<{
  config: ProductionConfig; secrets: MountedProductionSecretMaterial;
  workerJournal: PostgresOperationJournal; jobJournal: PostgresOperationJournal;
  current: Awaited<ReturnType<typeof createMountedProductionWorkerClients>>;
}>) {
  const approved = [{ image: input.config.worker.image, toolchainSha256: input.config.worker.toolchainSha256 }, ...(input.config.worker.retainedProfiles ?? [])];
  const executables = await Promise.all(approved.map(async (profile, index) => {
    const mounted = index === 0 ? input.current : await createMountedProductionWorkerClients({ config: input.config, secrets: input.secrets, image: profile.image, journal: createPostgresWorkerOperationJournal(input.workerJournal) });
    return { image: profile.image, toolchainSha256: profile.toolchainSha256, clients: mounted.clients, modalAppName: mounted.certification.modalConfig.appName, flyAppName: mounted.certification.flyConfig.appName };
  }));
  return new ProductionWorkerJobRouter({ workerJournal: input.workerJournal, jobJournal: input.jobJournal, executables, publication: { server: input.config.publication.uploadServer } });
}
