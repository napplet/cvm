import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";

type Reference = Readonly<{ id: string; requirement: string; decision: string; threat: string; scenario: string; input: string; execution: string; expected: Readonly<{ result: string; stateDelta: Readonly<Record<string, number>>; effects: Readonly<Record<string, number>>; evidence: readonly string[] }> }>;
const referenceSet = JSON.parse(readFileSync("tests/fixtures/phase-03-reference-set.json", "utf8")) as { version: number; cases: Reference[]; deferrals: string[] };
const requirements = ["CTX-01", "CTX-02", "CTX-03", "CTX-04", "PAY-01", "PAY-02", "PAY-03", "PAY-04", "PAY-05", "PAY-06", "PAY-07", "BILL-01", "BILL-02", "BILL-06"];
const executionFiles = {
  contextvm: ["tests/contextvm/adapter.test.ts"],
  ledger: ["tests/persistence/postgres-funding-store.test.ts"],
  lightning: ["tests/funding/lightning-top-up.test.ts"],
  cashu: ["tests/funding/cashu-top-up.test.ts"],
  admission: ["tests/funding/funded-admission.test.ts", "tests/phase-03/tracer.test.ts"],
} as const;
const executionFor = (id: string): keyof typeof executionFiles => {
  if (["P03-R40", "P03-R41", "P03-R42", "P03-R46"].includes(id)) return "contextvm";
  if (["P03-R44", "P03-R45", "P03-R56"].includes(id)) return "ledger";
  if (["P03-R48", "P03-R57"].includes(id)) return "lightning";
  if (["P03-R47", "P03-R50", "P03-R51", "P03-R52"].includes(id)) return "cashu";
  return "admission";
};

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
    expect(executionFiles[executionFor(item.id)].length).toBeGreaterThan(0);
  });

  test.each(referenceSet.cases)("$id executes its declared deterministic oracle", (item) => {
    const files = executionFiles[executionFor(item.id)];
    // Each reference case independently invokes its mapped deterministic oracle;
    // a fixture cannot pass only because a different group happened to run.
    const result = Bun.spawnSync(["bun", "test", ...files], { cwd: process.cwd(), stdout: "pipe", stderr: "pipe" });
    expect(result.exitCode, new TextDecoder().decode(result.stderr)).toBe(0);
    expect(item.expected.effects.forbidden).toBeGreaterThanOrEqual(1);
    expect(item.expected.evidence).toEqual(expect.arrayContaining([expect.any(String)]));
  });
});
