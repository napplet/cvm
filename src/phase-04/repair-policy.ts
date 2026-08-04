import { z } from "zod";

function deepFreeze<T>(value: T): T {
  if (value !== null && typeof value === "object" && !Object.isFrozen(value)) {
    for (const child of Object.values(value as Record<string, unknown>)) deepFreeze(child);
    Object.freeze(value);
  }
  return value;
}

export const PHASE_04_REPAIR_POLICY = deepFreeze({
  version: "phase-04-repair-policy-2026-08-04",
  maximumAutomaticRepairs: 1,
  comparison: "restrictive_only" as const,
});

export const AutomaticRepairRequestSchema = z.object({
  principalId: z.string().min(1), sessionId: z.string().min(1), expectedVersion: z.number().int().nonnegative(), currentVersion: z.number().int().nonnegative(),
  workspaceLineage: z.string().min(1), snapshotReference: z.string().min(1), originatingActionId: z.string().min(1), failedArtifactId: z.string().min(1), validationReportReference: z.string().min(1),
  priorAutomaticRepairs: z.number().int().nonnegative(), permanentNappletPolicy: z.enum(["pass", "deny"]), actionAuthorized: z.boolean(), candidateMaximumAutomaticRepairs: z.number().int().nonnegative().optional(),
}).strict();

export const AutomaticRepairDecisionSchema = z.discriminatedUnion("status", [
  z.object({ status: z.literal("allowed"), actionKind: z.literal("repair"), nextAction: z.literal("repair") }).strict(),
  z.object({ status: z.literal("denied"), code: z.enum(["STALE_SESSION_VERSION", "VALIDATION_BINDING_INVALID", "ACTION_AUTHORIZATION_REQUIRED", "PERMANENT_POLICY_DENIED", "AUTOMATIC_REPAIR_LIMIT_REACHED", "REPAIR_POLICY_NOT_RESTRICTIVE"]), nextAction: z.literal("signed_revision_required") }).strict(),
]);

export type AutomaticRepairRequest = z.infer<typeof AutomaticRepairRequestSchema>;
export type AutomaticRepairDecision = z.infer<typeof AutomaticRepairDecisionSchema>;

/** Pure coordinator policy: a repair never changes money, state, or worker grants. */
export function evaluateAutomaticRepair(input: unknown): AutomaticRepairDecision {
  const request = AutomaticRepairRequestSchema.safeParse(input);
  if (!request.success) return AutomaticRepairDecisionSchema.parse({ status: "denied", code: "VALIDATION_BINDING_INVALID", nextAction: "signed_revision_required" });
  const value = request.data;
  if (value.candidateMaximumAutomaticRepairs !== undefined && value.candidateMaximumAutomaticRepairs > PHASE_04_REPAIR_POLICY.maximumAutomaticRepairs) return AutomaticRepairDecisionSchema.parse({ status: "denied", code: "REPAIR_POLICY_NOT_RESTRICTIVE", nextAction: "signed_revision_required" });
  if (value.expectedVersion !== value.currentVersion) return AutomaticRepairDecisionSchema.parse({ status: "denied", code: "STALE_SESSION_VERSION", nextAction: "signed_revision_required" });
  if (value.permanentNappletPolicy !== "pass") return AutomaticRepairDecisionSchema.parse({ status: "denied", code: "PERMANENT_POLICY_DENIED", nextAction: "signed_revision_required" });
  if (!value.actionAuthorized) return AutomaticRepairDecisionSchema.parse({ status: "denied", code: "ACTION_AUTHORIZATION_REQUIRED", nextAction: "signed_revision_required" });
  if (value.priorAutomaticRepairs >= PHASE_04_REPAIR_POLICY.maximumAutomaticRepairs) return AutomaticRepairDecisionSchema.parse({ status: "denied", code: "AUTOMATIC_REPAIR_LIMIT_REACHED", nextAction: "signed_revision_required" });
  return AutomaticRepairDecisionSchema.parse({ status: "allowed", actionKind: "repair", nextAction: "repair" });
}
