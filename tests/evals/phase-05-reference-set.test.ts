import { describe, expect, test } from "bun:test";
import { readFile } from "node:fs/promises";
import { executePhase05ReferenceGate, validatePhase05ReferenceSet } from "./phase-05-runtime-observation";

const fixturePath = "tests/fixtures/phase-05-reference-set.json";

describe("Phase 05 actual-authority reference set", () => {
  test("covers every continuation requirement, decision, edge, threat, and prohibition", async () => {
    const fixture = validatePhase05ReferenceSet(JSON.parse(await readFile(fixturePath, "utf8")));
    expect(fixture.cases).not.toHaveLength(0);
    expect(fixture.coverage.complete).toBe(true);
  });

  test("runs facts-only probes and blocks any wrong durable, effect, or status expectation", async () => {
    const fixture = JSON.parse(await readFile(fixturePath, "utf8"));
    const gate = await executePhase05ReferenceGate(fixture);
    expect(gate.verdict).toBe("passed");
    const altered = structuredClone(fixture);
    altered.cases[0].expected.effects = "wrong-effects";
    expect((await executePhase05ReferenceGate(altered)).verdict).toBe("blocked");
  }, 60_000);
});
