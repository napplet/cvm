import { expect, test } from "bun:test";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { join, relative } from "node:path";
import { evaluateReleaseCertification } from "../../src/promotion/run-promotion";
import { verifyReleaseCertificationInput } from "../../src/promotion/candidate";
import { parseReleaseCertificationManifest, RELEASE_CLAIM_INVENTORY } from "../../src/promotion/schema";
import { writeCertificationObservation } from "../../src/certification/evidence";

const fixturePath = "tests/fixtures/phase-07-reference-set.json";

async function run(script: string, args: readonly string[]) {
  const child = Bun.spawn(["bun", script, ...args], { stdout: "pipe", stderr: "pipe", env: { ...process.env, PHASE07_TEST_SECRET: "supersecret", PHASE07_RELEASE_PROFILE_PATH: "", PHASE07_CERTIFICATION_EVIDENCE_DIRECTORY: "/tmp/napplet-cvm-phase07-test-evidence" } });
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
  requirements: RELEASE_CLAIM_INVENTORY.map((item) => ({ ...item, freshnessMs: 60_000 })),
  waivers: [],
});
const observation = (manifest: ReturnType<typeof releaseManifest>, candidateId: string, claim: string, live: boolean, status: "passed" | "blocked" = "passed") => ({
  version: 1 as const, evidenceClass: live ? "protected_live" as const : "deterministic" as const, status, candidate: { id: candidateId, provider: "modal" as const, image: `example/worker@sha256:${digest("3")}`, sourceSha256: digest("e") },
  input: { datasetSha256: digest("9"), profileSha256: digest("f"), topologySha256: digest("0"), command: ["certify"] },
  startedAtMs: 1_000, completedAtMs: 1_001, expiresAtMs: 61_001, claims: status === "passed" ? [claim] : [], limitations: status === "passed" ? [] : ["topology-unavailable"], reasonCode: status === "passed" ? "OBSERVATION_COMPLETE" : "TOPOLOGY_UNAVAILABLE",
  releaseBinding: { releaseId: manifest.releaseId, sourceRevision: manifest.sourceRevision, inputs: manifest.inputs },
});

test("manifest rejects missing exact release inputs and non-waivable safety waivers", () => {
  expect(() => parseReleaseCertificationManifest({ ...releaseManifest(), inputs: { ...releaseManifest().inputs, goldenSha256: "latest" } })).toThrow();
  expect(() => parseReleaseCertificationManifest({ ...releaseManifest(), waivers: [{ class: "user-key-custody", owner: "owner", reason: "no", evidenceSha256: digest("f"), expiresAtMs: 2_000, rollbackTrigger: "rollback", affectedIdentity: digest("1") }] })).toThrow();
});

test("evidence blocks stale, cross-candidate, non-pass, and concurrent release promotion decisions", async () => {
  const manifest = parseReleaseCertificationManifest(releaseManifest());
  const candidateId = digest("f");
  const rawManifest = releaseManifest();
  const valid = await Promise.all(RELEASE_CLAIM_INVENTORY.map((requirement) => writeCertificationObservation("/tmp/napplet-cvm-phase07-gate", observation(rawManifest, candidateId, requirement.claim, requirement.live))));
  const [first, second] = await Promise.all([evaluateReleaseCertification(manifest, valid, { candidateId, nowMs: 2_000 }), evaluateReleaseCertification(manifest, valid, { candidateId, nowMs: 2_000 })]);
  expect(first).toEqual(second);
  expect(first.status).toBe("promoted");
  await expect(evaluateReleaseCertification(manifest, [...valid.slice(0, -1), { ...valid.at(-1)!, candidate: { ...valid.at(-1)!.candidate, id: digest("c") } }], { candidateId, nowMs: 2_000 })).resolves.toMatchObject({ status: "blocked" });
  await expect(evaluateReleaseCertification(manifest, [...valid.slice(0, -1), { ...valid.at(-1)!, expiresAtMs: 1_500 }], { candidateId, nowMs: 2_000 })).resolves.toMatchObject({ status: "blocked" });
});

test("the sole evaluator blocks complete generic claim inventory when protected verification records are absent", async () => {
  const rawManifest = releaseManifest();
  const manifest = parseReleaseCertificationManifest(rawManifest);
  const candidateId = digest("1");
  const observations = await Promise.all(RELEASE_CLAIM_INVENTORY.map((requirement) => writeCertificationObservation(`/tmp/napplet-cvm-phase07-record-gate-${crypto.randomUUID()}`, observation(rawManifest, candidateId, requirement.claim, requirement.live))));
  await expect(evaluateReleaseCertification(manifest, observations, { candidateId, nowMs: 2_000 })).resolves.toMatchObject({ status: "blocked", reason: "RELEASE_VERIFICATION_RECORDS_REQUIRED" });
});

test("release evidence rejects arbitrary claims, deterministic live relabels, and mismatched immutable inputs", async () => {
  expect(() => parseReleaseCertificationManifest({ ...releaseManifest(), requirements: [{ id: "anything", claim: "release.anything", freshnessMs: 60_000, live: true }] })).toThrow("closed required-claim inventory");
  const rawManifest = releaseManifest();
  const manifest = parseReleaseCertificationManifest(rawManifest);
  const candidateId = digest("d");
  const observations = await Promise.all(RELEASE_CLAIM_INVENTORY.map((requirement) => writeCertificationObservation("/tmp/napplet-cvm-phase07-gate", observation(rawManifest, candidateId, requirement.claim, false))));
  await expect(evaluateReleaseCertification(manifest, observations, { candidateId, nowMs: 2_000 })).resolves.toMatchObject({ status: "blocked", reason: "RELEASE_REQUIRED_CLAIM_MISSING_OR_STALE" });
});

