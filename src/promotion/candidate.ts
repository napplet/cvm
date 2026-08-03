import { canonicalJson, parsePromotionManifest } from "./schema";

export type CandidateReadinessStatus = "unverified" | "review_ready" | "quarantined";

type JsonRecord = Record<string, unknown>;

export type CandidateStage = {
  readonly id: unknown;
  readonly executable: unknown;
  readonly argv: unknown;
  readonly timeoutMs: unknown;
  readonly expectedOutput: unknown;
};

export type CandidateRecord = JsonRecord & {
  readonly schemaVersion: unknown;
  readonly status: CandidateReadinessStatus;
  readonly protocol: unknown;
  readonly packages: readonly JsonRecord[];
  readonly cli: unknown;
  readonly stages: readonly CandidateStage[];
  readonly evidence: readonly JsonRecord[];
  readonly unresolved: readonly JsonRecord[];
};

export type CandidateDetection = {
  readonly candidateId: string;
  readonly evidenceSha256: string;
  readonly status: CandidateReadinessStatus;
  readonly blockers: readonly string[];
  readonly record: CandidateRecord;
};

const REQUIRED_STAGES = ["create", "init", "skills-install", "build", "verify", "conformance", "dry-run"] as const;
const SHA256 = /^[a-f0-9]{64}$/i;
const REVISION = /^[a-f0-9]{40,64}$/i;

function isRecord(value: unknown): value is JsonRecord {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function object(value: unknown): JsonRecord {
  return isRecord(value) ? value : {};
}

function copyRecord(value: unknown): JsonRecord {
  if (!isRecord(value)) return {};
  return Object.fromEntries(Object.entries(value).map(([key, child]) => [key, copyValue(child)]));
}

function copyValue(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(copyValue);
  if (isRecord(value)) return copyRecord(value);
  return value;
}

function packageKey(value: JsonRecord): string {
  return [value.name, value.version, value.integrity, value.sourceCommit].map((item) => typeof item === "string" ? item : "").join("\u0000");
}

function evidenceKey(value: JsonRecord): string {
  return [value.origin, value.sha256].map((item) => typeof item === "string" ? item : "").join("\u0000");
}

/** Produces a detached canonical candidate record without invoking any tools or packages. */
function normalizeCandidate(value: unknown): CandidateRecord {
  const input = object(value);
  const packages = Array.isArray(input.packages) ? input.packages.filter(isRecord).map(copyRecord).sort((left, right) => packageKey(left).localeCompare(packageKey(right))) : [];
  const evidence = Array.isArray(input.evidence) ? input.evidence.filter(isRecord).map(copyRecord).sort((left, right) => evidenceKey(left).localeCompare(evidenceKey(right))) : [];
  const stages = Array.isArray(input.stages)
    ? input.stages.map((stage) => {
        const source = object(stage);
        return { id: source.id, executable: source.executable, argv: copyValue(source.argv), timeoutMs: source.timeoutMs, expectedOutput: copyValue(source.expectedOutput) };
      })
    : [];
  const unresolved = Array.isArray(input.unresolved) ? input.unresolved.filter(isRecord).map(copyRecord) : [];
  return {
    ...copyRecord(input),
    schemaVersion: input.schemaVersion,
    status: input.status === "quarantined" ? "quarantined" : input.status === "review_ready" ? "review_ready" : "unverified",
    protocol: copyValue(input.protocol),
    packages,
    cli: copyValue(input.cli),
    stages,
    evidence,
    unresolved,
  };
}

function requiredString(value: unknown, field: string, blockers: string[], pattern?: RegExp): string | null {
  if (typeof value !== "string" || value.trim() === "") {
    blockers.push(`${field} must be a non-empty string`);
    return null;
  }
  if (pattern && !pattern.test(value)) {
    blockers.push(`${field} is not a valid immutable pin`);
    return null;
  }
  return value;
}

function requireRecord(value: unknown, field: string, blockers: string[]): JsonRecord {
  if (!isRecord(value)) blockers.push(`${field} must be an object`);
  return object(value);
}

function validateStages(stages: readonly CandidateStage[], blockers: string[]): void {
  const ids = stages.map((stage) => stage.id);
  if (ids.length !== REQUIRED_STAGES.length || ids.some((id, index) => id !== REQUIRED_STAGES[index])) {
    blockers.push(`stage sequence must be exactly ${REQUIRED_STAGES.join(" → ")}`);
  }
  for (const [index, stage] of stages.entries()) {
    const label = `stages[${index}]`;
    requiredString(stage.id, `${label}.id`, blockers);
    requiredString(stage.executable, `${label}.executable`, blockers);
    if (!Array.isArray(stage.argv) || !stage.argv.every((argument) => typeof argument === "string")) blockers.push(`${label}.argv must be a literal argv array`);
    if (!Number.isInteger(stage.timeoutMs) || (stage.timeoutMs as number) < 1) blockers.push(`${label}.timeoutMs must be a positive integer`);
    if (!isRecord(stage.expectedOutput)) blockers.push(`${label}.expectedOutput must be an object`);
  }
}

function validateCandidate(record: CandidateRecord): string[] {
  const blockers: string[] = [];
  if (record.schemaVersion !== 1) blockers.push("schemaVersion must be 1");
  const protocol = requireRecord(record.protocol, "protocol", blockers);
  requiredString(protocol.nip5dRevision, "protocol.nip5dRevision", blockers, REVISION);
  if (!Array.isArray(protocol.napRevisions) || protocol.napRevisions.length === 0) blockers.push("protocol.napRevisions must contain exact revision pins");
  else protocol.napRevisions.forEach((revision, index) => requiredString(revision, `protocol.napRevisions[${index}]`, blockers, REVISION));

  if (record.packages.length === 0) blockers.push("packages must contain immutable package records");
  const packageNames = new Set<string>();
  record.packages.forEach((pkg, index) => {
    const name = requiredString(pkg.name, `packages[${index}].name`, blockers);
    if (name && packageNames.has(name)) blockers.push(`duplicate package ${name}`);
    if (name) packageNames.add(name);
    requiredString(pkg.version, `packages[${index}].version`, blockers);
    requiredString(pkg.integrity, `packages[${index}].integrity`, blockers);
    requiredString(pkg.sourceCommit, `packages[${index}].sourceCommit`, blockers, REVISION);
  });

  const cli = requireRecord(record.cli, "cli", blockers);
  requiredString(cli.packageName, "cli.packageName", blockers);
  requiredString(cli.distribution, "cli.distribution", blockers);
  requiredString(cli.releaseAssetSha256, "cli.releaseAssetSha256", blockers, SHA256);
  requiredString(cli.executablePath, "cli.executablePath", blockers);
  requiredString(cli.executableSha256, "cli.executableSha256", blockers, SHA256);
  requiredString(cli.sourceCommit, "cli.sourceCommit", blockers, REVISION);
  requiredString(record.lockfileSha256, "lockfileSha256", blockers, SHA256);
  requiredString(record.scaffoldRevision, "scaffoldRevision", blockers, REVISION);
  requiredString(record.imageDigest, "imageDigest", blockers, SHA256);
  requiredString(record.runtimeVersion, "runtimeVersion", blockers);
  requiredString(record.pnpmVersion, "pnpmVersion", blockers);
  requiredString(record.browserVersion, "browserVersion", blockers);
  requiredString(record.conformanceVersion, "conformanceVersion", blockers);
  requiredString(record.policyVersion, "policyVersion", blockers);
  requiredString(record.workingDirectory, "workingDirectory", blockers);

  for (const kind of ["fixtures", "goldens"] as const) {
    const entries = record[kind];
    if (!Array.isArray(entries) || entries.length === 0) {
      blockers.push(`${kind} must contain immutable revision records`);
      continue;
    }
    entries.forEach((entry, index) => {
      const item = object(entry);
      requiredString(item.name, `${kind}[${index}].name`, blockers);
      requiredString(item.revision, `${kind}[${index}].revision`, blockers, REVISION);
      requiredString(item.sha256, `${kind}[${index}].sha256`, blockers, SHA256);
    });
  }
  validateStages(record.stages, blockers);
  if (record.evidence.length === 0) blockers.push("evidence must retain at least one queried origin and digest");
  record.evidence.forEach((entry, index) => {
    requiredString(entry.origin, `evidence[${index}].origin`, blockers);
    requiredString(entry.sha256, `evidence[${index}].sha256`, blockers, SHA256);
  });
  for (const unresolved of record.unresolved) {
    const field = requiredString(unresolved.field, "unresolved.field", blockers);
    const reason = requiredString(unresolved.reason, "unresolved.reason", blockers);
    if (field && reason) blockers.push(`${field}: ${reason}`);
  }
  if (blockers.length === 0) {
    try {
      parsePromotionManifest({
        schemaVersion: 1,
        status: "candidate",
        protocol: record.protocol,
        packages: record.packages,
        executables: [{ path: cli.executablePath, sha256: cli.executableSha256 }],
        lockfileSha256: record.lockfileSha256,
        scaffoldRevision: record.scaffoldRevision,
        imageDigest: record.imageDigest,
        runtimeVersion: record.runtimeVersion,
        browserVersion: record.browserVersion,
        fixtures: record.fixtures,
        goldens: record.goldens,
        policyVersion: record.policyVersion,
        workingDirectory: record.workingDirectory,
        stages: record.stages,
      });
    } catch (error) {
      blockers.push(error instanceof Error ? error.message : "candidate does not parse as a promotion manifest");
    }
  }
  return [...new Set(blockers)];
}

async function sha256Text(value: string): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(value));
  return Array.from(new Uint8Array(digest), (byte) => byte.toString(16).padStart(2, "0")).join("");
}

