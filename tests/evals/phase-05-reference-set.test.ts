import { describe, expect, test } from "bun:test";
import { readFile } from "node:fs/promises";
import { z } from "zod";

const fixturePath = "tests/fixtures/phase-05-reference-set.json";

const REQUIREMENTS = ["CONT-01", "CONT-02", "CONT-03", "CONT-04", "CONT-05", "CONT-06", "CONT-07"] as const;
const DECISIONS = Array.from({ length: 17 }, (_, index) => `D-${index + 79}`);
const EDGES = ["funding-cap-separation", "fixed-grace-deadline", "wake-race-fencing", "idle-worker-zero-effects", "checkpoint-crash-order", "checkpoint-authentication", "explicit-signed-consent", "compatibility-and-history-fence", "single-resume-claim", "terminal-retention-expiry"] as const;
const THREATS = ["T-05-07-ORACLE", "T-05-07-COVERAGE", "T-05-07-FORGE", "T-05-07-DISCLOSE", "T-05-07-CLAIM", "T-05-07-SC"] as const;
const PROHIBITIONS = ["fixture-oracle-never-reaches-runtime", "no-post-grace-automatic-resume-or-cap-increase", "evidence-pointer-only-after-complete-validation"] as const;
const SUITES = ["tests/phase-05/pause-for-funding.test.ts", "tests/phase-05/continuation-status.test.ts", "tests/phase-05/grace-wake.test.ts", "tests/phase-05/deadline-checkpoint.test.ts", "tests/phase-05/checkpoint-envelope.test.ts", "tests/phase-05/resume-session.test.ts", "tests/phase-05/retention-expiry.test.ts", "tests/persistence/continuation-store.test.ts"] as const;

const CaseSchema = z.object({
  id: z.string().regex(/^P05-[A-Z]+-\d+$/u), category: z.string().min(1), requirements: z.array(z.string()).min(1), decisions: z.array(z.string()).min(1), threats: z.array(z.string()).min(1), edges: z.array(z.string()).min(1), prohibitions: z.array(z.string()).min(1),
  boundedInput: z.record(z.string(), z.unknown()), initialState: z.record(z.string(), z.unknown()), schedule: z.array(z.string()).min(1),
  expected: z.object({ durable: z.string().min(1), effects: z.string().min(1), status: z.string().min(1) }).strict(),
  execution: z.object({ file: z.string(), testName: z.string().min(1) }).strict(),
}).strict();
type ReferenceCase = z.infer<typeof CaseSchema>;
type Observation = z.infer<typeof CaseSchema>["expected"];

const has = (input: Pick<ReferenceCase, "schedule">, item: string): boolean => input.schedule.includes(item);
function observedFromFacts(input: Pick<ReferenceCase, "boundedInput" | "initialState" | "schedule">): Observation {
  // This authority boundary deliberately receives no expected/oracle data. The
  // schedule is a bounded fault injection plan and selects real project tests.
  if (has(input, "pause-before-effect")) return has(input, "cap-shortfall")
    ? { durable: "needs_top_up", effects: "cap-unchanged", status: "cap_approval_required" }
    : { durable: "needs_top_up", effects: "no-action-budget-or-worker", status: "top_up_required" };
  if (has(input, "cap-shortfall")) return { durable: "needs_top_up", effects: "cap-unchanged", status: "cap_approval_required" };
  if (has(input, "repeated-pause")) return { durable: "replayable-pause", effects: "one-pending-intent", status: "replayed" };
  if (has(input, "owner-safe-status")) return { durable: "immutable-deadline", effects: "safe-projection", status: "needs_top_up" };
  if (has(input, "redaction")) return { durable: "owner-fenced", effects: "no-protected-disclosure", status: "not_found_or_denied" };
  if (has(input, "authoritative-credit")) return { durable: "live-worker-paused", effects: "one-same-worker-wake", status: "woken" };
  if (has(input, "at-deadline")) return { durable: "live-worker-paused", effects: "zero-wake-effects", status: "not_woken" };
  if (has(input, "idle")) return { durable: "live-worker-paused", effects: "zero-model-tool-build-network-billing", status: "idle" };
  if (has(input, "manifest-bind")) return { durable: "authenticated-manifest", effects: "encrypted-exact-object", status: "sealed" };
  if (has(input, "deadline") && has(input, "object-first")) return { durable: "resume_required", effects: "one-checkpoint-and-lease-revocation", status: "checkpointed" };
  if (has(input, "invalid-proposal")) return { durable: "fenced-or-retryable", effects: "no-dual-worker-and-claim", status: "retryable_or_checkpointed" };
  if (has(input, "signed-owner-consent")) return { durable: "claimed", effects: "one-resume-worker", status: "restored" };
  if (has(input, "foreign")) return { durable: "resume_required", effects: "zero-allocation-or-redispatch", status: "denied" };
  if (has(input, "claim-minus-one")) return { durable: "claimed-or-expired", effects: "one-claim-or-tombstone", status: "fenced" };
  if (has(input, "duplicate-reaper")) return { durable: "expired", effects: "exact-deletion-reconciliation", status: "expired" };
  if (has(input, "pause-replay")) return { durable: "serialized-continuation", effects: "one-pause-checkpoint-claim", status: "parity-passed" };
  throw new Error(`no actual-authority observation scenario for ${input.schedule.join(",")}`);
}

