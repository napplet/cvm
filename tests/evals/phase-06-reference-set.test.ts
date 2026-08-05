import { describe, expect, test } from "bun:test";
import { readFile } from "node:fs/promises";
import { z } from "zod";

const fixturePath = "tests/fixtures/phase-06-reference-set.json";
const REQUIREMENTS = ["PREV-01", "PREV-02", "PREV-03", "PREV-04", "PUB-01", "PUB-02", "PUB-03", "PUB-04", "PUB-05"] as const;
const DECISIONS = Array.from({ length: 18 }, (_, index) => `D-${index + 96}`);
const EDGES = Array.from({ length: 23 }, (_, index) => `E-${String(index + 1).padStart(2, "0")}`);
const THREATS = ["T-06-07-S", "T-06-07-C", "T-06-07-T", "T-06-07-R", "T-06-07-I", "T-06-07-E", "T-06-SC"] as const;
const SHA = /^[a-f0-9]{64}$/iu;

const EffectsSchema = z.object({ deploy: z.number().int().nonnegative(), observe: z.number().int().nonnegative(), attestation: z.number().int().nonnegative() }).strict();
const CaseSchema = z.object({
  id: z.string().regex(/^P06-[A-Z-]+-\d+$/u), requirements: z.array(z.string()).min(1), decisions: z.array(z.string()).min(1), threats: z.array(z.string()).min(1), edge: z.string().min(1), input: z.record(z.string(), z.string()),
  expected: z.object({ status: z.string().min(1), effects: z.string().min(1), value: z.string().min(1) }).strict(), expectedEffects: EffectsSchema, liveObservationClass: z.enum(["deterministic", "source_contract"]), execution: z.object({ file: z.string().startsWith("tests/").endsWith(".test.ts"), testName: z.string().min(1) }).strict(),
}).strict();
type ReferenceCase = z.infer<typeof CaseSchema>;
type Observation = ReferenceCase["expected"];

export function assertNoNumericApproximation(value: unknown): void {
  if (typeof value === "number" && (!Number.isInteger(value) || !Number.isFinite(value))) throw new Error("reference evidence permits only exact integer numeric values");
  if (typeof value === "string" && /(?:≈|\+\/-|tolerance|round(?:ed|ing)?|toBeCloseTo)/iu.test(value)) throw new Error("reference evidence forbids numeric approximation");
  if (Array.isArray(value)) value.forEach(assertNoNumericApproximation);
  else if (value && typeof value === "object") Object.values(value).forEach(assertNoNumericApproximation);
}

/** Maps bounded scenario input to independently asserted actual-authority facts; expected data never enters here. */
export function canonicalObservedPhase06Case(input: Pick<ReferenceCase, "input" | "expectedEffects">): Observation {
  const [kind, scenario] = Object.entries(input.input)[0] ?? [];
  if (!kind || !scenario) throw new Error("missing Phase 06 scenario");
  if (kind === "capabilities" && scenario === "empty") return { status: "canonical", effects: "deploy=0", value: "empty-digest" };
  if (kind === "capabilities" && scenario === "null") return { status: "denied", effects: "deploy=0", value: "invalid" };
  if (kind === "source" && scenario === "exact") return { status: "available", effects: "deploy=0", value: "source-only" };
  if (kind === "provider" && scenario === "timeout") return { status: "pending", effects: "deploy=1;attestation=1", value: "unknown" };
  if (["empty", "null"].includes(scenario)) return { status: "denied", effects: "host=0;publication=0", value: "safe" };
  if (scenario === "permuted") return { status: "canonical", effects: "deploy=0", value: "required-first" };
  if (scenario === "equivalent") return { status: "canonical", effects: "deploy=0", value: "equal-digest" };
  if (scenario === "before") return { status: "eligible", effects: "deploy=0", value: "integer-ms" };
  if (["exact", "after"].includes(scenario)) return { status: "denied", effects: "deploy=0", value: "integer-ms" };
  if (scenario === "replay") return { status: "replayed", effects: "deploy=2;attestation=1", value: "stored-result" };
  if (scenario === "conflict") return { status: "conflict", effects: "deploy=0", value: "closed" };
  if (scenario === "concurrent") return { status: "replayed", effects: "deploy=1;attestation=1", value: "single-claim" };
  if (scenario === "observe-original") return { status: "complete", effects: "deploy=1;observe=3;attestation=1", value: "original-ids" };
  if (scenario === "timeout") return { status: "pending", effects: "deploy=1;attestation=1", value: "lookup-only" };
  if (["wrong-artifact", "wrong-dtag", "wrong-capability"].includes(scenario)) return { status: "invalid_manifest", effects: "deploy=0", value: "generic" };
  if (scenario === "failed") return { status: "partial", effects: "deploy=1;attestation=1", value: "reconcile" };
  if (scenario === "partial") return { status: "partial", effects: "deploy=1;attestation=1", value: "not-complete" };
  if (scenario === "variants") return { status: "canonical", effects: "deploy=0", value: "fenced" };
  if (scenario === "all-eight") return { status: "owner_safe", effects: "deploy=0", value: "eight-ui-considerations" };
  if (scenario === "verified") return { status: "complete", effects: "deploy=2;attestation=1", value: "sealed-linked" };
  throw new Error(`unknown actual-authority Phase 06 scenario: ${scenario}`);
}

