import { z } from "zod";
import { canonicalJson } from "../../promotion/schema";
import { RELEASE_COST_FAMILIES, type LiveCostCatalogPort } from "./live-estimator";
import type { ReleaseTopologyQuantity } from "../topology";
import type { VertexGeminiPriceObservation } from "./official-sources";
import { OpenAiResponsesRateSnapshotSchema, type OpenAiResponsesRateSnapshot } from "./non-google-cost-bound";

const DigestSchema = z.string().regex(/^[a-f0-9]{64}$/iu).transform((value) => value.toLowerCase());
const ProviderSchema = z.enum(RELEASE_COST_FAMILIES);
const PaidProviderSchema = z.enum(["cloud_run", "gcs", "collector", "cloud_sql_postgres", "modal", "fly", "model"]);
const SourceQuoteSchema = z.object({ provider: PaidProviderSchema, componentId: z.string().regex(/^[a-z][a-z0-9._-]{2,127}$/u).optional(), skuId: z.string().regex(/^[A-Za-z0-9._-]{2,127}$/u).optional(), region: z.string().regex(/^[a-z][a-z0-9-]{2,63}$/u).optional(), currency: z.literal("USD"), unit: z.string().regex(/^[a-z][a-z0-9._/-]{1,63}$/u), priceMicros: z.number().int().positive().max(Number.MAX_SAFE_INTEGER), priceNanos: z.string().regex(/^\d+$/u).optional() }).strict().superRefine((value, context) => { if (value.priceNanos !== undefined && BigInt(value.priceNanos) <= 0n) context.addIssue({ code: "custom", message: "PRODUCTION_CATALOG_PRICE_INVALID" }); });
const SourceSnapshotSchema = z.object({ sourceId: z.string().regex(/^[a-z][a-z0-9._-]{2,127}$/u), bytes: z.instanceof(Uint8Array).refine((value) => value.byteLength > 0 && value.byteLength <= 8 * 1024 * 1024, "PRODUCTION_CATALOG_SOURCE_BYTES_INVALID"), observedAtMs: z.number().int().positive(), freshUntilMs: z.number().int().positive(), quotes: z.array(SourceQuoteSchema).min(1).max(64) }).strict();
/** Funding rails are capital custody and provider-fee arrangements, not Google
 * Cloud SKUs. They stay in the effect inventory but may not be smuggled into
 * a cloud price request or represented by a made-up zero vendor quote. */
const GOOGLE_PROVIDERS = ["cloud_run", "gcs", "collector", "cloud_sql_postgres"] as const;
const NON_BILLABLE_PROVIDERS = ["contextvm", "compatible_host", "signer", "promoted_cli", "upload", "owner_relay", "attestation_relay"] as const;
const FUNDING_FEE_PROVIDERS = ["cep8_lightning", "cashu"] as const;
const PAID_PROVIDERS = ["cloud_run", "gcs", "collector", "cloud_sql_postgres", "modal", "fly", "model"] as const;
type Quote = z.infer<typeof SourceQuoteSchema>;
type Snapshot = z.infer<typeof SourceSnapshotSchema>;

/** Catalog access has no project parameter and therefore no account selection path. */
export type GooglePublicCatalogPort = Readonly<{ readCatalog(input: Readonly<{ projectId: undefined; providers: readonly typeof GOOGLE_PROVIDERS[number][] }>): Promise<unknown> }>;
export type OfficialPricingSourcePort = Readonly<{ readOfficialPricing(input: Readonly<{ provider: "modal" | "fly" }>): Promise<unknown> }>;
export type VertexModelPricePort = Readonly<{ readVertexGeminiPrice(): Promise<VertexGeminiPriceObservation> }>;
const FundingFeeFactSchema = z.object({ provider: z.enum(FUNDING_FEE_PROVIDERS), sourceId: z.string().regex(/^[a-z][a-z0-9._-]{2,127}$/u), sourceDocumentSha256: DigestSchema, quoteSha256: DigestSchema, currency: z.literal("USD"), unit: z.string().regex(/^[a-z][a-z0-9._/-]{1,63}$/u), priceMicros: z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER), priceNanos: z.string().regex(/^\d+$/u).optional(), observedAtMs: z.number().int().positive(), freshUntilMs: z.number().int().positive() }).strict();
/** Rail fees are account/mint/route-specific and do not have a Cloud SKU.
 * The funding composition must provide a source-attributed current fee quote;
 * absence is an approval blocker, never a fabricated zero-cost assumption. */
