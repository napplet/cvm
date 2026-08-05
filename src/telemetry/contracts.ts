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
  "generation",
  "ledger_settlement",
  "checkpoint",
  "resume",
  "validation",
  "preview",
  "publication",
  "reconciliation",
  "promotion",
]);
export const LifecycleOutcomeSchema = z.enum(["accepted", "capacity_unavailable", "reconciliation_pending", "succeeded", "failed", "blocked", "pending"]);

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

/**
 * Derives the only correlation value coordinator services may pass to
 * telemetry. Callers supply stable internal identities; this helper never
 * exposes those identities to the observer.
 */
export async function protectedLifecycleCorrelation(parts: readonly string[]): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(parts.join("\u0000")));
  return `sha256:${Array.from(new Uint8Array(digest), (byte) => byte.toString(16).padStart(2, "0")).join("")}`;
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

/**
 * Total observer seam for trusted coordinators. Exporter failures are
 * deliberately ignored: observation is never authority to retry, mutate, or
 * suppress a domain result.
 */
export async function emitLifecycleObservation(
  telemetry: LifecycleTelemetryPort | undefined,
  correlationParts: readonly string[],
  stage: z.infer<typeof LifecycleStageSchema>,
  outcome: z.infer<typeof LifecycleOutcomeSchema>,
  monotonicMs = Date.now(),
): Promise<void> {
  try {
    if (!telemetry) return;
    const correlationDigest = await protectedLifecycleCorrelation(correlationParts);
    await emitLifecycleObservationWithCorrelation(telemetry, correlationDigest, stage, outcome, monotonicMs);
  } catch {
    // Intentionally non-fatal: the durable coordinator decision is complete.
  }
}

/** Emits a pre-protected correlation issued by the authenticated transport boundary. */
export async function emitLifecycleObservationWithCorrelation(
  telemetry: LifecycleTelemetryPort | undefined,
  correlationDigest: string,
  stage: z.infer<typeof LifecycleStageSchema>,
  outcome: z.infer<typeof LifecycleOutcomeSchema> | undefined,
  monotonicMs: number,
): Promise<void> {
  try {
    if (!telemetry) return;
    await telemetry.observe(LifecycleObservationSchema.parse({
      version: "admission-lifecycle-v1", correlationDigest, stage, monotonicMs, ...(outcome ? { outcome } : {}),
    }));
  } catch {
    // Telemetry is deliberately not part of the domain decision.
  }
}
