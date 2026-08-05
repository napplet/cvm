import { describe, expect, test } from "bun:test";
import { readFile } from "node:fs/promises";
import { executePhase07ReferenceCase, validatePhase07ReferenceSet } from "../../src/certification/phase-07-reference-set.js";

const fixturePath = "tests/fixtures/phase-07-reference-set.json";

describe("Phase 07 actual-authority reference set", () => {
  test("contains the locked 64-case source-complete corpus", async () => {
    const fixture = validatePhase07ReferenceSet(JSON.parse(await readFile(fixturePath, "utf8")));
    expect(fixture.cases).toHaveLength(64);
    expect(Object.fromEntries(Object.entries(fixture.categoryMinimums))).toEqual({ admission: 12, resilience: 16, security: 16, publication: 10, launch: 10 });
  });

  test("executes comparator-only cases and rejects a wrong oracle", async () => {
    const fixture = validatePhase07ReferenceSet(JSON.parse(await readFile(fixturePath, "utf8")));
    const results = await Promise.all(fixture.cases.map(executePhase07ReferenceCase));
    expect(results.filter((item) => item.status !== "passed")).toEqual([]);
    const altered = structuredClone(fixture.cases[0]);
    altered.expected.value = "wrong";
    expect((await executePhase07ReferenceCase(altered)).status).toBe("failed");
  }, 60_000);

  test("keeps protected-live observations non-passing and rejects protected canaries", async () => {
    const fixture = validatePhase07ReferenceSet(JSON.parse(await readFile(fixturePath, "utf8")));
    expect(fixture.liveObservations.every((item) => item.status === "blocked" || item.status === "not_observed")).toBe(true);
    const contaminated = structuredClone(fixture);
    contaminated.liveObservations[0].limitation = "Bearer secret-canary";
    expect(() => validatePhase07ReferenceSet(contaminated)).toThrow();
  });
});