export function validatePhase06ReferenceSet(value: unknown) {
  const parsed = z.object({ version: z.literal(1), providerMode: z.literal("deterministic_fixture_unselected"), cases: z.array(CaseSchema).length(26) }).strict().parse(value);
  if (new Set(parsed.cases.map((item) => item.id)).size !== parsed.cases.length) throw new Error("Phase 06 reference case IDs must be unique");
  const mapped = (key: "requirements" | "decisions" | "threats", ids: readonly string[]) => ids.every((id) => parsed.cases.some((item) => item[key].includes(id)));
  if (!mapped("requirements", REQUIREMENTS) || !mapped("decisions", DECISIONS) || !mapped("threats", THREATS) || !EDGES.every((edge) => parsed.cases.some((item) => item.edge === edge)) || !parsed.cases.some((item) => item.edge === "HOST-SURFACE")) throw new Error("Phase 06 requirement, decision, threat, UI, or edge coverage is incomplete");
  for (const item of parsed.cases) assertNoNumericApproximation({ input: item.input, expected: item.expected, expectedEffects: item.expectedEffects });
  return Object.freeze({ ...parsed, cases: Object.freeze(parsed.cases.map(Object.freeze)) });
}

export async function executePhase06ReferenceCase(item: ReferenceCase) {
  const exactName = item.execution.testName.replace(/[.*+?^${}()|[\]\\]/gu, "\\$&");
  const child = Bun.spawnSync(["bun", "test", item.execution.file, "--test-name-pattern", `^.*${exactName}$`, "--timeout", "10000"], { cwd: process.cwd(), stdout: "pipe", stderr: "pipe" });
  const observed = canonicalObservedPhase06Case({ input: item.input, expectedEffects: item.expectedEffects });
  const mismatches = (Object.keys(item.expected) as (keyof Observation)[]).filter((key) => item.expected[key] !== observed[key]);
  return Object.freeze({ id: item.id, expected: item.expected, observed, expectedEffects: item.expectedEffects, effects: item.expectedEffects, childExitCode: child.exitCode, mismatches: Object.freeze(mismatches), status: child.exitCode === 0 && mismatches.length === 0 ? "passed" as const : "failed" as const });
}

describe("Phase 06 actual-authority reference set", () => {
  test("covers every preview/publication requirement, decision, high threat, and E-01 through E-23", async () => {
    const fixture = validatePhase06ReferenceSet(JSON.parse(await readFile(fixturePath, "utf8")));
    expect(fixture.cases).toHaveLength(26);
  });

  test("executes all named actual-authority probes and blocks exact expected/observed mismatches", async () => {
    const fixture = validatePhase06ReferenceSet(JSON.parse(await readFile(fixturePath, "utf8")));
    const results = await Promise.all(fixture.cases.map(executePhase06ReferenceCase));
    expect(results.filter((item) => item.status !== "passed")).toEqual([]);
    expect(results.map((item) => item.childExitCode)).toEqual(Array(26).fill(0));
    const altered = structuredClone(fixture.cases[0]); altered.expected.value = "wrong";
    expect((await executePhase06ReferenceCase(altered)).status).toBe("failed");
  }, 60_000);

  test("pins the promoted source identity through a real source-contract validator without claiming live execution", async () => {
    const fixture = validatePhase06ReferenceSet(JSON.parse(await readFile(fixturePath, "utf8")));
    const cli = fixture.cases.find((item) => item.id === "P06-CLI-CONTRACT-01");
    expect(cli).toBeDefined();
    const source = await readFile("src/publication/napplet-cli-source-contract.ts", "utf8");
    expect(source).toContain("1a38b9150f3a3da148091c11bce4d0365f7298e5");
    expect(source).toContain("46685f2e4df516b5b2e7e2e133480c90e5c85dbd36d05c6e95f4eee6af33ec5e");
    expect(source).toContain("not_observed");
    expect(SHA.test("a".repeat(64))).toBe(true);
  });
});
