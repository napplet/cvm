import { z } from "zod";

const ProtectedDigestSchema = z.string().regex(/^sha256:[a-f0-9]{64}$/u);
const MonotonicMsSchema = z.number().int().min(0).finite();

/** Finite, versioned facts which may cross the trusted-boundary observer seam. */
export const LifecycleStageSchema = z.enum([
  "correlated_receipt",
  "capacity_intent_created",
  "capacity_reserve_started",
  "exact_session_ready",
  "capacity_refused",
  "reconciliation_pending",
]);
export const LifecycleOutcomeSchema = z.enum(["accepted", "capacity_unavailable", "reconciliation_pending"]);

/**
 * Created only by the ContextVM adapter after strict envelope correlation.
 * It deliberately contains hashes and a monotonic clock only: raw events,
 * pubkeys, prompts, provider data, and transport timing do not enter it.
 */
export const AdmissionLifecycleContextSchema = z.object({
  version: z.literal("admission-lifecycle-v1"),
  receiptMonotonicMs: MonotonicMsSchema,
  correlationDigest: ProtectedDigestSchema,
}).strict();
export type AdmissionLifecycleContext = z.infer<typeof AdmissionLifecycleContextSchema>;

export const LifecycleObservationSchema = z.object({
  version: z.literal("admission-lifecycle-v1"),
  correlationDigest: ProtectedDigestSchema,
  stage: LifecycleStageSchema,
  outcome: LifecycleOutcomeSchema.optional(),
  monotonicMs: MonotonicMsSchema,
}).strict();
export type LifecycleObservation = z.infer<typeof LifecycleObservationSchema>;

/** Observational only. The port intentionally has no capability, store, or session handles. */
export interface LifecycleTelemetryPort {
  observe(observation: LifecycleObservation): Promise<void> | void;
}

export function lifecycleObservation(
  context: AdmissionLifecycleContext,
  stage: z.infer<typeof LifecycleStageSchema>,
  monotonicMs: number,
  outcome?: z.infer<typeof LifecycleOutcomeSchema>,
): LifecycleObservation {
  return LifecycleObservationSchema.parse({
    version: "admission-lifecycle-v1",
    correlationDigest: context.correlationDigest,
    stage,
    monotonicMs,
    ...(outcome ? { outcome } : {}),
  });
}
