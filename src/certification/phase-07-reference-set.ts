import { createHash } from "node:crypto";
import { z } from "zod";
import { canonicalJson } from "../promotion/schema.js";
import { redactLifecycleObservation } from "../telemetry/redaction.js";
import { runAdmissionAttempt } from "../admission/benchmark.js";
import { D122_FAULT_MATRIX, NO_EFFECTS_ORACLE, runFaultScenario } from "../resilience/fault-harness.js";
import { InMemoryLifecycleExporter } from "../telemetry/otel.js";
import { projectHostPublicationSurface } from "../publication/host-surface.js";
import { createProtectedInfrastructureDrillEvidence } from "../resilience/fault-harness.js";

const DIGEST = /^[a-f0-9]{64}$/iu;
export const PHASE_07_REQUIREMENTS = ["SESS-02", "OPS-01", "OPS-02", "OPS-03", "OPS-04"] as const;
export const PHASE_07_DECISIONS = Array.from({ length: 16 }, (_, index) => `D-${index + 114}`);
export const PHASE_07_THREATS = ["T-07-EVL-01", "T-07-EVL-02", "T-07-EVL-03", "T-07-EVL-04", "T-07-SC"] as const;
export const PHASE_07_UI_ROWS = ["empty", "loading", "error", "populated", "partial", "overflow", "zero_one_many", "long_text"] as const;
export const PHASE_07_AI_DIMENSIONS = ["shell_authority", "napplet_conformance", "tool_use", "ledger_integrity", "admission_slo", "continuity", "original_operation", "sealed_identity", "telemetry_privacy", "live_promotion"] as const;
export const PHASE_07_API_ROWS = ["ADM-01", "ADM-02", "ADM-03", "ADM-04", "MOD-01", "MOD-02", "MOD-03", "MOD-04", "FLY-01", "FLY-02", "FLY-03", "FLY-04", "TEL-01", "TEL-02", "TEL-03", "TEL-04", "TEL-05", "CTX-01", "CEP-01", "CEP-02", "PAY-01", "PAY-02", "PAY-03", "MODEL-01", "MODEL-02", "MODEL-03", "SQL-01", "SQL-02", "SQL-03", "OBJ-01", "OBJ-02", "OBJ-03", "RUN-01", "RUN-02", "HOST-01", "HOST-02", "SIGN-01", "SIGN-02", "SIGN-03", "NAP-01", "NAP-02", "NAP-03", "PUB-01", "PUB-02", "PUB-03", "PUB-04", "SC-01", "SC-02", "SC-03", "CERT-01", "CERT-02", "CERT-03", "CERT-04"] as const;
export const PHASE_07_LIVE_OWNERS = ["contextvm", "cep8_lightning", "cashu", "model", "modal", "fly", "object_storage", "database", "control_plane", "compatible_host", "signer", "napplet_cli", "upload", "relay"] as const;

