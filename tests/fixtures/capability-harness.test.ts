import { describe, expect, test } from "bun:test";
import { FIXTURES, runFixture } from "../../src/fixtures/registry";

const digest = (value: string) => value.repeat(64).slice(0, 64);
const candidateId = "a19fc7d283a4482c53728f4a931743576564fb3826d7f8fa1383d02578b69024";

function runnerOutput(mode: "primary" | "degraded-no-intent") {
  return {
    fixture: "capability-harness",
    mode,
    status: "passed",
    candidateId,
    imageDigest: "a".repeat(64),
    stages: FIXTURES["capability-harness"].stages.map((id) => ({
      id,
      argv: ["/toolchain/bin/napplet", id],
      exitCode: 0,
      stdoutSha256: digest("b"),
      stderrSha256: digest("c"),
      nativeOutputSha256: digest("d"),
    })),
    installedSkillsSha256: digest("e"),
    distSha256: digest("f"),
    aggregateHash: digest("1"),
    observedDomains: mode === "primary" ? ["storage", "intent"] : ["storage"],
    optionalIntentPresenceRead: true,
    intentUsedThroughSdk: mode === "primary",
    gracefulDegradation: mode === "degraded-no-intent",
  };
}

describe("capability harness", () => {
  test("declares storage as its only hard capability and records SDK-only optional intent use", async () => {
    expect(FIXTURES["capability-harness"].requires).toEqual(["storage"]);
    expect(FIXTURES["capability-harness"].optionalDomains).toEqual(["intent"]);

    const primary = await runFixture("capability-harness", {
      imageDigest: "a".repeat(64),
      mode: "primary",
      runSealed: async (request) => ({
        id: request.id, argv: ["docker", ...request.args], cwd: request.inputDirectory,
        cwdSha256: "b".repeat(64), toolchainId: request.toolchainId, imageDigest: request.imageDigest,
        startedAtMs: 1, finishedAtMs: 2, exitCode: 0, stdout: JSON.stringify(runnerOutput("primary")), stderr: "",
        stdoutSha256: "c".repeat(64), stderrSha256: "d".repeat(64), disposition: "passed", evidenceSha256: "e".repeat(64),
      }),
    });

    expect(primary.observedDomains).toEqual(["storage", "intent"]);
    expect(primary.optionalIntentPresenceRead).toBe(true);
    expect(primary.intentUsedThroughSdk).toBe(true);
  });

  test("keeps the storage-backed path when optional intent is absent", async () => {
    const degraded = await runFixture("capability-harness", {
      imageDigest: "a".repeat(64),
      mode: "degraded-no-intent",
      runSealed: async (request) => ({
        id: request.id, argv: ["docker", ...request.args], cwd: request.inputDirectory,
        cwdSha256: "b".repeat(64), toolchainId: request.toolchainId, imageDigest: request.imageDigest,
        startedAtMs: 1, finishedAtMs: 2, exitCode: 0, stdout: JSON.stringify(runnerOutput("degraded-no-intent")), stderr: "",
        stdoutSha256: "c".repeat(64), stderrSha256: "d".repeat(64), disposition: "passed", evidenceSha256: "e".repeat(64),
      }),
    });

    expect(degraded.observedDomains).toEqual(["storage"]);
    expect(degraded.intentUsedThroughSdk).toBe(false);
    expect(degraded.gracefulDegradation).toBe(true);
  });
});
