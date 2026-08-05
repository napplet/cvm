import { expect, test } from "bun:test";

import { projectPreviewRuntimeStatus, safePreviewDenial } from "../../src/publication/public-status.js";
import { PreviewService } from "../../src/publication/preview-service.js";
import { DeterministicPreviewHostPort, DeterministicSealedArtifactPort, fixedPhase06Clock, verifiedPhase06Artifact } from "./fakes.js";

const review = Object.freeze({
  artifactId: verifiedPhase06Artifact.artifactId,
  aggregateSha256: verifiedPhase06Artifact.aggregateSha256,
  normalizedDTag: verifiedPhase06Artifact.normalizedDTag,
  runtimeVariant: "napplet-host/v1",
  required: [{ capability: "notes.read", purpose: "Read notes", consent: "required" as const, available: true }],
  optional: [{ capability: "notifications", purpose: "Show notifications", consent: "optional" as const, available: false }],
  compatibility: "degraded" as const,
  capabilityDigest: "e".repeat(64),
});

async function descriptor() {
  return new PreviewService({
    sealedArtifacts: new DeterministicSealedArtifactPort(),
    host: new DeterministicPreviewHostPort(),
    clock: fixedPhase06Clock(),
    capabilityReview: () => review,
  }).previewVerifiedArtifact({
    accountId: verifiedPhase06Artifact.accountId,
    sessionId: verifiedPhase06Artifact.sessionId,
    artifactId: verifiedPhase06Artifact.artifactId,
    runtimeVariant: "napplet-host/v1",
  });
}

test("projects ready, incompatible, exact-expiry, post-expiry, and denied observations into only safe states", async () => {
  const issued = await descriptor();
  if ("state" in issued) throw new Error("fixture did not issue a descriptor");
  for (const [observation, nowMs, state, nextAction] of [
    [{ state: "ready", tainted: "ignored" }, issued.expiresAtMs - 1, "ready", "review_capabilities"],
    [{ state: "incompatible", rawProviderDetail: "ignored" }, issued.expiresAtMs - 1, "incompatible", "review_capabilities"],
    [{ state: "ready" }, issued.expiresAtMs, "expired", "preview"],
    [{ state: "ready" }, issued.expiresAtMs + 1, "expired", "preview"],
    [{ state: "denied", action: "publish" }, issued.expiresAtMs - 1, "denied", "preview"],
  ] as const) {
    const result = projectPreviewRuntimeStatus({ descriptor: issued, observation, nowMs });
    expect(result).toMatchObject({ state, nextAction });
    expect(Object.keys(result).sort()).toEqual([
      "artifactId", "artifactSha256", "capabilityDigest", "descriptorId", "expiresAt", "missingRequired", "nextAction", "operationId", "runtimeVariant", "safeReasonCode", "state", "unavailableOptional",
    ]);
    expect(JSON.stringify(result)).not.toContain("tainted");
    expect(JSON.stringify(result)).not.toContain("rawProviderDetail");
  }
});

test("safe denial never becomes a runtime or publication authority", () => {
  expect(safePreviewDenial()).toEqual({ state: "denied", safeReasonCode: "preview_not_available", nextAction: "preview" });
});
