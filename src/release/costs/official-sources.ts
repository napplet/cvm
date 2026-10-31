import { z } from "zod";
import type { GooglePublicCatalogPort, OfficialPricingSourcePort } from "./production-catalog";
import type { UsdSatConversion } from "../../model/price-card";

/** Google public price pages are multi-MiB. This remains an aggregate cap, so
 * pagination cannot turn into an unbounded memory read. */
const MAX_SOURCE_BYTES = 8 * 1024 * 1024;
const MAX_CATALOG_PAGES = 16;
const DEFAULT_TIMEOUT_MS = 5_000;
const GOOGLE_ORIGIN = "https://cloudbilling.googleapis.com";
const MODAL_PRICING_URL = "https://modal.com/pricing";
const FLY_PRICING_URL = "https://docs.fly.io/about/pricing";
/** Coinbase Exchange's public ticker is an actual executable USD market quote,
 * not the display-only BTC/USD cache.  A settlement binds its exact response
 * digest and may never substitute a stale/cached value. */
export const BTC_USD_TICKER_URL = "https://api.exchange.coinbase.com/products/BTC-USD/ticker";
export const VERTEX_GEMINI_PRICING_URL = "https://cloud.google.com/model-garden/pricing";
/** Only infrastructure is discoverable through Cloud Billing. Payment rails
 * are funding capital (and separately contracted fees); model prices come
 * from the Vertex model source, never an invented Cloud SKU selector. */
const ProviderSchema = z.enum(["cloud_run", "gcs", "collector", "cloud_sql_postgres"]);
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
  /** A prior source capture may pin an exact SKU. Before the first capture,
   * all declared catalog attributes must resolve to exactly one official SKU. */
  skuId?: string;
  region: string;
  usageUnit: string;
  unit: string;
  descriptionIncludes?: string;
  resourceFamily?: string;
  resourceGroup?: string;
  usageType?: "OnDemand";
}>;
/** Controller-owned topology selectors. They are deliberately semantic rather
 * than a user-supplied SKU list: Cloud Billing returns and pins the selected
 * IDs in each fresh capture. A changed/ambiguous catalog is a refusal. */
export const PRODUCTION_CATALOG_SELECTORS: readonly GoogleCatalogSelector[] = Object.freeze([
  { componentId: "cloud_run.europe-west1.cpu", provider: "cloud_run", serviceDisplayName: "Cloud Run", skuId: "4C19-DF1E-81AB", region: "europe-west1", usageUnit: "s", unit: "worker-second" },
  { componentId: "cloud_run.europe-west1.memory", provider: "cloud_run", serviceDisplayName: "Cloud Run", descriptionIncludes: "Memory Allocation Time (Always-on CPU)", usageType: "OnDemand", region: "europe-west1", usageUnit: "GiBy.s", unit: "gibibyte-second" },
  { componentId: "cloud_run.us-central1.cpu", provider: "cloud_run", serviceDisplayName: "Cloud Run", skuId: "011E-3072-CBDB", region: "us-central1", usageUnit: "s", unit: "worker-second" },
  { componentId: "cloud_run.us-central1.memory", provider: "cloud_run", serviceDisplayName: "Cloud Run", descriptionIncludes: "Memory Allocation Time (Always-on CPU)", usageType: "OnDemand", region: "us-central1", usageUnit: "GiBy.s", unit: "gibibyte-second" },
  { componentId: "collector.europe-west1.cpu", provider: "collector", serviceDisplayName: "Cloud Run", skuId: "4C19-DF1E-81AB", region: "europe-west1", usageUnit: "s", unit: "worker-second" },
  { componentId: "collector.europe-west1.memory", provider: "collector", serviceDisplayName: "Cloud Run", descriptionIncludes: "Memory Allocation Time (Always-on CPU)", usageType: "OnDemand", region: "europe-west1", usageUnit: "GiBy.s", unit: "gibibyte-second" },
  { componentId: "collector.us-central1.cpu", provider: "collector", serviceDisplayName: "Cloud Run", skuId: "011E-3072-CBDB", region: "us-central1", usageUnit: "s", unit: "worker-second" },
  { componentId: "collector.us-central1.memory", provider: "collector", serviceDisplayName: "Cloud Run", descriptionIncludes: "Memory Allocation Time (Always-on CPU)", usageType: "OnDemand", region: "us-central1", usageUnit: "GiBy.s", unit: "gibibyte-second" },
  { componentId: "gcs.nam4.storage", provider: "gcs", serviceDisplayName: "Cloud Storage", descriptionIncludes: "dual-region standard storage", region: "nam4", usageUnit: "gibibyte day", unit: "gibibyte-day" },
  { componentId: "gcs.nam4.operations", provider: "gcs", serviceDisplayName: "Cloud Storage", descriptionIncludes: "dual-region class a operations", region: "nam4", usageUnit: "operations", unit: "operation" },
  { componentId: "cloud_sql_postgres.europe-west1.regional-ha", provider: "cloud_sql_postgres", serviceDisplayName: "Cloud SQL", descriptionIncludes: "postgresql regional", region: "europe-west1", usageUnit: "seconds", unit: "database-second" },
]);
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
  sourceUrl: typeof VERTEX_GEMINI_PRICING_URL; bytes: Uint8Array; observedAtMs: number; freshUntilMs: number; currency: "USD"; location: "global"; model: "gemini-4-argon";
  effectiveFrom: "2026-10-13"; effectiveUntil: "2026-11-30"; inputMicrosPerMillion: 4_000_000; cachedInputMicrosPerMillion: 200_000; outputAndThoughtMicrosPerMillion: 20_000_000;
}>;
/** Reads ADC only from gcloud stdout into this process's memory. No project is
 * selected, and no token crosses argv, environment, a digest, or an output. */
