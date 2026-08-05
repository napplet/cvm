import { z } from "zod";
import { ImmutableObjectReferenceSchema, type ImmutableObjectReference, type ObjectStorePort } from "../continuity/object-store";

const Sha256Schema = z.string().regex(/^[a-f0-9]{64}$/iu);
export const DURABILITY_SUBJECT_KINDS = [
  "checkpoint", "sealed_artifact", "validation_evidence", "usage_receipt", "promotion_evidence", "owner_event", "attestation",
] as const;
export const DurabilitySubjectSchema = z.object({
  kind: z.enum(DURABILITY_SUBJECT_KINDS),
  sourceIdentity: z.string().min(1).max(256),
  object: ImmutableObjectReferenceSchema,
  payloadSha256: Sha256Schema,
  ownerId: z.string().min(1).max(256),
  retentionUntil: z.string().datetime(),
  deletionState: z.enum(["retained", "tombstoned", "deleted"]),
}).strict();

const RestoreExpectedFactsSchema = z.object({
  ownerId: z.string().min(1),
  sessionId: z.string().min(1),
  pendingActionReference: z.string().min(1),
  sessionVersion: z.number().int().nonnegative(),
  artifactVersion: z.number().int().nonnegative(),
  leaseToken: z.string().min(1),
  compatibility: z.object({
    policyVersion: z.string().min(1), modelIdentity: z.string().min(1), nappletSdkIdentity: z.string().min(1), toolchainIdentity: z.string().min(1),
  }).strict(),
}).strict();

const VerifiedRestoreMaterialSchema = RestoreExpectedFactsSchema.extend({ archive: z.instanceof(Uint8Array) }).strict();
const RestoreReattachResultSchema = z.object({ status: z.enum(["reattached", "replayed", "reconciliation_pending"]), workerId: z.string().min(1).optional() }).strict();
export const RestoreDrillResultSchema = z.object({
  status: z.enum(["restored", "replayed", "reconciliation_pending", "blocked"]),
  code: z.string().min(1), reattachments: z.number().int().nonnegative(), effects: z.literal(0),
}).strict();

export type RestoreDrillInput = Readonly<{
  objectStore: ObjectStorePort;
  subject: z.input<typeof DurabilitySubjectSchema>;
  expected: z.input<typeof RestoreExpectedFactsSchema>;
  nowMs: number;
  decryptAndVerify(bytes: Uint8Array): Promise<z.input<typeof VerifiedRestoreMaterialSchema>>;
  reattach(input: Readonly<{ sourceIdentity: string; object: ImmutableObjectReference; archive: Uint8Array; expected: z.infer<typeof RestoreExpectedFactsSchema> }>): Promise<z.input<typeof RestoreReattachResultSchema>>;
}>;

export const RestoreDrillInputSchema = z.object({
  subject: DurabilitySubjectSchema,
  expected: RestoreExpectedFactsSchema,
  nowMs: z.number().int().nonnegative(),
}).strict();

async function digest(bytes: Uint8Array): Promise<string> {
  const value = await crypto.subtle.digest("SHA-256", bytes as BufferSource);
  return Array.from(new Uint8Array(value), (byte) => byte.toString(16).padStart(2, "0")).join("");
}

function drillResult(status: z.infer<typeof RestoreDrillResultSchema>["status"], code: string, reattachments = 0) {
  return RestoreDrillResultSchema.parse({ status, code, reattachments, effects: 0 });
}

/**
 * Exact retained-object restore drill for a freshly composed coordinator.
 * The caller supplies only narrow decryption and reattachment seams; every
 * byte, ownership, compatibility, version, lease, and retention fact is
 * verified before it can receive reattachment authority.
 */
