import { createHash } from "node:crypto";
import { lstat, readFile, realpath } from "node:fs/promises";
import { isAbsolute, join, relative, resolve, sep } from "node:path";
import { z } from "zod";
import type { ProtectedCertifierConfig } from "../certification/config";
import { validateCertificationObservation } from "../certification/evidence";
import { PROTECTED_SUITES } from "../certification/runner";
import { loadPinnedReleaseCertificationTrustRoot } from "../certification/trust";
import { evaluateReleaseCertification } from "../promotion/run-promotion";
import { canonicalJson, parseReleaseCertificationManifest } from "../promotion/schema";
import { verifyFinalizationCleanup } from "./finalization-cleanup";

const Digest = z.string().regex(/^[a-f0-9]{64}$/u);
const Bundle = z.object({
  version: z.literal(1), candidateId: Digest, topologySha256: Digest, authorizationReceiptSha256: Digest,
  bundleSha256: Digest, evidenceRootSha256: Digest, releaseManifest: z.unknown(),
  protectedRecords: z.array(z.unknown()).length(PROTECTED_SUITES.length), evaluatorVerdict: z.unknown(),
  trustRoot: z.object({ configSha256: Digest, moduleSha256: Digest, materialPath: z.string() }).strict(),
  verificationRecords: z.object({ reproducibility: z.unknown(), supplyChain: z.unknown() }).strict(),
  sourceMeasurement: z.unknown(),
  selectedWorker: z.object({ provider: z.enum(["modal", "fly"]), selectionEvidenceSha256: Digest }).strict().nullable(),
  receipts: z.array(z.string()), attestations: z.array(z.string()),
  cleanupPlan: z.object({ cleanupByMs: z.number().int().positive(), retainedEvidenceDays: z.number().int().min(30), retainedArtifactDays: z.number().int().min(30), effects: z.array(z.object({ providerOperationId: z.string().min(1), resourceIdentitySha256: Digest }).strict()) }).strict(),
}).strict();
const digest = (value: unknown) => createHash("sha256").update(canonicalJson(value)).digest("hex");

async function safeRead(workspace: string, path: string): Promise<unknown> {
  const root = resolve(workspace);
  const rel = relative(root, path);
  if (!isAbsolute(workspace) || rel === "" || rel === ".." || rel.startsWith(`..${sep}`) || isAbsolute(rel) || (await lstat(root)).isSymbolicLink()) throw new Error("RELEASE_FINALIZATION_PATH_REJECTED");
  let current = root;
  for (const part of rel.split(sep)) {
    current = join(current, part);
    if ((await lstat(current)).isSymbolicLink()) throw new Error("RELEASE_FINALIZATION_PATH_REJECTED");
  }
  const stat = await lstat(path);
  if (!stat.isFile() || stat.size > 32 * 1024 * 1024 || relative(await realpath(root), await realpath(path)) !== rel) throw new Error("RELEASE_FINALIZATION_PATH_REJECTED");
  return JSON.parse(await readFile(path, "utf8"));
}

/** The opaque handle selects data under the controller workspace. Authority
 * comes exclusively from the independently loaded, digest-pinned config;
 * neither bundle paths nor embedded module/config hashes select executable code. */
export async function verifyFinalizedRelease(input: Readonly<{
  workspace: string; bundleSha256: string; config: ProtectedCertifierConfig; configSha256: string; nowMs?: number;
}>) {
  const controller = input.config.controller;
  if (!Digest.safeParse(input.bundleSha256).success || !Digest.safeParse(input.configSha256).success || !controller || !input.config.trustRoot) throw new Error("RELEASE_FINALIZATION_AUTHORITY_REQUIRED");
  const root = join(resolve(input.workspace), "release-finalizations", controller.candidateId);
  const bundle = Bundle.parse(await safeRead(input.workspace, join(root, "bundles", `${input.bundleSha256}.json`)));
  const { bundleSha256, ...payload } = bundle;
  if (digest(payload) !== input.bundleSha256 || bundleSha256 !== input.bundleSha256) throw new Error("RELEASE_FINALIZATION_BUNDLE_DIGEST_INVALID");
  if (bundle.candidateId !== controller.candidateId || bundle.topologySha256 !== controller.topologySha256 || bundle.authorizationReceiptSha256 !== controller.authorizationReceiptSha256
    || bundle.trustRoot.configSha256 !== input.configSha256 || bundle.trustRoot.moduleSha256 !== input.config.trustRoot.sha256) throw new Error("RELEASE_FINALIZATION_BINDING_REJECTED");
  const manifest = parseReleaseCertificationManifest(bundle.releaseManifest);
  if (manifest.releaseId !== controller.releaseId || manifest.sourceRevision !== controller.sourceRevision || manifest.sourceSha256 !== controller.sourceSha256) throw new Error("RELEASE_FINALIZATION_BINDING_REJECTED");
  const records = await Promise.all(bundle.protectedRecords.map((record) => validateCertificationObservation(record, { candidateId: bundle.candidateId, nowMs: input.nowMs ?? Date.now() })));
  const suites = records.map((record) => record.input.command[1]?.replace("suite:", ""));
  if (new Set(suites).size !== PROTECTED_SUITES.length || PROTECTED_SUITES.some((suite) => !suites.includes(suite))
    || records.some((record) => record.evidenceClass !== "protected_live" || record.status !== "passed" || record.input.topologySha256 !== bundle.topologySha256)
    || digest(records.map((record) => record.evidenceSha256)) !== bundle.evidenceRootSha256) throw new Error("RELEASE_FINALIZATION_EVIDENCE_INVALID");
  const operationId = `promotion-${digest({ candidateId: bundle.candidateId, bundleSha256, authorizationReceiptSha256: bundle.authorizationReceiptSha256 })}`;
  const promoted = await safeRead(input.workspace, join(root, "operations", `${operationId}.promoted.json`));
  if (canonicalJson(promoted) !== canonicalJson({ version: 1, operationId, bundleSha256, status: "promoted" })) throw new Error("RELEASE_FINALIZATION_PROMOTION_REQUIRED");
  // Check each cleanup file through the same no-symlink boundary before the
  // cleanup verifier compares its exact original-operation receipt.
  for (const effect of bundle.cleanupPlan.effects) await safeRead(input.workspace, join(root, "cleanup", `${digest(`${operationId}:cleanup:${effect.providerOperationId}`)}.json`));
  await safeRead(input.workspace, join(root, "completed", `${bundleSha256}.json`));
  await verifyFinalizationCleanup({ root, operationId, bundleSha256, effects: bundle.cleanupPlan.effects });
  const trustRoot = await loadPinnedReleaseCertificationTrustRoot(input.config.trustRoot);
  const decision = await evaluateReleaseCertification(manifest, records, { candidateId: bundle.candidateId, nowMs: input.nowMs, sourceMeasurement: bundle.sourceMeasurement, verificationRecords: bundle.verificationRecords, trustRoot });
  // Re-evaluate the actual records; a stored success flag carries no authority.
  if (decision.status === "promoted" && canonicalJson(decision) !== canonicalJson(bundle.evaluatorVerdict)) throw new Error("RELEASE_FINALIZATION_VERDICT_MISMATCH");
  return Object.freeze({ ...decision, bundleSha256, cleanup: "completed" as const });
}
