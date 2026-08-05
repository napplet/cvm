import { expect, test } from "bun:test";

import { canonicalCapabilityReview } from "../../src/publication/capability-review.js";
import { PreviewService } from "../../src/publication/preview-service.js";
import {
  DeterministicAttestationPort,
  DeterministicNappletDeploymentPort,
  DeterministicPreviewHostPort,
  DeterministicSealedArtifactPort,
  fixedPhase06Clock,
  verifiedPhase06Artifact,
} from "./fakes.js";
import { reportPhase06Observation } from "./reference-observation.js";
import type { LifecycleObservation } from "../../src/telemetry/contracts";

function previewHarness(telemetry?: { observe(observation: LifecycleObservation): void }) {
  const sealedArtifacts = new DeterministicSealedArtifactPort();
  const host = new DeterministicPreviewHostPort();
  const deployment = new DeterministicNappletDeploymentPort();
  const attestation = new DeterministicAttestationPort();
  return {
    sealedArtifacts, host, deployment, attestation,
    preview: new PreviewService({ sealedArtifacts, host, clock: fixedPhase06Clock(), capabilityReview: canonicalCapabilityReview, telemetry }),
  };
}

test("issues one exact verified-artifact descriptor with an allow-scripts-only read grant", async () => {
  const observations: LifecycleObservation[] = [];
  const h = previewHarness({ observe: (observation) => { observations.push(observation); } });
  const result = await h.preview.previewVerifiedArtifact({
    accountId: verifiedPhase06Artifact.accountId,
    sessionId: verifiedPhase06Artifact.sessionId,
    artifactId: verifiedPhase06Artifact.artifactId,
    runtimeVariant: "napplet-host/v1",
  });

  expect(result).toMatchObject({
    artifact: {
      aggregateSha256: verifiedPhase06Artifact.aggregateSha256,
      manifestSha256: verifiedPhase06Artifact.manifestSha256,
      sealedObjectSha256: verifiedPhase06Artifact.sealedObjectSha256,
      entrypoint: verifiedPhase06Artifact.entrypoint,
    },
    iframeSandbox: "allow-scripts",
    authority: "preview_read_only",
    expiresAtMs: 1_700_000_060_000,
    review: {
      compatibility: "degraded",
      optional: [
        { capability: "notifications", available: false },
      ],
    },
  });
  expect(h.host.calls).toBe(1);
  expect(h.host.descriptors[0]).toMatchObject({
    artifact: { artifactId: verifiedPhase06Artifact.artifactId },
    review: { runtimeVariant: "napplet-host/v1" },
  });
  expect(h.deployment.calls).toBe(0);
  expect(h.attestation.calls).toBe(0);
  expect(JSON.stringify(result)).not.toContain("allowSameOrigin");
  expect(JSON.stringify(result)).not.toContain("publicationAuthority");
  expect(observations).toEqual([expect.objectContaining({ stage: "preview", outcome: "succeeded", correlationDigest: expect.stringMatching(/^sha256:[a-f0-9]{64}$/u) })]);
});

test("blocks an incompatible required-capability review before descriptor or facade effects", async () => {
  const h = previewHarness();
  h.sealedArtifacts.artifact = {
    ...verifiedPhase06Artifact,
    manifestCapabilities: verifiedPhase06Artifact.manifestCapabilities?.map((capability) => capability.name === "notes.read" ? { ...capability, available: false } : capability),
  };

  const result = await h.preview.previewVerifiedArtifact({
    accountId: verifiedPhase06Artifact.accountId,
    sessionId: verifiedPhase06Artifact.sessionId,
    artifactId: verifiedPhase06Artifact.artifactId,
    runtimeVariant: "napplet-host/v1",
  });

  expect(result).toEqual({ state: "denied", safeReasonCode: "preview_not_available", nextAction: "preview" });
  expect("previewGrantId" in result).toBe(false);
  expect(h.host.calls).toBe(0);
  expect(h.host.descriptors).toEqual([]);
  expect(h.deployment.calls).toBe(0);
  expect(h.attestation.calls).toBe(0);
  reportPhase06Observation({ id: "P06-CAP-REQUIRED-BLOCK-01", status: "denied", effects: "host=0;publication=0", value: "required-capability-incompatible" });
});

test("denies empty or null artifact and manifest-like identity before host or publication effects", async () => {
  for (const artifact of [null, {}, { ...verifiedPhase06Artifact, manifestSha256: "" }]) {
    const h = previewHarness();
    h.sealedArtifacts.artifact = artifact;
    const result = await h.preview.previewVerifiedArtifact({
      accountId: verifiedPhase06Artifact.accountId,
      sessionId: verifiedPhase06Artifact.sessionId,
      artifactId: verifiedPhase06Artifact.artifactId,
      runtimeVariant: "napplet-host/v1",
    });
    expect(result).toMatchObject({ state: "denied", safeReasonCode: "preview_not_available" });
    expect(h.host.calls).toBe(0);
    expect(h.deployment.calls).toBe(0);
    expect(h.attestation.calls).toBe(0);
  }
  for (const id of ["P06-PREV-EMPTY-01", "P06-PREV-NULL-01", "P06-MANIFEST-EMPTY-01", "P06-MANIFEST-NULL-01"]) reportPhase06Observation({ id, status: "denied", effects: "host=0;publication=0", value: "safe" });
});

test("rejects host grants that attempt any browser or publication authority expansion", async () => {
  const h = previewHarness();
  h.host.response = { previewGrantId: "preview-grant:unsafe", iframeSandbox: "allow-scripts", authority: "preview_read_only", unrestrictedNetwork: true };
  const result = await h.preview.previewVerifiedArtifact({
    accountId: verifiedPhase06Artifact.accountId,
    sessionId: verifiedPhase06Artifact.sessionId,
    artifactId: verifiedPhase06Artifact.artifactId,
    runtimeVariant: "napplet-host/v1",
  });
  expect(result).toMatchObject({ state: "denied", safeReasonCode: "preview_not_available" });
  expect(h.deployment.calls).toBe(0);
  expect(h.attestation.calls).toBe(0);
});
