import { z } from "zod";
import type { ModalSdkPort } from "../../worker-adapters/modal-worker";

const ImageSchema = z.string().regex(/^.+@sha256:[a-f0-9]{64}$/iu);
const LoopbackOriginSchema = z.string().url().refine((value) => {
  const parsed = new URL(value);
  return parsed.protocol === "http:" && (parsed.hostname === "127.0.0.1" || parsed.hostname === "localhost");
});

const COHORTS = ["pool_hit", "pool_miss", "cold", "contention", "reclaim", "failure"] as const;

/** The immutable cross-provider envelope.  A fresh protected evidence record,
 * not this construction module, may eventually select a worker provider. */
export const WORKER_RUNNER_DEFINITION = Object.freeze({
  blockNetwork: true as const,
  noInboundPorts: true as const,
  durableBacklog: 0 as const,
  timeoutMs: 600_000,
  idleTimeoutMs: 600_000,
  cpu: 1,
  memoryMiB: 1_024,
  readinessCommand: Object.freeze(["/usr/local/bin/napplet-cvm-worker", "ready"]),
});

export type FlyFetch = (url: string, init: RequestInit) => Promise<Response>;
export type WorkerSchedule = Readonly<{ id: string; cohort: typeof COHORTS[number] }>;

function schedules(): readonly WorkerSchedule[] {
  return Object.freeze(COHORTS.map((cohort) => Object.freeze({ id: `d116-${cohort}`, cohort })));
}

/**
 * Concrete, injectable vendor transports. Their effectful methods are retained
 * behind the returned adapter descriptors and are not called during factory
 * construction, estimation, or this plan's fixture verification.
 */
export function createWorkerDeploymentClients(input: Readonly<{
  image: string;
  workspaceRoot: string;
  policyVersion: string;
  modalSdk: ModalSdkPort;
  flyFetch: FlyFetch;
  flyApiOrigin: string;
}>) {
  const image = ImageSchema.parse(input.image);
  if (!input.workspaceRoot.startsWith("/") || !input.policyVersion) throw new Error("WORKER_CLIENT_CONFIG_INVALID");
  let flyApiOrigin: string;
  try { flyApiOrigin = LoopbackOriginSchema.parse(input.flyApiOrigin).replace(/\/$/u, ""); }
  catch { throw new Error("WORKER_CLIENT_LOOPBACK_REQUIRED"); }
  const schedule = schedules();
  const definition = Object.freeze({ ...WORKER_RUNNER_DEFINITION });

  return Object.freeze({
    selection: Object.freeze({ status: "unselected" as const, reasonCode: "FRESH_PROTECTED_EVIDENCE_REQUIRED" as const }),
    modal: Object.freeze({
      definition,
      schedules: schedule,
      /** 07-26 invokes this descriptor after exact receipt validation. */
      sdk: input.modalSdk,
      config: Object.freeze({ image, workspaceRoot: input.workspaceRoot, policyVersion: input.policyVersion }),
    }),
    fly: Object.freeze({
      definition,
      schedules: schedule,
      async create(inputForOperation: Readonly<{ operationId: string; region: string }>) {
        const response = await input.flyFetch(`${flyApiOrigin}/v1/apps/napplet-cvm/machines`, {
          method: "POST",
          headers: Object.freeze({ "content-type": "application/json" }),
          body: JSON.stringify({ operationId: inputForOperation.operationId, region: inputForOperation.region, image, guest: { cpus: definition.cpu, memory_mb: definition.memoryMiB }, services: [], auto_destroy: true, restart: { policy: "no" }, metadata: { policyVersion: input.policyVersion, blockNetwork: "true" } }),
        });
        if (!response.ok) throw new Error("FLY_WORKER_REQUEST_BLOCKED");
        const body = z.object({ id: z.string().min(1).max(128) }).strict().safeParse(await response.json());
        if (!body.success) throw new Error("FLY_WORKER_RESPONSE_INVALID");
        return Object.freeze({ id: body.data.id });
      },
      config: Object.freeze({ image, workspaceRoot: input.workspaceRoot, policyVersion: input.policyVersion }),
    }),
  });
}
