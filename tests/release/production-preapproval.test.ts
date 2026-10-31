import { expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { createOfficialPricingSources } from "../../src/release/costs/official-sources";
import { createCertificationBudgetCatalog, createProductionLiveCostCatalog } from "../../src/release/costs/production-catalog";
import { PriceFactSchema, createLiveCostEstimator, RELEASE_COST_FAMILIES } from "../../src/release/costs/live-estimator";
import { loadPreparedCollectorPreapproval, materializePreapproval, verifyPreapprovalMaterialization } from "../../src/release/preapproval-materializer";
import { deriveReleaseTopology } from "../../src/release/topology";
import { RELEASE_TOPOLOGY_QUANTITY_CONTRACT } from "../../src/release/topology";

const digest = (letter: string) => letter.repeat(64);

test("certification ceiling prices Argon input and output/thought at their distinct official units", async () => {
  const estimator = createLiveCostEstimator({
    catalog: createCertificationBudgetCatalog({ quantityContract: RELEASE_TOPOLOGY_QUANTITY_CONTRACT, now: () => 1_000_000 }),
    now: () => 1_000_000,
  });
  const estimate = await estimator.estimate({
    topologySha256: digest("9"),
    quantities: RELEASE_COST_FAMILIES.map((provider) => ({ provider, quantityNanos: 1_000_000_000n, headroomBasisPoints: 1_000 })),
    components: RELEASE_TOPOLOGY_QUANTITY_CONTRACT,
  });
  const model = estimate.lines.find((line) => line.provider === "model")!;
  expect(model.components?.map((component) => component.priceMicros)).toEqual([40_000_000, 200_000_000]);
  expect(estimate.maximumMicros).toBeGreaterThan(1_000_000_000);
  expect(estimate.maximumMicros).toBeLessThan(2_000_000_000);
});

test("binds each regional Google component to one authenticated catalog SKU without exposing ADC", async () => {
  const calls: string[] = [];
  const sources = createOfficialPricingSources({
    now: () => 1_000_000,
    fetch: async (request, init) => {
      const url = String(request);
      calls.push(url);
      expect(init?.redirect).toBe("error");
      if (url === "https://cloudbilling.googleapis.com/v1/services?pageSize=5000") {
        expect(init?.headers).toEqual(expect.objectContaining({ authorization: "Bearer opaque-adc-token-canary-value" }));
        return new Response(JSON.stringify({ services: [{ name: "services/RUN", serviceId: "RUN", displayName: "Cloud Run" }] }));
      }
      if (url.startsWith("https://cloudbilling.googleapis.com/v1/services/RUN/skus?")) {
        expect(init?.headers).toEqual(expect.objectContaining({ authorization: "Bearer opaque-adc-token-canary-value" }));
        return new Response(JSON.stringify({ skus: [
          { skuId: "RUN-EU", serviceRegions: ["europe-west1"], pricingInfo: [{ currencyConversionRate: 1, pricingExpression: { usageUnit: "seconds", tieredRates: [{ unitPrice: { currencyCode: "USD", units: "0", nanos: 1000 } }] } }] },
          { skuId: "RUN-US", serviceRegions: ["us-central1"], pricingInfo: [{ currencyConversionRate: 1, pricingExpression: { usageUnit: "seconds", tieredRates: [{ unitPrice: { currencyCode: "USD", units: "0", nanos: 2000 } }] } }] },
        ] }));
      }
      if (url === "https://modal.com/pricing") return new Response("<section id=\"sandboxes\"><h2>Modal Sandbox pricing</h2><div class=\"resource-row\"><span>CPU (non-preemptible)</span><span>$0.00003942 / core / sec</span></div><div class=\"resource-row\"><span>Memory (non-preemptible)</span><span>$0.00000667 / GiB / sec</span></div></section>");
      if (url === "https://docs.fly.io/about/pricing") return new Response("shared-cpu-1x 256MB $0.00000078 / second");
      return new Response("not found", { status: 404 });
    },
    google: {
      selectors: [
        { componentId: "cloud_run.europe-west1.cpu", provider: "cloud_run", serviceDisplayName: "Cloud Run", skuId: "RUN-EU", region: "europe-west1", usageUnit: "seconds", unit: "worker-second" },
        { componentId: "cloud_run.us-central1.cpu", provider: "cloud_run", serviceDisplayName: "Cloud Run", skuId: "RUN-US", region: "us-central1", usageUnit: "seconds", unit: "worker-second" },
      ],
    },
    adc: { async readAccessToken() { return "opaque-adc-token-canary-value"; } },
    workers: {
      modal: { cpuCores: 1, memoryGiB: 1, unit: "worker-100-seconds" },
      fly: { preset: "shared-cpu-1x", memory: "256MB", unit: "worker-100-seconds" },
    },
  });

  const google = await sources.google.readCatalog({ projectId: undefined, providers: ["cloud_run"] });
  const modal = await sources.sources.readOfficialPricing({ provider: "modal" });
  const fly = await sources.sources.readOfficialPricing({ provider: "fly" });
  expect(google).toMatchObject({ sourceId: "gcp-cloud-billing-catalog-v1", quotes: [
    { componentId: "cloud_run.europe-west1.cpu", region: "europe-west1", provider: "cloud_run", skuId: "RUN-EU", unit: "worker-second", priceMicros: 1 },
    { componentId: "cloud_run.us-central1.cpu", region: "us-central1", provider: "cloud_run", skuId: "RUN-US", unit: "worker-second", priceMicros: 2 },
  ] });
  expect(modal).toMatchObject({ quotes: [{ provider: "modal", unit: "worker-100-seconds", priceNanos: "4609000", priceMicros: 4609 }] });
  expect(fly).toMatchObject({ quotes: [{ provider: "fly", unit: "worker-100-seconds" }] });
  expect(calls).toEqual([
    "https://cloudbilling.googleapis.com/v1/services?pageSize=5000",
    "https://cloudbilling.googleapis.com/v1/services/RUN/skus?currencyCode=USD&pageSize=5000",
    "https://modal.com/pricing",
    "https://docs.fly.io/about/pricing",
  ]);

  const topology = await deriveReleaseTopology(digest("a"));
  // One Cloud SQL REGIONAL HA authority serves both ingress regions; billing
  // must not fabricate a second database from the second Cloud Run region.
  expect(topology.quantityContract.map((line) => line.provider)).toHaveLength(24);
  expect(new Set(topology.quantityContract.map((line) => line.quantityNanos)).size).toBeGreaterThan(1);
  expect(topology.quantityContract.find((line) => line.componentId === "cloud_run.europe-west1.cpu")?.quantityNanos).toBe("2700000000000");
  expect(topology.topologySha256).toMatch(/^[a-f0-9]{64}$/);
});

test("rejects redirects, unrecognized official rates, wrong units, and uniform quantity contracts", async () => {
  const source = createOfficialPricingSources({
    now: () => 1_000_000,
    fetch: async () => new Response("redirect", { status: 302, headers: { location: "https://evil.example" } }),
    google: { selectors: [{ componentId: "cloud_run.europe-west1.cpu", provider: "cloud_run", serviceDisplayName: "Cloud Run", skuId: "RUN-CPU", region: "europe-west1", usageUnit: "seconds", unit: "worker-second" }] },
    adc: { async readAccessToken() { return "opaque-adc-token-canary-value"; } },
    workers: { modal: { cpuCores: 1, memoryGiB: 1, unit: "worker-second" }, fly: { preset: "shared-cpu-1x", memory: "256MB", unit: "worker-second" } },
  });
  await expect(source.google.readCatalog({ projectId: undefined, providers: ["cloud_run"] })).rejects.toThrow("OFFICIAL_SOURCE_RESPONSE_REJECTED");
  await expect(source.sources.readOfficialPricing({ provider: "modal" })).rejects.toThrow("OFFICIAL_SOURCE_RESPONSE_REJECTED");
});

test("aggregates component receipts into one family line with complete provenance", async () => {
  const topology = await deriveReleaseTopology(digest("b"));
  const now = () => 1_000_000;
  const googleComponents = topology.quantityContract.filter((component) => ["cloud_run", "gcs", "collector", "cloud_sql_postgres"].includes(component.provider));
  const catalog = createProductionLiveCostCatalog({
    now,
    quantityContract: topology.quantityContract.map((component) => ({ ...component, quantityNanos: BigInt(component.quantityNanos) })),
    google: { async readCatalog() {
      return { sourceId: "gcp-cloud-billing-catalog-v1", bytes: new TextEncoder().encode("gcp-components"), observedAtMs: 999_999, freshUntilMs: 1_060_000,
        quotes: googleComponents.map((component, index) => ({ provider: component.provider, componentId: component.componentId, skuId: `sku-${index}`, region: component.region, currency: "USD", unit: component.unit, priceMicros: index + 1 })) };
    } },
    sources: { async readOfficialPricing({ provider }) { return { sourceId: `${provider}-official-pricing`, bytes: new TextEncoder().encode(provider), observedAtMs: 999_999, freshUntilMs: 1_060_000,
      quotes: [{ provider, componentId: `${provider}.global`, skuId: `${provider}-official`, region: "global", currency: "USD", unit: "worker-100-seconds", priceMicros: 3 }] }; } },
    vertex: { async readVertexGeminiPrice() { return { sourceUrl: "https://cloud.google.com/model-garden/pricing" as const, bytes: new TextEncoder().encode("vertex"), observedAtMs: 999_999, freshUntilMs: 1_060_000, currency: "USD" as const, location: "global" as const, model: "gemini-4-argon" as const, effectiveFrom: "2026-10-13" as const, effectiveUntil: "2026-11-30" as const, inputMicrosPerMillion: 4_000_000 as const, cachedInputMicrosPerMillion: 200_000 as const, outputAndThoughtMicrosPerMillion: 20_000_000 as const }; } },
    fundingRailFees: { async readFeeFacts() { return [
      { provider: "cep8_lightning", sourceId: "operator-nwc-fee-contract", sourceDocumentSha256: digest("d"), quoteSha256: digest("e"), currency: "USD", unit: "operation", priceMicros: 1, observedAtMs: 999_999, freshUntilMs: 1_060_000 },
      { provider: "cashu", sourceId: "operator-cashu-fee-contract", sourceDocumentSha256: digest("f"), quoteSha256: digest("0"), currency: "USD", unit: "operation", priceMicros: 1, observedAtMs: 999_999, freshUntilMs: 1_060_000 },
    ]; } },
  });
  const facts = (await catalog.listPriceFacts({ providers: RELEASE_COST_FAMILIES })).map(value => PriceFactSchema.parse(value));
  const cloudRun = facts.find((fact) => fact.provider === "cloud_run");
  expect(cloudRun).toMatchObject({ components: [
    { componentId: "cloud_run.europe-west1.cpu", region: "europe-west1" },
    { componentId: "cloud_run.europe-west1.memory", region: "europe-west1" },
    { componentId: "cloud_run.us-central1.cpu", region: "us-central1" },
    { componentId: "cloud_run.us-central1.memory", region: "us-central1" },
  ] });
  const estimate = await createLiveCostEstimator({ catalog, now }).estimate({ topologySha256: topology.topologySha256,
    quantities: RELEASE_COST_FAMILIES.map((provider) => ({ provider, quantityNanos: 1_000_000_000n, headroomBasisPoints: 1_000 })),
    components: topology.quantityContract.map((component) => ({ ...component, quantityNanos: BigInt(component.quantityNanos) })),
  });
  expect(estimate.lines).toHaveLength(16);
  expect(estimate.lines.find((line) => line.provider === "cloud_run")).toMatchObject({ components: [
    { componentId: "cloud_run.europe-west1.cpu", skuId: "sku-0" },
    { componentId: "cloud_run.europe-west1.memory", skuId: "sku-1" },
    { componentId: "cloud_run.us-central1.cpu", skuId: "sku-2" },
    { componentId: "cloud_run.us-central1.memory", skuId: "sku-3" },
  ] });
  expect(estimate.lines.find(line => line.provider === "cloud_run")).toMatchObject({ baseMicros: 18_900, headroomMicros: 1_890, maximumMicros: 20_790 });
  await expect(createLiveCostEstimator({ catalog: { listPriceFacts: async () => facts.map((fact) => fact.provider === "cloud_run" && fact.components ? { ...fact, components: [...fact.components, fact.components[0]] } : fact) }, now }).estimate({ topologySha256: topology.topologySha256,
    quantities: RELEASE_COST_FAMILIES.map((provider) => ({ provider, quantityNanos: 1_000_000_000n, headroomBasisPoints: 1_000 })), components: topology.quantityContract.map((component) => ({ ...component, quantityNanos: BigInt(component.quantityNanos) })),
  })).rejects.toThrow("LIVE_COST_COMPONENT_COVERAGE_REQUIRED");
});

test("conservative certification ceilings remain distinct from exact user billing and bind every topology component", async () => {
  const topology = await deriveReleaseTopology(digest("c"));
  const now = () => 1_000_000;
  const components = topology.quantityContract.map((component) => ({ ...component, quantityNanos: BigInt(component.quantityNanos) }));
  const catalog = createCertificationBudgetCatalog({ quantityContract: components, now });
  const facts = (await catalog.listPriceFacts({ providers: RELEASE_COST_FAMILIES })).map(value => PriceFactSchema.parse(value));
  expect(facts).toHaveLength(16);
  expect(facts.every((fact) => (fact as { sourceId: string }).sourceId === "napplet-cvm-certification-budget-v1")).toBe(true);
  const estimate = await createLiveCostEstimator({ catalog, now }).estimate({
    topologySha256: topology.topologySha256,
    quantities: RELEASE_COST_FAMILIES.map((provider) => ({ provider, quantityNanos: 1_000_000_000n, headroomBasisPoints: 1_000 })),
    components,
  });
  expect(estimate.lines).toHaveLength(16);
  expect(estimate.maximumMicros).toBeGreaterThan(0);
  // The fixed policy now budgets all 1,000 admission samples and eight suites,
  // rather than a single 20-minute worker per provider.
  expect(estimate.maximumMicros).toBeLessThanOrEqual(12_000_000_000);
  expect(estimate.lines.find((line) => line.provider === "model")?.maximumMicros).toBeGreaterThan(estimate.lines.find((line) => line.provider === "cloud_run")!.maximumMicros);
});

const sha256 = (value: string | Uint8Array) => createHash("sha256").update(value).digest("hex");
const pin = (label: string) => sha256(label);

test("materializes create-only receipt-free preapproval bytes and remeasures every pin", async () => {
  const workspace = await mkdtemp(join(tmpdir(), "napplet-cvm-preapproval-"));
  try {
    const repositoryRoot = process.cwd();
    const factoryModule = resolve(repositoryRoot, "src/release/deployment/production-factory.ts");
    const factoryConfig = resolve(repositoryRoot, "src/release/deployment/factory.ts");
    const collectorPath = join(workspace, "collector-oci", `${pin("manifest")}.oci.tar`);
    await mkdir(join(workspace, "collector-oci"), { recursive: true });
    await writeFile(collectorPath, "exact-local-oci-layout");
    const input = {
      workspace,
      repositoryRoot,
      candidateId: pin("candidate"),
      source: { sourceRevision: "a".repeat(40), sourceSha256: pin("source") },
      topology: { candidateSha256: pin("candidate"), topologySha256: pin("topology") },
      catalog: { catalogSha256: pin("catalog"), topologySha256: pin("topology") },
      authorization: { authorizationRequestSha256: pin("request"), controllerStateSha256: pin("state"), effectPlanSha256: pin("effects"), providerScopesSha256: pin("scopes"), maximumAuthorizedCostMicros: 1, cleanupByMs: 1_000, expiresAtMs: 2_000 },
      publicSettings: { regions: ["europe-west1", "us-central1"] as [string, string], maximumRunDurationMs: 900_000, retentionDays: 30 },
      opaqueReferenceNames: ["cloud-run", "modal"],
      collector: { plannedRegistryReference: `registry.example/napplet-cvm/collector@sha256:${pin("manifest")}`, registryAvailability: "not_uploaded" as const, localOciManifestDigest: `sha256:${pin("manifest")}`, localOciConfigDigest: `sha256:${pin("config")}`, platform: { os: "linux" as const, architecture: "amd64" as const }, baseImage: `otel/opentelemetry-collector@sha256:${pin("base")}`, dockerfileSha256: pin("dockerfile"), collectorConfigSha256: pin("collector-config"), ociLayoutPath: collectorPath, ociLayoutSha256: sha256("exact-local-oci-layout") },
      factory: {
        root: repositoryRoot,
        modulePath: factoryModule,
        moduleSha256: sha256(await readFile(factoryModule)),
        configPath: factoryConfig,
        configSha256: sha256(await readFile(factoryConfig)),
      },
    };
    const first = await materializePreapproval(input);
    const second = await materializePreapproval(input);
    expect(first).toEqual(second);
    expect(first.artifactPath).toStartWith(workspace);
    expect(first.artifactSha256).toBe(sha256(await readFile(first.artifactPath)));
    expect(await verifyPreapprovalMaterialization(first)).toEqual(first);
    await expect(loadPreparedCollectorPreapproval({ workspace, candidateId: pin("candidate"), authorizationRequestSha256: pin("request") })).resolves.toEqual(first.collector);
    const artifact = await readFile(first.artifactPath, "utf8");
    for (const forbidden of ["receipt", "workerSelection", "evidence", "trust", "evaluator", "pass", "secret://"]) expect(artifact.toLowerCase()).not.toContain(forbidden.toLowerCase());
    expect(JSON.parse(artifact)).toMatchObject({ authorization: { authorizationRequestSha256: pin("request"), controllerStateSha256: pin("state"), effectPlanSha256: pin("effects"), providerScopesSha256: pin("scopes"), maximumAuthorizedCostMicros: 1, cleanupByMs: 1_000, expiresAtMs: 2_000 } });
    await writeFile(first.artifactPath, "{}\n");
    await expect(verifyPreapprovalMaterialization(first)).rejects.toThrow("PREAPPROVAL_ARTIFACT_MUTATED");
  } finally {
    await rm(workspace, { recursive: true, force: true });
  }
});

test("rejects authority-shaped inputs, cross-bound hashes, and paths outside the confined roots", async () => {
  const workspace = await mkdtemp(join(tmpdir(), "napplet-cvm-preapproval-"));
  try {
    const repositoryRoot = process.cwd();
    const modulePath = resolve(repositoryRoot, "src/release/deployment/production-factory.ts");
    const configPath = resolve(repositoryRoot, "src/release/deployment/factory.ts");
    const collectorPath = join(workspace, "collector-oci", `${pin("manifest")}.oci.tar`);
    await mkdir(join(workspace, "collector-oci"), { recursive: true });
    await writeFile(collectorPath, "exact-local-oci-layout");
    const input = {
      workspace, repositoryRoot, candidateId: pin("candidate"), source: { sourceRevision: "a".repeat(40), sourceSha256: pin("source") },
      topology: { candidateSha256: pin("candidate"), topologySha256: pin("topology") }, catalog: { catalogSha256: pin("catalog"), topologySha256: pin("topology") },
      authorization: { authorizationRequestSha256: pin("request"), controllerStateSha256: pin("state"), effectPlanSha256: pin("effects"), providerScopesSha256: pin("scopes"), maximumAuthorizedCostMicros: 1, cleanupByMs: 1_000, expiresAtMs: 2_000 },
      publicSettings: { regions: ["europe-west1", "us-central1"] as [string, string], maximumRunDurationMs: 900_000, retentionDays: 30 }, opaqueReferenceNames: ["modal"],
      collector: { plannedRegistryReference: `registry.example/napplet-cvm/collector@sha256:${pin("manifest")}`, registryAvailability: "not_uploaded" as const, localOciManifestDigest: `sha256:${pin("manifest")}`, localOciConfigDigest: `sha256:${pin("config")}`, platform: { os: "linux" as const, architecture: "amd64" as const }, baseImage: `otel/opentelemetry-collector@sha256:${pin("base")}`, dockerfileSha256: pin("dockerfile"), collectorConfigSha256: pin("collector-config"), ociLayoutPath: collectorPath, ociLayoutSha256: sha256("exact-local-oci-layout") },
      factory: { root: repositoryRoot, modulePath, moduleSha256: sha256(await readFile(modulePath)), configPath, configSha256: sha256(await readFile(configPath)) },
    };
    await expect(materializePreapproval({ ...input, authorizationReceiptSha256: pin("receipt") } as never)).rejects.toThrow("PREAPPROVAL_INPUT_REJECTED");
    await expect(materializePreapproval({ ...input, authorization: { ...input.authorization, expiresAtMs: input.authorization.cleanupByMs } })).rejects.toThrow("PREAPPROVAL_BINDING_REJECTED");
    await expect(materializePreapproval({ ...input, catalog: { ...input.catalog, topologySha256: pin("other") } })).rejects.toThrow("PREAPPROVAL_BINDING_REJECTED");
    await expect(materializePreapproval({ ...input, factory: { ...input.factory, modulePath: "/tmp/outside.ts" } })).rejects.toThrow("PREAPPROVAL_FACTORY_REJECTED");
  } finally {
    await rm(workspace, { recursive: true, force: true });
  }
});
