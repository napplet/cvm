import { expect, test } from "bun:test";
import { readFile } from "node:fs/promises";
import { evaluateReleaseCertification } from "../../src/promotion/run-promotion";
import { parseReleaseCertificationManifest } from "../../src/promotion/schema";
import { writeCertificationObservation } from "../../src/certification/evidence";

const fixturePath = "tests/fixtures/phase-07-reference-set.json";

async function run(script: string, args: readonly string[]) {
  const child = Bun.spawn(["bun", script, ...args], { stdout: "pipe", stderr: "pipe", env: { ...process.env, PHASE07_TEST_SECRET: "supersecret" } });
  const [exitCode, stdout, stderr] = await Promise.all([child.exited, new Response(child.stdout).text(), new Response(child.stderr).text()]);
  return { exitCode, stdout, stderr };
}

test("07-W0-05 corpus binds promotion coverage and keeps protected live work non-passing", async () => {
  const registry = JSON.parse(await readFile(fixturePath, "utf8"));
  expect(registry.cases.filter((entry: { category: string }) => entry.category === "launch")).toHaveLength(10);
  expect(registry.cases.filter((entry: { requirements: string[] }) => entry.requirements.includes("OPS-04")).length).toBeGreaterThan(0);
  expect(registry.liveObservations.every((entry: { status: string }) => entry.status === "blocked" || entry.status === "not_observed")).toBe(true);
});

test("blocked protected preflight emits not_observed-safe records without a release pass or secret echo", async () => {
  const deterministic = await run("scripts/eval-phase-07.ts", ["--suite=all"]);
  const existingEvidence = await run("scripts/verify-phase-07-evidence.ts", ["--verify-existing"]);
  const protectedPreflight = await run("scripts/certify-phase-07.ts", ["--profile=release", "--preflight-only"]);
  for (const result of [deterministic, existingEvidence]) {
    expect(result.exitCode).toBe(0);
    expect(`${result.stdout}${result.stderr}`).toMatch(/promotionVerdict.*blocked|"blocked"/u);
    expect(`${result.stdout}${result.stderr}`).not.toContain("supersecret");
  }
  expect(protectedPreflight.exitCode).not.toBe(0);
  expect(`${protectedPreflight.stdout}${protectedPreflight.stderr}`).toMatch(/blocked|not_observed|not_implemented/u);
  expect(`${protectedPreflight.stdout}${protectedPreflight.stderr}`).not.toContain("supersecret");
});


const digest = (value: string) => value.repeat(64).slice(0, 64);
const releaseManifest = () => ({
  version: 1,
  sourceRevision: "a".repeat(40),
  releaseId: digest("1"),
  inputs: {
    controlImageDigest: digest("2"), workerImageDigest: digest("3"), packageLockSha256: digest("4"), toolchainSha256: digest("5"),
    migrationSha256: digest("6"), configSha256: digest("7"), policySha256: digest("8"), datasetSha256: digest("9"),
    goldenSha256: digest("a"), sbomSha256: digest("b"), provenanceSha256: digest("c"),
  },
  requirements: [
    { id: "deterministic", claim: "release.deterministic", freshnessMs: 60_000, live: false },
    { id: "live", claim: "release.live", freshnessMs: 60_000, live: true },
  ],
  waivers: [],
});
const observation = (candidateId: string, claim: string, status: "passed" | "blocked" = "passed") => ({
  version: 1 as const, status, candidate: { id: candidateId, provider: "modal" as const, image: `example/worker@sha256:${"d".repeat(64)}`, sourceSha256: digest("e") },
  input: { datasetSha256: digest("9"), profileSha256: digest("f"), topologySha256: digest("0"), command: ["certify"] },
  startedAtMs: 1_000, completedAtMs: 1_001, expiresAtMs: 61_001, claims: status === "passed" ? [claim] : [], limitations: status === "passed" ? [] : ["topology-unavailable"], reasonCode: status === "passed" ? "OBSERVATION_COMPLETE" : "TOPOLOGY_UNAVAILABLE",
});

test("manifest rejects missing exact release inputs and non-waivable safety waivers", () => {
  expect(() => parseReleaseCertificationManifest({ ...releaseManifest(), inputs: { ...releaseManifest().inputs, goldenSha256: "latest" } })).toThrow();
  expect(() => parseReleaseCertificationManifest({ ...releaseManifest(), waivers: [{ class: "user-key-custody", owner: "owner", reason: "no", evidenceSha256: digest("f"), expiresAtMs: 2_000, rollbackTrigger: "rollback", affectedIdentity: digest("1") }] })).toThrow();
});

test("evidence blocks stale, cross-candidate, non-pass, and concurrent release promotion decisions", async () => {
  const manifest = parseReleaseCertificationManifest(releaseManifest());
  const candidateId = digest("d");
  const valid = await Promise.all(["release.deterministic", "release.live"].map((claim) => writeCertificationObservation("/tmp/napplet-cvm-phase07-gate", observation(candidateId, claim))));
  const [first, second] = await Promise.all([evaluateReleaseCertification(manifest, valid, { candidateId, nowMs: 2_000 }), evaluateReleaseCertification(manifest, valid, { candidateId, nowMs: 2_000 })]);
  expect(first).toEqual(second);
  expect(first.status).toBe("promoted");
  await expect(evaluateReleaseCertification(manifest, [valid[0]!, { ...valid[1]!, candidate: { ...valid[1]!.candidate, id: digest("c") } }], { candidateId, nowMs: 2_000 })).resolves.toMatchObject({ status: "blocked" });
  await expect(evaluateReleaseCertification(manifest, [valid[0]!, { ...valid[1]!, expiresAtMs: 1_500 }], { candidateId, nowMs: 2_000 })).resolves.toMatchObject({ status: "blocked" });
});
