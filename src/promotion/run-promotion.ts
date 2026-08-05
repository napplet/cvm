import { canonicalJson, canonicalToolchainId, parsePromotionManifest, type CandidateStatus, type PromotionManifest, type ReleaseCertificationManifest } from "./schema";
import { writeEvidenceBundle } from "../evidence/bundle";
import { runSealedDenialProbes, runSealedToolchain, type CommandEvidence, type SealedToolchainRequest } from "../runner/sealed-toolchain";
import { validateCertificationObservation } from "../certification/evidence";

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
};

export type ReleaseCertificationDecision = {
  readonly candidateId: string;
  readonly releaseId: string;
  readonly evidenceSha256: string;
  readonly status: "promoted" | "blocked";
  readonly responsibleRequirement: string | null;
  readonly reason: string | null;
};

const releaseDecisions = new Map<string, Readonly<{ evidenceSha256: string; decision: Promise<ReleaseCertificationDecision> }>>();

async function sha256(value: string): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(value));
  return Array.from(new Uint8Array(digest), (byte) => byte.toString(16).padStart(2, "0")).join("");
}

async function releaseEvidenceSha256(observations: readonly unknown[]): Promise<string> {
  return sha256(canonicalJson(observations));
}

async function evaluateReleaseCertificationInner(
  manifest: ReleaseCertificationManifest,
  observations: readonly unknown[],
  input: Readonly<{ candidateId: string; nowMs: number; evidenceSha256: string }>,
): Promise<ReleaseCertificationDecision> {
  const blocked = (responsibleRequirement: string | null, reason: string): ReleaseCertificationDecision => ({ candidateId: input.candidateId, releaseId: manifest.releaseId, evidenceSha256: input.evidenceSha256, status: "blocked", responsibleRequirement, reason });
  if (manifest.waivers.some((waiver) => waiver.expiresAtMs <= input.nowMs)) return blocked("waiver", "RELEASE_WAIVER_EXPIRED");
  const parsed = await Promise.all(observations.map(async (value) => {
    try { return { observation: await validateCertificationObservation(value, { nowMs: input.nowMs, candidateId: input.candidateId }), error: null }; }
    catch (error) { return { observation: null, error: error instanceof Error ? error.message : "CERTIFICATION_OBSERVATION_INVALID" }; }
  }));
  const invalid = parsed.find((item) => item.error);
  if (invalid) return blocked(null, invalid.error!);
  for (const requirement of manifest.requirements) {
    const matches = parsed.map((item) => item.observation!).filter((item) => item.status === "passed" && item.claims.includes(requirement.claim) && item.completedAtMs >= input.nowMs - requirement.freshnessMs);
    if (matches.length !== 1) return blocked(requirement.id, matches.length === 0 ? "RELEASE_REQUIRED_CLAIM_MISSING_OR_STALE" : "RELEASE_REQUIRED_CLAIM_AMBIGUOUS");
  }
  return { candidateId: input.candidateId, releaseId: manifest.releaseId, evidenceSha256: input.evidenceSha256, status: "promoted", responsibleRequirement: null, reason: null };
}

/** The sole promotion decision is candidate-scoped and input-fingerprinted.  A
 * replay receives the same immutable terminal result; later evidence cannot replace it. */
export async function evaluateReleaseCertification(
  manifest: ReleaseCertificationManifest,
  observations: readonly unknown[],
  input: Readonly<{ candidateId: string; nowMs?: number }>,
): Promise<ReleaseCertificationDecision> {
  const nowMs = input.nowMs ?? Date.now();
  const evidenceSha256 = await releaseEvidenceSha256(observations);
  const key = `${input.candidateId}:${manifest.releaseId}`;
  const existing = releaseDecisions.get(key);
  if (existing) {
    if (existing.evidenceSha256 !== evidenceSha256) return { candidateId: input.candidateId, releaseId: manifest.releaseId, evidenceSha256, status: "blocked", responsibleRequirement: null, reason: "RELEASE_EVIDENCE_REPLACEMENT_REJECTED" };
    return existing.decision;
  }
  const decision = evaluateReleaseCertificationInner(manifest, observations, { candidateId: input.candidateId, nowMs, evidenceSha256 });
  releaseDecisions.set(key, { evidenceSha256, decision });
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
export async function runPromotionCandidate(rawManifest: unknown, options: RunPromotionOptions): Promise<PromotionEvidence> {
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
  if (!options.releaseManifest || !options.releaseObservations) return writePromotionEvidence(options.evidenceDirectory, manifest, candidateId, "blocked", "certification-required", stages);
  const certification = await evaluateReleaseCertification(options.releaseManifest, options.releaseObservations, { candidateId, nowMs: now() });
  if (certification.status !== "promoted") return writePromotionEvidence(options.evidenceDirectory, manifest, candidateId, "blocked", certification.responsibleRequirement ?? "release-certification", stages);
  const promoted = await writePromotionEvidence(options.evidenceDirectory, manifest, candidateId, "review-ready", "release-certified", stages);
  return { ...promoted, status: "promoted", responsibleStage: "release-certified" };
}
