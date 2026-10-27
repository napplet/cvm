import { expect, test } from "bun:test";
import { executeIdenticalWorkerCohorts } from "../../src/certification/live/worker-ports";

test.each(["initially_future", "expires_midway", "expires_at_completion", "clock_rewinds"] as const)("worker selection rejects %s evidence and stops further samples", async fault => {
  let now = fault === "initially_future" ? 99 : 150;
  let calls = 0;
  const candidates = (["modal", "fly"] as const).map((provider, index) => ({
    candidate: { id: String(index + 1).repeat(64), provider, image: `registry.example/worker@sha256:${"a".repeat(64)}`, sourceSha256: "b".repeat(64) },
    topologySha256: "c".repeat(64),
    observationPort: {
      evidenceClass: "protected_live" as const,
      async executeSample(sample: { id: string; cohort: string }) {
        calls++;
        if (fault === "expires_midway" && calls === 10 || fault === "expires_at_completion" && calls === 2000) now = 200;
        if (fault === "clock_rewinds" && calls === 10) now = 149;
        return { ...sample, outcome: "accepted", receiptMonotonicMs: 1, readyMonotonicMs: 2, readyLeaseCount: 1, durableBacklogCount: 0, isolation: "passed", cleanup: "passed" };
      },
    },
  }));
  const result = await executeIdenticalWorkerCohorts({ candidates, observedAtMs: 100, expiresAtMs: 200, now: () => now });
  expect(result).toMatchObject({ status: "unselected", provider: null, selectionEvidenceSha256: null, reasonCode: "EVIDENCE_STALE" });
  expect(calls).toBe(fault === "initially_future" ? 0 : fault === "expires_at_completion" ? 2000 : 10);
});
