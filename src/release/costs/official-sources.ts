import { z } from "zod";
import type { GooglePublicCatalogPort, OfficialPricingSourcePort } from "./production-catalog";

/** Google public price pages are multi-MiB. This remains an aggregate cap, so
 * pagination cannot turn into an unbounded memory read. */
const MAX_SOURCE_BYTES = 8 * 1024 * 1024;
const MAX_CATALOG_PAGES = 16;
const DEFAULT_TIMEOUT_MS = 5_000;
const GOOGLE_ORIGIN = "https://cloudbilling.googleapis.com";
const MODAL_PRICING_URL = "https://modal.com/pricing";
const FLY_PRICING_URL = "https://fly.io/docs/about/pricing/";
export const VERTEX_GEMINI_PRICING_URL = "https://cloud.google.com/gemini-enterprise-agent-platform/generative-ai/pricing";
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
  timeoutMs?: number;
  /** Optional only for deterministic offline readers. Production supplies ADC. */
  adc?: ApplicationDefaultTokenPort;
  google: Readonly<{ selectors: readonly GoogleCatalogSelector[] }>;
  workers: Readonly<{
    modal: Readonly<{ cpuCores: number; memoryGiB: number; unit: "worker-100-seconds" | "worker-second" }>;
    fly: Readonly<{ preset: string; memory: string; unit: "worker-100-seconds" | "worker-second" }>;
  }>;
}>;

type SourceQuote = Readonly<{ provider: string; componentId: string; skuId: string; region: string; currency: "USD"; unit: string; priceMicros: number; priceNanos: string }>;
type SourceSnapshot = Readonly<{ sourceId: string; bytes: Uint8Array; observedAtMs: number; freshUntilMs: number; quotes: readonly SourceQuote[] }>;
export type VertexGeminiPriceObservation = Readonly<{
  sourceUrl: typeof VERTEX_GEMINI_PRICING_URL; bytes: Uint8Array; observedAtMs: number; freshUntilMs: number; currency: "USD"; location: "global"; model: "gemini-3.8-flash";
  effectiveFrom: "2026-08-13"; effectiveUntil: "2026-12-31"; inputMicrosPerMillion: 1_500_000; cachedInputMicrosPerMillion: 150_000; outputAndThoughtMicrosPerMillion: 7_500_000;
}>;

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

async function readOfficial(fetcher: OfficialFetch, url: string, token?: string, timeoutMs = DEFAULT_TIMEOUT_MS): Promise<Uint8Array> {
  const parsed = new URL(url);
  if (parsed.protocol !== "https:" || !["cloudbilling.googleapis.com", "modal.com", "fly.io", "cloud.google.com"].includes(parsed.hostname)) throw new Error("OFFICIAL_SOURCE_ORIGIN_REJECTED");
  const headers: Record<string, string> = { accept: "application/json, text/html;q=0.9, text/plain;q=0.8" };
  if (token !== undefined) headers.authorization = `Bearer ${token}`;
  const controller = new AbortController(); let timer: ReturnType<typeof setTimeout> | undefined;
  let response: Response;
  try { response = await Promise.race([fetcher(url, { method: "GET", redirect: "error", headers, signal: controller.signal }), new Promise<never>((_resolve, reject) => { timer = setTimeout(() => { controller.abort(); reject(new Error("OFFICIAL_SOURCE_TIMEOUT")); }, timeoutMs); })]); }
  finally { if (timer !== undefined) clearTimeout(timer); }
  if (!response.ok || response.redirected) throw new Error("OFFICIAL_SOURCE_RESPONSE_REJECTED");
  if (!response.body) throw new Error("OFFICIAL_SOURCE_BYTES_REJECTED");
  const reader = response.body.getReader(); const chunks: Uint8Array[] = []; let length = 0; const deadline = Date.now() + timeoutMs; let complete = false;
  try { for (;;) { const remaining = deadline - Date.now(); if (remaining <= 0) throw new Error("OFFICIAL_SOURCE_TIMEOUT"); let readTimer: ReturnType<typeof setTimeout> | undefined; const next = await Promise.race([reader.read(), new Promise<never>((_resolve, reject) => { readTimer = setTimeout(() => reject(new Error("OFFICIAL_SOURCE_TIMEOUT")), remaining); })]).finally(() => { if (readTimer !== undefined) clearTimeout(readTimer); }); if (next.done) { complete = true; break; } length += next.value.byteLength; if (length > MAX_SOURCE_BYTES) throw new Error("OFFICIAL_SOURCE_BYTES_REJECTED"); chunks.push(next.value); } }
  finally { if (!complete) { controller.abort(); void reader.cancel(); } reader.releaseLock(); }
  if (length === 0) throw new Error("OFFICIAL_SOURCE_BYTES_REJECTED"); const bytes = new Uint8Array(length); let offset = 0; for (const chunk of chunks) { bytes.set(chunk, offset); offset += chunk.byteLength; } return bytes;
}
function json(bytes: Uint8Array): Record<string, unknown> { try { const value: unknown = JSON.parse(new TextDecoder().decode(bytes)); assertBounded(value, "OFFICIAL_SOURCE_PARSER_DRIFT"); return value; } catch (error) { if (error instanceof Error && error.message === "OFFICIAL_SOURCE_PARSER_DRIFT") throw error; throw new Error("OFFICIAL_SOURCE_PARSER_DRIFT"); } }
function joinRawDocuments(documents: readonly Uint8Array[]): Uint8Array { const total = documents.reduce((sum, document) => sum + document.byteLength, 0); if (total === 0 || total > MAX_SOURCE_BYTES) throw new Error("OFFICIAL_SOURCE_BYTES_REJECTED"); const joined = new Uint8Array(total); let cursor = 0; for (const document of documents) { joined.set(document, cursor); cursor += document.byteLength; } return joined; }
function decimalToNanos(value: string): bigint { if (!DecimalSchema.test(value)) throw new Error("OFFICIAL_SOURCE_PARSER_DRIFT"); const [whole, fraction = ""] = value.split("."); if (fraction.length > 9) throw new Error("OFFICIAL_SOURCE_PRECISION_REJECTED"); return BigInt(whole!) * 1_000_000_000n + BigInt((fraction + "000000000").slice(0, 9)); }
/** Keep nano-dollar precision for the estimator. The exposed micro value is a
 * conservative ceiling and is never used for the exact calculation. */
