import { canonicalJson, canonicalToolchainId, parsePromotionManifest, type CandidateStatus, type PromotionManifest, type ReleaseCertificationManifest } from "./schema";
import { writeEvidenceBundle } from "../evidence/bundle";
import { runSealedDenialProbes, runSealedToolchain, type CommandEvidence, type SealedToolchainRequest } from "../runner/sealed-toolchain";
import { validateCertificationObservation } from "../certification/evidence";
import { validateReproducibilityVerificationRecord } from "../certification/reproducibility";
import { validateSupplyChainVerificationRecord } from "../certification/supply-chain";
import { releaseSourceMeasurement, type ReleaseCertificationTrustRoot } from "../certification/trust";
import { emitLifecycleObservation, type LifecycleTelemetryPort } from "../telemetry/contracts";

export type PromotionStageEvidence = {
  readonly id: string;
  readonly status: "passed" | "blocked";
  readonly exitCode: number | null;
  readonly stdoutSha256: string;
  readonly stderrSha256: string;
  readonly startedAtMs: number;
  readonly finishedAtMs: number;
  readonly reportSha256: string;
  readonly reason?: string;
};

export type PromotionEvidence = {
  readonly version: 1;
  readonly candidateId: string | null;
  readonly status: CandidateStatus;
  readonly responsibleStage: string;
  readonly stages: readonly PromotionStageEvidence[];
  readonly evidenceSha256: string;
};

export type RunPromotionOptions = {
  readonly evidenceDirectory: string;
  readonly policyPath?: string;
  readonly inputDirectory?: string;
  readonly runSealed?: (request: SealedToolchainRequest) => Promise<CommandEvidence>;
  readonly runDenialProbes?: (request: Omit<SealedToolchainRequest, "id" | "script" | "args">) => Promise<readonly CommandEvidence[]>;
  readonly now?: () => number;
  readonly releaseManifest?: ReleaseCertificationManifest;
  readonly releaseObservations?: readonly unknown[];
  readonly verificationRecords?: ReleaseVerificationRecords;
  readonly trustRoot?: ReleaseCertificationTrustRoot;
  readonly telemetry?: LifecycleTelemetryPort;
};

export type ReleaseCertificationDecision = {
  readonly candidateId: string;
  readonly releaseId: string;
  readonly evidenceSha256: string;
  readonly status: "promoted" | "blocked";
  readonly responsibleRequirement: string | null;
  readonly reason: string | null;
};

export type ReleaseVerificationRecords = Readonly<{ reproducibility: unknown; supplyChain: unknown }>;

const releaseDecisions = new Map<string, Promise<ReleaseCertificationDecision>>();

async function sha256(value: string): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(value));
  return Array.from(new Uint8Array(digest), (byte) => byte.toString(16).padStart(2, "0")).join("");
}

async function releaseEvidenceSha256(observations: readonly unknown[]): Promise<string> {
  return sha256(canonicalJson(observations));
}

async function releaseDecisionFingerprint(manifest: ReleaseCertificationManifest, observations: readonly unknown[], sourceMeasurement: unknown, verificationRecords: ReleaseVerificationRecords): Promise<string> {
  return sha256(canonicalJson({ manifest, observations, sourceMeasurement, verificationRecords }));
}

async function authenticateReleaseCertificationInput(
  manifest: ReleaseCertificationManifest,
  observations: readonly unknown[],
  sourceMeasurement: unknown | undefined,
  verificationRecords: ReleaseVerificationRecords | undefined,
  trustRoot: ReleaseCertificationTrustRoot | undefined,
): Promise<"authenticated" | "RELEASE_SOURCE_MEASUREMENT_REQUIRED" | "RELEASE_VERIFICATION_RECORDS_REQUIRED" | "RELEASE_CERTIFIER_AUTHORITY_REQUIRED" | "RELEASE_CERTIFIER_AUTHORITY_INVALID" | "RELEASE_SOURCE_MEASUREMENT_INVALID"> {
  if (sourceMeasurement === undefined) return "RELEASE_SOURCE_MEASUREMENT_REQUIRED";
  if (!verificationRecords) return "RELEASE_VERIFICATION_RECORDS_REQUIRED";
  if (!trustRoot) return "RELEASE_CERTIFIER_AUTHORITY_REQUIRED";
  try {
    if (!(await trustRoot.verifySourceMeasurement(sourceMeasurement))) return "RELEASE_SOURCE_MEASUREMENT_INVALID";
    const trusted = await Promise.all([
      trustRoot.verifyManifest(manifest),
      trustRoot.verifyReproducibilityRecord(verificationRecords.reproducibility),
      trustRoot.verifySupplyChainRecord(verificationRecords.supplyChain),
      ...observations.map((observation) => trustRoot.verifyObservation(observation)),
    ]);
    return trusted.every(Boolean) ? "authenticated" : "RELEASE_CERTIFIER_AUTHORITY_INVALID";
  } catch {
    return "RELEASE_CERTIFIER_AUTHORITY_INVALID";
  }
}