export function createApplicationDefaultTokenPort(): ApplicationDefaultTokenPort {
  return Object.freeze({
    async readAccessToken() {
      const child = (() => {
        try { return Bun.spawn(["gcloud", "auth", "application-default", "print-access-token"], { stdin: "ignore", stdout: "pipe", stderr: "ignore", env: process.env }); }
        catch { throw new Error("ADC_APPLICATION_DEFAULT_LOGIN_REQUIRED"); }
      })();
      let timer: ReturnType<typeof setTimeout> | undefined;
      const reader = child.stdout.getReader();
      const output = async () => {
        const parts: Uint8Array[] = []; let size = 0;
        for (;;) { const part = await reader.read(); if (part.done) break; size += part.value.byteLength; if (size > 8192) throw new Error("ADC_TOKEN_RESPONSE_REJECTED"); parts.push(part.value); }
        const bytes = new Uint8Array(size); let offset = 0; for (const part of parts) { bytes.set(part, offset); offset += part.byteLength; }
        return new TextDecoder().decode(bytes).trim();
      };
      try {
        const [code, value] = await Promise.race([
          Promise.all([child.exited, output()]),
          new Promise<never>((_, reject) => { timer = setTimeout(() => { child.kill(); reject(new Error("ADC_TOKEN_TIMEOUT")); }, 5000); }),
        ]);
        if (code !== 0 || !TokenSchema.test(value)) throw new Error("ADC_APPLICATION_DEFAULT_LOGIN_REQUIRED");
        return value;
      } finally { clearTimeout(timer); child.kill(); void reader.cancel().catch(() => undefined); }

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
  if (parsed.protocol !== "https:" || !["cloudbilling.googleapis.com", "modal.com", "docs.fly.io", "cloud.google.com", "api.exchange.coinbase.com"].includes(parsed.hostname)) throw new Error("OFFICIAL_SOURCE_ORIGIN_REJECTED");
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
function decimalToInteger(value: string): readonly [bigint, bigint] {
  if (!DecimalSchema.test(value)) throw new Error("USD_SAT_SOURCE_PARSER_DRIFT");
  const [whole, fraction = ""] = value.split(".");
  if (fraction.length > 12) throw new Error("USD_SAT_SOURCE_PRECISION_REJECTED");
  const scale = 10n ** BigInt(fraction.length);
  const amount = BigInt(whole!) * scale + BigInt(fraction || "0");
  if (amount <= 0n) throw new Error("USD_SAT_SOURCE_PRICE_REJECTED");
  return [amount, scale];
}
function gcd(left: bigint, right: bigint): bigint { let a = left; let b = right; while (b !== 0n) [a, b] = [b, a % b]; return a; }
/** Keep nano-dollar precision for the estimator. The exposed micro value is a
 * conservative ceiling and is never used for the exact calculation. */
function nanosToMicros(nanos: bigint): number { if (nanos <= 0n) throw new Error("OFFICIAL_SOURCE_PRICE_REJECTED"); const micros = (nanos + 999n) / 1_000n; if (micros > BigInt(Number.MAX_SAFE_INTEGER)) throw new Error("OFFICIAL_SOURCE_PRICE_REJECTED"); return Number(micros); }
function pageUrl(serviceName: string, pageToken?: string): string { if (!/^services\/[A-Za-z0-9-]+$/u.test(serviceName) || (pageToken !== undefined && !/^[A-Za-z0-9._~-]{1,1024}$/u.test(pageToken))) throw new Error("OFFICIAL_SOURCE_PARSER_DRIFT"); return `${GOOGLE_ORIGIN}/v1/${serviceName}/skus?currencyCode=USD&pageSize=5000${pageToken ? `&pageToken=${encodeURIComponent(pageToken)}` : ""}`; }
function googlePriceNanos(rawSku: Record<string, unknown>, selector: GoogleCatalogSelector): bigint {
  if (!text(rawSku.skuId)) throw new Error("OFFICIAL_SOURCE_PARSER_DRIFT");
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
function matchesSelector(sku: Record<string, unknown>, selector: GoogleCatalogSelector): boolean {
  // A semantic SKU description can recur in every region. Narrow the real
  // offered regions before deciding that one semantic selector is unique.
  if (selector.skuId === undefined && (!Array.isArray(sku.serviceRegions) || !sku.serviceRegions.includes(selector.region))) return false;
  if (selector.skuId !== undefined && text(sku.skuId) !== selector.skuId) return false;
  if (selector.descriptionIncludes !== undefined && !text(sku.description)?.toLowerCase().includes(selector.descriptionIncludes.toLowerCase())) return false;
  const category = sku.category;
  if (selector.usageType !== undefined && (!category || typeof category !== "object" || Array.isArray(category) || !("usageType" in category) || text(category.usageType) !== selector.usageType)) return false;
  if ((selector.resourceFamily !== undefined || selector.resourceGroup !== undefined) && (!category || typeof category !== "object" || Array.isArray(category))) return false;
  if (selector.resourceFamily !== undefined && text((category as Record<string, unknown>).resourceFamily) !== selector.resourceFamily) return false;
  if (selector.resourceGroup !== undefined && text((category as Record<string, unknown>).resourceGroup) !== selector.resourceGroup) return false;
  return true;
}
function officialText(document: string): string {
  /* Modal's animated price digits carry one authoritative screen-reader value.
   * Preserve that value before stripping markup; otherwise the visual animation
   * turns $0.00003942 into a sequence of unrelated digits. */
  const srOnly = [...document.matchAll(/<span[^>]*class=["'][^"']*\bsr-only\b[^"']*["'][^>]*>\s*([0-9]+(?:\.[0-9]+)?)\s*<\/span>/giu)].map((match) => match[1]);
  return `${srOnly.join(" ")} ${document.replace(/<[^>]*>/gu, " ")}`.replace(/&(nbsp|amp|lt|gt|quot);/giu, " ").replace(/\s+/gu, " ");
}
function renderedText(document: string): string { return document.replace(/<[^>]*>/gu, " ").replace(/&(nbsp|amp|lt|gt|quot);/giu, " ").replace(/\s+/gu, " ").trim(); }
async function modalSandboxSection(document: string): Promise<string> {
  let parsedSections = 0;
  try {
    /* HTMLRewriter is Bun's available HTML parser. CSS ID selection checks the
     * actual id attribute, unlike a textual \bid matcher that also sees data-id. */
    const parsed = new HTMLRewriter().on("section#sandboxes", { element() { parsedSections += 1; } }).transform(new Response(document));
    await parsed.text();
  } catch { throw new Error("MODAL_SANDBOX_PRICING_SECTION_REJECTED"); }
  const starts = [...document.matchAll(/<section\b(?=[^>]*\sid\s*=\s*(?:["']sandboxes["']|sandboxes(?=[\s>])))[^>]*>/giu)];
  const headings = [...document.matchAll(/<h2\b[^>]*>([\s\S]*?)<\/h2\s*>/giu)].filter((heading) => renderedText(heading[1] ?? "") === "Modal Sandbox pricing");
  if (parsedSections !== 1 || starts.length !== 1 || headings.length !== 1 || starts[0]?.index === undefined || headings[0]?.index === undefined) throw new Error("MODAL_SANDBOX_PRICING_SECTION_REJECTED");
  const start = starts[0]; const sectionTags = /<\/?section\b[^>]*>/giu; sectionTags.lastIndex = start.index + start[0].length; let depth = 1;
  for (;;) {
    const tag = sectionTags.exec(document);
    if (!tag || tag.index === undefined) throw new Error("MODAL_SANDBOX_PRICING_SECTION_REJECTED");
    depth += tag[0].startsWith("</") ? -1 : 1;
    if (depth === 0) {
      const end = tag.index + tag[0].length;
      if (headings[0].index < start.index || headings[0].index >= end) throw new Error("MODAL_SANDBOX_PRICING_SECTION_REJECTED");
      return document.slice(start.index, end);
    }
  }
}
const MAX_MODAL_SANDBOX_NODES = 512;
const MAX_MODAL_SANDBOX_DEPTH = 32;
const MAX_MODAL_SANDBOX_TEXT_BYTES = 32 * 1024;
type ModalSandboxElement = { readonly parent?: ModalSandboxElement; readonly children: ModalSandboxElement[]; readonly directText: string[]; readonly inSandbox: boolean; readonly ariaHidden: boolean; readonly className: string; };
function modalSandboxText(element: ModalSandboxElement): string {
  if (element.ariaHidden) return "";
  return renderedText(`${element.directText.join("")} ${element.children.map(modalSandboxText).join(" ")}`);
}
function modalSandboxLabel(resource: "CPU" | "Memory"): string { return `${resource} (non-preemptible)`; }
function modalSandboxLabelElement(element: ModalSandboxElement, resource: "CPU" | "Memory"): boolean { return modalSandboxText(element) === modalSandboxLabel(resource); }
function modalSandboxPriceElement(element: ModalSandboxElement, unit: "core" | "GiB"): bigint | undefined {
  const match = new RegExp(`^\\$\\s*([0-9]+(?:\\.[0-9]+)?)\\s*\\/\\s*${unit}\\s*\\/\\s*sec$`, "iu").exec(modalSandboxText(element));
  return match?.[1] ? decimalToNanos(match[1]) : undefined;
}
function isDescendant(element: ModalSandboxElement, ancestor: ModalSandboxElement): boolean {
  for (let parent = element.parent; parent; parent = parent.parent) if (parent === ancestor) return true;
  return false;
}
function innermost(elements: readonly ModalSandboxElement[]): readonly ModalSandboxElement[] { return elements.filter(element => !elements.some(other => other !== element && isDescendant(other, element))); }
function commonAncestor(first: ModalSandboxElement, second: ModalSandboxElement): ModalSandboxElement | undefined {
  const ancestors = new Set<ModalSandboxElement>();
  for (let element: ModalSandboxElement | undefined = first; element; element = element.parent) ancestors.add(element);
  for (let element: ModalSandboxElement | undefined = second; element; element = element.parent) if (ancestors.has(element)) return element;
  return undefined;
}
function modalSandboxRowBranch(row: ModalSandboxElement, descendant: ModalSandboxElement): ModalSandboxElement | undefined {
  let branch = descendant;
  while (branch.parent && branch.parent !== row) branch = branch.parent;
  return branch.parent === row ? branch : undefined;
}
function modalSandboxResourceRow(row: ModalSandboxElement): boolean {
  return row.className.split(/\s+/u).includes("resource-row") && row.children.filter(child => !child.ariaHidden).length === 2;
}
async function modalSandboxRates(document: string): Promise<Readonly<{ cpu: bigint; memory: bigint }>> {
  const stack: ModalSandboxElement[] = []; const elements: ModalSandboxElement[] = []; let sandboxRoot: ModalSandboxElement | undefined; let textBytes = 0;
  try {
    const parsed = new HTMLRewriter().on("*", {
      element(element) {
        const parent = stack.at(-1);
        const inSandbox = parent?.inSandbox === true || (element.tagName.toLowerCase() === "section" && element.getAttribute("id") === "sandboxes");
        const current: ModalSandboxElement = { ...(parent ? { parent } : {}), children: [], directText: [], inSandbox, ariaHidden: element.getAttribute("aria-hidden") === "true", className: element.getAttribute("class") ?? "" };
        if (parent) parent.children.push(current);
        if (inSandbox && !parent?.inSandbox) {
          if (sandboxRoot) throw new Error("MODAL_SANDBOX_PRICING_RATE_REJECTED");
          sandboxRoot = current;
        }
        if (inSandbox) { elements.push(current); if (elements.length > MAX_MODAL_SANDBOX_NODES || stack.length >= MAX_MODAL_SANDBOX_DEPTH) throw new Error("MODAL_SANDBOX_PRICING_RATE_REJECTED"); }
        stack.push(current);
        element.onEndTag(() => { if (stack.pop() !== current) throw new Error("MODAL_SANDBOX_PRICING_RATE_REJECTED"); });
      },
      text(chunk) { const current = stack.at(-1); if (current?.inSandbox && !current.ariaHidden && chunk.text) { textBytes += new TextEncoder().encode(chunk.text).byteLength; if (textBytes > MAX_MODAL_SANDBOX_TEXT_BYTES) throw new Error("MODAL_SANDBOX_PRICING_RATE_REJECTED"); current.directText.push(chunk.text); } },
    }).transform(new Response(document));
    await parsed.text();
  } catch { throw new Error("MODAL_SANDBOX_PRICING_RATE_REJECTED"); }
  if (!sandboxRoot || stack.length !== 0) throw new Error("MODAL_SANDBOX_PRICING_RATE_REJECTED");
  const rate = (resource: "CPU" | "Memory", unit: "core" | "GiB") => {
    const labels = innermost(elements.filter(element => element !== sandboxRoot && modalSandboxLabelElement(element, resource)));
    const prices = innermost(elements.filter(element => element !== sandboxRoot && modalSandboxPriceElement(element, unit) !== undefined));
    if (labels.length !== 1 || prices.length !== 1) throw new Error("MODAL_SANDBOX_PRICING_RATE_REJECTED");
    const row = commonAncestor(labels[0]!, prices[0]!);
    const value = modalSandboxPriceElement(prices[0]!, unit);
    const labelBranch = row ? modalSandboxRowBranch(row, labels[0]!) : undefined;
    const priceBranch = row ? modalSandboxRowBranch(row, prices[0]!) : undefined;
    const rowLabels = row ? innermost(elements.filter(element => element !== sandboxRoot && (modalSandboxLabelElement(element, "CPU") || modalSandboxLabelElement(element, "Memory")) && (element === row || isDescendant(element, row)))) : [];
    if (!row || row === sandboxRoot || !modalSandboxResourceRow(row) || !labelBranch || !priceBranch || labelBranch === priceBranch || rowLabels.length !== 1 || rowLabels[0] !== labels[0]!) throw new Error("MODAL_SANDBOX_PRICING_RATE_REJECTED");
    if (value === undefined) throw new Error("MODAL_SANDBOX_PRICING_RATE_REJECTED");
    return value;
  };
  return Object.freeze({ cpu: rate("CPU", "core"), memory: rate("Memory", "GiB") });
}
function flyMonthlyMachinePrice(document: string, preset: string, memory: string): bigint {
  const escapedPreset = preset.replace(/[.*+?^${}()|[\]\\]/gu, "\\$&"); const escapedMemory = memory.replace(/[.*+?^${}()|[\]\\]/gu, "\\$&");
  const table = new RegExp(`Started Machine,?\\s*${escapedPreset}\\s*(?:with)?\\s*${escapedMemory}[^$]{0,128}\\$\\s*([0-9]+(?:\\.[0-9]+)?)\\s*/\\s*month`, "iu").exec(document);
  if (!table?.[1]) {
    /* Retain the direct per-second representation for a source revision that
     * exposes its calculator rate rather than the documented monthly table. */
    const perSecond = new RegExp(`${escapedPreset}[\\s\\S]{0,256}?${escapedMemory}[\\s\\S]{0,256}?\\$\\s*([0-9]+(?:\\.[0-9]+)?)\\s*/\\s*(?:second|sec)`, "iu").exec(document);
    if (!perSecond?.[1]) throw new Error("OFFICIAL_SOURCE_UNIT_REJECTED");
    return decimalToNanos(perSecond[1]);
  }
  /* Fly documents its monthly examples as a 30-day continuous run and bills
   * started Machines by the second. Convert that documented unit exactly. */
  return decimalToNanos(table[1]) / (30n * 24n * 60n * 60n);
}

/** The only production pricing readers: bounded official GETs, Cloud Billing
 * service/SKU endpoints only, and opaque ADC that never leaves request memory. */
export function createOfficialPricingSources(options: OfficialPricingSourcesOptions): Readonly<{ google: GooglePublicCatalogPort; sources: OfficialPricingSourcePort & Readonly<{ readVertexGeminiPrice(): Promise<VertexGeminiPriceObservation>; readUsdSatConversion(): Promise<UsdSatConversion> }> }> {
  const now = options.now ?? Date.now;
  const freshForMs = options.freshnessMs ?? 60 * 60 * 1000;
  const timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  const selectors = options.google.selectors;
  if (!Number.isSafeInteger(freshForMs) || freshForMs <= 0 || !Number.isSafeInteger(timeoutMs) || timeoutMs < 1 || timeoutMs > 30_000 || selectors.length === 0 || selectors.some((selector) => !validIdentifier(selector.componentId) || (selector.usageType !== undefined && selector.usageType !== "OnDemand") || (selector.skuId !== undefined && !validSkuId(selector.skuId)) || (selector.skuId === undefined && selector.descriptionIncludes === undefined && selector.resourceFamily === undefined && selector.resourceGroup === undefined) || !/^[a-z][a-z0-9-]{2,63}$/u.test(selector.region)) || new Set(selectors.map((selector) => selector.componentId)).size !== selectors.length) throw new Error("OFFICIAL_SOURCE_CONFIGURATION_REJECTED");
  const snapshot = (sourceId: string, bytes: Uint8Array, quotes: readonly SourceQuote[]): SourceSnapshot => { const observedAtMs = now(); if (!Number.isSafeInteger(observedAtMs) || observedAtMs <= 0) throw new Error("OFFICIAL_SOURCE_TIME_REJECTED"); return Object.freeze({ sourceId, bytes, observedAtMs, freshUntilMs: observedAtMs + freshForMs, quotes: Object.freeze([...quotes]) }); };
  return Object.freeze({
    google: Object.freeze({
      async readCatalog(input: Parameters<GooglePublicCatalogPort["readCatalog"]>[0]) {
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
        const quotes = selected.map((selector) => { const skus = catalogs.get(selector.serviceDisplayName)!; const matches = skus.filter((sku): sku is Record<string, unknown> => !!sku && typeof sku === "object" && !Array.isArray(sku) && matchesSelector(sku as Record<string, unknown>, selector)); if (matches.length !== 1) throw new Error("OFFICIAL_SOURCE_SKU_REJECTED"); const skuId = text(matches[0]!.skuId); if (!skuId) throw new Error("OFFICIAL_SOURCE_SKU_REJECTED"); const priceNanos = googlePriceNanos(matches[0]!, selector); return Object.freeze({ provider: selector.provider, componentId: selector.componentId, skuId, region: selector.region, currency: "USD" as const, unit: selector.unit, priceMicros: nanosToMicros(priceNanos), priceNanos: priceNanos.toString() }); });
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
        const credited = /Gemini 4 Argon\*?\s*through November\s+30,?\s+2026\s+Input \(text, image, video, audio\)\s+Global\s+\$2\.00\s+\$0\.10\s+Non-global\s+\$2\.20\s+\$0\.11\s+Text output \(response and reasoning\)\s+Global\s+\$10\.00\s+\$10\.00\s+Non-global\s+\$11\.00\s+\$11\.00/iu;
        const gross = /Gemini 4 Argon\s*\(Starting December\s+1,?\s+2026\)\s*,?\s*Gemini 4 Argon Cyber Permissive\s+Input \(text, image, video, audio\)\s+Global\s+\$4\.00\s+\$0\.20\s+Non-global\s+\$4\.40\s+\$0\.22\s+Text output \(response and reasoning\)\s+Global\s+\$20\.00\s+\$20\.00\s+Non-global\s+\$22\.00\s+\$22\.00/iu;
        if (!credited.test(source) || !gross.test(source) || !/Promotional pricing provided through 50% credits back on net spend/iu.test(source)) throw new Error("VERTEX_PRICE_SOURCE_GROSS_UNPROVEN");
        const observedAtMs = now(); if (!Number.isSafeInteger(observedAtMs) || observedAtMs <= 0) throw new Error("OFFICIAL_SOURCE_TIME_REJECTED");
        return frozenVertexPrice({ bytes, observedAtMs, freshUntilMs: observedAtMs + freshForMs });
      },
      async readUsdSatConversion() {
        const bytes = await readOfficial(options.fetch, BTC_USD_TICKER_URL, undefined, timeoutMs);
        const ticker = json(bytes);
        const quotedUsdPerBtc = text(ticker.price);
        if (!quotedUsdPerBtc) throw new Error("USD_SAT_SOURCE_PARSER_DRIFT");
        const [usdPerBtc, scale] = decimalToInteger(quotedUsdPerBtc);
        const numerator = 100_000_000n * scale;
        const divisor = gcd(numerator, usdPerBtc);
        const observedAtMs = now();
        if (!Number.isSafeInteger(observedAtMs) || observedAtMs <= 0) throw new Error("OFFICIAL_SOURCE_TIME_REJECTED");
        const observedAt = new Date(observedAtMs).toISOString();
        const freshUntil = new Date(observedAtMs + freshForMs).toISOString();
        const hash = await crypto.subtle.digest("SHA-256", new Uint8Array(bytes).buffer);
        const capturedBytesSha256 = Array.from(new Uint8Array(hash), (byte) => byte.toString(16).padStart(2, "0")).join("");
        return Object.freeze({
          source: Object.freeze({ url: BTC_USD_TICKER_URL, capturedBytesSha256, observedAt, effectiveAt: observedAt, freshUntil }),
          satsPerUsd: Object.freeze({ numerator: (numerator / divisor).toString(), denominator: (usdPerBtc / divisor).toString() }),
        });
      },
      async readOfficialPricing(input: Parameters<OfficialPricingSourcePort["readOfficialPricing"]>[0]) {
        const provider = WorkerProviderSchema.parse(input.provider); const url = provider === "modal" ? MODAL_PRICING_URL : FLY_PRICING_URL; const bytes = await readOfficial(options.fetch, url, undefined, timeoutMs); const document = new TextDecoder().decode(bytes); const normalized = officialText(document);
        let priceNanos: bigint;
        if (provider === "modal") {
          const sandbox = await modalSandboxSection(document);
          const { cpu, memory } = await modalSandboxRates(sandbox);
          priceNanos = (cpu * BigInt(options.workers.modal.cpuCores) + memory * BigInt(options.workers.modal.memoryGiB)) * (options.workers.modal.unit === "worker-100-seconds" ? 100n : 1n);
        } else {
          priceNanos = flyMonthlyMachinePrice(normalized, options.workers.fly.preset, options.workers.fly.memory) * (options.workers.fly.unit === "worker-100-seconds" ? 100n : 1n);
        }
        const unit = provider === "modal" ? options.workers.modal.unit : options.workers.fly.unit;
        return snapshot(`${provider}-official-pricing`, bytes, [{ provider, componentId: `${provider}.global`, skuId: `${provider}-official`, region: "global", currency: "USD", unit, priceMicros: nanosToMicros(priceNanos), priceNanos: priceNanos.toString() }]);
      },
    }),
  });
}

function frozenVertexPrice(input: Readonly<{ bytes: Uint8Array; observedAtMs: number; freshUntilMs: number }>): VertexGeminiPriceObservation {
  return Object.freeze({ sourceUrl: VERTEX_GEMINI_PRICING_URL, bytes: input.bytes, observedAtMs: input.observedAtMs, freshUntilMs: input.freshUntilMs, currency: "USD", location: "global", model: "gemini-4-argon", effectiveFrom: "2026-10-13", effectiveUntil: "2026-11-30", inputMicrosPerMillion: 4_000_000, cachedInputMicrosPerMillion: 200_000, outputAndThoughtMicrosPerMillion: 20_000_000 });
}
