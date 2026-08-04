import { canonicalJson, canonicalToolchainId, parsePromotionManifest, type CandidateStatus, type PromotionManifest } from "./schema";
import { writeEvidenceBundle } from "../evidence/bundle";
import { runSealedDenialProbes, runSealedToolchain, type CommandEvidence, type SealedToolchainRequest } from "../runner/sealed-toolchain";

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
};

async function sha256(value: string): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(value));
  return Array.from(new Uint8Array(digest), (byte) => byte.toString(16).padStart(2, "0")).join("");
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
  return writePromotionEvidence(options.evidenceDirectory, manifest, candidateId, "blocked", "certification-deferred", stages);
}
