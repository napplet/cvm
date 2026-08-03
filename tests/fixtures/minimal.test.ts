import { describe, expect, test } from "bun:test";
import { FIXTURES, runFixture } from "../../src/fixtures/registry";

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
          stdout: JSON.stringify({ fixture: "minimal", status: "passed", stages: fixture.stages, evidence: {} }),
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
