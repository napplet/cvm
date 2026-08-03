import { describe, expect, test } from "bun:test";
import { join } from "node:path";
import {
  parseToolchainImagePolicy,
  verifyToolchainImageInputs,
} from "../../scripts/build-toolchain-image";

const root = process.cwd();
const candidatePath = join(root, "toolchains/candidates/initial.json");
const policyPath = join(root, "infra/toolchain/egress-policy.json");
const dockerfilePath = join(root, "infra/toolchain/Dockerfile");
const lockfilePath = join(root, "toolchains/locks/initial/pnpm-lock.yaml");

describe("sealed toolchain image and policy", () => {
  test("image inputs bind the reviewed candidate to a frozen offline lock", async () => {
    const result = await verifyToolchainImageInputs({ candidatePath, policyPath, dockerfilePath, lockfilePath });

    expect(result.candidateId).toBe("2dbf448be962e289c962fd5b3659bf526232ded9de163c485925618cead1f23e");
    expect(result.lockfileSha256).toMatch(/^[a-f0-9]{64}$/);
    expect(result.packages).toEqual(expect.arrayContaining([
      expect.objectContaining({ name: "@napplet/skills", version: "0.3.1" }),
      expect.objectContaining({ name: "@napplet/conformance-cli", version: "0.2.18" }),
    ]));
    expect(result.dockerfile).toContain("--offline");
    expect(result.dockerfile).toContain("/toolchain/bin/napplet-conformance");
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
});
