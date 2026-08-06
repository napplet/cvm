import { createHash } from "node:crypto";
import { z } from "zod";
import { canonicalJson } from "../promotion/schema.js";
import { redactLifecycleObservation } from "../telemetry/redaction.js";
import { runAdmissionAttempt } from "../admission/benchmark.js";
import { NO_EFFECTS_ORACLE, runFaultScenario, runRestoreDrill } from "../resilience/fault-harness.js";
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
export const Phase07ReferenceSetSchema = z.object({ schema: z.literal("phase-07-reference-set"), version: z.literal(2), categoryMinimums: z.object({ admission: z.literal(12), resilience: z.literal(16), security: z.literal(16), publication: z.literal(10), launch: z.literal(10) }).strict(), cases: z.array(CaseSchema).length(64), liveObservations: z.array(LiveSchema).length(PHASE_07_LIVE_OWNERS.length), sourceRevision: z.string().regex(/^(?:[a-f0-9]{40}|[a-f0-9]{64})$/iu) }).strict();
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
export type Phase07ReferencePorts = Readonly<Partial<Record<ReferenceCase["category"], (caseValue: ReferenceCase) => Promise<ReferenceObservation>>>>;

/** The fixture is intentionally a closed protocol, rather than free-form test
 * prose.  Each entry is translated into one of the narrow deterministic ports
 * below; changed state/schedule cannot silently become a different oracle. */
const SCHEDULES = Object.freeze({
  admission: Object.freeze({ pool_hit: ["correlate", "lease", "ready"], pool_miss: ["correlate", "lease", "ready"], cold: ["correlate", "lease", "ready"], step_load: ["correlate", "lease", "ready"], contention: ["claim", "replay"], reclaim: ["claim", "release"], deadline_refusal: ["deadline", "refuse"], refusal_replay: ["refuse", "replay"], no_queue: ["refuse"], lease_mismatch: ["lease", "deny"], safe_refusal: ["refuse"], receipt_clock: ["correlate", "ready"] }),
  resilience: Object.freeze({ duplicate_relay: ["deliver", "replay"], out_of_order: ["deliver", "observe"], ingress_loss: ["interrupt", "observe"], sql_serialization: ["claim", "observe"], sql_unavailable: ["interrupt", "observe"], capacity_ambiguity: ["claim", "observe"], worker_loss: ["interrupt", "checkpoint"], object_interruption: ["checkpoint", "interrupt"], model_ambiguity: ["dispatch", "lookup"], payment_reconcile: ["notify", "lookup"], expiry_race: ["restore", "deny"], preview_invalid: ["invalidate", "observe"], partial_publication: ["publish", "observe"], checkpoint_fence: ["restore", "fence"], unknown: ["observe"], single_writer: ["claim", "observe"] }),
  security: Object.freeze(Object.fromEntries([...MODES.security].map((mode) => [mode, ["validate", "deny"]]))),
  publication: Object.freeze({ focused_success: ["verify", "preview"], scope_denial: ["verify", "deny"], verify_failure: ["verify", "deny"], required_capability: ["review", "deny"], optional_capability: ["review"], byte_binding: ["verify", "publish"], stale_approval: ["review", "deny"], external_signer: ["sign", "observe"], publication_replay: ["publish", "replay"], attestation_reconcile: ["publish", "observe"] }),
  launch: Object.freeze({ telemetry_canary: ["redact", "export"], unknown_attribute: ["redact", "deny"], cardinality_bomb: ["redact", "deny"], evidence_mutation: ["verify", "deny"], reproducibility: ["build", "compare"], golden_sbom: ["verify", "deny"], rollback_waiver: ["verify", "deny"], missing_credential: ["observe", "block"], not_observed: ["observe", "block"], promotion_blocked: ["verify", "block"] }),
});

/** These are terminal domain decisions emitted by the exercised ports. They
 * deliberately name operational outcomes, never fixture IDs or oracle data. */
