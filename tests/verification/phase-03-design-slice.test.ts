import { describe, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { join } from "node:path";
import { evaluatePhase03Design, validatePhase03DesignEvidence, writePhase03DesignEvidence } from "../../src/verification/phase-03-design-evidence";

const digest = (character: string) => character.repeat(64);
const checks = ["contextvm", "ledger", "lightning", "cashu", "funded-admission", "reference-set", "package-intake", "api-coverage"] as const;
const requirements = ["CTX-01", "CTX-02", "CTX-03", "CTX-04", "PAY-01", "PAY-02", "PAY-03", "PAY-04", "PAY-05", "PAY-06", "PAY-07", "BILL-01", "BILL-02", "BILL-06"] as const;
const input = () => ({
  identities: { packageIntake: "evidence/phase-03/package-intake.json", postgres: "src/persistence/postgres-funding-store.ts", contextvm: "src/contextvm/adapter.ts", lightning: "src/funding/lightning-top-up.ts", cashu: "src/funding/cashu-top-up.ts", fundedCore: "src/phase-03/funded-core.ts", referenceSet: "tests/fixtures/phase-03-reference-set.json" },
  checks: checks.map((id, index) => ({ id, severity: index === 5 ? "critical" as const : "high" as const, status: "passed" as const, evidenceSha256: digest(String(index + 1)) })),
  requirementMappings: Object.fromEntries(requirements.map((id) => [id, ["reference-set"]])),
  decisionMappings: Array.from({ length: 19 }, (_, index) => `D-${index + 40}`),
  observations: ["contextvm", "lightning", "cashu", "postgres", "capacity", "modal"].map((provider, index) => ({ version: 1 as const, provider, status: "blocked" as const, selection: "unselected" as const, certificationProfile: "design" as const, reasonCode: "PROVIDER_UNCONFIGURED", evidenceSha256: digest(String(index + 3)), limitations: ["live observation deferred to Phase 7"] })),
});

describe("Phase 03 immutable design evidence", () => {
  test("accepts complete deterministic proof while all live surfaces remain blocked and unselected", async () => {
    const decision = await evaluatePhase03Design(input());
    expect(decision.reasons).toEqual([]);
    expect(decision.evidence).toMatchObject({ verdict: "design-ready", offlineVerdict: "passed" });
    expect(decision.evidence.observations.every((item) => item.status === "blocked" && item.selection === "unselected")).toBeTrue();
  });

  test("rejects missing or unknown checks, mappings, raw bearer material, selection overclaims, and tamper", async () => {
    await expect(evaluatePhase03Design({ ...input(), checks: input().checks.slice(1) })).resolves.toMatchObject({ evidence: { verdict: "blocked" } });
    await expect(evaluatePhase03Design({ ...input(), observations: [{ ...input().observations[0]!, status: "blocked", selection: "eligible-not-selected" }] })).resolves.toMatchObject({ evidence: { verdict: "blocked" } });
    await expect(evaluatePhase03Design({ ...input(), rawInvoice: "forbidden" } as never)).resolves.toMatchObject({ evidence: { verdict: "blocked" } });
    const valid = (await evaluatePhase03Design(input())).evidence;
    await expect(validatePhase03DesignEvidence({ ...valid, evidenceSha256: digest("f") })).rejects.toThrow();
  });

  test("writes content-addressed immutable bytes and detects collisions", async () => {
    const directory = await mkdtemp(join(process.env.TMPDIR ?? "/tmp", "napplet-phase-03-evidence-"));
    try {
      const first = await writePhase03DesignEvidence(directory, input());
      const second = await writePhase03DesignEvidence(directory, input());
      expect(second).toEqual(first);
      await validatePhase03DesignEvidence(first);
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });
});
