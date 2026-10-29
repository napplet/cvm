import { z } from "zod";
import { PHASE_02_POLICY_INITIAL } from "../../policy/phase-02-policy";
import type { WorkerBenchmarkSample } from "../../admission/benchmark";
import { ModalWorkerConfigSchema, type ModalSandboxCreateOptions, type ModalSandboxPort, type ModalSdkPort, type ModalWorkerConfig } from "../../worker-adapters/modal-worker";
import type { ReleaseProviderPort } from "../providers";
import type { WorkerOperationJournal } from "../deployment/worker-clients";

const DigestSchema = z.string().regex(/^[a-f0-9]{64}$/iu);
const OperationIdSchema = z.string().regex(/^[a-z][a-z0-9_-]{2,127}$/u);
const CohortSchema = z.enum(["pool_hit", "pool_miss", "cold", "step_load", "contention", "reclaim", "ambiguity", "cleanup", "failure"]);
const ReadyObservationSchema = z.object({
  operationId: OperationIdSchema,
  cohort: CohortSchema.optional(),
  status: z.literal("ready"),
  isolation: z.literal("passed"),
  readyLeaseCount: z.literal(1),
  durableBacklogCount: z.literal(0),
}).strict();

export type ModalReadinessCommandPort = Readonly<{
  observeReady(input: Readonly<{ operationId: string; sandboxId: string; cohort?: z.infer<typeof CohortSchema> }>): Promise<unknown>;
}>;

export type ModalLiveWorkerProvider = ReleaseProviderPort & Readonly<{
  evidenceClass: "protected_live";
  executeSample(sample: Readonly<Pick<WorkerBenchmarkSample, "id" | "cohort">>): Promise<unknown>;
}>;

type Operation = { requestSha256: string; sandbox?: ModalSandboxPort; readiness?: z.infer<typeof ReadyObservationSchema>; cleanup: "pending" | "cleaned"; sample?: Readonly<Record<string, unknown>> };

function createOptions(config: ModalWorkerConfig, operationId: string): ModalSandboxCreateOptions {
  const [cpu, cpuLimit] = PHASE_02_POLICY_INITIAL.sandbox.cpu.split("/").map(Number);
  const [memoryGiB, memoryLimitGiB] = PHASE_02_POLICY_INITIAL.sandbox.memoryGiB.split("/").map(Number);
  return Object.freeze({
    cpu, cpuLimit, memoryMiB: memoryGiB * 1024, memoryLimitMiB: memoryLimitGiB * 1024,
    timeoutMs: PHASE_02_POLICY_INITIAL.sandbox.lifetimeMinutes * 60_000,
    idleTimeoutMs: PHASE_02_POLICY_INITIAL.sandbox.idleTimeoutMinutes * 60_000,
    workdir: config.workspaceRoot,
    command: Object.freeze(["/bin/sh", "-c", "while true; do sleep 60; done"]),
    env: Object.freeze({ NAPPLET_CVM_POLICY_VERSION: config.policyVersion }),
    blockNetwork: true,
    tags: Object.freeze({ ...config.tags }),
    name: `napplet-cvm-${operationId}`,
    ...(config.regions ? { regions: Object.freeze([...config.regions]) } : {}),
  });
}

/** Native SDK composition remains injected. ReleaseProviderRegistry validates the
 * exact authorization receipt immediately before it calls this mutation port. */
class ModalLiveWorkerProviderImpl implements ModalLiveWorkerProvider {
  readonly evidenceClass = "protected_live" as const;
  readonly #config: ModalWorkerConfig;
  readonly #sdk: ModalSdkPort;
  readonly #command: ModalReadinessCommandPort;
  readonly #now: () => number;
  readonly #journal: WorkerOperationJournal;
  readonly #operations = new Map<string, Operation>();

  constructor(input: Readonly<{ config: unknown; sdk: ModalSdkPort; command: ModalReadinessCommandPort; journal: WorkerOperationJournal; now?: () => number }>) {
    this.#config = ModalWorkerConfigSchema.parse(input.config);
    this.#sdk = input.sdk; this.#command = input.command; this.#journal = input.journal; this.#now = input.now ?? Date.now;
  }