test("final candidate verification rejects the deterministic pointer while live certification is blocked", async () => {
  const result = await run("src/promotion/candidate.ts", ["--release-evidence", "evidence/design/phase-07.json"]);
  expect(result.exitCode).not.toBe(0);
  expect(`${result.stdout}${result.stderr}`).toContain("blocked");
  expect(`${result.stdout}${result.stderr}`).not.toContain("supersecret");
});

test("candidate verification reports promoted release evidence as a successful package command", async () => {
  const root = await mkdtemp("tests/.tmp-phase07-release-");
  try {
    const rawManifest = releaseManifest();
    const candidateId = digest("8");
    const now = Date.now();
    const observationDirectory = join(root, "observations");
    const observations = await Promise.all(RELEASE_CLAIM_INVENTORY.map((requirement) => writeCertificationObservation(observationDirectory, {
      ...observation(rawManifest, candidateId, requirement.claim, requirement.live),
      startedAtMs: now - 2_000,
      completedAtMs: now - 1_000,
      expiresAtMs: now + 60_000,
    })));
    const deterministic = await Bun.file("evidence/design/phase-07.json").json() as { contentAddressedPath: string; evidenceSha256: string };
    const releasePath = join(root, "release.json");
    const release = {
      version: 1,
      candidateId,
      releaseManifest: rawManifest,
      deterministicEvidence: { contentAddressedPath: deterministic.contentAddressedPath, evidenceSha256: deterministic.evidenceSha256 },
      protectedObservations: observations.map((entry) => ({
        contentAddressedPath: relative(process.cwd(), join(observationDirectory, `${entry.evidenceSha256}.json`)),
        evidenceSha256: entry.evidenceSha256,
      })),
    };
    await writeFile(releasePath, JSON.stringify(release), "utf8");
    const runCandidateVerify = async () => {
      const child = Bun.spawn(["bun", "run", "candidate:verify", "--", "--release-evidence", relative(process.cwd(), releasePath)], { stdout: "pipe", stderr: "pipe" });
      const [exitCode, stdout, stderr] = await Promise.all([child.exited, new Response(child.stdout).text(), new Response(child.stderr).text()]);
      return { exitCode, stdout, stderr };
    };

    const promoted = await runCandidateVerify();
    expect(promoted.exitCode, `${promoted.stdout}${promoted.stderr}`).toBe(0);
    expect(`${promoted.stdout}${promoted.stderr}`).toContain('"status":"promoted"');

    await writeFile(releasePath, JSON.stringify({ ...release, candidateId: digest("7") }), "utf8");
    const blocked = await runCandidateVerify();
    expect(blocked.exitCode).not.toBe(0);
    expect(`${blocked.stdout}${blocked.stderr}`).toContain('"status":"blocked"');
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("release evidence input uses the sole evaluator for one exact complete candidate-bound bundle", async () => {
  const rawManifest = releaseManifest();
  const candidateId = digest("8");
  const observations = await Promise.all(RELEASE_CLAIM_INVENTORY.map((requirement) => writeCertificationObservation(`/tmp/napplet-cvm-phase07-cli-${crypto.randomUUID()}`, observation(rawManifest, candidateId, requirement.claim, requirement.live))));
  const pointer = await Bun.file("evidence/design/phase-07.json").json() as { contentAddressedPath: string; evidenceSha256: string };
  const deterministic = await Bun.file(pointer.contentAddressedPath).json();
  const observationPointers = observations.map((item) => ({ contentAddressedPath: `evidence/certification/test/${item.evidenceSha256}.json`, evidenceSha256: item.evidenceSha256 }));
  const result = await verifyReleaseCertificationInput({
    version: 1, candidateId, releaseManifest: rawManifest,
    deterministicEvidence: { contentAddressedPath: pointer.contentAddressedPath, evidenceSha256: pointer.evidenceSha256 }, protectedObservations: observationPointers,
  }, { nowMs: 2_000, loadDeterministic: async () => deterministic, loadObservation: async (entry) => observations.find((item) => item.evidenceSha256 === entry.evidenceSha256) });
  expect(result).toMatchObject({ status: "promoted" });
});

test("release evidence input rejects replacement pointers and extra claim ownership before promotion", async () => {
  const rawManifest = releaseManifest(); const candidateId = digest("7");
  const records = await Promise.all(RELEASE_CLAIM_INVENTORY.map((requirement) => writeCertificationObservation(`/tmp/napplet-cvm-phase07-cli-${crypto.randomUUID()}`, observation(rawManifest, candidateId, requirement.claim, requirement.live))));
  const pointer = await Bun.file("evidence/design/phase-07.json").json() as { contentAddressedPath: string; evidenceSha256: string };
  const deterministic = await Bun.file(pointer.contentAddressedPath).json();
  const entries = records.map((record) => ({ contentAddressedPath: `evidence/certification/test/${record.evidenceSha256}.json`, evidenceSha256: record.evidenceSha256 }));
  const result = await verifyReleaseCertificationInput({ version: 1, candidateId, releaseManifest: rawManifest, deterministicEvidence: { contentAddressedPath: pointer.contentAddressedPath, evidenceSha256: pointer.evidenceSha256 }, protectedObservations: entries }, { nowMs: 2_000, loadDeterministic: async () => deterministic, loadObservation: async (entry) => ({ ...records.find((record) => record.evidenceSha256 === entry.evidenceSha256)!, claims: entry.evidenceSha256 === entries[0]!.evidenceSha256 ? ["release.admission_slo", "release.worker"] : records.find((record) => record.evidenceSha256 === entry.evidenceSha256)!.claims }) });
  expect(result).toMatchObject({ status: "blocked", reason: "RELEASE_EVIDENCE_INVALID" });
});
