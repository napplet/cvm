import { expect, test } from "bun:test";
import { mkdtemp, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { verifyReproducibilityRecord, writeReproducibilityRecord } from "../../src/certification/reproducibility";

const digest = (value: string) => value.repeat(64).slice(0, 64);
const binding = {
  releaseId: digest("1"), sourceRevision: "a".repeat(40), inputs: {
    controlImageDigest: digest("2"), workerImageDigest: digest("3"), packageLockSha256: digest("4"), toolchainSha256: digest("5"),
    migrationSha256: digest("6"), configSha256: digest("7"), policySha256: digest("8"), datasetSha256: digest("9"), goldenSha256: digest("a"), sbomSha256: digest("b"), provenanceSha256: digest("c"),
  },
};
const candidateId = digest("d");
const artifactSha256 = digest("e");

function observation(isolationId: string, runId: string) {
  return {
    version: 1, evidenceClass: "protected_live" as const, status: "passed" as const, candidateId, releaseBinding: binding,
    isolationId, runId, sourceSha256: binding.sourceRevision.padEnd(64, "a"), lockSha256: binding.inputs.packageLockSha256,
    toolchainSha256: binding.inputs.toolchainSha256, datasetSha256: binding.inputs.datasetSha256,
    outputArtifactSha256: artifactSha256, runnerEvidenceSha256: digest(isolationId === "isolation-one" ? "f" : "0"),
    startedAtMs: 1_000, completedAtMs: 1_100,
  };
}

function record(records = [observation("isolation-one", "run-one"), observation("isolation-two", "run-two")]) {
  return { version: 1, evidenceClass: "protected_live" as const, candidateId, releaseBinding: binding, expectedArtifactSha256: artifactSha256, records, assembledAtMs: 1_200 };
}

test("two independent protected builds with exact immutable inputs create one redacted verified record", async () => {
  const verified = await verifyReproducibilityRecord(record(), { nowMs: 1_300, maxAgeMs: 1_000 });
  expect(verified).toMatchObject({ status: "verified", candidateId, expectedArtifactSha256: artifactSha256 });
  expect(verified.evidenceSha256).toMatch(/^[a-f0-9]{64}$/u);
  expect(JSON.stringify(verified)).not.toContain("isolation-one");
  expect(JSON.stringify(verified)).not.toContain("run-one");

  const directory = await mkdtemp(join(tmpdir(), "napplet-cvm-repro-"));
  const written = await writeReproducibilityRecord(directory, record(), { nowMs: 1_300, maxAgeMs: 1_000 });
  expect(JSON.parse(await readFile(join(directory, `${written.evidenceSha256}.json`), "utf8"))).toEqual(written);
  await expect(writeReproducibilityRecord(directory, record(), { nowMs: 1_300, maxAgeMs: 1_000 })).resolves.toEqual(written);
});

test("duplicate, stale, swapped, malformed, deterministic, divergent, changed-input, and expanded records fail closed", async () => {
  const variants: unknown[] = [
    record([observation("isolation-one", "run-one"), observation("isolation-one", "run-two")]),
    record([observation("isolation-one", "run-one"), observation("isolation-two", "run-one")]),
    record([observation("isolation-one", "run-one"), { ...observation("isolation-two", "run-two"), outputArtifactSha256: digest("0") }]),
    record([observation("isolation-one", "run-one"), { ...observation("isolation-two", "run-two"), toolchainSha256: digest("0") }]),
    { ...record(), evidenceClass: "deterministic" },
    { ...record(), expectedArtifactSha256: "not-a-digest" },
    { ...record(), extra: "rejected" },
  ];
  for (const value of variants) await expect(verifyReproducibilityRecord(value, { nowMs: 1_300, maxAgeMs: 1_000 })).rejects.toThrow();
  await expect(verifyReproducibilityRecord(record(), { nowMs: 2_200, maxAgeMs: 1_000 })).rejects.toThrow("REPRODUCIBILITY_RECORD_STALE");
});