export type FundingRailFeePort = Readonly<{ readFeeFacts(): Promise<readonly unknown[]> }>;
export type ProductionLiveCostCatalogOptions = Readonly<{ google: GooglePublicCatalogPort; sources: OfficialPricingSourcePort; vertex: VertexModelPricePort; fundingRailFees?: FundingRailFeePort; quantityContract?: readonly ReleaseTopologyQuantity[]; now?: () => number }>;
/** Versioned successor seam. It cannot feed the historic sixteen-family
 * estimator, preserving existing catalog hashes and readers. */
export type NonGoogleModelCostCatalogPort = Readonly<{ readModelRate(): Promise<OpenAiResponsesRateSnapshot> }>;
export function createNonGoogleModelCostCatalog(input: Readonly<{ rates: Readonly<{ readOpenAiResponsesRate(): Promise<unknown> }>; now?: () => number }>): NonGoogleModelCostCatalogPort {
  const now = input.now ?? Date.now;
  return Object.freeze({
    async readModelRate() {
      const rate = OpenAiResponsesRateSnapshotSchema.parse(await input.rates.readOpenAiResponsesRate());
      const at = now();
      if (!Number.isSafeInteger(at) || at <= 0 || rate.observedAtMs > at || rate.freshUntilMs <= at || rate.freshUntilMs <= rate.observedAtMs) throw new Error("NON_GOOGLE_MODEL_PRICE_HELD");
      return Object.freeze({ ...rate });
    },
  });
}