function nanosToMicros(nanos: bigint): number { if (nanos <= 0n) throw new Error("OFFICIAL_SOURCE_PRICE_REJECTED"); const micros = (nanos + 999n) / 1_000n; if (micros > BigInt(Number.MAX_SAFE_INTEGER)) throw new Error("OFFICIAL_SOURCE_PRICE_REJECTED"); return Number(micros); }
function pageUrl(serviceName: string, pageToken?: string): string { if (!/^services\/[A-Za-z0-9-]+$/u.test(serviceName) || (pageToken !== undefined && !/^[A-Za-z0-9._~-]{1,1024}$/u.test(pageToken))) throw new Error("OFFICIAL_SOURCE_PARSER_DRIFT"); return `${GOOGLE_ORIGIN}/v1/${serviceName}/skus?currencyCode=USD&pageSize=5000${pageToken ? `&pageToken=${encodeURIComponent(pageToken)}` : ""}`; }
function googlePriceNanos(rawSku: Record<string, unknown>, selector: GoogleCatalogSelector): bigint {
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
  const result = BigInt(text(price.units)!) * 1_000_000_000n + BigInt(integer(price.nanos)!);
  if (result <= 0n) throw new Error("OFFICIAL_SOURCE_PRICE_REJECTED");
  return result;
}
function priceAfter(textSource: string, matcher: RegExp): bigint { const match = matcher.exec(textSource); if (!match?.[1]) throw new Error("OFFICIAL_SOURCE_PARSER_DRIFT"); return decimalToNanos(match[1]); }

/** The only production pricing readers: bounded official GETs, Cloud Billing
 * service/SKU endpoints only, and opaque ADC that never leaves request memory. */
