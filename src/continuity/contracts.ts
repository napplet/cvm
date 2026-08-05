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
export const ContinuationStatusSchema = z.object({
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

export type PendingActionIntent = z.infer<typeof PendingActionIntentSchema>;
export type NeedsTopUpResult = z.infer<typeof NeedsTopUpResultSchema>;
export type ContinuationStatus = z.infer<typeof ContinuationStatusSchema>;
