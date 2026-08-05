import { mkdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { z } from "zod";
import { canonicalJson } from "../promotion/schema";
import { ReleaseObservationBindingSchema } from "./contracts";

const DigestSchema = z.string().regex(/^[a-f0-9]{64}$/iu).transform((value) => value.toLowerCase());
const IdentitySchema = z.string().regex(/^[a-z][a-z0-9._-]{2,127}$/u);
const EpochMsSchema = z.number().int().nonnegative().finite();

export const ProtectedBuildObservationSchema = z.object({
  version: z.literal(1), evidenceClass: z.literal("protected_live"), status: z.literal("passed"), candidateId: DigestSchema,
  releaseBinding: ReleaseObservationBindingSchema, isolationId: IdentitySchema, runId: IdentitySchema,
  sourceSha256: DigestSchema, lockSha256: DigestSchema, toolchainSha256: DigestSchema, datasetSha256: DigestSchema,
  outputArtifactSha256: DigestSchema, runnerEvidenceSha256: DigestSchema, startedAtMs: EpochMsSchema, completedAtMs: EpochMsSchema,
}).strict().superRefine((value, context) => {
  if (value.completedAtMs < value.startedAtMs) context.addIssue({ code: "custom", message: "build observation chronology is invalid" });
  if (!value.sourceSha256.startsWith(value.releaseBinding.sourceRevision)) context.addIssue({ code: "custom", message: "build source does not bind the release revision" });
  if (value.lockSha256 !== value.releaseBinding.inputs.packageLockSha256 || value.toolchainSha256 !== value.releaseBinding.inputs.toolchainSha256 || value.datasetSha256 !== value.releaseBinding.inputs.datasetSha256) {
    context.addIssue({ code: "custom", message: "build inputs do not bind the release" });
  }
});

const ReproducibilityInputSchema = z.object({
  version: z.literal(1), evidenceClass: z.literal("protected_live"), candidateId: DigestSchema, releaseBinding: ReleaseObservationBindingSchema,
  expectedArtifactSha256: DigestSchema, records: z.array(ProtectedBuildObservationSchema).length(2), assembledAtMs: EpochMsSchema,
}).strict();

export const ReproducibilityRecordSchema = z.object({
  version: z.literal(1), evidenceClass: z.literal("protected_live"), status: z.literal("verified"), candidateId: DigestSchema,
  releaseBindingSha256: DigestSchema, expectedArtifactSha256: DigestSchema, buildEvidenceSha256: z.array(DigestSchema).length(2),
  isolationIdentitySha256: z.array(DigestSchema).length(2), runIdentitySha256: z.array(DigestSchema).length(2), completedAtMs: EpochMsSchema,
  evidenceSha256: DigestSchema, contentAddressedPath: z.string().regex(/^evidence\/certification\/reproducibility\/[a-f0-9]{64}\.json$/iu),
}).strict();
export type ReproducibilityRecord = z.infer<typeof ReproducibilityRecordSchema>;

async function sha256(value: unknown): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(typeof value === "string" ? value : canonicalJson(value)));
  return Array.from(new Uint8Array(digest), (byte) => byte.toString(16).padStart(2, "0")).join("");
}

function exactBinding(left: unknown, right: unknown): boolean { return canonicalJson(left) === canonicalJson(right); }

