import { verifyReproducibilityRecord } from "../reproducibility";
import { verifySupplyChainCertification, type SupplyChainDependencies } from "../supply-chain";
import { ProtectedSuiteResultSchema, ReleaseObservationBindingSchema, WorkerCandidateSchema, type ProtectedSuiteResult } from "../contracts";
import type { ReleaseCertificationTrustRoot } from "../trust";

export type LiveSupplyChainObservationPort = Readonly<{
  evidenceClass: "protected_live" | "deterministic";
  runBuild(build: "primary" | "secondary"): Promise<unknown>;
  supplyChainInput(): Promise<unknown>;
  supplyChainDependencies?: SupplyChainDependencies;
}>;

export type LiveSupplyChainCertificationInput = Readonly<{
  candidate: unknown;
  releaseBinding?: unknown;
  expectedArtifactSha256?: string;
  trustRoot?: ReleaseCertificationTrustRoot;
  observationPort?: LiveSupplyChainObservationPort;
  nowMs?: number;
}>;

function nonPass(status: "blocked" | "failed", reasonCode: ProtectedSuiteResult["reasonCode"], limitation: string): ProtectedSuiteResult {
  return ProtectedSuiteResultSchema.parse({ status, claims: [], limitations: [limitation], reasonCode });
}

/**
 * Runs the two-build and independently pinned verifier sequence only when the
 * Plan 07-25 runner injects a protected-live port. Build/source/SBOM/provenance
 * values are consumed by existing strict verifiers and are reduced here to
 * their finite record digests; this adapter never writes protected evidence.
 */
export async function runLiveSupplyChainCertification(input: LiveSupplyChainCertificationInput): Promise<ProtectedSuiteResult> {
  const candidate = WorkerCandidateSchema.safeParse(input.candidate);
  const releaseBinding = ReleaseObservationBindingSchema.safeParse(input.releaseBinding);
  const port = input.observationPort;
  if (!candidate.success || !port || port.evidenceClass !== "protected_live" || !releaseBinding.success || !input.expectedArtifactSha256 || !input.trustRoot) {
    return nonPass("blocked", "INPUT_UNAVAILABLE", "protected-live-supply-chain-required");
  }

  try {
    const [primary, secondary] = await Promise.all([port.runBuild("primary"), port.runBuild("secondary")]);
    const reproducibility = await verifyReproducibilityRecord({
      version: 1,
      evidenceClass: "protected_live",
      candidateId: candidate.data.id,
      releaseBinding: releaseBinding.data,
      expectedArtifactSha256: input.expectedArtifactSha256,
      records: [primary, secondary],
      assembledAtMs: input.nowMs ?? Date.now(),
    }, { nowMs: input.nowMs, trustRoot: input.trustRoot });
    const supplyChain = await verifySupplyChainCertification(await port.supplyChainInput(), port.supplyChainDependencies);
    if (supplyChain.candidateId !== candidate.data.id || supplyChain.artifactSha256 !== reproducibility.expectedArtifactSha256) {
      return nonPass("failed", "EVIDENCE_INVALID", "supply-chain-artifact-binding-invalid");
    }
    return ProtectedSuiteResultSchema.parse({
      status: "passed",
      claims: ["release.reproducible_build", "release.supply_chain"],
      limitations: ["selection-external"],
      reasonCode: "OBSERVATION_COMPLETE",
      verificationDigests: {
        reproducibilityEvidenceSha256: reproducibility.evidenceSha256,
        supplyChainEvidenceSha256: supplyChain.evidenceSha256,
      },
    });
  } catch {
    return nonPass("blocked", "PROVIDER_UNAVAILABLE", "supply-chain-observation-unavailable");
  }
}
