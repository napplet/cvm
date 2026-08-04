import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";

type ReferenceCase = Readonly<{
  id: string;
  category: string;
  untrustedEnvelope: unknown;
  initialState: Readonly<{ version: number }>;
  policy: Readonly<{ policyVersion: string }>;
  grant: Readonly<Record<string, unknown>>;
  expected: Readonly<{
    code: string;
    stateDelta: number;
    allowedEffects: number;
    forbiddenEffects: number;
    requiredEvidence: readonly string[];
  }>;
}>;

const referenceSet = JSON.parse(readFileSync("tests/fixtures/phase-02-reference-set.json", "utf8")) as { version: number; cases: ReferenceCase[] };

describe("Phase 02 deterministic reference set", () => {
  test("contains exactly the complete 16-case security/state matrix", () => {
    expect(referenceSet.version).toBe(1);
    expect(referenceSet.cases).toHaveLength(16);
    expect(new Set(referenceSet.cases.map((item) => item.id)).size).toBe(16);
    expect(referenceSet.cases.map((item) => item.category)).toEqual([
      "accepted", "accepted", "accepted", "admission", "admission", "admission", "authority", "authority",
      "authority", "authority", "serialization", "serialization", "recovery", "recovery", "provider-boundary", "provider-boundary",
    ]);
  });

  test.each(referenceSet.cases)("$id has executable result, state, effect, and evidence oracles", (item) => {
    expect(item.id).toMatch(/^P02-R\d\d$/);
    expect(item.untrustedEnvelope).toBeDefined();
    expect(item.initialState.version).toBeGreaterThanOrEqual(0);
    expect(item.policy.policyVersion).toMatch(/^phase-02-policy-/);
    expect(item.grant).toBeDefined();
    expect(item.expected.code).toMatch(/^[A-Z0-9_]+$/);
    expect(item.expected.stateDelta).toBeGreaterThanOrEqual(0);
    expect(item.expected.allowedEffects).toBeGreaterThanOrEqual(0);
    expect(item.expected.forbiddenEffects).toBeGreaterThanOrEqual(0);
    expect(item.expected.requiredEvidence.length).toBeGreaterThan(0);
  });
});
