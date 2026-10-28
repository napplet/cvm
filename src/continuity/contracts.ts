import { RemixReferenceSchema } from "../remix/reference";
import { z } from "zod";

export const CanonicalSatSchema = z.string().regex(/^(0|[1-9][0-9]*)$/u);
export const EpochMillisecondsSchema = z.number().int().nonnegative();

export const ProtectedContinuationCommandSchema = z.object({
  schemaVersion: z.literal("protected-continuation-command-v1"),
  keyReference: z.string().min(1).max(256),
  retentionUntilMs: EpochMillisecondsSchema,
  bindingSha256: z.string().regex(/^[a-f0-9]{64}$/u),
  plaintextSha256: z.string().regex(/^[a-f0-9]{64}$/u).optional(),
  nonceBase64: z.string().length(16),
  wrapNonceBase64: z.string().length(16),
  wrappedDekBase64: z.string().length(64),
  ciphertextBase64: z.string().min(24).max(100_000).regex(/^[A-Za-z0-9+/]+={0,2}$/u),
}).strict();
export type ProtectedContinuationCommand = z.infer<typeof ProtectedContinuationCommandSchema>;

/** Durable identity for work that has not crossed an effectful boundary. */
export const PendingActionIntentSchema = z.object({
  accountId: z.string().min(1),
  sessionId: z.string().min(1),
  idempotencyKey: z.string().min(1),
  fingerprint: z.string().regex(/^[a-f0-9]{64}$/u),
  reference: z.string().min(1),
  actionKind: z.enum(["start_session", "revise_session", "repair"]),
  boundedPayloadHash: z.string().regex(/^[a-f0-9]{64}$/u),
  /** Exact bounded command identity retained after its live envelope expires. */
  commandSha256: z.string().regex(/^[a-f0-9]{64}$/u).optional(),
  expectedSessionVersion: z.number().int().nonnegative(),
  expectedArtifactVersion: z.number().int().nonnegative(),
  policyVersion: z.string().min(1),
  priceCardId: z.string().min(1),
  profileId: z.string().min(1),
  toolchainId: z.string().min(1),
  actionMaximum: CanonicalSatSchema,
  admissionReference: z.string().min(1),
  /** Private encrypted command, committed atomically with the pause. */
  protectedCommand: ProtectedContinuationCommandSchema.optional(),
}).strict();

export const NeedsTopUpResultSchema = z.object({
  status: z.literal("needs_top_up"),
  code: z.literal("ACTION_AFFORDABILITY_REQUIRED"),
  accountId: z.string().min(1),
  sessionId: z.string().min(1),
  pendingActionReference: z.string().min(1),
  pendingActionFingerprint: z.string().regex(/^[a-f0-9]{64}$/u),
  pendingActionKind: z.enum(["start_session", "revise_session", "repair"]),
  actionMaximum: CanonicalSatSchema,
  requiredAdditionalFunding: CanonicalSatSchema,
  requiredCapApproval: CanonicalSatSchema,
  settledBalance: CanonicalSatSchema,
  availableBalance: CanonicalSatSchema,
  remainingCap: CanonicalSatSchema,
  graceDeadlineMs: EpochMillisecondsSchema,
  checkpoint: z.object({ state: z.literal("live_worker"), reference: z.string().min(1) }).strict(),
  nextRequiredAction: z.enum(["top_up", "approve_cap", "top_up_and_approve_cap"]),
}).strict();