async function sha256Bytes(bytes: Uint8Array): Promise<string> { const hash = await crypto.subtle.digest("SHA-256", new Uint8Array(bytes).buffer); return Array.from(new Uint8Array(hash), (byte) => byte.toString(16).padStart(2, "0")).join(""); }
async function sha256(value: unknown): Promise<string> { return sha256Bytes(new TextEncoder().encode(canonicalJson(value))); }
function assertFresh(snapshot: Snapshot, nowMs: number): void { if (!Number.isSafeInteger(nowMs) || nowMs <= 0 || snapshot.observedAtMs > nowMs || snapshot.freshUntilMs <= nowMs || snapshot.freshUntilMs <= snapshot.observedAtMs) throw new Error("PRODUCTION_CATALOG_STALE"); }
function exactLegacyQuotes(snapshot: Snapshot, providers: readonly typeof PAID_PROVIDERS[number][]): Map<typeof PAID_PROVIDERS[number], Quote> { const quotes = new Map(snapshot.quotes.map((quote) => [quote.provider, quote] as const)); if (quotes.size !== snapshot.quotes.length || providers.some((provider) => !quotes.has(provider)) || [...quotes.keys()].some((provider) => !providers.includes(provider))) throw new Error("PRODUCTION_CATALOG_COVERAGE_REQUIRED"); return quotes; }
function componentsByProvider(contract: readonly ReleaseTopologyQuantity[] | undefined): Map<string, readonly ReleaseTopologyQuantity[]> | undefined {
  if (contract === undefined) return undefined;
  if (contract.length < RELEASE_COST_FAMILIES.length || new Set(contract.map((component) => component.componentId)).size !== contract.length || contract.some((component) => !RELEASE_COST_FAMILIES.includes(component.provider) || component.quantityNanos <= 0n || !/^[a-z][a-z0-9._-]{2,127}$/u.test(component.componentId) || !/^[a-z][a-z0-9-]{2,63}$/u.test(component.region) || !Number.isSafeInteger(component.headroomBasisPoints) || component.headroomBasisPoints < 0 || component.headroomBasisPoints > 10_000)) throw new Error("PRODUCTION_CATALOG_QUANTITY_CONTRACT_REJECTED");
  const result = new Map<string, ReleaseTopologyQuantity[]>(); for (const component of contract) result.set(component.provider, [...(result.get(component.provider) ?? []), component]);
  if (RELEASE_COST_FAMILIES.some((provider) => result.get(provider)?.length === undefined)) throw new Error("PRODUCTION_CATALOG_QUANTITY_CONTRACT_REJECTED");
  return new Map([...result].map(([provider, components]) => [provider, Object.freeze(components)]));
}
async function nonBillableFact(provider: typeof NON_BILLABLE_PROVIDERS[number], nowMs: number, components?: readonly ReleaseTopologyQuantity[]) {
  const policy = Object.freeze({ version: 1, policy: "project-owned-non-billable", provider, priceMicros: 0, currency: "USD", unit: "operation" }); const sourceDocumentSha256 = await sha256(policy);
  const provenance = components?.map((component) => Object.freeze({ componentId: component.componentId, skuId: "project-owned", region: component.region, unit: component.unit, priceMicros: 0, quantityNanos: component.quantityNanos.toString(), headroomBasisPoints: component.headroomBasisPoints, sourceDocumentSha256 }));
  return Object.freeze({ provider, sourceId: "napplet-cvm-nonbillable-policy-v1", sourceDocumentSha256, quoteSha256: await sha256({ sourceDocumentSha256, provenance }), currency: "USD" as const, unit: "operation", priceMicros: 0, observedAtMs: nowMs, freshUntilMs: nowMs + 60 * 60 * 1000, status: "available" as const, ...(provenance ? { components: provenance } : {}) });
}
function familyComponents(provider: typeof PAID_PROVIDERS[number], snapshot: Snapshot, contract: readonly ReleaseTopologyQuantity[]): readonly Quote[] {
  const expected = new Map(contract.map((component) => [component.componentId, component]));
  const actual = snapshot.quotes.filter((quote) => quote.provider === provider);
  /* A regional service can legitimately publish one SKU usable in multiple
   * deployment regions. Component identity is the authorization key; a SKU
   * remains retained as provenance without being an artificial unique key. */
  if (actual.length !== expected.size || actual.some((quote) => !quote.componentId || !quote.skuId || !quote.region || !expected.has(quote.componentId) || expected.get(quote.componentId)!.region !== quote.region || expected.get(quote.componentId)!.unit !== quote.unit) || new Set(actual.map((quote) => quote.componentId)).size !== actual.length) throw new Error("PRODUCTION_CATALOG_COMPONENT_COVERAGE_REQUIRED");
  return Object.freeze(contract.map((component) => actual.find((quote) => quote.componentId === component.componentId)!));
}
function fundingFeeFacts(raw: readonly unknown[], nowMs: number, components: Map<string, readonly ReleaseTopologyQuantity[]> | undefined) {
  const parsed = raw.map((value) => FundingFeeFactSchema.parse(value));
  if (parsed.length !== FUNDING_FEE_PROVIDERS.length || parsed.some((value, index) => value.provider !== FUNDING_FEE_PROVIDERS[index])) throw new Error("FUNDING_RAIL_FEE_CONTRACT_REQUIRED");
  return parsed.map((fact) => {
    if (fact.observedAtMs > nowMs || fact.freshUntilMs <= nowMs || fact.freshUntilMs <= fact.observedAtMs) throw new Error("FUNDING_RAIL_FEE_CONTRACT_STALE");
    const topology = components?.get(fact.provider);
    if (!topology) return Object.freeze({ ...fact, status: "available" as const });
    if (topology.length !== 1) throw new Error("FUNDING_RAIL_FEE_CONTRACT_REQUIRED");
    const component = topology[0]!;
    return Object.freeze({ ...fact, status: "available" as const, components: Object.freeze([{ componentId: component.componentId, skuId: `fee-contract-${fact.provider}`, region: component.region, unit: component.unit, priceMicros: fact.priceMicros, ...(fact.priceNanos === undefined ? {} : { priceNanos: fact.priceNanos }), quantityNanos: component.quantityNanos.toString(), headroomBasisPoints: component.headroomBasisPoints, sourceDocumentSha256: fact.sourceDocumentSha256 }]) });
  });
}

