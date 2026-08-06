import { z } from "zod";
import type { GooglePublicCatalogPort, OfficialPricingSourcePort } from "./production-catalog";

const MAX_SOURCE_BYTES = 1_000_000;
const GOOGLE_ORIGIN = "https://cloudbilling.googleapis.com";
const MODAL_PRICING_URL = "https://modal.com/pricing";
const FLY_PRICING_URL = "https://fly.io/docs/about/pricing/";
const ProviderSchema = z.enum(["cloud_run", "gcs", "collector", "cloud_sql_postgres", "cep8_lightning", "cashu", "model"]);
const WorkerProviderSchema = z.enum(["modal", "fly"]);
const DecimalSchema = /^\d+(?:\.\d+)?$/u;
const TokenSchema = /^[A-Za-z0-9._~-]{20,8192}$/u;

type OfficialFetch = (request: string, init: RequestInit) => Promise<Response>;
type GoogleProvider = z.infer<typeof ProviderSchema>;
export type ApplicationDefaultTokenPort = Readonly<{ readAccessToken(): Promise<string> }>;

export type GoogleCatalogSelector = Readonly<{
  componentId: string;
  provider: GoogleProvider;
  serviceDisplayName: string;
  skuId: string;
  region: string;
  usageUnit: string;
  unit: string;
}>;
export type OfficialPricingSourcesOptions = Readonly<{
  fetch: OfficialFetch;
  now?: () => number;
  freshnessMs?: number;
  /** Optional only for deterministic offline readers. Production supplies ADC. */
  adc?: ApplicationDefaultTokenPort;
  google: Readonly<{ selectors: readonly GoogleCatalogSelector[] }>;
  workers: Readonly<{
    modal: Readonly<{ cpuCores: number; memoryGiB: number; unit: "worker-100-seconds" | "worker-second" }>;
    fly: Readonly<{ preset: string; memory: string; unit: "worker-100-seconds" | "worker-second" }>;
  }>;
}>;

type SourceQuote = Readonly<{ provider: string; componentId: string; skuId: string; region: string; currency: "USD"; unit: string; priceMicros: number }>;
type SourceSnapshot = Readonly<{ sourceId: string; bytes: Uint8Array; observedAtMs: number; freshUntilMs: number; quotes: readonly SourceQuote[] }>;

/** Reads ADC only from gcloud stdout into this process's memory. No project is
 * selected, and no token crosses argv, environment, a digest, or an output. */
export function createApplicationDefaultTokenPort(): ApplicationDefaultTokenPort {
  return Object.freeze({
    async readAccessToken() {
      const process = Bun.spawn(["gcloud", "auth", "application-default", "print-access-token"], { stdin: "ignore", stdout: "pipe", stderr: "ignore" });
      const value = (await new Response(process.stdout).text()).trim();
      if (await process.exited !== 0 || !TokenSchema.test(value)) throw new Error("ADC_APPLICATION_DEFAULT_LOGIN_REQUIRED");
      return value;
    },
  });
}

function assertBounded(value: unknown, code = "OFFICIAL_SOURCE_RESPONSE_REJECTED"): asserts value is Record<string, unknown> { if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error(code); }
function integer(value: unknown): number | undefined { return typeof value === "number" && Number.isSafeInteger(value) ? value : undefined; }
function text(value: unknown): string | undefined { return typeof value === "string" ? value : undefined; }
function validIdentifier(value: string): boolean { return /^[a-z][a-z0-9._-]{2,127}$/u.test(value); }
function validSkuId(value: string): boolean { return /^[A-Za-z0-9._-]{2,127}$/u.test(value); }

