import { expect, test } from "bun:test";
import { createLiveCostEstimator, RELEASE_COST_FAMILIES } from "../../src/release/costs/live-estimator";

const digest = (letter: string) => letter.repeat(64);
const now = 1_000;

function facts(overrides: Record<string, unknown> = {}) {
  return RELEASE_COST_FAMILIES.map((provider, index) => ({ provider, sourceId: `${provider}-fixture`, sourceDocumentSha256: digest(String.fromCharCode(97 + index)), quoteSha256: digest(String.fromCharCode(65 + index)), currency: "USD", unit: "operation", priceMicros: index + 1, observedAtMs: 900, freshUntilMs: 2_000, status: "available", ...overrides }));
}

function input(overrides: Record<string, unknown> = {}) {
  return { topologySha256: digest("a"), quantities: RELEASE_COST_FAMILIES.map((provider) => ({ provider, quantityNanos: 1_000_000_000n, headroomBasisPoints: 1_000 })), ...overrides };
}

test("requires a fresh, ordered USD fact and bounded headroom for every sixteen provider family", async () => {
  const estimator = createLiveCostEstimator({ catalog: { listPriceFacts: async () => facts() }, now: () => now });
  const estimate = await estimator.estimate(input());
  expect(estimate.lines.map((line) => line.provider)).toEqual(RELEASE_COST_FAMILIES);
  expect(estimate.lines).toHaveLength(16);
  expect(estimate.maximumMicros).toBeGreaterThan(estimate.subtotalMicros);
  expect(estimate.lines.every((line) => line.sourceDocumentSha256.length === 64 && line.quoteSha256.length === 64)).toBeTrue();
});

test("blocks missing/stale/wrong-currency/source-drift facts and checked arithmetic failures", async () => {
  for (const records of [facts().slice(1), facts({ freshUntilMs: now }), facts({ currency: "EUR" }), facts({ status: "unknown" }), facts({ priceMicros: Number.MAX_SAFE_INTEGER })]) {
    const estimator = createLiveCostEstimator({ catalog: { listPriceFacts: async () => records }, now: () => now });
    await expect(estimator.estimate(input())).rejects.toThrow();
  }
});

test("reconciles original-operation actual-cost receipts and blocks unknown or over-bound finalization", async () => {
  const estimator = createLiveCostEstimator({ catalog: { listPriceFacts: async () => facts() }, now: () => now });
  const estimate = await estimator.estimate(input());
  const settled = estimator.reconcileActualCosts({ estimate, receipts: estimate.lines.map((line) => ({ provider: line.provider, operationId: `op-${line.provider}`, status: "observed" as const, actualCostMicros: line.maximumMicros })) });
  expect(settled.status).toBe("settled");
  expect(estimator.reconcileActualCosts({ estimate, receipts: [{ provider: "cloud_run", operationId: "op-cloud-run", status: "unknown" }] })).toEqual({ status: "blocked", reasonCode: "ACTUAL_COST_COVERAGE_REQUIRED" });
  expect(estimator.reconcileActualCosts({ estimate, receipts: estimate.lines.map((line) => ({ provider: line.provider, operationId: `op-${line.provider}`, status: "observed" as const, actualCostMicros: line.maximumMicros + 1 })) }).status).toBe("blocked");
});