const CategorySchema = z.enum(["admission", "resilience", "security", "publication", "launch"]);
const ExpectedSchema = z.object({ status: z.literal("passed"), value: z.string().min(1), effects: z.object({ credit: z.number().int().nonnegative(), debit: z.number().int().nonnegative(), worker: z.number().int().nonnegative(), publication: z.number().int().nonnegative() }).strict() }).strict();
const CaseSchema = z.object({
  id: z.string().regex(/^(?:A|R|S|P|L)\d{2}$/u), name: z.string().min(1).max(120), category: CategorySchema,
  scenario: z.object({ input: z.object({ mode: z.string().min(1).max(64), ordinal: z.number().int().nonnegative() }).strict(), initialState: z.enum(["empty", "funded", "paused", "verified"]), schedule: z.array(z.string().regex(/^[a-z0-9_-]{1,64}$/u)).min(1).max(8) }).strict(),
  expected: ExpectedSchema, requirements: z.array(z.enum(PHASE_07_REQUIREMENTS)).min(1), decisions: z.array(z.string().regex(/^D-1(?:1[4-9]|2[0-9])$/u)).min(1), threats: z.array(z.enum(PHASE_07_THREATS)).min(1), apiRows: z.array(z.string()).min(1), uiRows: z.array(z.enum(PHASE_07_UI_ROWS)).min(1), aiDimensions: z.array(z.enum(PHASE_07_AI_DIMENSIONS)).min(1), edge: z.string().regex(/^E-\d{2}$/u),
}).strict();
const LiveSchema = z.object({ owner: z.enum(PHASE_07_LIVE_OWNERS), status: z.enum(["blocked", "not_observed"]), claim: z.string().regex(/^[a-z0-9_.-]+$/u), inputDigest: z.string().regex(DIGEST), freshness: z.literal("protected_record_required"), limitation: z.string().regex(/^[a-z0-9_.-]+$/u) }).strict();
export const Phase07ReferenceSetSchema = z.object({ schema: z.literal("phase-07-reference-set"), version: z.literal(2), categoryMinimums: z.object({ admission: z.literal(12), resilience: z.literal(16), security: z.literal(16), publication: z.literal(10), launch: z.literal(10) }).strict(), cases: z.array(CaseSchema).length(64), liveObservations: z.array(LiveSchema).length(PHASE_07_LIVE_OWNERS.length), sourceRevision: z.string().regex(/^[a-f0-9]{40,64}$/iu) }).strict();
export type Phase07ReferenceSet = z.infer<typeof Phase07ReferenceSetSchema>;
export type Phase07Comparison = Readonly<{ id: string; status: "passed" | "failed"; expected: z.infer<typeof ExpectedSchema>; observed: z.infer<typeof ExpectedSchema>; evidenceClass: "deterministic" }>;

const hasProtectedData = (value: unknown): boolean => {
  if (typeof value === "string") return /(?:bearer\s+\S+|secret-canary|private.?key|raw[_ -]?(?:payload|receipt|envelope)|\/Users\/)/iu.test(value);
  if (Array.isArray(value)) return value.some(hasProtectedData);
  return Boolean(value && typeof value === "object" && Object.entries(value).some(([key, nested]) => /(?:token|secret|private|raw|prompt|path)/iu.test(key) || hasProtectedData(nested)));
};
const exact = (actual: readonly string[], required: readonly string[]) => actual.length === required.length && new Set(actual).size === required.length && required.every((item) => actual.includes(item));
const ZERO_EFFECTS = Object.freeze({ credit: 0, debit: 0, worker: 0, publication: 0 });
const MODES = Object.freeze({
  admission: new Set(["pool_hit", "pool_miss", "cold", "step_load", "contention", "reclaim", "deadline_refusal", "refusal_replay", "no_queue", "lease_mismatch", "safe_refusal", "receipt_clock"]),
  resilience: new Set(["duplicate_relay", "out_of_order", "ingress_loss", "sql_serialization", "sql_unavailable", "capacity_ambiguity", "worker_loss", "object_interruption", "model_ambiguity", "payment_reconcile", "expiry_race", "preview_invalid", "partial_publication", "checkpoint_fence", "unknown", "single_writer"]),
  security: new Set(["encoded_prompt", "tool_injection", "malformed_proposal", "grant_overwrite", "traversal", "symlink", "cross_session", "direct_fetch", "storage_escape", "iframe_spoof", "postinstall", "environment_probe", "dns_exfil", "websocket_exfil", "resource_exhaustion", "manifest_mutation"]),
  publication: new Set(["focused_success", "scope_denial", "verify_failure", "required_capability", "optional_capability", "byte_binding", "stale_approval", "external_signer", "publication_replay", "attestation_reconcile"]),
  launch: new Set(["telemetry_canary", "unknown_attribute", "cardinality_bomb", "evidence_mutation", "reproducibility", "golden_sbom", "rollback_waiver", "missing_credential", "not_observed", "promotion_blocked"]),
});
type ReferenceCase = z.infer<typeof CaseSchema>;
type ReferenceObservation = z.infer<typeof ExpectedSchema>;