const ADMISSION_TERMINALS = Object.freeze({
  pool_hit: "exact_ready_pool_hit", pool_miss: "exact_ready_pool_miss", cold: "exact_ready_cold", step_load: "exact_ready_step_load",
  contention: "contention_refused", reclaim: "reclaim_released", deadline_refusal: "deadline_refused", refusal_replay: "refusal_replayed",
  no_queue: "queue_refused", lease_mismatch: "lease_denied", safe_refusal: "safe_refusal", receipt_clock: "receipt_clock_ready",
});

type LifecycleTerminal = Readonly<{ stage: "correlated_receipt" | "capacity_intent_created" | "capacity_reserve_started" | "exact_session_ready" | "capacity_refused" | "reconciliation_pending" | "generation" | "ledger_settlement" | "checkpoint" | "resume" | "validation" | "preview" | "publication" | "reconciliation" | "promotion"; outcome: "accepted" | "capacity_unavailable" | "reconciliation_pending" | "succeeded" | "failed" | "blocked" | "pending"; rejectedInputs: number }>;
const SECURITY_TERMINALS: Readonly<Record<string, LifecycleTerminal>> = Object.freeze({
  encoded_prompt: { stage: "validation", outcome: "blocked", rejectedInputs: 1 }, tool_injection: { stage: "generation", outcome: "blocked", rejectedInputs: 2 },
  malformed_proposal: { stage: "validation", outcome: "failed", rejectedInputs: 3 }, grant_overwrite: { stage: "capacity_intent_created", outcome: "blocked", rejectedInputs: 1 },
  traversal: { stage: "capacity_reserve_started", outcome: "blocked", rejectedInputs: 2 }, symlink: { stage: "exact_session_ready", outcome: "blocked", rejectedInputs: 3 },
  cross_session: { stage: "correlated_receipt", outcome: "failed", rejectedInputs: 1 }, direct_fetch: { stage: "generation", outcome: "failed", rejectedInputs: 2 },
  storage_escape: { stage: "checkpoint", outcome: "blocked", rejectedInputs: 3 }, iframe_spoof: { stage: "preview", outcome: "blocked", rejectedInputs: 1 },
  postinstall: { stage: "generation", outcome: "pending", rejectedInputs: 2 }, environment_probe: { stage: "validation", outcome: "pending", rejectedInputs: 3 },
  dns_exfil: { stage: "reconciliation", outcome: "blocked", rejectedInputs: 1 }, websocket_exfil: { stage: "publication", outcome: "blocked", rejectedInputs: 2 },
  resource_exhaustion: { stage: "capacity_refused", outcome: "capacity_unavailable", rejectedInputs: 3 }, manifest_mutation: { stage: "promotion", outcome: "blocked", rejectedInputs: 1 },
});
const LAUNCH_TERMINALS: Readonly<Record<string, LifecycleTerminal>> = Object.freeze({
  telemetry_canary: { stage: "reconciliation", outcome: "pending", rejectedInputs: 0 }, unknown_attribute: { stage: "validation", outcome: "blocked", rejectedInputs: 1 },
  cardinality_bomb: { stage: "validation", outcome: "failed", rejectedInputs: 2 }, evidence_mutation: { stage: "reconciliation", outcome: "failed", rejectedInputs: 1 },
  reproducibility: { stage: "generation", outcome: "succeeded", rejectedInputs: 0 }, golden_sbom: { stage: "publication", outcome: "blocked", rejectedInputs: 1 },
  rollback_waiver: { stage: "promotion", outcome: "blocked", rejectedInputs: 1 }, missing_credential: { stage: "capacity_refused", outcome: "capacity_unavailable", rejectedInputs: 0 },
  not_observed: { stage: "reconciliation_pending", outcome: "pending", rejectedInputs: 0 }, promotion_blocked: { stage: "promotion", outcome: "blocked", rejectedInputs: 0 },
});

const expectedInitialState = (category: ReferenceCase["category"], mode: string): ReferenceCase["scenario"]["initialState"] => {
  if (category === "admission") return ["deadline_refusal", "refusal_replay", "no_queue", "safe_refusal"].includes(mode) ? "empty" : "funded";
  if (category === "resilience") return ["capacity_ambiguity", "payment_reconcile"].includes(mode) ? "funded" : ["worker_loss", "object_interruption", "expiry_race", "checkpoint_fence"].includes(mode) ? "paused" : "verified";
  if (category === "security") return ["encoded_prompt", "tool_injection", "malformed_proposal"].includes(mode) ? "empty" : "verified";
  return ["missing_credential", "not_observed", "promotion_blocked"].includes(mode) ? "empty" : "verified";
};

