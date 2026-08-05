import { z } from "zod";

const REQUIREMENTS = ["PREV-01", "PREV-02", "PREV-03", "PREV-04", "PUB-01", "PUB-02", "PUB-03", "PUB-04", "PUB-05"] as const;
const DECISIONS = Array.from({ length: 18 }, (_, index) => `D-${index + 96}`);
const EDGES = Array.from({ length: 23 }, (_, index) => `E-${String(index + 1).padStart(2, "0")}`);
const THREATS = ["T-06-07-S", "T-06-07-C", "T-06-07-T", "T-06-07-R", "T-06-07-I", "T-06-07-E", "T-06-SC"] as const;

const EffectsSchema = z.object({ deploy: z.number().int().nonnegative(), observe: z.number().int().nonnegative(), attestation: z.number().int().nonnegative() }).strict();
const CaseSchema = z.object({
  id: z.string().regex(/^P06-[A-Z-]+-\d+$/u), requirements: z.array(z.string()).min(1), decisions: z.array(z.string()).min(1), threats: z.array(z.string()).min(1), edge: z.string().min(1), input: z.record(z.string(), z.string()),
  expected: z.object({ status: z.string().min(1), effects: z.string().min(1), value: z.string().min(1) }).strict(), expectedEffects: EffectsSchema, liveObservationClass: z.enum(["deterministic", "source_contract"]), execution: z.object({ file: z.string().startsWith("tests/").endsWith(".test.ts"), testName: z.string().min(1) }).strict(),
}).strict();
export type Phase06ReferenceCase = z.infer<typeof CaseSchema>;
type Observation = Phase06ReferenceCase["expected"];
type EffectCounts = z.infer<typeof EffectsSchema>;

type BunSpawnResult = Readonly<{ stdout: ArrayBuffer | ArrayBufferView; stderr: ArrayBuffer | ArrayBufferView; exitCode: number }>;
type BunRuntime = Readonly<{ spawnSync(command: readonly string[], options: Readonly<{ cwd: string; stdout: "pipe"; stderr: "pipe"; env: Record<string, string | undefined> }>): BunSpawnResult }>;
type RuntimeGlobals = Readonly<{ Bun: BunRuntime; process: Readonly<{ cwd(): string; env: Record<string, string | undefined> }> }>;
const runtime = globalThis as unknown as RuntimeGlobals;

export function assertNoNumericApproximation(value: unknown): void {
  if (typeof value === "number" && (!Number.isInteger(value) || !Number.isFinite(value))) throw new Error("reference evidence permits only exact integer numeric values");
  if (typeof value === "string" && /(?:≈|\+\/-|tolerance|round(?:ed|ing)?|toBeCloseTo)/iu.test(value)) throw new Error("reference evidence forbids numeric approximation");
  if (Array.isArray(value)) value.forEach(assertNoNumericApproximation);
  else if (value && typeof value === "object") Object.values(value).forEach(assertNoNumericApproximation);
}

function observationsFrom(output: string): ReadonlyMap<string, Observation> {
  const values = new Map<string, Observation>();
  for (const match of output.matchAll(/^PHASE06_OBSERVATION:(.+)$/gmu)) {
    const value = z.object({ id: z.string(), status: z.string(), effects: z.string(), value: z.string() }).strict().parse(JSON.parse(match[1]));
    values.set(value.id, { status: value.status, effects: value.effects, value: value.value });
  }
  return values;
}

function effectsFrom(observation: Observation): EffectCounts {
  const counts = { deploy: 0, observe: 0, attestation: 0 };
  const seen = new Set<string>();
  for (const part of observation.effects.split(";")) {
    const match = /^(deploy|observe|attestation|host|publication)=(\d+)$/u.exec(part);
    if (!match || seen.has(match[1])) throw new Error("Phase 06 observation effects are malformed");
    seen.add(match[1]);
    const count = Number(match[2]);
    if (!Number.isSafeInteger(count) || (match[1] === "host" || match[1] === "publication") && count !== 0) throw new Error("Phase 06 observation effects are unsafe");
    if (match[1] === "deploy" || match[1] === "observe" || match[1] === "attestation") counts[match[1]] = count;
  }
  return EffectsSchema.parse(counts);
}

export function validatePhase06ReferenceSet(value: unknown) {
  const parsed = z.object({ version: z.literal(1), providerMode: z.literal("deterministic_fixture_unselected"), cases: z.array(CaseSchema).length(26) }).strict().parse(value);
  if (new Set(parsed.cases.map((item) => item.id)).size !== parsed.cases.length) throw new Error("Phase 06 reference case IDs must be unique");
  const mapped = (key: "requirements" | "decisions" | "threats", ids: readonly string[]) => ids.every((id) => parsed.cases.some((item) => item[key].includes(id)));
  if (!mapped("requirements", REQUIREMENTS) || !mapped("decisions", DECISIONS) || !mapped("threats", THREATS) || !EDGES.every((edge) => parsed.cases.some((item) => item.edge === edge)) || !parsed.cases.some((item) => item.edge === "HOST-SURFACE")) throw new Error("Phase 06 requirement, decision, threat, UI, or edge coverage is incomplete");
  for (const item of parsed.cases) assertNoNumericApproximation({ input: item.input, expected: item.expected, expectedEffects: item.expectedEffects });
  return Object.freeze({ ...parsed, cases: Object.freeze(parsed.cases.map(Object.freeze)) });
}

export async function executePhase06ReferenceCase(item: Phase06ReferenceCase) {
  const exactName = item.execution.testName.replace(/[.*+?^${}()|[\]\\]/gu, "\\$&");
  const child = runtime.Bun.spawnSync(["bun", "test", item.execution.file, "--test-name-pattern", `^.*${exactName}$`, "--timeout", "10000"], { cwd: runtime.process.cwd(), stdout: "pipe", stderr: "pipe", env: { ...runtime.process.env, PHASE06_REFERENCE_OBSERVATIONS: "1" } });
  const observed = observationsFrom(`${new TextDecoder().decode(child.stdout)}\n${new TextDecoder().decode(child.stderr)}`).get(item.id);
  if (!observed) return Object.freeze({ id: item.id, expected: item.expected, observed: undefined, expectedEffects: item.expectedEffects, effects: undefined, childExitCode: child.exitCode, mismatches: Object.freeze(["structured_observation_missing"]), status: "failed" as const });
  const effects = effectsFrom(observed);
  const mismatches = [
    ...(Object.keys(item.expected) as (keyof Observation)[]).filter((key) => item.expected[key] !== observed[key]),
    ...(Object.keys(item.expectedEffects) as (keyof EffectCounts)[]).filter((key) => item.expectedEffects[key] !== effects[key]).map((key) => `effect_${key}_mismatch`),
  ];
  return Object.freeze({ id: item.id, expected: item.expected, observed, expectedEffects: item.expectedEffects, effects, childExitCode: child.exitCode, mismatches: Object.freeze(mismatches), status: child.exitCode === 0 && mismatches.length === 0 ? "passed" as const : "failed" as const });
}
