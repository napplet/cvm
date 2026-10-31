import { expect, test } from "bun:test";
import { createProductionCoreSuiteAdapters } from "../../src/release/deployment/production-core-suite-adapters";
import { CoreControlPayloadSchemas, CoreScheduledSampleSchema, CoreFreshInstanceSchema, CoreRestoreChunkSchema, CORE_RESTORE_CHUNK_BYTES } from "../../src/release/deployment/production-core-suite-protocol";
import { createWorkerBenchmarkSchedule } from "../../src/admission/benchmark";
import { IDENTICAL_WORKER_COHORT_PROFILE } from "../../src/certification/live/worker-ports";
import { D122_FAULT_MATRIX, DURABILITY_SUBJECT_KINDS } from "../../src/resilience/fault-harness";
import { runLiveRestoreCertification, type LiveRestorePort } from "../../src/certification/live/restore";
import { assertMountedFreshWorkspaceSubject } from "../../src/production/mounted-fresh-restore-runtime";

const hash = "a".repeat(64);
const candidate = { id: hash, provider: "modal" as const, image: `registry/worker@sha256:${hash}`, sourceSha256: hash };
test("core suites cannot turn caller callbacks into real observations", () => {
  let calls = 0;
  const counterfeit = { async execute() { calls++; return { state: "completed", result: {} }; } };
  expect(() => createProductionCoreSuiteAdapters({ candidate, control: counterfeit as never, contextvm: { async generate() { calls++; } } as never })).toThrow("PRODUCTION_CORE_CONTROL_CLIENT_REQUIRED");
  expect(calls).toBe(0);
});

test("private cohort and fault controls accept only the locked schedules", () => {
  const schedule = createWorkerBenchmarkSchedule(IDENTICAL_WORKER_COHORT_PROFILE);
  expect(schedule).toHaveLength(1000);
  expect(schedule.slice(0, 200).every(item => item.cohort === "pool_hit")).toBe(true);
  expect(schedule.slice(200, 400).every(item => ["pool_miss", "cold", "contention"].includes(item.cohort))).toBe(true);
  for (const item of schedule) expect(CoreScheduledSampleSchema.safeParse({ id: item.id, cohort: item.cohort }).success).toBe(true);
  for (const invalid of [{ id: "benchmark-1001", cohort: "pool_hit" }, { id: "benchmark-1", cohort: "pool_miss" }, { id: "benchmark-1", cohort: "pool_hit", accepted: true }]) expect(CoreScheduledSampleSchema.safeParse(invalid).success).toBe(false);
  for (const schedule of D122_FAULT_MATRIX) expect(CoreControlPayloadSchemas["fault.inject"].safeParse({ schedule }).success).toBe(true);
  expect(CoreControlPayloadSchemas["fault.inject"].safeParse({ schedule: { ...D122_FAULT_MATRIX[0], replacement: true } }).success).toBe(false);
});

test("restore protocol rejects same-instance restore and unbounded chunk requests", () => {
  expect(CoreFreshInstanceSchema.safeParse({ freshInstanceId: "source", sourceInstanceId: "source", databaseInstanceId: "new-sql", applicationInstanceId: "new-app", restoredBackupSha256: hash }).success).toBe(false);
  expect(CoreFreshInstanceSchema.safeParse({ freshInstanceId: "new", sourceInstanceId: "source", databaseInstanceId: "source", applicationInstanceId: "new-app", restoredBackupSha256: hash }).success).toBe(false);
  expect(CoreRestoreChunkSchema.safeParse({ freshInstanceId: "new", sourceIdentity: "subject", offset: 0, totalBytes: 1, bytesBase64: "A".repeat(CORE_RESTORE_CHUNK_BYTES * 2) }).success).toBe(false);
});

test("mounted fresh recovery never coerces non-workspace subjects into checkpoint restores", () => {
  for (const kind of DURABILITY_SUBJECT_KINDS) {
    const subject = { kind, sourceIdentity: `${kind}:original`, object: { key: `retained/${kind}`, generation: 1, checksum: hash }, payloadSha256: hash, ownerId: "owner", retentionUntil: "2030-01-01T00:00:00.000Z", deletionState: "retained" as const };
    if (kind === "checkpoint") expect(() => assertMountedFreshWorkspaceSubject(subject)).not.toThrow();
    else expect(() => assertMountedFreshWorkspaceSubject(subject)).toThrow("MOUNTED_FRESH_RESTORE_SUBJECT_AUTHORITY_REQUIRED");
  }
});

test("restore cleans the fresh instance after a failed subject and blocks unconfirmed cleanup", async () => {
  for (const cleanupFails of [false, true]) {
    let cleanups = 0;
    const port: LiveRestorePort = {
      // Test-only runner contract fixture; never exported as release evidence.
      evidenceClass: "protected_live",
      async inventory() { return DURABILITY_SUBJECT_KINDS.map(kind => ({ kind, sourceIdentity: kind, object: { key: kind, generation: 1, checksum: hash }, payloadSha256: hash, ownerId: "owner", retentionUntil: "2030-01-01T00:00:00.000Z", deletionState: "retained" })); },
      async loseLocalState() { return { status: "lost" }; },
      async createFreshInstance() { return {
        async restoreSubject() { throw new Error("CORRUPT_OR_MISSING_SUBJECT"); },
        async exerciseExpiryDeletion() { throw new Error("UNREACHED"); },
        async observeTopology() { throw new Error("UNREACHED"); },
        async cleanup() { cleanups++; if (cleanupFails) throw new Error("DELETE_OUTCOME_UNKNOWN"); },
      }; },
    };
    const result = await runLiveRestoreCertification({ candidate, topology: {}, restorePort: port });
    expect(result.status).toBe("blocked");
    expect(result.claims).toEqual([]);
    expect(cleanups).toBe(1);
    expect(result.limitations).toEqual([cleanupFails ? "restore-cleanup-unconfirmed" : "restore-observation-unavailable"]);
  }
});
