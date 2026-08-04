import { mkdir, readFile, writeFile } from "node:fs/promises";
import { canonicalJson } from "../promotion/schema";

const SHA256 = /^[a-f0-9]{64}$/iu;
const REQUIRED_CHECK_IDS = ["contextvm", "ledger", "lightning", "cashu", "funded-admission", "reference-set", "package-intake", "api-coverage"] as const;
const REQUIRED_REQUIREMENTS = ["CTX-01", "CTX-02", "CTX-03", "CTX-04", "PAY-01", "PAY-02", "PAY-03", "PAY-04", "PAY-05", "PAY-06", "PAY-07", "BILL-01", "BILL-02", "BILL-06"] as const;
const REQUIRED_DECISIONS = Array.from({ length: 19 }, (_, index) => `D-${index + 40}`) as readonly string[];
const REQUIRED_OBSERVATIONS = ["contextvm", "lightning", "cashu", "postgres", "capacity", "modal"] as const;
const DEFERRALS = ["phase-04-exact-usage-debit", "phase-05-interruption-resume", "phase-06-preview-publication", "phase-07-live-slo-provider-provenance-certification", "v2-x402-l402"] as const;

export type Phase03CheckId = typeof REQUIRED_CHECK_IDS[number];
export type Phase03Provider = typeof REQUIRED_OBSERVATIONS[number];
export type Phase03Check = Readonly<{ id: Phase03CheckId; severity: "critical" | "high"; status: "passed" | "failed" | "blocked"; evidenceSha256: string }>;
export type Phase03Observation = Readonly<{ version: 1; provider: Phase03Provider; status: "passed" | "failed" | "blocked"; selection: "eligible-not-selected" | "unselected"; certificationProfile: "design"; reasonCode: string; evidenceSha256: string; limitations: readonly string[] }>;
export type Phase03DesignInput = Readonly<{
  identities: Readonly<{ packageIntake: string; postgres: string; contextvm: string; lightning: string; cashu: string; fundedCore: string; referenceSet: string }>;
  checks: readonly Phase03Check[];
  requirementMappings: Readonly<Record<string, readonly string[]>>;
  decisionMappings: readonly string[];
  observations: readonly Phase03Observation[];
}>;
export type Phase03DesignEvidence = Readonly<Phase03DesignInput & {
  version: 1; certificationProfile: "design"; verdict: "design-ready" | "blocked"; offlineVerdict: "passed" | "blocked"; deferrals: readonly typeof DEFERRALS[number][]; evidenceSha256: string;
}>;
export type Phase03DesignDecision = Readonly<{ evidence: Phase03DesignEvidence; reasons: readonly string[] }>;

function isRecord(value: unknown): value is Record<string, unknown> { return value !== null && typeof value === "object" && !Array.isArray(value); }
function isDigest(value: unknown): value is string { return typeof value === "string" && SHA256.test(value); }
function add(reasons: string[], reason: string): void { if (!reasons.includes(reason)) reasons.push(reason); }
async function digest(value: unknown): Promise<string> {
  const bytes = new TextEncoder().encode(canonicalJson(value));
  const result = await crypto.subtle.digest("SHA-256", bytes);
  return Array.from(new Uint8Array(result), (byte) => byte.toString(16).padStart(2, "0")).join("");
}
function forbidden(value: unknown): boolean {
  if (Array.isArray(value)) return value.some(forbidden);
  if (!isRecord(value)) return false;
  return Object.entries(value).some(([key, nested]) => /(?:raw.?event|raw.?prompt|\btoken\b|\bproof\b|invoice|preimage|credential|private.?key|protected.?plaintext|generated.?source|secret)/iu.test(key) || forbidden(nested));
}
function exact(values: readonly string[], expected: readonly string[]): boolean {
  return values.length === expected.length && new Set(values).size === expected.length && expected.every((value) => values.includes(value));
}
function validateObservation(observation: Phase03Observation, reasons: string[]): void {
  if (!observation || observation.version !== 1 || !REQUIRED_OBSERVATIONS.includes(observation.provider) || !["passed", "failed", "blocked"].includes(observation.status) || !["eligible-not-selected", "unselected"].includes(observation.selection) || observation.certificationProfile !== "design" || !observation.reasonCode || !isDigest(observation.evidenceSha256) || !Array.isArray(observation.limitations)) add(reasons, "provider observation is malformed");
  if (observation.status === "passed" && observation.selection !== "eligible-not-selected") add(reasons, "passed provider observation overclaims selection");
  if (observation.status !== "passed" && observation.selection !== "unselected") add(reasons, "blocked or failed provider observation is selected");
}

