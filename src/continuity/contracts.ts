import { z } from "zod";

export const CanonicalSatSchema = z.string().regex(/^(0|[1-9][0-9]*)$/u);
export const EpochMillisecondsSchema = z.number().int().nonnegative();

/** Durable identity for work that has not crossed an effectful boundary. */
export const PendingActionIntentSchema = z.object({
  accountId: z.string().min(1),
  sessionId: z.string().min(1),
  idempotencyKey: z.string().min(1),
  fingerprint: z.string().regex(/^[a-f0-9]{64}$/u),
  reference: z.string().min(1),
  actionKind: z.enum(["start_session", "revise_session", "repair"]),
  boundedPayloadHash: z.string().regex(/^[a-f0-9]{64}$/u),
  expectedSessionVersion: z.number().int().nonnegative(),
  expectedArtifactVersion: z.number().int().nonnegative(),
  policyVersion: z.string().min(1),
  priceCardId: z.string().min(1),
  profileId: z.string().min(1),
  toolchainId: z.string().min(1),
  actionMaximum: CanonicalSatSchema,
  admissionReference: z.string().min(1),
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
export const ContinuationStatusSchema = z.discriminatedUnion("status", [NeedsTopUpContinuationStatusSchema, ExpiredContinuationStatusSchema]);

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
  z.object({ status: z.literal("restored"), code: z.literal("RESUME_RESTORED"), sessionId: z.string().min(1), checkpointId: z.string().min(1), pendingActionReference: z.string().min(1), actionBudgetReference: z.string().min(1), allocationIntentReference: z.string().min(1) }).strict(),
  z.object({ status: z.literal("reconciliation_pending"), code: z.enum(["RESUME_ALLOCATION_RECONCILIATION", "RESUME_RESTORE_RECONCILIATION", "RESUME_CHECKPOINT_RECONCILIATION"]), sessionId: z.string().min(1), checkpointId: z.string().min(1), pendingActionReference: z.string().min(1), allocationIntentReference: z.string().min(1) }).strict(),
  z.object({ status: z.literal("denied"), code: z.enum(["RESUME_INVALID_COMMAND", "RESUME_CHECKPOINT_NOT_FOUND_OR_DENIED", "RESUME_PENDING_APPROVAL_REQUIRED", "RESUME_PENDING_ACTION_MISMATCH", "RESUME_CAP_APPROVAL_REQUIRED", "RESUME_COMPATIBILITY_DENIED", "RESUME_BALANCE_INSUFFICIENT", "RESUME_CAP_INSUFFICIENT", "RESUME_STALE_OR_CONFLICTING"]) }).strict(),
]);

export type PendingActionIntent = z.infer<typeof PendingActionIntentSchema>;
export type NeedsTopUpResult = z.infer<typeof NeedsTopUpResultSchema>;
export type ContinuationStatus = z.infer<typeof ContinuationStatusSchema>;
export type ResumePendingApproval = z.infer<typeof ResumePendingApprovalSchema>;
export type ResumeCompatibility = z.infer<typeof ResumeCompatibilitySchema>;
export type ResumeSessionCommand = z.infer<typeof ResumeSessionCommandSchema>;
export type ResumeSessionResult = z.infer<typeof ResumeSessionResultSchema>;
