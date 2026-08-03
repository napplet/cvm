import { canonicalJson } from "../promotion/schema";
import { runSealedToolchain, type CommandEvidence, type SealedToolchainRequest } from "../runner/sealed-toolchain";

const SHA256 = /^[a-f0-9]{64}$/i;
const CANDIDATE_ID = "a19fc7d283a4482c53728f4a931743576564fb3826d7f8fa1383d02578b69024";
const STAGES = ["create", "init", "skills", "overlay", "install", "build", "verify", "conformance", "dry-run"] as const;

export type FixtureStage = typeof STAGES[number];

export type FixtureName = "minimal" | "capability-harness";
export type FixtureMode = "primary" | "degraded-no-intent";

export type FixtureDefinition = {
  readonly name: FixtureName;
  readonly purpose: string;
  readonly requires: readonly string[];
  readonly optionalDomains: readonly string[];
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
  readonly fixture: FixtureName;
  readonly mode: FixtureMode;
  readonly status: "passed" | "blocked";
  readonly candidateId: string;
  readonly imageDigest: string;
  readonly stages: readonly FixtureStageResult[];
  readonly installedSkillsSha256: string;
  readonly distSha256: string;
  readonly aggregateHash: string;
  readonly sealedEvidenceSha256: string;
  readonly observedDomains: readonly string[];
  readonly optionalIntentPresenceRead: boolean;
  readonly intentUsedThroughSdk: boolean;
  readonly gracefulDegradation: boolean;
  readonly reason?: string;
};

export const FIXTURES: Readonly<Record<FixtureName, FixtureDefinition>> = {
  minimal: {
    name: "minimal",
    purpose: "A single focused napplet with no required capabilities.",
    requires: [],
    optionalDomains: [],
    publish: "dry-run-only",
    stages: STAGES,
  },
  "capability-harness": {
    name: "capability-harness",
    purpose: "Persist one user-controlled value through storage and optionally compose with intent.",
    requires: ["storage"],
    optionalDomains: ["intent"],
    publish: "dry-run-only",
    stages: STAGES,
  },
};

export type RunFixtureOptions = {
  readonly imageDigest: string;
  readonly policyPath?: string;
  readonly inputDirectory?: string;
  readonly definition?: FixtureDefinition;
  readonly mode?: FixtureMode;
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

function requireStringArray(value: unknown, label: string): asserts value is string[] {
  if (!Array.isArray(value) || value.some((item) => typeof item !== "string")) throw new Error(`${label} must be a string array`);
}

function parseRunnerOutput(value: unknown, definition: FixtureDefinition, mode: FixtureMode, imageDigest: string, sealedEvidenceSha256: string): FixtureRunResult {
  if (typeof value !== "object" || value === null || Array.isArray(value)) throw new Error("fixture runner output must be an object");
  const result = value as Record<string, unknown>;
  if (result.fixture !== definition.name || !["passed", "blocked"].includes(String(result.status))) throw new Error("fixture runner output has an invalid identity or status");
  if (result.mode !== mode) throw new Error("fixture runner mode does not match sealed invocation");
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
  requireStringArray(result.observedDomains, "observed capability domains");
  if (typeof result.optionalIntentPresenceRead !== "boolean" || typeof result.intentUsedThroughSdk !== "boolean" || typeof result.gracefulDegradation !== "boolean") {
    throw new Error("fixture capability evidence is malformed");
  }
  const observedDomains = [...result.observedDomains];
  if (new Set(observedDomains).size !== observedDomains.length) throw new Error("observed capability domains must be unique");
  const allowedDomains = new Set([...definition.requires, ...definition.optionalDomains]);
  if (observedDomains.some((domain) => !allowedDomains.has(domain))) throw new Error("fixture observed an undeclared capability domain");
  if (definition.name === "minimal" && (observedDomains.length !== 0 || result.optionalIntentPresenceRead || result.intentUsedThroughSdk || result.gracefulDegradation)) {
    throw new Error("minimal fixture cannot report capability-harness evidence");
  }
  if (definition.name === "capability-harness") {
    if (!observedDomains.includes("storage")) throw new Error("capability harness must observe storage through the public SDK");
    if (!result.optionalIntentPresenceRead) throw new Error("capability harness must record the sanctioned optional intent presence read");
    if (mode === "primary" && (!observedDomains.includes("intent") || !result.intentUsedThroughSdk || result.gracefulDegradation)) {
      throw new Error("primary capability harness evidence must use intent through the public SDK");
    }
    if (mode === "degraded-no-intent" && (observedDomains.includes("intent") || result.intentUsedThroughSdk || !result.gracefulDegradation)) {
      throw new Error("degraded capability harness evidence must not use intent");
    }
  }
  const parsed: FixtureRunResult = {
    fixture: definition.name,
    mode,
    status: result.status as "passed" | "blocked",
    candidateId: CANDIDATE_ID,
    imageDigest,
    stages,
    installedSkillsSha256: result.installedSkillsSha256,
    distSha256: result.distSha256,
    aggregateHash: result.aggregateHash,
    sealedEvidenceSha256,
    observedDomains,
    optionalIntentPresenceRead: result.optionalIntentPresenceRead,
    intentUsedThroughSdk: result.intentUsedThroughSdk,
    gracefulDegradation: result.gracefulDegradation,
    ...(typeof result.reason === "string" ? { reason: result.reason } : {}),
  };
  if (parsed.status === "passed" && parsed.reason) throw new Error("a passing fixture result cannot carry a blocking reason");
  return parsed;
}

/** Runs one declared fixture through the only host-to-container execution boundary. */
export async function runFixture(name: FixtureName, options: RunFixtureOptions): Promise<FixtureRunResult> {
  const definition = options.definition ?? FIXTURES[name];
  if (definition.name !== name) throw new Error("fixture definition name does not match the selected fixture");
  requireExactStages(definition.stages, STAGES);
  requireDigest(options.imageDigest, "image digest");
  const mode = options.mode ?? "primary";
  if (name === "minimal" && mode !== "primary") throw new Error("minimal fixture supports only primary mode");
  const inputDirectory = options.inputDirectory ?? process.cwd();
  const sealed = await (options.runSealed ?? runSealedToolchain)({
    id: `fixture-${name}`,
    policyPath: options.policyPath ?? "infra/toolchain/egress-policy.json",
    imageDigest: options.imageDigest,
    inputDirectory,
    script: "/toolchain/bin/fixture-runner",
    args: ["--fixture", `/input/fixtures/${name}/fixture.json`, "--mode", mode, "--image-digest", options.imageDigest],
    toolchainId: CANDIDATE_ID,
  });
  if (sealed.disposition !== "passed" || sealed.exitCode !== 0) throw new Error(`sealed fixture runner blocked: ${sealed.disposition}`);
  let output: unknown;
  try {
    output = JSON.parse(sealed.stdout);
  } catch {
    throw new Error("fixture runner output is not JSON");
  }
  return parseRunnerOutput(output, definition, mode, options.imageDigest, sealed.evidenceSha256);
}

export function fixtureResultDigest(result: FixtureRunResult): Promise<string> {
  return crypto.subtle.digest("SHA-256", new TextEncoder().encode(canonicalJson(result))).then((digest) =>
    Array.from(new Uint8Array(digest), (byte) => byte.toString(16).padStart(2, "0")).join(""),
  );
}
