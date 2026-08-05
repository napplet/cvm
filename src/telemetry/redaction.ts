import { createHmac } from "node:crypto";
import { z } from "zod";
import { LifecycleObservationSchema } from "./contracts";

export const LIFECYCLE_STAGES = [
  "correlated_receipt", "capacity_intent_created", "capacity_reserve_started", "exact_session_ready", "capacity_refused",
  "reconciliation_pending",
  "generation", "ledger_settlement", "checkpoint", "resume", "validation", "preview", "publication", "reconciliation", "promotion",
] as const;
export const LIFECYCLE_OUTCOMES = ["accepted", "capacity_unavailable", "reconciliation_pending", "succeeded", "failed", "blocked", "pending"] as const;

const DigestSchema = z.string().regex(/^sha256:[a-f0-9]{64}$/u);
const StageSchema = z.enum(LIFECYCLE_STAGES);
const OutcomeSchema = z.enum(LIFECYCLE_OUTCOMES);
const RawObservationSchema = z.object({
  version: z.literal("cvm.lifecycle.v1"), correlationId: z.string().min(1).max(256), stage: StageSchema,
  outcome: OutcomeSchema.optional(), monotonicMs: z.number().int().min(0).finite(),
}).strict();
const RedactedObservationSchema = z.object({
  version: z.literal("cvm.lifecycle.v1"), correlationDigest: DigestSchema, stage: StageSchema,
  outcome: OutcomeSchema.optional(), monotonicMs: z.number().int().min(0).finite(),
}).strict();

export type RedactedLifecycleObservation = Readonly<z.infer<typeof RedactedObservationSchema>>;
export type TelemetryRedactionOptions = Readonly<{ key: Uint8Array }>;

function validKey(key: Uint8Array): boolean { return key.byteLength >= 16 && key.byteLength <= 128; }

/** Produces a non-reversible correlation token. The caller owns the key material. */
export function protectedCorrelationId(value: string, key: Uint8Array): string {
  if (!validKey(key)) throw new Error("TELEMETRY_CORRELATION_KEY_INVALID");
  return `sha256:${createHmac("sha256", key).update(value, "utf8").digest("hex")}`;
}

/**
 * Reduces an untrusted coordinator fact to the sole record accepted by exporters.
 * Invalid, unknown, free-text, and legacy-incompatible facts are dropped.
 */
export function redactLifecycleObservation(input: unknown, options: TelemetryRedactionOptions): RedactedLifecycleObservation | null {
  if (!validKey(options.key)) return null;
  const alreadyRedacted = RedactedObservationSchema.safeParse(input);
  if (alreadyRedacted.success) return Object.freeze(alreadyRedacted.data);
  const raw = RawObservationSchema.safeParse(input);
  if (raw.success) return Object.freeze(RedactedObservationSchema.parse({
    version: "cvm.lifecycle.v1", correlationDigest: protectedCorrelationId(raw.data.correlationId, options.key), stage: raw.data.stage,
    monotonicMs: raw.data.monotonicMs, ...(raw.data.outcome ? { outcome: raw.data.outcome } : {}),
  }));
  const legacy = LifecycleObservationSchema.safeParse(input);
  if (!legacy.success || !StageSchema.safeParse(legacy.data.stage).success || (legacy.data.outcome && !OutcomeSchema.safeParse(legacy.data.outcome).success)) return null;
  return Object.freeze(RedactedObservationSchema.parse({
    version: "cvm.lifecycle.v1", correlationDigest: legacy.data.correlationDigest, stage: legacy.data.stage,
    monotonicMs: legacy.data.monotonicMs, ...(legacy.data.outcome ? { outcome: legacy.data.outcome } : {}),
  }));
}

/** Metrics deliberately exclude the protected correlation. Optional outcomes are a separate finite series. */
export function lifecycleCardinalityUpperBound(): number {
  return LIFECYCLE_STAGES.length * (LIFECYCLE_OUTCOMES.length + 1);
}

export function lifecycleMetricAttributes(observation: RedactedLifecycleObservation): Readonly<Record<string, string>> {
  return Object.freeze({ "cvm.lifecycle.version": "v1", "cvm.lifecycle.stage": observation.stage, "cvm.lifecycle.outcome": observation.outcome ?? "none" });
}
