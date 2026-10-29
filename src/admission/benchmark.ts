import { z } from "zod";
import { createHash } from "node:crypto";
import { WorkerCandidateSchema, type WorkerCandidate } from "../certification/contracts";

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

const CohortSchema = z.enum(["pool_hit", "pool_miss", "cold", "step_load", "contention", "reclaim", "ambiguity", "cleanup", "failure"]);
const BenchmarkStatusSchema = z.enum(["accepted", "capacity_unavailable", "ambiguous"]);
/** The immutable profile is supplied as a digest-bound evidence input, not as production metric labels. */
export const WorkerBenchmarkProfileSchema = z.object({
  acceptedFloor: z.number().int().min(1).max(100_000).default(1_000),
  forcedPoolHitFloor: z.number().int().min(1).max(100_000).default(200),
  forcedPoolMissColdContentionFloor: z.number().int().min(1).max(100_000).default(200),
  bootstrapReplicates: z.number().int().min(20).max(1_000).default(200),
}).strict();
export type WorkerBenchmarkProfile = z.infer<typeof WorkerBenchmarkProfileSchema>;
export const WorkerBenchmarkSampleSchema = z.object({
  id: z.string().regex(/^[a-z0-9._-]{1,128}$/u), cohort: CohortSchema, outcome: BenchmarkStatusSchema,
  receiptMonotonicMs: MonotonicMsSchema, readyMonotonicMs: MonotonicMsSchema.nullable(), readyLeaseCount: z.number().int().min(0).max(1), durableBacklogCount: z.number().int().min(0),
  isolation: z.enum(["passed", "failed", "not_observed"]), cleanup: z.enum(["passed", "failed", "not_observed"]),
}).strict();
export type WorkerBenchmarkSample = z.infer<typeof WorkerBenchmarkSampleSchema>;

export const WorkerCandidateBenchmarkSchema = z.object({ candidate: WorkerCandidateSchema, profile: WorkerBenchmarkProfileSchema, samples: z.array(WorkerBenchmarkSampleSchema).min(1) }).strict();
export type WorkerCandidateBenchmark = z.infer<typeof WorkerCandidateBenchmarkSchema>;

/** Canonical locked ordering shared by the verifier and provider transports.
 * The two forced 200-attempt cohorts are included within the 1,000 attempts. */
export function createWorkerBenchmarkSchedule(profile: WorkerBenchmarkProfile): WorkerBenchmarkSample[] {
  const count = Math.max(profile.acceptedFloor, profile.forcedPoolHitFloor + profile.forcedPoolMissColdContentionFloor + 9);
  return Array.from({ length: count }, (_, index) => ({
    id: `benchmark-${index + 1}`, cohort: index < profile.forcedPoolHitFloor ? "pool_hit" : index < profile.forcedPoolHitFloor + profile.forcedPoolMissColdContentionFloor ? (["pool_miss", "cold", "contention"] as const)[index % 3]! : (["pool_hit", "pool_miss", "cold", "step_load", "contention", "reclaim", "ambiguity", "cleanup", "failure"] as const)[index % 9]!,
    outcome: "accepted" as const, receiptMonotonicMs: 0, readyMonotonicMs: 0, readyLeaseCount: 0, durableBacklogCount: 0, isolation: "not_observed" as const, cleanup: "not_observed" as const,
  }));
}

/** Runs exactly the same immutable schedule through either provider variant. */
export async function runWorkerCandidateBenchmark(input: Readonly<{ candidate: unknown; profile?: unknown; execute: (sample: Readonly<Pick<WorkerBenchmarkSample, "id" | "cohort">>) => Promise<unknown> }>): Promise<WorkerCandidateBenchmark> {
  const candidate = WorkerCandidateSchema.parse(input.candidate); const profile = WorkerBenchmarkProfileSchema.parse(input.profile ?? {});
  const samples: WorkerBenchmarkSample[] = [];
  for (const planned of createWorkerBenchmarkSchedule(profile)) {
    const observed = z.record(z.string(), z.unknown()).parse(await input.execute({ id: planned.id, cohort: planned.cohort }));
    const result = WorkerBenchmarkSampleSchema.parse({ id: planned.id, cohort: planned.cohort, ...observed });
    if (result.id !== planned.id || result.cohort !== planned.cohort) throw new Error("WORKER_BENCHMARK_SCHEDULE_MUTATED");
    samples.push(result);
  }
  return WorkerCandidateBenchmarkSchema.parse({ candidate, profile, samples });
}