/** Public projection shape; it intentionally contains no payload, archive, or provider material. */
const NeedsTopUpContinuationStatusSchema = z.object({
  status: z.literal("needs_top_up"),
  pendingAction: z.object({ reference: z.string().min(1), fingerprint: z.string().regex(/^[a-f0-9]{64}$/u), kind: z.enum(["start_session", "revise_session", "repair"]) }).strict(),
  actionMaximum: CanonicalSatSchema,
  requiredAdditionalFunding: CanonicalSatSchema,
  requiredCapApproval: CanonicalSatSchema,
  settledBalance: CanonicalSatSchema,
  availableBalance: CanonicalSatSchema,
  remainingCap: CanonicalSatSchema,
  graceDeadlineMs: EpochMillisecondsSchema,
  checkpoint: z.object({ state: z.literal("live_worker"), reference: z.string().min(1) }).strict(),
  nextRequiredAction: z.enum(["top_up", "approve_cap", "top_up_and_approve_cap"]),
}).strict();
const ExpiredContinuationStatusSchema = z.object({
  status: z.literal("expired"),
  /** Safe server reference only; no manifest, object, or key identity crosses this boundary. */
  checkpoint: z.object({ reference: z.string().min(1) }).strict(),
  retentionDeadlineMs: EpochMillisecondsSchema,
  deletionState: z.enum(["scheduled", "deleted", "failed", "unknown", "not_recorded"]),
  nextRequiredAction: z.literal("none"),
}).strict();
const ResumeRecoveryContinuationStatusSchema = z.object({
  status: z.enum(["resume_required", "restore_pending", "restored"]),
  /** Server reference only; no archive/object/key metadata is projected. */
  checkpoint: z.object({ reference: z.string().min(1) }).strict(),
  nextRequiredAction: z.enum(["resume_session", "wait_for_current_action"]),
}).strict();
export const ContinuationStatusSchema = z.discriminatedUnion("status", [NeedsTopUpContinuationStatusSchema, ExpiredContinuationStatusSchema, ResumeRecoveryContinuationStatusSchema]);

/** Owner-signed consent for one exact, previously paused action. */
export const ResumePendingApprovalSchema = z.object({
  reference: z.string().min(1),
  fingerprint: z.string().regex(/^[a-f0-9]{64}$/u),
  kind: z.enum(["start_session", "revise_session", "repair"]),
  maximum: CanonicalSatSchema,
}).strict();

/** Server-owned pins; checkpoint/archive text is never a compatibility authority. */
export const ResumeCompatibilitySchema = z.object({
  policyVersion: z.string().min(1),
  profileId: z.string().min(1),
  priceCardId: z.string().min(1),
  toolchainId: z.string().min(1),
}).strict();

/** Strict, transport-neutral explicit-resume command. The adapter injects principal. */
export const ResumeSessionCommandSchema = z.object({
  principal: z.object({ id: z.string().min(1) }).strict(),
  sessionId: z.string().min(1),
  checkpointId: z.string().min(1),
  expectedSessionVersion: z.number().int().nonnegative(),
  expectedCheckpointVersion: z.literal(1),
  idempotencyKey: z.string().min(1),
  approvePendingAction: z.literal(true),
  capApprovalReference: z.string().min(1),
  pendingAction: ResumePendingApprovalSchema,
}).strict();

/** Safe public result: no account, archive, key, provider, or payment material. */
export const ResumeSessionResultSchema = z.discriminatedUnion("status", [
  z.object({ status: z.literal("restored"), code: z.literal("RESUME_RESTORED"), sessionId: z.string().min(1), checkpointId: z.string().min(1), pendingActionReference: z.string().min(1) }).strict(),
  z.object({ status: z.literal("reconciliation_pending"), code: z.enum(["RESUME_ALLOCATION_RECONCILIATION", "RESUME_RESTORE_RECONCILIATION", "RESUME_CHECKPOINT_RECONCILIATION", "RESUME_ACTION_RECONCILIATION"]), sessionId: z.string().min(1), checkpointId: z.string().min(1), pendingActionReference: z.string().min(1) }).strict(),
  z.object({ status: z.literal("denied"), code: z.enum(["RESUME_INVALID_COMMAND", "RESUME_CHECKPOINT_NOT_FOUND_OR_DENIED", "RESUME_PENDING_APPROVAL_REQUIRED", "RESUME_PENDING_ACTION_MISMATCH", "RESUME_CAP_APPROVAL_REQUIRED", "RESUME_COMPATIBILITY_DENIED", "RESUME_BALANCE_INSUFFICIENT", "RESUME_CAP_INSUFFICIENT", "RESUME_STALE_OR_CONFLICTING"]) }).strict(),
]);

export type PendingActionIntent = z.infer<typeof PendingActionIntentSchema>;
export type NeedsTopUpResult = z.infer<typeof NeedsTopUpResultSchema>;
export type ContinuationStatus = z.infer<typeof ContinuationStatusSchema>;
export type ResumePendingApproval = z.infer<typeof ResumePendingApprovalSchema>;
export type ResumeCompatibility = z.infer<typeof ResumeCompatibilitySchema>;
export type ResumeSessionCommand = z.infer<typeof ResumeSessionCommandSchema>;
export type ResumeSessionResult = z.infer<typeof ResumeSessionResultSchema>;