  async discoverCapabilities() { return { capability: "available" as const }; }
  async discoverAuthentication() { return { authentication: "authorized" as const }; }
  async plan(input: Readonly<{ operationId: string; effectId: string; region: string; desiredDigest: string }>) {
    OperationIdSchema.parse(input.operationId); DigestSchema.parse(input.desiredDigest);
    const operationId = OperationIdSchema.parse(input.operationId);
    const record = await this.#journal.claim({ operationId, requestSha256: DigestSchema.parse(input.desiredDigest), resourceName: `napplet-cvm-${operationId}` });
    if (record.record.operationId !== operationId || record.record.requestSha256 !== input.desiredDigest || record.record.resourceName !== `napplet-cvm-${operationId}`) throw new Error("MODAL_OPERATION_IDENTITY_CONFLICT");
    const existing = this.#operations.get(operationId);
    if (existing && existing.requestSha256 !== input.desiredDigest) throw new Error("MODAL_OPERATION_IDENTITY_CONFLICT");
    this.#operations.set(operationId, existing ?? { cleanup: "pending", requestSha256: input.desiredDigest });
    return { status: "planned" as const, estimatedCostMicros: 0 };
  }

  async #reconcile(operationId: string, cohort?: z.infer<typeof CohortSchema>): Promise<z.infer<typeof ReadyObservationSchema> | undefined> {
    const operation = this.#operations.get(operationId);
    if (!operation?.sandbox) return operation?.readiness;
    const observed = ReadyObservationSchema.parse(await this.#command.observeReady({ operationId, sandboxId: operation.sandbox.id, ...(cohort ? { cohort } : {}) }));
    if (observed.operationId !== operationId || (cohort && observed.cohort !== cohort)) throw new Error("MODAL_READINESS_OPERATION_MISMATCH");
    operation.readiness = observed;
    return observed;
  }