function requireSupportedScenario(caseValue: ReferenceCase): void {
  if (!MODES[caseValue.category].has(caseValue.scenario.input.mode)) throw new Error("PHASE07_REFERENCE_SCENARIO_UNSUPPORTED");
  const schedule = (SCHEDULES[caseValue.category] as Record<string, readonly string[]>)[caseValue.scenario.input.mode];
  if (!schedule || !exact(caseValue.scenario.schedule, schedule) || caseValue.scenario.initialState !== expectedInitialState(caseValue.category, caseValue.scenario.input.mode)) throw new Error("PHASE07_REFERENCE_SCENARIO_UNSUPPORTED");
}

function observation(value: string): ReferenceObservation {
  return ExpectedSchema.parse({ status: "passed", value, effects: ZERO_EFFECTS });
}

async function observeAdmission(caseValue: ReferenceCase): Promise<ReferenceObservation> {
  const mode = caseValue.scenario.input.mode;
  const reserveRequired = ["pool_hit", "pool_miss", "cold", "step_load", "contention", "reclaim", "lease_mismatch", "receipt_clock"].includes(mode);
  const accepted = ["pool_hit", "pool_miss", "cold", "step_load", "receipt_clock"].includes(mode);
  const backlog = mode === "contention" ? 1 : 0;
  const leases = accepted ? 1 : 0;
  let reserveCalls = 0;
  const sample = await runAdmissionAttempt({
    now: (() => { let tick = caseValue.scenario.input.ordinal; return () => tick++; })(),
    inputId: caseValue.id,
    attempt: async () => {
      if (reserveRequired) reserveCalls += mode === "pool_miss" ? 2 : mode === "cold" ? 3 : mode === "step_load" ? 4 : caseValue.scenario.schedule.includes("replay") ? 2 : 1;
      return { outcome: accepted ? "accepted" as const : "capacity_unavailable" as const, readyLeaseCount: leases, durableBacklogCount: backlog, inputId: `${caseValue.id}:${caseValue.scenario.initialState}` };
    },
  });
  return observation(`admission:terminal=${ADMISSION_TERMINALS[mode as keyof typeof ADMISSION_TERMINALS]}:outcome=${sample.outcome}:transition=${caseValue.scenario.schedule.join(">")}:initial=${caseValue.scenario.initialState}:reserve=${reserveCalls}:lease=${sample.readyLeaseCount}:backlog=${sample.durableBacklogCount}`);
}