export function createOfficialPricingSources(options: OfficialPricingSourcesOptions): Readonly<{ google: GooglePublicCatalogPort; sources: OfficialPricingSourcePort & Readonly<{ readVertexGeminiPrice(): Promise<VertexGeminiPriceObservation> }> }> {
  const now = options.now ?? Date.now;
  const freshForMs = options.freshnessMs ?? 60 * 60 * 1000;
  const timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  const selectors = options.google.selectors;
  if (!Number.isSafeInteger(freshForMs) || freshForMs <= 0 || !Number.isSafeInteger(timeoutMs) || timeoutMs < 1 || timeoutMs > 30_000 || selectors.length === 0 || selectors.some((selector) => !validIdentifier(selector.componentId) || !validSkuId(selector.skuId) || !/^[a-z][a-z0-9-]{2,63}$/u.test(selector.region)) || new Set(selectors.map((selector) => selector.componentId)).size !== selectors.length || new Set(selectors.map((selector) => selector.skuId)).size !== selectors.length) throw new Error("OFFICIAL_SOURCE_CONFIGURATION_REJECTED");
  const snapshot = (sourceId: string, bytes: Uint8Array, quotes: readonly SourceQuote[]): SourceSnapshot => { const observedAtMs = now(); if (!Number.isSafeInteger(observedAtMs) || observedAtMs <= 0) throw new Error("OFFICIAL_SOURCE_TIME_REJECTED"); return Object.freeze({ sourceId, bytes, observedAtMs, freshUntilMs: observedAtMs + freshForMs, quotes: Object.freeze([...quotes]) }); };
  return Object.freeze({
    google: Object.freeze({
      async readCatalog(input) {
        if (input.projectId !== undefined || !Array.isArray(input.providers) || input.providers.length === 0 || input.providers.some((provider) => !ProviderSchema.safeParse(provider).success) || new Set(input.providers).size !== input.providers.length) throw new Error("OFFICIAL_SOURCE_GOOGLE_REQUEST_REJECTED");
        const selected = selectors.filter((selector) => input.providers.includes(selector.provider));
        if (selected.length === 0 || input.providers.some((provider) => !selected.some((selector) => selector.provider === provider))) throw new Error("OFFICIAL_SOURCE_GOOGLE_COVERAGE_REJECTED");
        const token = options.adc ? await options.adc.readAccessToken() : undefined;
        if (token !== undefined && !TokenSchema.test(token)) throw new Error("ADC_APPLICATION_DEFAULT_LOGIN_REQUIRED");
        const rawDocuments: Uint8Array[] = []; let capturedBytes = 0;
        const capture = (bytes: Uint8Array) => { capturedBytes += bytes.byteLength; if (capturedBytes > MAX_SOURCE_BYTES) throw new Error("OFFICIAL_SOURCE_BYTES_REJECTED"); rawDocuments.push(bytes); };
        const services: unknown[] = []; let serviceToken: string | undefined; const serviceTokens = new Set<string>();
        for (let page = 0; page < MAX_CATALOG_PAGES; page += 1) { const url = `${GOOGLE_ORIGIN}/v1/services?pageSize=5000${serviceToken ? `&pageToken=${encodeURIComponent(serviceToken)}` : ""}`; const bytes = await readOfficial(options.fetch, url, token, timeoutMs); capture(bytes); const catalog = json(bytes); if (!Array.isArray(catalog.services)) throw new Error("OFFICIAL_SOURCE_PARSER_DRIFT"); services.push(...catalog.services); const next = text(catalog.nextPageToken); if (!next) break; if (!/^[A-Za-z0-9._~-]{1,1024}$/u.test(next) || page === MAX_CATALOG_PAGES - 1 || serviceTokens.has(next)) throw new Error("OFFICIAL_SOURCE_PAGINATION_REJECTED"); serviceTokens.add(next); serviceToken = next; }
        const names = new Map<string, string>();
        for (const service of services) { assertBounded(service); const displayName = text(service.displayName); const name = text(service.name); if (displayName && name && selected.some((selector) => selector.serviceDisplayName === displayName)) { const prior = names.get(displayName); if (prior !== undefined && prior !== name) throw new Error("OFFICIAL_SOURCE_SERVICE_REJECTED"); names.set(displayName, name); } }
        if (names.size !== new Set(selected.map((selector) => selector.serviceDisplayName)).size) throw new Error("OFFICIAL_SOURCE_SERVICE_REJECTED");
        const catalogs = new Map<string, unknown[]>();
        for (const displayName of [...names.keys()].sort()) { const skus: unknown[] = []; let pageToken: string | undefined; const skuTokens = new Set<string>(); for (let page = 0; page < MAX_CATALOG_PAGES; page += 1) { const bytes = await readOfficial(options.fetch, pageUrl(names.get(displayName)!, pageToken), token, timeoutMs); capture(bytes); const catalog = json(bytes); if (!Array.isArray(catalog.skus)) throw new Error("OFFICIAL_SOURCE_PARSER_DRIFT"); skus.push(...catalog.skus); const next = text(catalog.nextPageToken); if (!next) break; if (!/^[A-Za-z0-9._~-]{1,1024}$/u.test(next) || page === MAX_CATALOG_PAGES - 1 || skuTokens.has(next)) throw new Error("OFFICIAL_SOURCE_PAGINATION_REJECTED"); skuTokens.add(next); pageToken = next; } catalogs.set(displayName, skus); }
        const quotes = selected.map((selector) => { const skus = catalogs.get(selector.serviceDisplayName)!; const matches = skus.filter((sku): sku is Record<string, unknown> => !!sku && typeof sku === "object" && !Array.isArray(sku) && text((sku as Record<string, unknown>).skuId) === selector.skuId); if (matches.length !== 1) throw new Error("OFFICIAL_SOURCE_SKU_REJECTED"); const priceNanos = googlePriceNanos(matches[0]!, selector); return Object.freeze({ provider: selector.provider, componentId: selector.componentId, skuId: selector.skuId, region: selector.region, currency: "USD" as const, unit: selector.unit, priceMicros: nanosToMicros(priceNanos), priceNanos: priceNanos.toString() }); });
        return snapshot("gcp-cloud-billing-catalog-v1", joinRawDocuments(rawDocuments), quotes);
      },
    }),
    sources: Object.freeze({
      async readVertexGeminiPrice() {
        const bytes = await readOfficial(options.fetch, VERTEX_GEMINI_PRICING_URL, undefined, timeoutMs);
        // The Cloud documentation page contains both rendered tables and JSON
        // hydration payloads. Bind to the rendered table text; never let an
        // unrelated embedded JSON occurrence select a price.
        const source = new TextDecoder().decode(bytes).replace(/<[^>]*>/gu, " ").replace(/&(nbsp|amp|lt|gt|quot);/giu, " ").replace(/\s+/gu, " ");
        /* The asterisked 2026 rows are explicitly a 50% billing credit. They
         * cannot fund an authorization; retain the full pre-credit charge
         * proven by the matching standard rows instead. */
        const credited = /Gemini 3\.8 Flash\*?\s*through December\s+31,?\s+2026\s+Input \(text, image, video, audio\)\s+Global\s+\$0\.75\s+\$0\.75\s+\$0\.075\s+\$0\.075\s+Non-global[\s\S]{0,200}?Text output \(response and reasoning\)\s+Global\s+\$3\.75\s+\$3\.75/iu;
        const gross = /Gemini 3\.8 Flash\s+Starting January\s+1,?\s+2027\s+Input \(text, image, video, audio\)\s+Global\s+\$1\.50\s+\$1\.50\s+\$0\.15\s+\$0\.15[\s\S]{0,200}?Text output \(response and reasoning\)\s+Global\s+\$7\.50\s+\$7\.50/iu;
        if (!credited.test(source) || !gross.test(source) || !/Promotional pricing provided through 50% credits back on net spend/iu.test(source)) throw new Error("VERTEX_PRICE_SOURCE_GROSS_UNPROVEN");
        const observedAtMs = now(); if (!Number.isSafeInteger(observedAtMs) || observedAtMs <= 0) throw new Error("OFFICIAL_SOURCE_TIME_REJECTED");
        return frozenVertexPrice({ bytes, observedAtMs, freshUntilMs: observedAtMs + freshForMs });
      },
      async readOfficialPricing(input) {
        const provider = WorkerProviderSchema.parse(input.provider); const url = provider === "modal" ? MODAL_PRICING_URL : FLY_PRICING_URL; const bytes = await readOfficial(options.fetch, url, undefined, timeoutMs); const document = new TextDecoder().decode(bytes);
        const priceNanos = provider === "modal" ? (() => { const cpu = priceAfter(document, /\$([0-9]+(?:\.[0-9]+)?)\s*\/\s*core\s*\/\s*sec/iu); const memory = priceAfter(document, /\$([0-9]+(?:\.[0-9]+)?)\s*\/\s*GiB\s*\/\s*sec/iu); return (cpu * BigInt(options.workers.modal.cpuCores) + memory * BigInt(options.workers.modal.memoryGiB)) * (options.workers.modal.unit === "worker-100-seconds" ? 100n : 1n); })() : (() => { const preset = options.workers.fly.preset.replace(/[.*+?^${}()|[\]\\]/gu, "\\$&"); const memory = options.workers.fly.memory.replace(/[.*+?^${}()|[\]\\]/gu, "\\$&"); const match = new RegExp(`${preset}[\\s\\S]{0,256}?${memory}[\\s\\S]{0,256}?\\$([0-9]+(?:\\.[0-9]+)?)\\s*\\/\\s*(second|sec)`, "iu").exec(document); if (!match?.[1]) throw new Error("OFFICIAL_SOURCE_UNIT_REJECTED"); return decimalToNanos(match[1]) * (options.workers.fly.unit === "worker-100-seconds" ? 100n : 1n); })();
        const unit = provider === "modal" ? options.workers.modal.unit : options.workers.fly.unit;
        return snapshot(`${provider}-official-pricing`, bytes, [{ provider, componentId: `${provider}.global`, skuId: `${provider}-official`, region: "global", currency: "USD", unit, priceMicros: nanosToMicros(priceNanos), priceNanos: priceNanos.toString() }]);
      },
    }),
  });
}

function frozenVertexPrice(input: Readonly<{ bytes: Uint8Array; observedAtMs: number; freshUntilMs: number }>): VertexGeminiPriceObservation {
  return Object.freeze({ sourceUrl: VERTEX_GEMINI_PRICING_URL, bytes: input.bytes, observedAtMs: input.observedAtMs, freshUntilMs: input.freshUntilMs, currency: "USD", location: "global", model: "gemini-3.8-flash", effectiveFrom: "2026-08-13", effectiveUntil: "2026-12-31", inputMicrosPerMillion: 1_500_000, cachedInputMicrosPerMillion: 150_000, outputAndThoughtMicrosPerMillion: 7_500_000 });
}
