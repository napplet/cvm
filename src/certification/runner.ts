import { type CertificationObservation, type CertificationObservationInput, type ProtectedSuite, type ReleaseObservationBindingSchema } from "./contracts";
import { loadProtectedVerificationRecords, parseProtectedSuiteResult, type ProtectedCertificationAdapterRegistry, type ProtectedVerificationReferences } from "./adapters";
import { writeCertificationObservation } from "./evidence";
import { validateReproducibilityVerificationRecord } from "./reproducibility";
import { validateSupplyChainVerificationRecord } from "./supply-chain";

export const PROTECTED_SUITES = ["admission", "telemetry", "chaos", "restore", "security-host", "supply-chain", "contextvm-payment-model", "publication"] as const satisfies readonly ProtectedSuite[];

function assertExactProtectedRegistry(registry: ProtectedCertificationAdapterRegistry | undefined): void {
  if (!registry) return;
  const keys = Object.keys(registry.adapters).sort();
  const expected = [...PROTECTED_SUITES].sort();
  if (registry.evidenceClass !== "protected_live" || keys.length !== expected.length || keys.some((key, index) => key !== expected[index]) || keys.some((key) => typeof registry.adapters[key as ProtectedSuite] !== "function")) {
    throw new Error("CERTIFICATION_PROTECTED_REGISTRY_EXACT_SET_REQUIRED");
  }
}

const suiteClaims: Readonly<Record<ProtectedSuite, readonly string[]>> = {
  admission: ["release.deterministic_fault_matrix", "release.admission_slo", "release.worker"], telemetry: ["release.telemetry_policy"],
  chaos: ["release.database_failover", "release.control_plane"], restore: ["release.checkpoint_object"], "security-host": ["release.compatible_host", "release.owner_signer"],
  "supply-chain": ["release.supply_chain", "release.promoted_cli"], "contextvm-payment-model": ["release.contextvm_relay", "release.cep8_lightning", "release.cashu", "release.model_reconciliation"], publication: ["release.sealed_upload", "release.publication_relay"],
};

export type ProtectedCertificationProfile = Readonly<{
  candidate: CertificationObservationInput["candidate"];
  datasetSha256: string;
  topologySha256: string;
  profileSha256: string;
  releaseBinding?: import("zod").infer<typeof ReleaseObservationBindingSchema>;
  protectedVerificationReferences?: ProtectedVerificationReferences;
  credentialsAvailable?: boolean;
}>;
export type ProtectedCertificationRun = Readonly<{ records: readonly CertificationObservation[]; status: "passed" | "blocked" | "failed" }>;

function finiteFailure(profile: ProtectedCertificationProfile, suite: ProtectedSuite, status: "blocked" | "failed", reasonCode: CertificationObservationInput["reasonCode"], now: number): CertificationObservationInput {
  return { version: 1, evidenceClass: profile.releaseBinding ? "protected_live" : "deterministic", status, candidate: profile.candidate,
    input: { datasetSha256: profile.datasetSha256, profileSha256: profile.profileSha256, topologySha256: profile.topologySha256, command: ["certify-phase-07", `suite:${suite}`] },
    startedAtMs: now, completedAtMs: now, expiresAtMs: now + 60_000, claims: [], limitations: [`suite-${suite}`, "protected-live-required"], reasonCode,
    ...(profile.releaseBinding ? { releaseBinding: profile.releaseBinding } : {}),
  };
}

type VerificationDigests = Readonly<{ reproducibilityEvidenceSha256: string; supplyChainEvidenceSha256: string }>;

async function verifiedSupplyChainDigests(profile: ProtectedCertificationProfile, now: number): Promise<VerificationDigests> {
  if (!profile.releaseBinding || !profile.protectedVerificationReferences) throw new Error("CERTIFICATION_RECORDS_UNAVAILABLE");
  const records = await loadProtectedVerificationRecords(profile.protectedVerificationReferences);
  const artifactSha256 = profile.candidate.image.slice(-64).toLowerCase();
  const reproducibility = await validateReproducibilityVerificationRecord(records.reproducibility, { candidateId: profile.candidate.id, releaseBinding: profile.releaseBinding, artifactSha256, nowMs: now });
  const supplyChain = await validateSupplyChainVerificationRecord(records.supplyChain, { candidateId: profile.candidate.id, releaseBinding: profile.releaseBinding, artifactSha256, nowMs: now });
  return { reproducibilityEvidenceSha256: reproducibility.evidenceSha256, supplyChainEvidenceSha256: supplyChain.evidenceSha256 };
}
/** Runs each requested suite independently. The registry controls evidence
 * class, never adapter output, so fixtures can validate contracts without
 * becoming live-release passes. */
