import { describe, expect, test } from "bun:test";
import { evaluateArtifactContract, type ArtifactContractInput } from "../../src/policy/artifact-contract";

const cleanUpstream = { scanner: { verdict: "pass" as const }, conformance: { verdict: "pass" as const } };

const focused: ArtifactContractInput = {
  purpose: { kind: "focused", statements: ["Persist one user-controlled value."] },
  surface: { hasBackend: false, hasSecondPurpose: false, serviceWorker: false, dynamicAuthority: false },
  dependencies: { appOwnedSignerOrRelay: false, privateNappletImport: false },
  capabilities: { declaredHard: [], observedDomains: [], optionalIntentPresenceRead: false, intentUsedThroughSdk: false },
  upstream: cleanUpstream,
};

describe("artifact contract policy", () => {
  test("passes a focused minimal artifact and the sanctioned SDK-mediated optional intent path", async () => {
    expect(await evaluateArtifactContract(focused)).toMatchObject({ verdict: "pass", findings: [] });

    const capability = await evaluateArtifactContract({
      ...focused,
      purpose: { kind: "focused", statements: ["Persist one user-controlled value through storage."] },
      capabilities: { declaredHard: ["storage"], observedDomains: ["storage", "intent"], optionalIntentPresenceRead: true, intentUsedThroughSdk: true },
    });
    expect(capability.verdict).toBe("pass");
  });

  test.each([
    ["full-stack backend", { ...focused, purpose: { kind: "full-stack", statements: ["Build a dashboard and API."] }, surface: { ...focused.surface, hasBackend: true } }, "cvm:scope:focused-only"],
    ["upstream direct authority", { ...focused, upstream: { ...cleanUpstream, scanner: { verdict: "block", checkId: "upstream:scan:window-napplet-invocation" } } }, "upstream:scan:window-napplet-invocation"],
    ["upstream external asset", { ...focused, upstream: { ...cleanUpstream, scanner: { verdict: "block", checkId: "upstream:scan:external-asset" } } }, "upstream:scan:external-asset"],
    ["service worker", { ...focused, surface: { ...focused.surface, serviceWorker: true } }, "cvm:gap:service-worker"],
    ["app-owned signer", { ...focused, dependencies: { ...focused.dependencies, appOwnedSignerOrRelay: true } }, "cvm:gap:signer-relay"],
    ["unused hard capability", { ...focused, capabilities: { declaredHard: ["storage"], observedDomains: [], optionalIntentPresenceRead: false, intentUsedThroughSdk: false } }, "cvm:capability:necessary-hard"],
  ])("blocks representative %s evidence with exactly one primary owner", async (_name, input, checkId) => {
    const decision = await evaluateArtifactContract(input);
    expect(decision.verdict).toBe("block");
    expect(decision.findings).toHaveLength(1);
    expect(decision.findings[0]?.checkId).toBe(checkId);
    expect(decision.evidenceSha256).toMatch(/^[a-f0-9]{64}$/);
  });

  test("fails closed on malformed upstream evidence, unknown domains, global intent invocation, and manual review", async () => {
    for (const input of [
      { ...focused, upstream: { scanner: { verdict: "unknown" }, conformance: { verdict: "pass" } } },
      { ...focused, capabilities: { declaredHard: [], observedDomains: ["unknown"], optionalIntentPresenceRead: false, intentUsedThroughSdk: false } },
      { ...focused, capabilities: { declaredHard: ["storage"], observedDomains: ["storage", "intent"], optionalIntentPresenceRead: true, intentUsedThroughSdk: false } },
      { ...focused, upstream: { scanner: { verdict: "manual_review" }, conformance: { verdict: "pass" } } },
    ]) {
      expect((await evaluateArtifactContract(input)).verdict).toBe("block");
    }
  });

  test("produces the same immutable evidence serially and in parallel", async () => {
    const inputs = [focused, { ...focused, surface: { ...focused.surface, serviceWorker: true } }];
    const serial = [];
    for (const input of inputs) serial.push(await evaluateArtifactContract(input));
    const parallel = await Promise.all(inputs.map((input) => evaluateArtifactContract(input)));
    expect(parallel).toEqual(serial);
  });
});


describe("GAMEPAD generation policy", () => {
  test("accepts declared optional controllers and observed controller requirements", async () => {
    const capabilities = { ...focused.capabilities, observedDomains: ["gamepad"], declaredOptional: ["gamepad"] };
    expect((await evaluateArtifactContract({ ...focused, capabilities })).verdict).toBe("pass");
    expect((await evaluateArtifactContract({ ...focused, capabilities: { ...capabilities, declaredOptional: [], declaredHard: ["gamepad"] } })).verdict).toBe("pass");
  });
  test("rejects undeclared, duplicate, contradictory, and unused controller requirements", async () => {
    for (const capabilities of [
      { ...focused.capabilities, observedDomains: ["gamepad"] },
      { ...focused.capabilities, declaredOptional: ["gamepad", "gamepad"], observedDomains: ["gamepad"] },
      { ...focused.capabilities, declaredOptional: ["gamepad"], declaredHard: ["gamepad"], observedDomains: ["gamepad"] },
      { ...focused.capabilities, declaredHard: ["gamepad"] },
    ]) expect((await evaluateArtifactContract({ ...focused, capabilities })).verdict).toBe("block");
  });
});