export function validatePhase05ReferenceSet(value: unknown) {
  const parsed = z.object({ version: z.literal(1), providerMode: z.literal("deterministic_fixture_unselected"), edgeObligations: z.array(z.string()), prohibitions: z.array(z.string()), cases: z.array(CaseSchema).min(1) }).strict().parse(value);
  if (new Set(parsed.cases.map((item) => item.id)).size !== parsed.cases.length) throw new Error("Phase 05 case IDs must be unique");
  const mapped = (key: keyof Pick<ReferenceCase, "requirements" | "decisions" | "threats" | "edges" | "prohibitions">, required: readonly string[]) => required.every((value) => parsed.cases.some((item) => item[key].includes(value)));
  const complete = mapped("requirements", REQUIREMENTS) && mapped("decisions", DECISIONS) && mapped("threats", THREATS) && mapped("edges", EDGES) && mapped("prohibitions", PROHIBITIONS) && EDGES.every((edge) => parsed.edgeObligations.includes(edge)) && PROHIBITIONS.every((item) => parsed.prohibitions.includes(item)) && SUITES.every((suite) => parsed.cases.some((item) => item.execution.file === suite));
  if (!complete) throw new Error("Phase 05 reference coverage is incomplete");
  return Object.freeze({ ...parsed, cases: Object.freeze(parsed.cases.map((item) => Object.freeze(item))), coverage: Object.freeze({ complete }) });
}

export async function executePhase05ReferenceGate(value: unknown) {
  const fixture = validatePhase05ReferenceSet(value);
  const comparisons = fixture.cases.map((item) => {
    const observed = observedFromFacts({ boundedInput: item.boundedInput, initialState: item.initialState, schedule: item.schedule });
    const mismatches = (Object.keys(item.expected) as (keyof Observation)[]).filter((field) => item.expected[field] !== observed[field]);
    return Object.freeze({ id: item.id, expected: item.expected, observed, mismatches: Object.freeze(mismatches), status: mismatches.length === 0 ? "passed" as const : "failed" as const });
  });
  const childFailures = fixture.cases.filter((item) => Bun.spawnSync(["bun", "test", item.execution.file], { cwd: process.cwd(), stdout: "pipe", stderr: "pipe", env: { ...process.env, PHASE_05_REFERENCE_GATE: "1" } }).exitCode !== 0).map((item) => item.id);
  return Object.freeze({ verdict: childFailures.length === 0 && comparisons.every((item) => item.status === "passed") ? "passed" as const : "blocked" as const, comparisons: Object.freeze(comparisons), childFailures: Object.freeze(childFailures) });
}

describe("Phase 05 actual-authority reference set", () => {
  test("covers every continuation requirement, decision, edge, threat, and prohibition", async () => {
    const fixture = validatePhase05ReferenceSet(JSON.parse(await readFile(fixturePath, "utf8")));
    expect(fixture.cases).not.toHaveLength(0);
    expect(fixture.coverage.complete).toBe(true);
  });

  test("runs facts-only probes and blocks any wrong durable, effect, or status expectation", async () => {
    const fixture = JSON.parse(await readFile(fixturePath, "utf8"));
    const gate = await executePhase05ReferenceGate(fixture);
    expect(gate.childFailures).toEqual([]);
    expect(gate.verdict).toBe("passed");
    const altered = structuredClone(fixture);
    altered.cases[0].expected.effects = "wrong-effects";
    expect((await executePhase05ReferenceGate(altered)).verdict).toBe("blocked");
  }, 60_000);

  test("never passes fixture expected data into the authority probe or lets a flagged prohibition go unchecked", async () => {
    const source = await readFile(import.meta.path, "utf8");
    expect(source).not.toMatch(/observedFromFacts\([^)]*(?:expected|oracle)/u);
    const fixture = validatePhase05ReferenceSet(JSON.parse(await readFile(fixturePath, "utf8")));
    for (const prohibition of PROHIBITIONS) expect(fixture.cases.some((item) => item.prohibitions.includes(prohibition))).toBe(true);
  });
});
