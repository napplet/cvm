import { expect, test } from "bun:test";

import { canonicalCapabilityBytes, canonicalCapabilityReview, capabilityDigestForReview, evaluateRuntimeCompatibility } from "../../src/publication/capability-review.js";
import { verifiedPhase06Artifact } from "./fakes.js";
import { reportPhase06Observation } from "./reference-observation.js";

function manifestArtifact(capabilities: unknown) {
  return { ...verifiedPhase06Artifact, requiredCapabilities: ["notes.read"], optionalCapabilities: ["notifications"], manifestCapabilities: capabilities };
}

const required = {
  name: "notes.read",
  requirement: "required",
  purpose: "Read selected notes",
  consent: "required",
  compatibleRuntimes: ["napplet-host/v1"],
  available: true,
};
const optional = {
  name: "notifications",
  requirement: "optional",
  purpose: "Show completion notices",
  consent: "optional",
  compatibleRuntimes: [],
  available: true,
};

test("canonicalizes empty and permuted verified-manifest capability declarations into exact stable bytes", async () => {
  const empty = await canonicalCapabilityReview({ ...verifiedPhase06Artifact, requiredCapabilities: [], optionalCapabilities: [], manifestCapabilities: [] }, "napplet-host/v1");
  expect(empty).toMatchObject({ required: [], optional: [], compatibility: "compatible" });
  expect(await capabilityDigestForReview(empty)).toBe(empty.capabilityDigest);

  const first = await canonicalCapabilityReview(manifestArtifact([optional, required]), "napplet-host/v1");
  const second = await canonicalCapabilityReview(manifestArtifact([required, optional]), "napplet-host/v1");
  expect(first.required[0]).toMatchObject({ name: "notes.read", requirement: "required", consent: "required", compatibleRuntimes: ["napplet-host/v1"], available: true });
  expect(first.optional[0]).toMatchObject({ name: "notifications", requirement: "optional", consent: "optional", compatibleRuntimes: [], available: false });
  expect(Array.from(canonicalCapabilityBytes(first))).toEqual(Array.from(canonicalCapabilityBytes(second)));
  expect(first.capabilityDigest).toBe(second.capabilityDigest);
  reportPhase06Observation({ id: "P06-CAP-EMPTY-01", status: "canonical", effects: "deploy=0", value: "empty-digest" });
  reportPhase06Observation({ id: "P06-CAP-ORDER-01", status: "canonical", effects: "deploy=0", value: "required-first" });
  reportPhase06Observation({ id: "P06-CAP-HASH-01", status: "canonical", effects: "deploy=0", value: "equal-digest" });
});

test("rejects null, duplicate, contradictory, or identity-mismatched capability declarations", async () => {
  await expect(canonicalCapabilityReview(manifestArtifact(null), "napplet-host/v1")).rejects.toThrow();
  await expect(canonicalCapabilityReview(manifestArtifact([required, required]), "napplet-host/v1")).rejects.toThrow();
  await expect(canonicalCapabilityReview(manifestArtifact([{ ...required, consent: "optional" }]), "napplet-host/v1")).rejects.toThrow();
  await expect(canonicalCapabilityReview(manifestArtifact([{ ...required, name: "other.capability" }]), "napplet-host/v1")).rejects.toThrow();
  reportPhase06Observation({ id: "P06-CAP-NULL-01", status: "denied", effects: "deploy=0", value: "invalid" });
});

test("blocks missing required capabilities, exposes optional degradation, and binds compatibility fences into review identity", async () => {
  const requiredUnavailable = await canonicalCapabilityReview(manifestArtifact([{ ...required, available: false }, optional]), "napplet-host/v1");
  const optionalUnavailable = await canonicalCapabilityReview(manifestArtifact([required, optional]), "napplet-host/v1");
  const incompatibleRuntime = await canonicalCapabilityReview(manifestArtifact([required, optional]), "different-host/v1");
  expect(requiredUnavailable.compatibility).toBe("incompatible");
  expect(optionalUnavailable.compatibility).toBe("degraded");
  expect(incompatibleRuntime.compatibility).toBe("incompatible");
  expect(evaluateRuntimeCompatibility(optionalUnavailable)).toEqual({ compatibility: "degraded", missingRequired: [], unavailableOptional: ["notifications"] });
  expect(incompatibleRuntime.capabilityDigest).not.toBe(optionalUnavailable.capabilityDigest);
  const changedPolicy = await canonicalCapabilityReview({ ...manifestArtifact([required, optional]), policyIdentity: "policy:changed" }, "napplet-host/v1");
  const changedDTag = await canonicalCapabilityReview({ ...manifestArtifact([required, optional]), normalizedDTag: "changed-napplet" }, "napplet-host/v1");
  expect(changedPolicy.capabilityDigest).not.toBe(optionalUnavailable.capabilityDigest);
  expect(changedDTag.capabilityDigest).not.toBe(optionalUnavailable.capabilityDigest);
});


test("GAMEPAD availability preserves the optional fallback and blocks controller-required artifacts", async () => {
  const controller = { name: "gamepad", requirement: "optional", purpose: "Optional controller input", consent: "optional", compatibleRuntimes: [], available: false };
  const artifact = { ...verifiedPhase06Artifact, requiredCapabilities: [], optionalCapabilities: ["gamepad"], manifestCapabilities: [controller] };
  const review = await canonicalCapabilityReview(artifact, "napplet-host/v1");
  expect(evaluateRuntimeCompatibility(review)).toEqual({ compatibility: "degraded", missingRequired: [], unavailableOptional: ["gamepad"] });
  const requiredReview = await canonicalCapabilityReview({ ...artifact, requiredCapabilities: ["gamepad"], optionalCapabilities: [], manifestCapabilities: [{ ...controller, requirement: "required", consent: "required" }] }, "napplet-host/v1");
  expect(evaluateRuntimeCompatibility(requiredReview)).toEqual({ compatibility: "incompatible", missingRequired: ["gamepad"], unavailableOptional: [] });
});
