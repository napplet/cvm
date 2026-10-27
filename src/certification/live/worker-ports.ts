import { z } from "zod";
import { canonicalJson } from "../../promotion/schema";
import { WorkerBenchmarkProfileSchema, evaluateAdmissionSlo, runWorkerCandidateBenchmark, type WorkerBenchmarkSample } from "../../admission/benchmark";
import { WorkerCandidateSchema } from "../contracts";
import type { LiveAdmissionObservationPort } from "./admission";

const DigestSchema = z.string().regex(/^[a-f0-9]{64}$/iu).transform((value) => value.toLowerCase());
const ExactProfile = WorkerBenchmarkProfileSchema.parse({
  acceptedFloor: 1_000,
  forcedPoolHitFloor: 200,
  forcedPoolMissColdContentionFloor: 200,
  bootstrapReplicates: 200,
});
const CandidateInputSchema = z.object({
  candidate: WorkerCandidateSchema,
  topologySha256: DigestSchema,
  observationPort: z.custom<LiveAdmissionObservationPort>(),
}).strict();

export const IDENTICAL_WORKER_COHORT_PROFILE = ExactProfile;
export type WorkerSelection = Readonly<{
  status: "selected" | "unselected";
  provider: "modal" | "fly" | null;
  topologySha256: string | null;
  selectionEvidenceSha256: string | null;
  reasonCode: "SELECTED_FROM_FRESH_EVIDENCE" | "PROTECTED_EVIDENCE_REQUIRED" | "EVIDENCE_STALE" | "SCHEDULE_MISMATCH" | "SLO_OR_SAFETY_FAILED" | "CANDIDATE_INPUT_INVALID";
}>;

async function digest(value: unknown): Promise<string> {
  const bytes = new TextEncoder().encode(canonicalJson(value));
  const hash = await crypto.subtle.digest("SHA-256", bytes);
  return Array.from(new Uint8Array(hash), (byte) => byte.toString(16).padStart(2, "0")).join("");
}

function unselected(reasonCode: Exclude<WorkerSelection["reasonCode"], "SELECTED_FROM_FRESH_EVIDENCE">): WorkerSelection {
  return Object.freeze({ status: "unselected", provider: null, topologySha256: null, selectionEvidenceSha256: null, reasonCode });
}

function sameSchedule(left: readonly WorkerBenchmarkSample[], right: readonly WorkerBenchmarkSample[]): boolean {
  return left.length === right.length && left.every((sample, index) => sample.id === right[index]?.id && sample.cohort === right[index]?.cohort);
}

/**
 * Executes the exact D-116 schedule through both protected observation ports.
 * It accepts no profile override: 1,000 accepted samples plus the two forced
 * 200-sample floors are part of the certification contract, not tuning knobs.
 */
export async function executeIdenticalWorkerCohorts(input: Readonly<{
  candidates: readonly unknown[];
  observedAtMs: number;
  expiresAtMs: number;
  now?: () => number;
}>): Promise<WorkerSelection> {
  const candidates = z.array(CandidateInputSchema).length(2).safeParse(input.candidates);
  const time = z.object({ observedAtMs: z.number().int().nonnegative(), expiresAtMs: z.number().int().positive() }).safeParse(input);
  if (!candidates.success || !time.success || new Set(candidates.data.map((value) => value.candidate.provider)).size !== 2) return unselected("CANDIDATE_INPUT_INVALID");
  if (candidates.data.some((value) => value.observationPort.evidenceClass !== "protected_live")) return unselected("PROTECTED_EVIDENCE_REQUIRED");
  const clock = input.now ?? Date.now;
  let lastNow = time.data.observedAtMs;
  let stale = false;
  const isFresh = () => {
    const now = clock();
    stale ||= !Number.isSafeInteger(now) || now < lastNow || now >= time.data.expiresAtMs || time.data.observedAtMs >= time.data.expiresAtMs;
    lastNow = now;
    return !stale;
  };
  if (!isFresh()) return unselected("EVIDENCE_STALE");

  try {
    const benchmarks = await Promise.all(candidates.data.map(async (entry) => ({
      entry,
      benchmark: await runWorkerCandidateBenchmark({ candidate: entry.candidate, profile: ExactProfile, execute: (sample) => {
        if (!isFresh()) throw new Error("WORKER_COHORT_EVIDENCE_EXPIRED");
        return entry.observationPort.executeSample(sample);
      } }),
    })));
    if (!isFresh()) return unselected("EVIDENCE_STALE");
    if (!sameSchedule(benchmarks[0]!.benchmark.samples, benchmarks[1]!.benchmark.samples)) return unselected("SCHEDULE_MISMATCH");
    const evaluated = benchmarks.map((value) => ({ ...value, evaluation: evaluateAdmissionSlo(value.benchmark) }));
    if (evaluated.some((value) => value.evaluation.status !== "passed" || value.evaluation.upperP95Ms === null)) return unselected("SLO_OR_SAFETY_FAILED");
    const winner = [...evaluated].sort((left, right) => left.evaluation.upperP95Ms! - right.evaluation.upperP95Ms! || left.entry.candidate.provider.localeCompare(right.entry.candidate.provider))[0]!;
    const selectionEvidenceSha256 = await digest({
      version: 1,
      profile: ExactProfile,
      observedAtMs: time.data.observedAtMs,
      expiresAtMs: time.data.expiresAtMs,
      candidates: evaluated.map(({ entry, evaluation }) => ({ candidateId: entry.candidate.id, provider: entry.candidate.provider, topologySha256: entry.topologySha256, count: evaluation.count, upperP95Ms: evaluation.upperP95Ms, rejectionRate: evaluation.rejectionRate, reasonCode: evaluation.reasonCode })),
      selected: { candidateId: winner.entry.candidate.id, provider: winner.entry.candidate.provider, topologySha256: winner.entry.topologySha256 },
    });
    if (!isFresh()) return unselected("EVIDENCE_STALE");
    return Object.freeze({ status: "selected", provider: winner.entry.candidate.provider, topologySha256: winner.entry.topologySha256, selectionEvidenceSha256, reasonCode: "SELECTED_FROM_FRESH_EVIDENCE" });
  } catch {
    return unselected(stale ? "EVIDENCE_STALE" : "SLO_OR_SAFETY_FAILED");
  }
}
