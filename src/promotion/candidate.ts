import { canonicalJson, parseReleaseCertificationManifest, type ReleaseCertificationManifest } from "./schema";
import { validateCertificationObservation, validatePhase07DesignEvidence } from "../certification/evidence";
import { evaluateReleaseCertification, type ReleaseCertificationDecision, type ReleaseVerificationRecords } from "./run-promotion";

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

type ReleaseEvidencePointer = Readonly<{ contentAddressedPath: string; evidenceSha256: string }>;
type ReleaseCertificationInput = Readonly<{ version: 1; candidateId: string; releaseManifest: ReleaseCertificationManifest; deterministicEvidence: ReleaseEvidencePointer; protectedObservations: readonly ReleaseEvidencePointer[]; verificationRecords: Readonly<{ reproducibilityEvidence: ReleaseEvidencePointer; supplyChainEvidence: ReleaseEvidencePointer }> }>;

function exactReleaseRecord(value: unknown, keys: readonly string[]): Record<string, unknown> {
  if (!isRecord(value) || Object.keys(value).length !== keys.length || keys.some((key) => !(key in value))) throw new Error("RELEASE_INPUT_INVALID");
  return value;
}
function parseEvidencePointer(value: unknown): ReleaseEvidencePointer {
  const record = exactReleaseRecord(value, ["contentAddressedPath", "evidenceSha256"]);
  if (typeof record.contentAddressedPath !== "string" || record.contentAddressedPath.length === 0 || record.contentAddressedPath.startsWith("/") || record.contentAddressedPath.split("/").includes("..") || typeof record.evidenceSha256 !== "string" || !SHA256.test(record.evidenceSha256)) throw new Error("RELEASE_INPUT_INVALID");
  return { contentAddressedPath: record.contentAddressedPath, evidenceSha256: record.evidenceSha256.toLowerCase() };
}

/** Strictly parses the one release-bundle shape accepted by the public verifier.
 * Evidence names are explicit pointers; it has no directory enumeration or
 * fallback discovery authority. */
export function parseReleaseCertificationInput(value: unknown): ReleaseCertificationInput {
  const record = exactReleaseRecord(value, ["version", "candidateId", "releaseManifest", "deterministicEvidence", "protectedObservations", "verificationRecords"]);
  if (record.version !== 1 || typeof record.candidateId !== "string" || !SHA256.test(record.candidateId) || !Array.isArray(record.protectedObservations) || record.protectedObservations.length === 0) throw new Error("RELEASE_INPUT_INVALID");
  const protectedObservations = record.protectedObservations.map(parseEvidencePointer);
  if (new Set(protectedObservations.map((item) => item.contentAddressedPath)).size !== protectedObservations.length || new Set(protectedObservations.map((item) => item.evidenceSha256)).size !== protectedObservations.length) throw new Error("RELEASE_INPUT_INVALID");
  const verificationRecords = exactReleaseRecord(record.verificationRecords, ["reproducibilityEvidence", "supplyChainEvidence"]);
  const reproducibilityEvidence = parseEvidencePointer(verificationRecords.reproducibilityEvidence);
  const supplyChainEvidence = parseEvidencePointer(verificationRecords.supplyChainEvidence);
  if (reproducibilityEvidence.evidenceSha256 === supplyChainEvidence.evidenceSha256 || reproducibilityEvidence.contentAddressedPath === supplyChainEvidence.contentAddressedPath) throw new Error("RELEASE_INPUT_INVALID");
  return { version: 1, candidateId: record.candidateId.toLowerCase(), releaseManifest: parseReleaseCertificationManifest(record.releaseManifest), deterministicEvidence: parseEvidencePointer(record.deterministicEvidence), protectedObservations, verificationRecords: { reproducibilityEvidence, supplyChainEvidence } };
}

function blockedReleaseDecision(candidateId: string, manifest: ReleaseCertificationManifest, reason: string): ReleaseCertificationDecision {
  return { candidateId, releaseId: manifest.releaseId, evidenceSha256: "0".repeat(64), status: "blocked", responsibleRequirement: null, reason };
}

/** Validates deterministic provenance and the closed, explicitly named
 * observation inventory, then delegates the only promoted/blocked decision to
 * evaluateReleaseCertification exactly once. */
