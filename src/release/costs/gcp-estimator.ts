import { z } from "zod";
import { canonicalJson } from "../../promotion/schema";

const DigestSchema = z.string().regex(/^[a-f0-9]{64}$/iu).transform((value) => value.toLowerCase());
const ComponentSchema = z.enum(["cloud_run", "collector", "cloud_sql", "storage", "network", "retention"]);
const CurrencySchema = z.literal("USD");
const CatalogRecordSchema = z.object({
  skuId: z.string().regex(/^[a-z][a-z0-9._-]{1,127}$/u),
  serviceId: z.string().regex(/^[a-z][a-z0-9._-]{1,127}$/u),
  region: z.string().regex(/^[a-z0-9-]{2,64}$/u),
  currencyCode: z.string().regex(/^[A-Z]{3}$/u),
  units: z.string().regex(/^\d+$/u),
  nanos: z.number().int().min(0).max(999_999_999),
  observedAtMs: z.number().int().positive(),
  freshUntilMs: z.number().int().positive(),
}).strict();
const QuantitySchema = z.object({
  component: ComponentSchema,
  skuId: z.string().regex(/^[a-z][a-z0-9._-]{1,127}$/u),
  region: z.string().regex(/^[a-z0-9-]{2,64}$/u),
  /** Number of billable units scaled by 1e9, preserving fractional quantities exactly. */
  quantityNanos: z.bigint().positive(),
}).strict();
const EstimateInputSchema = z.object({
  topologySha256: DigestSchema,
  catalogId: z.string().regex(/^[a-z][a-z0-9._-]{2,127}$/u),
  sourceId: z.string().regex(/^[a-z][a-z0-9._-]{2,127}$/u),
  regions: z.tuple([z.string().regex(/^[a-z0-9-]{2,64}$/u), z.string().regex(/^[a-z0-9-]{2,64}$/u)]),
  durationMs: z.number().int().positive().max(86_400_000),
  cleanupByMs: z.number().int().positive(),
  evidenceRetentionDays: z.number().int().positive().max(3_650),
  artifactRetentionDays: z.number().int().positive().max(3_650),
  headroomBasisPoints: z.number().int().min(0).max(10_000),
  quantities: z.array(QuantitySchema).length(6),
}).strict();

const COMPONENTS = ["cloud_run", "collector", "cloud_sql", "storage", "network", "retention"] as const;
const NANOS_PER_UNIT = 1_000_000_000n;
const NANOS_PER_MICRO = 1_000n;
const MAX_MICROS = BigInt(Number.MAX_SAFE_INTEGER);

export type GcpCatalogPort = Readonly<{
  /** A read-only Cloud Billing Catalog seam. It receives no credentials from this module. */
  listSkus(input: Readonly<{ catalogId: string; skuIds: readonly string[] }>): Promise<readonly unknown[]>;
}>;

export type GcpCostEstimateInput = z.input<typeof EstimateInputSchema>;

function ceilDivide(numerator: bigint, denominator: bigint): bigint {
  return (numerator + denominator - 1n) / denominator;
}

function checkedMicros(value: bigint): number {
  if (value < 0n || value > MAX_MICROS) throw new Error("GCP_COST_OVERFLOW");
  return Number(value);
}

async function sha256(value: unknown): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(canonicalJson(value)));
  return Array.from(new Uint8Array(digest), (byte) => byte.toString(16).padStart(2, "0")).join("");
}

function exactQuantities(input: z.infer<typeof EstimateInputSchema>) {
  const components = input.quantities.map((quantity) => quantity.component);
  if (new Set(components).size !== COMPONENTS.length || COMPONENTS.some((component) => !components.includes(component))) throw new Error("GCP_COST_TOPOLOGY_INVALID");
  if (new Set(input.regions).size !== input.regions.length || input.cleanupByMs <= 0) throw new Error("GCP_COST_TOPOLOGY_INVALID");
  // Caller order is the canonical topology-effect order and is therefore preserved
  // in the cost envelope rather than silently reordering a receipt-bound request.
  return input.quantities;
}

