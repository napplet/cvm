import { z } from "zod";
import { canonicalJson } from "../../promotion/schema";

export const RELEASE_COST_FAMILIES = Object.freeze([
  "cloud_run", "gcs", "collector", "cloud_sql_postgres", "modal", "fly", "contextvm", "cep8_lightning", "cashu", "model", "compatible_host", "signer", "promoted_cli", "upload", "owner_relay", "attestation_relay",
] as const);

const ProviderSchema = z.enum(RELEASE_COST_FAMILIES);
const DigestSchema = z.string().regex(/^[a-f0-9]{64}$/iu).transform((value) => value.toLowerCase());
const PriceFactSchema = z.object({
  provider: ProviderSchema,
  sourceId: z.string().regex(/^[a-z][a-z0-9._-]{2,127}$/u),
  sourceDocumentSha256: DigestSchema,
  quoteSha256: DigestSchema,
  currency: z.string().regex(/^[A-Z]{3}$/u),
  unit: z.string().regex(/^[a-z][a-z0-9._/-]{1,63}$/u),
  priceMicros: z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER),
  observedAtMs: z.number().int().positive(),
  freshUntilMs: z.number().int().positive(),
  status: z.literal("available"),
}).strict();
const QuantitySchema = z.object({ provider: ProviderSchema, quantityNanos: z.bigint().positive(), headroomBasisPoints: z.number().int().min(0).max(10_000) }).strict();
const EstimateInputSchema = z.object({ topologySha256: DigestSchema, quantities: z.array(QuantitySchema).length(RELEASE_COST_FAMILIES.length) }).strict();
const ActualReceiptSchema = z.object({ provider: ProviderSchema, operationId: z.string().regex(/^[a-z][a-z0-9_-]{2,127}$/u), status: z.literal("observed"), actualCostMicros: z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER) }).strict();

const NANO = 1_000_000_000n;
const MAX = BigInt(Number.MAX_SAFE_INTEGER);
function checked(value: bigint): number { if (value < 0n || value > MAX) throw new Error("LIVE_COST_OVERFLOW"); return Number(value); }
function ceil(numerator: bigint, denominator: bigint): bigint { return (numerator + denominator - 1n) / denominator; }
async function sha256(value: unknown): Promise<string> { const hash = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(canonicalJson(value))); return Array.from(new Uint8Array(hash), (byte) => byte.toString(16).padStart(2, "0")).join(""); }

export type LiveCostCatalogPort = Readonly<{ listPriceFacts(input: Readonly<{ providers: readonly string[] }>): Promise<readonly unknown[]> }>;

function exactCoverage<T extends { provider: string }>(records: readonly T[], code: string): readonly T[] {
  if (records.length !== RELEASE_COST_FAMILIES.length || records.some((record, index) => record.provider !== RELEASE_COST_FAMILIES[index])) throw new Error(code);
  return records;
}

export function createLiveCostEstimator(options: Readonly<{ catalog: LiveCostCatalogPort; now?: () => number }>) {
  const now = options.now ?? Date.now;
  return Object.freeze({
    async estimate(input: unknown) {
      const parsed = EstimateInputSchema.parse(input);
      const quantities = exactCoverage(parsed.quantities, "LIVE_COST_QUANTITY_COVERAGE_REQUIRED");
      const nowMs = now();
      if (!Number.isSafeInteger(nowMs) || nowMs <= 0) throw new Error("LIVE_COST_TIME_INVALID");
      const records = exactCoverage((await options.catalog.listPriceFacts({ providers: RELEASE_COST_FAMILIES })).map((value) => PriceFactSchema.parse(value)), "LIVE_COST_COVERAGE_REQUIRED");
      const lines = records.map((record, index) => {
        const quantity = quantities[index]!;
        if (record.provider !== quantity.provider || record.currency !== "USD") throw new Error("LIVE_COST_CURRENCY_OR_ORDER_INVALID");
        if (record.observedAtMs > nowMs || record.freshUntilMs <= nowMs || record.freshUntilMs <= record.observedAtMs) throw new Error("LIVE_COST_FACT_STALE");
        const baseMicros = checked(ceil(BigInt(record.priceMicros) * quantity.quantityNanos, NANO));
        const headroomMicros = checked(ceil(BigInt(baseMicros) * BigInt(quantity.headroomBasisPoints), 10_000n));
        return Object.freeze({ provider: record.provider, sourceId: record.sourceId, sourceDocumentSha256: record.sourceDocumentSha256, quoteSha256: record.quoteSha256, currency: "USD" as const, unit: record.unit, quantityNanos: quantity.quantityNanos, observedAtMs: record.observedAtMs, freshUntilMs: record.freshUntilMs, baseMicros, headroomBasisPoints: quantity.headroomBasisPoints, headroomMicros, maximumMicros: checked(BigInt(baseMicros) + BigInt(headroomMicros)) });
      });
      const subtotalMicros = lines.reduce((total, line) => checked(BigInt(total) + BigInt(line.baseMicros)), 0);
      const maximumMicros = lines.reduce((total, line) => checked(BigInt(total) + BigInt(line.maximumMicros)), 0);
      return Object.freeze({ version: 1 as const, currency: "USD" as const, topologySha256: parsed.topologySha256, observedAtMs: Math.max(...lines.map((line) => line.observedAtMs)), freshUntilMs: Math.min(...lines.map((line) => line.freshUntilMs)), subtotalMicros, maximumMicros, sourceSha256: await sha256({ topologySha256: parsed.topologySha256, lines: lines.map(({ quantityNanos, ...line }) => ({ ...line, quantityNanos: quantityNanos.toString() })) }), lines });
    },
    reconcileActualCosts(input: Readonly<{ estimate: { lines: readonly { provider: typeof RELEASE_COST_FAMILIES[number]; maximumMicros: number }[]; maximumMicros: number }; receipts: readonly unknown[] }>) {
      const lines = exactCoverage(input.estimate.lines, "ACTUAL_COST_ESTIMATE_COVERAGE_REQUIRED");
      const receipts = input.receipts.map((receipt) => ActualReceiptSchema.safeParse(receipt));
      if (receipts.some((receipt) => !receipt.success)) return Object.freeze({ status: "blocked" as const, reasonCode: "ACTUAL_COST_COVERAGE_REQUIRED" as const });
      const actual = receipts.map((receipt) => receipt.data);
      if (actual.length !== RELEASE_COST_FAMILIES.length || actual.some((receipt, index) => receipt.provider !== RELEASE_COST_FAMILIES[index]) || new Set(actual.map((receipt) => receipt.operationId)).size !== actual.length) return Object.freeze({ status: "blocked" as const, reasonCode: "ACTUAL_COST_COVERAGE_REQUIRED" as const });
      const total = actual.reduce((sum, receipt, index) => {
        if (receipt.actualCostMicros > lines[index]!.maximumMicros) return -1;
        return sum < 0 ? sum : sum + receipt.actualCostMicros;
      }, 0);
      if (!Number.isSafeInteger(total) || total < 0 || total > input.estimate.maximumMicros) return Object.freeze({ status: "blocked" as const, reasonCode: "ACTUAL_COST_BOUND_EXCEEDED" as const });
      return Object.freeze({ status: "settled" as const, actualMicros: total });
    },
  });
}
