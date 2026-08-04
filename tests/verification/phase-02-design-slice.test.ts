import { describe, expect, test } from "bun:test";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { join } from "node:path";
import {
  evaluatePhase02Design,
  validatePhase02DesignEvidence,
  writePhase02DesignEvidence,
  type Phase02DesignInput,
} from "../../src/verification/phase-02-design-evidence";

const digest = (value: string) => value.repeat(64).slice(0, 64);
const deterministicChecks = [
  "tracer", "admission", "risk", "session", "gateway", "fake-worker", "artifact-contract", "reference-set",
] as const;
const provider = { version: 1, provider: "modal", status: "blocked" as const, selection: "unselected" as const, reasonCode: "PROVIDER_UNSELECTED", policyVersion: "phase-02-policy-2026-08-04", failedChecks: [], limitations: ["NOT_PRODUCTION_CERTIFIED", "SLO_NOT_MEASURED"] as const, evidenceSha256: digest("a") };
const input: Phase02DesignInput = {
  policy: { identity: "phase-02-policy-2026-08-04", sha256: digest("b") },
  sqlite: { identity: "phase-02-sqlite-session-store-v1", schemaSha256: digest("c") },
  identities: { trustedCore: "src/phase-02/trusted-core.ts", workerContracts: "src/phase-02/contracts.ts", artifactGate: "src/policy/artifact-contract.ts" },
  checks: deterministicChecks.map((id, index) => ({ id, severity: id === "reference-set" ? "critical" as const : "high" as const, status: "passed" as const, evidenceSha256: digest(String(index + 1)) })),
  providerObservation: provider,
};

describe("Phase 02 design evidence", () => {
  test("keeps a complete offline proof design-ready when the provider is blocked and unselected", async () => {
    const decision = await evaluatePhase02Design(input);
    expect(decision.evidence.offlineVerdict).toBe("passed");
    expect(decision.evidence.verdict).toBe("design-ready");
    expect(decision.evidence.providerObservation.status).toBe("blocked");
    expect(decision.evidence.providerObservation.selection).toBe("unselected");
    await expect(validatePhase02DesignEvidence(decision.evidence)).resolves.toBeUndefined();
  });

  test("separates a provider failure and an eligible-but-unselected provider pass from offline readiness", async () => {
    const failed = await evaluatePhase02Design({ ...input, providerObservation: { ...provider, status: "failed", reasonCode: "PROBE_EXECUTION_FAILED" } });
    const eligible = await evaluatePhase02Design({ ...input, providerObservation: { ...provider, status: "passed", selection: "eligible-not-selected", reasonCode: "PROBE_COMPLETE" } });
    expect(failed.evidence).toMatchObject({ verdict: "design-ready", providerObservation: { selection: "unselected" } });
    expect(eligible.evidence).toMatchObject({ verdict: "design-ready", providerObservation: { selection: "eligible-not-selected" } });
  });

  test.each([
    ["missing check", { ...input, checks: input.checks.slice(1) }],
    ["duplicate check", { ...input, checks: [...input.checks, input.checks[0]!] }],
    ["failed deterministic check", { ...input, checks: input.checks.map((item) => item.id === "gateway" ? { ...item, status: "failed" as const } : item) }],
    ["policy mismatch", { ...input, providerObservation: { ...provider, policyVersion: "other-policy" } }],
  ])("blocks %s", async (_name, value) => {
    expect((await evaluatePhase02Design(value)).evidence.verdict).toBe("blocked");
  });

  test("rejects tampering, raw prompt/secret/grant fields, unknown deferrals, and immutable collisions", async () => {
    const decision = await evaluatePhase02Design(input);
    await expect(validatePhase02DesignEvidence({ ...decision.evidence, offlineVerdict: "blocked" })).rejects.toThrow();
    await expect(validatePhase02DesignEvidence({ ...decision.evidence, rawPrompt: "synthetic" } as unknown as typeof decision.evidence)).rejects.toThrow();
    await expect(validatePhase02DesignEvidence({ ...decision.evidence, deferrals: ["launch-certification", "unknown"] })).rejects.toThrow();
    const directory = await mkdtemp(join(process.env.TMPDIR ?? "/tmp", "napplet-phase-02-design-"));
    try {
      const evidence = await writePhase02DesignEvidence(directory, input);
      expect(await Bun.file(join(directory, `${evidence.evidenceSha256}.json`)).exists()).toBeTrue();
      await Bun.write(join(directory, `${evidence.evidenceSha256}.json`), "{\"tampered\":true}\n");
      await expect(writePhase02DesignEvidence(directory, input)).rejects.toThrow("collision");
    } finally { await rm(directory, { recursive: true, force: true }); }
  });
});
