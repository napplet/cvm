import { describe, expect, test } from "bun:test";
import { join } from "node:path";
import {
  parseToolchainImagePolicy,
  verifyToolchainImageInputs,
} from "../../scripts/build-toolchain-image";
import {
  parseSealedToolchainPolicy,
  runSealedDenialProbes,
  runSealedToolchain,
} from "../../src/runner/sealed-toolchain";

const root = process.cwd();
const candidatePath = join(root, "toolchains/candidates/cli-0.5.2-release-set.json");
const policyPath = join(root, "infra/toolchain/egress-policy.json");
const dockerfilePath = join(root, "infra/toolchain/Dockerfile");
const lockfilePath = join(root, "toolchains/locks/initial/pnpm-lock.yaml");
const approvedCandidateId = "a19fc7d283a4482c53728f4a931743576564fb3826d7f8fa1383d02578b69024";

describe("sealed toolchain image and policy", () => {
  test("image inputs bind the reviewed candidate to a frozen offline lock", async () => {
    const result = await verifyToolchainImageInputs({ candidatePath, policyPath, dockerfilePath, lockfilePath });

    expect(result.candidateId).toBe("a19fc7d283a4482c53728f4a931743576564fb3826d7f8fa1383d02578b69024");
    expect(result.lockfileSha256).toMatch(/^[a-f0-9]{64}$/);
    expect(result.packages).toEqual(expect.arrayContaining([
      expect.objectContaining({ name: "@napplet/skills", version: "0.3.2" }),
      expect.objectContaining({ name: "@napplet/boilerplate", version: "0.3.2" }),
      expect.objectContaining({ name: "@napplet/conformance-cli", version: "0.2.18" }),
    ]));
    expect(result.dockerfile).toContain("pnpm fetch --frozen-lockfile --ignore-scripts");
    expect(result.dockerfile).toContain("COPY --from=intake /toolchain/node_modules /toolchain/node_modules");
    expect(result.dockerfile).toContain("/toolchain/bin/napplet-conformance");
    expect(result.dockerfile).toContain("AS cli-source");
    expect(result.dockerfile).toContain("--cached-only");
    expect(result.dockerfile).toContain("54a3c5ac963b1eebe3a178a90f112f86bc3ed2914cde1632a60e89b4f2b5c524");
    expect(result.dockerfile).toContain("3573e8cda272806df011ab856357f5165a6719bb1daed8080227ee1083a112d3");
    expect(result.dockerfile).not.toContain("releases/download/%40napplet/cli%400.5.2/napplet-linux-");
    expect(result.dockerfile).not.toMatch(/\bnpx\b/);
  });

  test("policy rejects missing, relaxed, or unknown image isolation controls", async () => {
    const policy = parseToolchainImagePolicy(await Bun.file(policyPath).json());

    expect(policy.runtime).toBe("docker");
    expect(policy.network).toBe("none");
    expect(policy.readOnlyRootFilesystem).toBeTrue();
    expect(policy.capDrop).toEqual(["ALL"]);
    expect(policy.securityOpt).toEqual(["no-new-privileges"]);
    expect(policy.user).toBe("65532:65532");
    expect(policy.environment).toEqual({ CI: "1", HOME: "/home/napplet" });
    expect(() => parseToolchainImagePolicy({ ...policy, network: "bridge" })).toThrow("network");
    expect(() => parseToolchainImagePolicy({ ...policy, unexpected: true })).toThrow("unknown");
  });

  test("rejects the quarantined mixed release set and stale candidate identity", async () => {
    await expect(verifyToolchainImageInputs({
      candidatePath: join(root, "toolchains/candidates/cli-0.5.2.json"),
      policyPath,
      dockerfilePath,
      lockfilePath,
    })).rejects.toThrow("candidate is not approved");

    await expect(verifyToolchainImageInputs({
      candidatePath: join(root, "toolchains/candidates/initial.json"),
      policyPath,
      dockerfilePath,
      lockfilePath,
    })).rejects.toThrow("policy candidate ID");
  });
});

