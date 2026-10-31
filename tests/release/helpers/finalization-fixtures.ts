// Local protocol fixtures only. These bytes are never live certification evidence.
import { createHash } from "node:crypto";
import { canonicalJson, RELEASE_CLAIM_INVENTORY } from "../../../src/promotion/schema";
import { writeFile } from "node:fs/promises";
import { join } from "node:path";
import { writeCertificationObservation } from "../../../src/certification/evidence";
import { CertificationObservationInputSchema } from "../../../src/certification/contracts";
import { PROTECTED_SUITES } from "../../../src/certification/runner";
import { materializeProtectedCertifier } from "../../../src/release/materialize-certifier";
const digest = (value: string) => value.repeat(64).slice(0, 64);
const sha256 = async (value: unknown) => createHash("sha256").update(canonicalJson(value)).digest("hex");
const sha256String = async (value: string) => createHash("sha256").update(value).digest("hex");
export const releaseManifest = () => ({
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
export const observation = (manifest: ReturnType<typeof releaseManifest>, candidateId: string, claim: string, live: boolean, status: "passed" | "blocked" = "passed", atMs = 1_000) => ({
  version: 1 as const, evidenceClass: live ? "protected_live" as const : "deterministic" as const, status, candidate: { id: candidateId, provider: "modal" as const, image: `example/worker@sha256:${digest("3")}`, sourceSha256: manifest.sourceSha256 },
  input: { datasetSha256: digest("9"), profileSha256: digest("f"), topologySha256: digest("0"), command: ["certify"] },
  startedAtMs: atMs, completedAtMs: atMs + 1, expiresAtMs: atMs + 60_001, claims: status === "passed" ? [claim] : [], limitations: status === "passed" ? [] : ["topology-unavailable"], reasonCode: status === "passed" ? "OBSERVATION_COMPLETE" as const : "TOPOLOGY_UNAVAILABLE" as const,
  releaseBinding: { releaseId: manifest.releaseId, sourceRevision: manifest.sourceRevision, sourceSha256: manifest.sourceSha256, supplyChainPolicy: manifest.supplyChainPolicy, inputs: manifest.inputs },
});

export async function protectedVerificationRecords(manifest: ReturnType<typeof releaseManifest>, candidateId: string, atMs = 1_000) {
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

export function bindSupplyChainObservation<T extends ReturnType<typeof observation>>(value: T, records: Awaited<ReturnType<typeof protectedVerificationRecords>>): T {
  return value.claims.includes("release.supply_chain") ? { ...value, verificationDigests: { reproducibilityEvidenceSha256: records.reproducibility.evidenceSha256, supplyChainEvidenceSha256: records.supplyChain.evidenceSha256 } } as T : value;
}

export async function finalizationFixture(root: string, nowMs = 2_000) {
  const manifest = releaseManifest();
  manifest.sourceSha256 = await sha256String("source");
  const candidateId = await sha256String(root);
  const topologySha256 = digest("0");
  const authorizationReceiptSha256 = digest("d");
  await writeFile(join(root, "source.tar"), "source");
  const materialized = await materializeProtectedCertifier({
    workspace: root, repositoryRoot: process.cwd(), candidateId, releaseManifest: manifest,
    topology: { candidateSha256: candidateId, topologySha256 },
    authorization: { authorizationReceiptSha256, authorizationRequestSha256: digest("c") },
    source: { sourceRevision: manifest.sourceRevision, sourceSha256: manifest.sourceSha256 }, secretReferences: {},
  });
  const verificationRecords = await protectedVerificationRecords(manifest, candidateId, nowMs);
  const claims = [
    ["release.deterministic_fault_matrix", "release.admission_slo", "release.worker"], ["release.telemetry_policy"],
    ["release.database_failover", "release.control_plane"], ["release.checkpoint_object"], ["release.compatible_host", "release.owner_signer"],
    ["release.supply_chain", "release.promoted_cli"], ["release.contextvm_relay", "release.cep8_lightning", "release.cashu", "release.model_reconciliation"], ["release.sealed_upload", "release.publication_relay"],
  ];
  const observations = await Promise.all(PROTECTED_SUITES.map((suite, index) => {
    const base = observation(manifest, candidateId, claims[index]![0]!, true, "passed", nowMs);
    return writeCertificationObservation(join(root, "fixture-observations"), CertificationObservationInputSchema.parse(bindSupplyChainObservation({
      ...base, claims: claims[index]!, input: { ...base.input, command: ["certify-phase-07", `suite:${suite}`] },
    }, verificationRecords)));
  }));
  const trust = { materialized, workspace: root, repositoryRoot: process.cwd(), candidateId, topologySha256, authorizationReceiptSha256,
    releaseManifest: manifest, observations, reproducibilityRecord: verificationRecords.reproducibility, supplyChainRecord: verificationRecords.supplyChain,
    sourceArchive: { root, relativePath: "source.tar", canonicalSourceReference: `git+https://github.com/acme/napplet-cvm@${manifest.sourceRevision}`, sourceRevision: manifest.sourceRevision, sourceSha256: manifest.sourceSha256 }, nowMs };
  return { trust, manifest, candidateId, topologySha256, authorizationReceiptSha256, verificationRecords, observations };
}

