import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";

type Reference = Readonly<{ id: string; requirement: string; decision: string; threat: string; scenario: string; input: string; execution: string; expected: Readonly<{ result: string; stateDelta: Readonly<Record<string, number>>; effects: Readonly<Record<string, number>>; evidence: readonly string[] }> }>;
const referenceSet = JSON.parse(readFileSync("tests/fixtures/phase-03-reference-set.json", "utf8")) as { version: number; cases: Reference[]; deferrals: string[] };
const requirements = ["CTX-01", "CTX-02", "CTX-03", "CTX-04", "PAY-01", "PAY-02", "PAY-03", "PAY-04", "PAY-05", "PAY-06", "PAY-07", "BILL-01", "BILL-02", "BILL-06"];

describe("Phase 03 deterministic reference set", () => {
  test("maps every requirement and D-40 through D-58 to an executable deterministic oracle", () => {
    expect(referenceSet.version).toBe(1);
    expect(referenceSet.cases).toHaveLength(19);
    expect(new Set(referenceSet.cases.map((item) => item.id)).size).toBe(19);
    expect(new Set(referenceSet.cases.map((item) => item.decision))).toEqual(new Set(Array.from({ length: 19 }, (_, index) => `D-${index + 40}`)));
    expect(new Set(referenceSet.cases.map((item) => item.requirement))).toEqual(new Set(requirements));
    expect(referenceSet.deferrals).toEqual(["phase-04-exact-usage-debit", "phase-05-interruption-resume", "phase-06-preview-publication", "phase-07-live-slo-provider-provenance-certification", "v2-x402-l402"]);
  });

  test.each(referenceSet.cases)("$id has exact result, durable state, effect, evidence, and execution oracles", (item) => {
    expect(item.id).toMatch(/^P03-R(?:4[0-9]|5[0-8])$/);
    expect(item.expected.result).toMatch(/^[A-Z0-9_]+$/);
    expect(item.expected.stateDelta).toEqual(expect.objectContaining({ commands: expect.any(Number), postings: expect.any(Number), holds: expect.any(Number), outbox: expect.any(Number) }));
    expect(item.expected.effects).toEqual({ allowed: expect.any(Number), forbidden: expect.any(Number) });
    expect(item.expected.evidence.length).toBeGreaterThan(0);
    expect(item.execution).toBe("deterministic");
  });
});
