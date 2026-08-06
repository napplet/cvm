import { z } from "zod";
import { WorkerBenchmarkProfileSchema, WorkerCandidateBenchmarkSchema, evaluateAdmissionSlo, runWorkerCandidateBenchmark, type WorkerBenchmarkSample } from "../../admission/benchmark";
import { ProtectedSuiteResultSchema, WorkerCandidateSchema, type ProtectedSuiteResult } from "../contracts";

type ScheduledSample = Readonly<Pick<WorkerBenchmarkSample, "id" | "cohort">>;

/** A Plan 07-25 owned port. This module neither creates a provider client nor
 * receives credentials, so local contract fixtures cannot mutate a provider. */
export type LiveAdmissionObservationPort = Readonly<{
  evidenceClass: "protected_live" | "deterministic";
  executeSample(sample: ScheduledSample): Promise<unknown>;
}>;

export type LiveAdmissionCertificationInput = Readonly<{
  candidate: unknown;
  profile?: unknown;
  observationPort?: LiveAdmissionObservationPort;
}>;

function nonPass(status: "blocked" | "failed", reasonCode: ProtectedSuiteResult["reasonCode"], limitation: string): ProtectedSuiteResult {
  return ProtectedSuiteResultSchema.parse({ status, claims: [], limitations: [limitation], reasonCode });
}

/**
 * Converts only individual exact-session observations into the existing locked
 * benchmark contract. Callers cannot submit a summary, select a provider, or
 * assert a passing status. Deterministic ports are rejected before the first
 * schedule item is dispatched.
 */
export async function runLiveAdmissionCertification(input: LiveAdmissionCertificationInput): Promise<ProtectedSuiteResult> {
  const candidate = WorkerCandidateSchema.safeParse(input.candidate);
  const profile = WorkerBenchmarkProfileSchema.safeParse(input.profile ?? {});
  const port = input.observationPort;
  if (!candidate.success || !profile.success || !port || port.evidenceClass !== "protected_live") {
    return nonPass("blocked", "INPUT_UNAVAILABLE", "protected-live-observation-required");
  }

  try {
    const benchmark = await runWorkerCandidateBenchmark({
      candidate: candidate.data,
      profile: profile.data,
      execute: async (sample) => port.executeSample(sample),
    });
    const parsed = WorkerCandidateBenchmarkSchema.parse(benchmark);
    const evaluation = evaluateAdmissionSlo(parsed);
    if (evaluation.status === "passed") {
      return ProtectedSuiteResultSchema.parse({
        status: "passed",
        claims: ["release.admission_slo", "release.worker"],
        limitations: ["selection-external"],
        reasonCode: "OBSERVATION_COMPLETE",
      });
    }
    if (evaluation.status === "blocked") return nonPass("blocked", "SAMPLE_INSUFFICIENT", "locked-sample-floor-unmet");
    const reasonCode = evaluation.reasonCode === "SLO_OR_SAFETY_FAILED" && evaluation.upperP95Ms !== null && evaluation.upperP95Ms > 5_000
      ? "SLO_NOT_MET" : "READINESS_FAILED";
    return nonPass("failed", reasonCode, "admission-observation-not-eligible");
  } catch {
    return nonPass("blocked", "PROVIDER_UNAVAILABLE", "provider-observation-unavailable");
  }
}
