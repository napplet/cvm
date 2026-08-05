import { z } from "zod";
import {
  CheckpointExportRequestSchema, CheckpointExportResultSchema, CheckpointFenceRequestSchema, CheckpointFenceResultSchema, CheckpointRestoreRequestSchema, CheckpointRestoreResultSchema, CheckpointTerminationRequestSchema, CheckpointTerminationResultSchema,
  WorkerRunRequestSchema, WorkerRunResultSchema, type CheckpointExportRequest, type CheckpointExportResult, type CheckpointFenceRequest, type CheckpointFenceResult, type CheckpointRestoreRequest, type CheckpointRestoreResult, type CheckpointTerminationRequest, type CheckpointTerminationResult, type ContinuationWorkerPort, type WorkerRunRequest, type WorkerRunResult,
} from "../phase-02/contracts";
import { PHASE_02_POLICY_INITIAL } from "../policy/phase-02-policy";

const image = /^[a-z0-9][a-z0-9._/-]*(?::[a-z0-9._-]+)?@sha256:[a-f0-9]{64}$/iu;
export const FlyWorkerConfigSchema = z.object({ appName: z.string().min(1).max(128), image: z.string().regex(image), region: z.string().min(1).max(64), workspaceRoot: z.string().regex(/^\/(?:[^/\0]+\/?)*$/u), policyVersion: z.literal(PHASE_02_POLICY_INITIAL.policyVersion) }).strict();
export type FlyWorkerConfig = z.infer<typeof FlyWorkerConfigSchema>;
/** Deliberately small injected REST boundary: no Fly response/error can reach the domain. */
export interface FlyMachinesClientPort { create(input: Readonly<{ appName: string; image: string; region: string; command: readonly string[]; blockNetwork: true }>): Promise<Readonly<{ id: string }>>; exec(id: string, argv: readonly string[], request: string): Promise<Readonly<{ stdout: string; exitCode: number }>>; destroy(id: string): Promise<void>; }
export type FlyProbeEvidence = Readonly<{ version: 1; provider: "fly"; status: "passed" | "failed" | "blocked"; selection: "eligible-not-selected" | "unselected"; reasonCode: "CREDENTIALS_UNAVAILABLE" | "PROBE_COMPLETE" | "PROBE_FAILED"; image?: string }>;
export async function blockedFlyProbeEvidence(): Promise<FlyProbeEvidence> { return Object.freeze({ version: 1, provider: "fly", status: "blocked", selection: "unselected", reasonCode: "CREDENTIALS_UNAVAILABLE" }); }

export class FlyWorkerAdapter implements ContinuationWorkerPort {
  readonly #config: FlyWorkerConfig; readonly #client: FlyMachinesClientPort;
  constructor(config: unknown, client: FlyMachinesClientPort) { this.#config = FlyWorkerConfigSchema.parse(config); this.#client = client; }
  async run(input: WorkerRunRequest, signal: AbortSignal): Promise<WorkerRunResult> {
    const request = WorkerRunRequestSchema.safeParse(input); if (!request.success || signal.aborted) return WorkerRunResultSchema.parse({ status: signal.aborted ? "interrupted" : "unavailable", code: signal.aborted ? "WORKER_INTERRUPTED" : "WORKER_UNAVAILABLE" });
    let id: string | undefined;
    try { id = (await this.#client.create({ appName: this.#config.appName, image: this.#config.image, region: this.#config.region, command: ["/usr/local/bin/napplet-cvm-worker", "run-proposal"], blockNetwork: true })).id; const output = await this.#client.exec(id, ["/usr/local/bin/napplet-cvm-worker", "run-proposal"], JSON.stringify(request.data)); if (output.exitCode !== 0) throw new Error("worker failed"); return WorkerRunResultSchema.parse(JSON.parse(output.stdout)); }
    catch { return WorkerRunResultSchema.parse({ status: "unavailable", code: "WORKER_UNAVAILABLE" }); }
    finally { if (id) try { await this.#client.destroy(id); } catch { /* fail closed: no native detail */ } }
  }
  async exportCheckpoint(input: CheckpointExportRequest): Promise<CheckpointExportResult> { CheckpointExportRequestSchema.parse(input); return CheckpointExportResultSchema.parse({ status: "denied", code: "WORKER_CONTINUATION_DENIED" }); }
  async fenceCheckpoint(input: CheckpointFenceRequest): Promise<CheckpointFenceResult> { CheckpointFenceRequestSchema.parse(input); return CheckpointFenceResultSchema.parse({ status: "denied", code: "WORKER_CONTINUATION_DENIED" }); }
  async restoreCheckpoint(input: CheckpointRestoreRequest): Promise<CheckpointRestoreResult> { CheckpointRestoreRequestSchema.parse(input); return CheckpointRestoreResultSchema.parse({ status: "denied", code: "WORKER_CONTINUATION_DENIED" }); }
  async terminateCheckpoint(input: CheckpointTerminationRequest): Promise<CheckpointTerminationResult> { CheckpointTerminationRequestSchema.parse(input); return CheckpointTerminationResultSchema.parse({ status: "denied", code: "WORKER_CONTINUATION_DENIED" }); }
}
export function createFlyWorkerAdapter(config: unknown, client: FlyMachinesClientPort): FlyWorkerAdapter { return new FlyWorkerAdapter(config, client); }