export async function verifyReleaseCertificationInput(value: unknown, options: Readonly<{ nowMs?: number; loadDeterministic: (pointer: ReleaseEvidencePointer) => Promise<unknown>; loadObservation: (pointer: ReleaseEvidencePointer) => Promise<unknown>; loadVerificationRecord: (pointer: ReleaseEvidencePointer) => Promise<unknown> }>): Promise<ReleaseCertificationDecision> {
  let input: ReleaseCertificationInput;
  try { input = parseReleaseCertificationInput(value); }
  catch { return { candidateId: "0".repeat(64), releaseId: "0".repeat(64), evidenceSha256: "0".repeat(64), status: "blocked", responsibleRequirement: null, reason: "RELEASE_INPUT_INVALID" }; }
  try {
    const deterministic = await validatePhase07DesignEvidence(await options.loadDeterministic(input.deterministicEvidence));
    if (deterministic.evidenceSha256 !== input.deterministicEvidence.evidenceSha256 || deterministic.contentAddressedPath !== input.deterministicEvidence.contentAddressedPath) return blockedReleaseDecision(input.candidateId, input.releaseManifest, "RELEASE_DETERMINISTIC_EVIDENCE_INVALID");
    if (input.protectedObservations.length !== input.releaseManifest.requirements.length) return blockedReleaseDecision(input.candidateId, input.releaseManifest, "RELEASE_OBSERVATION_INVENTORY_INVALID");
    const observations = await Promise.all(input.protectedObservations.map(options.loadObservation));
    const parsedObservations = await Promise.all(observations.map((observation) => validateCertificationObservation(observation)));
    const allowedClaims = new Set(input.releaseManifest.requirements.map((requirement) => requirement.claim));
    if (parsedObservations.some((observation, index) => observation.evidenceSha256 !== input.protectedObservations[index]!.evidenceSha256 || (observation.status === "passed" && (observation.claims.length !== 1 || !allowedClaims.has(observation.claims[0]!))))) return blockedReleaseDecision(input.candidateId, input.releaseManifest, "RELEASE_OBSERVATION_INVENTORY_INVALID");
    const verificationRecords: ReleaseVerificationRecords = { reproducibility: await options.loadVerificationRecord(input.verificationRecords.reproducibilityEvidence), supplyChain: await options.loadVerificationRecord(input.verificationRecords.supplyChainEvidence) };
    const decision = await evaluateReleaseCertification(input.releaseManifest, parsedObservations, { candidateId: input.candidateId, nowMs: options.nowMs, verificationRecords });
    if (decision.status !== "promoted") return decision;
    const reproducibilityDigest = (verificationRecords.reproducibility as { evidenceSha256?: unknown }).evidenceSha256;
    const supplyChainDigest = (verificationRecords.supplyChain as { evidenceSha256?: unknown }).evidenceSha256;
    if (reproducibilityDigest !== input.verificationRecords.reproducibilityEvidence.evidenceSha256 || supplyChainDigest !== input.verificationRecords.supplyChainEvidence.evidenceSha256) return blockedReleaseDecision(input.candidateId, input.releaseManifest, "RELEASE_VERIFICATION_RECORD_POINTER_INVALID");
    const supplyObservation = parsedObservations.find((item) => item.claims.includes("release.supply_chain"));
    if (!supplyObservation || supplyObservation.verificationDigests?.reproducibilityEvidenceSha256 !== reproducibilityDigest || supplyObservation.verificationDigests?.supplyChainEvidenceSha256 !== supplyChainDigest) return blockedReleaseDecision(input.candidateId, input.releaseManifest, "RELEASE_SUPPLY_CHAIN_RECORD_BINDING_INVALID");
    return decision;
  } catch { return blockedReleaseDecision(input.candidateId, input.releaseManifest, "RELEASE_EVIDENCE_INVALID"); }
}

function parseCliArguments(args: readonly string[]): CandidateCliArguments | null {
  if (args.length === 2 && args[0] === "--release-evidence" && !args[1]!.startsWith("-")) return { mode: "release-evidence", path: args[1]! };
  const reviewReady = args.includes("--review-ready");
  const paths = args.filter((argument) => argument !== "--review-ready");
  if (paths.length !== 1 || paths[0]!.startsWith("-")) return null;
  return { mode: "review", path: paths[0]!, reviewReady };
}

async function readReleaseJson(path: string): Promise<unknown> {
  if (path.startsWith("/") || path.split("/").includes("..")) throw new Error("RELEASE_INPUT_INVALID");
  return Bun.file(path).json();
}
/** The CLI only reads explicit release-bundle paths; a lone deterministic
 * pointer deliberately fails parsing and cannot be promoted. */
async function verifyReleaseEvidence(path: string): Promise<ReleaseCertificationDecision> {
  return verifyReleaseCertificationInput(await readReleaseJson(path), { loadDeterministic: async (pointer) => {
    const source = await readReleaseJson(pointer.contentAddressedPath) as { contentAddressedPath?: unknown };
    return typeof source.contentAddressedPath === "string" ? readReleaseJson(source.contentAddressedPath) : source;
  }, loadObservation: (pointer) => readReleaseJson(pointer.contentAddressedPath), loadVerificationRecord: (pointer) => readReleaseJson(pointer.contentAddressedPath) });
}

if (import.meta.main) {
  const parsed = parseCliArguments(process.argv.slice(2));
  if (!parsed) {
    console.error("usage: bun run candidate:verify -- <candidate.json> --review-ready | --release-evidence <phase-07-evidence.json>");
    process.exitCode = 2;
  } else {
    try {
      if (parsed.mode === "release-evidence") {
        const decision = await verifyReleaseEvidence(parsed.path);
        console.log(JSON.stringify(decision));
        process.exitCode = decision.status === "promoted" ? 0 : 1;
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
