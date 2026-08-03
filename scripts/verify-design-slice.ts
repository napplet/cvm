import { writeFile } from "node:fs/promises";
import { canonicalJson } from "../src/promotion/schema";
import { runFixture, type FixtureMode, type FixtureName } from "../src/fixtures/registry";
import { evaluateArtifactContract, type ArtifactContractInput } from "../src/policy/artifact-contract";
import { writeDesignVerificationEvidence } from "../src/verification/design-evidence";

const candidateId = "a19fc7d283a4482c53728f4a931743576564fb3826d7f8fa1383d02578b69024";

async function sha256(value: string): Promise<string> {
  const output = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(value));
  return Array.from(new Uint8Array(output), (byte) => byte.toString(16).padStart(2, "0")).join("");
}

async function sourceDigest(paths: readonly string[]): Promise<string> {
  return sha256((await Promise.all(paths.map(async (path) => `${path}\n${await Bun.file(path).text()}`))).join("\n"));
}

/**
 * Phase 1 cannot run the generator natively with --network=none: upstream
 * boilerplate clones its template from GitHub. Model that known state through the
 * real registry/parser boundary without manufacturing Chromium success.
 */
async function blockedFixture(name: FixtureName, mode: FixtureMode, imageDigest: string) {
  return runFixture(name, {
    imageDigest,
    mode,
    runSealed: async (request) => {
      const capability = name === "capability-harness";
      const reason = "native scaffold is not self-contained: @napplet/boilerplate clones GitHub while sealed execution uses --network=none; Phase 7 owns compatible sealed-scaffold closure";
      const output = {
        fixture: name, mode, status: "blocked", candidateId, imageDigest, stages: [],
        installedSkillsSha256: "0".repeat(64), distSha256: "0".repeat(64), aggregateHash: "0".repeat(64),
        observedDomains: capability ? ["storage"] : [], optionalIntentPresenceRead: capability,
        intentUsedThroughSdk: false, gracefulDegradation: capability && mode === "degraded-no-intent", reason,
      };
      return {
        id: request.id, argv: ["design-blocker", ...request.args], cwd: request.inputDirectory,
        cwdSha256: await sha256(request.inputDirectory), toolchainId: request.toolchainId, imageDigest,
        startedAtMs: 0, finishedAtMs: 0, exitCode: 0, stdout: JSON.stringify(output), stderr: "",
        stdoutSha256: await sha256(JSON.stringify(output)), stderrSha256: await sha256(""), disposition: "passed" as const,
        evidenceSha256: await sha256(canonicalJson({ fixture: name, mode, candidateId, imageDigest, reason })),
      };
    },
  });
}

const cleanUpstream = { scanner: { verdict: "pass" as const }, conformance: { verdict: "pass" as const } };
const focused: ArtifactContractInput = {
  purpose: { kind: "focused", statements: ["Persist one user-controlled value."] },
  surface: { hasBackend: false, hasSecondPurpose: false, serviceWorker: false, dynamicAuthority: false },
  dependencies: { appOwnedSignerOrRelay: false, privateNappletImport: false },
  capabilities: { declaredHard: [], observedDomains: [], optionalIntentPresenceRead: false, intentUsedThroughSdk: false },
  upstream: cleanUpstream,
};

async function policyResults() {
  const cases: readonly [string, ArtifactContractInput, "pass" | "block"][] = [
    ["focused-minimal", focused, "pass"],
    ["capability-harness", { ...focused, capabilities: { declaredHard: ["storage"], observedDomains: ["storage", "intent"], optionalIntentPresenceRead: true, intentUsedThroughSdk: true } }, "pass"],
    ["full-stack-backend", { ...focused, purpose: { kind: "full-stack", statements: ["Build a dashboard and API."] }, surface: { ...focused.surface, hasBackend: true } }, "block"],
    ["direct-window-napplet-invocation", { ...focused, upstream: { ...cleanUpstream, scanner: { verdict: "block", checkId: "upstream:scan:window-napplet-invocation" } } }, "block"],
    ["external-asset", { ...focused, upstream: { ...cleanUpstream, scanner: { verdict: "block", checkId: "upstream:scan:external-asset" } } }, "block"],
    ["service-worker", { ...focused, surface: { ...focused.surface, serviceWorker: true } }, "block"],
    ["app-owned-signer-relay", { ...focused, dependencies: { ...focused.dependencies, appOwnedSignerOrRelay: true } }, "block"],
    ["unused-hard-capability", { ...focused, capabilities: { declaredHard: ["storage"], observedDomains: [], optionalIntentPresenceRead: false, intentUsedThroughSdk: false } }, "block"],
  ];
  return Promise.all(cases.map(async ([name, input, expectedVerdict]) => {
    const decision = await evaluateArtifactContract(input);
    return { name, verdict: decision.verdict, expectedVerdict, evidenceSha256: decision.evidenceSha256 };
  }));
}

const imageDigest = await sourceDigest(["infra/toolchain/Dockerfile", "toolchains/locks/initial/pnpm-lock.yaml"]);
const policySha256 = await sourceDigest(["policy/upstream-coverage.json", "src/policy/artifact-contract.ts"]);
const fixtures = await Promise.all([
  blockedFixture("minimal", "primary", imageDigest),
  blockedFixture("capability-harness", "primary", imageDigest),
  blockedFixture("capability-harness", "degraded-no-intent", imageDigest),
]);
const evidence = await writeDesignVerificationEvidence("evidence/design", {
  candidateId, imageDigest, policySha256, fixtures, policyResults: await policyResults(), waiver: null,
  provenanceLinks: [
    "toolchains/candidates/cli-0.5.2-release-set.json",
    "infra/toolchain/Dockerfile",
    "policy/upstream-coverage.json",
    "Phase 1 image identity is a sealed-image-input digest, not an OCI image claim; native runtime remains blocked.",
  ],
});
await writeFile("evidence/design/phase-01.json", `${canonicalJson({ certificationProfile: "design", verdict: evidence.verdict, evidenceSha256: evidence.evidenceSha256, contentAddressedPath: `evidence/design/${evidence.evidenceSha256}.json`, nativeRuntime: "blocked; compatible sealed scaffold closure deferred to Phase 7" })}\n`);
console.log(JSON.stringify({ verdict: evidence.verdict, evidenceSha256: evidence.evidenceSha256, nativeRuntime: "blocked" }));