async function evaluateReleaseCertificationInner(
  manifest: ReleaseCertificationManifest,
  observations: readonly unknown[],
  input: Readonly<{ candidateId: string; nowMs: number; evidenceSha256: string; verificationRecords: ReleaseVerificationRecords }>,
): Promise<ReleaseCertificationDecision> {
  const blocked = (responsibleRequirement: string | null, reason: string): ReleaseCertificationDecision => ({ candidateId: input.candidateId, releaseId: manifest.releaseId, evidenceSha256: input.evidenceSha256, status: "blocked", responsibleRequirement, reason });
  if (manifest.waivers.some((waiver) => waiver.expiresAtMs <= input.nowMs)) return blocked("waiver", "RELEASE_WAIVER_EXPIRED");
  const releaseBinding = { releaseId: manifest.releaseId, sourceRevision: manifest.sourceRevision, sourceSha256: manifest.sourceSha256, supplyChainPolicy: manifest.supplyChainPolicy, inputs: manifest.inputs };
  let verificationDigests: Readonly<{ reproducibilityEvidenceSha256: string; supplyChainEvidenceSha256: string }>;
  try {
    const reproducibility = await validateReproducibilityVerificationRecord(input.verificationRecords.reproducibility, { candidateId: input.candidateId, releaseBinding, artifactSha256: manifest.inputs.workerImageDigest, nowMs: input.nowMs });
    const supplyChain = await validateSupplyChainVerificationRecord(input.verificationRecords.supplyChain, { candidateId: input.candidateId, releaseBinding, artifactSha256: manifest.inputs.workerImageDigest, nowMs: input.nowMs });
    verificationDigests = { reproducibilityEvidenceSha256: reproducibility.evidenceSha256, supplyChainEvidenceSha256: supplyChain.evidenceSha256 };
  } catch {
    return blocked("supply-chain", "RELEASE_VERIFICATION_RECORDS_INVALID");
  }
  const parsed = await Promise.all(observations.map(async (value) => {
    try { return { observation: await validateCertificationObservation(value, { nowMs: input.nowMs, candidateId: input.candidateId }), error: null }; }
    catch (error) { return { observation: null, error: error instanceof Error ? error.message : "CERTIFICATION_OBSERVATION_INVALID" }; }
  }));
  const invalid = parsed.find((item) => item.error);
  if (invalid) return blocked(null, invalid.error!);
  const bindingMatches = (observation: NonNullable<(typeof parsed)[number]["observation"]>): boolean => {
    const binding = observation.releaseBinding;
    if (!binding || binding.releaseId !== manifest.releaseId || binding.sourceRevision !== manifest.sourceRevision) return false;
    return binding.sourceSha256 === manifest.sourceSha256
      && canonicalJson(binding.supplyChainPolicy) === canonicalJson(manifest.supplyChainPolicy)
      && Object.entries(manifest.inputs).every(([key, value]) => binding.inputs[key as keyof typeof binding.inputs] === value)
      && observation.candidate.image.endsWith(`@sha256:${manifest.inputs.workerImageDigest}`)
      && observation.candidate.sourceSha256 === manifest.sourceSha256;
  };
  if (parsed.some((item) => !bindingMatches(item.observation!))) return blocked(null, "RELEASE_OBSERVATION_BINDING_MISMATCH");
  const supplyObservation = parsed.map((item) => item.observation!).find((item) => item.claims.includes("release.supply_chain"));
  if (!supplyObservation || canonicalJson(supplyObservation.verificationDigests) !== canonicalJson(verificationDigests)) return blocked("supply-chain", "RELEASE_SUPPLY_CHAIN_RECORD_BINDING_INVALID");
  for (const requirement of manifest.requirements) {
    const matches = parsed.map((item) => item.observation!).filter((item) => item.status === "passed"
      && item.claims.includes(requirement.claim)
      && item.completedAtMs >= input.nowMs - requirement.freshnessMs
      && (!requirement.live || item.evidenceClass === "protected_live"));
    if (matches.length !== 1) return blocked(requirement.id, matches.length === 0 ? "RELEASE_REQUIRED_CLAIM_MISSING_OR_STALE" : "RELEASE_REQUIRED_CLAIM_AMBIGUOUS");
  }
  return { candidateId: input.candidateId, releaseId: manifest.releaseId, evidenceSha256: input.evidenceSha256, status: "promoted", responsibleRequirement: null, reason: null };
}

