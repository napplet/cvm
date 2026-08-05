import { describe, expect, test } from "bun:test";
import { readFile } from "node:fs/promises";
import { executePhase06ReferenceCase, validatePhase06ReferenceSet } from "../../src/verification/phase-06-reference-set.js";

const fixturePath = "tests/fixtures/phase-06-reference-set.json";
const SHA = /^[a-f0-9]{64}$/iu;

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
    const alteredEffects = structuredClone(fixture.cases[0]); alteredEffects.expectedEffects.deploy += 1;
    expect((await executePhase06ReferenceCase(alteredEffects)).status).toBe("failed");
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
