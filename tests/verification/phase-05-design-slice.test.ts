import { describe, expect, test } from "bun:test";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { evaluatePhase05Design, validatePhase05DesignEvidence, writePhase05DesignEvidence } from "../../src/verification/phase-05-design-evidence";
import { executePhase05ReferenceGate } from "../evals/phase-05-reference-set.test";

const fixturePath = "tests/fixtures/phase-05-reference-set.json";

describe("Phase 05 immutable design evidence", () => {
  test("re-derives every comparison and keeps all live providers unselected", async () => {
    const fixture = JSON.parse(await readFile(fixturePath, "utf8"));
    const gate = await executePhase05ReferenceGate(fixture);
    const decision = await evaluatePhase05Design({ fixture, comparisons: gate.comparisons });
    expect(decision.evidence.verdict).toBe("design-ready");
    expect(decision.evidence.providers.every((provider) => provider.selection === "unselected")).toBe(true);
  });

  test("fails closed for observation tampering, protected data, readiness claims, and immutable collisions", async () => {
    const fixture = JSON.parse(await readFile(fixturePath, "utf8"));
    const gate = await executePhase05ReferenceGate(fixture);
    const bad = structuredClone(gate.comparisons);
    bad[0].observed.status = "wrong";
    await expect(evaluatePhase05Design({ fixture, comparisons: bad })).resolves.toMatchObject({ evidence: { verdict: "blocked" } });
    await expect(evaluatePhase05Design({ fixture, comparisons: gate.comparisons, prompt: "forbidden" } as never)).resolves.toMatchObject({ evidence: { verdict: "blocked" } });
    const directory = await mkdtemp(join(process.env.TMPDIR ?? "/tmp", "napplet-phase-05-evidence-"));
    try {
      const written = await writePhase05DesignEvidence(directory, { fixture, comparisons: gate.comparisons });
      await validatePhase05DesignEvidence(written);
      await expect(validatePhase05DesignEvidence({ ...written, aggregate: { ...(written as any).aggregate, passed: 0 } } as never)).rejects.toThrow();
      await writeFile(join(directory, `${written.evidenceSha256}.json`), "different", "utf8");
      await expect(writePhase05DesignEvidence(directory, { fixture, comparisons: gate.comparisons })).rejects.toThrow("collision");
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  }, 60_000);
});
