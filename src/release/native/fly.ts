import { z } from "zod";
import { PHASE_02_POLICY_INITIAL } from "../../policy/phase-02-policy";
import type { WorkerBenchmarkSample } from "../../admission/benchmark";
import type { FlyMachinesClientPort, FlyWorkerConfig } from "../../worker-adapters/fly-worker";
import { FlyWorkerConfigSchema } from "../../worker-adapters/fly-worker";
import type { ReleaseProviderPort } from "../providers";

const DigestSchema = z.string().regex(/^[a-f0-9]{64}$/iu);
const OperationIdSchema = z.string().regex(/^[a-z][a-z0-9_-]{2,127}$/u);
const CohortSchema = z.enum(["pool_hit", "pool_miss", "cold", "step_load", "contention", "reclaim", "ambiguity", "cleanup", "failure"]);
const ReadyObservationSchema = z.object({ operationId: OperationIdSchema, cohort: CohortSchema.optional(), status: z.literal("ready"), isolation: z.literal("passed"), readyLeaseCount: z.literal(1), durableBacklogCount: z.literal(0) }).strict();

type NativeFlyMachinesClientPort = Omit<FlyMachinesClientPort, "create"> & Readonly<{
  create(input: Readonly<{ appName: string; image: string; region: string; command: readonly string[]; blockNetwork: true; noInboundPorts: true; cpu: number; memoryMiB: number; timeoutMs: number; idleTimeoutMs: number }>): Promise<Readonly<{ id: string }>>;
}>;
export type FlyReadinessCommandPort = Readonly<{ observeReady(input: Readonly<{ operationId: string; machineId: string; cohort?: z.infer<typeof CohortSchema> }>): Promise<unknown> }>;
export type FlyLiveWorkerProvider = ReleaseProviderPort & Readonly<{ evidenceClass: "protected_live"; executeSample(sample: Readonly<Pick<WorkerBenchmarkSample, "id" | "cohort">>): Promise<unknown> }>;
type Operation = { machineId?: string; readiness?: z.infer<typeof ReadyObservationSchema>; cleanup: "pending" | "cleaned"; sample?: Readonly<Record<string, unknown>> };

function createOptions(config: FlyWorkerConfig) {
  const [cpu] = PHASE_02_POLICY_INITIAL.sandbox.cpu.split("/").map(Number);
  const [memoryGiB] = PHASE_02_POLICY_INITIAL.sandbox.memoryGiB.split("/").map(Number);
  return Object.freeze({ appName: config.appName, image: config.image, region: config.region, command: Object.freeze(["/usr/local/bin/napplet-cvm-worker", "run-proposal"]), blockNetwork: true as const, noInboundPorts: true as const, cpu, memoryMiB: memoryGiB * 1024, timeoutMs: PHASE_02_POLICY_INITIAL.sandbox.lifetimeMinutes * 60_000, idleTimeoutMs: PHASE_02_POLICY_INITIAL.sandbox.idleTimeoutMinutes * 60_000 });
}

class FlyLiveWorkerProviderImpl implements FlyLiveWorkerProvider {
  readonly evidenceClass = "protected_live" as const;
  readonly #config: FlyWorkerConfig; readonly #client: NativeFlyMachinesClientPort; readonly #command: FlyReadinessCommandPort; readonly #now: () => number; readonly #operations = new Map<string, Operation>();
  constructor(input: Readonly<{ config: unknown; client: NativeFlyMachinesClientPort; command: FlyReadinessCommandPort; now?: () => number }>) { this.#config = FlyWorkerConfigSchema.parse(input.config); this.#client = input.client; this.#command = input.command; this.#now = input.now ?? Date.now; }
  async discoverCapabilities() { return { capability: "available" as const }; }
  async discoverAuthentication() { return { authentication: "authorized" as const }; }
  async plan(input: Readonly<{ operationId: string; effectId: string; region: string; desiredDigest: string }>) { OperationIdSchema.parse(input.operationId); DigestSchema.parse(input.desiredDigest); this.#operations.set(input.operationId, this.#operations.get(input.operationId) ?? { cleanup: "pending" }); return { status: "planned" as const, estimatedCostMicros: 0 }; }
  async #reconcile(operationId: string, cohort?: z.infer<typeof CohortSchema>) { const operation = this.#operations.get(operationId); if (!operation?.machineId) return operation?.readiness; const observed = ReadyObservationSchema.parse(await this.#command.observeReady({ operationId, machineId: operation.machineId, ...(cohort ? { cohort } : {}) })); if (observed.operationId !== operationId || (cohort && observed.cohort !== cohort)) throw new Error("FLY_READINESS_OPERATION_MISMATCH"); operation.readiness = observed; return observed; }
  async #ensureReady(operationId: string, cohort?: z.infer<typeof CohortSchema>) { const operation = this.#operations.get(operationId); if (!operation) throw new Error("FLY_OPERATION_NOT_PLANNED"); if (operation.readiness) return operation.readiness; if (!operation.machineId) operation.machineId = (await this.#client.create(createOptions(this.#config))).id; return (await this.#reconcile(operationId, cohort))!; }
  async apply(input: Readonly<{ operationId: string; effectId: string; region: string; desiredDigest: string }>) { try { await this.#ensureReady(OperationIdSchema.parse(input.operationId)); return { status: "applied" as const, actualCostMicros: 0 }; } catch { return { status: "unknown" as const, actualCostMicros: 0 }; } }
  async observe(input: Readonly<{ operationId: string }>) { const operationId = OperationIdSchema.parse(input.operationId); if (!this.#operations.has(operationId)) return { status: "missing" as const, actualCostMicros: 0 }; try { return { status: (await this.#ensureReady(operationId)) ? "completed" as const : "pending" as const, actualCostMicros: 0 }; } catch { return { status: "unknown" as const, actualCostMicros: 0 }; } }
  async cleanup(input: Readonly<{ operationId: string; resourceIdentitySha256?: string }>) { const operation = this.#operations.get(OperationIdSchema.parse(input.operationId)); if (!operation?.machineId || operation.cleanup === "cleaned") return { status: "blocked" as const, actualCostMicros: 0 }; try { await this.#client.destroy(operation.machineId); operation.cleanup = "cleaned"; return { status: "cleaned" as const, actualCostMicros: 0 }; } catch { return { status: "pending" as const, actualCostMicros: 0 }; } }
  async executeSample(sample: Readonly<Pick<WorkerBenchmarkSample, "id" | "cohort">>) { const cohort = CohortSchema.parse(sample.cohort); const operationId = `benchmark-${sample.id}`; const existing = this.#operations.get(operationId); if (existing?.sample) return existing.sample; if (!existing) await this.plan({ operationId, effectId: "fly-benchmark", region: this.#config.region, desiredDigest: "0".repeat(64) }); const receiptMonotonicMs = this.#now(); await this.#ensureReady(operationId, cohort); const readyMonotonicMs = this.#now(); const cleanup = await this.cleanup({ operationId }); const result = Object.freeze({ id: sample.id, cohort, outcome: "accepted" as const, receiptMonotonicMs, readyMonotonicMs, readyLeaseCount: 1, durableBacklogCount: 0, isolation: "passed" as const, cleanup: cleanup.status === "cleaned" ? "passed" as const : "failed" as const }); this.#operations.get(operationId)!.sample = result; return result; }
}
export function createFlyLiveWorkerProvider(input: Readonly<{ config: unknown; client: NativeFlyMachinesClientPort; command: FlyReadinessCommandPort; now?: () => number }>): FlyLiveWorkerProvider { return new FlyLiveWorkerProviderImpl(input); }
