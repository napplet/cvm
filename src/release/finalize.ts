import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { dirname, join, relative, resolve, sep } from "node:path";
import { loadPinnedReleaseCertificationTrustRoot } from "../certification/trust";
import { completeFinalizationCleanup } from "./finalization-cleanup";
import { claimFinalizationRecord } from "./finalization-files";
import { canonicalJson, parseReleaseCertificationManifest } from "../promotion/schema";
import { evaluateReleaseCertification, type ReleaseCertificationDecision, type ReleaseVerificationRecords } from "../promotion/run-promotion";
import { validateCertificationObservation } from "../certification/evidence";
import type { CertificationObservation } from "../certification/contracts";
import { PROTECTED_SUITES } from "../certification/runner";
import { finalizeProtectedTrustRoot, type FinalizeProtectedTrustRootInput, type FinalizedProtectedTrustRoot } from "./materialize-certifier";

const DIGEST = /^[a-f0-9]{64}$/iu;
const safeDigest = (value: unknown): value is string => typeof value === "string" && DIGEST.test(value);

export type ReleaseFinalizationPromotionPort = Readonly<{
  /** Durable original-operation journal write. It must happen before promote. */
  persist(input: Readonly<{ operationId: string; bundleSha256: string; authorizationReceiptSha256: string; verificationAuthority?: Readonly<{ path: string; sha256: string }> }>): Promise<void>;
  /** The only pointer-changing effect. Replays use the same operation identity. */
  promote(input: Readonly<{ operationId: string; bundleSha256: string }>): Promise<"promoted" | "unknown">;
  observe?(input: Readonly<{ operationId: string; bundleSha256: string }>): Promise<"promoted" | "unknown">;
}>;

export type ReleaseFinalizationCleanupPort = Readonly<{
  cleanup(input: Readonly<{ operationId: string; providerOperationId: string; resourceIdentitySha256: string }>): Promise<"cleaned" | "retained" | "unknown">;
  /** Query the original operation after a lost response. Never redispatch. */
  observe?(input: Readonly<{ operationId: string; providerOperationId: string; resourceIdentitySha256: string }>): Promise<"cleaned" | "retained" | "unknown">;
}>;

export type ReleaseFinalizationInput = Readonly<{
  workspace: string;
  candidateId: string;
  topologySha256: string;
  authorizationReceiptSha256: string;
  protectedRecords: readonly unknown[];
  /** Required only after the exact-eight root is proven complete. */
  trust?: Omit<FinalizeProtectedTrustRootInput, "candidateId" | "topologySha256" | "authorizationReceiptSha256" | "observations">;
  verificationRecords?: ReleaseVerificationRecords;
  sourceMeasurement?: unknown;
  selectedWorker?: Readonly<{ provider: "modal" | "fly"; selectionEvidenceSha256: string }>;
  receipts?: readonly string[];
  attestations?: readonly string[];
  cleanupPlan?: Readonly<{ cleanupByMs: number; retainedEvidenceDays: number; retainedArtifactDays: number; effects: readonly Readonly<{ providerOperationId: string; resourceIdentitySha256: string }>[] }>;
  promotion: ReleaseFinalizationPromotionPort;
  cleanup?: ReleaseFinalizationCleanupPort;
  nowMs?: number;
}>;

export type ReleaseFinalizationResult = Readonly<{
  status: "promoted" | "blocked" | "cleanup_incomplete";
  bundleSha256: string | null;
  operationId: string | null;
  decision: ReleaseCertificationDecision | null;
  verificationConfig?: Readonly<{ path: string; sha256: string }>;
}>;

/** Reconciliation never creates a second promotion operation. Unknown means
 * the original operation must be observed by a later authenticated executor,
 * not redispatched by a resumed local process. */
export async function resumeFinalizationPromotion(input: Readonly<{
  operationId: string;
  bundleSha256: string;
  authorizationReceiptSha256: string;
  status: "pending" | "unknown" | "promoted";
  verificationAuthority?: Readonly<{ path: string; sha256: string }>;
  persist(input: Readonly<{ operationId: string; bundleSha256: string; authorizationReceiptSha256: string; verificationAuthority?: Readonly<{ path: string; sha256: string }> }>): Promise<void>;
  promote(input: Readonly<{ operationId: string; bundleSha256: string }>): Promise<"promoted" | "unknown">;
}>): Promise<Readonly<{ status: "promoted" | "blocked"; operationId: string }>> {
  if (input.status === "promoted") return Object.freeze({ status: "promoted", operationId: input.operationId });
  if (input.status === "unknown") return Object.freeze({ status: "blocked", operationId: input.operationId });
  await input.persist({ operationId: input.operationId, bundleSha256: input.bundleSha256, authorizationReceiptSha256: input.authorizationReceiptSha256, ...(input.verificationAuthority ? { verificationAuthority: input.verificationAuthority } : {}) });
  const result = await input.promote({ operationId: input.operationId, bundleSha256: input.bundleSha256 });
  return Object.freeze({ status: result === "promoted" ? "promoted" : "blocked", operationId: input.operationId });
}