/** The sole promotion decision is candidate-scoped and input-fingerprinted.  A
 * replay receives the same immutable terminal result; later evidence cannot replace it. */
export async function evaluateReleaseCertification(
  manifest: ReleaseCertificationManifest,
  observations: readonly unknown[],
  input: Readonly<{ candidateId: string; nowMs?: number; sourceMeasurement?: unknown; verificationRecords?: ReleaseVerificationRecords; trustRoot?: ReleaseCertificationTrustRoot }>,
): Promise<ReleaseCertificationDecision> {
  const nowMs = input.nowMs ?? Date.now();
  const evidenceSha256 = await releaseEvidenceSha256([observations, input.sourceMeasurement ?? null, input.verificationRecords ?? null]);
  const blocked = (reason: Exclude<Awaited<ReturnType<typeof authenticateReleaseCertificationInput>>, "authenticated">): ReleaseCertificationDecision => ({ candidateId: input.candidateId, releaseId: manifest.releaseId, evidenceSha256, status: "blocked", responsibleRequirement: reason === "RELEASE_VERIFICATION_RECORDS_REQUIRED" ? "supply-chain" : null, reason });
  const authentication = await authenticateReleaseCertificationInput(manifest, observations, input.sourceMeasurement, input.verificationRecords, input.trustRoot);
  if (authentication !== "authenticated") return blocked(authentication);
  const key = `${input.candidateId}:${await releaseDecisionFingerprint(manifest, observations, input.sourceMeasurement, input.verificationRecords!)}`;
  const existing = releaseDecisions.get(key);
  if (existing) return existing;
  const decision = evaluateReleaseCertificationInner(manifest, observations, { candidateId: input.candidateId, nowMs, evidenceSha256, verificationRecords: input.verificationRecords! });
  releaseDecisions.set(key, decision);
  return decision;
}

async function stageEvidence(stageId: string, command: CommandEvidence, expectedOutput: unknown): Promise<PromotionStageEvidence> {
  let reason: string | undefined;
  if (command.disposition !== "passed") reason = command.disposition;
  else {
    try {
      if (canonicalJson(JSON.parse(command.stdout)) !== canonicalJson(expectedOutput)) reason = "unexpected stage output";
    } catch {
      reason = "malformed JSON output";
    }
  }
  return {
    id: stageId,
    status: reason ? "blocked" : "passed",
    exitCode: command.exitCode,
    stdoutSha256: command.stdoutSha256,
    stderrSha256: command.stderrSha256,
    startedAtMs: command.startedAtMs,
    finishedAtMs: command.finishedAtMs,
    reportSha256: command.evidenceSha256,
    ...(reason ? { reason } : {}),
  };
}

async function syntheticFailure(stageId: string, reason: string, now: () => number): Promise<PromotionStageEvidence> {
  const timestamp = now();
  const base = {
    id: stageId,
    status: "blocked" as const,
    exitCode: null,
    stdoutSha256: await sha256(""),
    stderrSha256: await sha256(reason),
    startedAtMs: timestamp,
    finishedAtMs: timestamp,
    reason,
  };
  return { ...base, reportSha256: await sha256(canonicalJson(base)) };
}

async function writePromotionEvidence(
  directory: string,
  manifest: PromotionManifest,
  candidateId: string,
  status: Extract<CandidateStatus, "review-ready" | "blocked">,
  responsibleStage: string,
  stages: readonly PromotionStageEvidence[],
): Promise<PromotionEvidence> {
  const manifestSha256 = await sha256(canonicalJson(manifest));
  const bundle = await writeEvidenceBundle(directory, {
    verdict: { status, responsibleStage },
    manifest: { candidateId, sha256: manifestSha256 },
    nativeReports: stages.map((stage) => ({ id: stage.id, sha256: stage.reportSha256 })),
    integrationResults: [{ id: "promotion-tracer", reportDigests: stages.map((stage) => stage.reportSha256) }],
    // A single native trace proves neither an artifact/golden comparison nor reproducibility/provenance.
    artifacts: { status: "not-evaluated" },
    reproducibility: { status: "not-evaluated" },
    provenance: { status: "not-evaluated" },
  });
  return { version: 1, candidateId, status, responsibleStage, stages, evidenceSha256: bundle.evidenceSha256 };
}

