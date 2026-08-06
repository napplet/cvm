import { expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { verifyReproducibilityRecord, writeReproducibilityRecord } from "../../src/certification/reproducibility";
import { loadPinnedReleaseCertificationTrustRoot, type ReleaseCertificationTrustRoot } from "../../src/certification/trust";

const digest = (value: string) => value.repeat(64).slice(0, 64);
const binding = {
  releaseId: digest("1"), sourceRevision: "a".repeat(40), sourceSha256: digest("e"), supplyChainPolicy: { cosign: { executableSha256: digest("0"), signerIdentity: "https://github.com/acme/napplet/.github/workflows/release.yml@refs/heads/main", issuer: "https://token.actions.githubusercontent.com", predicateType: "https://slsa.dev/provenance/v1" }, sbom: { bomFormat: "CycloneDX", specVersion: "1.5", generator: { vendor: "acme", name: "sealed-toolchain", version: "1" } } }, inputs: {
    controlImageDigest: digest("2"), workerImageDigest: digest("3"), packageLockSha256: digest("4"), toolchainSha256: digest("5"),
    migrationSha256: digest("6"), configSha256: digest("7"), policySha256: digest("8"), datasetSha256: digest("9"), goldenSha256: digest("a"), sbomSha256: digest("b"), provenanceSha256: digest("c"),
  },
};
const candidateId = digest("d");
const artifactSha256 = digest("e");

const sha256Bytes = (value: Uint8Array): string => createHash("sha256").update(value).digest("hex");

async function runReproducibilityCli(env: Record<string, string | undefined>) {
  const child = Bun.spawn(["bun", "scripts/verify-phase-07-reproducibility.ts"], { stdout: "pipe", stderr: "pipe", env: { ...process.env, ...env } });
  const [exitCode, stdout, stderr] = await Promise.all([child.exited, new Response(child.stdout).text(), new Response(child.stderr).text()]);
  return { exitCode, stdout, stderr };
}

function observation(isolationId: string, runId: string) {
  return {
    version: 1, evidenceClass: "protected_live" as const, status: "passed" as const, candidateId, releaseBinding: binding,
    isolationId, runId, sourceMeasurement: { canonicalSourceReference: `git+https://github.com/acme/napplet-cvm@${binding.sourceRevision}`, sourceSha256: binding.sourceSha256 }, lockSha256: binding.inputs.packageLockSha256,
    toolchainSha256: binding.inputs.toolchainSha256, datasetSha256: binding.inputs.datasetSha256,
    outputArtifactSha256: artifactSha256, runnerEvidenceSha256: digest(isolationId === "isolation-one" ? "f" : "0"),
    startedAtMs: 1_000, completedAtMs: 1_100,
  };
}

function sourceTrustRoot(expectedBinding = binding): ReleaseCertificationTrustRoot {
  return {
    verifyManifest: async () => true,
    verifyObservation: async () => true,
    verifyReproducibilityRecord: async () => true,
    verifySupplyChainRecord: async () => true,
    verifySourceMeasurement: async (measurement) => JSON.stringify(measurement) === JSON.stringify({ canonicalSourceReference: `git+https://github.com/acme/napplet-cvm@${expectedBinding.sourceRevision}`, sourceSha256: expectedBinding.sourceSha256 }),
  };
}

const protectedOptions = { nowMs: 1_300, maxAgeMs: 1_000, trustRoot: sourceTrustRoot() };

function record(records = [observation("isolation-one", "run-one"), observation("isolation-two", "run-two")]) {
  return { version: 1, evidenceClass: "protected_live" as const, candidateId, releaseBinding: binding, expectedArtifactSha256: artifactSha256, records, assembledAtMs: 1_200 };
}

test("two independent protected builds with exact immutable inputs create one redacted verified record", async () => {
  const verified = await verifyReproducibilityRecord(record(), protectedOptions);
  expect(verified).toMatchObject({ status: "verified", candidateId, expectedArtifactSha256: artifactSha256 });
  expect(verified.evidenceSha256).toMatch(/^[a-f0-9]{64}$/u);
  expect(JSON.stringify(verified)).not.toContain("isolation-one");
  expect(JSON.stringify(verified)).not.toContain("run-one");

  const directory = await mkdtemp(join(tmpdir(), "napplet-cvm-repro-"));
  const written = await writeReproducibilityRecord(directory, record(), protectedOptions);
  expect(JSON.parse(await readFile(join(directory, `${written.evidenceSha256}.json`), "utf8"))).toEqual(written);
  await expect(writeReproducibilityRecord(directory, record(), protectedOptions)).resolves.toEqual(written);
});

test("duplicate, stale, swapped, malformed, deterministic, divergent, changed-input, and expanded records fail closed", async () => {
  const variants: unknown[] = [
    record([observation("isolation-one", "run-one"), observation("isolation-one", "run-two")]),
    record([observation("isolation-one", "run-one"), observation("isolation-two", "run-one")]),
    record([observation("isolation-one", "run-one"), { ...observation("isolation-two", "run-two"), outputArtifactSha256: digest("0") }]),
    record([observation("isolation-one", "run-one"), { ...observation("isolation-two", "run-two"), toolchainSha256: digest("0") }]),
    { ...record(), evidenceClass: "deterministic" },
    { ...record(), expectedArtifactSha256: "not-a-digest" },
    { ...record(), extra: "rejected" },
  ];
  for (const value of variants) await expect(verifyReproducibilityRecord(value, protectedOptions)).rejects.toThrow();
  await expect(verifyReproducibilityRecord(record(), { ...protectedOptions, nowMs: 2_200 })).rejects.toThrow("REPRODUCIBILITY_RECORD_STALE");
  await expect(verifyReproducibilityRecord(record(), { ...protectedOptions, nowMs: 1_050 })).rejects.toThrow("REPRODUCIBILITY_RECORD_FROM_FUTURE");
});

test("source revision and source bytes are independent exact release inputs", async () => {
  const exactButUnrelatedDigest = digest("b");
  const exactBinding = { ...binding, sourceSha256: exactButUnrelatedDigest };
  const exactRecords = [
    { ...observation("isolation-one", "run-one"), releaseBinding: exactBinding, sourceMeasurement: { canonicalSourceReference: `git+https://github.com/acme/napplet-cvm@${exactBinding.sourceRevision}`, sourceSha256: exactButUnrelatedDigest } },
    { ...observation("isolation-two", "run-two"), releaseBinding: exactBinding, sourceMeasurement: { canonicalSourceReference: `git+https://github.com/acme/napplet-cvm@${exactBinding.sourceRevision}`, sourceSha256: exactButUnrelatedDigest } },
  ];
  const exactOptions = { nowMs: 1_300, maxAgeMs: 1_000, trustRoot: sourceTrustRoot(exactBinding) };
  await expect(verifyReproducibilityRecord({ ...record(exactRecords), releaseBinding: exactBinding }, exactOptions)).resolves.toMatchObject({ status: "verified", measuredSourceSha256: exactButUnrelatedDigest });

  const prefixDerived = `${exactBinding.sourceRevision}${"0".repeat(24)}`;
  const paddedRevisionRecords = exactRecords.map((entry) => ({ ...entry, sourceMeasurement: { ...entry.sourceMeasurement, sourceSha256: prefixDerived } }));
  await expect(verifyReproducibilityRecord({ ...record(paddedRevisionRecords), releaseBinding: exactBinding }, exactOptions)).rejects.toThrow("REPRODUCIBILITY_SOURCE_MEASUREMENT_UNTRUSTED");
  await expect(verifyReproducibilityRecord({ ...record(exactRecords), releaseBinding: { ...exactBinding, sourceSha256: undefined } }, exactOptions)).rejects.toThrow();
  await expect(verifyReproducibilityRecord({ ...record(exactRecords), releaseBinding: exactBinding }, { nowMs: 1_300, maxAgeMs: 1_000 })).rejects.toThrow("REPRODUCIBILITY_SOURCE_MEASUREMENT_UNTRUSTED");
});

test("the reproducibility command requires a digest-pinned protected trust root and verifies measured source bytes", async () => {
  const root = await mkdtemp(join(tmpdir(), "napplet-cvm-repro-cli-"));
  try {
    const sourceBytes = new TextEncoder().encode("protected immutable source archive");
    const sourceSha256 = sha256Bytes(sourceBytes);
    const sourcePath = join(root, "source.tar");
    const inputPath = join(root, "input.json");
    const outputDirectory = join(root, "evidence");
    const sourceReference = `git+https://github.com/acme/napplet-cvm@${binding.sourceRevision}`;
    const releaseBinding = { ...binding, sourceSha256 };
    const completedAtMs = Date.now() - 100;
    const input = {
      ...record([
        { ...observation("isolation-one", "run-one"), releaseBinding, sourceMeasurement: { canonicalSourceReference: sourceReference, sourceSha256 }, startedAtMs: completedAtMs - 100, completedAtMs },
        { ...observation("isolation-two", "run-two"), releaseBinding, sourceMeasurement: { canonicalSourceReference: sourceReference, sourceSha256 }, startedAtMs: completedAtMs - 100, completedAtMs },
      ]),
      releaseBinding,
      assembledAtMs: completedAtMs,
    };
    await writeFile(sourcePath, sourceBytes);
    await writeFile(inputPath, JSON.stringify(input));

    const unconfigured = await runReproducibilityCli({ NAPPLET_CVM_CERTIFIER_CONFIG: "", NAPPLET_CVM_CERTIFIER_CONFIG_SHA256: "" });
    expect(unconfigured.exitCode).not.toBe(0);
    expect(`${unconfigured.stdout}${unconfigured.stderr}`).toContain("protected_configuration_unavailable");

    const modulePath = join(root, "trust-root.ts");
    await writeFile(modulePath, `import { createPinnedReleaseCertificationTrustRoot } from ${JSON.stringify(join(process.cwd(), "src/certification/trust.ts"))};\nexport const protectedReproducibilityTrustRoot = createPinnedReleaseCertificationTrustRoot({ sourceArchiveRoot: ${JSON.stringify(root)}, sourceArchives: [{ canonicalSourceReference: ${JSON.stringify(sourceReference)}, relativePath: "source.tar", sourceSha256: ${JSON.stringify(sourceSha256)} }] });\n`);
    const moduleSha256 = sha256Bytes(await Bun.file(modulePath).arrayBuffer().then((value) => new Uint8Array(value)));
    const trustRoot = await loadPinnedReleaseCertificationTrustRoot({ root, modulePath, sha256: moduleSha256 });
    expect(await trustRoot.verifySourceMeasurement(input.records[0]!.sourceMeasurement)).toBe(true);
    await writeFile(sourcePath, "changed source archive");
    expect(await trustRoot.verifySourceMeasurement(input.records[0]!.sourceMeasurement)).toBe(false);
    await writeFile(sourcePath, sourceBytes);
    const configPath = join(root, "certifier.json");
    await writeFile(configPath, JSON.stringify({
      version: 1, mode: "protected", releaseProfilePath: inputPath, evidenceDirectory: outputDirectory, credentials: "unavailable",
      adapter: { root, modulePath, sha256: moduleSha256 },
      trustRoot: { root, modulePath, sha256: moduleSha256 },
      reproducibility: { buildRecordsPath: inputPath, evidenceDirectory: outputDirectory },
    }));
    const configSha256 = sha256Bytes(new Uint8Array(await Bun.file(configPath).arrayBuffer()));
    const configured = await runReproducibilityCli({ NAPPLET_CVM_CERTIFIER_CONFIG: configPath, NAPPLET_CVM_CERTIFIER_CONFIG_SHA256: configSha256 });
    expect(configured.exitCode, `${configured.stdout}${configured.stderr}`).toBe(0);
    expect(`${configured.stdout}${configured.stderr}`).toContain('"status":"verified"');
    const output = JSON.parse(configured.stdout) as { evidenceSha256: string };
    expect(await Bun.file(join(outputDirectory, `${output.evidenceSha256}.json`)).exists()).toBe(true);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
