import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { z } from "zod";
import { canonicalJson } from "../promotion/schema";
import { CertificationBundleSchema, CertificationObservationInputSchema, CertificationObservationSchema, type CertificationBundle, type CertificationObservation, type CertificationObservationInput } from "./contracts";
import { PHASE_07_AI_DIMENSIONS, PHASE_07_API_ROWS, PHASE_07_DECISIONS, PHASE_07_REQUIREMENTS, PHASE_07_THREATS, PHASE_07_UI_ROWS, phase07DatasetSha256, type Phase07Comparison, type Phase07ReferenceSet, validatePhase07ReferenceSet } from "./phase-07-reference-set";

async function digest(value: unknown): Promise<string> {
  const bytes = new TextEncoder().encode(canonicalJson(value));
  const hash = await crypto.subtle.digest("SHA-256", bytes);
  return Array.from(new Uint8Array(hash), (item) => item.toString(16).padStart(2, "0")).join("");
}

function observationPayload(value: CertificationObservation): Omit<CertificationObservation, "evidenceSha256"> {
  const { evidenceSha256: _digest, ...payload } = value;
  return payload;
}

/** Validates a standalone observation before it can satisfy a specific owned claim. */
export async function validateCertificationObservation(value: unknown, requirements?: Readonly<{ nowMs: number; candidateId?: string; requiredClaim?: string }>): Promise<CertificationObservation> {
  const parsed = CertificationObservationSchema.parse(value);
  if (await digest(observationPayload(parsed)) !== parsed.evidenceSha256) throw new Error("CERTIFICATION_OBSERVATION_DIGEST_INVALID");
  if (requirements?.candidateId && parsed.candidate.id !== requirements.candidateId) throw new Error("CERTIFICATION_OBSERVATION_CANDIDATE_INVALID");
  if (requirements?.nowMs !== undefined && parsed.expiresAtMs <= requirements.nowMs) throw new Error("CERTIFICATION_OBSERVATION_STALE");
  if (requirements?.requiredClaim && (parsed.status !== "passed" || !parsed.claims.includes(requirements.requiredClaim))) throw new Error("CERTIFICATION_CLAIM_UNSATISFIED");
  return parsed;
}

/** Immutable create-or-verify record write. Same bytes replay; different bytes never overwrite. */
export async function writeCertificationObservation(directory: string, input: CertificationObservationInput): Promise<CertificationObservation> {
  const payload = CertificationObservationInputSchema.parse(input);
  const observation = CertificationObservationSchema.parse({ ...payload, evidenceSha256: await digest(payload) });
  await validateCertificationObservation(observation);
  await mkdir(directory, { recursive: true });
  const content = `${canonicalJson(observation)}\n`;
  const path = join(directory, `${observation.evidenceSha256}.json`);
  try { await writeFile(path, content, { encoding: "utf8", flag: "wx" }); }
  catch (error) {
    if (!(error instanceof Error) || !("code" in error) || error.code !== "EEXIST") throw error;
    if (await readFile(path, "utf8") !== content) throw new Error("CERTIFICATION_OBSERVATION_COLLISION");
  }
  return observation;
}

/** Assembles an immutable bundle only from fresh passed records of the exact candidate, then atomically advances its pointer. */
export async function assembleCertificationBundle(directory: string, input: Readonly<{ candidateId: string; observations: readonly unknown[]; nowMs?: number; pointer?: string }>): Promise<CertificationBundle> {
  const nowMs = input.nowMs ?? Date.now();
  const observations = await Promise.all(input.observations.map((item) => validateCertificationObservation(item, { nowMs, candidateId: input.candidateId })));
  if (observations.some((item) => item.status !== "passed")) throw new Error("CERTIFICATION_BUNDLE_NON_PASS");
  const claims = [...new Set(observations.flatMap((item) => item.claims))].sort();
  if (claims.length === 0) throw new Error("CERTIFICATION_BUNDLE_CLAIMS_REQUIRED");
  const base = { version: 1 as const, candidateId: input.candidateId, observationDigests: observations.map((item) => item.evidenceSha256).sort(), claims, assembledAtMs: nowMs };
  const evidenceSha256 = await digest(base);
  const bundle = CertificationBundleSchema.parse({ ...base, evidenceSha256, pointer: `current/${evidenceSha256}.json` });
  await mkdir(directory, { recursive: true });
  const bundlePath = join(directory, `${bundle.evidenceSha256}.bundle.json`);
  const content = `${canonicalJson(bundle)}\n`;
  try { await writeFile(bundlePath, content, { encoding: "utf8", flag: "wx" }); }
  catch (error) { if (!(error instanceof Error) || !("code" in error) || error.code !== "EEXIST") throw error; if (await readFile(bundlePath, "utf8") !== content) throw new Error("CERTIFICATION_BUNDLE_COLLISION"); }
  const pointerDirectory = join(directory, "current"); await mkdir(pointerDirectory, { recursive: true });
  const pointerPath = join(directory, input.pointer ?? "current.json");
  const temporary = join(pointerDirectory, `.${bundle.evidenceSha256}.tmp`);
  await writeFile(temporary, `${canonicalJson({ bundle: bundle.evidenceSha256 })}\n`, { encoding: "utf8", flag: "wx" });
  await rename(temporary, pointerPath);
  return bundle;
}