describe("runSealedToolchain", () => {
  test("constructs one literal default-deny Docker argv with no caller security override", async () => {
    let captured: Record<string, unknown> | undefined;
    const result = await runSealedToolchain({
      id: "native",
      policyPath,
      imageDigest: "a".repeat(64),
      inputDirectory: root,
      script: "/toolchain/bin/napplet-conformance",
      args: ["--json", "$(must stay literal)"],
      toolchainId: approvedCandidateId,
      execute: async (command) => {
        captured = command as unknown as Record<string, unknown>;
        return {
          id: command.id, argv: [command.executable, ...command.argv], cwd: command.cwd, cwdSha256: "b".repeat(64), toolchainId: command.toolchainId, imageDigest: command.imageDigest,
          startedAtMs: 1, finishedAtMs: 2, exitCode: 0, stdout: "{}", stderr: "", stdoutSha256: "c".repeat(64), stderrSha256: "d".repeat(64), disposition: "passed", evidenceSha256: "e".repeat(64),
        };
      },
    });

    expect(result.disposition).toBe("passed");
    expect(captured?.argv).toEqual(expect.arrayContaining([
      "run", "--rm", "--pull=never", "--network=none", "--read-only", "--cap-drop=ALL", "--security-opt=no-new-privileges", "--user=65532:65532",
      "--pids-limit=64", "--memory=2g", "--cpus=2", "--entrypoint=/toolchain/bin/bun", `napplet-cvm/toolchain@sha256:${"a".repeat(64)}`, "/toolchain/bin/napplet-conformance", "$(must stay literal)",
    ]));
    await expect(runSealedToolchain({ id: "bad", policyPath, imageDigest: "not-a-digest", inputDirectory: root, script: "/toolchain/bin/napplet-conformance", args: [], toolchainId: approvedCandidateId })).rejects.toThrow("image digest");

    await expect(runSealedToolchain({
      id: "candidate-mismatch",
      policyPath,
      imageDigest: "a".repeat(64),
      inputDirectory: root,
      script: "/toolchain/bin/napplet-conformance",
      args: [],
      toolchainId: "b".repeat(64),
      execute: async () => { throw new Error("must not execute"); },
    })).rejects.toThrow("candidate ID does not match");
  });

  test("fails closed when a policy control is relaxed or a denial probe succeeds", async () => {
    const policy = await Bun.file(policyPath).json();
    expect(parseSealedToolchainPolicy(policy).network).toBe("none");
    expect(() => parseSealedToolchainPolicy({ ...policy, capDrop: [] })).toThrow("capDrop");
    await expect(runSealedDenialProbes({
      policyPath,
      imageDigest: "a".repeat(64),
      inputDirectory: root,
      toolchainId: approvedCandidateId,
      execute: async (command) => ({
        id: command.id, argv: [command.executable, ...command.argv], cwd: command.cwd, cwdSha256: "b".repeat(64), toolchainId: command.toolchainId, imageDigest: command.imageDigest,
        startedAtMs: 1, finishedAtMs: 2, exitCode: 0, stdout: "connected", stderr: "", stdoutSha256: "c".repeat(64), stderrSha256: "d".repeat(64), disposition: "passed", evidenceSha256: "e".repeat(64),
      }),
    })).rejects.toThrow("denial probe dns");
    await expect(runSealedDenialProbes({
      policyPath,
      imageDigest: "a".repeat(64),
      inputDirectory: root,
      toolchainId: approvedCandidateId,
      execute: async (command) => ({
        id: command.id, argv: [command.executable, ...command.argv], cwd: command.cwd, cwdSha256: "b".repeat(64), toolchainId: command.toolchainId, imageDigest: command.imageDigest,
        startedAtMs: 1, finishedAtMs: 2, exitCode: 1, stdout: "", stderr: "missing probe evidence", stdoutSha256: "c".repeat(64), stderrSha256: "d".repeat(64), disposition: "non-zero-exit", evidenceSha256: "e".repeat(64),
      }),
    })).rejects.toThrow("denial probe dns");
  });
});
