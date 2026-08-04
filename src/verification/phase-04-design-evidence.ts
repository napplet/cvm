import { mkdir, readFile, writeFile } from "node:fs/promises";
import { z } from "zod";
import { canonicalJson } from "../promotion/schema";

const SHA256 = /^[a-f0-9]{64}$/iu;
const CHECK_IDS = ["reference-set", "metered-authority", "reconciliation", "artifact-honesty", "owner-status", "contextvm-boundary"] as const;
const CASE_IDS = ["P04-AUTH-01", "P04-AUTH-02", "P04-AUTH-03", "P04-AUTH-04", "P04-ACCT-01", "P04-ACCT-02", "P04-ACCT-03", "P04-ACCT-04", "P04-SER-01", "P04-SER-02", "P04-SER-03", "P04-AMB-01", "P04-AMB-02", "P04-AMB-03", "P04-ART-01", "P04-ART-02", "P04-ART-03", "P04-ADV-01", "P04-ADV-02", "P04-STATUS-01"] as const;
const REQUIREMENTS = ["BILL-03", "BILL-04", "BILL-05", "SESS-01", "SESS-03", "SESS-04", "GEN-05", "GEN-06"] as const;
const DECISIONS = Array.from({ length: 20 }, (_, index) => `D-${index + 59}`);
const THREATS = ["T-04-ADAPTER", "T-04-AMBIGUITY", "T-04-ATOMIC", "T-04-AUTHORITY", "T-04-BLOCK", "T-04-DIAGNOSTIC", "T-04-DISCLOSE", "T-04-DOUBLE", "T-04-EFFECT", "T-04-EVIDENCE", "T-04-EVIDENCE-LEAK", "T-04-HISTORY-DOS", "T-04-HONESTY", "T-04-INJECTION", "T-04-INPUT", "T-04-MISMATCH", "T-04-NATIVE", "T-04-ORACLE", "T-04-PRICE", "T-04-QUARANTINE", "T-04-RACE", "T-04-READINESS", "T-04-REPAIR", "T-04-REPLAY", "T-04-RETRY", "T-04-SC", "T-04-STATUS-LEAK", "T-04-STATUS-OWNER"] as const;
const DEFERRALS = ["live-provider-selection", "live-provider-certification", "provider-latency-availability-cost-certification", "preview-and-publication", "phase-07-slo-chaos-certification"] as const;
const RUNTIME_FIELDS = ["providerDispatches", "providerLookups", "workerCalls", "receiptWrites", "debitPostings", "creditPostings", "releases", "actionState", "sessionState", "artifactVersion", "evidence", "providerSelection", "status", "nextAction"] as const;