const Phase07ComparisonSchema = z.object({ id: z.string(), status: z.enum(["passed", "failed"]), expected: z.object({ status: z.literal("passed"), value: z.string(), effects: z.object({ credit: z.number().int().nonnegative(), debit: z.number().int().nonnegative(), worker: z.number().int().nonnegative(), publication: z.number().int().nonnegative() }).strict() }).strict(), observed: z.object({ status: z.literal("passed"), value: z.string(), effects: z.object({ credit: z.number().int().nonnegative(), debit: z.number().int().nonnegative(), worker: z.number().int().nonnegative(), publication: z.number().int().nonnegative() }).strict() }).strict(), evidenceClass: z.literal("deterministic") }).strict();
const MappingSchema = z.record(z.string(), z.array(z.string()).min(1));
const Phase07EvidenceBaseSchema = z.object({
  version: z.literal(1), phase: z.literal("07"), evidenceClass: z.literal("deterministic_design"), offlineVerdict: z.literal("passed"), promotionVerdict: z.literal("blocked"),
  sourceRevision: z.string().regex(/^(?:[a-f0-9]{40}|[a-f0-9]{64})$/iu), datasetSha256: z.string().regex(/^[a-f0-9]{64}$/iu),
  commands: z.array(z.string().min(1)).length(2), caseComparisons: z.array(Phase07ComparisonSchema).length(64), aggregate: z.object({ cases: z.literal(64), passed: z.literal(64), blockedLive: z.number().int().positive(), effects: z.object({ credit: z.literal(0), debit: z.literal(0), worker: z.literal(0), publication: z.literal(0) }).strict() }).strict(),
  requirementMappings: MappingSchema, decisionMappings: MappingSchema, threatMappings: MappingSchema, apiMappings: MappingSchema, uiMappings: MappingSchema, aiMappings: MappingSchema,
  liveObservations: z.array(z.object({ owner: z.string(), status: z.enum(["blocked", "not_observed"]), claim: z.string(), inputDigest: z.string().regex(/^[a-f0-9]{64}$/iu), freshness: z.literal("protected_record_required"), limitation: z.string() }).strict()).min(1),
}).strict();
export const Phase07DesignEvidenceSchema = Phase07EvidenceBaseSchema.extend({ evidenceSha256: z.string().regex(/^[a-f0-9]{64}$/iu), contentAddressedPath: z.string().regex(/^evidence\/design\/[a-f0-9]{64}\.json$/iu) }).strict();
export type Phase07DesignEvidence = z.infer<typeof Phase07DesignEvidenceSchema>;

const phase07Payload = (evidence: Phase07DesignEvidence | Omit<Phase07DesignEvidence, "evidenceSha256" | "contentAddressedPath">) => {
  const { evidenceSha256: _digest, contentAddressedPath: _path, ...payload } = evidence as Phase07DesignEvidence;
  return payload;
};
const exactKeys = (value: Record<string, readonly string[]>, keys: readonly string[]) => Object.keys(value).length === keys.length && keys.every((key) => value[key]?.length);
function mappings(fixture: Phase07ReferenceSet, field: "requirements" | "decisions" | "threats" | "apiRows" | "uiRows" | "aiDimensions", keys: readonly string[]): Record<string, string[]> {
  return Object.fromEntries(keys.map((key) => [key, fixture.cases.filter((item) => (item[field] as readonly string[]).includes(key)).map((item) => item.id)]));
}

