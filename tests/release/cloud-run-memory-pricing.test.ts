import { expect, test } from "bun:test";
import { createOfficialPricingSources, PRODUCTION_CATALOG_SELECTORS } from "../../src/release/costs/official-sources";

const price = (usageUnit: string, nanos: number) => [{ pricingExpression: { usageUnit, tieredRates: [{ unitPrice: { currencyCode: "USD", units: "0", nanos } }] } }];
const cpu = [
  { skuId: "4C19-DF1E-81AB", serviceRegions: ["europe-west1"], pricingInfo: price("s", 18_000) },
  { skuId: "011E-3072-CBDB", serviceRegions: ["us-central1"], pricingInfo: price("s", 18_000) },
];
const memory = (region: string, usageType = "OnDemand", usageUnit = "GiBy.s") => ({ skuId: "MEM-" + region, description: "Memory Allocation Time (Always-on CPU) in " + region, category: { usageType }, serviceRegions: [region], pricingInfo: price(usageUnit, 2_000) });
function source(rows: readonly unknown[]) {
  let calls = 0;
  const sources = createOfficialPricingSources({ now: () => 1_000_000, adc: { async readAccessToken() { return "offline-token-marker-0000000000"; } }, fetch: async url => {
    calls++;
    return new Response(JSON.stringify(url.includes("/skus?") ? { skus: [...cpu, ...rows] } : { services: [{ name: "services/RUN", displayName: "Cloud Run" }] }));
  }, google: { selectors: PRODUCTION_CATALOG_SELECTORS }, workers: { modal: { cpuCores: 2, memoryGiB: 2, unit: "worker-second" }, fly: { preset: "shared-cpu-1x", memory: "1GB", unit: "worker-second" } } });
  return { read: () => sources.google.readCatalog({ projectId: undefined, providers: ["cloud_run", "collector"] }), calls: () => calls };
}

test("semantic memory selection binds both regions and on-demand usage without assigning a CPU price to RAM", async () => {
  const reader = source([memory("europe-west1"), memory("us-central1"), memory("europe-west1", "Commit1Yr")]);
  const result = await reader.read();
  expect(result).toMatchObject({ quotes: [
    { provider: "cloud_run", componentId: "cloud_run.europe-west1.cpu", priceMicros: 18, unit: "worker-second" },
    { provider: "cloud_run", componentId: "cloud_run.europe-west1.memory", priceMicros: 2, unit: "gibibyte-second" },
    { provider: "cloud_run", componentId: "cloud_run.us-central1.cpu", priceMicros: 18 },
    { provider: "cloud_run", componentId: "cloud_run.us-central1.memory", priceMicros: 2 },
    { provider: "collector", componentId: "collector.europe-west1.cpu", priceMicros: 18 },
    { provider: "collector", componentId: "collector.europe-west1.memory", priceMicros: 2 },
    { provider: "collector", componentId: "collector.us-central1.cpu", priceMicros: 18 },
    { provider: "collector", componentId: "collector.us-central1.memory", priceMicros: 2 },
  ] });
  expect(reader.calls()).toBe(2);
});

test("memory price selection rejects wrong units, unavailable regions, discounted-only and ambiguous catalog results", async () => {
  for (const rows of [
    [memory("europe-west1", "OnDemand", "By.s"), memory("us-central1")],
    [memory("europe-west1"), memory("asia-east1")],
    [memory("europe-west1", "Commit1Yr"), memory("us-central1")],
    [memory("europe-west1"), { ...memory("europe-west1"), skuId: "MEM-RIVAL" }, memory("us-central1")],
  ]) await expect(source(rows).read()).rejects.toThrow();
});
