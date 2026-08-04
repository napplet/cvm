import { describe, expect, test } from "bun:test";
import { PHASE_04_REPAIR_POLICY, evaluateAutomaticRepair } from "../../src/phase-04/repair-policy";

const request = {
  principalId: "principal:owner", sessionId: "session:stable", expectedVersion: 1, currentVersion: 1,
  workspaceLineage: "workspace:session:stable", snapshotReference: "snapshot:1", originatingActionId: "revision:failed", failedArtifactId: "artifact:failed:2", validationReportReference: "report:validation:2",
  priorAutomaticRepairs: 0, permanentNappletPolicy: "pass" as const, actionAuthorized: true,
};

describe("one validation-triggered repair policy", () => {
  test("is deeply immutable, versioned, and allows only the first current authorized repair", () => {
    expect(PHASE_04_REPAIR_POLICY).toMatchObject({ version: "phase-04-repair-policy-2026-08-04", maximumAutomaticRepairs: 1, comparison: "restrictive_only" });
    expect(Object.isFrozen(PHASE_04_REPAIR_POLICY)).toBe(true);
    expect(evaluateAutomaticRepair(request)).toEqual({ status: "allowed", actionKind: "repair", nextAction: "repair" });
  });

  test("denies stale, mismatched, unaffordable, policy-broadened, and recursive repairs without a second action", () => {
    expect(evaluateAutomaticRepair({ ...request, expectedVersion: 0 })).toMatchObject({ status: "denied", code: "STALE_SESSION_VERSION", nextAction: "signed_revision_required" });
    expect(evaluateAutomaticRepair({ ...request, failedArtifactId: "" })).toMatchObject({ status: "denied", code: "VALIDATION_BINDING_INVALID" });
    expect(evaluateAutomaticRepair({ ...request, actionAuthorized: false })).toMatchObject({ status: "denied", code: "ACTION_AUTHORIZATION_REQUIRED" });
    expect(evaluateAutomaticRepair({ ...request, permanentNappletPolicy: "deny" })).toMatchObject({ status: "denied", code: "PERMANENT_POLICY_DENIED" });
    expect(evaluateAutomaticRepair({ ...request, priorAutomaticRepairs: 1 })).toMatchObject({ status: "denied", code: "AUTOMATIC_REPAIR_LIMIT_REACHED", nextAction: "signed_revision_required" });
    expect(evaluateAutomaticRepair({ ...request, candidateMaximumAutomaticRepairs: 2 })).toMatchObject({ status: "denied", code: "REPAIR_POLICY_NOT_RESTRICTIVE" });
  });
});
