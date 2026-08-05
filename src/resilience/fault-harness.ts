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
  certification: z.enum(["deterministic_contract", "protected_live"]).default("deterministic_contract"),
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

const empty = { credit: 0, debit: 0, worker: 0, session: 0, artifact: 0, checkpoint: 0, deploy: 0, ownerEvent: 0, attestation: 0 };

/**
 * Complete D-122 inventory.  These descriptors are executable schedules, not
 * a retry engine: protected-live rows retain their certification disposition.
 */
export const D122_FAULT_MATRIX: readonly FaultSchedule[] = Object.freeze([
  ["duplicate-relay", "duplicate_relay", "relay_delivery", "duplicate"],
  ["out-of-order-relay", "out_of_order_relay", "relay_delivery", "out_of_order"],
  ["regional-ingress-loss", "regional_ingress_loss", "relay_delivery", "unavailable", "protected_live"],
  ["sql-serialization", "sql_serialization", "sql_transaction", "serialization_failure"],
  ["sql-unavailable", "sql_unavailable", "sql_transaction", "unavailable", "protected_live"],
  ["capacity-ambiguity", "capacity_ambiguity", "capacity_reservation", "lost_response"],
  ["worker-loss", "worker_loss", "worker_execution", "worker_lost"],
  ["object-interruption", "object_interruption", "checkpoint_write", "interrupted"],
  ["model-receipt-ambiguity", "model_receipt_ambiguity", "model_lookup", "unresolved", "protected_live"],
  ["payment-notification", "payment_notification", "payment_settlement", "duplicate"],
  ["restore-expiry-race", "restore_expiry_race", "checkpoint_restore", "expired"],
  ["preview-source-invalidation", "preview_source_invalidation", "preview_read", "invalidated"],
  ["partial-publication", "partial_publication", "publication_attestation", "partial", "protected_live"],
].map(([id, faultClass, boundary, outcome, certification = "deterministic_contract"]) => FaultScheduleSchema.parse({
  id,
  faultClass,
  boundary,
  certification,
  input: { operationId: `operation:${id}` },
  initialState: { sessionId: `session:${id}` },
  outcomes: [{ boundary, outcome }],
}))) as readonly FaultSchedule[];

/** Exported so callers can use the canonical zero-effect oracle for non-effect seams. */
export const NO_EFFECTS_ORACLE: EffectOracle = Object.freeze(empty);
