import { z } from "zod";
import { assertPostgresOperationJournal, type PostgresOperationJournal } from "../release/deployment/postgres-operation-journal";
import { createPostgresWorkerOperationJournal } from "../release/deployment/postgres-provider-journals";
import type { createWorkerDeploymentClients } from "../release/deployment/worker-clients";
import { ProductionWorkerJobClient } from "../worker-adapters/production-job-client";
import type { ProductionWorkerPublication } from "../worker-adapters/publication-metadata";
import { PRODUCTION_WORKER_POLICY } from "../worker-adapters/production-worker-policy";

const Digest = z.string().regex(/^[a-f0-9]{64}$/u);
const Image = z.string().regex(/^.+@sha256:[a-f0-9]{64}$/iu);
const App = z.string().regex(/^[a-z][a-z0-9-]{2,62}$/u);
export type ProductionWorkerExecutable = Readonly<{
  image: string; toolchainSha256: string;
  modalAppName: string; flyAppName: string;
  clients: ReturnType<typeof createWorkerDeploymentClients>;
  artifactContract?: "legacy-aggregate-v1" | "nip5d-direct-v1";
}>;
const routers = new WeakSet<object>();
export function assertProductionWorkerJobRouter(value: unknown): asserts value is ProductionWorkerJobRouter {
  if (!value || typeof value !== "object" || !routers.has(value)) throw new Error("PRODUCTION_WORKER_JOB_ROUTER_REQUIRED");
}

/** Coordinator-owned approved executables. Selection uses the durable original
 * provider intent, never request/archive text or the current default. Creating
 * a client performs no provider mutation or replacement dispatch. */
export class ProductionWorkerJobRouter {
  readonly toolchainSha256s: readonly string[];
  readonly #executables: readonly ProductionWorkerExecutable[];
  constructor(private readonly input: Readonly<{
    workerJournal: PostgresOperationJournal; jobJournal: PostgresOperationJournal;
    executables: readonly ProductionWorkerExecutable[];
    publication?: ProductionWorkerPublication;
  }>) {
    assertPostgresOperationJournal(input.workerJournal); assertPostgresOperationJournal(input.jobJournal);
    if (input.executables.length < 1 || input.executables.length > 9) throw new Error("PRODUCTION_WORKER_EXECUTABLES_INVALID");
    const images = new Set<string>();
    this.#executables = Object.freeze(input.executables.map(value => {
      const image = Image.parse(value.image), toolchainSha256 = Digest.parse(value.toolchainSha256);
      if (images.has(image) || value.clients.modal.config.image !== image || value.clients.fly.config.image !== image
        || value.clients.modal.config.policyVersion !== PRODUCTION_WORKER_POLICY.version || value.clients.fly.config.policyVersion !== PRODUCTION_WORKER_POLICY.version) throw new Error("PRODUCTION_WORKER_EXECUTABLES_INVALID");
      images.add(image);
      const artifactContract = value.artifactContract === undefined ? undefined : z.enum(["legacy-aggregate-v1", "nip5d-direct-v1"]).parse(value.artifactContract);
      if (artifactContract === "nip5d-direct-v1" && !input.publication) throw new Error("PRODUCTION_DIRECT_PUBLICATION_REQUIRED");
      return Object.freeze({ ...value, ...(artifactContract === undefined ? {} : { artifactContract }), image, toolchainSha256, modalAppName: App.parse(value.modalAppName), flyAppName: App.parse(value.flyAppName) });
    }));
    this.toolchainSha256s = Object.freeze([...new Set(this.#executables.map(value => value.toolchainSha256))]);
    routers.add(this); Object.freeze(this);
  }
  async #select(input: Readonly<{ provider: "modal" | "fly"; workerOperationId: string }>, requireResource: boolean) {
    const original = await createPostgresWorkerOperationJournal(this.input.workerJournal).read(input.workerOperationId);
    if (!original || original.operationId !== input.workerOperationId || original.provider !== input.provider
      || original.policyVersion !== PRODUCTION_WORKER_POLICY.version || (requireResource && (typeof original.resourceId !== "string" || original.resourceId.length === 0))
      || !Digest.safeParse(original.sessionLeaseSha256).success || !Number.isSafeInteger(original.providerDeadlineEpochMs) || !original.providerDeadlineEpochMs || original.providerDeadlineEpochMs < 1) throw new Error("PRODUCTION_WORKER_ORIGINAL_EXECUTABLE_REQUIRED");
    const executable = this.#executables.find(value => value.image === original.image && value.toolchainSha256 === original.toolchainSha256);
    if (!executable || original.appName !== (input.provider === "modal" ? executable.modalAppName : executable.flyAppName)) throw new Error("PRODUCTION_WORKER_ORIGINAL_EXECUTABLE_REQUIRED");
    return executable;
  }
  /** Original lifecycle observation, including a lost CREATE response. This
   * cannot execute a job, create a replacement or request termination. */
  async observeTermination(input: Readonly<{ provider: "modal" | "fly"; workerOperationId: string }>) {
    const executable = await this.#select(input, false);
    return executable.clients[input.provider].observeTermination({ operationId: input.workerOperationId });
  }
  async resolve(input: Readonly<{ provider: "modal" | "fly"; workerOperationId: string }>): Promise<ProductionWorkerJobClient> {
    const executable = await this.#select(input, true);
    return new ProductionWorkerJobClient({ provider: input.provider, workerOperationId: input.workerOperationId, clients: executable.clients, workerJournal: this.input.workerJournal, jobJournal: this.input.jobJournal, toolchainSha256: executable.toolchainSha256, publication: this.input.publication,
      ...(executable.artifactContract === "nip5d-direct-v1" ? { artifactContract: executable.artifactContract } : {}) });
  }
}
