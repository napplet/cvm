import { mkdir, readFile, writeFile } from "node:fs/promises";
import { canonicalJson, canonicalToolchainId, parsePromotionManifest, type CandidateStatus, type PromotionManifest } from "./schema";

export type PromotionStageEvidence = {
  readonly id: string;
  readonly status: "passed" | "blocked";
  readonly exitCode: number | null;
  readonly stdoutSha256: string;
  readonly stderrSha256: string;
  readonly startedAtMs: number;
  readonly finishedAtMs: number;
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
  readonly now?: () => number;
};

const decoder = new TextDecoder();

async function sha256(bytes: Uint8Array | string): Promise<string> {
  const source = typeof bytes === "string" ? new TextEncoder().encode(bytes) : bytes;
  const hash = await crypto.subtle.digest("SHA-256", source);
  return Array.from(new Uint8Array(hash), (byte) => byte.toString(16).padStart(2, "0")).join("");
}

function blocked(candidateId: string | null, responsibleStage: string, stages: readonly PromotionStageEvidence[], reason: string): Promise<PromotionEvidence> {
  return finishEvidence({ version: 1, candidateId, status: "blocked", responsibleStage, stages: [...stages, { id: responsibleStage, status: "blocked", exitCode: null, stdoutSha256: "", stderrSha256: "", startedAtMs: 0, finishedAtMs: 0, reason }] });
}

async function finishEvidence(evidence: Omit<PromotionEvidence, "evidenceSha256">): Promise<PromotionEvidence> {
  const evidenceSha256 = await sha256(canonicalJson(evidence));
  return { ...evidence, evidenceSha256 };
}

async function writeCanonicalEvidence(directory: string, evidence: PromotionEvidence): Promise<void> {
  await mkdir(directory, { recursive: true });
  const file = `${directory}/${evidence.candidateId ?? "malformed"}.json`;
  const content = `${canonicalJson(evidence)}\n`;
  try {
    await writeFile(file, content, { encoding: "utf8", flag: "wx" });
  } catch (error) {
    if (!(error instanceof Error) || !("code" in error) || error.code !== "EEXIST") throw error;
    const existing = await readFile(file, "utf8");
    if (existing !== content) throw new Error(`evidence already exists with different content for ${evidence.candidateId}`);
  }
}

async function runStage(manifest: PromotionManifest, stage: PromotionManifest["stages"][number], now: () => number): Promise<PromotionStageEvidence> {
  const approved = manifest.executables.find((entry) => entry.path === stage.executable);
  if (!approved) throw new Error("unapproved executable");
  const executableBytes = new Uint8Array(await Bun.file(stage.executable).arrayBuffer());
  if ((await sha256(executableBytes)) !== approved.sha256) throw new Error("executable digest does not match immutable manifest pin");

  const startedAtMs = now();
  const child = Bun.spawn([stage.executable, ...stage.argv], {
    cwd: manifest.workingDirectory,
    env: {},
    stdin: "ignore",
    stdout: "pipe",
    stderr: "pipe",
  });
  let timedOut = false;
  const timeout = setTimeout(() => {
    timedOut = true;
    child.kill();
  }, stage.timeoutMs);
  const [exitCode, stdoutBytes, stderrBytes] = await Promise.all([
    child.exited,
    new Response(child.stdout).bytes(),
    new Response(child.stderr).bytes(),
  ]).finally(() => clearTimeout(timeout));
  const finishedAtMs = now();
  const stdout = decoder.decode(stdoutBytes);
  const stderr = decoder.decode(stderrBytes);
  const evidence: PromotionStageEvidence = {
    id: stage.id,
    status: "passed",
    exitCode,
    stdoutSha256: await sha256(stdoutBytes),
    stderrSha256: await sha256(stderrBytes),
    startedAtMs,
    finishedAtMs,
  };
  if (timedOut) return { ...evidence, status: "blocked", reason: "timeout" };
  if (exitCode !== 0) return { ...evidence, status: "blocked", reason: "non-zero exit" };
  let output: unknown;
  try {
    output = JSON.parse(stdout);
  } catch {
    return { ...evidence, status: "blocked", reason: "malformed JSON output" };
  }
  if (canonicalJson(output) !== canonicalJson(stage.expectedOutput)) {
    return { ...evidence, status: "blocked", reason: "unexpected stage output" };
  }
  return evidence;
}

/**
 * Executes a manifest candidate without resolving packages, using only its pinned
 * absolute executable. A successful trace is review-ready, never promoted.
 */
export async function runPromotionCandidate(rawManifest: unknown, options: RunPromotionOptions): Promise<PromotionEvidence> {
  const now = options.now ?? Date.now;
  let manifest: PromotionManifest;
  let candidateId: string;
  try {
    manifest = parsePromotionManifest(rawManifest);
    candidateId = await canonicalToolchainId(manifest);
  } catch (error) {
    const evidence = await blocked(null, "manifest", [], error instanceof Error ? error.message : "malformed manifest");
    await writeCanonicalEvidence(options.evidenceDirectory, evidence);
    return evidence;
  }

  const stages: PromotionStageEvidence[] = [];
  for (const stage of manifest.stages) {
    try {
      const result = await runStage(manifest, stage, now);
      stages.push(result);
      if (result.status === "blocked") {
        const evidence = await finishEvidence({ version: 1, candidateId, status: "blocked", responsibleStage: stage.id, stages });
        await writeCanonicalEvidence(options.evidenceDirectory, evidence);
        return evidence;
      }
    } catch (error) {
      const evidence = await blocked(candidateId, stage.id, stages, error instanceof Error ? error.message : "stage execution failed");
      await writeCanonicalEvidence(options.evidenceDirectory, evidence);
      return evidence;
    }
  }
  const evidence = await finishEvidence({ version: 1, candidateId, status: "review-ready", responsibleStage: "none", stages });
  await writeCanonicalEvidence(options.evidenceDirectory, evidence);
  return evidence;
}