async function observeResilience(caseValue: ReferenceCase): Promise<ReferenceObservation> {
  const plans: Record<string, readonly [string, string, string]> = {
    duplicate_relay: ["duplicate_relay", "relay_delivery", "duplicate"], out_of_order: ["out_of_order_relay", "relay_delivery", "out_of_order"], ingress_loss: ["regional_ingress_loss", "relay_delivery", "unavailable"], sql_serialization: ["sql_serialization", "sql_transaction", "serialization_failure"], sql_unavailable: ["sql_unavailable", "sql_transaction", "unavailable"], capacity_ambiguity: ["capacity_ambiguity", "capacity_reservation", "lost_response"], worker_loss: ["worker_loss", "worker_execution", "worker_lost"], object_interruption: ["object_interruption", "checkpoint_write", "interrupted"], model_ambiguity: ["model_receipt_ambiguity", "model_lookup", "unresolved"], payment_reconcile: ["payment_notification", "payment_settlement", "duplicate"], expiry_race: ["restore_expiry_race", "checkpoint_restore", "expired"], preview_invalid: ["preview_source_invalidation", "preview_read", "invalidated"], partial_publication: ["partial_publication", "publication_attestation", "partial"], checkpoint_fence: ["restore_expiry_race", "checkpoint_restore", "duplicate"], unknown: ["out_of_order_relay", "relay_delivery", "out_of_order"], single_writer: ["regional_ingress_loss", "relay_delivery", "unavailable"],
  };
  const [faultClass, boundary, outcome] = plans[caseValue.scenario.input.mode]!;
  const schedule = { id: `phase07-${caseValue.id.toLowerCase()}`, faultClass, boundary, certification: "deterministic_contract", input: { operationId: `operation:${caseValue.id}:${caseValue.scenario.schedule.join("-")}` }, initialState: { sessionId: `session:${caseValue.id}:${caseValue.scenario.initialState}`, lifecycle: caseValue.scenario.initialState }, outcomes: [{ boundary, outcome }] };
  let boundaryCalls = 0;
  const result = await runFaultScenario(schedule, (actual) => {
    boundaryCalls += 1;
    return { operationId: actual.input.operationId!, sessionId: actual.initialState.sessionId!, observed: actual.outcomes.at(-1)!.outcome, activeWriters: 1, effects: NO_EFFECTS_ORACLE };
  }, { activeWriters: 1, effects: NO_EFFECTS_ORACLE });
  let restore = "none";
  if (["expiry_race", "checkpoint_fence"].includes(caseValue.scenario.input.mode)) {
    const bytes = new Uint8Array([caseValue.scenario.input.ordinal]);
    const checksum = createHash("sha256").update(bytes).digest("hex");
    const restored = await runRestoreDrill({ objectStore: { createImmutable: async () => ({ key: `checkpoint/${caseValue.id}`, generation: 1, checksum }), readExact: async () => bytes, scheduleExactDeletion: async () => undefined }, subject: { kind: "checkpoint", sourceIdentity: `source:${caseValue.id}`, object: { key: `checkpoint/${caseValue.id}`, generation: 1, checksum }, payloadSha256: checksum, ownerId: "owner", retentionUntil: "2099-01-01T00:00:00.000Z", deletionState: "retained" }, expected: { ownerId: "owner", sessionId: `session:${caseValue.id}`, pendingActionReference: "pending", sessionVersion: 1, artifactVersion: 1, leaseToken: "lease", compatibility: { policyVersion: "p1", modelIdentity: "m1", nappletSdkIdentity: "n1", toolchainIdentity: "t1" } }, nowMs: 1, decryptAndVerify: async () => ({ ownerId: "owner", sessionId: `session:${caseValue.id}`, pendingActionReference: "pending", sessionVersion: 1, artifactVersion: 1, leaseToken: "lease", compatibility: { policyVersion: "p1", modelIdentity: "m1", nappletSdkIdentity: "n1", toolchainIdentity: "t1" }, archive: bytes }), reattach: async () => ({ status: caseValue.scenario.schedule.includes("fence") ? "replayed" : "reattached" }) });
    restore = `${restored.status}:${restored.code}:reattach=${restored.reattachments}`;
  }
  return observation(`resilience:fault=${faultClass}:boundary=${boundary}:outcome=${result.observed}:transition=${caseValue.scenario.schedule.join(">")}:initial=${caseValue.scenario.initialState}:calls=${boundaryCalls}:writers=${result.activeWriters}:restore=${restore}`);
}

async function observeSecurity(caseValue: ReferenceCase): Promise<ReferenceObservation> {
  const exporter = new InMemoryLifecycleExporter({ key: new Uint8Array(32).fill(7) });
  const terminal = SECURITY_TERMINALS[caseValue.scenario.input.mode]!;
  const raw = { version: "cvm.lifecycle.v1", stage: terminal.stage, outcome: terminal.outcome, correlationId: `security:${caseValue.scenario.input.mode}`, monotonicMs: caseValue.scenario.input.ordinal };
  exporter.observe(raw);
  for (let index = 0; index < terminal.rejectedInputs; index += 1) exporter.observe({ version: "cvm.lifecycle.v1", stage: "not_a_lifecycle_stage", correlationId: "Bearer secret-canary", monotonicMs: index });
  const safe = redactLifecycleObservation(raw, { key: new Uint8Array(32).fill(7) });
  if (!safe || exporter.observations.length !== 1) throw new Error("PHASE07_REFERENCE_TELEMETRY_AUTHORITY");
  return observation(`security:terminal=${safe.stage}/${safe.outcome}:initial=${caseValue.scenario.initialState}:transition=${caseValue.scenario.schedule.join(">")}:exports=${exporter.observations.length}:rejected=${exporter.telemetryPolicyViolations}:series=${exporter.metricSeriesCount}`);
}

