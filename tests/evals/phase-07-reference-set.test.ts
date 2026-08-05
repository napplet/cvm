import { describe, expect, test } from "bun:test";
import { readFile } from "node:fs/promises";
import { executePhase07ReferenceCase, validatePhase07ReferenceSet } from "../../src/certification/phase-07-reference-set.js";
import { buildPhase07DesignEvidence, validatePhase07DesignEvidence } from "../../src/certification/evidence.js";

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

  test("binds each named authority observation to its typed scenario, never its coverage ID", async () => {
    const fixture = validatePhase07ReferenceSet(JSON.parse(await readFile(fixturePath, "utf8")));
    const results = await Promise.all(fixture.cases.map(executePhase07ReferenceCase));
    expect(results).toHaveLength(64);
    expect(results.map((result) => result.id).sort()).toEqual(fixture.cases.map((item) => item.id).sort());
    for (const category of ["admission", "resilience", "security", "publication", "launch"] as const) {
      const original = fixture.cases.find((item) => item.category === category)!;
      const changed = structuredClone(original);
      changed.scenario.schedule = [...changed.scenario.schedule, "semantic_canary"];
      expect((await executePhase07ReferenceCase(changed)).status).toBe("failed");
    }
    const unsupported = structuredClone(fixture.cases[0]);
    unsupported.scenario.input.mode = "semantic_canary";
    expect((await executePhase07ReferenceCase(unsupported)).status).toBe("failed");
  }, 60_000);

  test("keeps comparator expectations out of authority adapters", async () => {
    const source = await readFile("src/certification/phase-07-reference-set.ts", "utf8");
    const adapterSource = source.slice(source.indexOf("async function observeAdmission"), source.indexOf("/** Runs the deterministic probe"));
    expect(adapterSource).not.toMatch(/\.expected\b/u);
    expect(adapterSource).toContain("runAdmissionAttempt");
    expect(adapterSource).toContain("runFaultScenario");
    expect(adapterSource).toContain("InMemoryLifecycleExporter");
    expect(adapterSource).toContain("projectHostPublicationSurface");
    expect(adapterSource).toContain("createProtectedInfrastructureDrillEvidence");
  });

  test("keeps protected-live observations non-passing and rejects protected canaries", async () => {
    const fixture = validatePhase07ReferenceSet(JSON.parse(await readFile(fixturePath, "utf8")));
    expect(fixture.liveObservations.every((item) => item.status === "blocked" || item.status === "not_observed")).toBe(true);
    const contaminated = structuredClone(fixture);
    contaminated.liveObservations[0].limitation = "Bearer secret-canary";
    expect(() => validatePhase07ReferenceSet(contaminated)).toThrow();
  });

  test("builds canonical deterministic evidence and rejects a promoted live claim", async () => {
    const fixture = validatePhase07ReferenceSet(JSON.parse(await readFile(fixturePath, "utf8")));
    const comparisons = await Promise.all(fixture.cases.map(executePhase07ReferenceCase));
    const first = await buildPhase07DesignEvidence({ fixture, comparisons, sourceRevision: fixture.sourceRevision });
    const second = await buildPhase07DesignEvidence({ fixture, comparisons, sourceRevision: fixture.sourceRevision });
    expect(first.evidenceSha256).toBe(second.evidenceSha256);
    expect(first.offlineVerdict).toBe("passed");
    expect(first.promotionVerdict).toBe("blocked");
    expect((await validatePhase07DesignEvidence(first)).contentAddressedPath).toBe(`evidence/design/${first.evidenceSha256}.json`);
    const forged = structuredClone(first);
    forged.liveObservations[0].status = "passed";
    await expect(validatePhase07DesignEvidence(forged)).rejects.toThrow();
  });
});
