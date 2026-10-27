import { z } from "zod";
import { WorkerCandidateSchema, ProtectedSuiteResultSchema, type ProtectedSuiteResult } from "../contracts";
import { D122_FAULT_MATRIX, EffectOracleSchema, FaultExecutionSchema, runFaultScenario, validateTopologyClaim, type FaultSchedule } from "../../resilience/fault-harness";

const FaultDispatchSchema = z.object({
  operationId: z.string().min(1).max(256), sessionId: z.string().min(1).max(256),
  // Prepared and persisted before injection, independently of the post-fault
  // effect query. The query cannot serve as its own expected oracle.
  oracle: z.object({ activeWriters: z.literal(1), effects: EffectOracleSchema.refine(value => Object.values(value).every(count => count <= 1), "original effects must be at most once") }).strict(),
}).strict();
const FaultObservationSchema = FaultExecutionSchema;

/** Provider controls are injected by the authorization-gated runner. This
 * adapter never creates credentials, a topology, or an evidence writer. */
export type LiveChaosFaultPort = Readonly<{
  evidenceClass: "protected_live" | "deterministic";
  executeFault(schedule: FaultSchedule): Promise<unknown>;
  observeOriginal(identity: Readonly<{ operationId: string; sessionId: string }>): Promise<unknown>;
  observeTopology(): Promise<unknown>;
}>;

export type LiveChaosCertificationInput = Readonly<{
  candidate: unknown;
  topology: unknown;
  faultPort?: LiveChaosFaultPort;
}>;

function nonPass(status: "blocked" | "failed", reasonCode: ProtectedSuiteResult["reasonCode"], limitation: string): ProtectedSuiteResult {
  return ProtectedSuiteResultSchema.parse({ status, claims: [], limitations: [limitation], reasonCode });
}

/**
 * Runs every D-122 schedule only through a protected provider-control port and
 * compares an independently prepared oracle with an original-identity observation. A local
 * fixture is refused before any fault dispatch, so it cannot claim chaos
 * success, replace an operation, or write protected evidence.
 */
export async function runLiveChaosCertification(input: LiveChaosCertificationInput): Promise<ProtectedSuiteResult> {
  const candidate = WorkerCandidateSchema.safeParse(input.candidate);
  const port = input.faultPort;
  if (!candidate.success || !port || port.evidenceClass !== "protected_live") {
    return nonPass("blocked", "INPUT_UNAVAILABLE", "protected-live-fault-control-required");
  }

  try {
    for (const schedule of D122_FAULT_MATRIX) {
      const dispatched = FaultDispatchSchema.parse(await port.executeFault(schedule));
      if (dispatched.operationId !== schedule.input.operationId || dispatched.sessionId !== schedule.initialState.sessionId) {
        return nonPass("failed", "EVIDENCE_INVALID", "original-operation-mismatch");
      }
      const observed = FaultObservationSchema.parse(await port.observeOriginal({ operationId: dispatched.operationId, sessionId: dispatched.sessionId }));
      if (observed.operationId !== dispatched.operationId || observed.sessionId !== dispatched.sessionId) {
        return nonPass("failed", "EVIDENCE_INVALID", "authoritative-observation-mismatch");
      }
      if (!schedule.outcomes.some(value => value.boundary === schedule.boundary && value.outcome === observed.observed)) return nonPass("failed", "EVIDENCE_INVALID", "injected-fault-not-observed");
      try { await runFaultScenario(schedule, async () => observed, dispatched.oracle); }
      catch { return nonPass("failed", "EVIDENCE_INVALID", "fault-oracle-mismatch"); }
    }
    const topology = validateTopologyClaim({ claimed: input.topology as never, observation: await port.observeTopology() as never });
    if (topology.status !== "observed") return nonPass("blocked", "TOPOLOGY_UNAVAILABLE", "topology-observation-required");
    return ProtectedSuiteResultSchema.parse({
      status: "passed", claims: ["release.database_failover", "release.control_plane"], limitations: ["selection-external"], reasonCode: "OBSERVATION_COMPLETE",
    });
  } catch {
    return nonPass("blocked", "PROVIDER_UNAVAILABLE", "fault-oracle-unavailable");
  }
}