export const Phase04DesignEvidenceSchema = z.object({
  version: z.literal(1), certificationProfile: z.literal("design"), verdict: z.enum(["design-ready", "blocked"]), offlineVerdict: z.enum(["passed", "blocked"]), evidenceSha256: z.string().regex(SHA256),
});
export const Phase04RuntimeObservationSchema = z.object({
  providerDispatches: z.number().int().nonnegative(), providerLookups: z.number().int().nonnegative(), workerCalls: z.number().int().nonnegative(), receiptWrites: z.number().int().nonnegative(), debitPostings: z.number().int().nonnegative(), creditPostings: z.number().int().nonnegative(), releases: z.number().int().nonnegative(),
  actionState: z.string().min(1), sessionState: z.string().min(1), artifactVersion: z.number().int().nonnegative(), evidence: z.string().min(1), providerSelection: z.literal("unselected"), status: z.string().min(1), nextAction: z.string().min(1),
}).strict();
export const Phase04CaseComparisonSchema = z.object({ id: z.enum(CASE_IDS), expected: Phase04RuntimeObservationSchema, observed: Phase04RuntimeObservationSchema }).strict();
export type Phase04Check = Readonly<{ id: typeof CHECK_IDS[number]; severity: "critical" | "high"; status: "passed" | "failed" | "blocked"; evidenceSha256: string }>;
export type Phase04Observation = Readonly<{ provider: "deterministic_gateway" | "live_model"; status: "passed" | "not_observed"; selection: "unselected"; evidenceSha256: string; limitations: readonly string[] }>;
export type Phase04RuntimeObservation = z.infer<typeof Phase04RuntimeObservationSchema>;
export type Phase04CaseComparison = z.infer<typeof Phase04CaseComparisonSchema>;
export type Phase04DesignInput = Readonly<{
  identities: Readonly<{ referenceSet: string; meteredService: string; gateway: string; reconciliation: string; status: string; adapter: string }>;
  checks: readonly Phase04Check[];
  caseComparisons: readonly Phase04CaseComparison[];
  requirementMappings: Readonly<Record<string, readonly string[]>>;
  decisionMappings: readonly string[];
  threatMappings: readonly string[];
  observations: readonly Phase04Observation[];
}>;
export type Phase04DesignEvidence = Readonly<Omit<Phase04DesignInput, "caseComparisons"> & { caseComparisons: readonly (Phase04CaseComparison & Readonly<{ status: "passed" | "failed"; mismatches: readonly (typeof RUNTIME_FIELDS[number])[] }>)[]; caseResults: readonly Readonly<{ id: typeof CASE_IDS[number]; status: "passed" | "failed" }>[]; aggregateEffects?: Readonly<Record<Extract<typeof RUNTIME_FIELDS[number], "providerDispatches" | "providerLookups" | "workerCalls" | "receiptWrites" | "debitPostings" | "creditPostings" | "releases">, number>>; version: 1; certificationProfile: "design"; verdict: "design-ready" | "blocked"; offlineVerdict: "passed" | "blocked"; deferrals: readonly typeof DEFERRALS[number][]; evidenceSha256: string }>;
export type Phase04DesignDecision = Readonly<{ evidence: Phase04DesignEvidence; reasons: readonly string[] }>;

function isRecord(value: unknown): value is Record<string, unknown> { return value !== null && typeof value === "object" && !Array.isArray(value); }
function digest(value: unknown): Promise<string> { return crypto.subtle.digest("SHA-256", new TextEncoder().encode(canonicalJson(value))).then((hash) => Array.from(new Uint8Array(hash), (byte) => byte.toString(16).padStart(2, "0")).join("")); }
function exact(values: readonly string[], expected: readonly string[]): boolean { return values.length === expected.length && new Set(values).size === expected.length && expected.every((value) => values.includes(value)); }
function add(reasons: string[], reason: string): void { if (!reasons.includes(reason)) reasons.push(reason); }
function forbidden(value: unknown): boolean {
  if (typeof value === "string") return /(?:\bbearer\b|\bsecret\b|\bprivate(?:[_ -]?key)?\b|\bcredential\b|\btoken\b|\bgrant\b|\bprompt\b|\breasoning\b|generated[_ -]?source|provider[_ -]?native|internal[_ -]?capability|preview[_ -]?(?:ready|url)|publish[_ -]?(?:ready|url)|live[_ -]?selected)/iu.test(value);
  if (Array.isArray(value)) return value.some(forbidden);
  return isRecord(value) && Object.entries(value).some(([key, nested]) => /(?:prompt|source|reasoning|credential|grant|provider.?native|internal.?capability|preview|publish)/iu.test(key) || forbidden(nested));
}
function deriveComparisons(value: unknown): readonly (Phase04CaseComparison & Readonly<{ status: "passed" | "failed"; mismatches: readonly (typeof RUNTIME_FIELDS[number])[] }>)[] {
  if (!Array.isArray(value)) return [];
  return value.map((comparison) => {
    const parsed = Phase04CaseComparisonSchema.parse(comparison);
    const mismatches = RUNTIME_FIELDS.filter((field) => parsed.expected[field] !== parsed.observed[field]);
    return Object.freeze({ ...parsed, status: mismatches.length === 0 ? "passed" as const : "failed" as const, mismatches: Object.freeze(mismatches) });
  });
}
function aggregateObservedEffects(comparisons: readonly (Phase04CaseComparison & Readonly<{ status: "passed" | "failed" }>)[]) {
  if (comparisons.length !== CASE_IDS.length || comparisons.some((comparison) => comparison.status !== "passed")) return undefined;
  return Object.freeze({ providerDispatches: comparisons.reduce((sum, item) => sum + item.observed.providerDispatches, 0), providerLookups: comparisons.reduce((sum, item) => sum + item.observed.providerLookups, 0), workerCalls: comparisons.reduce((sum, item) => sum + item.observed.workerCalls, 0), receiptWrites: comparisons.reduce((sum, item) => sum + item.observed.receiptWrites, 0), debitPostings: comparisons.reduce((sum, item) => sum + item.observed.debitPostings, 0), creditPostings: comparisons.reduce((sum, item) => sum + item.observed.creditPostings, 0), releases: comparisons.reduce((sum, item) => sum + item.observed.releases, 0) });
}

