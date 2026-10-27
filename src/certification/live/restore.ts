import { z } from "zod";
import { WorkerCandidateSchema, ProtectedSuiteResultSchema, type ProtectedSuiteResult } from "../contracts";
import { runRestoreDrill, validateDurabilityInventory, validateTopologyClaim, type DurabilitySubjectSchema, type RestoreDrillInput } from "../../resilience/fault-harness";
import type { ObjectStorePort } from "../../continuity/object-store";

const LocalStateLossSchema = z.object({ status: z.literal("lost") }).strict();
const ExpiryDeletionSchema = z.object({ expired: z.literal(true), deleted: z.literal(true) }).strict();

export type FreshRestoreSubjectPort = Readonly<{
  objectStore: ObjectStorePort;
  expected: RestoreDrillInput["expected"];
  decryptAndVerify: RestoreDrillInput["decryptAndVerify"];
  reattach: RestoreDrillInput["reattach"];
}>;

/** The protected runner injects a newly composed controller and narrow object
 * read/decrypt/reattach seams. There is deliberately no protected evidence
 * write capability in this interface. */
export type LiveRestorePort = Readonly<{
  evidenceClass: "protected_live" | "deterministic";
  inventory(): Promise<unknown>;
  loseLocalState(): Promise<unknown>;
  createFreshInstance(): Promise<Readonly<{
    restoreSubject(subject: z.infer<typeof DurabilitySubjectSchema>): Promise<FreshRestoreSubjectPort>;
    exerciseExpiryDeletion(): Promise<unknown>;
    observeTopology(): Promise<unknown>;
    cleanup?(): Promise<void>;
  }>>;
}>;

export type LiveRestoreCertificationInput = Readonly<{
  candidate: unknown;
  topology: unknown;
  nowMs?: number;
  restorePort?: LiveRestorePort;
}>;

function nonPass(status: "blocked" | "failed", reasonCode: ProtectedSuiteResult["reasonCode"], limitation: string): ProtectedSuiteResult {
  return ProtectedSuiteResultSchema.parse({ status, claims: [], limitations: [limitation], reasonCode });
}

/**
 * Verifies all seven D-125 subjects after the original infrastructure loses
 * local state. Exact object generation/checksum, decryption, owner/version/
 * lease/toolchain facts, and retention are delegated to runRestoreDrill; wider
 * RTO/RPO claims require an exact observed topology match.
 */
export async function runLiveRestoreCertification(input: LiveRestoreCertificationInput): Promise<ProtectedSuiteResult> {
  const candidate = WorkerCandidateSchema.safeParse(input.candidate);
  const port = input.restorePort;
  if (!candidate.success || !port || port.evidenceClass !== "protected_live") {
    return nonPass("blocked", "INPUT_UNAVAILABLE", "protected-live-restore-control-required");
  }

  let fresh: Awaited<ReturnType<LiveRestorePort["createFreshInstance"]>> | undefined;
  try {
    const subjects = validateDurabilityInventory(await port.inventory());
    LocalStateLossSchema.parse(await port.loseLocalState());
    fresh = await port.createFreshInstance();
    for (const subject of subjects) {
      const restored = await fresh.restoreSubject(subject);
      const result = await runRestoreDrill({
        objectStore: restored.objectStore,
        subject,
        expected: restored.expected,
        nowMs: input.nowMs ?? Date.now(),
        decryptAndVerify: restored.decryptAndVerify,
        reattach: restored.reattach,
      });
      if (result.status !== "restored" || result.reattachments !== 1) {
        return nonPass("failed", "EVIDENCE_INVALID", "fresh-instance-restore-incomplete");
      }
    }
    ExpiryDeletionSchema.parse(await fresh.exerciseExpiryDeletion());
    const topology = validateTopologyClaim({ claimed: input.topology as never, observation: await fresh.observeTopology() as never });
    if (topology.status !== "observed") return nonPass("blocked", "TOPOLOGY_UNAVAILABLE", "topology-observation-required");
    return ProtectedSuiteResultSchema.parse({
      status: "passed", claims: ["release.checkpoint_object"], limitations: ["selection-external"], reasonCode: "OBSERVATION_COMPLETE",
    });
  } catch {
    return nonPass("blocked", "PROVIDER_UNAVAILABLE", "restore-observation-unavailable");
  } finally {
    if (fresh?.cleanup) {
      try { await fresh.cleanup(); }
      catch { return nonPass("blocked", "PROVIDER_UNAVAILABLE", "restore-cleanup-unconfirmed"); }
    }
  }
}