  async #ensureReady(operationId: string, cohort?: z.infer<typeof CohortSchema>): Promise<z.infer<typeof ReadyObservationSchema>> {
    const operation = this.#operations.get(operationId);
    if (!operation) throw new Error("MODAL_OPERATION_NOT_PLANNED");
    const record = await this.#journal.read(operationId);
    if (!record) throw new Error("MODAL_OPERATION_NOT_DURABLE");
    if (record.operationId !== operationId || record.requestSha256 !== operation.requestSha256 || record.resourceName !== `napplet-cvm-${operationId}` || (operation.sandbox && record.resourceId && record.resourceId !== operation.sandbox.id)) throw new Error("MODAL_OPERATION_IDENTITY_CONFLICT");
    if (operation.readiness) return operation.readiness;
    if (operation.sandbox) return (await this.#reconcile(operationId, cohort))!;
    const app = await this.#sdk.apps.fromName(this.#config.appName, { createIfMissing: false });
    if (record.resourceId) {
      if (!this.#sdk.sandboxes.fromId) throw new Error("MODAL_REATTACH_UNSUPPORTED");
      operation.sandbox = await this.#sdk.sandboxes.fromId(record.resourceId);
      return (await this.#reconcile(operationId, cohort))!;
    }
    if (!this.#sdk.sandboxes.findByName) throw new Error("MODAL_LOST_CREATE_LOOKUP_UNSUPPORTED");
    const existing = await this.#sdk.sandboxes.findByName(this.#config.appName, record.resourceName);
    if (existing.kind === "unknown") throw new Error("MODAL_LOST_CREATE_UNKNOWN");
    if (existing.kind === "found") {
      operation.sandbox = existing.sandbox;
      await this.#journal.update({ operationId, requestSha256: record.requestSha256, state: "reconciled", resourceId: existing.sandbox.id });
      return (await this.#reconcile(operationId, cohort))!;
    }
    if (record.state !== "claimed") throw new Error("MODAL_LOST_CREATE_UNCERTAIN");
    const image = this.#sdk.images.fromRegistry(this.#config.image);
    await this.#journal.update({ operationId, requestSha256: record.requestSha256, state: "dispatching" });
    try {
      operation.sandbox = await this.#sdk.sandboxes.create(app, image, createOptions(this.#config, operationId));
      await this.#journal.update({ operationId, requestSha256: record.requestSha256, state: "dispatched", resourceId: operation.sandbox.id });
    } catch (error) {
      await this.#journal.update({ operationId, requestSha256: record.requestSha256, state: "unknown" });
      throw error;
    }
    return (await this.#reconcile(operationId, cohort))!;
  }

  async apply(input: Readonly<{ operationId: string; effectId: string; region: string; desiredDigest: string }>) {
    try {
      const operationId = OperationIdSchema.parse(input.operationId);
      if (this.#operations.get(operationId)?.requestSha256 !== DigestSchema.parse(input.desiredDigest)) throw new Error("MODAL_OPERATION_IDENTITY_CONFLICT");
      await this.#ensureReady(operationId); return { status: "applied" as const, actualCostMicros: 0 };
    }
    catch { return { status: "unknown" as const, actualCostMicros: 0 }; }
  }
  async observe(input: Readonly<{ operationId: string }>) {
    const operationId = OperationIdSchema.parse(input.operationId); const operation = this.#operations.get(operationId);
    if (!operation) return { status: "missing" as const, actualCostMicros: 0 };
    try { return { status: (await this.#ensureReady(operationId)) ? "completed" as const : "pending" as const, actualCostMicros: 0 }; }
    catch { return { status: "unknown" as const, actualCostMicros: 0 }; }
  }
  async cleanup(input: Readonly<{ operationId: string; resourceIdentitySha256?: string }>) {
    const operationId = OperationIdSchema.parse(input.operationId); const operation = this.#operations.get(operationId);
    if (!operation?.sandbox || operation.cleanup === "cleaned") return { status: "blocked" as const, actualCostMicros: 0 };
    try {
      const record = await this.#journal.read(operationId); if (!record?.resourceId || record.operationId !== operationId || record.requestSha256 !== operation.requestSha256 || record.resourceName !== `napplet-cvm-${operationId}` || record.resourceId !== operation.sandbox.id) return { status: "blocked" as const, actualCostMicros: 0 };
      await this.#journal.update({ operationId, requestSha256: record.requestSha256, state: "terminating", resourceId: record.resourceId });
      await operation.sandbox.terminate();
      const observed = this.#sdk.sandboxes.findByName ? await this.#sdk.sandboxes.findByName(this.#config.appName, record.resourceName) : Object.freeze({ kind: "unknown" as const });
      if (observed.kind !== "missing") return { status: "pending" as const, actualCostMicros: 0 };
      await this.#journal.update({ operationId, requestSha256: record.requestSha256, state: "terminated", resourceId: record.resourceId });
      operation.cleanup = "cleaned"; return { status: "cleaned" as const, actualCostMicros: 0 };
    }
    catch { return { status: "pending" as const, actualCostMicros: 0 }; }
  }
  async executeSample(sample: Readonly<Pick<WorkerBenchmarkSample, "id" | "cohort">>) {
    const cohort = CohortSchema.parse(sample.cohort); const operationId = `benchmark-${sample.id}`;
    const existing = this.#operations.get(operationId);
    if (existing?.sample) return existing.sample;
    if (!existing) await this.plan({ operationId, effectId: "modal-benchmark", region: "global", desiredDigest: "0".repeat(64) });
    const receiptMonotonicMs = this.#now();
    await this.#ensureReady(operationId, cohort);
    const readyMonotonicMs = this.#now();
    const cleanup = await this.cleanup({ operationId });
    const result = Object.freeze({ id: sample.id, cohort, outcome: "accepted" as const, receiptMonotonicMs, readyMonotonicMs, readyLeaseCount: 1, durableBacklogCount: 0, isolation: "passed" as const, cleanup: cleanup.status === "cleaned" ? "passed" as const : "failed" as const });
    this.#operations.get(operationId)!.sample = result;
    return result;
  }
}

export function createModalLiveWorkerProvider(input: Readonly<{ config: unknown; sdk: ModalSdkPort; command: ModalReadinessCommandPort; journal: WorkerOperationJournal; now?: () => number }>): ModalLiveWorkerProvider {
  return new ModalLiveWorkerProviderImpl(input);
}