/** Evaluates offline deterministic proof without converting absent live providers into a pass. */
export async function evaluatePhase03Design(input: Phase03DesignInput): Promise<Phase03DesignDecision> {
  const reasons: string[] = [];
  if (!input || !isRecord(input)) add(reasons, "design input is malformed");
  const identities = input?.identities;
  if (!identities || identities.packageIntake !== "evidence/phase-03/package-intake.json" || identities.postgres !== "src/persistence/postgres-funding-store.ts" || identities.contextvm !== "src/contextvm/adapter.ts" || identities.lightning !== "src/funding/lightning-top-up.ts" || identities.cashu !== "src/funding/cashu-top-up.ts" || identities.fundedCore !== "src/phase-03/funded-core.ts" || identities.referenceSet !== "tests/fixtures/phase-03-reference-set.json") add(reasons, "authority identity set is invalid");
  if (forbidden(input)) add(reasons, "design evidence contains forbidden raw material");
  if (!Array.isArray(input.checks) || !exact(input.checks.map((check) => check.id), REQUIRED_CHECK_IDS)) add(reasons, "deterministic check identity set is incomplete, duplicate, or unknown");
  for (const check of input.checks ?? []) {
    if (!REQUIRED_CHECK_IDS.includes(check.id) || !["critical", "high"].includes(check.severity) || check.status !== "passed" || !isDigest(check.evidenceSha256)) add(reasons, `deterministic check ${String(check.id)} is malformed or not passed`);
  }
  if (!input.requirementMappings || !exact(Object.keys(input.requirementMappings), REQUIRED_REQUIREMENTS) || Object.values(input.requirementMappings).some((mappings) => !Array.isArray(mappings) || mappings.length === 0 || mappings.some((item) => !REQUIRED_CHECK_IDS.includes(item as Phase03CheckId)))) add(reasons, "requirement mapping set is incomplete or invalid");
  if (!Array.isArray(input.decisionMappings) || !exact(input.decisionMappings, REQUIRED_DECISIONS)) add(reasons, "decision mapping set is incomplete, duplicate, or unknown");
  if (!Array.isArray(input.observations) || !exact(input.observations.map((observation) => observation.provider), REQUIRED_OBSERVATIONS)) add(reasons, "provider observation set is incomplete, duplicate, or unknown");
  for (const observation of input.observations ?? []) validateObservation(observation, reasons);
  const offlineVerdict = reasons.length === 0 ? "passed" as const : "blocked" as const;
  const withoutDigest = {
    version: 1 as const, certificationProfile: "design" as const, verdict: offlineVerdict === "passed" ? "design-ready" as const : "blocked" as const, offlineVerdict,
    identities: Object.freeze({ ...input.identities }), checks: Object.freeze(input.checks.map((check) => Object.freeze({ ...check }))),
    requirementMappings: Object.freeze(Object.fromEntries(Object.entries(input.requirementMappings).map(([key, value]) => [key, Object.freeze([...value])]))), decisionMappings: Object.freeze([...input.decisionMappings]),
    observations: Object.freeze(input.observations.map((observation) => Object.freeze({ ...observation, limitations: Object.freeze([...observation.limitations]) }))), deferrals: Object.freeze([...DEFERRALS]),
  };
  return Object.freeze({ evidence: Object.freeze({ ...withoutDigest, evidenceSha256: await digest(withoutDigest) }), reasons: Object.freeze(reasons) });
}

/** Validates an independently loaded content-addressed record before it may be pointed to as current. */
export async function validatePhase03DesignEvidence(evidence: Phase03DesignEvidence): Promise<void> {
  if (!evidence || evidence.version !== 1 || evidence.certificationProfile !== "design" || !["design-ready", "blocked"].includes(evidence.verdict) || !["passed", "blocked"].includes(evidence.offlineVerdict)) throw new Error("Phase 03 design evidence profile is invalid");
  if (!isDigest(evidence.evidenceSha256) || forbidden(evidence)) throw new Error("Phase 03 design evidence digest or redaction is invalid");
  if (evidence.verdict === "design-ready" && evidence.offlineVerdict !== "passed") throw new Error("design-ready evidence requires passed offline verdict");
  if (!exact(evidence.deferrals, DEFERRALS)) throw new Error("Phase 03 design evidence has invalid deferrals");
  const { evidenceSha256, version: _version, certificationProfile: _profile, verdict: _verdict, offlineVerdict: _offlineVerdict, deferrals: _deferrals, ...input } = evidence;
  const evaluated = await evaluatePhase03Design(input);
  if (evaluated.evidence.verdict !== evidence.verdict || evaluated.evidence.offlineVerdict !== evidence.offlineVerdict || evaluated.evidence.evidenceSha256 !== evidenceSha256) throw new Error("Phase 03 design evidence deterministic proof is invalid");
}

/** Immutable create-or-verify record write; callers update a stable pointer only after a fresh validation. */
export async function writePhase03DesignEvidence(directory: string, input: Phase03DesignInput): Promise<Phase03DesignEvidence> {
  const { evidence } = await evaluatePhase03Design(input);
  await validatePhase03DesignEvidence(evidence);
  await mkdir(directory, { recursive: true });
  const content = `${canonicalJson(evidence)}\n`;
  const path = `${directory}/${evidence.evidenceSha256}.json`;
  try { await writeFile(path, content, { encoding: "utf8", flag: "wx" }); }
  catch (error) {
    if (!(error instanceof Error) || !("code" in error) || error.code !== "EEXIST") throw error;
    if (await readFile(path, "utf8") !== content) throw new Error("immutable Phase 03 design evidence collision");
  }
  return evidence;
}
