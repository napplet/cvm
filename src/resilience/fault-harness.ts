import { z } from "zod";

/** Closed fault families from D-122. Schedules carry facts, never mutation handles. */
export const FaultClassSchema = z.enum([
  "duplicate_relay", "out_of_order_relay", "regional_ingress_loss", "sql_serialization", "sql_unavailable",
  "capacity_ambiguity", "worker_loss", "object_interruption", "model_receipt_ambiguity", "payment_notification",
  "restore_expiry_race", "preview_source_invalidation", "partial_publication",
]);

/** Existing persistence and external-port seams at which a deterministic outcome may be injected. */
export const FaultBoundarySchema = z.enum([
  "relay_delivery", "payment_settlement", "sql_transaction", "capacity_reservation", "worker_execution",
  "checkpoint_write", "checkpoint_restore", "model_dispatch", "model_lookup", "preview_read",
  "publication_deploy", "publication_owner_event", "publication_attestation",
]);

const FaultOutcomeSchema = z.enum([
  "accepted", "duplicate", "out_of_order", "unavailable", "serialization_failure", "lost_response",
  "worker_lost", "interrupted", "pending", "receipt_found", "definitive_not_accepted", "unresolved",
  "invalidated", "partial", "expired",
]);

export const EffectOracleSchema = z.object({
  credit: z.number().int().nonnegative(),
  debit: z.number().int().nonnegative(),
  worker: z.number().int().nonnegative(),
  session: z.number().int().nonnegative(),
  artifact: z.number().int().nonnegative(),
  checkpoint: z.number().int().nonnegative(),
  deploy: z.number().int().nonnegative(),
  ownerEvent: z.number().int().nonnegative(),
  attestation: z.number().int().nonnegative(),
}).strict();

export const FaultScheduleSchema = z.object({
  id: z.string().min(1).max(128),
  faultClass: FaultClassSchema,
  boundary: FaultBoundarySchema,
  input: z.record(z.string(), z.string().min(1).max(256)).readonly(),
  initialState: z.record(z.string(), z.string().min(1).max(256)).readonly(),
  outcomes: z.array(z.object({ boundary: FaultBoundarySchema, outcome: FaultOutcomeSchema }).strict()).min(1).max(32).readonly(),
}).strict();

const FaultExecutionSchema = z.object({
  operationId: z.string().min(1).max(256),
  sessionId: z.string().min(1).max(256),
  observed: FaultOutcomeSchema,
  activeWriters: z.number().int().nonnegative(),
  effects: EffectOracleSchema,
}).strict();

export type FaultSchedule = z.infer<typeof FaultScheduleSchema>;
export type EffectOracle = z.infer<typeof EffectOracleSchema>;
export type FaultExecution = z.infer<typeof FaultExecutionSchema>;

/**
 * Runs a schedule against an injected port-boundary adapter and checks only its
 * returned durable/effect projection.  The runner deliberately exposes no
 * store, transaction, provider, or effect capability to the schedule.
 */
export async function runFaultScenario(
  candidate: unknown,
  execute: (schedule: FaultSchedule) => Promise<FaultExecution> | FaultExecution,
  oracle: Readonly<{ activeWriters: number; effects: EffectOracle }>,
): Promise<FaultExecution> {
  const schedule = FaultScheduleSchema.parse(candidate);
  const result = FaultExecutionSchema.parse(await execute(Object.freeze(structuredClone(schedule))));
  const expected = EffectOracleSchema.parse(oracle.effects);
  if (oracle.activeWriters !== 1 || result.activeWriters !== oracle.activeWriters) throw new Error("FAULT_ORACLE_ACTIVE_WRITER_MISMATCH");
  if (JSON.stringify(result.effects) !== JSON.stringify(expected)) throw new Error("FAULT_ORACLE_EFFECT_MISMATCH");
  return Object.freeze(structuredClone(result));
}
