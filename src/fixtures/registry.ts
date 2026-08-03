import { canonicalJson } from "../promotion/schema";
import { runSealedToolchain, type CommandEvidence, type SealedToolchainRequest } from "../runner/sealed-toolchain";

const SHA256 = /^[a-f0-9]{64}$/i;
const CANDIDATE_ID = "a19fc7d283a4482c53728f4a931743576564fb3826d7f8fa1383d02578b69024";
const STAGES = ["create", "init", "skills", "overlay", "install", "build", "verify", "conformance", "dry-run"] as const;

export type FixtureStage = typeof STAGES[number];

export type FixtureDefinition = {
  readonly name: "minimal";
  readonly purpose: string;
  readonly requires: readonly string[];
  readonly publish: "dry-run-only";
  readonly stages: readonly FixtureStage[];
};

export type FixtureStageResult = {
  readonly id: FixtureStage;
  readonly argv: readonly string[];
  readonly exitCode: number;
  readonly stdoutSha256: string;
  readonly stderrSha256: string;
  readonly nativeOutputSha256: string;
};

export type FixtureRunResult = {
  readonly fixture: "minimal";
  readonly status: "passed" | "blocked";
  readonly candidateId: string;
  readonly imageDigest: string;
  readonly stages: readonly FixtureStageResult[];
  readonly installedSkillsSha256: string;
  readonly distSha256: string;
  readonly aggregateHash: string;
  readonly sealedEvidenceSha256: string;
  readonly reason?: string;
};

export const FIXTURES: Readonly<Record<"minimal", FixtureDefinition>> = {
  minimal: {
    name: "minimal",
    purpose: "A single focused napplet with no required capabilities.",
    requires: [],
    publish: "dry-run-only",
    stages: STAGES,
  },
};

export type RunFixtureOptions = {
  readonly imageDigest: string;
  readonly policyPath?: string;
  readonly inputDirectory?: string;
  readonly definition?: FixtureDefinition;
  readonly runSealed?: (request: SealedToolchainRequest) => Promise<CommandEvidence>;
};

function requireDigest(value: unknown, label: string): asserts value is string {
  if (typeof value !== "string" || !SHA256.test(value)) throw new Error(`${label} must be a SHA-256 digest`);
}

function requireExactStages(value: unknown, expected: readonly FixtureStage[]): asserts value is FixtureStage[] {
  if (!Array.isArray(value) || value.length !== expected.length || value.some((stage, index) => stage !== expected[index])) {
    throw new Error("fixture runner must return the exact sealed stage plan");
  }
}

function parseStage(value: unknown, expected: FixtureStage): FixtureStageResult {
  if (typeof value !== "object" || value === null || Array.isArray(value)) throw new Error(`fixture ${expected} evidence is malformed`);
  const stage = value as Record<string, unknown>;
  if (stage.id !== expected || !Array.isArray(stage.argv) || !stage.argv.every((item) => typeof item === "string") || !Number.isInteger(stage.exitCode) || stage.exitCode !== 0) {
    throw new Error(`fixture ${expected} stage evidence is invalid`);
  }
  requireDigest(stage.stdoutSha256, `${expected} stdout`);
  requireDigest(stage.stderrSha256, `${expected} stderr`);
  requireDigest(stage.nativeOutputSha256, `${expected} native output`);
  return stage as unknown as FixtureStageResult;
}

function parseRunnerOutput(value: unknown, definition: FixtureDefinition, imageDigest: string, sealedEvidenceSha256: string): FixtureRunResult {
  if (typeof value !== "object" || value === null || Array.isArray(value)) throw new Error("fixture runner output must be an object");
  const result = value as Record<string, unknown>;
  if (result.fixture !== definition.name || !["passed", "blocked"].includes(String(result.status))) throw new Error("fixture runner output has an invalid identity or status");
  if (result.candidateId !== CANDIDATE_ID) throw new Error("fixture runner candidate ID does not match the approved release set");
  requireDigest(result.imageDigest, "fixture image");
  if (result.imageDigest !== imageDigest) throw new Error("fixture runner image digest does not match sealed invocation");
  if (!Array.isArray(result.stages)) throw new Error("fixture runner stages must be an array");
  const stageIds = result.stages.map((stage) => typeof stage === "object" && stage !== null ? (stage as Record<string, unknown>).id : undefined);
  if (result.status === "passed") requireExactStages(stageIds, definition.stages);
  if (result.status === "blocked" && stageIds.some((id, index) => id !== definition.stages[index])) throw new Error("blocked fixture runner stages are reordered");
  const stages = result.stages.map((stage, index) => parseStage(stage, definition.stages[index]!));
  requireDigest(result.installedSkillsSha256, "installed skills");
  requireDigest(result.distSha256, "dist tree");
  requireDigest(result.aggregateHash, "upstream aggregate hash");
  const parsed: FixtureRunResult = {
    fixture: definition.name,
    status: result.status as "passed" | "blocked",
    candidateId: CANDIDATE_ID,
    imageDigest,
    stages,
    installedSkillsSha256: result.installedSkillsSha256,
    distSha256: result.distSha256,
    aggregateHash: result.aggregateHash,
    sealedEvidenceSha256,
    ...(typeof result.reason === "string" ? { reason: result.reason } : {}),
  };
  if (parsed.status === "passed" && parsed.reason) throw new Error("a passing fixture result cannot carry a blocking reason");
  return parsed;
}

/** Runs one declared fixture through the only host-to-container execution boundary. */
export async function runFixture(name: "minimal", options: RunFixtureOptions): Promise<FixtureRunResult> {
  const definition = options.definition ?? FIXTURES[name];
  if (definition.name !== name) throw new Error("fixture definition name does not match the selected fixture");
  requireExactStages(definition.stages, STAGES);
  requireDigest(options.imageDigest, "image digest");
  const inputDirectory = options.inputDirectory ?? process.cwd();
  const sealed = await (options.runSealed ?? runSealedToolchain)({
    id: `fixture-${name}`,
    policyPath: options.policyPath ?? "infra/toolchain/egress-policy.json",
    imageDigest: options.imageDigest,
    inputDirectory,
    script: "/toolchain/bin/fixture-runner",
    args: ["--fixture", `/input/fixtures/${name}/fixture.json`, "--image-digest", options.imageDigest],
    toolchainId: CANDIDATE_ID,
  });
  if (sealed.disposition !== "passed" || sealed.exitCode !== 0) throw new Error(`sealed fixture runner blocked: ${sealed.disposition}`);
  let output: unknown;
  try {
    output = JSON.parse(sealed.stdout);
  } catch {
    throw new Error("fixture runner output is not JSON");
  }
  return parseRunnerOutput(output, definition, options.imageDigest, sealed.evidenceSha256);
}

export function fixtureResultDigest(result: FixtureRunResult): Promise<string> {
  return crypto.subtle.digest("SHA-256", new TextEncoder().encode(canonicalJson(result))).then((digest) =>
    Array.from(new Uint8Array(digest), (byte) => byte.toString(16).padStart(2, "0")).join(""),
  );
}
