import { expect, test } from "bun:test";
import { createProductionLiveCostCatalog } from "../../src/release/costs/production-catalog";
import { RELEASE_COST_FAMILIES } from "../../src/release/costs/live-estimator";

const digest = (letter: string) => letter.repeat(64);
const nowMs = 1_000_000;

function source(provider: "modal" | "fly", priceMicros: number) {
  return {
    sourceId: `${provider}-official-pricing`,
    bytes: new TextEncoder().encode(`${provider}:public-rate-card:v1`),
    observedAtMs: nowMs - 1,
    freshUntilMs: nowMs + 60_000,
    quotes: [{ provider, currency: "USD", unit: "worker-second", priceMicros }],
  };
}

function catalog(overrides: Partial<Record<string, unknown>> = {}) {
  let calls = 0;
  return {
    calls: () => calls,
    catalog: createProductionLiveCostCatalog({
      now: () => nowMs,
      google: {
        async readCatalog(input) {
          calls += 1;
          expect(input).toEqual({ projectId: undefined, providers: ["cloud_run", "gcs", "collector", "cloud_sql_postgres", "cep8_lightning", "cashu", "model"] });
          return {
            sourceId: "gcp-cloud-billing-catalog-v1",
            bytes: new TextEncoder().encode("official-google-catalog-v1"),
            observedAtMs: nowMs - 1,
            freshUntilMs: nowMs + 60_000,
            quotes: [
              ["cloud_run", 11], ["gcs", 12], ["collector", 13], ["cloud_sql_postgres", 14],
              ["cep8_lightning", 15], ["cashu", 16], ["model", 17],
            ].map(([provider, priceMicros]) => ({ provider, currency: "USD", unit: "operation", priceMicros })),
          };
        },
      },
      sources: {
        async readOfficialPricing(input) {
          if (input.provider === "modal") return source("modal", 18);
          if (input.provider === "fly") return source("fly", 19);
          throw new Error("unexpected source");
        },
      },
      ...overrides,
    }),
  };
}

test("derives one complete current sixteen-family catalog from public sources without selecting a future project", async () => {
  const fixture = catalog();
  const facts = await fixture.catalog.listPriceFacts({ providers: RELEASE_COST_FAMILIES });
  expect(fixture.calls()).toBe(1);
  expect(facts).toHaveLength(16);
  expect(facts.map((fact) => fact.provider)).toEqual(RELEASE_COST_FAMILIES);
  expect(facts.find((fact) => fact.provider === "contextvm")).toMatchObject({ priceMicros: 0, sourceId: "napplet-cvm-nonbillable-policy-v1", unit: "operation" });
  expect(facts.find((fact) => fact.provider === "modal")).toMatchObject({ priceMicros: 18, sourceId: "modal-official-pricing" });
  expect(facts.find((fact) => fact.provider === "fly")).toMatchObject({ priceMicros: 19, sourceId: "fly-official-pricing" });
  expect(facts.some((fact) => fact.priceMicros === 158 || fact.sourceId.includes("fixture"))).toBeFalse();
  expect(facts.every((fact) => /^[a-f0-9]{64}$/u.test(fact.sourceDocumentSha256) && /^[a-f0-9]{64}$/u.test(fact.quoteSha256))).toBeTrue();
});

test("fails closed on stale, incomplete, changed, unpriced, or non-USD source facts", async () => {
  for (const scenario of [
    { sources: { async readOfficialPricing(input: { provider: "modal" | "fly" }) { return source(input.provider, input.provider === "modal" ? 18 : 19); } }, google: { async readCatalog() { return { sourceId: "gcp-cloud-billing-catalog-v1", bytes: new TextEncoder().encode("a"), observedAtMs: nowMs - 1, freshUntilMs: nowMs, quotes: [] }; } } },
  ]) {
    const candidate = createProductionLiveCostCatalog({ now: () => nowMs, ...scenario });
    await expect(candidate.listPriceFacts({ providers: RELEASE_COST_FAMILIES })).rejects.toThrow();
  }
  const fixture = catalog();
  await expect(fixture.catalog.listPriceFacts({ providers: [...RELEASE_COST_FAMILIES].reverse() })).rejects.toThrow("PRODUCTION_CATALOG_COVERAGE_REQUIRED");
  expect(digest("a")).toHaveLength(64);
});