/** Evaluates only the deterministic Phase 4 proof, keeping live-provider certification explicitly deferred. */
export async function evaluatePhase04Design(input: Phase04DesignInput): Promise<Phase04DesignDecision> {
  const reasons: string[] = [];
  if (!input || !isRecord(input)) add(reasons, "Phase 04 design input is malformed");
  if (!input?.identities || input.identities.referenceSet !== "tests/fixtures/phase-04-reference-set.json" || input.identities.meteredService !== "src/phase-04/metered-generation-service.ts" || input.identities.gateway !== "src/model/deterministic-model-gateway.ts" || input.identities.reconciliation !== "src/model/reconciliation.ts" || input.identities.status !== "src/phase-04/session-status.ts" || input.identities.adapter !== "src/contextvm/adapter.ts") add(reasons, "Phase 04 authority identity set is invalid");
  if (forbidden(input)) add(reasons, "Phase 04 evidence contains forbidden disclosure or readiness claim");
  if (!Array.isArray(input?.checks) || !exact(input.checks.map((item) => item.id), CHECK_IDS)) add(reasons, "Phase 04 deterministic check identity set is incomplete, duplicate, or unknown");
  for (const check of input?.checks ?? []) if (!CHECK_IDS.includes(check.id) || !["critical", "high"].includes(check.severity) || check.status !== "passed" || !SHA256.test(check.evidenceSha256)) add(reasons, `Phase 04 check ${String(check.id)} is malformed or not passed`);
  let comparisons: readonly (Phase04CaseComparison & Readonly<{ status: "passed" | "failed"; mismatches: readonly (typeof RUNTIME_FIELDS[number])[] }>)[] = [];
  try { comparisons = deriveComparisons(input?.caseComparisons); }
  catch { add(reasons, "Phase 04 runtime comparison is malformed"); }
  if (!exact(comparisons.map((item) => item.id), CASE_IDS) || comparisons.some((item) => item.status !== "passed")) add(reasons, "Phase 04 runtime comparison set is incomplete or mismatched");
  if (!input?.requirementMappings || !exact(Object.keys(input.requirementMappings), REQUIREMENTS) || Object.values(input.requirementMappings).some((ids) => !Array.isArray(ids) || ids.length === 0 || ids.some((id) => !CASE_IDS.includes(id as typeof CASE_IDS[number])))) add(reasons, "Phase 04 requirement mappings are incomplete or invalid");
  if (!Array.isArray(input?.decisionMappings) || !exact(input.decisionMappings, DECISIONS)) add(reasons, "Phase 04 decision mappings are incomplete, duplicate, or unknown");
  if (!Array.isArray(input?.threatMappings) || !exact(input.threatMappings, THREATS)) add(reasons, "Phase 04 threat mappings are incomplete, duplicate, or unknown");
  if (!Array.isArray(input?.observations) || !exact(input.observations.map((item) => item.provider), ["deterministic_gateway", "live_model"])) add(reasons, "Phase 04 provider observations are incomplete, duplicate, or unknown");
  for (const observation of input?.observations ?? []) {
    if (!SHA256.test(observation.evidenceSha256) || observation.selection !== "unselected" || !Array.isArray(observation.limitations)) add(reasons, "Phase 04 provider observation is malformed or selected");
    if (observation.provider === "deterministic_gateway" && observation.status !== "passed") add(reasons, "deterministic gateway observation must pass without selection");
    if (observation.provider === "live_model" && observation.status !== "not_observed") add(reasons, "live model observation must remain not observed and unselected");
  }
  const aggregateEffects = aggregateObservedEffects(comparisons);
  if (!aggregateEffects) add(reasons, "Phase 04 observed aggregate is unavailable until every runtime comparison passes");
  const offlineVerdict = reasons.length === 0 ? "passed" as const : "blocked" as const;
  const withoutDigest = { version: 1 as const, certificationProfile: "design" as const, verdict: offlineVerdict === "passed" ? "design-ready" as const : "blocked" as const, offlineVerdict, identities: Object.freeze({ ...input.identities }), checks: Object.freeze(input.checks.map((item) => Object.freeze({ ...item }))), caseComparisons: Object.freeze(comparisons.map((item) => Object.freeze({ ...item, expected: Object.freeze({ ...item.expected }), observed: Object.freeze({ ...item.observed }), mismatches: Object.freeze([...item.mismatches]) }))), caseResults: Object.freeze(comparisons.map((item) => Object.freeze({ id: item.id, status: item.status }))), requirementMappings: Object.freeze(Object.fromEntries(Object.entries(input.requirementMappings).map(([key, value]) => [key, Object.freeze([...value])]))), decisionMappings: Object.freeze([...input.decisionMappings]), threatMappings: Object.freeze([...input.threatMappings]), ...(aggregateEffects ? { aggregateEffects } : {}), observations: Object.freeze(input.observations.map((item) => Object.freeze({ ...item, limitations: Object.freeze([...item.limitations]) }))), deferrals: Object.freeze([...DEFERRALS]) };
  return Object.freeze({ evidence: Object.freeze({ ...withoutDigest, evidenceSha256: await digest(withoutDigest) }), reasons: Object.freeze(reasons) });
}

