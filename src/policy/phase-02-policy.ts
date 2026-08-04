/**
 * Phase 2's initial policy fixture.  Policy consumers import these ceilings;
 * changing one requires a new named, versioned fixture rather than a fallback.
 */
export const PHASE_02_POLICY_INITIAL = deepFreeze({
  policyVersion: "phase-02-policy-2026-08-04",
  admission: {
    maxCodePoints: 4_000,
    maxUtf8Bytes: 16 * 1024,
    maxGraphemes: 4_096,
    maxInputTokens: 2_000,
    maxLines: 64,
    maxCodePointsPerLine: 1_000,
  },
  tools: { maxPathCharacters: 300, maxWriteContentCharacters: 30_000 },
  action: { maxTurns: 16 },
  sandbox: {
    cpu: "1/2",
    memoryGiB: "1/2",
    lifetimeMinutes: 20,
    idleTimeoutMinutes: 2,
    execTimeoutSeconds: 30,
    maxOutputBytes: 1024 * 1024,
  },
} as const);

export type Phase02Policy = typeof PHASE_02_POLICY_INITIAL;

function deepFreeze<T>(value: T): T {
  if (value !== null && typeof value === "object" && !Object.isFrozen(value)) {
    for (const child of Object.values(value as Record<string, unknown>)) deepFreeze(child);
    Object.freeze(value);
  }
  return value;
}
