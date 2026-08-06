import { z } from "zod";
import { canonicalJson } from "../../promotion/schema";
import { RELEASE_COST_FAMILIES, type LiveCostCatalogPort } from "./live-estimator";
import type { ReleaseTopologyQuantity } from "../topology";

const DigestSchema = z.string().regex(/^[a-f0-9]{64}$/iu).transform((value) => value.toLowerCase());
const ProviderSchema = z.enum(RELEASE_COST_FAMILIES);
const PaidProviderSchema = z.enum(["cloud_run", "gcs", "collector", "cloud_sql_postgres", "modal", "fly", "cep8_lightning", "cashu", "model"]);
const SourceQuoteSchema = z.object({
  provider: PaidProviderSchema,
  currency: z.literal("USD"),
  unit: z.string().regex(/^[a-z][a-z0-9._/-]{1,63}$/u),
  priceMicros: z.number().int().positive().max(Number.MAX_SAFE_INTEGER),
}).strict();
const SourceSnapshotSchema = z.object({
  sourceId: z.string().regex(/^[a-z][a-z0-9._-]{2,127}$/u),
  bytes: z.instanceof(Uint8Array).refine((value) => value.byteLength > 0 && value.byteLength <= 1_000_000, "PRODUCTION_CATALOG_SOURCE_BYTES_INVALID"),
  observedAtMs: z.number().int().positive(),
  freshUntilMs: z.number().int().positive(),
  quotes: z.array(SourceQuoteSchema).min(1).max(16),
}).strict();

const GOOGLE_PROVIDERS = ["cloud_run", "gcs", "collector", "cloud_sql_postgres", "cep8_lightning", "cashu", "model"] as const;
const NON_BILLABLE_PROVIDERS = ["contextvm", "compatible_host", "signer", "promoted_cli", "upload", "owner_relay", "attestation_relay"] as const;
const PAID_PROVIDERS = ["cloud_run", "gcs", "collector", "cloud_sql_postgres", "modal", "fly", "cep8_lightning", "cashu", "model"] as const;

/** No concrete provider project is accepted here. Cloud Billing catalog reads are
 * public/read-only and must not select another account merely because it is accessible. */
export type GooglePublicCatalogPort = Readonly<{
  readCatalog(input: Readonly<{ projectId: undefined; providers: readonly typeof GOOGLE_PROVIDERS[number][] }>): Promise<unknown>;
}>;

/** Modal and Fly have no documented account-rate API. The caller reads the
 * official public bytes and this boundary verifies the exact observed bytes. */
export type OfficialPricingSourcePort = Readonly<{
  readOfficialPricing(input: Readonly<{ provider: "modal" | "fly" }>): Promise<unknown>;
}>;

export type ProductionLiveCostCatalogOptions = Readonly<{
  google: GooglePublicCatalogPort;
  sources: OfficialPricingSourcePort;
  /** Supplying the topology contract binds every source quote to the exact
   * hashed unit used by release authorization. Legacy callers remain blocked
   * from claiming topology binding until they pass this contract. */
  quantityContract?: readonly ReleaseTopologyQuantity[];
  now?: () => number;
}>;

async function sha256Bytes(bytes: Uint8Array): Promise<string> {
  const hash = await crypto.subtle.digest("SHA-256", bytes);
  return Array.from(new Uint8Array(hash), (byte) => byte.toString(16).padStart(2, "0")).join("");
}

async function sha256(value: unknown): Promise<string> {
  return sha256Bytes(new TextEncoder().encode(canonicalJson(value)));
}

function exactQuotes(snapshot: z.infer<typeof SourceSnapshotSchema>, providers: readonly typeof PAID_PROVIDERS[number][]): Map<typeof PAID_PROVIDERS[number], z.infer<typeof SourceQuoteSchema>> {
  const quotes = new Map(snapshot.quotes.map((quote) => [quote.provider, quote] as const));
  if (quotes.size !== snapshot.quotes.length || providers.some((provider) => !quotes.has(provider)) || [...quotes.keys()].some((provider) => !providers.includes(provider))) {
    throw new Error("PRODUCTION_CATALOG_COVERAGE_REQUIRED");
  }
  return quotes;
}

function assertFresh(snapshot: z.infer<typeof SourceSnapshotSchema>, nowMs: number): void {
  if (!Number.isSafeInteger(nowMs) || nowMs <= 0 || snapshot.observedAtMs > nowMs || snapshot.freshUntilMs <= nowMs || snapshot.freshUntilMs <= snapshot.observedAtMs) {
    throw new Error("PRODUCTION_CATALOG_STALE");
  }
}
function quantityByProvider(contract: readonly ReleaseTopologyQuantity[] | undefined): Map<string, ReleaseTopologyQuantity> | undefined {
  if (contract === undefined) return undefined;
  if (contract.length !== RELEASE_COST_FAMILIES.length || contract.some((line, index) => line.provider !== RELEASE_COST_FAMILIES[index] || line.quantityNanos <= 0n || !Number.isSafeInteger(line.headroomBasisPoints) || line.headroomBasisPoints < 0 || line.headroomBasisPoints > 10_000)
    || new Set(contract.map((line) => line.quantityNanos.toString())).size === 1) throw new Error("PRODUCTION_CATALOG_QUANTITY_CONTRACT_REJECTED");
  return new Map(contract.map((line) => [line.provider, line]));
}

