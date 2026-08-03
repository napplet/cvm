import { describe, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { join } from "node:path";
import { evaluateDesignVerification, validateDesignVerificationEvidence, writeDesignVerificationEvidence, type DesignVerificationInput } from "../../src/verification/design-evidence";

const digest = (value: string) => value.repeat(64).slice(0, 64);
const candidateId = "a19fc7d283a4482c53728f4a931743576564fb3826d7f8fa1383d02578b69024";

function fixture(fixture: "minimal" | "capability-harness", mode: "primary" | "degraded-no-intent", status: "passed" | "blocked" = "passed") {
  return {
    fixture, mode, status, candidateId, imageDigest: digest("a"), stages: status === "passed" ? [{ id: "conformance", argv: ["pnpm", "test:conformance"], exitCode: 0, stdoutSha256: digest("b"), stderrSha256: digest("c"), nativeOutputSha256: digest(fixture === "minimal" ? "d" : mode === "primary" ? "e" : "f") }] : [],
    installedSkillsSha256: digest("g"), distSha256: digest(fixture === "minimal" ? "h" : mode === "primary" ? "i" : "j"), aggregateHash: digest(fixture === "minimal" ? "k" : mode === "primary" ? "l" : "m"), sealedEvidenceSha256: digest(fixture === "minimal" ? "n" : mode === "primary" ? "o" : "p"),
    observedDomains: fixture === "minimal" ? [] : mode === "primary" ? ["storage", "intent"] : ["storage"], optionalIntentPresenceRead: fixture === "capability-harness", intentUsedThroughSdk: fixture === "capability-harness" && mode === "primary", gracefulDegradation: fixture === "capability-harness" && mode === "degraded-no-intent",
    ...(status === "blocked" ? { reason: "offline template unavailable" } : {}),
  } as const;
}

const input: DesignVerificationInput = {
  candidateId, imageDigest: digest("a"), policySha256: digest("q"), fixtures: [fixture("minimal", "primary"), fixture("capability-harness", "primary"), fixture("capability-harness", "degraded-no-intent")],
  policyResults: [{ name: "focused-minimal", verdict: "pass", evidenceSha256: digest("r") }, { name: "capability-harness", verdict: "pass", evidenceSha256: digest("s") }, { name: "service-worker", verdict: "block", evidenceSha256: digest("t") }],
  provenanceLinks: ["toolchains/candidates/cli-0.5.2-release-set.json"], waiver: null,
};

describe("design verification evidence", () => {
  test("binds complete representative evidence without production authority", async () => {
    const decision = await evaluateDesignVerification(input);
    expect(decision.verdict).toBe("design-ready");
    expect(decision.evidence?.certificationProfile).toBe("design");
    expect(decision.evidence?.deferredLaunchGates).toContain("production-promotion");
    expect(decision.evidence?.fixtures).toHaveLength(3);
    await expect(validateDesignVerificationEvidence(decision.evidence!)).resolves.toBeUndefined();
  });

  test("retains an actual blocked native fixture as blocking design evidence", async () => {
    const decision = await evaluateDesignVerification({ ...input, fixtures: [fixture("minimal", "primary", "blocked"), fixture("capability-harness", "primary", "blocked"), fixture("capability-harness", "degraded-no-intent", "blocked")] });
    expect(decision.verdict).toBe("blocked");
    expect(decision.evidence?.fixtures.every((entry) => entry.status === "blocked")).toBe(true);
  });

  test.each([
    ["missing positive", { ...input, fixtures: input.fixtures.slice(1) }],
    ["unknown policy", { ...input, policyResults: [{ name: "unknown", verdict: "manual_review", evidenceSha256: digest("r") }] }],
    ["waiver", { ...input, waiver: { candidateId, checkId: "cvm:gap:service-worker", reportSha256: digest("u"), owner: "operator", rationale: "no", compensatingEvidenceSha256: digest("v"), expiresAt: "2026-08-04T00:00:00Z", rollbackTrigger: "any regression" } }],
    ["tampered identity", { ...input, candidateId: digest("z") }],
  ])("blocks %s inputs", async (_name, value) => {
    expect((await evaluateDesignVerification(value)).verdict).toBe("blocked");
  });

  test("writes content-addressed immutable evidence", async () => {
    const directory = await mkdtemp(join(process.env.TMPDIR ?? "/tmp", "napplet-design-evidence-"));
    try {
      const evidence = await writeDesignVerificationEvidence(directory, input);
      expect(await Bun.file(join(directory, `${evidence.evidenceSha256}.json`)).exists()).toBe(true);
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });
});
