import type { PostgresOperationJournal } from "../release/deployment/postgres-operation-journal";
import { createPostgresWorkerOperationJournal } from "../release/deployment/postgres-provider-journals";
import type { ProductionConfig } from "./config";
import type { MountedProductionSecretMaterial } from "./secret-material";
import { createMountedProductionWorkerClients } from "./mounted-worker-clients";
import { ProductionWorkerJobRouter } from "./worker-job-router";

/** Candidate-owned executable contracts preserve legacy omission and select
 * direct jobs only when explicitly configured. Credentials stay on the
 * coordinator; original image/toolchain/provider app bindings still match. */
export async function createMountedProductionWorkerJobRouter(input: Readonly<{
  config: ProductionConfig; secrets: MountedProductionSecretMaterial;
  workerJournal: PostgresOperationJournal; jobJournal: PostgresOperationJournal;
  current: Awaited<ReturnType<typeof createMountedProductionWorkerClients>>;
}>) {
  const approved = [{ image: input.config.worker.image, toolchainSha256: input.config.worker.toolchainSha256, artifactContract: input.config.worker.artifactContract }, ...(input.config.worker.retainedProfiles ?? [])];
  const executables = await Promise.all(approved.map(async (profile, index) => {
    const mounted = index === 0 ? input.current : await createMountedProductionWorkerClients({ config: input.config, secrets: input.secrets, image: profile.image, journal: createPostgresWorkerOperationJournal(input.workerJournal) });
    return { image: profile.image, toolchainSha256: profile.toolchainSha256, ...(profile.artifactContract === undefined ? {} : { artifactContract: profile.artifactContract }), clients: mounted.clients, modalAppName: mounted.certification.modalConfig.appName, flyAppName: mounted.certification.flyConfig.appName };
  }));
  return new ProductionWorkerJobRouter({ workerJournal: input.workerJournal, jobJournal: input.jobJournal, executables, publication: { server: input.config.publication.uploadServer } });
}
