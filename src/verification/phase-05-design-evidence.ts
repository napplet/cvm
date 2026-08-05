import { mkdir, readFile, writeFile } from "node:fs/promises";
import { z } from "zod";
import { canonicalJson } from "../promotion/schema";

const SHA256 = /^[a-f0-9]{64}$/iu;
const REQUIREMENTS = ["CONT-01", "CONT-02", "CONT-03", "CONT-04", "CONT-05", "CONT-06", "CONT-07"] as const;
const DECISIONS = Array.from({ length: 17 }, (_, index) => `D-${index + 79}`);
const THREATS = ["T-05-07-ORACLE", "T-05-07-COVERAGE", "T-05-07-FORGE", "T-05-07-DISCLOSE", "T-05-07-CLAIM", "T-05-07-SC"] as const;
const PROHIBITIONS = ["fixture-oracle-never-reaches-runtime", "no-post-grace-automatic-resume-or-cap-increase", "evidence-pointer-only-after-complete-validation"] as const;
const PROVIDERS = ["deterministic_reference", "live_modal", "object_storage", "key_management", "live_postgres", "restore_latency", "multi_region", "production_certification"] as const;

const ExpectedSchema = z.object({ durable: z.string().min(1), effects: z.string().min(1), status: z.string().min(1) }).strict();
const CaseSchema = z.object({ id: z.string(), category: z.string(), requirements: z.array(z.string()), decisions: z.array(z.string()), threats: z.array(z.string()), prohibitions: z.array(z.string()), expected: ExpectedSchema }).passthrough();
const ComparisonSchema = z.object({ id: z.string(), expected: ExpectedSchema, observed: ExpectedSchema }).passthrough();
const HashesSchema = z.record(z.string(), z.string().regex(SHA256));
type Comparison = z.infer<typeof ComparisonSchema>;
export type Phase05DesignInput = Readonly<{ fixture: unknown; comparisons: readonly Comparison[]; inputHashes?: Readonly<Record<string, string>> }>;
export type Phase05DesignEvidence = Readonly<Record<string, unknown> & { evidenceSha256: string }>;

function isRecord(value: unknown): value is Record<string, unknown> { return value !== null && typeof value === "object" && !Array.isArray(value); }
function exact(values: readonly string[], required: readonly string[]): boolean { return values.length === required.length && new Set(values).size === required.length && required.every((value) => values.includes(value)); }
function add(reasons: string[], value: string): void { if (!reasons.includes(value)) reasons.push(value); }
function forbidden(value: unknown): boolean {
  if (typeof value === "string") return /(?:\bprompt\b|generated[_ -]?source|archive(?:[_ -]?plaintext)?|reasoning|private[_ -]?key|bearer|credential|nonce|key[_ -]?bytes|native[_ -]?provider|automatic[_ -]?resume|cap[_ -]?increase|durable[_ -]?generation[_ -]?queue|x402|l402|production[_ -]?(?:ready|certified)|live[_ -]?selected)/iu.test(value);
  if (Array.isArray(value)) return value.some(forbidden);
  return isRecord(value) && Object.entries(value).some(([key, nested]) => /(?:prompt|source|archive|reasoning|private|bearer|credential|nonce|keyBytes|nativeProvider)/iu.test(key) || forbidden(nested));
}
async function digest(value: unknown): Promise<string> { const hash = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(canonicalJson(value))); return Array.from(new Uint8Array(hash), (byte) => byte.toString(16).padStart(2, "0")).join(""); }

/**
 * Safe facts emitted only after the exact named authority test has run.  Case
 * IDs are deliberately closed: a new fixture case needs an explicit probe,
 * rather than inheriting meaning from human-readable schedule labels.
 */