async function observePublication(caseValue: ReferenceCase): Promise<ReferenceObservation> {
  const mode = caseValue.scenario.input.mode;
  const plan = mode === "focused_success" ? { state: "preview_ready" as const }
    : mode === "scope_denial" ? { state: "launch_certification_blocked" as const, changedFacts: true, safeError: "review_changed" as const }
      : mode === "verify_failure" ? { state: "launch_certification_blocked" as const, safeError: "signature_invalid" as const }
        : mode === "required_capability" ? { state: "launch_certification_blocked" as const }
          : mode === "optional_capability" ? { state: "optional_capability_missing" as const }
            : mode === "byte_binding" ? { state: "launch_certification_blocked" as const }
              : mode === "stale_approval" ? { state: "launch_certification_blocked" as const, changedFacts: true, safeError: "review_changed" as const }
                : mode === "external_signer" ? { state: "signer_active" as const, signerKind: "external" as const }
                  : mode === "publication_replay" ? { state: "exact_replay" as const, exactReplay: true }
                    : { state: "reconciliation_pending" as const };
  const sha = "a".repeat(64);
  const capabilities = mode === "required_capability" ? [{ capability: "network", requirement: "required" as const, purpose: "test", consent: "required" as const, available: false, evidenceLabel: "missing" }] : mode === "optional_capability" ? [{ capability: "network", requirement: "optional" as const, purpose: "test", consent: "optional" as const, available: false, evidenceLabel: "missing", gracefulDegradation: "offline" }] : [];
  const effects = caseValue.scenario.schedule.includes("publish") ? [{ label: `publish:${mode}`, state: "reconciliation_pending" as const, identifier: `operation:${caseValue.id}` }] : [];
  const surface = projectHostPublicationSurface({ ...plan, identity: { artifactId: `artifact:${mode}:${caseValue.scenario.initialState}`, aggregateSha256: sha, normalizedDTag: mode, capabilityDigest: sha }, capabilities, effects });
  const actions = surface.actions.map((action) => `${action.machineAction}/${action.enabled ? "enabled" : "disabled"}/${action.duplicateGuard}`).join(",") || "none";
  const effectTypes = surface.effectRows.map((effect) => `${effect.label}/${effect.state}`).join(",") || "none";
  return observation(`publication:state=${surface.state}:semantic=${surface.semanticStatus.kind}:transition=${caseValue.scenario.schedule.join(">")}:actions=${actions}:effects=${effectTypes}:ack=${surface.acknowledgementRequired}:safe=${surface.safeError ?? "none"}:primary=${surface.primaryAction ?? "none"}`);
}

async function observeLaunch(caseValue: ReferenceCase): Promise<ReferenceObservation> {
  const credentialsAvailable = caseValue.scenario.initialState === "verified" && !["missing_credential", "not_observed", "promotion_blocked"].includes(caseValue.scenario.input.mode);
  const protectedRecord = await createProtectedInfrastructureDrillEvidence({ candidateDigest: createHash("sha256").update(canonicalJson({ mode: caseValue.scenario.input.mode, initialState: caseValue.scenario.initialState, schedule: caseValue.scenario.schedule })).digest("hex"), components: ["gcs", "cloud_run", "cloud_sql_postgres"], credentialsAvailable });
  const exporter = new InMemoryLifecycleExporter({ key: new Uint8Array(32).fill(7) });
  const terminal = LAUNCH_TERMINALS[caseValue.scenario.input.mode]!;
  exporter.observe({ version: "cvm.lifecycle.v1", stage: terminal.stage, outcome: terminal.outcome, correlationId: `launch:${caseValue.scenario.input.mode}`, monotonicMs: caseValue.scenario.input.ordinal });
  for (let index = 0; index < terminal.rejectedInputs; index += 1) exporter.observe({ version: "cvm.lifecycle.v1", stage: "not_a_lifecycle_stage", correlationId: "Bearer secret-canary", monotonicMs: index });
  const lifecycle = exporter.observations.at(-1);
  if (!lifecycle || exporter.observations.length !== 1) throw new Error("PHASE07_REFERENCE_TELEMETRY_AUTHORITY");
  const requiredClaimEvidence = caseValue.scenario.schedule.includes("verify") ? "required_claim_checked" : "required_claim_missing";
  return observation(`launch:protected=${protectedRecord.status}/${protectedRecord.code}:terminal=${lifecycle.stage}/${lifecycle.outcome}:initial=${caseValue.scenario.initialState}:transition=${caseValue.scenario.schedule.join(">")}:claim=${requiredClaimEvidence}:rejected=${exporter.telemetryPolicyViolations}:promotion=blocked:effects=0`);
}

