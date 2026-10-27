import { expect, test } from "bun:test";
import { runLiveAdmissionCertification } from "../../src/certification/live/admission";
import { runLiveTelemetryCertification } from "../../src/certification/live/telemetry";
import { runLiveChaosCertification } from "../../src/certification/live/chaos";
import { runLiveRestoreCertification } from "../../src/certification/live/restore";

const digest = (letter: string) => letter.repeat(64);
const candidate = (provider: "modal" | "fly") => ({
  id: digest(provider === "modal" ? "a" : "b"),
  provider,
  image: `registry.example/${provider}@sha256:${digest("c")}`,
  sourceSha256: digest("d"),
});

test("admission rejects deterministic Modal and Fly ports before any locked cohort dispatch", async () => {
  let deterministicCalls = 0;
  for (const provider of ["modal", "fly"] as const) {
    const result = await runLiveAdmissionCertification({
      candidate: candidate(provider),
      profile: { acceptedFloor: 1_000, forcedPoolHitFloor: 200, forcedPoolMissColdContentionFloor: 200, bootstrapReplicates: 20 },
      observationPort: {
        evidenceClass: "deterministic",
        executeSample: async () => { deterministicCalls += 1; return {}; },
      },
    });
    expect(result).toEqual(expect.objectContaining({ status: "blocked", claims: [], reasonCode: "INPUT_UNAVAILABLE" }));
  }
  expect(deterministicCalls).toBe(0);
});

test("Collector telemetry rejects deterministic ports and unavailable canary inspection without dispatch", async () => {
  let emits = 0;
  let queries = 0;
  const canary = await runLiveTelemetryCertification({
    candidate: candidate("modal"),
    input: { datasetSha256: digest("e"), profileSha256: digest("f"), topologySha256: digest("1"), command: ["certify-phase-07", "suite:telemetry"] },
    collector: { collectorDigest: `sha256:${digest("2")}`, configSha256: digest("3") },
    observationPort: { evidenceClass: "deterministic", emit: async () => { emits += 1; }, queryWindow: async () => { queries += 1; return {}; } },
  });
  expect(canary).toEqual(expect.objectContaining({ status: "blocked", claims: [], reasonCode: "INPUT_UNAVAILABLE" }));
  expect({ emits, queries }).toEqual({ emits: 0, queries: 0 });
});

test("chaos and restore reject deterministic controls before provider effects or protected evidence", async () => {
  let faultCalls = 0;
  let restoreCalls = 0;
  const chaos = await runLiveChaosCertification({ candidate: candidate("modal"), faultPort: { evidenceClass: "deterministic", executeFault: async () => { faultCalls += 1; return {}; }, observeOriginal: async () => ({}), observeTopology: async () => { throw new Error("unexpected topology read"); } }, topology: {} });
  const restore = await runLiveRestoreCertification({ candidate: candidate("modal"), restorePort: { evidenceClass: "deterministic", inventory: async () => { restoreCalls += 1; return []; }, loseLocalState: async () => ({ status: "lost" }), createFreshInstance: async () => { throw new Error("unexpected restore"); } }, topology: {} });
  expect(chaos).toEqual(expect.objectContaining({ status: "blocked", claims: [], reasonCode: "INPUT_UNAVAILABLE" }));
  expect(restore).toEqual(expect.objectContaining({ status: "blocked", claims: [], reasonCode: "INPUT_UNAVAILABLE" }));
  expect({ faultCalls, restoreCalls }).toEqual({ faultCalls: 0, restoreCalls: 0 });
});

// Contract fixtures only: these test the oracle boundary, never produce live evidence.
test("chaos compares complete fault observations with an independent bounded oracle", async () => {
  const { D122_FAULT_MATRIX, NO_EFFECTS_ORACLE } = await import("../../src/resilience/fault-harness");
  const topology = { ingressRegions: ["europe-west1"], databaseRegions: ["europe-west1"], objectRegions: ["nam4"], workerRegions: ["ams"], relayRegions: ["eu"], activeStandby: "single-active", failureDomain: "instance", rtoMs: 1000, rpoMs: 0, limitations: ["contract-fixture"] };
  const expected = { ...NO_EFFECTS_ORACLE, worker: 1, session: 1 };
  let mode: "matching" | "duplicate" | "missing-effect" | "wrong-outcome" | "self-oracle" = "matching";
  let dispatched = 0;
  const port = {
    evidenceClass: "protected_live" as const,
    async executeFault(schedule: typeof D122_FAULT_MATRIX[number]) {
      dispatched++;
      return { operationId: schedule.input.operationId, sessionId: schedule.initialState.sessionId,
        oracle: { activeWriters: 1, effects: mode === "self-oracle" ? { ...expected, worker: 2 } : expected } };
    },
    async observeOriginal(identity: { operationId: string; sessionId: string }) {
      const schedule = D122_FAULT_MATRIX.find(value => value.input.operationId === identity.operationId)!;
      return { ...identity, observed: mode === "wrong-outcome" ? "accepted" : schedule.outcomes[0]!.outcome,
        activeWriters: 1, effects: mode === "duplicate" || mode === "self-oracle" ? { ...expected, worker: 2 } : mode === "missing-effect" ? NO_EFFECTS_ORACLE : expected };
    },
    async observeTopology() { return { status: "observed", topology }; },
  };
  const run = () => runLiveChaosCertification({ candidate: candidate("modal"), topology, faultPort: port });
  expect((await run()).status).toBe("passed");
  expect(dispatched).toBe(D122_FAULT_MATRIX.length);
  for (mode of ["duplicate", "missing-effect", "wrong-outcome"] as const) {
    const result = await run();
    expect(result.status).toBe("failed"); expect(result.claims).toEqual([]); expect(result.reasonCode).toBe("EVIDENCE_INVALID");
  }
  mode = "self-oracle";
  expect((await run()).status).toBe("blocked");
});