async function readOfficial(fetcher: OfficialFetch, url: string, token?: string): Promise<Uint8Array> {
  const parsed = new URL(url);
  if (parsed.protocol !== "https:" || !["cloudbilling.googleapis.com", "modal.com", "fly.io"].includes(parsed.hostname)) throw new Error("OFFICIAL_SOURCE_ORIGIN_REJECTED");
  const headers: Record<string, string> = { accept: "application/json, text/html;q=0.9, text/plain;q=0.8" };
  if (token !== undefined) headers.authorization = `Bearer ${token}`;
  const response = await fetcher(url, { method: "GET", redirect: "error", headers });
  if (!response.ok || response.redirected) throw new Error("OFFICIAL_SOURCE_RESPONSE_REJECTED");
  const bytes = new Uint8Array(await response.arrayBuffer());
  if (bytes.byteLength === 0 || bytes.byteLength > MAX_SOURCE_BYTES) throw new Error("OFFICIAL_SOURCE_BYTES_REJECTED");
  return bytes;
}
function json(bytes: Uint8Array): Record<string, unknown> { try { const value: unknown = JSON.parse(new TextDecoder().decode(bytes)); assertBounded(value, "OFFICIAL_SOURCE_PARSER_DRIFT"); return value; } catch (error) { if (error instanceof Error && error.message === "OFFICIAL_SOURCE_PARSER_DRIFT") throw error; throw new Error("OFFICIAL_SOURCE_PARSER_DRIFT"); } }
function joinRawDocuments(documents: readonly Uint8Array[]): Uint8Array { const total = documents.reduce((sum, document) => sum + document.byteLength, 0); if (total === 0 || total > MAX_SOURCE_BYTES) throw new Error("OFFICIAL_SOURCE_BYTES_REJECTED"); const joined = new Uint8Array(total); let cursor = 0; for (const document of documents) { joined.set(document, cursor); cursor += document.byteLength; } return joined; }
function decimalToNanos(value: string): bigint { if (!DecimalSchema.test(value)) throw new Error("OFFICIAL_SOURCE_PARSER_DRIFT"); const [whole, fraction = ""] = value.split("."); if (fraction.length > 9) throw new Error("OFFICIAL_SOURCE_PRECISION_REJECTED"); return BigInt(whole!) * 1_000_000_000n + BigInt((fraction + "000000000").slice(0, 9)); }
function nanosToMicros(nanos: bigint): number { if (nanos <= 0n || nanos % 1_000n !== 0n) throw new Error("OFFICIAL_SOURCE_PRECISION_REJECTED"); const micros = nanos / 1_000n; if (micros > BigInt(Number.MAX_SAFE_INTEGER)) throw new Error("OFFICIAL_SOURCE_PRICE_REJECTED"); return Number(micros); }
function pageUrl(serviceName: string): string { if (!/^services\/[A-Za-z0-9-]+$/u.test(serviceName)) throw new Error("OFFICIAL_SOURCE_PARSER_DRIFT"); return `${GOOGLE_ORIGIN}/v1/${serviceName}/skus?currencyCode=USD&pageSize=5000`; }
function googlePriceMicros(rawSku: Record<string, unknown>, selector: GoogleCatalogSelector): number {
  if (text(rawSku.skuId) !== selector.skuId) throw new Error("OFFICIAL_SOURCE_PARSER_DRIFT");
  const offeredRegions = rawSku.serviceRegions;
  if (!Array.isArray(offeredRegions) || !offeredRegions.includes(selector.region)) throw new Error("OFFICIAL_SOURCE_REGION_REJECTED");
  const pricing = rawSku.pricingInfo;
  if (!Array.isArray(pricing) || pricing.length !== 1) throw new Error("OFFICIAL_SOURCE_PARSER_DRIFT");
  assertBounded(pricing[0]); assertBounded(pricing[0].pricingExpression);
  const expression = pricing[0].pricingExpression;
  if (text(expression.usageUnit) !== selector.usageUnit) throw new Error("OFFICIAL_SOURCE_UNIT_REJECTED");
  const tiers = expression.tieredRates;
  if (!Array.isArray(tiers) || tiers.length !== 1) throw new Error("OFFICIAL_SOURCE_TIER_REJECTED");
  assertBounded(tiers[0]); assertBounded(tiers[0].unitPrice);
  const price = tiers[0].unitPrice;
  if (text(price.currencyCode) !== "USD" || !/^-?\d+$/u.test(text(price.units) ?? "") || integer(price.nanos) === undefined || integer(price.nanos)! < 0 || integer(price.nanos)! >= 1_000_000_000) throw new Error("OFFICIAL_SOURCE_PRICE_REJECTED");
  return nanosToMicros(BigInt(text(price.units)!) * 1_000_000_000n + BigInt(integer(price.nanos)!));
}
function priceAfter(textSource: string, matcher: RegExp): bigint { const match = matcher.exec(textSource); if (!match?.[1]) throw new Error("OFFICIAL_SOURCE_PARSER_DRIFT"); return decimalToNanos(match[1]); }

/** The only production pricing readers: bounded official GETs, Cloud Billing
 * service/SKU endpoints only, and opaque ADC that never leaves request memory. */