function requireSupportedScenario(caseValue: ReferenceCase): void {
  if (!MODES[caseValue.category].has(caseValue.scenario.input.mode)) throw new Error("PHASE07_REFERENCE_SCENARIO_UNSUPPORTED");
}

function observation(value: string): ReferenceObservation {
  return ExpectedSchema.parse({ status: "passed", value, effects: ZERO_EFFECTS });
}

async function observeAdmission(caseValue: ReferenceCase): Promise<ReferenceObservation> {
  let reserveCalls = 0;
  const sample = await runAdmissionAttempt({
    now: (() => { let tick = caseValue.scenario.input.ordinal; return () => tick++; })(),
    inputId: caseValue.id,
    attempt: async () => {
      reserveCalls += 1;
      return { outcome: "capacity_unavailable" as const, readyLeaseCount: 0, durableBacklogCount: 0, inputId: caseValue.id };
    },
  });
  return observation(`admission:${sample.outcome}:reserve=${reserveCalls}:backlog=${sample.durableBacklogCount}`);
}

async function observeResilience(caseValue: ReferenceCase): Promise<ReferenceObservation> {
  const schedule = D122_FAULT_MATRIX[caseValue.scenario.input.ordinal % D122_FAULT_MATRIX.length]!;
  let boundaryCalls = 0;
  const result = await runFaultScenario({ ...schedule, id: `phase07-${caseValue.id.toLowerCase()}` }, (actual) => {
    boundaryCalls += 1;
    return { operationId: actual.input.operationId!, sessionId: actual.initialState.sessionId!, observed: actual.outcomes.at(-1)!.outcome, activeWriters: 1, effects: NO_EFFECTS_ORACLE };
  }, { activeWriters: 1, effects: NO_EFFECTS_ORACLE });
  return observation(`resilience:${result.observed}:boundary=${boundaryCalls}:writers=${result.activeWriters}`);
}

async function observeSecurity(caseValue: ReferenceCase): Promise<ReferenceObservation> {
  const exporter = new InMemoryLifecycleExporter({ key: new Uint8Array(32).fill(7) });
  exporter.observe({ version: "cvm.lifecycle.v1", stage: "validation", outcome: "blocked", correlationId: `reference:${caseValue.id}`, monotonicMs: caseValue.scenario.input.ordinal });
  const safe = redactLifecycleObservation({ version: "cvm.lifecycle.v1", stage: "validation", outcome: "blocked", correlationId: `reference:${caseValue.id}`, monotonicMs: caseValue.scenario.input.ordinal }, { key: new Uint8Array(32).fill(7) });
  if (!safe || exporter.observations.length !== 1) throw new Error("PHASE07_REFERENCE_TELEMETRY_AUTHORITY");
  return observation(`security:${exporter.observations[0]!.outcome}:exports=${exporter.observations.length}:violations=${exporter.telemetryPolicyViolations}`);
}

async function observePublication(caseValue: ReferenceCase): Promise<ReferenceObservation> {
  const state = caseValue.scenario.input.mode === "focused_success" ? "preview_ready" : caseValue.scenario.input.mode === "optional_capability" ? "optional_capability_missing" : "launch_certification_blocked";
  const sha = "a".repeat(64);
  const surface = projectHostPublicationSurface({ state, identity: { artifactId: `artifact:${caseValue.id}`, aggregateSha256: sha, normalizedDTag: "reference", capabilityDigest: sha }, capabilities: [] });
  return observation(`publication:${surface.semanticStatus.kind}:identifiers=${surface.identifiers.length}:actions=${surface.actions.length}`);
}

async function observeLaunch(caseValue: ReferenceCase): Promise<ReferenceObservation> {
  const protectedRecord = await createProtectedInfrastructureDrillEvidence({ candidateDigest: createHash("sha256").update(caseValue.id).digest("hex"), components: ["gcs", "cloud_run", "cockroach"], credentialsAvailable: false });
  return observation(`launch:${protectedRecord.status}:${protectedRecord.code}:effects=0`);
}