/**
 * Converts an injected Cloud Billing Catalog response to a finite, authorization-ready
 * USD maximum. The adapter itself has no provider SDK, command, credential, or network path.
 */
export function createGcpCostEstimator(options: Readonly<{ port: GcpCatalogPort; now?: () => number }>) {
  const now = options.now ?? Date.now;
  return Object.freeze({
    async estimate(input: GcpCostEstimateInput) {
      const parsed = EstimateInputSchema.parse(input);
      const quantities = exactQuantities(parsed);
      const nowMs = now();
      if (!Number.isSafeInteger(nowMs) || parsed.cleanupByMs <= nowMs || parsed.cleanupByMs > nowMs + parsed.durationMs) throw new Error("GCP_COST_CLEANUP_UNBOUNDED");

      const raw = await options.port.listSkus({ catalogId: parsed.catalogId, skuIds: quantities.map((quantity) => quantity.skuId) });
      const records = raw.map((record) => CatalogRecordSchema.parse(record));
      const bySku = new Map(records.map((record) => [record.skuId, record]));
      if (bySku.size !== records.length || quantities.some((quantity) => !bySku.has(quantity.skuId))) throw new Error("GCP_COST_CATALOG_MISSING_SKU");

      const lines = quantities.map((quantity) => {
        const record = bySku.get(quantity.skuId)!;
        if (record.region !== quantity.region) throw new Error("GCP_COST_CATALOG_REGION_INVALID");
        if (record.currencyCode !== CurrencySchema.value) throw new Error("GCP_COST_CURRENCY_INVALID");
        if (record.observedAtMs > nowMs || record.freshUntilMs <= nowMs || record.freshUntilMs <= record.observedAtMs) throw new Error("GCP_COST_CATALOG_STALE");
        const priceNanos = BigInt(record.units) * NANOS_PER_UNIT + BigInt(record.nanos);
        const costMicros = checkedMicros(ceilDivide(priceNanos * quantity.quantityNanos, NANOS_PER_UNIT * NANOS_PER_MICRO));
        return Object.freeze({ component: quantity.component, skuId: record.skuId, serviceId: record.serviceId, region: record.region, priceUnits: record.units, priceNanos: record.nanos, quantityNanos: quantity.quantityNanos, costMicros, observedAtMs: record.observedAtMs, freshUntilMs: record.freshUntilMs });
      });
      const subtotalMicros = lines.reduce((total, line) => checkedMicros(BigInt(total) + BigInt(line.costMicros)), 0);
      const headroomMicros = checkedMicros(ceilDivide(BigInt(subtotalMicros) * BigInt(parsed.headroomBasisPoints), 10_000n));
      const maximumMicros = checkedMicros(BigInt(subtotalMicros) + BigInt(headroomMicros));
      const observedAtMs = Math.max(...lines.map((line) => line.observedAtMs));
      const freshUntilMs = Math.min(...lines.map((line) => line.freshUntilMs));
      const sourceSha256 = await sha256({ version: 1, catalogId: parsed.catalogId, sourceId: parsed.sourceId, topologySha256: parsed.topologySha256, lines: lines.map(({ quantityNanos, ...line }) => ({ ...line, quantityNanos: quantityNanos.toString() })) });
      return Object.freeze({
        version: 1 as const,
        currency: "USD" as const,
        catalogId: parsed.catalogId,
        sourceId: parsed.sourceId,
        sourceSha256,
        topologySha256: parsed.topologySha256,
        regions: parsed.regions,
        observedAtMs,
        freshUntilMs,
        durationMs: parsed.durationMs,
        cleanupByMs: parsed.cleanupByMs,
        evidenceRetentionDays: parsed.evidenceRetentionDays,
        artifactRetentionDays: parsed.artifactRetentionDays,
        headroomBasisPoints: parsed.headroomBasisPoints,
        subtotalMicros,
        headroomMicros,
        maximumMicros,
        lines,
      });
    },
  });
}