export function createOfficialPricingSources(options: OfficialPricingSourcesOptions): Readonly<{ google: GooglePublicCatalogPort; sources: OfficialPricingSourcePort }> {
  const now = options.now ?? Date.now;
  const freshForMs = options.freshnessMs ?? 60 * 60 * 1000;
  const selectors = options.google.selectors;
  if (!Number.isSafeInteger(freshForMs) || freshForMs <= 0 || selectors.length === 0 || selectors.some((selector) => !validIdentifier(selector.componentId) || !validSkuId(selector.skuId) || !/^[a-z][a-z0-9-]{2,63}$/u.test(selector.region)) || new Set(selectors.map((selector) => selector.componentId)).size !== selectors.length || new Set(selectors.map((selector) => selector.skuId)).size !== selectors.length) throw new Error("OFFICIAL_SOURCE_CONFIGURATION_REJECTED");
  const snapshot = (sourceId: string, bytes: Uint8Array, quotes: readonly SourceQuote[]): SourceSnapshot => { const observedAtMs = now(); if (!Number.isSafeInteger(observedAtMs) || observedAtMs <= 0) throw new Error("OFFICIAL_SOURCE_TIME_REJECTED"); return Object.freeze({ sourceId, bytes, observedAtMs, freshUntilMs: observedAtMs + freshForMs, quotes: Object.freeze([...quotes]) }); };
  return Object.freeze({
    google: Object.freeze({
      async readCatalog(input) {
        if (input.projectId !== undefined || !Array.isArray(input.providers) || input.providers.length === 0 || input.providers.some((provider) => !ProviderSchema.safeParse(provider).success) || new Set(input.providers).size !== input.providers.length) throw new Error("OFFICIAL_SOURCE_GOOGLE_REQUEST_REJECTED");
        const selected = selectors.filter((selector) => input.providers.includes(selector.provider));
        if (selected.length === 0 || input.providers.some((provider) => !selected.some((selector) => selector.provider === provider))) throw new Error("OFFICIAL_SOURCE_GOOGLE_COVERAGE_REJECTED");
        const token = options.adc ? await options.adc.readAccessToken() : undefined;
        if (token !== undefined && !TokenSchema.test(token)) throw new Error("ADC_APPLICATION_DEFAULT_LOGIN_REQUIRED");
        const serviceBytes = await readOfficial(options.fetch, `${GOOGLE_ORIGIN}/v1/services`, token);
        const services = json(serviceBytes).services;
        if (!Array.isArray(services)) throw new Error("OFFICIAL_SOURCE_PARSER_DRIFT");
        const names = new Map<string, string>();
        for (const service of services) { assertBounded(service); const displayName = text(service.displayName); const name = text(service.name); if (displayName && name && selected.some((selector) => selector.serviceDisplayName === displayName)) names.set(displayName, name); }
        if (names.size !== new Set(selected.map((selector) => selector.serviceDisplayName)).size) throw new Error("OFFICIAL_SOURCE_SERVICE_REJECTED");
        const rawDocuments: Uint8Array[] = [serviceBytes]; const catalogs = new Map<string, Record<string, unknown>>();
        for (const displayName of [...names.keys()].sort()) { const bytes = await readOfficial(options.fetch, pageUrl(names.get(displayName)!), token); rawDocuments.push(bytes); const catalog = json(bytes); if (typeof catalog.nextPageToken === "string" && catalog.nextPageToken.length > 0) throw new Error("OFFICIAL_SOURCE_PAGINATION_REJECTED"); if (!Array.isArray(catalog.skus)) throw new Error("OFFICIAL_SOURCE_PARSER_DRIFT"); catalogs.set(displayName, catalog); }
        const quotes = selected.map((selector) => { const skus = catalogs.get(selector.serviceDisplayName)!.skus as unknown[]; const matches = skus.filter((sku): sku is Record<string, unknown> => !!sku && typeof sku === "object" && !Array.isArray(sku) && text((sku as Record<string, unknown>).skuId) === selector.skuId); if (matches.length !== 1) throw new Error("OFFICIAL_SOURCE_SKU_REJECTED"); return Object.freeze({ provider: selector.provider, componentId: selector.componentId, skuId: selector.skuId, region: selector.region, currency: "USD" as const, unit: selector.unit, priceMicros: googlePriceMicros(matches[0]!, selector) }); });
        return snapshot("gcp-cloud-billing-catalog-v1", joinRawDocuments(rawDocuments), quotes);
      },
    }),
    sources: Object.freeze({
      async readOfficialPricing(input) {
        const provider = WorkerProviderSchema.parse(input.provider); const url = provider === "modal" ? MODAL_PRICING_URL : FLY_PRICING_URL; const bytes = await readOfficial(options.fetch, url); const document = new TextDecoder().decode(bytes);
        const priceMicros = provider === "modal" ? (() => { const cpu = priceAfter(document, /\$([0-9]+(?:\.[0-9]+)?)\s*\/\s*core\s*\/\s*sec/iu); const memory = priceAfter(document, /\$([0-9]+(?:\.[0-9]+)?)\s*\/\s*GiB\s*\/\s*sec/iu); return nanosToMicros((cpu * BigInt(options.workers.modal.cpuCores) + memory * BigInt(options.workers.modal.memoryGiB)) * (options.workers.modal.unit === "worker-100-seconds" ? 100n : 1n)); })() : (() => { const preset = options.workers.fly.preset.replace(/[.*+?^${}()|[\]\\]/gu, "\\$&"); const memory = options.workers.fly.memory.replace(/[.*+?^${}()|[\]\\]/gu, "\\$&"); const rate = priceAfter(document, new RegExp(`${preset}[\\s\\S]{0,512}?${memory}[\\s\\S]{0,512}?\\$([0-9]+(?:\\.[0-9]+)?)`, "iu")); return nanosToMicros(rate * (options.workers.fly.unit === "worker-100-seconds" ? 100n : 1n)); })();
        const unit = provider === "modal" ? options.workers.modal.unit : options.workers.fly.unit;
        return snapshot(`${provider}-official-pricing`, bytes, [{ provider, componentId: `${provider}.global`, skuId: `${provider}-official`, region: "global", currency: "USD", unit, priceMicros }]);
      },
    }),
  });
}
