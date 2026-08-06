import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { dirname, join, relative, resolve, sep } from "node:path";
import { pathToFileURL } from "node:url";
import { canonicalJson, parseReleaseCertificationManifest } from "../promotion/schema";
import { evaluateReleaseCertification, type ReleaseCertificationDecision, type ReleaseVerificationRecords } from "../promotion/run-promotion";
import { validateCertificationObservation, type CertificationObservation } from "../certification/evidence";
import { PROTECTED_SUITES } from "../certification/runner";
import { finalizeProtectedTrustRoot, type FinalizeProtectedTrustRootInput, type FinalizedProtectedTrustRoot } from "./materialize-certifier";

const DIGEST = /^[a-f0-9]{64}$/iu;
const safeDigest = (value: unknown): value is string => typeof value === "string" && DIGEST.test(value);

export type ReleaseFinalizationPromotionPort = Readonly<{
  /** Durable original-operation journal write. It must happen before promote. */
  persist(input: Readonly<{ operationId: string; bundleSha256: string; authorizationReceiptSha256: string }>): Promise<void>;
  /** The only pointer-changing effect. Replays use the same operation identity. */
  promote(input: Readonly<{ operationId: string; bundleSha256: string }>): Promise<"promoted" | "unknown">;
}>;

export type ReleaseFinalizationCleanupPort = Readonly<{
  cleanup(input: Readonly<{ operationId: string; providerOperationId: string; resourceIdentitySha256: string }>): Promise<"cleaned" | "retained" | "unknown">;
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
}>;

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
  try { await writeFile(path, contents, { encoding: "utf8", flag: "wx", mode: 0o600 }); }
  catch (error) {
    if (!(error instanceof Error) || !("code" in error) || error.code !== "EEXIST") throw error;
    if (await readFile(path, "utf8") !== contents) throw new Error(collision);
  }
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
  const module = await import(`${pathToFileURL(value.trustRoot.modulePath).href}?bundle=${value.trustRoot.sha256}`) as { protectedReleaseCertificationTrustRoot?: Parameters<typeof evaluateReleaseCertification>[2]["trustRoot"] };
  if (!module.protectedReleaseCertificationTrustRoot) throw new Error("RELEASE_FINALIZATION_TRUST_ROOT_INVALID");
  return module.protectedReleaseCertificationTrustRoot;
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
  const trust = await finalizeProtectedTrustRoot({ ...input.trust, workspace, candidateId: input.candidateId, topologySha256: input.topologySha256, authorizationReceiptSha256: input.authorizationReceiptSha256, observations: records });
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
  if (!await exists(promotedPath)) {
    await input.promotion.persist({ operationId, bundleSha256, authorizationReceiptSha256: payload.authorizationReceiptSha256 });
    const promoted = await input.promotion.promote({ operationId, bundleSha256 });
    if (promoted !== "promoted") return { status: "blocked", bundleSha256, operationId, decision };
    await writeImmutable(promotedPath, `${canonicalJson({ version: 1, operationId, bundleSha256, status: "promoted" })}\n`, "RELEASE_FINALIZATION_PROMOTION_COLLISION");
  }
  await advancePointer(join(root, "current.json"), `${canonicalJson({ version: 1, candidateId: payload.candidateId, bundleSha256, operationId })}\n`);

  if (!input.cleanup || cleanup.effects.length === 0) return { status: "promoted", bundleSha256, operationId, decision };
  const results = await Promise.all(cleanup.effects.map(async (effect) => {
    const cleanupOperationId = `${operationId}:cleanup:${effect.providerOperationId}`;
    const observationPath = join(root, "cleanup", `${await digest(cleanupOperationId)}.json`);
    if (await exists(observationPath)) {
      const stored = JSON.parse(await readFile(observationPath, "utf8")) as { result?: "cleaned" | "retained" | "unknown" };
      if (stored.result === "cleaned" || stored.result === "retained" || stored.result === "unknown") return stored.result;
      throw new Error("RELEASE_FINALIZATION_CLEANUP_COLLISION");
    }
    const result = await input.cleanup!.cleanup({ operationId: cleanupOperationId, ...effect });
    await writeImmutable(observationPath, `${canonicalJson({ version: 1, operationId: cleanupOperationId, providerOperationId: effect.providerOperationId, result })}\n`, "RELEASE_FINALIZATION_CLEANUP_COLLISION");
    return result;
  }));
  return results.every((result) => result === "cleaned" || result === "retained")
    ? { status: "promoted", bundleSha256, operationId, decision }
    : { status: "cleanup_incomplete", bundleSha256, operationId, decision };
}
