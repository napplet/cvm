import { createHash } from "node:crypto";
import { z } from "zod";
import type { CapacityObservation, ReadyCapacityPort } from "../funding/funded-admission";
import { PRODUCTION_WORKER_POLICY } from "../worker-adapters/production-worker-policy";
import type { createWorkerDeploymentClients, WorkerOperationRecord } from "../release/deployment/worker-clients";
import { PostgresOperationJournal, assertPostgresOperationJournal } from "../release/deployment/postgres-operation-journal";

const Intent = z.string().regex(/^capacity-intent:[a-f0-9]{64}$/u);
const Binding = z.string().regex(/^sha256:[a-f0-9]{64}$/u);
const Reference = z.string().regex(/^capacity:[a-f0-9]{64}$/u);
const Digest = z.string().regex(/^[a-f0-9]{64}$/u);
const Provider = z.enum(["modal", "fly"]);

type CapacityRecord = Readonly<{
  intentReference: string;
  expectedSessionBindingDigest: string;
  reference: string;
  workerOperationId: string;
  provider: "modal" | "fly";
  deadlineEpochMs: number;
  /** Immutable execution facts; absent only on retained pre-profile records. */
  execution?: Readonly<{ image: string; toolchainSha256: string; policyVersion: string; flyRegion?: string }>;
  prewarmed?: boolean;
  readiness?: Readonly<{ readyMonotonicMs: number; readinessProbeDigest: string }>;
}>;

export type ProductionReadyCapacityPort = ReadyCapacityPort & Readonly<{
  /** Prepare this exact authenticated future binding; never credit or admit it. */
  prewarm(input: Readonly<{ intentReference: string; expectedSessionBindingDigest: string }>): Promise<CapacityObservation>;
  inspect(input: Readonly<{ intentReference: string }>): Promise<CapacityRecord | undefined>;
  /** Query-only proof for a previously requested worker release. */
  observeRelease(input: Readonly<{ intentReference: string; reference: string }>): Promise<Readonly<{ status: "terminated" | "pending" | "unknown" | "blocked" }>>;
}>;
const capacities = new WeakSet<object>();
export function assertProductionReadyCapacity(value: unknown): asserts value is ProductionReadyCapacityPort {
  if (!value || typeof value !== "object" || !capacities.has(value)) throw new Error("PRODUCTION_READY_CAPACITY_REQUIRED");
}

const digest = (value: string) => createHash("sha256").update(value).digest("hex");
const canonical = (value: unknown) => JSON.stringify(value);
/* `capacity-` is nine bytes; keep the provider operation under the worker
 * client's 49-character validation ceiling while retaining 160 bits. */
const workerOperationId = (intentReference: string, binding: string) => `capacity-${digest(`${intentReference}:${binding}`).slice(0, 40)}`;

/**
 * Immediate-only, durable worker capacity.  It creates/reconciles exactly one
 * isolated worker for the persisted admission intent and never queues work.
 * A reservation becomes usable only after the provider's immutable readiness
 * probe succeeds; otherwise the funding path gets a refusal/unknown before a
 * cap hold or paid model request can be accepted.
 */