async function digest(value: unknown): Promise<string> {
  const bytes = new TextEncoder().encode(canonicalJson(value));
  const hash = await crypto.subtle.digest("SHA-256", bytes);
  return Array.from(new Uint8Array(hash), (byte) => byte.toString(16).padStart(2, "0")).join("");
}

function within(root: string, value: string): boolean {
  const relation = relative(root, value);
  return relation !== "" && relation !== ".." && !relation.startsWith(`..${sep}`);
}

async function writeImmutable(path: string, contents: string, collision: string): Promise<void> {
  await mkdir(dirname(path), { recursive: true, mode: 0o700 });
  try { await claimFinalizationRecord(path, JSON.parse(contents)); }
  catch { throw new Error(collision); }
}

async function advancePointer(path: string, contents: string): Promise<void> {
  await mkdir(dirname(path), { recursive: true, mode: 0o700 });
  const temporary = `${path}.${crypto.randomUUID()}.tmp`;
  await writeFile(temporary, contents, { encoding: "utf8", flag: "wx", mode: 0o600 });
  await rename(temporary, path);
}

async function exists(path: string): Promise<boolean> {
  try { await readFile(path, "utf8"); return true; }
  catch (error) { if (error instanceof Error && "code" in error && error.code === "ENOENT") return false; throw error; }
}

async function exactEight(input: ReleaseFinalizationInput): Promise<CertificationObservation[]> {
  if (!safeDigest(input.candidateId) || !safeDigest(input.topologySha256) || !safeDigest(input.authorizationReceiptSha256)
    || !Array.isArray(input.protectedRecords) || input.protectedRecords.length !== PROTECTED_SUITES.length) {
    throw new Error("RELEASE_FINALIZATION_EVIDENCE_INVALID");
  }
  let records: CertificationObservation[];
  try {
    records = await Promise.all(input.protectedRecords.map((record) => validateCertificationObservation(record, { nowMs: input.nowMs ?? Date.now(), candidateId: input.candidateId })));
  } catch { throw new Error("RELEASE_FINALIZATION_EVIDENCE_INVALID"); }
  const suites = records.map((record) => record.input.command.at(1)?.replace("suite:", ""));
  if (records.some((record) => record.evidenceClass !== "protected_live" || record.status !== "passed" || record.input.topologySha256 !== input.topologySha256 || !record.releaseBinding)
    || suites.length !== PROTECTED_SUITES.length || new Set(suites).size !== PROTECTED_SUITES.length
    || PROTECTED_SUITES.some((suite) => !suites.includes(suite))) throw new Error("RELEASE_FINALIZATION_EVIDENCE_INVALID");
  const manifest = canonicalJson(records[0]!.releaseBinding);
  if (records.some((record) => canonicalJson(record.releaseBinding) !== manifest)) throw new Error("RELEASE_FINALIZATION_EVIDENCE_INVALID");
  return records.sort((left, right) => left.input.command[1]!.localeCompare(right.input.command[1]!));
}

async function loadFinalTrustRoot(value: FinalizedProtectedTrustRoot): Promise<Parameters<typeof evaluateReleaseCertification>[2]["trustRoot"]> {
  return loadPinnedReleaseCertificationTrustRoot(value.trustRoot);
}

/**
 * Finalization deliberately contains no policy evaluator and no provider client.
 * It validates a complete protected root, delegates the only release decision to
 * the existing evaluator, then journals an immutable bundle before the one
 * caller-provided promotion pointer effect.
 */
