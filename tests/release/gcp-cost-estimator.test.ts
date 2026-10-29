import { expect, test } from "bun:test";
import { createGcpCostEstimator, type GcpCostEstimateInput, type GcpCatalogPort } from "../../src/release/costs/gcp-estimator";

const digest = (letter: string) => letter.repeat(64);
const now = 1_000;
const skus = ["run", "collector", "sql", "storage", "network", "retention"] as const;

function port(records: readonly Record<string, unknown>[]): GcpCatalogPort {
  return { listSkus: async (input) => records.filter((record) => input.skuIds.includes(record.skuId as string)) };
}

function input(overrides: Record<string, unknown> = {}): GcpCostEstimateInput {
  return {
    topologySha256: digest("a"),
    catalogId: "gcp-cloud-billing-v1",
    sourceId: "cloud-billing-catalog",
    regions: ["europe-west1", "us-central1"],
    durationMs: 900_000,
    cleanupByMs: 1_900,
    evidenceRetentionDays: 30,
    artifactRetentionDays: 30,
    headroomBasisPoints: 1_000,
    quantities: skus.map((sku) => ({ component: sku === "run" ? "cloud_run" : sku === "collector" ? "collector" : sku === "sql" ? "cloud_sql" : sku, skuId: sku, region: sku === "storage" || sku === "retention" ? "nam4" : "europe-west1", quantityNanos: 1_000_000_000n })),
    ...overrides,
  };
}

function catalog(overrides: Record<string, unknown> = {}) {
  return skus.map((sku, index) => ({
    skuId: sku,
    serviceId: `service-${sku}`,
    region: sku === "storage" || sku === "retention" ? "nam4" : "europe-west1",
    currencyCode: "USD",
    units: String(index + 1),
    nanos: 0,
    observedAtMs: 900,
    freshUntilMs: 2_000,
    ...overrides,
  }));
}

test("prices the exact bounded topology from injected fresh Cloud Billing catalog records in checked USD micros", async () => {
  const estimator = createGcpCostEstimator({ port: port(catalog()), now: () => now });
  const result = await estimator.estimate(input());

  expect(result).toEqual(expect.objectContaining({
    currency: "USD", maximumMicros: 23_100_000, sourceId: "cloud-billing-catalog", catalogId: "gcp-cloud-billing-v1",
    observedAtMs: 900, freshUntilMs: 2_000, durationMs: 900_000, cleanupByMs: 1_900,
    evidenceRetentionDays: 30, artifactRetentionDays: 30, headroomBasisPoints: 1_000,
  }));
  expect(result.lines.map((line) => line.skuId)).toEqual([...skus]);
  expect(result.sourceSha256).toMatch(/^[a-f0-9]{64}$/);
});

test("fails closed for stale, missing, foreign-currency, and overflowing catalog data before it can become authorization input", async () => {
  const stale = createGcpCostEstimator({ port: port(catalog({ freshUntilMs: now })), now: () => now });
  await expect(stale.estimate(input())).rejects.toThrow("GCP_COST_CATALOG_STALE");

  const missing = createGcpCostEstimator({ port: port(catalog().slice(1)), now: () => now });
  await expect(missing.estimate(input())).rejects.toThrow("GCP_COST_CATALOG_MISSING_SKU");

  const foreign = createGcpCostEstimator({ port: port(catalog({ currencyCode: "CAD" })), now: () => now });
  await expect(foreign.estimate(input())).rejects.toThrow("GCP_COST_CURRENCY_INVALID");

  const overflowing = createGcpCostEstimator({ port: port(catalog({ units: "9007199254740992" })), now: () => now });
  await expect(overflowing.estimate(input())).rejects.toThrow("GCP_COST_OVERFLOW");
});
