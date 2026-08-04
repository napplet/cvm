import { describe, expect, test } from "bun:test";
import { FIXTURES, runFixture } from "../../src/fixtures/registry";

const digest = (value: string) => value.repeat(64).slice(0, 64);

function runnerOutput(stages: readonly string[], status: "passed" | "blocked" = "passed") {
  return {
    fixture: "minimal",
    mode: "primary",
    status,
    candidateId: "a19fc7d283a4482c53728f4a931743576564fb3826d7f8fa1383d02578b69024",
    imageDigest: "a".repeat(64),
    stages: stages.map((id) => ({ id, argv: ["/toolchain/bin/napplet", id], exitCode: 0, stdoutSha256: digest("b"), stderrSha256: digest("c"), nativeOutputSha256: digest("d") })),
    installedSkillsSha256: digest("e"),
    distSha256: digest("f"),
    aggregateHash: digest("1"),
    observedDomains: [],
    optionalIntentPresenceRead: false,
    intentUsedThroughSdk: false,
    gracefulDegradation: false,
  };
}

describe("minimal fixture", () => {
  test("uses the exact promoted public creation plan without publication", async () => {
    const fixture = FIXTURES.minimal;

    expect(fixture.purpose).toBe("A single focused napplet with no required capabilities.");
    expect(fixture.requires).toEqual([]);
    expect(fixture.stages).toEqual([
      "create",
      "init",
      "skills",
      "overlay",
      "install",
      "build",
      "verify",
      "conformance",
      "dry-run",
    ]);
    expect(fixture.publish).toBe("dry-run-only");

    const calls: string[] = [];
    const result = await runFixture("minimal", {
      imageDigest: "a".repeat(64),
      runSealed: async (request) => {
        calls.push(request.script);
        return {
          id: request.id,
          argv: ["docker", ...request.args],
          cwd: request.inputDirectory,
          cwdSha256: "b".repeat(64),
          toolchainId: request.toolchainId,
          imageDigest: request.imageDigest,
          startedAtMs: 1,
          finishedAtMs: 2,
          exitCode: 0,
          stdout: JSON.stringify(runnerOutput(fixture.stages)),
          stderr: "",
          stdoutSha256: "c".repeat(64),
          stderrSha256: "d".repeat(64),
          disposition: "passed",
          evidenceSha256: "e".repeat(64),
        };
      },
    });

    expect(calls).toEqual(["/toolchain/bin/fixture-runner"]);
    expect(result.status).toBe("passed");
    expect(result.stages.map((stage) => stage.id)).toEqual(fixture.stages);
  });

  test("rejects a runner report without the native init evidence", async () => {
    await expect(runFixture("minimal", {
      imageDigest: "a".repeat(64),
      runSealed: async (request) => ({
        id: request.id,
        argv: ["docker", ...request.args],
        cwd: request.inputDirectory,
        cwdSha256: "b".repeat(64),
        toolchainId: request.toolchainId,
        imageDigest: request.imageDigest,
        startedAtMs: 1,
        finishedAtMs: 2,
        exitCode: 0,
        stdout: JSON.stringify(runnerOutput(FIXTURES.minimal.stages.filter((stage) => stage !== "init"))),
        stderr: "",
        stdoutSha256: "c".repeat(64),
        stderrSha256: "d".repeat(64),
        disposition: "passed",
        evidenceSha256: "e".repeat(64),
      }),
    })).rejects.toThrow("exact sealed stage plan");
  });

  test("retains a blocked native result without claiming a conformant artifact", async () => {
    const result = await runFixture("minimal", {
      imageDigest: "a".repeat(64),
      runSealed: async (request) => ({
        id: request.id,
        argv: ["docker", ...request.args],
        cwd: request.inputDirectory,
        cwdSha256: "b".repeat(64),
        toolchainId: request.toolchainId,
        imageDigest: request.imageDigest,
        startedAtMs: 1,
        finishedAtMs: 2,
        exitCode: 0,
        stdout: JSON.stringify({ ...runnerOutput([], "blocked"), reason: "offline template unavailable" }),
        stderr: "",
        stdoutSha256: "c".repeat(64),
        stderrSha256: "d".repeat(64),
        disposition: "passed",
        evidenceSha256: "e".repeat(64),
      }),
    });

    expect(result.status).toBe("blocked");
    expect(result.stages).toEqual([]);
    expect(result.reason).toBe("offline template unavailable");
  });

  test("retains the final failed native stage as structured blocked evidence", async () => {
    const output = runnerOutput(["create"], "blocked");
    output.stages[0]!.exitCode = 1;
    output.reason = "create exited 1";
    const result = await runFixture("minimal", {
      imageDigest: "a".repeat(64),
      runSealed: async (request) => ({
        id: request.id, argv: ["docker", ...request.args], cwd: request.inputDirectory,
        cwdSha256: "b".repeat(64), toolchainId: request.toolchainId, imageDigest: request.imageDigest,
        startedAtMs: 1, finishedAtMs: 2, exitCode: 0, stdout: JSON.stringify(output), stderr: "",
        stdoutSha256: "c".repeat(64), stderrSha256: "d".repeat(64), disposition: "passed", evidenceSha256: "e".repeat(64),
      }),
    });

    expect(result.status).toBe("blocked");
    expect(result.stages).toEqual([expect.objectContaining({ id: "create", exitCode: 1 })]);
    expect(result.reason).toBe("create exited 1");
  });

  test.each([
    ["missing", ["create", "init", "skills", "overlay", "install", "build", "verify", "conformance"]],
    ["empty", []],
    ["duplicated", ["create", "init", "skills", "overlay", "install", "build", "verify", "conformance", "dry-run", "dry-run"]],
    ["reordered", ["init", "create", "skills", "overlay", "install", "build", "verify", "conformance", "dry-run"]],
  ])("rejects a %s stage plan", async (_name, stages) => {
    await expect(runFixture("minimal", {
      imageDigest: "a".repeat(64),
      definition: { ...FIXTURES.minimal, stages },
    })).rejects.toThrow("exact sealed stage plan");
  });
});
