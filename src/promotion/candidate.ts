import { canonicalJson } from "./schema";
import { validatePhase07DesignEvidence } from "../certification/evidence";

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
  readonly reviewScope: unknown;
  readonly protocol: unknown;
  readonly packages: readonly JsonRecord[];
  readonly cli: unknown;
  readonly deferredPromotionPins: readonly unknown[];
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

const SHA256 = /^[a-f0-9]{64}$/i;
const REVISION = /^[a-f0-9]{40,64}$/i;
const INTEGRITY = /^sha512-[A-Za-z0-9+/]+={0,2}$/;
const REVIEW_SCOPE = "provenance-intake";

/**
 * These are D-04 promotion-manifest pins, not pre-install provenance facts.
 * Plans 04-11 must materialize and verify them before parsePromotionManifest
 * can admit a final candidate for promotion.
 */
export const DEFERRED_PROMOTION_PINS = [
  "protocol.napRevisions",
  "lockfileSha256",
  "scaffoldRevision",
  "imageDigest",
  "runtimeVersion",
  "pnpmVersion",
  "browserVersion",
  "conformanceVersion",
  "fixtures",
  "goldens",
  "policyVersion",
  "workingDirectory",
  "cli.executablePath",
  "cli.executableSha256",
  "stages",
] as const;

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
    reviewScope: input.reviewScope,
    protocol: copyValue(input.protocol),
    packages,
    cli: copyValue(input.cli),
    deferredPromotionPins: Array.isArray(input.deferredPromotionPins) ? input.deferredPromotionPins.map(copyValue) : [],
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

function requiredUrl(value: unknown, field: string, blockers: string[]): void {
  const url = requiredString(value, field, blockers);
  if (url && !url.startsWith("https://")) blockers.push(`${field} must be an https origin`);
}

function requireDeferredNull(record: CandidateRecord, path: string, value: unknown, blockers: string[]): void {
  if (value !== null && !(Array.isArray(value) && value.length === 0)) blockers.push(`${path} must remain deferred until Plans 04-11`);
}

function validateDeferredPromotionPins(record: CandidateRecord, cli: JsonRecord, protocol: JsonRecord, blockers: string[]): void {
  const supplied = record.deferredPromotionPins;
  if (supplied.length !== DEFERRED_PROMOTION_PINS.length || supplied.some((pin, index) => pin !== DEFERRED_PROMOTION_PINS[index])) {
    blockers.push(`deferredPromotionPins must be exactly ${DEFERRED_PROMOTION_PINS.join(", ")}`);
  }
  requireDeferredNull(record, "protocol.napRevisions", protocol.napRevisions, blockers);
  requireDeferredNull(record, "lockfileSha256", record.lockfileSha256, blockers);
  requireDeferredNull(record, "scaffoldRevision", record.scaffoldRevision, blockers);
  requireDeferredNull(record, "imageDigest", record.imageDigest, blockers);
  requireDeferredNull(record, "runtimeVersion", record.runtimeVersion, blockers);
  requireDeferredNull(record, "pnpmVersion", record.pnpmVersion, blockers);
  requireDeferredNull(record, "browserVersion", record.browserVersion, blockers);
  requireDeferredNull(record, "conformanceVersion", record.conformanceVersion, blockers);
  requireDeferredNull(record, "fixtures", record.fixtures, blockers);
  requireDeferredNull(record, "goldens", record.goldens, blockers);
  requireDeferredNull(record, "policyVersion", record.policyVersion, blockers);
  requireDeferredNull(record, "workingDirectory", record.workingDirectory, blockers);
  requireDeferredNull(record, "cli.executablePath", cli.executablePath, blockers);
  requireDeferredNull(record, "cli.executableSha256", cli.executableSha256, blockers);
  requireDeferredNull(record, "stages", record.stages, blockers);
}

