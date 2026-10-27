import { expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { detectCandidate } from "../../src/promotion/candidate";
import { verifyToolchainImageInputs } from "../../scripts/build-toolchain-image";

const candidatePath = "toolchains/candidates/cli-0.5.2-source-build.json";
const policyPath = "infra/toolchain/source-build-egress-policy.json";
const inputs = { candidatePath, policyPath, dockerfilePath: "infra/toolchain/Dockerfile", lockfilePath: "toolchains/locks/initial/pnpm-lock.yaml" };
test("separate source candidate binds both actual builds and does not reuse release provenance", async () => {
  const candidate = await Bun.file(candidatePath).json();
  const detected = await detectCandidate(candidate);
  expect(detected.status).toBe("review_ready");
  expect(detected.blockers).toEqual([]);
  expect((await verifyToolchainImageInputs(inputs)).candidateId).toBe(detected.candidateId);
  const old = await detectCandidate(await Bun.file("toolchains/candidates/cli-0.5.2-release-set.json").json());
  expect(old.candidateId).not.toBe(detected.candidateId);
  expect(old.status).toBe("review_ready");
  expect((await detectCandidate({ ...candidate, cli: { ...candidate.cli, releaseAssetSha256: "a".repeat(64) } })).status).toBe("unverified");
  expect((await detectCandidate({ ...candidate, cli: { ...candidate.cli, sourceBuild: { ...candidate.cli.sourceBuild, executableSha256: { "x86_64-unknown-linux-gnu": "a".repeat(64) } } } })).status).toBe("unverified");
});
test("changed runtime, source, recipe or architecture bytes cannot pass even with a new policy ID", async () => {
  const directory = await mkdtemp(join(tmpdir(), "cvm-source-candidate-"));
  try {
    for (const field of ["runtimeArchiveSha256", "sourceArchiveSha256", "sourceLockSha256", "recipeSha256", "executableSha256"]) {
      const candidate = await Bun.file(candidatePath).json();
      candidate.cli.sourceBuild[field] = field === "executableSha256" ? { ...candidate.cli.sourceBuild.executableSha256, "aarch64-unknown-linux-gnu": "a".repeat(64) } : "a".repeat(64);
      const policy = await Bun.file(policyPath).json(); policy.candidateId = (await detectCandidate(candidate)).candidateId;
      const changedCandidate = join(directory, "candidate.json"), changedPolicy = join(directory, "policy.json");
      await Bun.write(changedCandidate, JSON.stringify(candidate)); await Bun.write(changedPolicy, JSON.stringify(policy));
      await expect(verifyToolchainImageInputs({ ...inputs, candidatePath: changedCandidate, policyPath: changedPolicy })).rejects.toThrow("SOURCEBUILD_CANDIDATE_BINDING_INVALID");
    }
  } finally { await rm(directory, { recursive: true, force: true }); }
});