export async function runRestoreDrill(input: RestoreDrillInput): Promise<z.infer<typeof RestoreDrillResultSchema>> {
  const parsed = RestoreDrillInputSchema.safeParse({ subject: input.subject, expected: input.expected, nowMs: input.nowMs });
  if (!parsed.success) return drillResult("blocked", "RESTORE_INVALID_INPUT");
  const { subject, expected, nowMs } = parsed.data;
  if (subject.deletionState !== "retained" || nowMs >= Date.parse(subject.retentionUntil)) return drillResult("blocked", "RESTORE_EXPIRED_OR_DELETED");

  let bytes: Uint8Array | undefined;
  try { bytes = await input.objectStore.readExact(subject.object); } catch { return drillResult("blocked", "RESTORE_OBJECT_NOT_FOUND"); }
  if (!bytes) return drillResult("blocked", "RESTORE_OBJECT_NOT_FOUND");
  if (await digest(bytes) !== subject.object.checksum) return drillResult("blocked", "RESTORE_OBJECT_CHECKSUM_MISMATCH");

  let material: z.infer<typeof VerifiedRestoreMaterialSchema>;
  try { material = VerifiedRestoreMaterialSchema.parse(await input.decryptAndVerify(new Uint8Array(bytes))); } catch { return drillResult("blocked", "RESTORE_DECRYPT_OR_ARCHIVE_DENIED"); }
  if (await digest(material.archive) !== subject.payloadSha256) return drillResult("blocked", "RESTORE_DECRYPT_OR_ARCHIVE_DENIED");
  if (subject.ownerId !== expected.ownerId || material.ownerId !== expected.ownerId || material.sessionId !== expected.sessionId || material.pendingActionReference !== expected.pendingActionReference || material.sessionVersion !== expected.sessionVersion || material.artifactVersion !== expected.artifactVersion || material.leaseToken !== expected.leaseToken || JSON.stringify(material.compatibility) !== JSON.stringify(expected.compatibility)) {
    return drillResult("blocked", "RESTORE_FACTS_DENIED");
  }

  try {
    const result = RestoreReattachResultSchema.parse(await input.reattach({ sourceIdentity: subject.sourceIdentity, object: subject.object, archive: new Uint8Array(material.archive), expected }));
    if (result.status === "reattached") return drillResult("restored", "RESTORE_REATTACHED", 1);
    if (result.status === "replayed") return drillResult("replayed", "RESTORE_REPLAYED");
    return drillResult("reconciliation_pending", "RESTORE_RECONCILIATION_PENDING");
  } catch { return drillResult("blocked", "RESTORE_REATTACH_DENIED"); }
}

const TopologyClaimSchema = z.object({
  ingressRegions: z.array(z.string().min(1)).min(1), databaseRegions: z.array(z.string().min(1)).min(1), objectRegions: z.array(z.string().min(1)).min(1), workerRegions: z.array(z.string().min(1)).min(1), relayRegions: z.array(z.string().min(1)).min(1),
  activeStandby: z.enum(["active-active", "active-standby", "single-active"]), failureDomain: z.enum(["instance", "zone", "region"]), rtoMs: z.number().int().nonnegative(), rpoMs: z.number().int().nonnegative(), limitations: z.array(z.string().min(1)),
}).strict();
const TopologyObservationSchema = z.union([
  z.object({ status: z.literal("blocked"), reason: z.string().min(1) }).strict(),
  z.object({ status: z.literal("observed"), topology: TopologyClaimSchema }).strict(),
]);
export function validateTopologyClaim(input: Readonly<{ claimed: z.input<typeof TopologyClaimSchema>; observation: z.input<typeof TopologyObservationSchema> }>) {
  const claimed = TopologyClaimSchema.parse(input.claimed);
  const observation = TopologyObservationSchema.parse(input.observation);
  if (observation.status === "blocked") return Object.freeze({ status: "blocked" as const, code: "TOPOLOGY_NOT_OBSERVED", reason: observation.reason });
  const actual = observation.topology;
  if (JSON.stringify(claimed) !== JSON.stringify(actual)) return Object.freeze({ status: "blocked" as const, code: "TOPOLOGY_CLAIM_EXCEEDS_OBSERVATION", reason: "TOPOLOGY_MISMATCH" });
  return Object.freeze({ status: "observed" as const, code: "TOPOLOGY_OBSERVED" });
}

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
