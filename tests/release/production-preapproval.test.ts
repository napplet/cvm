import { expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { createOfficialPricingSources } from "../../src/release/costs/official-sources";
import { materializePreapproval, verifyPreapprovalMaterialization } from "../../src/release/preapproval-materializer";
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

const sha256 = (value: string | Uint8Array) => createHash("sha256").update(value).digest("hex");
const pin = (label: string) => sha256(label);

test("materializes create-only receipt-free preapproval bytes and remeasures every pin", async () => {
  const workspace = await mkdtemp(join(tmpdir(), "napplet-cvm-preapproval-"));
  try {
    const repositoryRoot = process.cwd();
    const factoryModule = resolve(repositoryRoot, "src/release/deployment/production-factory.ts");
    const factoryConfig = resolve(repositoryRoot, "src/release/deployment/factory.ts");
    const input = {
      workspace,
      repositoryRoot,
      candidateId: pin("candidate"),
      source: { sourceRevision: "a".repeat(40), sourceSha256: pin("source") },
      topology: { candidateSha256: pin("candidate"), topologySha256: pin("topology") },
      catalog: { catalogSha256: pin("catalog"), topologySha256: pin("topology") },
      publicSettings: { regions: ["europe-west1", "us-central1"] as [string, string], maximumRunDurationMs: 900_000, retentionDays: 30 },
      opaqueReferenceNames: ["cloud-run", "modal"],
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
    const artifact = await readFile(first.artifactPath, "utf8");
    for (const forbidden of ["receipt", "workerSelection", "evidence", "trust", "evaluator", "pass", "secret://"]) expect(artifact.toLowerCase()).not.toContain(forbidden.toLowerCase());
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
    const input = {
      workspace, repositoryRoot, candidateId: pin("candidate"), source: { sourceRevision: "a".repeat(40), sourceSha256: pin("source") },
      topology: { candidateSha256: pin("candidate"), topologySha256: pin("topology") }, catalog: { catalogSha256: pin("catalog"), topologySha256: pin("topology") },
      publicSettings: { regions: ["europe-west1", "us-central1"] as [string, string], maximumRunDurationMs: 900_000, retentionDays: 30 }, opaqueReferenceNames: ["modal"],
      factory: { root: repositoryRoot, modulePath, moduleSha256: sha256(await readFile(modulePath)), configPath, configSha256: sha256(await readFile(configPath)) },
    };
    await expect(materializePreapproval({ ...input, authorizationReceiptSha256: pin("receipt") } as never)).rejects.toThrow("PREAPPROVAL_INPUT_REJECTED");
    await expect(materializePreapproval({ ...input, catalog: { ...input.catalog, topologySha256: pin("other") } })).rejects.toThrow("PREAPPROVAL_BINDING_REJECTED");
    await expect(materializePreapproval({ ...input, factory: { ...input.factory, modulePath: "/tmp/outside.ts" } })).rejects.toThrow("PREAPPROVAL_FACTORY_REJECTED");
  } finally {
    await rm(workspace, { recursive: true, force: true });
  }
});