function validateCandidate(record: CandidateRecord): string[] {
  const blockers: string[] = [];
  if (record.schemaVersion !== 1) blockers.push("schemaVersion must be 1");
  requiredString(record.reviewScope, "reviewScope", blockers);
  if (record.reviewScope !== REVIEW_SCOPE) blockers.push(`reviewScope must be ${REVIEW_SCOPE}`);

  const protocol = requireRecord(record.protocol, "protocol", blockers);
  requiredString(protocol.nip5dRevision, "protocol.nip5dRevision", blockers, REVISION);
  requiredUrl(protocol.nip5dEvidenceOrigin, "protocol.nip5dEvidenceOrigin", blockers);

  if (record.packages.length === 0) blockers.push("packages must contain immutable package provenance records");
  const packageNames = new Set<string>();
  record.packages.forEach((pkg, index) => {
    const name = requiredString(pkg.name, `packages[${index}].name`, blockers);
    if (name && packageNames.has(name)) blockers.push(`duplicate package ${name}`);
    if (name) packageNames.add(name);
    const version = requiredString(pkg.version, `packages[${index}].version`, blockers);
    if (version === "latest" || (version && /[~^*]/.test(version))) blockers.push(`packages[${index}].version must be an exact pin`);
    requiredString(pkg.integrity, `packages[${index}].integrity`, blockers, INTEGRITY);
    requiredString(pkg.publisher, `packages[${index}].publisher`, blockers);
    requiredUrl(pkg.registryOrigin, `packages[${index}].registryOrigin`, blockers);
    requiredUrl(pkg.authoritativeRepository, `packages[${index}].authoritativeRepository`, blockers);
    requiredString(pkg.sourceCommit, `packages[${index}].sourceCommit`, blockers, REVISION);
    requiredString(pkg.sourceMapping, `packages[${index}].sourceMapping`, blockers);
    requiredUrl(pkg.sourceEvidenceOrigin, `packages[${index}].sourceEvidenceOrigin`, blockers);
  });

  const cli = requireRecord(record.cli, "cli", blockers);
  requiredString(cli.packageName, "cli.packageName", blockers);
  requiredString(cli.version, "cli.version", blockers);
  requiredString(cli.distributionType, "cli.distributionType", blockers);
  if (cli.distributionType !== "github-release-asset") blockers.push("cli.distributionType must be github-release-asset");
  requiredUrl(cli.distribution, "cli.distribution", blockers);
  requiredUrl(cli.authoritativeRepository, "cli.authoritativeRepository", blockers);
  requiredString(cli.releaseTag, "cli.releaseTag", blockers);
  requiredString(cli.releaseAsset, "cli.releaseAsset", blockers);
  requiredString(cli.releaseAssetSha256, "cli.releaseAssetSha256", blockers, SHA256);
  requiredString(cli.sourceCommit, "cli.sourceCommit", blockers, REVISION);
  requiredString(cli.sourceMapping, "cli.sourceMapping", blockers);
  requiredUrl(cli.releaseEvidenceOrigin, "cli.releaseEvidenceOrigin", blockers);
  requiredUrl(cli.sourceEvidenceOrigin, "cli.sourceEvidenceOrigin", blockers);

  validateDeferredPromotionPins(record, cli, protocol, blockers);
  if (record.evidence.length === 0) blockers.push("evidence must retain at least one queried origin and digest");
  record.evidence.forEach((entry, index) => {
    requiredUrl(entry.origin, `evidence[${index}].origin`, blockers);
    requiredString(entry.sha256, `evidence[${index}].sha256`, blockers, SHA256);
  });
  for (const unresolved of record.unresolved) {
    const field = requiredString(unresolved.field, "unresolved.field", blockers);
    const reason = requiredString(unresolved.reason, "unresolved.reason", blockers);
    if (field && reason) blockers.push(`${field}: ${reason}`);
  }
  return [...new Set(blockers)];
}

async function sha256Text(value: string): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(value));
  return Array.from(new Uint8Array(digest), (byte) => byte.toString(16).padStart(2, "0")).join("");
}

/**
 * Detects one immutable pre-install provenance subject from already-collected public metadata.
 * It is deliberately pure: it cannot install packages, run lifecycle scripts, materialize an
 * image, write goldens, or mutate promotion pointers.
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

/** Evaluates only pre-install provenance review readiness; it never promotes a toolchain. */
export async function verifyCandidateReviewReadiness(value: unknown): Promise<CandidateDetection> {
  return detectCandidate(value);
}

type CandidateCliArguments = { readonly mode: "review"; readonly path: string; readonly reviewReady: boolean } | { readonly mode: "release-evidence"; readonly path: string };

function parseCliArguments(args: readonly string[]): CandidateCliArguments | null {
  if (args.length === 2 && args[0] === "--release-evidence" && !args[1]!.startsWith("-")) return { mode: "release-evidence", path: args[1]! };
  const reviewReady = args.includes("--review-ready");
  const paths = args.filter((argument) => argument !== "--review-ready");
  if (paths.length !== 1 || paths[0]!.startsWith("-")) return null;
  return { mode: "review", path: paths[0]!, reviewReady };
}

/** Final release verification deliberately treats a deterministic record as an
 * input, never as a substitute for protected evidence. */
async function verifyReleaseEvidence(path: string): Promise<Readonly<{ status: "blocked"; reason: string; evidenceSha256: string }>> {
  const pointerOrEvidence = await Bun.file(path).json() as { contentAddressedPath?: unknown };
  const source = typeof pointerOrEvidence.contentAddressedPath === "string" ? await Bun.file(pointerOrEvidence.contentAddressedPath).json() : pointerOrEvidence;
  const evidence = await validatePhase07DesignEvidence(source);
  return { status: "blocked", reason: "PROTECTED_LIVE_CERTIFICATION_REQUIRED", evidenceSha256: evidence.evidenceSha256 };
}

if (import.meta.main) {
  const parsed = parseCliArguments(process.argv.slice(2));
  if (!parsed) {
    console.error("usage: bun run candidate:verify -- <candidate.json> --review-ready | --release-evidence <phase-07-evidence.json>");
    process.exitCode = 2;
  } else {
    try {
      if (parsed.mode === "release-evidence") {
        console.log(JSON.stringify(await verifyReleaseEvidence(parsed.path)));
        process.exitCode = 1;
      } else {
        const candidate = await verifyCandidateReviewReadiness(await Bun.file(parsed.path).json());
        console.log(JSON.stringify(candidate));
        if (parsed.reviewReady && candidate.status !== "review_ready") process.exitCode = 1;
      }
    } catch (error) {
      console.error(error instanceof Error ? error.message : "candidate verification failed");
      process.exitCode = 1;
    }
  }
}
