import { mkdir, readFile, writeFile } from "node:fs/promises";
import { canonicalJson } from "../promotion/schema";

const SHA256 = /^[a-f0-9]{64}$/i;
const REQUIRED_CHECK_IDS = ["tracer", "admission", "risk", "session", "gateway", "fake-worker", "artifact-contract", "reference-set"] as const;
const PHASE_7_DEFERRALS = ["provider-certification", "readiness-slo-load-proof", "chaos-and-regional-recovery", "exhaustive-hostile-depth", "supply-chain-promotion-and-launch-hardening"] as const;

export type Phase02CheckId = typeof REQUIRED_CHECK_IDS[number];
export type Phase02Check = Readonly<{ id: Phase02CheckId; severity: "critical" | "high"; status: "passed" | "failed" | "blocked"; evidenceSha256: string }>;
export type Phase02ProviderObservation = Readonly<{
  version: 1;
  provider: "modal";
  status: "passed" | "failed" | "blocked";
  selection: "eligible-not-selected" | "unselected";
  reasonCode: string;
  policyVersion: string;
  failedChecks: readonly string[];
  limitations: readonly string[];
  evidenceSha256: string;
}>;
export type Phase02DesignInput = Readonly<{
  policy: Readonly<{ identity: string; sha256: string }>;
  sqlite: Readonly<{ identity: string; schemaSha256: string }>;
  identities: Readonly<{ trustedCore: string; workerContracts: string; artifactGate: string }>;
  checks: readonly Phase02Check[];
  providerObservation: Phase02ProviderObservation;
}>;
export type Phase02DesignEvidence = Readonly<{
  version: 1;
  certificationProfile: "design";
  verdict: "design-ready" | "blocked";
  offlineVerdict: "passed" | "blocked";
  policy: Phase02DesignInput["policy"];
  sqlite: Phase02DesignInput["sqlite"];
  identities: Phase02DesignInput["identities"];
  checks: readonly Phase02Check[];
  requirementMappings: Readonly<Record<string, readonly string[]>>;
  decisionMappings: readonly string[];
  providerObservation: Phase02ProviderObservation;
  deferrals: readonly typeof PHASE_7_DEFERRALS[number][];
  evidenceSha256: string;
}>;
export type Phase02DesignDecision = Readonly<{ evidence: Phase02DesignEvidence; reasons: readonly string[] }>;

function isDigest(value: unknown): value is string { return typeof value === "string" && SHA256.test(value); }
function isRecord(value: unknown): value is Record<string, unknown> { return value !== null && typeof value === "object" && !Array.isArray(value); }
async function digest(value: unknown): Promise<string> {
  const result = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(canonicalJson(value)));
  return Array.from(new Uint8Array(result), (byte) => byte.toString(16).padStart(2, "0")).join("");
}
function add(reasons: string[], reason: string): void { if (!reasons.includes(reason)) reasons.push(reason); }
function forbiddenField(value: unknown): boolean {
  if (Array.isArray(value)) return value.some(forbiddenField);
  if (!isRecord(value)) return false;
  return Object.entries(value).some(([key, nested]) => /(?:raw.?prompt|secret|token|capability.?grant|\bgrant\b|generated.?source)/iu.test(key) || forbiddenField(nested));
}

function validateProvider(provider: Phase02ProviderObservation, policyIdentity: string, reasons: string[]): void {
  if (!provider || provider.version !== 1 || provider.provider !== "modal" || !["passed", "failed", "blocked"].includes(provider.status) || !["eligible-not-selected", "unselected"].includes(provider.selection) || !isDigest(provider.evidenceSha256) || provider.policyVersion !== policyIdentity || !Array.isArray(provider.failedChecks) || !Array.isArray(provider.limitations)) add(reasons, "provider observation is malformed or has a mismatched policy identity");
  if (provider.status === "passed" && provider.selection !== "eligible-not-selected") add(reasons, "passed provider observations are only eligible-not-selected");
  if (provider.status !== "passed" && provider.selection !== "unselected") add(reasons, "blocked or failed provider observations remain unselected");
}

