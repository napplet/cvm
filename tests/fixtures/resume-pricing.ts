import { createVertexGeminiProductionPricing } from "../../src/model/price-card";
import type { ResumePricingContext } from "../../src/continuity/resume-pricing";

export const resumePricingContext = (now: number): ResumePricingContext => ({
  realm: "production-real", accountId: "account:owner", sessionId: "session:one", checkpointId: "checkpoint:one",
  checkpointSha256: "a".repeat(64), checkpointVersion: 1, expectedSessionVersion: 1, expectedArtifactVersion: 1,
  pendingAction: { reference: "pending:one", fingerprint: "b".repeat(64), kind: "revise_session", maximum: "1" },
  commandSha256: "c".repeat(64), originalOperationId: "operation:original", originalSettlementSha256: "d".repeat(64),
  originalCommandMaximum: "50", policyVersion: "policy:one", toolchainId: "toolchain:one", retentionUntilMs: now + 86_400_000,
});
export async function resumePricingMaterial(now: number) {
  // Synthetic source fixture only; these numbers are not current API prices.
  return createVertexGeminiProductionPricing({
    observation: { sourceUrl: "https://cloud.google.com/vertex-ai/generative-ai/pricing", bytes: new TextEncoder().encode("synthetic source fixture"),
      observedAtMs: now, freshUntilMs: now + 120_000, currency: "USD", location: "global", model: "gemini-4-argon",
      inputMicrosPerMillion: 1_000_000, cachedInputMicrosPerMillion: 1_000_000, outputAndThoughtMicrosPerMillion: 1_000_000 },
    conversion: { source: { url: "https://fx.example/fixture", capturedBytesSha256: "e".repeat(64), observedAt: new Date(now).toISOString(),
      effectiveAt: new Date(now).toISOString(), freshUntil: new Date(now + 90_000).toISOString() }, satsPerUsd: { numerator: "10000", denominator: "1" } },
    maximumInputTokens: "100", maximumOutputTokens: "10", profileId: "profile:one", deadlineMs: 10_000,
  });
}