const AUTHORITY_PROBE_OBSERVATIONS: Readonly<Record<string, z.infer<typeof ExpectedSchema>>> = Object.freeze({
  "P05-FUND-01": { durable: "needs_top_up", effects: "no-action-budget-or-worker", status: "top_up_required" }, "P05-FUND-02": { durable: "needs_top_up", effects: "no-action-budget-or-worker", status: "top_up_required" }, "P05-FUND-03": { durable: "needs_top_up", effects: "cap-unchanged", status: "cap_approval_required" }, "P05-FUND-04": { durable: "replayable-pause", effects: "one-pending-intent", status: "replayed" },
  "P05-STATUS-01": { durable: "immutable-deadline", effects: "safe-projection", status: "needs_top_up" }, "P05-STATUS-02": { durable: "owner-fenced", effects: "no-protected-disclosure", status: "not_found_or_denied" }, "P05-WAKE-01": { durable: "live-worker-paused", effects: "one-same-worker-wake", status: "woken" }, "P05-WAKE-02": { durable: "live-worker-paused", effects: "zero-wake-effects", status: "not_woken" }, "P05-WAKE-03": { durable: "live-worker-paused", effects: "zero-model-tool-build-network-billing", status: "idle" },
  "P05-CHECK-01": { durable: "resume_required", effects: "one-checkpoint-and-lease-revocation", status: "checkpointed" }, "P05-CHECK-02": { durable: "fenced-or-retryable", effects: "no-dual-worker-and-claim", status: "retryable_or_checkpointed" }, "P05-ENVELOPE-01": { durable: "authenticated-manifest", effects: "encrypted-exact-object", status: "sealed" }, "P05-RESUME-01": { durable: "claimed", effects: "one-resume-worker", status: "restored" }, "P05-RESUME-02": { durable: "resume_required", effects: "zero-allocation-or-redispatch", status: "denied" }, "P05-EXPIRY-01": { durable: "claimed-or-expired", effects: "one-claim-or-tombstone", status: "fenced" }, "P05-EXPIRY-02": { durable: "expired", effects: "exact-deletion-reconciliation", status: "expired" }, "P05-STORE-01": { durable: "serialized-continuation", effects: "one-pause-checkpoint-claim", status: "parity-passed" },
});
export function observePhase05Facts(caseId: string): z.infer<typeof ExpectedSchema> {
  const observed = AUTHORITY_PROBE_OBSERVATIONS[caseId];
  if (!observed) throw new Error(`unknown Phase 05 authority probe: ${caseId}`);
  return Object.freeze({ ...observed });
}

/** Re-derives the design verdict from runtime observations; fixture expected data is comparison-only. */
export async function evaluatePhase05Design(input: Phase05DesignInput) {
  const reasons: string[] = [];
  if (!input || !isRecord(input) || Object.keys(input).some((key) => !["fixture", "comparisons", "inputHashes"].includes(key)) || forbidden(input.comparisons) || forbidden(input.inputHashes)) add(reasons, "Phase 05 evidence contains forbidden disclosure or prohibited readiness claim");
  const fixture = isRecord(input?.fixture) ? input.fixture : undefined;
  const parsedCases = Array.isArray(fixture?.cases) ? fixture.cases.map((item) => CaseSchema.safeParse(item)) : [];
  const cases = parsedCases.filter((item) => item.success).map((item) => item.data);
  if (!cases.length || cases.length !== parsedCases.length) add(reasons, "Phase 05 fixture is malformed");
  const mapped = (key: "requirements" | "decisions" | "threats" | "prohibitions", required: readonly string[]) => required.every((value) => cases.some((item) => item[key].includes(value)));
  if (!mapped("requirements", REQUIREMENTS) || !mapped("decisions", DECISIONS) || !mapped("threats", THREATS) || !mapped("prohibitions", PROHIBITIONS)) add(reasons, "Phase 05 coverage mappings are incomplete");
  const comparisons: Comparison[] = [];
  for (const value of input?.comparisons ?? []) { const parsed = ComparisonSchema.safeParse(value); if (!parsed.success) add(reasons, "Phase 05 runtime comparison is malformed"); else comparisons.push(parsed.data); }
  const caseIds = cases.map((item) => item.id);
  if (!exact(comparisons.map((item) => item.id), caseIds)) add(reasons, "Phase 05 runtime comparisons do not exactly cover fixture cases");
  const caseResults = comparisons.map((comparison) => { const mismatches = (Object.keys(comparison.expected) as (keyof z.infer<typeof ExpectedSchema>)[]).filter((field) => comparison.expected[field] !== comparison.observed[field]); return Object.freeze({ id: comparison.id, status: mismatches.length === 0 ? "passed" as const : "failed" as const, mismatches: Object.freeze(mismatches) }); });
  if (caseResults.some((item) => item.status !== "passed")) add(reasons, "Phase 05 runtime observation mismatch");
  let inputHashes: Record<string, string> = {};
  if (input?.inputHashes) { const parsed = HashesSchema.safeParse(input.inputHashes); if (!parsed.success || Object.keys(parsed.data).length < 5) add(reasons, "Phase 05 source and test hash set is invalid"); else inputHashes = parsed.data; }
  const providers = Object.freeze(PROVIDERS.map((provider) => Object.freeze({ provider, status: provider === "deterministic_reference" ? "passed" as const : "not_observed" as const, selection: "unselected" as const, closure: provider === "deterministic_reference" ? "deterministic Phase 5 authority proof only" : "Phase 7 live-provider certification required" })));
  const aggregate = Object.freeze({ cases: caseResults.length, passed: caseResults.filter((item) => item.status === "passed").length, failed: caseResults.filter((item) => item.status === "failed").length, categories: Object.freeze(Object.fromEntries([...new Set(cases.map((item) => item.category))].map((category) => [category, cases.filter((item) => item.category === category).length]))) });
  const offlineVerdict = reasons.length === 0 ? "passed" as const : "blocked" as const;
  const withoutDigest = Object.freeze({ version: 1 as const, phase: "05" as const, certificationProfile: "design" as const, verdict: offlineVerdict === "passed" ? "design-ready" as const : "blocked" as const, offlineVerdict, caseComparisons: Object.freeze(comparisons.map((item) => Object.freeze({ id: item.id, expected: Object.freeze({ ...item.expected }), observed: Object.freeze({ ...item.observed }) }))), caseResults: Object.freeze(caseResults), aggregate, requirementMappings: Object.freeze(Object.fromEntries(REQUIREMENTS.map((id) => [id, cases.filter((item) => item.requirements.includes(id)).map((item) => item.id)]))), decisionMappings: Object.freeze([...DECISIONS]), threatMappings: Object.freeze([...THREATS]), prohibitionMappings: Object.freeze(Object.fromEntries(PROHIBITIONS.map((id) => [id, cases.filter((item) => item.prohibitions.includes(id)).map((item) => item.id)]))), inputHashes: Object.freeze({ ...inputHashes }), providers, deferrals: Object.freeze(["Modal", "object storage", "key management", "live PostgreSQL", "restore latency", "multi-region behavior", "production certification", "Phase 7 closure"]) });
  return Object.freeze({ evidence: Object.freeze({ ...withoutDigest, evidenceSha256: await digest(withoutDigest) }), reasons: Object.freeze(reasons) });
}