export async function runProtectedCertificationSuite(input: Readonly<{ profile: ProtectedCertificationProfile; suite: ProtectedSuite; evidenceDirectory: string; registry?: ProtectedCertificationAdapterRegistry; preflightOnly?: boolean; now?: () => number }>): Promise<CertificationObservation> {
  const now = input.now?.() ?? Date.now();
  const { profile, suite } = input;
  if (input.preflightOnly) return writeCertificationObservation(input.evidenceDirectory, finiteFailure(profile, suite, "blocked", "INPUT_UNAVAILABLE", now));
  if (!input.registry || !input.registry.adapters[suite]) return writeCertificationObservation(input.evidenceDirectory, finiteFailure(profile, suite, "blocked", "INPUT_UNAVAILABLE", now));
  if (profile.credentialsAvailable === false) return writeCertificationObservation(input.evidenceDirectory, finiteFailure(profile, suite, "blocked", "CREDENTIALS_UNAVAILABLE", now));
  if (input.registry.evidenceClass === "protected_live" && !profile.releaseBinding) return writeCertificationObservation(input.evidenceDirectory, finiteFailure(profile, suite, "blocked", "TOPOLOGY_UNAVAILABLE", now));
  if (input.registry.evidenceClass === "protected_live" && profile.releaseBinding && profile.candidate.sourceSha256 !== profile.releaseBinding.sourceSha256) return writeCertificationObservation(input.evidenceDirectory, finiteFailure(profile, suite, "failed", "EVIDENCE_INVALID", now));
  try {
    const verificationDigests = suite === "supply-chain" && input.registry.evidenceClass === "protected_live" ? await verifiedSupplyChainDigests(profile, now) : undefined;
    const result = parseProtectedSuiteResult(await input.registry.adapters[suite]!({ suite, candidate: profile.candidate, input: { datasetSha256: profile.datasetSha256, profileSha256: profile.profileSha256, topologySha256: profile.topologySha256, command: ["certify-phase-07", `suite:${suite}`] }, releaseBinding: profile.releaseBinding, credentialReference: profile.credentialsAvailable === false ? "unavailable" : "configured", ...(verificationDigests ? { verificationDigests } : {}) }));
    if (result.status === "passed" && result.claims.some((claim) => !suiteClaims[suite].includes(claim))) throw new Error("CERTIFICATION_ADAPTER_RESULT_INVALID");
    if (verificationDigests && (result.status !== "passed" || JSON.stringify(result.verificationDigests) !== JSON.stringify(verificationDigests))) throw new Error("CERTIFICATION_ADAPTER_RECORD_BINDING_INVALID");
    const observation: CertificationObservationInput = { version: 1, evidenceClass: input.registry.evidenceClass, status: result.status, candidate: profile.candidate, input: { datasetSha256: profile.datasetSha256, profileSha256: profile.profileSha256, topologySha256: profile.topologySha256, command: ["certify-phase-07", `suite:${suite}`] }, startedAtMs: now, completedAtMs: now, expiresAtMs: now + 60_000, claims: result.claims, limitations: result.limitations, reasonCode: result.reasonCode, ...(input.registry.evidenceClass === "protected_live" && profile.releaseBinding ? { releaseBinding: profile.releaseBinding } : {}), ...(verificationDigests ? { verificationDigests } : {}) };
    return writeCertificationObservation(input.evidenceDirectory, observation);
  } catch (error) {
    const unavailable = error instanceof Error && error.message === "CERTIFICATION_RECORDS_UNAVAILABLE";
    return writeCertificationObservation(input.evidenceDirectory, finiteFailure(profile, suite, unavailable ? "blocked" : "failed", unavailable ? "INPUT_UNAVAILABLE" : "EVIDENCE_INVALID", now));
  }
}

export async function runProtectedCertificationProfile(input: Readonly<{ profile: ProtectedCertificationProfile; selectedSuites?: readonly ProtectedSuite[]; evidenceDirectory: string; registry?: ProtectedCertificationAdapterRegistry; preflightOnly?: boolean; now?: () => number }>): Promise<ProtectedCertificationRun> {
  assertExactProtectedRegistry(input.registry);
  const selectedSuites = input.selectedSuites ?? PROTECTED_SUITES;
  if (selectedSuites.length === 0 || new Set(selectedSuites).size !== selectedSuites.length || selectedSuites.some((suite) => !PROTECTED_SUITES.includes(suite))) throw new Error("CERTIFICATION_SUITE_SELECTION_INVALID");
  const records: CertificationObservation[] = [];
  for (const suite of selectedSuites) records.push(await runProtectedCertificationSuite({ ...input, suite }));
  const allRequiredClaims = Object.values(suiteClaims).flat();
  const completeAllSuites = selectedSuites.length === PROTECTED_SUITES.length && new Set(selectedSuites).size === PROTECTED_SUITES.length;
  const completeInventory = allRequiredClaims.every((claim) => records.flatMap((record) => record.status === "passed" ? record.claims : []).filter((item) => item === claim).length === 1);
  const passed = records.every((record) => record.status === "passed") && (!completeAllSuites || completeInventory);
  return { records, status: passed ? "passed" : records.some((record) => record.status === "failed") ? "failed" : "blocked" };
}
