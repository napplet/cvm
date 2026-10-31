import { z } from "zod";
import { WorkerBenchmarkSampleSchema, createWorkerBenchmarkSchedule } from "../../admission/benchmark";
import { IDENTICAL_WORKER_COHORT_PROFILE } from "../../certification/live/worker-ports";
import { LifecycleObservationSchema } from "../../telemetry/contracts";
import { D122_FAULT_MATRIX, DurabilitySubjectSchema, RestoreDrillInputSchema } from "../../resilience/fault-harness";
import { canonicalJson } from "../../promotion/schema";

export const CORE_RESTORE_CHUNK_BYTES = 131_072;
export const CORE_RESTORE_MAX_BYTES = 536_870_912;
const Digest = z.string().regex(/^[a-f0-9]{64}$/u);
const Identity = z.string().min(1).max(256);
const Subject = z.object({ freshInstanceId: Identity, subject: DurabilitySubjectSchema }).strict();
const schedule = new Map(createWorkerBenchmarkSchedule(IDENTICAL_WORKER_COHORT_PROFILE).map(sample => [sample.id, sample.cohort]));
export const CoreScheduledSampleSchema = WorkerBenchmarkSampleSchema.pick({ id: true, cohort: true }).refine(sample => schedule.get(sample.id) === sample.cohort, "exact locked schedule required");
export const CoreControlPayloadSchemas = Object.freeze({
  "cohort.prepare": z.object({ candidateId: Digest, provider: z.enum(["modal", "fly"]), sample: CoreScheduledSampleSchema }).strict(),
  "cohort.observe": z.object({ candidateId: Digest, provider: z.enum(["modal", "fly"]), sample: CoreScheduledSampleSchema }).strict(),
  "telemetry.emit": z.object({ observation: LifecycleObservationSchema }).strict(),
  "telemetry.window": z.object({ binding: z.object({ candidateId: Digest, topologySha256: Digest, datasetSha256: Digest, profileSha256: Digest, collectorDigest: z.string().regex(/^sha256:[a-f0-9]{64}$/u), configSha256: Digest }).strict() }).strict(),
  "fault.inject": z.object({ schedule: z.unknown().refine(value => D122_FAULT_MATRIX.some(item => canonicalJson(item) === canonicalJson(value)), "locked fault schedule required") }).strict(),
  "fault.observe": z.object({ operationId: Identity, sessionId: Identity }).strict(),
  /** Receipt-bound preparation is a named control effect. Inventory remains a
   * read-only query and cannot create a retained archive. */
  "restore.prepare": z.object({}).strict(),
  "restore.inventory": z.object({}).strict(),
  "restore.lose-local": z.object({}).strict(),
  "restore.create": z.object({}).strict(),
  "restore.subject": z.discriminatedUnion("action", [
    Subject.extend({ action: z.literal("describe") }),
    Subject.extend({ action: z.enum(["read-ciphertext", "read-plaintext"]), offset: z.number().int().nonnegative().max(CORE_RESTORE_MAX_BYTES).refine(value => value % CORE_RESTORE_CHUNK_BYTES === 0) }),
    Subject.extend({ action: z.literal("decrypt"), ciphertextSha256: Digest }),
    Subject.extend({ action: z.literal("reattach"), archiveSha256: Digest, expected: RestoreDrillInputSchema.shape.expected }),
  ]),
  "restore.expiry": z.object({ freshInstanceId: Identity }).strict(),
  "restore.topology": z.object({ freshInstanceId: Identity.optional() }).strict(),
  "restore.cleanup": z.object({ freshInstanceId: Identity }).strict(),
});
/** Described facts come from restored SQL, never from the requesting client. */
export const CoreRestoreDescriptorSchema = z.object({ freshInstanceId: Identity, subject: DurabilitySubjectSchema, expected: RestoreDrillInputSchema.shape.expected }).strict();
export const CoreRestoreChunkSchema = z.object({ freshInstanceId: Identity, sourceIdentity: Identity, offset: z.number().int().nonnegative(), totalBytes: z.number().int().positive().max(CORE_RESTORE_MAX_BYTES), bytesBase64: z.string().min(1).max(Math.ceil(CORE_RESTORE_CHUNK_BYTES / 3) * 4).regex(/^[A-Za-z0-9+/]+={0,2}$/u) }).strict();
export const CoreFreshInstanceSchema = z.object({ freshInstanceId: Identity, sourceInstanceId: Identity, databaseInstanceId: Identity, applicationInstanceId: Identity, restoredBackupSha256: Digest }).strict().refine(value => value.freshInstanceId !== value.sourceInstanceId && value.databaseInstanceId !== value.sourceInstanceId && value.applicationInstanceId !== value.sourceInstanceId, "fresh instance required");

export type CoreServiceControlKind = keyof typeof CoreControlPayloadSchemas;

/** Fixed, project-owned constructor provenance for the four core suites.
 * This is an implementation identity, not caller-provided evidence and is
 * deliberately independent of the retired cloud control transport. */
export const CORE_NATIVE_BACKEND_PROVENANCE = Object.freeze({
  admission: Object.freeze({ module: "src/production/certification-services.ts", export: "ProductionCertificationCoreServices", purpose: "receipt_bound_admission_observation" }),
  telemetry: Object.freeze({ module: "src/production/certification-services.ts", export: "ProductionNativeCoreCertificationServices", purpose: "authenticated_native_telemetry_hold" }),
  chaos: Object.freeze({ module: "src/production/chaos-certification.ts", export: "ProductionChaosCertificationService", purpose: "original_operation_fault_observation" }),
  restore: Object.freeze({ module: "src/production/restore-certification.ts", export: "ProductionRestoreCertification", purpose: "fresh_postgres_object_key_restore" }),
});
export type CoreNativeBackendSuite = keyof typeof CORE_NATIVE_BACKEND_PROVENANCE;
/** Named bounded live operations, never a generic callback supplied by HTTP. */
export type ProductionCertificationServices = Readonly<{
  prepareCohort(input: Readonly<{ operationId: string; candidateId: string; provider: "modal" | "fly"; sample: Readonly<{ id: string; cohort: string }> }>): Promise<unknown>;
  observeCohort(input: Readonly<{ operationId: string; candidateId: string; provider: "modal" | "fly"; sample: Readonly<{ id: string; cohort: string }> }>): Promise<unknown>;
  emitTelemetry(input: Readonly<{ operationId: string; observation: unknown }>): Promise<unknown>;
  telemetryWindow(input: Readonly<{ operationId: string; binding: unknown }>): Promise<unknown>;
  injectFault(input: Readonly<{ operationId: string; schedule: unknown }>): Promise<unknown>;
  observeFault(input: Readonly<{ operationId: string; sessionId: string }>): Promise<unknown>;
  restore(input: Readonly<{ operationId: string; action: Exclude<CoreServiceControlKind, "cohort.prepare" | "cohort.observe" | "telemetry.emit" | "telemetry.window" | "fault.inject" | "fault.observe">; payload: unknown }>): Promise<unknown>;
  /** Query only; it observes the original provider operation and never
   * redispatches work after an uncertain control request. */
  reconcile(input: Readonly<{ operationId: string; kind: CoreServiceControlKind; payload: unknown }>): Promise<unknown>;
}>;