export function createProductionReadyCapacity(input: Readonly<{
  provider: "modal" | "fly";
  workers: ReturnType<typeof createWorkerDeploymentClients>;
  journal: PostgresOperationJournal;
  workerJournal: PostgresOperationJournal;
  image: string;
  toolchainSha256: string;
  flyRegion?: string;
  now?: () => number;
}>): ProductionReadyCapacityPort {
  const provider = Provider.parse(input.provider);
  assertPostgresOperationJournal(input.journal);
  assertPostgresOperationJournal(input.workerJournal);
  const image = z.string().regex(/^.+@sha256:[a-f0-9]{64}$/iu).parse(input.image);
  Digest.parse(image.split("@sha256:")[1]!.toLowerCase());
  const toolchainSha256 = Digest.parse(input.toolchainSha256);
  const flyRegion = input.flyRegion === undefined ? undefined : z.string().regex(/^[a-z0-9-]{2,32}$/u).parse(input.flyRegion);
  if (provider === "fly" && !flyRegion) throw new Error("PRODUCTION_FLY_CAPACITY_REGION_REQUIRED");
  const execution = Object.freeze({ image, toolchainSha256, policyVersion: PRODUCTION_WORKER_POLICY.version, ...(provider === "fly" ? { flyRegion } : {}) });
  const now = input.now ?? Date.now;
  const capacityKey = (intentReference: string) => `capacity-intent:${digest(intentReference)}`;
  const load = async (intentReference: string): Promise<CapacityRecord | undefined> => (await input.journal.read<CapacityRecord>(capacityKey(Intent.parse(intentReference))))?.value;
  const originalWorker = async (record: CapacityRecord): Promise<WorkerOperationRecord | undefined> => {
    const original = (await input.workerJournal.read<WorkerOperationRecord>(record.workerOperationId))?.value;
    if (!original || record.provider !== provider || original.operationId !== record.workerOperationId || original.provider !== record.provider
      || original.sessionLeaseSha256 !== record.expectedSessionBindingDigest.slice("sha256:".length)
      || original.providerDeadlineEpochMs !== record.deadlineEpochMs || original.policyVersion !== PRODUCTION_WORKER_POLICY.version
      || !original.image || !/^.+@sha256:[a-f0-9]{64}$/iu.test(original.image) || !Digest.safeParse(original.toolchainSha256).success) return undefined;
    if (record.execution && (record.execution.image !== original.image || record.execution.toolchainSha256 !== original.toolchainSha256
      || record.execution.policyVersion !== original.policyVersion || (provider === "fly" && record.execution.flyRegion !== original.region))) return undefined;
    return original;
  };
  const ensure = async (intentReferenceRaw: string, expectedBindingRaw: string): Promise<CapacityRecord> => {
    const intentReference = Intent.parse(intentReferenceRaw); const expectedSessionBindingDigest = Binding.parse(expectedBindingRaw);
    const value = Object.freeze({ intentReference, expectedSessionBindingDigest, reference: `capacity:${digest(`${intentReference}:${expectedSessionBindingDigest}`)}`, workerOperationId: workerOperationId(intentReference, expectedSessionBindingDigest), provider, execution, deadlineEpochMs: now() + PRODUCTION_WORKER_POLICY.totalLifetimeMs });
    const claimed = await input.journal.claim<CapacityRecord>(capacityKey(intentReference), digest(canonical({ intentReference, expectedSessionBindingDigest, provider })), value);
    const record = claimed.record.value;
    if (record.intentReference !== intentReference || record.expectedSessionBindingDigest !== expectedSessionBindingDigest || record.provider !== provider || record.reference !== value.reference || record.workerOperationId !== value.workerOperationId || !Number.isSafeInteger(record.deadlineEpochMs) || record.deadlineEpochMs <= now()) throw new Error("PRODUCTION_CAPACITY_BINDING_CONFLICT");
    if (record.execution) {
      if (record.execution.image !== image || record.execution.toolchainSha256 !== toolchainSha256 || record.execution.policyVersion !== execution.policyVersion
        || record.execution.flyRegion !== execution.flyRegion) throw new Error("PRODUCTION_CAPACITY_ORIGINAL_PROFILE_REQUIRED");
    } else {
      // Never stamp current defaults onto an old record. Only its original
      // provider intent can establish compatibility without a rewrite.
      const original = await originalWorker(record);
      if (!original || original.image !== image || original.toolchainSha256 !== toolchainSha256
        || (provider === "fly" && original.region !== flyRegion)) throw new Error("PRODUCTION_CAPACITY_ORIGINAL_PROFILE_REQUIRED");
    }
    return record;
  };
  const dispatch = async (record: CapacityRecord) => {
    // Once the original resource is bound, retries need only readiness. A
    // missing resource ID still enters the provider client's durable claim
    // branch, which reconciles the original request without another create.
    if ((await input.workerJournal.read<WorkerOperationRecord>(record.workerOperationId))?.value.resourceId) return { status: "reconciled" as const };
    const leaseSha256 = record.expectedSessionBindingDigest.slice("sha256:".length);
    return provider === "modal"
      ? input.workers.modal.create({ operationId: record.workerOperationId, sessionLeaseSha256: leaseSha256, toolchainSha256, providerDeadlineEpochMs: record.deadlineEpochMs })
      : input.workers.fly.create({ operationId: record.workerOperationId, region: flyRegion!, sessionLeaseSha256: leaseSha256, toolchainSha256, providerDeadlineEpochMs: record.deadlineEpochMs });
  };
  const observe = async (record: CapacityRecord, persistAdmissionReadiness = true): Promise<CapacityObservation> => {
    const original = await originalWorker(record);
    if (!original?.resourceId) return Object.freeze({ status: "unknown" as const, reference: record.reference });
    const status = provider === "modal"
      ? await input.workers.modal.observe({ operationId: record.workerOperationId })
      : await input.workers.fly.observe({ operationId: record.workerOperationId });
    if (status.status === "missing") return Object.freeze({ status: "refused" as const, reason: "worker_missing" });
    if (status.status !== "completed" || status.resourceId !== original.resourceId || !status.readiness) return Object.freeze({ status: "unknown" as const, reference: record.reference });
    const observed = z.object({ readyMonotonicMs: z.number().int().nonnegative(), readinessProbeDigest: z.string().regex(/^sha256:[a-f0-9]{64}$/u) }).safeParse(status.readiness);
    if (!observed.success) return Object.freeze({ status: "unknown" as const, reference: record.reference });
    let readiness = persistAdmissionReadiness ? record.readiness : observed.data;
    if (!readiness) {
      const stored = await input.journal.read<CapacityRecord>(capacityKey(record.intentReference));
      if (!stored || stored.value.workerOperationId !== record.workerOperationId) return Object.freeze({ status: "unknown" as const, reference: record.reference });
      const saved = await input.journal.compareAndSet<CapacityRecord>(capacityKey(record.intentReference), digest(canonical({ intentReference: record.intentReference, expectedSessionBindingDigest: record.expectedSessionBindingDigest, provider })), stored.revision, { ...stored.value, readiness: observed.data });
      if (!saved) {
        const reconciled = await input.journal.read<CapacityRecord>(capacityKey(record.intentReference));
        if (!reconciled?.value.readiness) return Object.freeze({ status: "unknown" as const, reference: record.reference });
        readiness = reconciled.value.readiness;
      } else readiness = saved.value.readiness;
    }
    if (!readiness) return Object.freeze({ status: "unknown" as const, reference: record.reference });
    return Object.freeze({
      status: "available" as const,
      reference: record.reference,
      expiresAt: new Date(record.deadlineEpochMs).toISOString(),
      usable: true as const,
      ready: Object.freeze({
        intentReference: record.intentReference,
        leaseReference: record.reference,
        sessionBindingDigest: record.expectedSessionBindingDigest,
        imageDigest: `sha256:${original.image!.split("@sha256:")[1]!.toLowerCase()}`,
        readinessProbeDigest: readiness.readinessProbeDigest,
        readyMonotonicMs: readiness.readyMonotonicMs,
      }),
    });
  };
  const capacity = Object.freeze<ProductionReadyCapacityPort>({
    async inspect(value) { return load(Intent.parse(value.intentReference)); },
    async prewarm(value) {
      const record = await ensure(value.intentReference, value.expectedSessionBindingDigest);
      if (record.readiness) throw new Error("PRODUCTION_CAPACITY_ALREADY_ADMITTED");
      const created = await dispatch(record);
      if (created.status === "unknown") return Object.freeze({ status: "unknown" as const, reference: record.reference });
      const ready = await observe(record, false);
      if (ready.status !== "available") return ready;
      const stored = await input.journal.read<CapacityRecord>(capacityKey(record.intentReference));
      if (!stored || stored.value.readiness) throw new Error("PRODUCTION_CAPACITY_PREWARM_CONFLICT");
      if (!stored.value.prewarmed && !await input.journal.compareAndSet(capacityKey(record.intentReference), stored.identitySha256, stored.revision, { ...stored.value, prewarmed: true })) throw new Error("PRODUCTION_CAPACITY_PREWARM_CONFLICT");
      return ready;
    },
    async reserveNow(value: Readonly<{ intentReference: string; expectedSessionBindingDigest: string }>) {
      const record = await ensure(value.intentReference, value.expectedSessionBindingDigest);
      if (!record.prewarmed) {
        const created = await dispatch(record);
        if (created.status === "unknown") return Object.freeze({ status: "unknown" as const, reference: record.reference });
      }
      return observe(record);
    },
    async observe(value: Readonly<{ intentReference: string; expectedSessionBindingDigest: string; reference?: string }>) {
      const intentReference = Intent.parse(value.intentReference); const expectedSessionBindingDigest = Binding.parse(value.expectedSessionBindingDigest);
      const record = await load(intentReference);
      if (!record) return Object.freeze({ status: "unknown" as const, ...(value.reference ? { reference: Reference.parse(value.reference) } : {}) });
      if (record.expectedSessionBindingDigest !== expectedSessionBindingDigest || (value.reference !== undefined && record.reference !== Reference.parse(value.reference))) return Object.freeze({ status: "unknown" as const, reference: record.reference });
      return observe(record);
    },
    async release(value: Readonly<{ intentReference: string; reference: string }>) {
      const intentReference = Intent.parse(value.intentReference); const reference = Reference.parse(value.reference); const record = await load(intentReference);
      if (!record || record.reference !== reference) throw new Error("PRODUCTION_CAPACITY_RELEASE_BINDING_REQUIRED");
      const observed = provider === "modal"
        ? await input.workers.modal.observeTermination({ operationId: record.workerOperationId })
        : await input.workers.fly.observeTermination({ operationId: record.workerOperationId });
      if (observed.status === "terminated") return;
      if (observed.status !== "pending") throw new Error("PRODUCTION_CAPACITY_RELEASE_UNCONFIRMED");
      const terminated = provider === "modal"
        ? await input.workers.modal.terminate({ operationId: record.workerOperationId })
        : await input.workers.fly.terminate({ operationId: record.workerOperationId });
      if (terminated.status !== "terminated") throw new Error("PRODUCTION_CAPACITY_RELEASE_UNCONFIRMED");
    },
    async observeRelease(value) {
      const intentReference = Intent.parse(value.intentReference); const reference = Reference.parse(value.reference); const record = await load(intentReference);
      if (!record || record.reference !== reference) return Object.freeze({ status: "blocked" as const });
      return provider === "modal"
        ? input.workers.modal.observeTermination({ operationId: record.workerOperationId })
        : input.workers.fly.observeTermination({ operationId: record.workerOperationId });
    },
  });
  capacities.add(capacity);
  return capacity;
}