/**
 * Detects one immutable review subject from already-collected public metadata.
 * It is deliberately pure: it cannot install packages, run lifecycle scripts, or
 * mutate promotion pointers or goldens.
 */
export async function detectCandidate(value: unknown): Promise<CandidateDetection> {
  const record = normalizeCandidate(value);
  const blockers = validateCandidate(record);
  const status: CandidateReadinessStatus = record.status === "quarantined"
    ? "quarantined"
    : blockers.length === 0 && record.status === "review_ready"
      ? "review_ready"
      : "unverified";
  const immutableRecord = { ...record, status, blockers };
  return {
    candidateId: await sha256Text(canonicalJson(immutableRecord)),
    evidenceSha256: await sha256Text(canonicalJson(record.evidence)),
    status,
    blockers,
    record: { ...record, status },
  };
}

/** Evaluates whether a candidate can be sent to human review; it never promotes it. */
export async function verifyCandidateReviewReadiness(value: unknown): Promise<CandidateDetection> {
  return detectCandidate(value);
}

if (import.meta.main) {
  const path = process.argv.at(-1);
  if (!path || path.startsWith("-")) {
    console.error("usage: bun run src/promotion/candidate.ts -- <candidate.json>");
    process.exitCode = 2;
  } else {
    try {
      const candidate = await verifyCandidateReviewReadiness(await Bun.file(path).json());
      console.log(JSON.stringify(candidate));
    } catch (error) {
      console.error(error instanceof Error ? error.message : "candidate verification failed");
      process.exitCode = 1;
    }
  }
}
