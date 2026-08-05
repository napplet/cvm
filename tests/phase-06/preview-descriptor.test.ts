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

function previewHarness() {
  const sealedArtifacts = new DeterministicSealedArtifactPort();
  const host = new DeterministicPreviewHostPort();
  const deployment = new DeterministicNappletDeploymentPort();
  const attestation = new DeterministicAttestationPort();
  return {
    sealedArtifacts, host, deployment, attestation,
    preview: new PreviewService({ sealedArtifacts, host, clock: fixedPhase06Clock(), capabilityReview: canonicalCapabilityReview }),
  };
}

test("issues one exact verified-artifact descriptor with an allow-scripts-only read grant", async () => {
  const h = previewHarness();
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
