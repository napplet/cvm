import { mkdir, readFile, writeFile } from "node:fs/promises";
import { canonicalJson } from "../promotion/schema";
import type { FixtureRunResult } from "../fixtures/registry";

const SHA256 = /^[a-f0-9]{64}$/i;
const APPROVED_CANDIDATE_ID = "a19fc7d283a4482c53728f4a931743576564fb3826d7f8fa1383d02578b69024";
const EXPECTED_FIXTURES = ["minimal:primary", "capability-harness:primary", "capability-harness:degraded-no-intent"] as const;
export const DEFERRED_LAUNCH_GATES = ["exhaustive-provenance", "cross-environment-reproducibility", "full-hostile-mutation-matrix", "formal-golden-approval", "waiver-drills", "sbom-provenance-enforcement", "production-promotion"] as const;

export type OwnerWaiverContract = {
  readonly candidateId: string;
  readonly checkId: string;
  readonly reportSha256: string;
  readonly owner: string;
  readonly rationale: string;
  readonly compensatingEvidenceSha256: string;
  readonly expiresAt: string;
  readonly rollbackTrigger: string;
};

export type DesignPolicyResult = { readonly name: string; readonly verdict: "pass" | "block" | "manual_review"; readonly expectedVerdict: "pass" | "block"; readonly evidenceSha256: string };
export type DesignVerificationInput = {
  readonly candidateId: string;
  readonly imageDigest: string;
  readonly policySha256: string;
  readonly fixtures: readonly FixtureRunResult[];
  readonly policyResults: readonly DesignPolicyResult[];
  readonly provenanceLinks: readonly string[];
  readonly waiver: OwnerWaiverContract | null;
};
export type DesignFixtureEvidence = Pick<FixtureRunResult, "fixture" | "mode" | "status" | "candidateId" | "imageDigest" | "installedSkillsSha256" | "distSha256" | "aggregateHash" | "sealedEvidenceSha256" | "observedDomains" | "optionalIntentPresenceRead" | "intentUsedThroughSdk" | "gracefulDegradation" | "reason"> & { readonly nativeReportDigests: readonly string[] };
export type DesignVerificationEvidence = Omit<DesignVerificationInput, "fixtures"> & {
  readonly version: 1;
  readonly certificationProfile: "design";
  readonly verdict: "design-ready" | "blocked";
  readonly fixtures: readonly DesignFixtureEvidence[];
  readonly deferredLaunchGates: readonly string[];
  readonly evidenceSha256: string;
};
export type DesignVerificationDecision = { readonly verdict: "design-ready" | "blocked"; readonly evidence?: DesignVerificationEvidence; readonly reasons: readonly string[] };

function isDigest(value: unknown): value is string { return typeof value === "string" && SHA256.test(value); }
async function digest(value: unknown): Promise<string> {
  const bytes = new TextEncoder().encode(canonicalJson(value));
  const output = await crypto.subtle.digest("SHA-256", bytes);
  return Array.from(new Uint8Array(output), (byte) => byte.toString(16).padStart(2, "0")).join("");
}
function reason(reasons: string[], message: string): void { if (!reasons.includes(message)) reasons.push(message); }

function evidenceForFixture(result: FixtureRunResult): DesignFixtureEvidence {
  return Object.freeze({
    fixture: result.fixture, mode: result.mode, status: result.status, candidateId: result.candidateId, imageDigest: result.imageDigest,
    installedSkillsSha256: result.installedSkillsSha256, distSha256: result.distSha256, aggregateHash: result.aggregateHash, sealedEvidenceSha256: result.sealedEvidenceSha256,
    observedDomains: Object.freeze([...result.observedDomains]), optionalIntentPresenceRead: result.optionalIntentPresenceRead,
    intentUsedThroughSdk: result.intentUsedThroughSdk, gracefulDegradation: result.gracefulDegradation,
    nativeReportDigests: Object.freeze(result.stages.map((stage) => stage.nativeOutputSha256)), ...(result.reason ? { reason: result.reason } : {}),
  });
}

function checkFixture(result: FixtureRunResult, index: number, candidateId: string, imageDigest: string, reasons: string[]): void {
  if (`${result.fixture}:${result.mode}` !== EXPECTED_FIXTURES[index]) reason(reasons, "required positive fixture is missing, reordered, or duplicated");
  if (result.candidateId !== candidateId || result.imageDigest !== imageDigest) reason(reasons, "fixture identity does not bind the approved candidate and image");
  const digests = [result.installedSkillsSha256, result.distSha256, result.aggregateHash, result.sealedEvidenceSha256, ...result.stages.flatMap((stage) => [stage.stdoutSha256, stage.stderrSha256, stage.nativeOutputSha256])];
  if (digests.some((value) => !isDigest(value))) reason(reasons, "fixture evidence contains a malformed digest");
  if (result.status === "passed" && (result.stages.length === 0 || !result.stages.some((stage) => stage.id === "conformance"))) reason(reasons, "passing fixture lacks a native Chromium/conformance report");
  if (result.status === "blocked" && !result.reason) reason(reasons, "blocked fixture lacks a structured native reason");
  if (result.status === "passed" && result.fixture === "capability-harness" && result.mode === "primary" && (!result.observedDomains.includes("storage") || !result.observedDomains.includes("intent") || !result.optionalIntentPresenceRead || !result.intentUsedThroughSdk || result.gracefulDegradation)) reason(reasons, "primary capability evidence is incomplete");
  if (result.status === "passed" && result.fixture === "capability-harness" && result.mode === "degraded-no-intent" && (!result.observedDomains.includes("storage") || result.observedDomains.includes("intent") || !result.optionalIntentPresenceRead || result.intentUsedThroughSdk || !result.gracefulDegradation)) reason(reasons, "degraded capability evidence is incomplete");
}

