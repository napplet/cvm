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
