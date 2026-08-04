import { z } from "zod";
import { observeFundedStart } from "./phase-04-runtime-financial";

const effectFields = ["providerDispatches", "providerLookups", "workerCalls", "receiptWrites", "debitPostings", "creditPostings", "releases"] as const;
export const Phase04RuntimeObservationSchema = z.object({
  providerDispatches: z.number().int().nonnegative(), providerLookups: z.number().int().nonnegative(), workerCalls: z.number().int().nonnegative(), receiptWrites: z.number().int().nonnegative(), debitPostings: z.number().int().nonnegative(), creditPostings: z.number().int().nonnegative(), releases: z.number().int().nonnegative(),
  actionState: z.string().min(1), sessionState: z.string().min(1), artifactVersion: z.number().int().nonnegative(), evidence: z.string().min(1), providerSelection: z.literal("unselected"), status: z.string().min(1), nextAction: z.string().min(1),
}).strict();
export type Phase04RuntimeObservation = z.infer<typeof Phase04RuntimeObservationSchema>;
export type Phase04RuntimeCaseInput = Readonly<{ id: string; boundedInput: Record<string, unknown>; initialState: Record<string, unknown>; schedule: readonly string[] }>;
type ExpectedObservation = Phase04RuntimeObservation & Readonly<{ oracle: string }>;
export type Phase04CaseComparison = Readonly<{ id: string; status: "passed" | "failed"; mismatches: readonly (keyof Phase04RuntimeObservation)[]; expected: Phase04RuntimeObservation; observed: Phase04RuntimeObservation }>;

function expectedObservation(value: unknown): Phase04RuntimeObservation {
  const parsed = z.object({ ...Phase04RuntimeObservationSchema.shape, oracle: z.string() }).strict().parse(value);
  const { oracle: _oracle, ...expected } = parsed;
  return expected;
}

/** Runtime scenarios accept only case facts, never an expected oracle or pass status. */
export async function observePhase04Case(input: Phase04RuntimeCaseInput): Promise<Phase04RuntimeObservation> {
  if (!input || input.id !== "P04-ACCT-03" || !input.boundedInput || !input.initialState || !Array.isArray(input.schedule)) throw new Error(`no runtime scenario registered for ${input?.id ?? "unknown"}`);
  return Phase04RuntimeObservationSchema.parse(await observeFundedStart());
}

export function comparePhase04Case(id: string, expectedValue: unknown, observedValue: unknown): Phase04CaseComparison {
  const expected = expectedObservation(expectedValue);
  const observed = Phase04RuntimeObservationSchema.parse(observedValue);
  const mismatches = (Object.keys(Phase04RuntimeObservationSchema.shape) as (keyof Phase04RuntimeObservation)[]).filter((field) => expected[field] !== observed[field]);
  return Object.freeze({ id, status: mismatches.length === 0 ? "passed" : "failed", mismatches: Object.freeze(mismatches), expected: Object.freeze(expected), observed: Object.freeze(observed) });
}

export function aggregateObservedEffects(comparisons: readonly Phase04CaseComparison[]): Readonly<Record<(typeof effectFields)[number], number>> | undefined {
  if (comparisons.some((comparison) => comparison.status !== "passed")) return undefined;
  return Object.freeze(Object.fromEntries(effectFields.map((field) => [field, comparisons.reduce((sum, comparison) => sum + comparison.observed[field], 0)])) as Record<(typeof effectFields)[number], number>);
}

/** Partial during tracer work: unmatched/non-observed cases fail closed. */
export async function executePhase04ReferenceGate(value: unknown) {
  const cases = z.object({ cases: z.array(z.object({ id: z.string(), boundedInput: z.record(z.string(), z.unknown()), initialState: z.record(z.string(), z.unknown()), schedule: z.array(z.string()), expected: z.unknown() })) }).parse(value).cases;
  const comparisons = await Promise.all(cases.map(async (item) => {
    if (item.id !== "P04-ACCT-03") return undefined;
    return comparePhase04Case(item.id, item.expected, await observePhase04Case(item));
  }));
  const observed = comparisons.filter((comparison): comparison is Phase04CaseComparison => comparison !== undefined);
  const complete = observed.length === cases.length;
  const passed = complete && observed.every((comparison) => comparison.status === "passed");
  return Object.freeze({ verdict: passed ? "passed" as const : "blocked" as const, comparisons: Object.freeze(observed), aggregateEffects: passed ? aggregateObservedEffects(observed) : undefined });
}
