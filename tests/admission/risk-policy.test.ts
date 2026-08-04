import { describe, expect, test } from "bun:test";
import {
  RISK_POLICY_INITIAL,
  evaluateRisk,
  type RiskSignalDetector,
} from "../../src/admission/risk-policy";
import type { TokenCounter } from "../../src/admission/admission-policy";

const tokenCounter: TokenCounter = { version: "test-tokenizer-v1", count(idea) { return idea.trim().split(/\s+/u).filter(Boolean).length; } };
const baseGrant = ["workspace:write", "workspace:read"] as const;

function detector(result: unknown, calls = { count: 0 }): RiskSignalDetector {
  return {
    version: "test-detector-v1",
    async detect() {
      calls.count += 1;
      return result;
    },
  };
}

describe("SAFE-02 restrictive-only risk policy", () => {
  test("does not invoke the detector when hard text admission has denied input", async () => {
    const calls = { count: 0 };
    const decision = await evaluateRisk({ idea: "data:text/plain;base64,SGVsbG8=" }, tokenCounter, detector([], calls), baseGrant);
    expect(decision).toMatchObject({ status: "denied", code: "INPUT_EMBEDDED_DATA" });
    expect(calls.count).toBe(0);
  });

  test("preserves exactly the frozen base grant after a clean result", async () => {
    const decision = await evaluateRisk({ idea: "Build a focused counter." }, tokenCounter, detector([]), baseGrant);
    expect(decision).toMatchObject({ status: "accepted", code: "RISK_ACCEPTED", grants: baseGrant });
    expect(decision.policy).toEqual(RISK_POLICY_INITIAL);
    expect(Object.isFrozen(decision.grants)).toBeTrue();
  });

  test.each([
    [{ id: "PROMPT_INJECTION", severity: "high" }],
    [{ id: "JAILBREAK", severity: "high" }],
  ])("rejects configured signals without adding a grant", async (signals) => {
    const decision = await evaluateRisk({ idea: "Build a focused counter." }, tokenCounter, detector(signals), baseGrant);
    expect(decision).toMatchObject({ status: "denied", code: "RISK_POLICY_REJECTED", grants: [] });
    expect(decision.grants.every((grant) => baseGrant.includes(grant as typeof baseGrant[number]))).toBeTrue();
  });

  test.each([
    ["throw", detector({})],
    ["unavailable", detector({ status: "unavailable" })],
    ["malformed", detector([{ id: "PROMPT_INJECTION", severity: "critical", extra: true }])],
  ])("fails closed when the detector is %s", async (_name, subject) => {
    if (_name === "throw") subject = { version: "throwing-v1", detect() { throw new Error("offline"); } };
    const decision = await evaluateRisk({ idea: "Build a focused counter." }, tokenCounter, subject, baseGrant);
    expect(decision).toMatchObject({ status: "denied", code: "RISK_CLASSIFIER_UNAVAILABLE", grants: [] });
  });

  test("times out a slow detector before any execution hook", async () => {
    const slow: RiskSignalDetector = { version: "slow-v1", detect() { return new Promise(() => undefined); } };
    const hooks = { allocations: 0, models: 0, billable: 0, workers: 0 };
    const decision = await evaluateRisk({ idea: "Build a focused counter." }, tokenCounter, slow, baseGrant, hooks);
    expect(decision).toMatchObject({ status: "denied", code: "RISK_CLASSIFIER_UNAVAILABLE", grants: [] });
    expect(hooks).toEqual({ allocations: 0, models: 0, billable: 0, workers: 0 });
  });

  test("canonicalizes reordered and duplicated detector signals into one stable evidence identity", async () => {
    const first = await evaluateRisk({ idea: "Build a focused counter." }, tokenCounter, detector([
      { id: "JAILBREAK", severity: "high" }, { id: "PROMPT_INJECTION", severity: "high" }, { id: "JAILBREAK", severity: "high" },
    ]), baseGrant);
    const second = await evaluateRisk({ idea: "Build a focused counter." }, tokenCounter, detector([
      { id: "PROMPT_INJECTION", severity: "high" }, { id: "JAILBREAK", severity: "high" },
    ]), baseGrant);
    expect(first.signals).toEqual([{ id: "JAILBREAK", severity: "high" }, { id: "PROMPT_INJECTION", severity: "high" }]);
    expect(first.evidence.identity).toBe(second.evidence.identity);
  });

  test("records only correlation, policy, detector, latency, signal, hash, and length evidence", async () => {
    const secret = "unique secret idea that must not leak";
    const decision = await evaluateRisk({ idea: secret }, tokenCounter, detector([]), baseGrant);
    expect(decision.evidence).toMatchObject({
      inputSha256: expect.stringMatching(/^[a-f0-9]{64}$/),
      detectorVersion: "test-detector-v1",
      latencyClass: expect.any(String),
      identity: expect.stringMatching(/^[a-f0-9]{64}$/),
    });
    expect(JSON.stringify(decision.evidence)).not.toContain(secret);
  });
});
