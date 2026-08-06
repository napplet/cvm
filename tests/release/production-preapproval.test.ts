import { expect, test } from "bun:test";
import { createOfficialPricingSources } from "../../src/release/costs/official-sources";
import { deriveReleaseTopology } from "../../src/release/topology";

const digest = (letter: string) => letter.repeat(64);

test("captures only allowlisted official pricing bytes and derives ordered non-uniform topology quantities", async () => {
  const calls: string[] = [];
  const sources = createOfficialPricingSources({
    now: () => 1_000_000,
    fetch: async (request, init) => {
      const url = String(request);
      calls.push(url);
      expect(init?.redirect).toBe("error");
      if (url === "https://cloudbilling.googleapis.com/v1/services") {
        return new Response(JSON.stringify({ services: [{ name: "services/RUN", serviceId: "RUN", displayName: "Cloud Run" }] }));
      }
      if (url.startsWith("https://cloudbilling.googleapis.com/v1/services/RUN/skus?")) {
        return new Response(JSON.stringify({ skus: [{ skuId: "RUN-CPU", serviceRegions: ["europe-west1", "us-central1"], pricingInfo: [{ currencyConversionRate: 1, pricingExpression: { usageUnit: "seconds", tieredRates: [{ unitPrice: { currencyCode: "USD", units: "0", nanos: 1000 } }] } }] }] }));
      }
      if (url === "https://modal.com/pricing") return new Response("Modal Sandbox $0.00003942 / core / sec $0.00000667 / GiB / sec");
      if (url === "https://fly.io/docs/about/pricing/") return new Response("shared-cpu-1x 256MB $0.00000078");
      return new Response("not found", { status: 404 });
    },
    google: {
      selectors: [{ provider: "cloud_run", serviceDisplayName: "Cloud Run", skuId: "RUN-CPU", regions: ["europe-west1", "us-central1"], usageUnit: "seconds", unit: "worker-second" }],
    },
    workers: {
      modal: { cpuCores: 1, memoryGiB: 1, unit: "worker-second" },
      fly: { preset: "shared-cpu-1x", memory: "256MB", unit: "worker-second" },
    },
  });

  const google = await sources.google.readCatalog({ projectId: undefined, providers: ["cloud_run"] });
  const modal = await sources.sources.readOfficialPricing({ provider: "modal" });
  const fly = await sources.sources.readOfficialPricing({ provider: "fly" });
  expect(google).toMatchObject({ sourceId: "gcp-cloud-billing-catalog-v1", quotes: [{ provider: "cloud_run", unit: "worker-second", priceMicros: 1 }] });
  expect(modal).toMatchObject({ quotes: [{ provider: "modal", unit: "worker-second" }] });
  expect(fly).toMatchObject({ quotes: [{ provider: "fly", unit: "worker-second" }] });
  expect(calls).toEqual([
    "https://cloudbilling.googleapis.com/v1/services",
    "https://cloudbilling.googleapis.com/v1/services/RUN/skus?currencyCode=USD&pageSize=5000",
    "https://modal.com/pricing",
    "https://fly.io/docs/about/pricing/",
  ]);

  const topology = await deriveReleaseTopology(digest("a"));
  expect(topology.quantityContract.map((line) => line.provider)).toHaveLength(16);
  expect(new Set(topology.quantityContract.map((line) => line.quantityNanos.toString())).size).toBeGreaterThan(1);
  expect(topology.quantityContract.find((line) => line.provider === "cloud_run")?.quantityNanos).toBe(5_400_000_000_000n);
  expect(topology.topologySha256).toMatch(/^[a-f0-9]{64}$/);
});

test("rejects redirects, unrecognized official rates, wrong units, and uniform quantity contracts", async () => {
  const source = createOfficialPricingSources({
    now: () => 1_000_000,
    fetch: async () => new Response("redirect", { status: 302, headers: { location: "https://evil.example" } }),
    google: { selectors: [{ provider: "cloud_run", serviceDisplayName: "Cloud Run", skuId: "RUN-CPU", regions: ["europe-west1", "us-central1"], usageUnit: "seconds", unit: "worker-second" }] },
    workers: { modal: { cpuCores: 1, memoryGiB: 1, unit: "worker-second" }, fly: { preset: "shared-cpu-1x", memory: "256MB", unit: "worker-second" } },
  });
  await expect(source.google.readCatalog({ projectId: undefined, providers: ["cloud_run"] })).rejects.toThrow("OFFICIAL_SOURCE_RESPONSE_REJECTED");
  await expect(source.sources.readOfficialPricing({ provider: "modal" })).rejects.toThrow("OFFICIAL_SOURCE_RESPONSE_REJECTED");
});