/** Build deterministic evidence only after every actual comparator result has passed. */
export async function buildPhase07DesignEvidence(input: Readonly<{ fixture: unknown; comparisons: readonly Phase07Comparison[]; sourceRevision: string }>): Promise<Phase07DesignEvidence> {
  const fixture = validatePhase07ReferenceSet(input.fixture);
  const comparisons = z.array(Phase07ComparisonSchema).length(64).parse(input.comparisons);
  if (comparisons.some((item) => item.status !== "passed" || canonicalJson(item.expected) !== canonicalJson(item.observed)) || new Set(comparisons.map((item) => item.id)).size !== 64 || comparisons.some((item) => !fixture.cases.some((caseValue) => caseValue.id === item.id))) throw new Error("PHASE07_EVIDENCE_COMPARISON_INVALID");
  const base = {
    version: 1 as const, phase: "07" as const, evidenceClass: "deterministic_design" as const, offlineVerdict: "passed" as const, promotionVerdict: "blocked" as const,
    sourceRevision: z.string().regex(/^(?:[a-f0-9]{40}|[a-f0-9]{64})$/iu).parse(input.sourceRevision).toLowerCase(), datasetSha256: phase07DatasetSha256(fixture),
    commands: ["bun run eval:phase07", "bun run verify:phase07-evidence"] as const, caseComparisons: [...comparisons].sort((a, b) => a.id.localeCompare(b.id)),
    aggregate: { cases: 64 as const, passed: 64 as const, blockedLive: fixture.liveObservations.length, effects: { credit: 0 as const, debit: 0 as const, worker: 0 as const, publication: 0 as const } },
    requirementMappings: mappings(fixture, "requirements", PHASE_07_REQUIREMENTS), decisionMappings: mappings(fixture, "decisions", PHASE_07_DECISIONS), threatMappings: mappings(fixture, "threats", PHASE_07_THREATS), apiMappings: mappings(fixture, "apiRows", PHASE_07_API_ROWS), uiMappings: mappings(fixture, "uiRows", PHASE_07_UI_ROWS), aiMappings: mappings(fixture, "aiDimensions", PHASE_07_AI_DIMENSIONS),
    liveObservations: fixture.liveObservations.map((item) => ({ ...item })),
  };
  if (!exactKeys(base.requirementMappings, PHASE_07_REQUIREMENTS) || !exactKeys(base.decisionMappings, PHASE_07_DECISIONS) || !exactKeys(base.threatMappings, PHASE_07_THREATS) || !exactKeys(base.apiMappings, PHASE_07_API_ROWS) || !exactKeys(base.uiMappings, PHASE_07_UI_ROWS) || !exactKeys(base.aiMappings, PHASE_07_AI_DIMENSIONS)) throw new Error("PHASE07_EVIDENCE_MAPPING_INVALID");
  const evidenceSha256 = await digest(base);
  return Phase07DesignEvidenceSchema.parse({ ...base, evidenceSha256, contentAddressedPath: `evidence/design/${evidenceSha256}.json` });
}

export async function validatePhase07DesignEvidence(input: unknown): Promise<Phase07DesignEvidence> {
  const evidence = Phase07DesignEvidenceSchema.parse(input);
  if (await digest(phase07Payload(evidence)) !== evidence.evidenceSha256 || evidence.contentAddressedPath !== `evidence/design/${evidence.evidenceSha256}.json`) throw new Error("PHASE07_EVIDENCE_DIGEST_INVALID");
  if (!exactKeys(evidence.requirementMappings, PHASE_07_REQUIREMENTS) || !exactKeys(evidence.decisionMappings, PHASE_07_DECISIONS) || !exactKeys(evidence.threatMappings, PHASE_07_THREATS) || !exactKeys(evidence.apiMappings, PHASE_07_API_ROWS) || !exactKeys(evidence.uiMappings, PHASE_07_UI_ROWS) || !exactKeys(evidence.aiMappings, PHASE_07_AI_DIMENSIONS)) throw new Error("PHASE07_EVIDENCE_MAPPING_INVALID");
  if (evidence.promotionVerdict !== "blocked" || evidence.liveObservations.some((item) => item.status === "blocked" ? !item.limitation : item.status !== "not_observed")) throw new Error("PHASE07_EVIDENCE_LIVE_HONESTY_INVALID");
  return evidence;
}

/** Content-addressed create-or-verify record plus atomic stable pointer update. */
export async function writePhase07DesignEvidence(directory: string, input: Readonly<{ fixture: unknown; comparisons: readonly Phase07Comparison[]; sourceRevision: string }>): Promise<Phase07DesignEvidence> {
  const evidence = await buildPhase07DesignEvidence(input); await validatePhase07DesignEvidence(evidence);
  await mkdir(directory, { recursive: true });
  const immutablePath = join(directory, `${evidence.evidenceSha256}.json`); const immutableBytes = `${canonicalJson(evidence)}\n`;
  try { await writeFile(immutablePath, immutableBytes, { encoding: "utf8", flag: "wx" }); }
  catch (error) { if (!(error instanceof Error) || !("code" in error) || error.code !== "EEXIST") throw error; if (await readFile(immutablePath, "utf8") !== immutableBytes) throw new Error("PHASE07_EVIDENCE_COLLISION"); }
  const pointer = { version: 1, phase: "07", evidenceSha256: evidence.evidenceSha256, contentAddressedPath: evidence.contentAddressedPath, offlineVerdict: evidence.offlineVerdict, promotionVerdict: evidence.promotionVerdict };
  const temporary = join(directory, `.phase-07.${evidence.evidenceSha256}.tmp`); await writeFile(temporary, `${canonicalJson(pointer)}\n`, { encoding: "utf8", flag: "wx" }); await rename(temporary, join(directory, "phase-07.json"));
  return evidence;
}