/**
 * A pre-admission command has deliberately not acquired a session, cap hold,
 * worker lease, or provider operation.  Keep this type separate from
 * PendingActionIntent, which describes an already-admitted live pause.
 */
export const PendingStartCommandSchema = z.object({
  remixReference: RemixReferenceSchema.optional(),
  idempotencyKey: z.string().min(1).max(160),
  maximum: CanonicalSatSchema,
  idea: z.string().trim().min(1).max(8_000),
  policyVersion: z.string().min(1).max(160),
}).strict();

export const PendingActionHeaderSchema = z.object({
  schemaVersion: z.literal("pending-action-envelope-v1"),
  kind: z.literal("pending_action"),
  checkpointId: z.string().min(1),
  checkpointVersion: z.literal(1),
  ownerId: z.string().regex(/^[a-f0-9]{64}$/u),
  accountId: z.string().min(1),
  commandFingerprint: z.string().regex(/^[a-f0-9]{64}$/u),
  expiresAtMs: EpochMillisecondsSchema,
  expectedSessionVersion: z.literal(0),
  expectedArtifactVersion: z.literal(0),
  policyVersion: z.string().min(1),
  profileId: z.string().min(1),
  priceCardId: z.string().min(1),
  toolchainId: z.string().min(1),
  rootManifestSha256: z.string().regex(/^[a-f0-9]{64}$/u),
  keyId: z.string().min(1),
}).strict();

export const PendingActionEnvelopeSchema = z.object({
  header: PendingActionHeaderSchema,
  headerSha256: z.string().regex(/^[a-f0-9]{64}$/u),
  ciphertextBase64: z.string().min(1).regex(/^[A-Za-z0-9+/]+={0,2}$/u),
  ciphertextSha256: z.string().regex(/^[a-f0-9]{64}$/u),
  nonceBase64: z.string().min(1).regex(/^[A-Za-z0-9+/]+={0,2}$/u),
}).strict();

export const PendingActionStatusSchema = z.enum(["saved", "bound", "completed", "failed"]);
export const PendingActionRecordSchema = z.object({
  checkpointId: z.string().min(1),
  ownerId: z.string().regex(/^[a-f0-9]{64}$/u),
  accountId: z.string().min(1),
  idempotencyKey: z.string().min(1),
  commandFingerprint: z.string().regex(/^[a-f0-9]{64}$/u),
  reference: z.string().min(1),
  maximum: CanonicalSatSchema,
  envelope: PendingActionEnvelopeSchema,
  expiresAtMs: EpochMillisecondsSchema,
  state: PendingActionStatusSchema,
  admissionReference: z.string().min(1).optional(),
  resumeIdempotencyKey: z.string().min(1).optional(),
  resumeFingerprint: z.string().regex(/^[a-f0-9]{64}$/u).optional(),
  operationId: z.string().min(1).optional(),
  result: z.unknown().optional(),
}).strict();

export const ResumePreAdmissionCommandSchema = z.object({
  kind: z.literal("pending_action"),
  checkpointId: z.string().min(1),
  expectedCheckpointVersion: z.literal(1),
  expectedSessionVersion: z.literal(0),
  idempotencyKey: z.string().min(1).max(160),
  approvePendingAction: z.literal(true),
  admissionReference: z.string().min(1),
  pendingAction: z.object({
    reference: z.string().min(1),
    fingerprint: z.string().regex(/^[a-f0-9]{64}$/u),
    kind: z.literal("start_session"),
    maximum: CanonicalSatSchema,
  }).strict(),
}).strict();

export type PendingStartCommand = z.infer<typeof PendingStartCommandSchema>;
export type PendingActionHeader = z.infer<typeof PendingActionHeaderSchema>;
export type PendingActionEnvelope = z.infer<typeof PendingActionEnvelopeSchema>;
export type PendingActionRecord = z.infer<typeof PendingActionRecordSchema>;
export type ResumePreAdmissionCommand = z.infer<typeof ResumePreAdmissionCommandSchema>;