async function nonBillableFact(provider: typeof NON_BILLABLE_PROVIDERS[number], nowMs: number) {
  const policy = Object.freeze({ version: 1, policy: "project-owned-non-billable", provider, priceMicros: 0, currency: "USD", unit: "operation" });
  const documentSha256 = await sha256(policy);
  return Object.freeze({
    provider,
    sourceId: "napplet-cvm-nonbillable-policy-v1",
    sourceDocumentSha256: documentSha256,
    quoteSha256: documentSha256,
    currency: "USD" as const,
    unit: "operation",
    priceMicros: 0,
    observedAtMs: nowMs,
    freshUntilMs: nowMs + 60 * 60 * 1000,
    status: "available" as const,
  });
}

/**
 * Creates the product catalog exclusively from current source snapshots.
 * It deliberately has no network/client construction path: callers may supply only
 * a schema-bounded public Catalog reader and byte-preserving official rate sources.
 */
export function createProductionLiveCostCatalog(options: ProductionLiveCostCatalogOptions): LiveCostCatalogPort {
  const now = options.now ?? Date.now;
  const quantities = quantityByProvider(options.quantityContract);
  return Object.freeze({
    async listPriceFacts(input: Readonly<{ providers: readonly string[] }>) {
      if (input.providers.length !== RELEASE_COST_FAMILIES.length || input.providers.some((provider, index) => provider !== RELEASE_COST_FAMILIES[index])) {
        throw new Error("PRODUCTION_CATALOG_COVERAGE_REQUIRED");
      }
      const nowMs = now();
      if (!Number.isSafeInteger(nowMs) || nowMs <= 0) throw new Error("PRODUCTION_CATALOG_TIME_INVALID");
      const [rawGoogle, rawModal, rawFly] = await Promise.all([
        options.google.readCatalog({ projectId: undefined, providers: GOOGLE_PROVIDERS }),
        options.sources.readOfficialPricing({ provider: "modal" }),
        options.sources.readOfficialPricing({ provider: "fly" }),
      ]);
      const google = SourceSnapshotSchema.parse(rawGoogle);
      const modal = SourceSnapshotSchema.parse(rawModal);
      const fly = SourceSnapshotSchema.parse(rawFly);
      assertFresh(google, nowMs);
      assertFresh(modal, nowMs);
      assertFresh(fly, nowMs);
      const googleQuotes = exactQuotes(google, GOOGLE_PROVIDERS);
      const modalQuotes = exactQuotes(modal, ["modal"]);
      const flyQuotes = exactQuotes(fly, ["fly"]);
      const snapshots = new Map<typeof PAID_PROVIDERS[number], z.infer<typeof SourceSnapshotSchema>>([
        ...GOOGLE_PROVIDERS.map((provider) => [provider, google] as const),
        ["modal", modal], ["fly", fly],
      ]);
      const quotes = new Map<typeof PAID_PROVIDERS[number], z.infer<typeof SourceQuoteSchema>>([
        ...googleQuotes, ...modalQuotes, ...flyQuotes,
      ]);
      const facts = await Promise.all(RELEASE_COST_FAMILIES.map(async (provider) => {
        if ((NON_BILLABLE_PROVIDERS as readonly string[]).includes(provider)) return nonBillableFact(provider as typeof NON_BILLABLE_PROVIDERS[number], nowMs);
        const paidProvider = ProviderSchema.parse(provider) as typeof PAID_PROVIDERS[number];
        const snapshot = snapshots.get(paidProvider);
        const quote = quotes.get(paidProvider);
        if (!snapshot || !quote) throw new Error("PRODUCTION_CATALOG_COVERAGE_REQUIRED");
        const quantity = quantities?.get(paidProvider);
        if (quantity && quantity.unit !== quote.unit) throw new Error("PRODUCTION_CATALOG_UNIT_MISMATCH");
        const sourceDocumentSha256 = await sha256Bytes(snapshot.bytes);
        return Object.freeze({
          provider: paidProvider,
          sourceId: snapshot.sourceId,
          sourceDocumentSha256,
          quoteSha256: await sha256({ sourceDocumentSha256, quote, ...(quantity ? { quantity: { unit: quantity.unit, quantityNanos: quantity.quantityNanos.toString(), headroomBasisPoints: quantity.headroomBasisPoints } } : {}) }),
          currency: quote.currency,
          unit: quote.unit,
          priceMicros: quote.priceMicros,
          observedAtMs: snapshot.observedAtMs,
          freshUntilMs: snapshot.freshUntilMs,
          status: "available" as const,
        });
      }));
      if (facts.some((fact, index) => fact.provider !== RELEASE_COST_FAMILIES[index])) throw new Error("PRODUCTION_CATALOG_COVERAGE_REQUIRED");
      return Object.freeze(facts);
    },
  });
}

export const PRODUCTION_NON_BILLABLE_COST_POLICY_SHA256: Promise<string> = sha256({
  version: 1,
  policy: "project-owned-non-billable",
  providers: NON_BILLABLE_PROVIDERS,
});