function quantile(values: readonly number[], fraction: number): number | null { return values.length === 0 ? null : values[Math.min(values.length - 1, Math.ceil(values.length * fraction) - 1)]!; }
/** Seeded percentile bootstrap: independent uniform draws with replacement.
 * Counter-hashed blocks give reproducible draws without the correlations of
 * the former affine index schedule. Rejection sampling avoids modulo bias.
 * The 95th percentile of bootstrap p95s is the one-sided 95% upper estimate.
 * Like an ordinary percentile bootstrap, this assumes independent samples;
 * protected acquisition must separately check its cohort/dependence contract. */
function bootstrapUpperP95(latencies: readonly number[], replicates: number): number | null {
  if (latencies.length === 0) return null;
  const values: number[] = [];
  let block = 0; let cursor = 32; let bytes: Buffer = Buffer.alloc(0);
  const limit = Math.floor(0x1_0000_0000 / latencies.length) * latencies.length;
  const draw = () => {
    for (;;) {
      if (cursor === 32) {
        bytes = createHash("sha256").update(`napplet-cvm:admission-bootstrap:v1:${block++}`).digest();
        cursor = 0;
      }
      const value = bytes.readUInt32LE(cursor); cursor += 4;
      if (value < limit) return value % latencies.length;
    }
  };
  for (let replicate = 0; replicate < replicates; replicate += 1) {
    const sample = Array.from({ length: latencies.length }, () => latencies[draw()]!);
    values.push(quantile(sample.sort((a, b) => a - b), 0.95)!);
  }
  return quantile(values.sort((a, b) => a - b), 0.95);
}

/** Returns evidence facts only; selection is deliberately impossible in deterministic code. */
export function evaluateAdmissionSlo(input: unknown): Readonly<{ status: "passed" | "failed" | "blocked"; selection: "unselected"; provider: WorkerCandidate["provider"]; p50Ms: number | null; p95Ms: number | null; p99Ms: number | null; upperP95Ms: number | null; count: number; rejectionRate: number; reasonCode: string }> {
  const benchmark = WorkerCandidateBenchmarkSchema.parse(input); const accepted = benchmark.samples.filter((sample) => sample.outcome === "accepted");
  const latencies = accepted.filter((sample) => sample.readyMonotonicMs !== null).map((sample) => sample.readyMonotonicMs! - sample.receiptMonotonicMs).sort((a, b) => a - b);
  const upperP95Ms = bootstrapUpperP95(latencies, benchmark.profile.bootstrapReplicates);
  const poolHit = accepted.filter((sample) => sample.cohort === "pool_hit").length;
  const poolMissColdContention = accepted.filter((sample) => ["pool_miss", "cold", "contention"].includes(sample.cohort)).length;
  const unsafe = benchmark.samples.some((sample) => sample.durableBacklogCount !== 0 || (sample.outcome === "accepted" && (sample.readyLeaseCount !== 1 || sample.readyMonotonicMs === null || sample.isolation !== "passed" || sample.cleanup !== "passed")));
  const hasEveryCohort = CohortSchema.options.every((cohort) => benchmark.samples.some((sample) => sample.cohort === cohort));
  const sufficient = hasEveryCohort && accepted.length >= benchmark.profile.acceptedFloor && poolHit >= benchmark.profile.forcedPoolHitFloor && poolMissColdContention >= benchmark.profile.forcedPoolMissColdContentionFloor;
  const status = !sufficient ? "blocked" : unsafe || upperP95Ms === null || upperP95Ms > 5_000 ? "failed" : "passed";
  return Object.freeze({ status, selection: "unselected" as const, provider: benchmark.candidate.provider, p50Ms: quantile(latencies, 0.5), p95Ms: quantile(latencies, 0.95), p99Ms: quantile(latencies, 0.99), upperP95Ms, count: accepted.length, rejectionRate: benchmark.samples.length === 0 ? 0 : 1 - accepted.length / benchmark.samples.length, reasonCode: status === "passed" ? "SLO_OBSERVED_UNSELECTED" : !sufficient ? "SAMPLE_INSUFFICIENT" : "SLO_OR_SAFETY_FAILED" });
}

/** Guards against a vendor-specific worker/lease/evidence authority entering the shared domain. */
export function detectWorkerAuthorityDelta(input: Readonly<{ workerPort: string; continuationPort: string; evidenceIdentity: string }>): Readonly<{ status: "no_change" | "blocking_failure"; reasonCode: "PROVIDER_VARIANTS_ONLY" | "VENDOR_AUTHORITY_INTRODUCED" }> {
  const unchanged = input.workerPort === "WorkerPort" && input.continuationPort === "ContinuationWorkerPort" && input.evidenceIdentity === "CertificationObservation";
  return Object.freeze(unchanged ? { status: "no_change" as const, reasonCode: "PROVIDER_VARIANTS_ONLY" as const } : { status: "blocking_failure" as const, reasonCode: "VENDOR_AUTHORITY_INTRODUCED" as const });
}