function vertexSnapshot(observation: VertexGeminiPriceObservation): Snapshot {
  const priceNanos = (microsPerMillion: number): string => (BigInt(microsPerMillion) * 10n * 1_000n).toString();
  /* The topology has separate non-cached-input and combined-output/thought
   * components. Cached input remains captured in the model snapshot and is
   * used only for exact receipt reconciliation; it cannot lower a maximum. */
  const quotes: readonly Quote[] = [
    { provider: "model", componentId: "model.global.input", skuId: "gemini-4-argon-global-input", region: observation.location, currency: "USD", unit: "ten-million-tokens", priceMicros: observation.inputMicrosPerMillion * 10, priceNanos: priceNanos(observation.inputMicrosPerMillion) },
    { provider: "model", componentId: "model.global.output-thought", skuId: "gemini-4-argon-global-output-thought", region: observation.location, currency: "USD", unit: "ten-million-tokens", priceMicros: observation.outputAndThoughtMicrosPerMillion * 10, priceNanos: priceNanos(observation.outputAndThoughtMicrosPerMillion) },
  ];
  return { sourceId: "vertex-gemini-4-argon-official-pricing", bytes: new Uint8Array(observation.bytes), observedAtMs: observation.observedAtMs, freshUntilMs: observation.freshUntilMs, quotes: [...quotes] };
}

/** Builds sixteen stable family facts. When a topology contract is supplied,
 * every fact retains ordered one-to-one component provenance for recomputation. */