/** Evaluates deterministic design proof independently from optional provider observation. */
export async function evaluatePhase02Design(input: Phase02DesignInput): Promise<Phase02DesignDecision> {
  const reasons: string[] = [];
  if (input.policy.identity !== "phase-02-policy-2026-08-04" || !isDigest(input.policy.sha256) || !isDigest(input.sqlite.schemaSha256) || input.sqlite.identity !== "phase-02-sqlite-session-store-v1") add(reasons, "policy or durable SQLite identity is invalid");
  if (!input.identities.trustedCore.endsWith("src/phase-02/trusted-core.ts") || !input.identities.workerContracts.endsWith("src/phase-02/contracts.ts") || !input.identities.artifactGate.endsWith("src/policy/artifact-contract.ts")) add(reasons, "trusted-core authority identities are invalid");
  if (forbiddenField(input)) add(reasons, "design evidence may not contain raw prompt, secret, token, grant, or generated-source fields");
  if (input.checks.length !== REQUIRED_CHECK_IDS.length || new Set(input.checks.map((check) => check.id)).size !== REQUIRED_CHECK_IDS.length || REQUIRED_CHECK_IDS.some((id) => !input.checks.some((check) => check.id === id))) add(reasons, "deterministic check identity set is incomplete, duplicate, or unknown");
  for (const check of input.checks) {
    if (!REQUIRED_CHECK_IDS.includes(check.id) || !["critical", "high"].includes(check.severity) || !isDigest(check.evidenceSha256) || check.status !== "passed") add(reasons, `deterministic check ${check.id} is missing, malformed, or not passed`);
  }
  validateProvider(input.providerObservation, input.policy.identity, reasons);
  const offlineVerdict: Phase02DesignEvidence["offlineVerdict"] = reasons.length === 0 ? "passed" : "blocked";
  const verdict: Phase02DesignEvidence["verdict"] = offlineVerdict === "passed" ? "design-ready" : "blocked";
  const withoutDigest = {
    version: 1 as const,
    certificationProfile: "design" as const,
    verdict,
    offlineVerdict,
    policy: Object.freeze({ ...input.policy }),
    sqlite: Object.freeze({ ...input.sqlite }),
    identities: Object.freeze({ ...input.identities }),
    checks: Object.freeze(input.checks.map((check) => Object.freeze({ ...check }))),
    requirementMappings: Object.freeze({ "SESS-05": Object.freeze(["session", "reference-set"]), "SAFE-01": Object.freeze(["admission", "reference-set"]), "SAFE-02": Object.freeze(["risk", "reference-set"]), "SAFE-03": Object.freeze(["gateway", "artifact-contract", "reference-set"]), "SAFE-04": Object.freeze(["fake-worker", "tracer", "reference-set"]) }),
    decisionMappings: Object.freeze(Array.from({ length: 20 }, (_, index) => `D-${index + 20}`)),
    providerObservation: Object.freeze({ ...input.providerObservation, failedChecks: Object.freeze([...input.providerObservation.failedChecks]), limitations: Object.freeze([...input.providerObservation.limitations]) }),
    deferrals: Object.freeze([...PHASE_7_DEFERRALS]),
  };
  return Object.freeze({ evidence: Object.freeze({ ...withoutDigest, evidenceSha256: await digest(withoutDigest) }), reasons: Object.freeze(reasons) });
}

/** Validates a standalone content-addressed record and rejects overclaiming/redaction failures. */
export async function validatePhase02DesignEvidence(evidence: Phase02DesignEvidence): Promise<void> {
  if (!evidence || evidence.version !== 1 || evidence.certificationProfile !== "design" || !["design-ready", "blocked"].includes(evidence.verdict) || !["passed", "blocked"].includes(evidence.offlineVerdict)) throw new Error("Phase 02 design evidence profile is invalid");
  if (!isDigest(evidence.evidenceSha256) || forbiddenField(evidence)) throw new Error("Phase 02 design evidence digest or redaction is invalid");
  if (evidence.verdict === "design-ready" && evidence.offlineVerdict !== "passed") throw new Error("design-ready evidence requires a passed offline verdict");
  if (!Array.isArray(evidence.deferrals) || evidence.deferrals.length !== PHASE_7_DEFERRALS.length || evidence.deferrals.some((item) => !PHASE_7_DEFERRALS.includes(item))) throw new Error("Phase 02 design evidence has an unknown deferral");
  const { evidenceSha256, ...withoutDigest } = evidence;
  if (await digest(withoutDigest) !== evidenceSha256) throw new Error("Phase 02 design evidence digest does not match canonical content");
  const evaluated = await evaluatePhase02Design({ policy: evidence.policy, sqlite: evidence.sqlite, identities: evidence.identities, checks: evidence.checks, providerObservation: evidence.providerObservation });
  if (evaluated.evidence.verdict !== evidence.verdict || evaluated.evidence.offlineVerdict !== evidence.offlineVerdict) throw new Error("Phase 02 design evidence has an invalid deterministic verdict");
}

/** Uses immutable create-or-verify writes; the stable pointer is written by the command after validation. */
export async function writePhase02DesignEvidence(directory: string, input: Phase02DesignInput): Promise<Phase02DesignEvidence> {
  const { evidence } = await evaluatePhase02Design(input);
  await validatePhase02DesignEvidence(evidence);
  await mkdir(directory, { recursive: true });
  const content = `${canonicalJson(evidence)}\n`;
  const path = `${directory}/${evidence.evidenceSha256}.json`;
  try { await writeFile(path, content, { encoding: "utf8", flag: "wx" }); }
  catch (error) {
    if (!(error instanceof Error) || !("code" in error) || error.code !== "EEXIST") throw error;
    if (await readFile(path, "utf8") !== content) throw new Error("immutable Phase 02 design evidence collision");
  }
  return evidence;
}