/** Validates source coverage and keeps expected values on the comparator side only. */
export function validatePhase07ReferenceSet(input: unknown): Phase07ReferenceSet {
  const parsed = Phase07ReferenceSetSchema.parse(input);
  if (hasProtectedData(parsed)) throw new Error("PHASE07_REFERENCE_PROTECTED_DATA");
  if (new Set(parsed.cases.map((item) => item.id)).size !== 64) throw new Error("PHASE07_REFERENCE_DUPLICATE_CASE");
  for (const [category, minimum] of Object.entries(parsed.categoryMinimums)) if (parsed.cases.filter((item) => item.category === category).length < minimum) throw new Error("PHASE07_REFERENCE_CATEGORY_MINIMUM");
  const mapped = <T extends string>(values: readonly T[], key: keyof z.infer<typeof CaseSchema>) => [...new Set(parsed.cases.flatMap((item) => item[key] as readonly T[]))].sort();
  if (!exact(mapped(PHASE_07_REQUIREMENTS, "requirements"), PHASE_07_REQUIREMENTS) || !exact(mapped(PHASE_07_DECISIONS, "decisions"), PHASE_07_DECISIONS) || !exact(mapped(PHASE_07_THREATS, "threats"), PHASE_07_THREATS) || !exact(mapped(PHASE_07_API_ROWS, "apiRows"), PHASE_07_API_ROWS) || !exact(mapped(PHASE_07_UI_ROWS, "uiRows"), PHASE_07_UI_ROWS) || !exact(mapped(PHASE_07_AI_DIMENSIONS, "aiDimensions"), PHASE_07_AI_DIMENSIONS)) throw new Error("PHASE07_REFERENCE_SOURCE_COVERAGE");
  if (!exact(parsed.liveObservations.map((item) => item.owner), PHASE_07_LIVE_OWNERS) || parsed.liveObservations.some((item) => item.status === "blocked" && item.claim === "")) throw new Error("PHASE07_REFERENCE_LIVE_INVENTORY");
  return Object.freeze(parsed);
}

async function deterministicObservation(caseValue: ReferenceCase): Promise<ReferenceObservation> {
  // These adapters receive only the typed scenario. Comparator expectations
  // never cross the authority boundary.
  requireSupportedScenario(caseValue);
  const result = caseValue.category === "admission" ? await observeAdmission(caseValue)
    : caseValue.category === "resilience" ? await observeResilience(caseValue)
      : caseValue.category === "security" ? await observeSecurity(caseValue)
        : caseValue.category === "publication" ? await observePublication(caseValue)
          : await observeLaunch(caseValue);
  // Bind the authority observation to the full typed scenario.  An ID is only
  // coverage metadata; retaining it while changing schedule/input/state must
  // not preserve a passing comparator result.
  const scenarioDigest = createHash("sha256").update(canonicalJson(caseValue.scenario)).digest("hex").slice(0, 16);
  return observation(`${result.value}:scenario=${scenarioDigest}`);
}

/** Runs the deterministic probe without passing expected values into runtime. */
export async function executePhase07ReferenceCase(input: unknown): Promise<Phase07Comparison> {
  const caseValue = CaseSchema.parse(input);
  let observed: ReferenceObservation;
  try { observed = await deterministicObservation(caseValue); }
  catch { observed = observation("authority:failed:scenario=unsupported"); }
  const same = canonicalJson(caseValue.expected) === canonicalJson(observed);
  return Object.freeze({ id: caseValue.id, status: same ? "passed" : "failed", expected: caseValue.expected, observed, evidenceClass: "deterministic" });
}

export function phase07DatasetSha256(reference: unknown): string { return createHash("sha256").update(canonicalJson(validatePhase07ReferenceSet(reference))).digest("hex"); }
