import { expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { finalizeProtectedTrustRoot, materializeProtectedCertifier } from "../../src/release/materialize-certifier";
import { loadCertifierConfig } from "../../src/certification/config";
import { canonicalJson } from "../../src/promotion/schema";

const sha256 = (value: string | Uint8Array): string => createHash("sha256").update(value).digest("hex");
const digest = (label: string): string => sha256(label);
const revision = "a".repeat(40);

const releaseManifest = () => ({
  version: 1,
  releaseId: digest("release"),
  sourceRevision: revision,
  sourceSha256: digest("source"),
  supplyChainPolicy: {
    cosign: { executableSha256: digest("cosign"), signerIdentity: "issuer:identity", issuer: "https://issuer.example", predicateType: "https://slsa.dev/provenance/v1" },
    sbom: { bomFormat: "CycloneDX", specVersion: "1.5", generator: { vendor: "napplet", name: "generator", version: "1" } },
  },
  inputs: Object.fromEntries(["controlImageDigest", "workerImageDigest", "packageLockSha256", "toolchainSha256", "migrationSha256", "configSha256", "policySha256", "datasetSha256", "goldenSha256", "sbomSha256", "provenanceSha256"].map((key) => [key, digest(key)])),
  requirements: [
    { id: "deterministic-fault-matrix", claim: "release.deterministic_fault_matrix", freshnessMs: 1_000, live: false },
    { id: "telemetry-policy", claim: "release.telemetry_policy", freshnessMs: 1_000, live: false },
    { id: "supply-chain", claim: "release.supply_chain", freshnessMs: 1_000, live: false },
    { id: "admission-slo", claim: "release.admission_slo", freshnessMs: 1_000, live: true },
    { id: "contextvm-relay", claim: "release.contextvm_relay", freshnessMs: 1_000, live: true },
    { id: "cep8-lightning", claim: "release.cep8_lightning", freshnessMs: 1_000, live: true },
    { id: "cashu", claim: "release.cashu", freshnessMs: 1_000, live: true },
    { id: "model-reconciliation", claim: "release.model_reconciliation", freshnessMs: 1_000, live: true },
    { id: "worker", claim: "release.worker", freshnessMs: 1_000, live: true },
    { id: "checkpoint-object", claim: "release.checkpoint_object", freshnessMs: 1_000, live: true },
    { id: "database-failover", claim: "release.database_failover", freshnessMs: 1_000, live: true },
    { id: "control-plane", claim: "release.control_plane", freshnessMs: 1_000, live: true },
    { id: "compatible-host", claim: "release.compatible_host", freshnessMs: 1_000, live: true },
    { id: "owner-signer", claim: "release.owner_signer", freshnessMs: 1_000, live: true },
    { id: "promoted-cli", claim: "release.promoted_cli", freshnessMs: 1_000, live: true },
    { id: "sealed-upload", claim: "release.sealed_upload", freshnessMs: 1_000, live: true },
    { id: "publication-relay", claim: "release.publication_relay", freshnessMs: 1_000, live: true },
  ],
  waivers: [],
});

test("materializes a candidate-bound local config, profile, adapter bundle, secret references, and evidence tree", async () => {
  const root = await mkdtemp(join(tmpdir(), "napplet-cvm-materialize-"));
  try {
    let providerCalls = 0;
    let protectedRunnerCalls = 0;
    const input = {
      workspace: root,
      repositoryRoot: process.cwd(),
      candidateId: digest("candidate"),
      releaseManifest: releaseManifest(),
      topology: { candidateSha256: digest("candidate"), topologySha256: digest("topology"), deployment: { resources: [], limitations: ["DATABASE_CONTINUITY_NOT_CERTIFIED"] } },
      authorization: { authorizationReceiptSha256: digest("receipt"), authorizationRequestSha256: digest("request") },
      source: { sourceRevision: revision, sourceSha256: digest("source") },
      secretReferences: { modal: "secret://modal", "cloud-run": "secret://cloud-run" },
      onProviderCall: () => { providerCalls += 1; },
      onProtectedRunnerCall: () => { protectedRunnerCalls += 1; },
    };
    const first = await materializeProtectedCertifier(input);
    const second = await materializeProtectedCertifier(input);

    expect(first).toEqual(second);
    expect(first.env.NAPPLET_CVM_CERTIFIER_CONFIG).toStartWith(root);
    expect(first.env.NAPPLET_CVM_CERTIFIER_CONFIG_SHA256).toMatch(/^[a-f0-9]{64}$/);
    expect(sha256(await readFile(first.configPath))).toBe(first.configSha256);
    expect(JSON.parse(await readFile(first.configPath, "utf8"))).toMatchObject({ mode: "protected", controller: { candidateId: digest("candidate"), topologySha256: digest("topology") } });
    expect(await readFile(first.secretReferencesPath, "utf8")).toContain("secret://modal");
    expect(await readFile(first.secretReferencesPath, "utf8")).not.toContain("credential-value");
    expect(sha256(await readFile(first.adapter.modulePath))).toBe(first.adapter.sha256);
    await expect(loadCertifierConfig({ env: first.env })).resolves.toMatchObject({ mode: "protected", controller: { candidateId: digest("candidate") } });
    expect(providerCalls).toBe(0);
    expect(protectedRunnerCalls).toBe(0);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("materialization rejects caller authority overrides, stale topology, and generated byte mutation", async () => {
  const root = await mkdtemp(join(tmpdir(), "napplet-cvm-materialize-"));
  try {
    const input = {
      workspace: root, repositoryRoot: process.cwd(), candidateId: digest("candidate"), releaseManifest: releaseManifest(),
      topology: { candidateSha256: digest("candidate"), topologySha256: digest("topology"), deployment: { resources: [], limitations: [] } },
      authorization: { authorizationReceiptSha256: digest("receipt"), authorizationRequestSha256: digest("request") },
      source: { sourceRevision: revision, sourceSha256: digest("source") }, secretReferences: { modal: "secret://modal" },
    };
    await expect(materializeProtectedCertifier({ ...input, configPath: join(root, "operator.json") } as never)).rejects.toThrow("MATERIALIZER_OVERRIDE_REJECTED");
    await expect(materializeProtectedCertifier({ ...input, topology: { ...input.topology, candidateSha256: digest("other") } })).rejects.toThrow("MATERIALIZER_TOPOLOGY_REJECTED");
    const result = await materializeProtectedCertifier(input);
    await writeFile(result.configPath, "{}\n");
    await expect(materializeProtectedCertifier(input)).rejects.toThrow("MATERIALIZER_ARTIFACT_MUTATED");
    const cleanRoot = await mkdtemp(join(tmpdir(), "napplet-cvm-materialize-"));
    const clean = await materializeProtectedCertifier({ ...input, workspace: cleanRoot });
    await writeFile(clean.adapter.modulePath, "tampered adapter bundle\n");
    await expect(materializeProtectedCertifier({ ...input, workspace: cleanRoot })).rejects.toThrow("MATERIALIZER_ARTIFACT_MUTATED");
    await rm(cleanRoot, { recursive: true, force: true });
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("finalizes a project-owned candidate-bound trust root from exact local protected-record fixtures", async () => {
  const root = await mkdtemp(join(tmpdir(), "napplet-cvm-finalize-"));
  try {
    const manifest = releaseManifest();
    const candidateId = digest("candidate");
    const sourceArchivePath = join(root, "source.tar");
    await writeFile(sourceArchivePath, "source");
    const materialized = await materializeProtectedCertifier({
      workspace: root, repositoryRoot: process.cwd(), candidateId, releaseManifest: manifest,
      topology: { candidateSha256: candidateId, topologySha256: digest("topology") },
      authorization: { authorizationReceiptSha256: digest("receipt"), authorizationRequestSha256: digest("request") },
      source: { sourceRevision: revision, sourceSha256: digest("source") }, secretReferences: { modal: "secret://modal" },
    });
    const bindingSha256 = sha256(canonicalJson(manifest));
    const observation = { version: 1, evidenceClass: "protected_live", status: "passed", candidateId, releaseBinding: manifest, evidenceSha256: digest("observation") };
    const verification = { version: 1, evidenceClass: "protected_live", status: "verified", candidateId, releaseBindingSha256: bindingSha256, evidenceSha256: digest("verification") };
    const final = await finalizeProtectedTrustRoot({ materialized, workspace: root, repositoryRoot: process.cwd(), candidateId, releaseManifest: manifest, topologySha256: digest("topology"), authorizationReceiptSha256: digest("receipt"), sourceArchive: { root, relativePath: "source.tar", canonicalSourceReference: "git:napplet-cvm", sourceRevision: revision, sourceSha256: digest("source") }, observations: [observation], reproducibilityRecord: verification, supplyChainRecord: verification });
    expect(await readFile(final.trustRoot.modulePath, "utf8")).not.toContain("source.tar");
    expect(final.env.NAPPLET_CVM_CERTIFIER_CONFIG_SHA256).toMatch(/^[a-f0-9]{64}$/);
    await expect(loadCertifierConfig({ env: final.env })).resolves.toMatchObject({ trustRoot: final.trustRoot, controller: { candidateId } });
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("trust finalization rejects non-pass, cross-candidate, substituted, and changed-source fixture records without runner calls", async () => {
  const root = await mkdtemp(join(tmpdir(), "napplet-cvm-finalize-"));
  try {
    const manifest = releaseManifest(); const candidateId = digest("candidate");
    await writeFile(join(root, "source.tar"), "source");
    const materialized = await materializeProtectedCertifier({ workspace: root, repositoryRoot: process.cwd(), candidateId, releaseManifest: manifest, topology: { candidateSha256: candidateId, topologySha256: digest("topology") }, authorization: { authorizationReceiptSha256: digest("receipt"), authorizationRequestSha256: digest("request") }, source: { sourceRevision: revision, sourceSha256: digest("source") }, secretReferences: { modal: "secret://modal" } });
    const common = { materialized, workspace: root, repositoryRoot: process.cwd(), candidateId, releaseManifest: manifest, topologySha256: digest("topology"), authorizationReceiptSha256: digest("receipt"), sourceArchive: { root, relativePath: "source.tar", canonicalSourceReference: "git:napplet-cvm", sourceRevision: revision, sourceSha256: digest("source") }, reproducibilityRecord: { version: 1, evidenceClass: "protected_live", status: "verified", candidateId, releaseBindingSha256: sha256(canonicalJson(manifest)), evidenceSha256: digest("repro") }, supplyChainRecord: { version: 1, evidenceClass: "protected_live", status: "verified", candidateId, releaseBindingSha256: sha256(canonicalJson(manifest)), evidenceSha256: digest("supply") } };
    await expect(finalizeProtectedTrustRoot({ ...common, observations: [{ version: 1, evidenceClass: "protected_live", status: "blocked", candidateId, releaseBinding: manifest, evidenceSha256: digest("observation") }] })).rejects.toThrow("MATERIALIZER_TRUST_EVIDENCE_REJECTED");
    await expect(finalizeProtectedTrustRoot({ ...common, observations: [{ version: 1, evidenceClass: "protected_live", status: "passed", candidateId: digest("other"), releaseBinding: manifest, evidenceSha256: digest("observation") }] })).rejects.toThrow("MATERIALIZER_TRUST_EVIDENCE_REJECTED");
    await writeFile(join(root, "source.tar"), "substituted");
    await expect(finalizeProtectedTrustRoot({ ...common, observations: [{ version: 1, evidenceClass: "protected_live", status: "passed", candidateId, releaseBinding: manifest, evidenceSha256: digest("observation") }] })).rejects.toThrow("MATERIALIZER_SOURCE_ARCHIVE_REJECTED");
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
