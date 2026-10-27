import { z } from "zod";
import { ModalClient, NotFoundError } from "modal";
import type { ModalSdkPort, ModalSandboxPort, ModalSandboxCreateOptions } from "../worker-adapters/modal-worker";
import { createFlyMachinesHttpTransport, createWorkerDeploymentClients, type WorkerOperationJournal } from "../release/deployment/worker-clients";
import type { ModalReadinessCommandPort } from "../release/native/modal";
import type { FlyReadinessCommandPort } from "../release/native/fly";
import { PRODUCTION_WORKER_POLICY } from "../worker-adapters/production-worker-policy";
import type { MountedProductionSecretMaterial } from "./secret-material";
import type { ProductionConfig } from "./config";

const ModalAccess = z.object({ tokenId: z.string().min(16).max(512), tokenSecret: z.string().min(16).max(2048), appName: z.string().regex(/^[a-z][a-z0-9-]{2,62}$/u), environment: z.string().min(1).max(128).optional() }).strict();
const FlyAccess = z.object({ token: z.string().min(12).max(2048).refine(value => !/\s/u.test(value)), appName: z.string().regex(/^[a-z][a-z0-9-]{2,62}$/u), region: z.string().regex(/^[a-z0-9-]{2,32}$/u) }).strict();

function modalPort(sandbox: any): ModalSandboxPort {
  return Object.freeze({
    id: String(sandbox.sandboxId),
    getTags: () => sandbox.getTags(),
    exec: (argv: readonly string[], options: Readonly<{ timeoutMs: number }>) => sandbox.exec([...argv], options),
    poll: () => sandbox.poll(),
    terminate: () => sandbox.terminate(),
    filesystem: Object.freeze({
      copyFromLocal: (localPath: string, remotePath: string) => sandbox.filesystem.copyFromLocal(localPath, remotePath),
      copyToLocal: (remotePath: string, localPath: string) => sandbox.filesystem.copyToLocal(remotePath, localPath),
      async listFiles(remotePath: string) {
        const listing = await sandbox.filesystem.listFiles(remotePath);
        if (!Array.isArray(listing)) throw new Error("MODAL_FILESYSTEM_LIST_INVALID");
        const prefix = `${remotePath.replace(/\/$/u, "")}/`;
        return listing.map((entry: unknown) => {
          const path = entry && typeof entry === "object" && typeof (entry as { path?: unknown }).path === "string" ? (entry as { path: string }).path : undefined;
          if (!path || !path.startsWith(prefix)) throw new Error("MODAL_FILESYSTEM_LIST_INVALID");
          return path.slice(prefix.length);
        });
      },
    }),
  });
}

function modalSdk(access: z.infer<typeof ModalAccess>): ModalSdkPort {
  const client = new ModalClient({ tokenId: access.tokenId, tokenSecret: access.tokenSecret, ...(access.environment ? { environment: access.environment } : {}) });
  return Object.freeze({
    apps: Object.freeze({ fromName: (name: string, options: Readonly<{ createIfMissing: false }>) => client.apps.fromName(name, options) }),
    images: Object.freeze({ fromRegistry: (image: string) => client.images.fromRegistry(image) }),
    sandboxes: Object.freeze({
      async create(app: unknown, image: unknown, options: ModalSandboxCreateOptions) { return modalPort(await client.sandboxes.create(app as never, image as never, options as never)); },
      async fromId(id: string) { return modalPort(await client.sandboxes.fromId(id)); },
      async findByName(appName: string, name: string) {
        try { return Object.freeze({ kind: "found" as const, sandbox: modalPort(await client.sandboxes.fromName(appName, name)) }); }
        catch (error) { return error instanceof NotFoundError ? Object.freeze({ kind: "missing" as const }) : Object.freeze({ kind: "unknown" as const }); }
      },
    }),
  });
}

/** Reconcile only the exact durable original worker operation.  The native
 * certification providers use this instead of a caller-installed readiness
 * callback, preserving provider identity across a process restart. */
export function createMountedWorkerReadinessCommands(input: Readonly<{
  clients: ReturnType<typeof createWorkerDeploymentClients>;
  journal: WorkerOperationJournal;
}>): Readonly<{ modal: ModalReadinessCommandPort; fly: FlyReadinessCommandPort }> {
  const ready = async (provider: "modal" | "fly", operationId: string, resourceId: string) => {
    const record = await input.journal.read(operationId);
    if (!record?.resourceId || record.resourceId !== resourceId || record.provider !== provider) return { status: "unknown" as const };
    const observed = provider === "modal" ? await input.clients.modal.observe({ operationId }) : await input.clients.fly.observe({ operationId });
    if (observed.status !== "completed" || !observed.readiness) return { status: observed.status === "missing" ? "unknown" as const : observed.status };
    return Object.freeze({ operationId, status: "ready" as const, isolation: "passed" as const, readyLeaseCount: 1 as const, durableBacklogCount: 0 as const });
  };
  return Object.freeze({
    modal: Object.freeze({ observeReady: (value: Parameters<ModalReadinessCommandPort["observeReady"]>[0]) => ready("modal", value.operationId, value.sandboxId) }),
    fly: Object.freeze({ observeReady: (value: Parameters<FlyReadinessCommandPort["observeReady"]>[0]) => ready("fly", value.operationId, value.machineId) }),
  });
}

/** Materializes provider credentials only in the trusted coordinator process.
 * The returned ports never reach a generated worker and have no environment
 * fallback: a missing mounted record is a startup failure. */
export async function createMountedProductionWorkerClients(input: Readonly<{
  config: ProductionConfig;
  secrets: MountedProductionSecretMaterial;
  journal: WorkerOperationJournal;
}>) {
  const modal = ModalAccess.parse(JSON.parse(await input.secrets.text("worker.modalAccessReference", 8_192)));
  const fly = FlyAccess.parse(JSON.parse(await input.secrets.text("worker.flyAccessReference", 8_192)));
  const modalTransport = modalSdk(modal);
  const flyTransport = createFlyMachinesHttpTransport({ appName: fly.appName, getAccessToken: async () => fly.token, journal: input.journal, fetch });
  const clients = createWorkerDeploymentClients({
    image: input.config.worker.image,
    workspaceRoot: PRODUCTION_WORKER_POLICY.workspaceRoot,
    policyVersion: PRODUCTION_WORKER_POLICY.version,
    modalAppName: modal.appName,
    modalTags: Object.freeze({ "napplet-cvm-realm": "production-real" }),
    modalRegions: input.config.regions,
    journal: input.journal,
    modalSdk: modalTransport,
    fly: flyTransport,
  });
  /* Raw SDK/API ports remain coordinator-only and are exposed solely for the
   * native certification adapters; neither is serializable or request-owned. */
  return Object.freeze({ clients, flyRegion: fly.region, certification: Object.freeze({
    modalSdk: modalTransport,
    modalConfig: Object.freeze({ appName: modal.appName, image: input.config.worker.image, workspaceRoot: PRODUCTION_WORKER_POLICY.workspaceRoot, tags: Object.freeze({ "napplet-cvm-realm": "production-real" }), regions: input.config.regions, policyVersion: PRODUCTION_WORKER_POLICY.version }),
    flyClient: flyTransport,
    flyConfig: Object.freeze({ appName: fly.appName, image: input.config.worker.image, region: fly.region }),
  }) });
}