export async function finalizeReleaseCertification(input: ReleaseFinalizationInput): Promise<ReleaseFinalizationResult> {
  const records = await exactEight(input);
  if (!input.trust || !input.verificationRecords || !input.sourceMeasurement || !input.cleanupPlan) {
    throw new Error("RELEASE_FINALIZATION_INPUT_REQUIRED");
  }
  const workspace = resolve(input.workspace);
  const trust = await finalizeProtectedTrustRoot({ ...input.trust, workspace, candidateId: input.candidateId, topologySha256: input.topologySha256, authorizationReceiptSha256: input.authorizationReceiptSha256, observations: records, nowMs: input.nowMs });
  const trustRoot = await loadFinalTrustRoot(trust);
  const manifest = parseReleaseCertificationManifest(input.trust.releaseManifest);
  const decision = await evaluateReleaseCertification(manifest, records, {
    candidateId: input.candidateId,
    nowMs: input.nowMs,
    sourceMeasurement: input.sourceMeasurement,
    verificationRecords: input.verificationRecords,
    trustRoot,
  });
  if (decision.status !== "promoted") return { status: "blocked", bundleSha256: null, operationId: null, decision };

  const cleanup = input.cleanupPlan;
  if (!Number.isSafeInteger(cleanup.cleanupByMs) || cleanup.cleanupByMs <= (input.nowMs ?? Date.now())
    || !Number.isInteger(cleanup.retainedEvidenceDays) || cleanup.retainedEvidenceDays < 30
    || !Number.isInteger(cleanup.retainedArtifactDays) || cleanup.retainedArtifactDays < 30
    || cleanup.effects.some((effect) => !safeDigest(effect.resourceIdentitySha256) || !effect.providerOperationId)) throw new Error("RELEASE_FINALIZATION_CLEANUP_PLAN_INVALID");
  const root = join(workspace, "release-finalizations", input.candidateId.toLowerCase());
  if (!within(workspace, root)) throw new Error("RELEASE_FINALIZATION_WORKSPACE_REJECTED");
  const payload = {
    version: 1 as const,
    candidateId: input.candidateId.toLowerCase(), topologySha256: input.topologySha256.toLowerCase(), authorizationReceiptSha256: input.authorizationReceiptSha256.toLowerCase(),
    evidenceRootSha256: await digest(records.map((record) => record.evidenceSha256)),
    releaseManifest: manifest,
    protectedRecords: records, evaluatorVerdict: decision, trustRoot: { configSha256: trust.configSha256, moduleSha256: trust.trustRoot.sha256, materialPath: trust.materialPath },
    verificationRecords: input.verificationRecords, sourceMeasurement: input.sourceMeasurement,
    selectedWorker: input.selectedWorker ?? null, receipts: [...(input.receipts ?? [])].sort(), attestations: [...(input.attestations ?? [])].sort(), cleanupPlan: cleanup,
  };
  const bundleSha256 = await digest(payload);
  const bundle = { ...payload, bundleSha256 };
  await writeImmutable(join(root, "bundles", `${bundleSha256}.json`), `${canonicalJson(bundle)}\n`, "RELEASE_FINALIZATION_BUNDLE_COLLISION");
  const operationId = `promotion-${await digest({ candidateId: payload.candidateId, bundleSha256, authorizationReceiptSha256: payload.authorizationReceiptSha256 })}`;
  await writeImmutable(join(root, "operations", `${operationId}.json`), `${canonicalJson({ version: 1, operationId, bundleSha256, authorizationReceiptSha256: payload.authorizationReceiptSha256, status: "pending" })}\n`, "RELEASE_FINALIZATION_OPERATION_COLLISION");
  const promotedPath = join(root, "operations", `${operationId}.promoted.json`);
  const unknownPath = join(root, "operations", `${operationId}.unknown.json`);
  const intentPath = join(root, "operations", `${operationId}.dispatch.json`);
  const claim = await claimFinalizationRecord(intentPath, { version: 1, operationId, bundleSha256, authorizationReceiptSha256: payload.authorizationReceiptSha256 });
  let promotion: Readonly<{ status: "promoted" | "blocked" }>;
  if (await exists(promotedPath)) promotion = { status: "promoted" };
  else if (!claim || await exists(unknownPath)) {
    // A process crash may leave only the pre-dispatch claim. Never infer that
    // the effect was not sent; query the original provider journal instead.
    let observed: "promoted" | "unknown" = "unknown";
    try { observed = await input.promotion.observe?.({ operationId, bundleSha256 }) ?? "unknown"; } catch { /* remains unknown */ }
    promotion = { status: observed === "promoted" ? "promoted" : "blocked" };
  } else {
    try {
      promotion = await resumeFinalizationPromotion({ operationId, bundleSha256, authorizationReceiptSha256: payload.authorizationReceiptSha256,
        status: "pending", verificationAuthority: { path: trust.configPath, sha256: trust.configSha256 }, persist: value => input.promotion.persist(value), promote: value => input.promotion.promote(value) });
    } catch { promotion = { status: "blocked" }; }
  }
  if (promotion.status !== "promoted") {
    if (!await exists(unknownPath)) {
      await writeImmutable(unknownPath, `${canonicalJson({ version: 1, operationId, bundleSha256, status: "unknown" })}\n`, "RELEASE_FINALIZATION_PROMOTION_COLLISION");
    }
    return { status: "blocked", bundleSha256, operationId, decision };
  }
  if (!await exists(promotedPath)) {
    await writeImmutable(promotedPath, `${canonicalJson({ version: 1, operationId, bundleSha256, status: "promoted" })}\n`, "RELEASE_FINALIZATION_PROMOTION_COLLISION");
  }
  const completed = await completeFinalizationCleanup({ root, operationId, bundleSha256, effects: cleanup.effects, port: input.cleanup });
  if (!completed) return { status: "cleanup_incomplete", bundleSha256, operationId, decision };
  // A pointer visible to operator verification means both promotion and all
  // cleanup observations are durably complete.
  await advancePointer(join(root, "current.json"), `${canonicalJson({ version: 1, candidateId: payload.candidateId, bundleSha256, operationId })}\n`);
  return { status: "promoted", bundleSha256, operationId, decision, verificationConfig: { path: trust.configPath, sha256: trust.configSha256 } };
}
