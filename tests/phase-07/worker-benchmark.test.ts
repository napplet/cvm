import { describe, expect, test } from "bun:test";

import {
  CertificationObservationSchema,
  WorkerCandidateSchema,
} from "../../src/certification/contracts";
import {
  assembleCertificationBundle,
  validateCertificationObservation,
  writeCertificationObservation,
} from "../../src/certification/evidence";
import { mkdtemp } from "node:fs/promises";
import { detectWorkerAuthorityDelta, evaluateAdmissionSlo, runWorkerCandidateBenchmark } from "../../src/admission/benchmark";
import { blockedFlyProbeEvidence } from "../../src/worker-adapters/fly-worker";

const digest = (char: string) => char.repeat(64);
const candidate = { id: digest("a"), provider: "modal", image: `registry.example/worker@sha256:${digest("b")}`, sourceSha256: digest("c") };
const observation = {
  version: 1, status: "passed", candidate, input: { datasetSha256: digest("d"), profileSha256: digest("e"), topologySha256: digest("f"), command: ["/usr/local/bin/benchmark", "--exact-ready"] },
  startedAtMs: 1_000, completedAtMs: 1_100, expiresAtMs: 2_000,
  claims: ["worker.admission_slo"], limitations: [], reasonCode: "OBSERVATION_COMPLETE",
};

describe("certification evidence", () => {
  test("binds every status to the candidate, immutable input, finite reason, and canonical digest", async () => {
    const parsed = await writeCertificationObservation(await mkdtemp("/tmp/napplet-cvm-certification-"), observation);
    await expect(validateCertificationObservation(parsed, { nowMs: 1_500, candidateId: candidate.id, requiredClaim: "worker.admission_slo" })).resolves.toMatchObject({ status: "passed" });
    for (const status of ["failed", "blocked", "skipped", "not_observed"] as const) {
      await expect(validateCertificationObservation({ ...parsed, status, claims: [] }, { nowMs: 1_500, candidateId: candidate.id, requiredClaim: "worker.admission_slo" })).rejects.toThrow();
    }
  });

  test("rejects candidate, input, command, topology, timestamp, claim, and status mutation", async () => {
    const parsed = await writeCertificationObservation(await mkdtemp("/tmp/napplet-cvm-certification-"), observation);
    for (const changed of [
      { ...parsed, candidate: { ...candidate, id: digest("9") } }, { ...parsed, input: { ...parsed.input, topologySha256: digest("9") } },
      { ...parsed, input: { ...parsed.input, command: ["changed"] } }, { ...parsed, completedAtMs: 1_101 },
      { ...parsed, claims: ["other"] }, { ...parsed, status: "blocked" },
    ]) await expect(validateCertificationObservation(changed, { nowMs: 1_500, candidateId: candidate.id, requiredClaim: "worker.admission_slo" })).rejects.toThrow();
  });

  test("writes immutable content-addressed observations and leaves the pointer unchanged on a non-pass", async () => {
    const root = await mkdtemp("/tmp/napplet-cvm-certification-");
    const first = await writeCertificationObservation(root, observation);
    await expect(writeCertificationObservation(root, observation)).resolves.toMatchObject({ evidenceSha256: first.evidenceSha256 });
    const bundle = await assembleCertificationBundle(root, { candidateId: candidate.id, observations: [first], nowMs: 1_500 });
    expect(bundle.claims).toEqual(["worker.admission_slo"]);
    await expect(assembleCertificationBundle(root, { candidateId: candidate.id, observations: [{ ...first, status: "blocked", claims: [] }], pointer: bundle.pointer, nowMs: 1_500 })).rejects.toThrow();
  });
});

test("worker candidate is provider-neutral and rejects vendor-native authority", () => {
  expect(WorkerCandidateSchema.parse(candidate)).toMatchObject({ provider: "modal", id: candidate.id });
  expect(() => WorkerCandidateSchema.parse({ ...candidate, client: { token: "no" } })).toThrow();
});

test("worker benchmark keeps candidates unselected until identical fresh live evidence meets every cohort floor", async () => {
  const result = await runWorkerCandidateBenchmark({
    candidate, profile: { acceptedFloor: 3, forcedPoolHitFloor: 1, forcedPoolMissColdContentionFloor: 1, bootstrapReplicates: 20 },
    execute: async (sample) => ({ ...sample, outcome: "accepted", receiptMonotonicMs: 100, readyMonotonicMs: 200, readyLeaseCount: 1, durableBacklogCount: 0, isolation: "passed", cleanup: "passed" }),
  });
  const flyResult = await runWorkerCandidateBenchmark({
    candidate: { ...candidate, provider: "fly", id: digest("f") }, profile: result.profile,
    execute: async (sample) => ({ ...sample, outcome: "accepted", receiptMonotonicMs: 100, readyMonotonicMs: 200, readyLeaseCount: 1, durableBacklogCount: 0, isolation: "passed", cleanup: "passed" }),
  });
  expect(flyResult.samples.map((sample) => [sample.id, sample.cohort])).toEqual(result.samples.map((sample) => [sample.id, sample.cohort]));
  expect(evaluateAdmissionSlo(result)).toMatchObject({ status: "passed", selection: "unselected", provider: "modal" });
  expect(evaluateAdmissionSlo(flyResult)).toMatchObject({ status: "passed", selection: "unselected", provider: "fly" });
  expect(detectWorkerAuthorityDelta({ workerPort: "WorkerPort", continuationPort: "ContinuationWorkerPort", evidenceIdentity: "CertificationObservation" })).toMatchObject({ status: "no_change" });
  expect(detectWorkerAuthorityDelta({ workerPort: "ModalWorkerPort", continuationPort: "ContinuationWorkerPort", evidenceIdentity: "CertificationObservation" })).toMatchObject({ status: "blocking_failure" });
  await expect(blockedFlyProbeEvidence()).resolves.toMatchObject({ provider: "fly", status: "blocked", selection: "unselected" });
});


test("admission upper p95 includes resampling uncertainty near the five-second boundary", async () => {
  let index = 0;
  const benchmark = await runWorkerCandidateBenchmark({
    candidate,
    profile: { acceptedFloor: 1_000, forcedPoolHitFloor: 200, forcedPoolMissColdContentionFloor: 200, bootstrapReplicates: 1_000 },
    execute: async () => ({ outcome: "accepted", receiptMonotonicMs: 0, readyMonotonicMs: index++ < 959 ? 4_000 : 6_000, readyLeaseCount: 1, durableBacklogCount: 0, isolation: "passed", cleanup: "passed" }),
  });
  const result = evaluateAdmissionSlo(benchmark);
  expect(result).toMatchObject({ count: 1_000, p95Ms: 4_000, upperP95Ms: 6_000, status: "failed", selection: "unselected" });
  expect(evaluateAdmissionSlo(benchmark)).toEqual(result);
  expect(evaluateAdmissionSlo({ ...benchmark, samples: [...benchmark.samples].reverse() })).toEqual(result);
  expect(evaluateAdmissionSlo({ ...benchmark, samples: benchmark.samples.map((sample) => ({ ...sample, readyMonotonicMs: 4_000 })) })).toMatchObject({ upperP95Ms: 4_000, status: "passed" });
});