/** Validates two independently protected builds before producing any reusable release fact. */
export async function verifyReproducibilityRecord(input: unknown, options: Readonly<{ nowMs?: number; maxAgeMs?: number }> = {}): Promise<ReproducibilityRecord> {
  const parsed = ReproducibilityInputSchema.parse(input);
  const nowMs = options.nowMs ?? Date.now();
  const maxAgeMs = options.maxAgeMs ?? 24 * 60 * 60 * 1_000;
  if (!Number.isInteger(maxAgeMs) || maxAgeMs < 1) throw new Error("REPRODUCIBILITY_FRESHNESS_INVALID");
  const [first, second] = parsed.records;
  if (first!.candidateId !== parsed.candidateId || second!.candidateId !== parsed.candidateId || !exactBinding(first!.releaseBinding, parsed.releaseBinding) || !exactBinding(second!.releaseBinding, parsed.releaseBinding)) throw new Error("REPRODUCIBILITY_RELEASE_BINDING_INVALID");
  if (first!.isolationId === second!.isolationId || first!.runId === second!.runId) throw new Error("REPRODUCIBILITY_IDENTITIES_NOT_DISTINCT");
  if (first!.outputArtifactSha256 !== parsed.expectedArtifactSha256 || second!.outputArtifactSha256 !== parsed.expectedArtifactSha256) throw new Error("REPRODUCIBILITY_OUTPUT_MISMATCH");
  const completedAtMs = Math.max(first!.completedAtMs, second!.completedAtMs);
  if (parsed.assembledAtMs < completedAtMs) throw new Error("REPRODUCIBILITY_ASSEMBLY_CHRONOLOGY_INVALID");
  if (nowMs - completedAtMs > maxAgeMs) throw new Error("REPRODUCIBILITY_RECORD_STALE");
  const base = {
    version: 1 as const, evidenceClass: "protected_live" as const, status: "verified" as const, candidateId: parsed.candidateId,
    releaseBindingSha256: await sha256(parsed.releaseBinding), expectedArtifactSha256: parsed.expectedArtifactSha256,
    buildEvidenceSha256: [first!.runnerEvidenceSha256, second!.runnerEvidenceSha256].sort(),
    isolationIdentitySha256: (await Promise.all([sha256(first!.isolationId), sha256(second!.isolationId)])).sort(),
    runIdentitySha256: (await Promise.all([sha256(first!.runId), sha256(second!.runId)])).sort(), completedAtMs,
  };
  const evidenceSha256 = await sha256(base);
  return ReproducibilityRecordSchema.parse({ ...base, evidenceSha256, contentAddressedPath: `evidence/certification/reproducibility/${evidenceSha256}.json` });
}

/** Revalidates the finite persisted record at a later authority boundary. The
 * original protected build output is intentionally never reloaded or persisted. */
export async function validateReproducibilityVerificationRecord(value: unknown, expected: Readonly<{ candidateId: string; releaseBinding: unknown; artifactSha256: string; nowMs?: number; maxAgeMs?: number }>): Promise<ReproducibilityRecord> {
  const record = ReproducibilityRecordSchema.parse(value);
  const nowMs = expected.nowMs ?? Date.now(); const maxAgeMs = expected.maxAgeMs ?? 24 * 60 * 60 * 1_000;
  if (!Number.isInteger(maxAgeMs) || maxAgeMs < 1) throw new Error("REPRODUCIBILITY_FRESHNESS_INVALID");
  if (record.candidateId !== expected.candidateId.toLowerCase() || record.expectedArtifactSha256 !== expected.artifactSha256.toLowerCase()
    || record.releaseBindingSha256 !== await sha256(ReleaseObservationBindingSchema.parse(expected.releaseBinding))) throw new Error("REPRODUCIBILITY_RELEASE_BINDING_INVALID");
  if (nowMs - record.completedAtMs > maxAgeMs) throw new Error("REPRODUCIBILITY_RECORD_STALE");
  const { evidenceSha256, contentAddressedPath, ...base } = record;
  if (evidenceSha256 !== await sha256(base) || contentAddressedPath !== `evidence/certification/reproducibility/${evidenceSha256}.json`) throw new Error("REPRODUCIBILITY_RECORD_DIGEST_INVALID");
  return record;
}

/** Writes a redacted create-or-verify record; raw run identities and paths never reach disk. */
export async function writeReproducibilityRecord(directory: string, input: unknown, options: Readonly<{ nowMs?: number; maxAgeMs?: number }> = {}): Promise<ReproducibilityRecord> {
  const record = await verifyReproducibilityRecord(input, options);
  await mkdir(directory, { recursive: true });
  const path = join(directory, `${record.evidenceSha256}.json`);
  const content = `${canonicalJson(record)}\n`;
  try { await writeFile(path, content, { encoding: "utf8", flag: "wx" }); }
  catch (error) {
    if (!(error instanceof Error) || !("code" in error) || error.code !== "EEXIST") throw error;
    if (await readFile(path, "utf8") !== content) throw new Error("REPRODUCIBILITY_RECORD_COLLISION");
  }
  return record;
}
