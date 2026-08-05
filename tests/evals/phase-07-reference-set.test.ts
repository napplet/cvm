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
    const results = await Promise.all(fixture.cases.map((caseValue) => executePhase07ReferenceCase(caseValue)));
    expect(results.filter((item) => item.status !== "passed")).toEqual([]);
    const altered = structuredClone(fixture.cases[0]);
    altered.expected.value = "wrong";
    expect((await executePhase07ReferenceCase(altered)).status).toBe("failed");
  }, 60_000);

  test("binds each named authority observation to its typed scenario, never its coverage ID", async () => {
    const fixture = validatePhase07ReferenceSet(JSON.parse(await readFile(fixturePath, "utf8")));
    const results = await Promise.all(fixture.cases.map((caseValue) => executePhase07ReferenceCase(caseValue)));
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

  test("rejects every valid cross-case scenario substitution within its category", async () => {
    const fixture = validatePhase07ReferenceSet(JSON.parse(await readFile(fixturePath, "utf8")));
    for (const category of ["admission", "resilience", "security", "publication", "launch"] as const) {
      const cases = fixture.cases.filter((caseValue) => caseValue.category === category);
      for (const original of cases) {
        for (const replacement of cases) {
          if (replacement.id === original.id) continue;
          const substituted = structuredClone(original);
          substituted.scenario = structuredClone(replacement.scenario);
          const result = await executePhase07ReferenceCase(substituted);
          expect(result.status, `${category}: ${original.id} <- ${replacement.id}`).toBe("failed");
          expect(result.observed.value, `${category}: ${original.id} <- ${replacement.id}`).not.toBe(original.expected.value);
        }
      }
    }
  }, 60_000);

  test("translates each category's mode, state, and ordered events or fails before comparison", async () => {
    const fixture = validatePhase07ReferenceSet(JSON.parse(await readFile(fixturePath, "utf8")));
    const changedModes = new Map([["admission", "contention"], ["resilience", "out_of_order"], ["security", "tool_injection"], ["publication", "scope_denial"], ["launch", "missing_credential"]]);
    for (const category of ["admission", "resilience", "security", "publication", "launch"] as const) {
      const original = fixture.cases.find((item) => item.category === category)!;
      const baseline = await executePhase07ReferenceCase(original);
      const modeMutation = structuredClone(original);
      modeMutation.scenario.input.mode = changedModes.get(category)!;
      const modeResult = await executePhase07ReferenceCase(modeMutation);
      expect(modeResult.status).toBe("failed");
      expect(modeResult.observed.value !== baseline.observed.value || modeResult.observed.value.startsWith("authority:failed")).toBe(true);
      const stateMutation = structuredClone(original);
      stateMutation.scenario.initialState = original.scenario.initialState === "empty" ? "verified" : "empty";
      const stateResult = await executePhase07ReferenceCase(stateMutation);
      expect(stateResult.status).toBe("failed");
      expect(stateResult.observed.value).toContain("authority:failed");
      const scheduleMutation = structuredClone(original);
      scheduleMutation.scenario.schedule = [...scheduleMutation.scenario.schedule, "semantic_canary"];
      const scheduleResult = await executePhase07ReferenceCase(scheduleMutation);
      expect(scheduleResult.status).toBe("failed");
      expect(scheduleResult.observed.value).toContain("authority:failed");
    }
  }, 60_000);

  test("fails a comparator when an injected category port changes a real effect projection", async () => {
    const fixture = validatePhase07ReferenceSet(JSON.parse(await readFile(fixturePath, "utf8")));
    const admission = fixture.cases.find((item) => item.category === "admission")!;
    const injected = await executePhase07ReferenceCase(admission, {
      admission: async () => ({ status: "passed", value: "admission:mutated-port", effects: { credit: 0, debit: 0, worker: 1, publication: 0 } }),
    });
    expect(injected.status).toBe("failed");
    expect(injected.observed.effects.worker).toBe(1);
  });

  test("executes restoration fences and protected launch evidence without a live pass", async () => {
    const fixture = validatePhase07ReferenceSet(JSON.parse(await readFile(fixturePath, "utf8")));
    const expiry = await executePhase07ReferenceCase(fixture.cases.find((item) => item.id === "R11")!);
    const fence = await executePhase07ReferenceCase(fixture.cases.find((item) => item.id === "R14")!);
    const launch = await executePhase07ReferenceCase(fixture.cases.find((item) => item.id === "L10")!);
    expect(expiry.observed.value).toContain("RESTORE_REATTACHED");
    expect(fence.observed.value).toContain("RESTORE_REPLAYED");
    expect(launch.observed.value).toMatch(/claim=required_claim_checked:rejected=\d+:promotion=blocked/u);
    expect(launch.observed.value).toContain("PROTECTED_INFRASTRUCTURE_UNAVAILABLE");
  });

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
    (contaminated.liveObservations as unknown as Array<{ limitation: string }>)[0]!.limitation = "Bearer secret-canary";
    expect(() => validatePhase07ReferenceSet(contaminated)).toThrow();
  });

  test("builds canonical deterministic evidence and rejects a promoted live claim", async () => {
    const fixture = validatePhase07ReferenceSet(JSON.parse(await readFile(fixturePath, "utf8")));
    const comparisons = await Promise.all(fixture.cases.map((caseValue) => executePhase07ReferenceCase(caseValue)));
    const first = await buildPhase07DesignEvidence({ fixture, comparisons, sourceRevision: fixture.sourceRevision });
    const second = await buildPhase07DesignEvidence({ fixture, comparisons, sourceRevision: fixture.sourceRevision });
    expect(first.evidenceSha256).toBe(second.evidenceSha256);
    expect(first.offlineVerdict).toBe("passed");
    expect(first.promotionVerdict).toBe("blocked");
    expect((await validatePhase07DesignEvidence(first)).contentAddressedPath).toBe(`evidence/design/${first.evidenceSha256}.json`);
    const forged = structuredClone(first);
    (forged.liveObservations as unknown as Array<{ status: string }>)[0]!.status = "passed";
    await expect(validatePhase07DesignEvidence(forged)).rejects.toThrow();
  });
});
