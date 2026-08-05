import { z } from "zod";

const SampleIdentitySchema = z.string().min(1).max(160);
const MonotonicMsSchema = z.number().int().min(0).finite();
const OutcomeSchema = z.enum(["accepted", "capacity_unavailable", "reconciliation_pending"]);

/** Provider-neutral records, deliberately free of provider, region, or pool labels. */
export const AdmissionSampleSchema = z.object({
  candidateId: SampleIdentitySchema,
  inputId: SampleIdentitySchema,
  outcome: OutcomeSchema,
  receiptMonotonicMs: MonotonicMsSchema,
  readyMonotonicMs: MonotonicMsSchema.nullable(),
  readyLeaseCount: z.number().int().min(0).max(1),
  durableBacklogCount: z.number().int().min(0),
}).strict();
export type AdmissionSample = z.infer<typeof AdmissionSampleSchema>;

export const AdmissionBenchmarkReportSchema = z.object({
  outcome: z.enum(["passed", "failed", "insufficient_sample"]),
  count: z.number().int().min(0),
  p50Ms: z.number().int().min(0).nullable(),
  p95Ms: z.number().int().min(0).nullable(),
  p99Ms: z.number().int().min(0).nullable(),
  rejectionRate: z.number().min(0).max(1),
  acceptedWithoutReadyCount: z.number().int().min(0),
  durableBacklogCount: z.number().int().min(0),
  samples: z.array(AdmissionSampleSchema),
}).strict();
export type AdmissionBenchmarkReport = z.infer<typeof AdmissionBenchmarkReportSchema>;

type AttemptResult = Readonly<{
  outcome: z.infer<typeof OutcomeSchema>;
  readyLeaseCount: number;
  durableBacklogCount: number;
  candidateId?: string;
  inputId?: string;
}>;

/** Measures from caller-owned trusted receipt through its exact-ready outcome. */
export async function runAdmissionAttempt(input: Readonly<{
  now: () => number;
  attempt: () => Promise<AttemptResult>;
  candidateId?: string;
  inputId?: string;
}>): Promise<AdmissionSample> {
  const receiptMonotonicMs = input.now();
  const result = await input.attempt();
  const readyMonotonicMs = input.now();
  if (!Number.isSafeInteger(receiptMonotonicMs) || !Number.isSafeInteger(readyMonotonicMs) || readyMonotonicMs < receiptMonotonicMs) throw new Error("ADMISSION_MONOTONIC_CLOCK_INVALID");
  if (result.outcome === "accepted" && (result.readyLeaseCount !== 1 || result.durableBacklogCount !== 0)) throw new Error("ADMISSION_READY_LEASE_REQUIRED");
  return AdmissionSampleSchema.parse({
    candidateId: result.candidateId ?? input.candidateId ?? "unknown-candidate",
    inputId: result.inputId ?? input.inputId ?? "unknown-input",
    outcome: result.outcome,
    receiptMonotonicMs,
    readyMonotonicMs: result.outcome === "accepted" ? readyMonotonicMs : null,
    readyLeaseCount: result.readyLeaseCount,
    durableBacklogCount: result.durableBacklogCount,
  });
}

function percentile(sorted: readonly number[], fraction: number): number | null {
  if (sorted.length === 0) return null;
  return sorted[Math.min(sorted.length - 1, Math.max(0, Math.ceil(sorted.length * fraction) - 1))]!;
}

/** Fails closed for missing, partial, unready, or backlogged admission cohorts. */
export function summarizeAdmissionSamples(input: readonly unknown[], options: Readonly<{ minimumSamples: number }>): AdmissionBenchmarkReport {
  const samples = input.map((sample) => AdmissionSampleSchema.parse(sample));
  const count = samples.length;
  const accepted = samples.filter((sample) => sample.outcome === "accepted");
  const latencies = accepted
    .filter((sample) => sample.readyMonotonicMs !== null)
    .map((sample) => sample.readyMonotonicMs! - sample.receiptMonotonicMs)
    .sort((left, right) => left - right);
  const acceptedWithoutReadyCount = accepted.filter((sample) => sample.readyLeaseCount !== 1 || sample.readyMonotonicMs === null).length;
  const durableBacklogCount = samples.reduce((total, sample) => total + sample.durableBacklogCount, 0);
  const rejectionRate = count === 0 ? 0 : samples.filter((sample) => sample.outcome !== "accepted").length / count;
  const outcome = count < options.minimumSamples
    ? "insufficient_sample"
    : acceptedWithoutReadyCount > 0 || durableBacklogCount > 0 || accepted.some((sample) => sample.readyMonotonicMs! < sample.receiptMonotonicMs)
      ? "failed"
      : "passed";
  return AdmissionBenchmarkReportSchema.parse({
    outcome, count, p50Ms: percentile(latencies, 0.5), p95Ms: percentile(latencies, 0.95), p99Ms: percentile(latencies, 0.99),
    rejectionRate, acceptedWithoutReadyCount, durableBacklogCount, samples,
  });
}