/** Builds a bounded design-stage record; it deliberately has no production promotion authority. */
export async function evaluateDesignVerification(input: DesignVerificationInput): Promise<DesignVerificationDecision> {
  const reasons: string[] = [];
  if (input.candidateId !== APPROVED_CANDIDATE_ID) reason(reasons, "candidate is not the D-19 approved release set");
  if (!isDigest(input.imageDigest) || !isDigest(input.policySha256)) reason(reasons, "image or policy identity is malformed");
  if (input.waiver !== null) reason(reasons, "owner waivers are defined but forbidden in the design profile");
  if (!Array.isArray(input.fixtures) || input.fixtures.length !== EXPECTED_FIXTURES.length) reason(reasons, "all positive fixture modes are required");
  for (const [index, fixture] of input.fixtures.entries()) checkFixture(fixture, index, input.candidateId, input.imageDigest, reasons);
  if (!Array.isArray(input.policyResults) || input.policyResults.length === 0) reason(reasons, "policy evidence is required");
  for (const result of input.policyResults) {
    if (!result || typeof result.name !== "string" || !isDigest(result.evidenceSha256) || !["pass", "block", "manual_review"].includes(result.verdict) || !["pass", "block"].includes(result.expectedVerdict)) reason(reasons, "policy result is malformed or unknown");
    else if (result.verdict !== result.expectedVerdict) reason(reasons, "policy result did not match its expected verdict");
  }
  if (!Array.isArray(input.provenanceLinks) || input.provenanceLinks.length === 0 || input.provenanceLinks.some((link) => typeof link !== "string" || link.length === 0)) reason(reasons, "provenance links are required");

  const fixtureEvidence = Object.freeze(input.fixtures.map(evidenceForFixture));
  const blockedNative = input.fixtures.some((fixture) => fixture.status !== "passed");
  if (blockedNative) reason(reasons, "native fixture execution remains blocked pending Phase 7 compatible sealed scaffold closure");
  const verdict = reasons.length === 0 ? "design-ready" : "blocked";
  const withoutDigest = {
    version: 1 as const, certificationProfile: "design" as const, verdict, candidateId: input.candidateId, imageDigest: input.imageDigest,
    policySha256: input.policySha256, fixtures: fixtureEvidence, policyResults: Object.freeze(input.policyResults.map((result) => Object.freeze({ ...result }))),
    provenanceLinks: Object.freeze([...input.provenanceLinks]), waiver: input.waiver, deferredLaunchGates: Object.freeze([...DEFERRED_LAUNCH_GATES]),
  };
  const evidence = Object.freeze({ ...withoutDigest, evidenceSha256: await digest(withoutDigest) });
  return Object.freeze({ verdict, evidence, reasons: Object.freeze(reasons) });
}

export async function validateDesignVerificationEvidence(evidence: DesignVerificationEvidence): Promise<void> {
  if (evidence.version !== 1 || evidence.certificationProfile !== "design" || !["design-ready", "blocked"].includes(evidence.verdict)) throw new Error("design evidence profile is invalid");
  if (!isDigest(evidence.evidenceSha256)) throw new Error("design evidence digest is invalid");
  const { evidenceSha256, ...withoutDigest } = evidence;
  if (await digest(withoutDigest) !== evidenceSha256) throw new Error("design evidence digest does not match canonical content");
  if (evidence.waiver !== null) throw new Error("design evidence cannot authorize an owner waiver");
  if (!evidence.deferredLaunchGates.every((gate) => DEFERRED_LAUNCH_GATES.includes(gate as typeof DEFERRED_LAUNCH_GATES[number]))) throw new Error("design evidence has an unknown deferred launch gate");
}

export async function writeDesignVerificationEvidence(directory: string, input: DesignVerificationInput): Promise<DesignVerificationEvidence> {
  const decision = await evaluateDesignVerification(input);
  if (!decision.evidence) throw new Error("design evidence could not be evaluated");
  await validateDesignVerificationEvidence(decision.evidence);
  await mkdir(directory, { recursive: true });
  const content = `${canonicalJson(decision.evidence)}\n`;
  const path = `${directory}/${decision.evidence.evidenceSha256}.json`;
  try { await writeFile(path, content, { encoding: "utf8", flag: "wx" }); }
  catch (error) {
    if (!(error instanceof Error) || !("code" in error) || error.code !== "EEXIST") throw error;
    if ((await readFile(path, "utf8")) !== content) throw new Error("immutable design evidence collision");
  }
  return decision.evidence;
}
