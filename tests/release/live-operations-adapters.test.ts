import { expect, test } from "bun:test";
import { LifecycleStageSchema, type LifecycleObservation } from "../../src/telemetry/contracts";
import { lifecycleCardinalityUpperBound } from "../../src/telemetry/redaction";
import { runLiveAdmissionCertification } from "../../src/certification/live/admission";
import { runLiveTelemetryCertification } from "../../src/certification/live/telemetry";

const digest = (letter: string) => letter.repeat(64);
const candidate = (provider: "modal" | "fly") => ({
  id: digest(provider === "modal" ? "a" : "b"),
  provider,
  image: `registry.example/${provider}@sha256:${digest("c")}`,
  sourceSha256: digest("d"),
});

test("admission runs the identical locked Modal and Fly schedules, while deterministic ports cannot pass", async () => {
  let deterministicCalls = 0;
  const deterministic = await runLiveAdmissionCertification({
    candidate: candidate("modal"),
    profile: { acceptedFloor: 1_000, forcedPoolHitFloor: 200, forcedPoolMissColdContentionFloor: 200, bootstrapReplicates: 20 },
    observationPort: {
      evidenceClass: "deterministic",
      executeSample: async () => { deterministicCalls += 1; return {}; },
    },
  });
  expect(deterministic).toEqual(expect.objectContaining({ status: "blocked", claims: [], reasonCode: "INPUT_UNAVAILABLE" }));
  expect(deterministicCalls).toBe(0);

  const schedules = new Map<string, string[]>();
  for (const provider of ["modal", "fly"] as const) {
    const result = await runLiveAdmissionCertification({
      candidate: candidate(provider),
      profile: { acceptedFloor: 1_000, forcedPoolHitFloor: 200, forcedPoolMissColdContentionFloor: 200, bootstrapReplicates: 20 },
      observationPort: {
        evidenceClass: "protected_live",
        executeSample: async (sample: { id: string; cohort: string }) => {
          schedules.set(provider, [...(schedules.get(provider) ?? []), `${sample.id}:${sample.cohort}`]);
          return { ...sample, outcome: "accepted", receiptMonotonicMs: 10, readyMonotonicMs: 4_900, readyLeaseCount: 1, durableBacklogCount: 0, isolation: "passed", cleanup: "passed" };
        },
      },
    });
    expect(result).toEqual(expect.objectContaining({ status: "passed", claims: ["release.admission_slo", "release.worker"] }));
  }
  expect(schedules.get("modal")).toEqual(schedules.get("fly"));
});

test("Collector telemetry requires a candidate-bound complete export window and rejects canaries", async () => {
  const observations: LifecycleObservation[] = [];
  const result = await runLiveTelemetryCertification({
    candidate: candidate("modal"),
    input: { datasetSha256: digest("e"), profileSha256: digest("f"), topologySha256: digest("1"), command: ["certify-phase-07", "suite:telemetry"] },
    collector: { collectorDigest: `sha256:${digest("2")}`, configSha256: digest("3") },
    observationPort: {
      evidenceClass: "protected_live",
      emit: async (observation: LifecycleObservation) => { observations.push(observation); },
      queryWindow: async (binding: unknown) => ({ status: "observed", binding, observations, rejectedCanaries: true, metricSeriesCount: lifecycleCardinalityUpperBound() }),
    },
  });
  expect(result).toEqual(expect.objectContaining({ status: "passed", claims: ["release.telemetry_policy"] }));
  expect(new Set(observations.map((item) => item.stage))).toEqual(new Set(LifecycleStageSchema.options));

  const canary = await runLiveTelemetryCertification({
    candidate: candidate("modal"),
    input: { datasetSha256: digest("e"), profileSha256: digest("f"), topologySha256: digest("1"), command: ["certify-phase-07", "suite:telemetry"] },
    collector: { collectorDigest: `sha256:${digest("2")}`, configSha256: digest("3") },
    observationPort: { evidenceClass: "deterministic", emit: async () => { throw new Error("must not emit"); }, queryWindow: async () => { throw new Error("must not query"); } },
  });
  expect(canary).toEqual(expect.objectContaining({ status: "blocked", claims: [], reasonCode: "INPUT_UNAVAILABLE" }));
});
