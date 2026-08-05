import { expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { mkdtemp, readFile, rm, symlink, writeFile } from "node:fs/promises";
import { join, relative } from "node:path";
import { evaluateReleaseCertification } from "../../src/promotion/run-promotion";
import { verifyReleaseCertificationInput } from "../../src/promotion/candidate";
import { canonicalJson, parseReleaseCertificationManifest, RELEASE_CLAIM_INVENTORY } from "../../src/promotion/schema";
import { writeCertificationObservation } from "../../src/certification/evidence";
import type { ReleaseCertificationTrustRoot } from "../../src/certification/trust";

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
const sha256Bytes = (value: Uint8Array): string => createHash("sha256").update(value).digest("hex");
async function sha256(value: unknown): Promise<string> {
  const bytes = new TextEncoder().encode(canonicalJson(value));
  const hash = await crypto.subtle.digest("SHA-256", bytes);
  return Array.from(new Uint8Array(hash), (byte) => byte.toString(16).padStart(2, "0")).join("");
}
async function sha256String(value: string): Promise<string> {
  const bytes = new TextEncoder().encode(value);
  const hash = await crypto.subtle.digest("SHA-256", bytes);
  return Array.from(new Uint8Array(hash), (byte) => byte.toString(16).padStart(2, "0")).join("");
}

const permissiveTestTrustRoot: ReleaseCertificationTrustRoot = {
  verifyManifest: async () => true,
  verifyObservation: async () => true,
  verifyReproducibilityRecord: async () => true,
  verifySupplyChainRecord: async () => true,
  verifySourceMeasurement: async () => true,
};

function anchoredTrustRoot(manifest: unknown, observations: readonly unknown[], records: Readonly<{ reproducibility: unknown; supplyChain: unknown }>): ReleaseCertificationTrustRoot {
  const same = (actual: unknown, expected: unknown) => canonicalJson(actual) === canonicalJson(expected);
  return {
    verifyManifest: async (actual) => same(actual, manifest),
    verifyObservation: async (actual) => observations.some((expected) => same(actual, expected)),
    verifyReproducibilityRecord: async (actual) => same(actual, records.reproducibility),
    verifySupplyChainRecord: async (actual) => same(actual, records.supplyChain),
    verifySourceMeasurement: async () => true,
  };
}
const releaseManifest = () => ({
  version: 1,
  sourceRevision: "a".repeat(40),
  sourceSha256: digest("e"),
  supplyChainPolicy: {
    cosign: { executableSha256: digest("0"), signerIdentity: "https://github.com/acme/napplet/.github/workflows/release.yml@refs/heads/main", issuer: "https://token.actions.githubusercontent.com", predicateType: "https://slsa.dev/provenance/v1" },
    sbom: { bomFormat: "CycloneDX", specVersion: "1.5", generator: { vendor: "acme", name: "sealed-toolchain", version: "1" } },
  },
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
  releaseBinding: { releaseId: manifest.releaseId, sourceRevision: manifest.sourceRevision, sourceSha256: manifest.sourceSha256, supplyChainPolicy: manifest.supplyChainPolicy, inputs: manifest.inputs },
});

async function protectedVerificationRecords(manifest: ReturnType<typeof releaseManifest>, candidateId: string, atMs = 1_000) {
  const releaseBindingSha256 = await sha256({ releaseId: manifest.releaseId, sourceRevision: manifest.sourceRevision, sourceSha256: manifest.sourceSha256, supplyChainPolicy: manifest.supplyChainPolicy, inputs: manifest.inputs });
  const reproducibilityBase = {
    version: 1 as const, evidenceClass: "protected_live" as const, status: "verified" as const, candidateId,
    releaseBindingSha256, measuredSourceSha256: manifest.sourceSha256, sourceReferenceSha256: [await sha256String(`git+https://github.com/acme/napplet-cvm@${manifest.sourceRevision}`), await sha256String(`git+https://github.com/acme/napplet-cvm@${manifest.sourceRevision}`)], expectedArtifactSha256: manifest.inputs.workerImageDigest,
    buildEvidenceSha256: [digest("a"), digest("b")], isolationIdentitySha256: [digest("c"), digest("d")], runIdentitySha256: [digest("e"), digest("f")], completedAtMs: atMs,
  };
  const reproducibilityEvidenceSha256 = await sha256(reproducibilityBase);
  const supplyChainBase = {
    version: 1 as const, evidenceClass: "protected_live" as const, status: "verified" as const, candidateId, artifactSha256: manifest.inputs.workerImageDigest,
    releaseBindingSha256, cosignExecutableSha256: manifest.supplyChainPolicy.cosign.executableSha256, cosignCommandSha256: digest("1"), signerIdentitySha256: await sha256String(manifest.supplyChainPolicy.cosign.signerIdentity), issuerSha256: await sha256String(manifest.supplyChainPolicy.cosign.issuer),
    predicateType: "https://slsa.dev/provenance/v1" as const, sbomFormat: manifest.supplyChainPolicy.sbom.bomFormat, sbomSpecVersion: manifest.supplyChainPolicy.sbom.specVersion, sbomGeneratorSha256: await sha256(manifest.supplyChainPolicy.sbom.generator), sbomSha256: manifest.inputs.sbomSha256, provenanceSha256: manifest.inputs.provenanceSha256, reviewedComponentsSha256: digest("4"), verifiedAtMs: atMs,
  };
  const supplyChainEvidenceSha256 = await sha256(supplyChainBase);
  return {
    reproducibility: { ...reproducibilityBase, evidenceSha256: reproducibilityEvidenceSha256, contentAddressedPath: `evidence/certification/reproducibility/${reproducibilityEvidenceSha256}.json` },
    supplyChain: { ...supplyChainBase, evidenceSha256: supplyChainEvidenceSha256, contentAddressedPath: `evidence/certification/supply-chain/${supplyChainEvidenceSha256}.json` },
  };
}

function bindSupplyChainObservation<T extends ReturnType<typeof observation>>(value: T, records: Awaited<ReturnType<typeof protectedVerificationRecords>>): T {
  return value.claims.includes("release.supply_chain") ? { ...value, verificationDigests: { reproducibilityEvidenceSha256: records.reproducibility.evidenceSha256, supplyChainEvidenceSha256: records.supplyChain.evidenceSha256 } } as T : value;
}

test("manifest rejects missing exact release inputs and non-waivable safety waivers", () => {
  expect(() => parseReleaseCertificationManifest({ ...releaseManifest(), inputs: { ...releaseManifest().inputs, goldenSha256: "latest" } })).toThrow();
  expect(() => parseReleaseCertificationManifest({ ...releaseManifest(), waivers: [{ class: "user-key-custody", owner: "owner", reason: "no", evidenceSha256: digest("f"), expiresAtMs: 2_000, rollbackTrigger: "rollback", affectedIdentity: digest("1") }] })).toThrow();
  for (const length of [41, 63]) expect(() => parseReleaseCertificationManifest({ ...releaseManifest(), sourceRevision: "a".repeat(length) })).toThrow("complete SHA-1 or SHA-256 revision pin");
  expect(parseReleaseCertificationManifest({ ...releaseManifest(), sourceRevision: "b".repeat(64) }).sourceRevision).toBe("b".repeat(64));
});

test("evidence blocks stale, cross-candidate, non-pass, and concurrent release promotion decisions", async () => {
  const manifest = parseReleaseCertificationManifest(releaseManifest());
  const candidateId = digest("f");
  const rawManifest = releaseManifest();
  const records = await protectedVerificationRecords(rawManifest, candidateId);
  const valid = await Promise.all(RELEASE_CLAIM_INVENTORY.map((requirement) => writeCertificationObservation("/tmp/napplet-cvm-phase07-gate", bindSupplyChainObservation(observation(rawManifest, candidateId, requirement.claim, requirement.live), records))));
  const [first, second] = await Promise.all([evaluateReleaseCertification(manifest, valid, { candidateId, nowMs: 2_000, verificationRecords: records, trustRoot: permissiveTestTrustRoot }), evaluateReleaseCertification(manifest, valid, { candidateId, nowMs: 2_000, verificationRecords: records, trustRoot: permissiveTestTrustRoot })]);
  expect(first).toEqual(second);
  expect(first.status).toBe("promoted");
  await expect(evaluateReleaseCertification(manifest, [...valid.slice(0, -1), { ...valid.at(-1)!, candidate: { ...valid.at(-1)!.candidate, id: digest("c") } }], { candidateId, nowMs: 2_000, verificationRecords: records, trustRoot: permissiveTestTrustRoot })).resolves.toMatchObject({ status: "blocked" });
  await expect(evaluateReleaseCertification(manifest, [...valid.slice(0, -1), { ...valid.at(-1)!, expiresAtMs: 1_500 }], { candidateId, nowMs: 2_000, verificationRecords: records, trustRoot: permissiveTestTrustRoot })).resolves.toMatchObject({ status: "blocked" });
});

test("the sole evaluator authenticates a changed manifest before consulting a promoted cache entry", async () => {
  const rawManifest = releaseManifest();
  const manifest = parseReleaseCertificationManifest(rawManifest);
  const candidateId = digest("7");
  const records = await protectedVerificationRecords(rawManifest, candidateId);
  const observations = await Promise.all(RELEASE_CLAIM_INVENTORY.map((requirement) => writeCertificationObservation(`/tmp/napplet-cvm-phase07-cache-auth-${crypto.randomUUID()}`, bindSupplyChainObservation(observation(rawManifest, candidateId, requirement.claim, requirement.live), records))));
  let manifestChecks = 0;
  const trustRoot: ReleaseCertificationTrustRoot = {
    ...permissiveTestTrustRoot,
    verifyManifest: async (actual) => {
      manifestChecks += 1;
      return canonicalJson(actual) === canonicalJson(manifest);
    },
  };

  await expect(evaluateReleaseCertification(manifest, observations, { candidateId, nowMs: 2_000, verificationRecords: records, trustRoot })).resolves.toMatchObject({ status: "promoted" });
  const changedManifest = parseReleaseCertificationManifest({ ...rawManifest, requirements: rawManifest.requirements.map((requirement, index) => index === 0 ? { ...requirement, freshnessMs: requirement.freshnessMs + 1 } : requirement) });
  await expect(evaluateReleaseCertification(changedManifest, observations, { candidateId, nowMs: 2_000, verificationRecords: records, trustRoot })).resolves.toMatchObject({ status: "blocked", reason: "RELEASE_CERTIFIER_AUTHORITY_INVALID" });
  expect(manifestChecks).toBe(2);
});

test("the sole evaluator rejects an observation whose candidate source digest differs from the manifest", async () => {
  const rawManifest = releaseManifest();
  const manifest = parseReleaseCertificationManifest(rawManifest);
  const candidateId = digest("2");
  const records = await protectedVerificationRecords(rawManifest, candidateId);
  const observations = await Promise.all(RELEASE_CLAIM_INVENTORY.map((requirement) => writeCertificationObservation(`/tmp/napplet-cvm-phase07-source-${crypto.randomUUID()}`, bindSupplyChainObservation({ ...observation(rawManifest, candidateId, requirement.claim, requirement.live), candidate: { ...observation(rawManifest, candidateId, requirement.claim, requirement.live).candidate, sourceSha256: digest("0") } }, records))));
  await expect(evaluateReleaseCertification(manifest, observations, { candidateId, nowMs: 2_000, verificationRecords: records, trustRoot: permissiveTestTrustRoot })).resolves.toMatchObject({ status: "blocked", reason: "RELEASE_OBSERVATION_BINDING_MISMATCH" });
});

test("the sole evaluator rejects verification records bound to a self-selected manifest signer policy", async () => {
  const trusted = releaseManifest();
  const candidateId = digest("3");
  const records = await protectedVerificationRecords(trusted, candidateId);
  const observations = await Promise.all(RELEASE_CLAIM_INVENTORY.map((requirement) => writeCertificationObservation(`/tmp/napplet-cvm-phase07-policy-${crypto.randomUUID()}`, bindSupplyChainObservation(observation(trusted, candidateId, requirement.claim, requirement.live), records))));
  const substitutedManifest = parseReleaseCertificationManifest({ ...trusted, supplyChainPolicy: { ...trusted.supplyChainPolicy, cosign: { ...trusted.supplyChainPolicy.cosign, signerIdentity: "https://github.com/attacker/release.yml@refs/heads/main" } } });
  await expect(evaluateReleaseCertification(substitutedManifest, observations, { candidateId, nowMs: 2_000, verificationRecords: records, trustRoot: permissiveTestTrustRoot })).resolves.toMatchObject({ status: "blocked", reason: "RELEASE_VERIFICATION_RECORDS_INVALID" });
});

test("the sole evaluator blocks complete generic claim inventory when protected verification records are absent", async () => {
  const rawManifest = releaseManifest();
  const manifest = parseReleaseCertificationManifest(rawManifest);
  const candidateId = digest("1");
  const observations = await Promise.all(RELEASE_CLAIM_INVENTORY.map((requirement) => writeCertificationObservation(`/tmp/napplet-cvm-phase07-record-gate-${crypto.randomUUID()}`, observation(rawManifest, candidateId, requirement.claim, requirement.live))));
  await expect(evaluateReleaseCertification(manifest, observations, { candidateId, nowMs: 2_000 })).resolves.toMatchObject({ status: "blocked", reason: "RELEASE_VERIFICATION_RECORDS_REQUIRED" });
});

test("the sole evaluator rejects deterministic, stale, and swapped protected verification records", async () => {
  const rawManifest = releaseManifest(); const manifest = parseReleaseCertificationManifest(rawManifest);
  const candidateId = digest("5"); const records = await protectedVerificationRecords(rawManifest, candidateId);
  const observations = await Promise.all(RELEASE_CLAIM_INVENTORY.map((requirement) => writeCertificationObservation(`/tmp/napplet-cvm-phase07-record-mutations-${crypto.randomUUID()}`, bindSupplyChainObservation(observation(rawManifest, candidateId, requirement.claim, requirement.live), records))));
  const variants = [
    { reproducibility: { ...records.reproducibility, evidenceClass: "deterministic" }, supplyChain: records.supplyChain },
    { reproducibility: records.reproducibility, supplyChain: { ...records.supplyChain, candidateId: digest("6") } },
  ];
  for (const verificationRecords of variants) await expect(evaluateReleaseCertification(manifest, observations, { candidateId, nowMs: 2_000, verificationRecords, trustRoot: permissiveTestTrustRoot })).resolves.toMatchObject({ status: "blocked" });
  const staleCandidateId = digest("e"); const stale = await protectedVerificationRecords(rawManifest, staleCandidateId, 0);
  const staleObservations = await Promise.all(RELEASE_CLAIM_INVENTORY.map((requirement) => writeCertificationObservation(`/tmp/napplet-cvm-phase07-record-stale-${crypto.randomUUID()}`, bindSupplyChainObservation(observation(rawManifest, staleCandidateId, requirement.claim, requirement.live), stale))));
  await expect(evaluateReleaseCertification(manifest, staleObservations, { candidateId: staleCandidateId, nowMs: 86_400_002, verificationRecords: stale, trustRoot: permissiveTestTrustRoot })).resolves.toMatchObject({ status: "blocked", reason: "RELEASE_VERIFICATION_RECORDS_INVALID" });
  const futureCandidateId = digest("9"); const future = await protectedVerificationRecords(rawManifest, futureCandidateId, 3_000);
  const futureObservations = await Promise.all(RELEASE_CLAIM_INVENTORY.map((requirement) => writeCertificationObservation(`/tmp/napplet-cvm-phase07-record-future-${crypto.randomUUID()}`, bindSupplyChainObservation(observation(rawManifest, futureCandidateId, requirement.claim, requirement.live), future))));
  await expect(evaluateReleaseCertification(manifest, futureObservations, { candidateId: futureCandidateId, nowMs: 2_000, verificationRecords: future, trustRoot: permissiveTestTrustRoot })).resolves.toMatchObject({ status: "blocked", reason: "RELEASE_VERIFICATION_RECORDS_INVALID" });
});

test("release evidence rejects arbitrary claims, deterministic live relabels, and mismatched immutable inputs", async () => {
  expect(() => parseReleaseCertificationManifest({ ...releaseManifest(), requirements: [{ id: "anything", claim: "release.anything", freshnessMs: 60_000, live: true }] })).toThrow("closed required-claim inventory");
  const rawManifest = releaseManifest();
  const manifest = parseReleaseCertificationManifest(rawManifest);
  const candidateId = digest("d");
  const records = await protectedVerificationRecords(rawManifest, candidateId);
  const observations = await Promise.all(RELEASE_CLAIM_INVENTORY.map((requirement) => writeCertificationObservation("/tmp/napplet-cvm-phase07-gate", bindSupplyChainObservation(observation(rawManifest, candidateId, requirement.claim, false), records))));
  await expect(evaluateReleaseCertification(manifest, observations, { candidateId, nowMs: 2_000, verificationRecords: records, trustRoot: permissiveTestTrustRoot })).resolves.toMatchObject({ status: "blocked", reason: "RELEASE_REQUIRED_CLAIM_MISSING_OR_STALE" });
});

test("final candidate verification rejects the deterministic pointer while live certification is blocked", async () => {
  const result = await run("src/promotion/candidate.ts", ["--release-evidence", "evidence/design/phase-07.json"]);
  expect(result.exitCode).not.toBe(0);
  expect(`${result.stdout}${result.stderr}`).toContain("blocked");
  expect(`${result.stdout}${result.stderr}`).not.toContain("supersecret");
});

test("candidate verification blocks a publicly rehashed release bundle without an operator trust root", async () => {
  const root = await mkdtemp("tests/.tmp-phase07-release-");
  try {
    const rawManifest = releaseManifest();
    const candidateId = digest("8");
    const now = Date.now();
    const observationDirectory = join(root, "observations");
    const verification = await protectedVerificationRecords(rawManifest, candidateId, now - 1_000);
    const observations = await Promise.all(RELEASE_CLAIM_INVENTORY.map((requirement) => writeCertificationObservation(observationDirectory, {
      ...bindSupplyChainObservation(observation(rawManifest, candidateId, requirement.claim, requirement.live), verification),
      startedAtMs: now - 2_000,
      completedAtMs: now - 1_000,
      expiresAtMs: now + 60_000,
    })));
    const deterministic = await Bun.file("evidence/design/phase-07.json").json() as { contentAddressedPath: string; evidenceSha256: string };
    const reproducibilityPath = join(root, "reproducibility.json"); const supplyChainPath = join(root, "supply-chain.json");
    await writeFile(reproducibilityPath, JSON.stringify(verification.reproducibility), "utf8"); await writeFile(supplyChainPath, JSON.stringify(verification.supplyChain), "utf8");
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
      verificationRecords: {
        reproducibilityEvidence: { contentAddressedPath: relative(process.cwd(), reproducibilityPath), evidenceSha256: verification.reproducibility.evidenceSha256 },
        supplyChainEvidence: { contentAddressedPath: relative(process.cwd(), supplyChainPath), evidenceSha256: verification.supplyChain.evidenceSha256 },
      },
    };
    await writeFile(releasePath, JSON.stringify(release), "utf8");
    const runCandidateVerify = async () => {
      const child = Bun.spawn(["bun", "run", "candidate:verify", "--", "--release-evidence", relative(process.cwd(), releasePath)], { stdout: "pipe", stderr: "pipe" });
      const [exitCode, stdout, stderr] = await Promise.all([child.exited, new Response(child.stdout).text(), new Response(child.stderr).text()]);
      return { exitCode, stdout, stderr };
    };

    const promoted = await runCandidateVerify();
    expect(promoted.exitCode, `${promoted.stdout}${promoted.stderr}`).not.toBe(0);
    expect(`${promoted.stdout}${promoted.stderr}`).toContain('"status":"blocked"');
    expect(`${promoted.stdout}${promoted.stderr}`).toContain("RELEASE_CERTIFIER_AUTHORITY_REQUIRED");

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
  const verification = await protectedVerificationRecords(rawManifest, candidateId);
  const observations = await Promise.all(RELEASE_CLAIM_INVENTORY.map((requirement) => writeCertificationObservation(`/tmp/napplet-cvm-phase07-cli-${crypto.randomUUID()}`, bindSupplyChainObservation(observation(rawManifest, candidateId, requirement.claim, requirement.live), verification))));
  const pointer = await Bun.file("evidence/design/phase-07.json").json() as { contentAddressedPath: string; evidenceSha256: string };
  const deterministic = await Bun.file(pointer.contentAddressedPath).json();
  const observationPointers = observations.map((item) => ({ contentAddressedPath: `evidence/certification/test/${item.evidenceSha256}.json`, evidenceSha256: item.evidenceSha256 }));
  const releaseInput = {
    version: 1, candidateId, releaseManifest: rawManifest,
    deterministicEvidence: { contentAddressedPath: pointer.contentAddressedPath, evidenceSha256: pointer.evidenceSha256 }, protectedObservations: observationPointers,
    verificationRecords: { reproducibilityEvidence: { contentAddressedPath: "evidence/certification/test/reproducibility.json", evidenceSha256: verification.reproducibility.evidenceSha256 }, supplyChainEvidence: { contentAddressedPath: "evidence/certification/test/supply-chain.json", evidenceSha256: verification.supplyChain.evidenceSha256 } },
  };
  const loaders = { nowMs: 2_000, loadDeterministic: async () => deterministic, loadObservation: async (entry: { evidenceSha256: string }) => observations.find((item) => item.evidenceSha256 === entry.evidenceSha256), loadVerificationRecord: async (entry: { evidenceSha256: string }) => entry.evidenceSha256 === verification.reproducibility.evidenceSha256 ? verification.reproducibility : verification.supplyChain };
  const untrusted = await verifyReleaseCertificationInput(releaseInput, loaders);
  expect(untrusted).toMatchObject({ status: "blocked", reason: "RELEASE_CERTIFIER_AUTHORITY_REQUIRED" });
  const result = await verifyReleaseCertificationInput(releaseInput, { ...loaders, trustRoot: anchoredTrustRoot(parseReleaseCertificationManifest(rawManifest), observations, verification) });
  expect(result).toMatchObject({ status: "promoted" });
});

test("release evidence input rejects replacement pointers and extra claim ownership before promotion", async () => {
  const rawManifest = releaseManifest(); const candidateId = digest("7");
  const verification = await protectedVerificationRecords(rawManifest, candidateId);
  const records = await Promise.all(RELEASE_CLAIM_INVENTORY.map((requirement) => writeCertificationObservation(`/tmp/napplet-cvm-phase07-cli-${crypto.randomUUID()}`, bindSupplyChainObservation(observation(rawManifest, candidateId, requirement.claim, requirement.live), verification))));
  const pointer = await Bun.file("evidence/design/phase-07.json").json() as { contentAddressedPath: string; evidenceSha256: string };
  const deterministic = await Bun.file(pointer.contentAddressedPath).json();
  const entries = records.map((record) => ({ contentAddressedPath: `evidence/certification/test/${record.evidenceSha256}.json`, evidenceSha256: record.evidenceSha256 }));
  const result = await verifyReleaseCertificationInput({ version: 1, candidateId, releaseManifest: rawManifest, deterministicEvidence: { contentAddressedPath: pointer.contentAddressedPath, evidenceSha256: pointer.evidenceSha256 }, protectedObservations: entries, verificationRecords: { reproducibilityEvidence: { contentAddressedPath: "evidence/certification/test/reproducibility.json", evidenceSha256: verification.reproducibility.evidenceSha256 }, supplyChainEvidence: { contentAddressedPath: "evidence/certification/test/supply-chain.json", evidenceSha256: verification.supplyChain.evidenceSha256 } } }, { nowMs: 2_000, loadDeterministic: async () => deterministic, loadObservation: async (entry) => ({ ...records.find((record) => record.evidenceSha256 === entry.evidenceSha256)!, claims: entry.evidenceSha256 === entries[0]!.evidenceSha256 ? ["release.admission_slo", "release.worker"] : records.find((record) => record.evidenceSha256 === entry.evidenceSha256)!.claims }), loadVerificationRecord: async (entry) => entry.evidenceSha256 === verification.reproducibility.evidenceSha256 ? verification.reproducibility : verification.supplyChain, trustRoot: permissiveTestTrustRoot });
  expect(result).toMatchObject({ status: "blocked", reason: "RELEASE_EVIDENCE_INVALID" });
});

test("the protected release command owns a pinned root and rejects a freshly rehashed counterfeit before evaluator authority", async () => {
  const root = await mkdtemp("tests/.tmp-phase07-protected-release-");
  try {
    const operatorRoot = join(process.cwd(), root);
    const rawManifest = releaseManifest();
    const candidateId = digest("b");
    const now = Date.now();
    const verification = await protectedVerificationRecords(rawManifest, candidateId, now - 1_000);
    const observationDirectory = join(root, "observations");
    const observations = await Promise.all(RELEASE_CLAIM_INVENTORY.map((requirement) => writeCertificationObservation(observationDirectory, {
      ...bindSupplyChainObservation(observation(rawManifest, candidateId, requirement.claim, requirement.live), verification),
      startedAtMs: now - 2_000,
      completedAtMs: now - 1_000,
      expiresAtMs: now + 60_000,
    })));
    const deterministic = await Bun.file("evidence/design/phase-07.json").json() as { contentAddressedPath: string; evidenceSha256: string };
    const reproducibilityPath = join(root, "reproducibility.json");
    const supplyChainPath = join(root, "supply-chain.json");
    await writeFile(reproducibilityPath, JSON.stringify(verification.reproducibility));
    await writeFile(supplyChainPath, JSON.stringify(verification.supplyChain));
    const releasePath = join(root, "release.json");
    const release = {
      version: 1,
      candidateId,
      releaseManifest: rawManifest,
      deterministicEvidence: { contentAddressedPath: deterministic.contentAddressedPath, evidenceSha256: deterministic.evidenceSha256 },
      protectedObservations: observations.map((item) => ({ contentAddressedPath: join(observationDirectory, `${item.evidenceSha256}.json`), evidenceSha256: item.evidenceSha256 })),
      verificationRecords: {
        reproducibilityEvidence: { contentAddressedPath: reproducibilityPath, evidenceSha256: verification.reproducibility.evidenceSha256 },
        supplyChainEvidence: { contentAddressedPath: supplyChainPath, evidenceSha256: verification.supplyChain.evidenceSha256 },
      },
    };
    await writeFile(releasePath, JSON.stringify(release));

    const sourcePath = join(root, "source.tar");
    const sourceBytes = new TextEncoder().encode("operator-held immutable source archive");
    await writeFile(sourcePath, sourceBytes);
    const sourceSha256 = sha256Bytes(sourceBytes);
    const sourceReference = `git+https://github.com/acme/napplet-cvm@${rawManifest.sourceRevision}`;
    const rootModulePath = join(root, "operator-root.ts");
    const trustedModule = (expected: unknown) => `import { createPinnedReleaseCertificationTrustRoot } from ${JSON.stringify(join(process.cwd(), "src/certification/trust.ts"))};\nexport const protectedReleaseCertificationTrustRoot = createPinnedReleaseCertificationTrustRoot({ sourceArchiveRoot: ${JSON.stringify(operatorRoot)}, sourceArchives: [{ canonicalSourceReference: ${JSON.stringify(sourceReference)}, relativePath: "source.tar", sourceSha256: ${JSON.stringify(sourceSha256)} }], manifest: ${JSON.stringify(expected)}, observations: ${JSON.stringify(observations)}, reproducibilityRecord: ${JSON.stringify(verification.reproducibility)}, supplyChainRecord: ${JSON.stringify(verification.supplyChain)} });\n`;
    await writeFile(rootModulePath, trustedModule(rawManifest));
    const rootDigest = sha256Bytes(new Uint8Array(await Bun.file(rootModulePath).arrayBuffer()));
    const counterfeitRootPath = join(root, "candidate-permissive-root.ts");
    const counterfeitMarker = join(root, "counterfeit-root-loaded");
    await writeFile(counterfeitRootPath, `await Bun.write(${JSON.stringify(counterfeitMarker)}, "loaded");\nexport const protectedReleaseCertificationTrustRoot = { verifyManifest: async () => true, verifyObservation: async () => true, verifyReproducibilityRecord: async () => true, verifySupplyChainRecord: async () => true, verifySourceMeasurement: async () => true };\n`);

    const runProtected = async (env: Record<string, string | undefined> = {}) => {
      const child = Bun.spawn(["bun", "run", "release:verify:protected", "--", "--release-evidence", releasePath], { stdout: "pipe", stderr: "pipe", env: {
        ...process.env,
        PHASE07_RELEASE_TRUST_ROOT_DIRECTORY: operatorRoot,
        PHASE07_RELEASE_TRUST_ROOT: join(process.cwd(), rootModulePath),
        PHASE07_RELEASE_TRUST_ROOT_SHA256: rootDigest,
        PHASE07_RELEASE_CANDIDATE_TRUST_ROOT: counterfeitRootPath,
        ...env,
      } });
      const [exitCode, stdout, stderr] = await Promise.all([child.exited, new Response(child.stdout).text(), new Response(child.stderr).text()]);
      return { exitCode, stdout, stderr };
    };

    for (const result of [await runProtected(), await runProtected()]) {
      expect(result.exitCode, `${result.stdout}${result.stderr}`).toBe(0);
      expect(`${result.stdout}${result.stderr}`).toContain('"status":"promoted"');
    }
    expect(await Bun.file(counterfeitMarker).exists()).toBe(false);

    const counterfeitManifest = { ...rawManifest, releaseId: digest("c") };
    const counterfeitVerification = await protectedVerificationRecords(counterfeitManifest, candidateId, now - 1_000);
    const counterfeitObservationDirectory = join(root, "counterfeit-observations");
    const counterfeitObservations = await Promise.all(RELEASE_CLAIM_INVENTORY.map((requirement) => writeCertificationObservation(counterfeitObservationDirectory, {
      ...bindSupplyChainObservation(observation(counterfeitManifest, candidateId, requirement.claim, requirement.live), counterfeitVerification),
      startedAtMs: now - 2_000,
      completedAtMs: now - 1_000,
      expiresAtMs: now + 60_000,
    })));
    const counterfeitReproducibilityPath = join(root, "counterfeit-reproducibility.json");
    const counterfeitSupplyChainPath = join(root, "counterfeit-supply-chain.json");
    await writeFile(counterfeitReproducibilityPath, JSON.stringify(counterfeitVerification.reproducibility));
    await writeFile(counterfeitSupplyChainPath, JSON.stringify(counterfeitVerification.supplyChain));
    const counterfeit = {
      ...release,
      releaseManifest: counterfeitManifest,
      protectedObservations: counterfeitObservations.map((item) => ({ contentAddressedPath: join(counterfeitObservationDirectory, `${item.evidenceSha256}.json`), evidenceSha256: item.evidenceSha256 })),
      verificationRecords: {
        reproducibilityEvidence: { contentAddressedPath: counterfeitReproducibilityPath, evidenceSha256: counterfeitVerification.reproducibility.evidenceSha256 },
        supplyChainEvidence: { contentAddressedPath: counterfeitSupplyChainPath, evidenceSha256: counterfeitVerification.supplyChain.evidenceSha256 },
      },
    };
    await writeFile(releasePath, JSON.stringify(counterfeit));
    const rejected = await runProtected();
    expect(rejected.exitCode).not.toBe(0);
    expect(`${rejected.stdout}${rejected.stderr}`).toContain('"status":"blocked"');
    expect(`${rejected.stdout}${rejected.stderr}`).toContain("RELEASE_CERTIFIER_AUTHORITY_REQUIRED");
    expect(`${rejected.stdout}${rejected.stderr}`).not.toContain("protected_live");
    expect(await Bun.file(counterfeitMarker).exists()).toBe(false);

    const missing = await runProtected({ PHASE07_RELEASE_TRUST_ROOT_DIRECTORY: undefined });
    expect(missing.exitCode).not.toBe(0);
    expect(`${missing.stdout}${missing.stderr}`).toContain("protected_configuration_unavailable");
    const malformed = await runProtected({ PHASE07_RELEASE_TRUST_ROOT_SHA256: "not-a-sha256" });
    expect(malformed.exitCode).not.toBe(0);
    const escaped = await runProtected({ PHASE07_RELEASE_TRUST_ROOT: join(operatorRoot, "..", "operator-root.ts") });
    expect(escaped.exitCode).not.toBe(0);
    const nonFile = await runProtected({ PHASE07_RELEASE_TRUST_ROOT: operatorRoot });
    expect(nonFile.exitCode).not.toBe(0);
    const drift = await runProtected({ PHASE07_RELEASE_TRUST_ROOT_SHA256: digest("0") });
    expect(drift.exitCode).not.toBe(0);
    const missingExportPath = join(root, "missing-export.ts");
    await writeFile(missingExportPath, "export const notATrustRoot = {};\n");
    const missingExport = await runProtected({ PHASE07_RELEASE_TRUST_ROOT: join(process.cwd(), missingExportPath), PHASE07_RELEASE_TRUST_ROOT_SHA256: sha256Bytes(new Uint8Array(await Bun.file(missingExportPath).arrayBuffer())) });
    expect(missingExport.exitCode).not.toBe(0);
    const incompletePath = join(root, "incomplete-root.ts");
    await writeFile(incompletePath, "export const protectedReleaseCertificationTrustRoot = { verifyManifest: async () => true };\n");
    const incomplete = await runProtected({ PHASE07_RELEASE_TRUST_ROOT: join(process.cwd(), incompletePath), PHASE07_RELEASE_TRUST_ROOT_SHA256: sha256Bytes(new Uint8Array(await Bun.file(incompletePath).arrayBuffer())) });
    expect(incomplete.exitCode).not.toBe(0);
    const symlinkPath = join(root, "symlink-root.ts");
    await symlink(rootModulePath, symlinkPath);
    const symlinked = await runProtected({ PHASE07_RELEASE_TRUST_ROOT: join(process.cwd(), symlinkPath), PHASE07_RELEASE_TRUST_ROOT_SHA256: rootDigest });
    expect(symlinked.exitCode).not.toBe(0);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