export function createProductionLiveCostCatalog(options: ProductionLiveCostCatalogOptions): LiveCostCatalogPort {
  const now = options.now ?? Date.now; const quantities = componentsByProvider(options.quantityContract);
  return Object.freeze({
    async listPriceFacts(input: Readonly<{ providers: readonly string[] }>) {
      if (input.providers.length !== RELEASE_COST_FAMILIES.length || input.providers.some((provider, index) => provider !== RELEASE_COST_FAMILIES[index])) throw new Error("PRODUCTION_CATALOG_COVERAGE_REQUIRED");
      if (!options.fundingRailFees) throw new Error("FUNDING_RAIL_FEE_CONTRACT_REQUIRED");
      const [rawGoogle, rawModal, rawFly, rawVertex, rawFundingFees] = await Promise.all([options.google.readCatalog({ projectId: undefined, providers: GOOGLE_PROVIDERS }), options.sources.readOfficialPricing({ provider: "modal" }), options.sources.readOfficialPricing({ provider: "fly" }), options.vertex.readVertexGeminiPrice(), options.fundingRailFees.readFeeFacts()]);
      /* Capture the evaluation instant after asynchronous source reads. A
       * source observes itself at the end of its bounded fetch; sampling here
       * before that work made every real-time snapshot look future-dated. */
      const nowMs = now(); if (!Number.isSafeInteger(nowMs) || nowMs <= 0) throw new Error("PRODUCTION_CATALOG_TIME_INVALID");
      const google = SourceSnapshotSchema.parse(rawGoogle); const modal = SourceSnapshotSchema.parse(rawModal); const fly = SourceSnapshotSchema.parse(rawFly); const vertex = vertexSnapshot(rawVertex); assertFresh(google, nowMs); assertFresh(modal, nowMs); assertFresh(fly, nowMs); assertFresh(vertex, nowMs);
      const snapshots = new Map<typeof PAID_PROVIDERS[number], Snapshot>([...GOOGLE_PROVIDERS.map((provider) => [provider, google] as const), ["modal", modal], ["fly", fly], ["model", vertex]]);
      const railFees = new Map(fundingFeeFacts(rawFundingFees, nowMs, quantities).map((fact) => [fact.provider, fact] as const));
      /* Legacy consumers without a component contract still receive a single
       * model fact. Derive it from quoted model units rather than pretending a
       * product certification ceiling is a vendor price. */
      const legacyModel = vertex.quotes.reduce((total, quote) => total + quote.priceMicros, 0);
      const legacyQuotes = quantities === undefined ? new Map<typeof PAID_PROVIDERS[number], Quote>([...exactLegacyQuotes(google, GOOGLE_PROVIDERS), ...exactLegacyQuotes(modal, ["modal"]), ...exactLegacyQuotes(fly, ["fly"]), ["model", { provider: "model", currency: "USD", unit: "token-aggregate", priceMicros: legacyModel }]]) : undefined;
      const facts = await Promise.all(RELEASE_COST_FAMILIES.map(async (provider) => {
        const components = quantities?.get(provider);
        if ((FUNDING_FEE_PROVIDERS as readonly string[]).includes(provider)) return railFees.get(provider as typeof FUNDING_FEE_PROVIDERS[number])!;
        if ((NON_BILLABLE_PROVIDERS as readonly string[]).includes(provider)) return nonBillableFact(provider as typeof NON_BILLABLE_PROVIDERS[number], nowMs, components);
        const paidProvider = ProviderSchema.parse(provider) as typeof PAID_PROVIDERS[number]; const snapshot = snapshots.get(paidProvider); if (!snapshot) throw new Error("PRODUCTION_CATALOG_COVERAGE_REQUIRED"); const sourceDocumentSha256 = await sha256Bytes(snapshot.bytes);
        if (!components) { const quote = legacyQuotes!.get(paidProvider); if (!quote) throw new Error("PRODUCTION_CATALOG_COVERAGE_REQUIRED"); return Object.freeze({ provider: paidProvider, sourceId: snapshot.sourceId, sourceDocumentSha256, quoteSha256: await sha256({ sourceDocumentSha256, quote }), currency: quote.currency, unit: quote.unit, priceMicros: quote.priceMicros, observedAtMs: snapshot.observedAtMs, freshUntilMs: snapshot.freshUntilMs, status: "available" as const }); }
        const componentQuotes = familyComponents(paidProvider, snapshot, components);
        const provenance = componentQuotes.map((quote, index) => { const component = components[index]!; return Object.freeze({ componentId: component.componentId, skuId: quote.skuId!, region: component.region, unit: component.unit, priceMicros: quote.priceMicros, ...(quote.priceNanos === undefined ? {} : { priceNanos: quote.priceNanos }), quantityNanos: component.quantityNanos.toString(), headroomBasisPoints: component.headroomBasisPoints, sourceDocumentSha256 }); });
        return Object.freeze({ provider: paidProvider, sourceId: snapshot.sourceId, sourceDocumentSha256, quoteSha256: await sha256({ sourceDocumentSha256, components: provenance }), currency: "USD" as const, unit: components.length === 1 ? components[0]!.unit : "component-aggregate", priceMicros: provenance.reduce((total, component) => total + component.priceMicros, 0), observedAtMs: snapshot.observedAtMs, freshUntilMs: snapshot.freshUntilMs, status: "available" as const, components: provenance });
      }));
      if (facts.some((fact, index) => fact.provider !== RELEASE_COST_FAMILIES[index])) throw new Error("PRODUCTION_CATALOG_COVERAGE_REQUIRED"); return Object.freeze(facts);
    },
  });
}
export const PRODUCTION_NON_BILLABLE_COST_POLICY_SHA256: Promise<string> = sha256({ version: 1, policy: "project-owned-non-billable", providers: NON_BILLABLE_PROVIDERS });

const CERTIFICATION_CEILING_MICROS: Readonly<Record<typeof PAID_PROVIDERS[number], number>> = Object.freeze({
  cloud_run: 100,
  gcs: 2_000,
  collector: 100,
  cloud_sql_postgres: 1_000,
  modal: 10_000,
  fly: 10_000,
  // Model components use distinct published rates; see
  // certificationComponentCeiling below rather than charging a synthetic
  // uniform model rate to both input and output/thought.
  model: 0,
});