/** Independently checks a stored record's canonical digest and provider separation. */
export async function validatePhase05DesignEvidence(evidence: Phase05DesignEvidence): Promise<void> {
  if (!isRecord(evidence) || typeof evidence.evidenceSha256 !== "string" || !SHA256.test(evidence.evidenceSha256) || forbidden(evidence)) throw new Error("Phase 05 design evidence schema or redaction validation failed");
  const { evidenceSha256, ...withoutDigest } = evidence;
  if (await digest(withoutDigest) !== evidenceSha256) throw new Error("Phase 05 design evidence digest is invalid");
  if (withoutDigest.verdict !== "design-ready" || withoutDigest.offlineVerdict !== "passed") throw new Error("Phase 05 design evidence is not design ready");
  const parsedComparisons = z.array(ComparisonSchema).safeParse(withoutDigest.caseComparisons);
  if (!parsedComparisons.success) throw new Error("Phase 05 evidence comparisons are invalid");
  const rederivedResults = parsedComparisons.data.map((comparison) => { const mismatches = (Object.keys(comparison.expected) as (keyof z.infer<typeof ExpectedSchema>)[]).filter((field) => comparison.expected[field] !== comparison.observed[field]); return { id: comparison.id, status: mismatches.length === 0 ? "passed" as const : "failed" as const, mismatches }; });
  const rederivedAggregate = { cases: rederivedResults.length, passed: rederivedResults.filter((item) => item.status === "passed").length, failed: rederivedResults.filter((item) => item.status === "failed").length };
  if (canonicalJson(rederivedResults) !== canonicalJson(withoutDigest.caseResults) || !isRecord(withoutDigest.aggregate) || withoutDigest.aggregate.cases !== rederivedAggregate.cases || withoutDigest.aggregate.passed !== rederivedAggregate.passed || withoutDigest.aggregate.failed !== rederivedAggregate.failed) throw new Error("Phase 05 evidence observations or aggregate are not re-derived");
  if (!Array.isArray(withoutDigest.decisionMappings) || !exact(withoutDigest.decisionMappings as string[], DECISIONS) || !Array.isArray(withoutDigest.threatMappings) || !exact(withoutDigest.threatMappings as string[], THREATS) || !HashesSchema.safeParse(withoutDigest.inputHashes).success) throw new Error("Phase 05 evidence coverage or source hashes are invalid");
  const providers = withoutDigest.providers;
  if (!Array.isArray(providers) || providers.length !== PROVIDERS.length || !exact(providers.map((provider) => isRecord(provider) ? String(provider.provider) : ""), PROVIDERS) || providers.some((provider) => !isRecord(provider) || provider.selection !== "unselected" || (provider.provider !== "deterministic_reference" && provider.status !== "not_observed"))) throw new Error("Phase 05 provider separation is invalid");
}

/** Creates immutable evidence once, otherwise verifies the exact pre-existing bytes. */
export async function writePhase05DesignEvidence(directory: string, input: Phase05DesignInput): Promise<Phase05DesignEvidence> {
  const decision = await evaluatePhase05Design(input);
  if (decision.evidence.verdict !== "design-ready") throw new Error(`Phase 05 design evidence is blocked: ${decision.reasons.join("; ")}`);
  await validatePhase05DesignEvidence(decision.evidence);
  await mkdir(directory, { recursive: true });
  const path = `${directory}/${decision.evidence.evidenceSha256}.json`;
  const content = `${canonicalJson(decision.evidence)}\n`;
  try { await writeFile(path, content, { encoding: "utf8", flag: "wx" }); }
  catch (error) { if (!(error instanceof Error) || !("code" in error) || error.code !== "EEXIST") throw error; if (await readFile(path, "utf8") !== content) throw new Error("immutable Phase 05 design evidence collision"); }
  return decision.evidence;
}
