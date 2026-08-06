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
  const chaos = await runLiveChaosCertification({ candidate: candidate("modal"), faultPort: { evidenceClass: "deterministic", executeFault: async () => { faultCalls += 1; return {}; }, observeOriginal: async () => ({}) }, topology: {} });
  const restore = await runLiveRestoreCertification({ candidate: candidate("modal"), restorePort: { evidenceClass: "deterministic", inventory: async () => { restoreCalls += 1; return []; }, loseLocalState: async () => ({ status: "lost" }), createFreshInstance: async () => ({}) }, topology: {} });
  expect(chaos).toEqual(expect.objectContaining({ status: "blocked", claims: [], reasonCode: "INPUT_UNAVAILABLE" }));
  expect(restore).toEqual(expect.objectContaining({ status: "blocked", claims: [], reasonCode: "INPUT_UNAVAILABLE" }));
  expect({ faultCalls, restoreCalls }).toEqual({ faultCalls: 0, restoreCalls: 0 });
});