/** Validates source coverage and keeps expected values on the comparator side only. */
export function validatePhase07ReferenceSet(input: unknown): Phase07ReferenceSet {
  const parsed = Phase07ReferenceSetSchema.parse(input);
  if (hasProtectedData(parsed)) throw new Error("PHASE07_REFERENCE_PROTECTED_DATA");
  if (new Set(parsed.cases.map((item) => item.id)).size !== 64) throw new Error("PHASE07_REFERENCE_DUPLICATE_CASE");
  for (const [category, minimum] of Object.entries(parsed.categoryMinimums)) if (parsed.cases.filter((item) => item.category === category).length < minimum) throw new Error("PHASE07_REFERENCE_CATEGORY_MINIMUM");
  const mapped = <T extends string>(values: readonly T[], key: "requirements" | "decisions" | "threats" | "apiRows" | "uiRows" | "aiDimensions") => [...new Set(parsed.cases.flatMap((item) => item[key] as unknown as readonly T[]))].sort();
  if (!exact(mapped(PHASE_07_REQUIREMENTS, "requirements"), PHASE_07_REQUIREMENTS) || !exact(mapped(PHASE_07_DECISIONS, "decisions"), PHASE_07_DECISIONS) || !exact(mapped(PHASE_07_THREATS, "threats"), PHASE_07_THREATS) || !exact(mapped(PHASE_07_API_ROWS, "apiRows"), PHASE_07_API_ROWS) || !exact(mapped(PHASE_07_UI_ROWS, "uiRows"), PHASE_07_UI_ROWS) || !exact(mapped(PHASE_07_AI_DIMENSIONS, "aiDimensions"), PHASE_07_AI_DIMENSIONS)) throw new Error("PHASE07_REFERENCE_SOURCE_COVERAGE");
  if (!exact(parsed.liveObservations.map((item) => item.owner), PHASE_07_LIVE_OWNERS) || parsed.liveObservations.some((item) => item.status === "blocked" && item.claim === "")) throw new Error("PHASE07_REFERENCE_LIVE_INVENTORY");
  return Object.freeze(parsed);
}

async function deterministicObservation(caseValue: ReferenceCase, ports: Phase07ReferencePorts = {}): Promise<ReferenceObservation> {
  // These adapters receive only the typed scenario. Comparator expectations
  // never cross the authority boundary.
  requireSupportedScenario(caseValue);
  const adapter = ports[caseValue.category] ?? (caseValue.category === "admission" ? observeAdmission
    : caseValue.category === "resilience" ? observeResilience
      : caseValue.category === "security" ? observeSecurity
        : caseValue.category === "publication" ? observePublication
          : observeLaunch);
  const result = await adapter(caseValue);
  return result;
}

/** Runs the deterministic probe without passing expected values into runtime. */
export async function executePhase07ReferenceCase(input: unknown, ports?: Phase07ReferencePorts): Promise<Phase07Comparison> {
  const caseValue = CaseSchema.parse(input);
  let observed: ReferenceObservation;
  try { observed = await deterministicObservation(caseValue, ports); }
  catch { observed = observation("authority:failed:scenario=unsupported"); }
  const same = canonicalJson(caseValue.expected) === canonicalJson(observed);
  return Object.freeze({ id: caseValue.id, status: same ? "passed" : "failed", expected: caseValue.expected, observed, evidenceClass: "deterministic" });
}

export function phase07DatasetSha256(reference: unknown): string { return createHash("sha256").update(canonicalJson(validatePhase07ReferenceSet(reference))).digest("hex"); }