/**
 * Executes a manifest candidate without package resolution. A successful trace is
 * blocked until the separately measured certification layers are present; it has no promoted-pointer mutation capability.
 */
async function runPromotionCandidateInner(rawManifest: unknown, options: RunPromotionOptions): Promise<PromotionEvidence> {
  const now = options.now ?? Date.now;
  let manifest: PromotionManifest;
  let candidateId: string;
  try {
    manifest = parsePromotionManifest(rawManifest);
    candidateId = await canonicalToolchainId(manifest);
  } catch (error) {
    const reason = error instanceof Error ? error.message : "malformed manifest";
    const failure = await syntheticFailure("manifest", reason, now);
    return { version: 1, candidateId: null, status: "blocked", responsibleStage: "manifest", stages: [failure], evidenceSha256: failure.reportSha256 };
  }

  const sealedInputs = {
    policyPath: options.policyPath ?? "infra/toolchain/egress-policy.json",
    inputDirectory: options.inputDirectory ?? manifest.workingDirectory,
    toolchainId: candidateId,
    imageDigest: manifest.imageDigest,
    now,
  };
  try {
    await (options.runDenialProbes ?? runSealedDenialProbes)(sealedInputs);
  } catch (error) {
    const failure = await syntheticFailure("egress-denial", error instanceof Error ? error.message : "denial probes failed", now);
    return writePromotionEvidence(options.evidenceDirectory, manifest, candidateId, "blocked", "egress-denial", [failure]);
  }

  const stages: PromotionStageEvidence[] = [];
  for (const stage of manifest.stages) {
    try {
      const command = await (options.runSealed ?? runSealedToolchain)({
        id: stage.id,
        ...sealedInputs,
        script: stage.executable,
        executableSha256: manifest.executables.find((entry) => entry.path === stage.executable)!.sha256,
        args: stage.argv,
        toolchainId: candidateId,
        imageDigest: manifest.imageDigest,
        timeoutMs: stage.timeoutMs,
        now,
      });
      const result = await stageEvidence(stage.id, command, stage.expectedOutput);
      stages.push(result);
      if (result.status === "blocked") return writePromotionEvidence(options.evidenceDirectory, manifest, candidateId, "blocked", stage.id, stages);
    } catch (error) {
      const failure = await syntheticFailure(stage.id, error instanceof Error ? error.message : "stage execution failed", now);
      stages.push(failure);
      return writePromotionEvidence(options.evidenceDirectory, manifest, candidateId, "blocked", stage.id, stages);
    }
  }
  if (!options.releaseManifest || !options.releaseObservations || !options.verificationRecords) return writePromotionEvidence(options.evidenceDirectory, manifest, candidateId, "blocked", "certification-required", stages);
  const certification = await evaluateReleaseCertification(options.releaseManifest, options.releaseObservations, { candidateId, nowMs: now(), sourceMeasurement: releaseSourceMeasurement(options.releaseManifest), verificationRecords: options.verificationRecords, trustRoot: options.trustRoot });
  if (certification.status !== "promoted") return writePromotionEvidence(options.evidenceDirectory, manifest, candidateId, "blocked", certification.responsibleRequirement ?? "release-certification", stages);
  const promoted = await writePromotionEvidence(options.evidenceDirectory, manifest, candidateId, "review-ready", "release-certified", stages);
  return { ...promoted, status: "promoted", responsibleStage: "release-certified" };
}

/** Promotion has no mutation capability; emit its final candidate decision only after it is known. */
export async function runPromotionCandidate(rawManifest: unknown, options: RunPromotionOptions): Promise<PromotionEvidence> {
  const result = await runPromotionCandidateInner(rawManifest, options);
  await emitLifecycleObservation(options.telemetry, [result.candidateId ?? "invalid-candidate", result.evidenceSha256], "promotion", result.status === "promoted" ? "succeeded" : "blocked", options.now?.() ?? Date.now());
  return result;
}