/** Strictly re-evaluates a loaded record, rejecting collision, tamper, redaction, and readiness overclaims. */
export async function validatePhase04DesignEvidence(evidence: Phase04DesignEvidence): Promise<void> {
  if (!Phase04DesignEvidenceSchema.safeParse(evidence).success || forbidden(evidence) || !exact(evidence.deferrals, DEFERRALS)) throw new Error("Phase 04 design evidence schema, redaction, or deferral validation failed");
  const { evidenceSha256, version: _version, certificationProfile: _profile, verdict: _verdict, offlineVerdict: _offline, deferrals: _deferrals, ...input } = evidence;
  const evaluated = await evaluatePhase04Design(input);
  if (evaluated.evidence.evidenceSha256 !== evidenceSha256 || evaluated.evidence.verdict !== evidence.verdict || evaluated.evidence.offlineVerdict !== evidence.offlineVerdict) throw new Error("Phase 04 design evidence deterministic proof is invalid");
}

/** Writes a canonical content-addressed record once, or verifies identical bytes when it already exists. */
export async function writePhase04DesignEvidence(directory: string, input: Phase04DesignInput): Promise<Phase04DesignEvidence> {
  const { evidence } = await evaluatePhase04Design(input);
  await validatePhase04DesignEvidence(evidence);
  await mkdir(directory, { recursive: true });
  const content = `${canonicalJson(evidence)}\n`;
  const path = `${directory}/${evidence.evidenceSha256}.json`;
  try { await writeFile(path, content, { encoding: "utf8", flag: "wx" }); }
  catch (error) {
    if (!(error instanceof Error) || !("code" in error) || error.code !== "EEXIST") throw error;
    if (await readFile(path, "utf8") !== content) throw new Error("immutable Phase 04 design evidence collision");
  }
  return evidence;
}