const ARGON_CERTIFICATION_CEILING_MICROS = Object.freeze({
  // USD $4 input and $20 output/thought per million tokens, expressed in the
  // topology's ten-million-token unit.  These are a conservative product
  // ceiling, deliberately separate from a fresh provider quote.
  "model.global.input": 40_000_000,
  "model.global.output-thought": 200_000_000,
} as const);

function certificationComponentCeiling(provider: typeof PAID_PROVIDERS[number], componentId: string): number {
  if (provider !== "model") return CERTIFICATION_CEILING_MICROS[provider];
  const ceiling = ARGON_CERTIFICATION_CEILING_MICROS[componentId as keyof typeof ARGON_CERTIFICATION_CEILING_MICROS];
  if (ceiling === undefined) throw new Error("PRODUCTION_CATALOG_QUANTITY_CONTRACT_REJECTED");
  return ceiling;
}

/**
 * Product-owned maximum-spend catalog for release certification. These are
 * deliberately conservative per-unit ceilings, not representations of vendor
 * list prices and not the end-user metering source. Actual provider receipts
 * are still reconciled after execution and may never exceed these bounds.
 */
export function createCertificationBudgetCatalog(options: Readonly<{
  quantityContract: readonly ReleaseTopologyQuantity[];
  now?: () => number;
}>): LiveCostCatalogPort {
  const quantities = componentsByProvider(options.quantityContract);
  if (!quantities) throw new Error("PRODUCTION_CATALOG_QUANTITY_CONTRACT_REJECTED");
  const now = options.now ?? Date.now;
  return Object.freeze({ async listPriceFacts(input) {
    if (input.providers.length !== RELEASE_COST_FAMILIES.length || input.providers.some((provider, index) => provider !== RELEASE_COST_FAMILIES[index])) throw new Error("PRODUCTION_CATALOG_COVERAGE_REQUIRED");
    const readAtMs = now();
    if (!Number.isSafeInteger(readAtMs) || readAtMs <= 0) throw new Error("PRODUCTION_CATALOG_TIME_INVALID");
    // The controller snapshots its request clock before capability discovery.
    // Backdate this versioned in-memory policy by one minute so that bounded
    // discovery latency cannot make the policy appear future-dated.
    const observedAtMs = Math.max(1, readAtMs - 60_000);
    const policy = Object.freeze({ version: 1, policy: "release-certification-maximum-spend", ceilingsMicros: CERTIFICATION_CEILING_MICROS, argonComponentCeilingsMicros: ARGON_CERTIFICATION_CEILING_MICROS });
    const sourceDocumentSha256 = await sha256(policy);
    return Object.freeze(await Promise.all(RELEASE_COST_FAMILIES.map(async (provider) => {
      const components = quantities.get(provider)!;
      const paid = (PAID_PROVIDERS as readonly string[]).includes(provider);
      const provenance = components.map((component) => Object.freeze({
        componentId: component.componentId,
        skuId: `budget-${component.componentId}`,
        region: component.region,
        unit: component.unit,
        priceMicros: paid ? certificationComponentCeiling(provider as typeof PAID_PROVIDERS[number], component.componentId) : 0,
        quantityNanos: component.quantityNanos.toString(),
        headroomBasisPoints: component.headroomBasisPoints,
        sourceDocumentSha256,
      }));
      return Object.freeze({
        provider,
        sourceId: "napplet-cvm-certification-budget-v1",
        sourceDocumentSha256,
        quoteSha256: await sha256({ provider, provenance }),
        currency: "USD" as const,
        unit: components.length === 1 ? components[0]!.unit : "component-aggregate",
        priceMicros: provenance.reduce((total, component) => total + component.priceMicros, 0),
        observedAtMs,
        freshUntilMs: observedAtMs + 24 * 60 * 60 * 1000,
        status: "available" as const,
        components: Object.freeze(provenance),
      });
    })));
  } });
}
