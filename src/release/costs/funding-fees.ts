import { canonicalJson } from "../../promotion/schema";
import type { UsdSatConversion } from "../../model/price-card";

type FeeFact = Readonly<{ provider: "cep8_lightning" | "cashu"; sourceId: string; sourceDocumentSha256: string; quoteSha256: string; currency: "USD"; unit: "operation"; priceMicros: number; observedAtMs: number; freshUntilMs: number }>;
export type SealedFundingFeePolicyProjection = Readonly<{
  observedAtMs: number; freshUntilMs: number;
  nwc: Readonly<{ maximumReceiverFeeSats: string; policySha256: string }>;
  cashu: Readonly<{ maximumProofs: number; mints: readonly Readonly<{ url: string; keysetIds: readonly string[] }>[] }>;
}>;

async function hash(value: Uint8Array | unknown): Promise<string> {
  const bytes = value instanceof Uint8Array ? value : new TextEncoder().encode(canonicalJson(value));
  const digest = await crypto.subtle.digest("SHA-256", new Uint8Array(bytes).buffer);
  return Array.from(new Uint8Array(digest), byte => byte.toString(16).padStart(2, "0")).join("");
}
function ceil(left: bigint, right: bigint): bigint { return (left + right - 1n) / right; }
function parseSats(value: string): bigint { if (!/^(?:0|[1-9][0-9]*)$/u.test(value)) throw new Error("FUNDING_FEE_POLICY_INVALID"); return BigInt(value); }
function usdMicros(sats: bigint, conversion: UsdSatConversion): number {
  const value = ceil(sats * 1_000_000n * BigInt(conversion.satsPerUsd.denominator), BigInt(conversion.satsPerUsd.numerator));
  if (value > BigInt(Number.MAX_SAFE_INTEGER)) throw new Error("FUNDING_FEE_POLICY_INVALID");
  return Number(value);
}
async function mintFee(fetcher: typeof fetch, mint: { url: string; keysetIds: readonly string[] }): Promise<Readonly<{ bytes: Uint8Array; feePpk: number }>> {
  const base = new URL(mint.url);
  if (base.protocol !== "https:" || base.username || base.password || base.search || base.hash || mint.keysetIds.length === 0) throw new Error("FUNDING_FEE_POLICY_INVALID");
  const response = await fetcher(`${base.toString().replace(/\/$/u, "")}/v1/keysets`, { method: "GET", redirect: "error", headers: { accept: "application/json" } });
  if (!response.ok || response.redirected) throw new Error("CASHU_MINT_FEE_DISCOVERY_FAILED");
  const bytes = new Uint8Array(await response.arrayBuffer());
  if (bytes.byteLength === 0 || bytes.byteLength > 1_000_000) throw new Error("CASHU_MINT_FEE_DISCOVERY_FAILED");
  let body: unknown; try { body = JSON.parse(new TextDecoder().decode(bytes)); } catch { throw new Error("CASHU_MINT_FEE_DISCOVERY_FAILED"); }
  const keysets = body && typeof body === "object" && !Array.isArray(body) ? (body as { keysets?: unknown }).keysets : undefined;
  if (!Array.isArray(keysets)) throw new Error("CASHU_MINT_FEE_DISCOVERY_FAILED");
  const selected = keysets.filter((value): value is { id: string; input_fee_ppk: number } => !!value && typeof value === "object" && typeof (value as { id?: unknown }).id === "string" && mint.keysetIds.includes((value as { id: string }).id) && Number.isSafeInteger((value as { input_fee_ppk?: unknown }).input_fee_ppk) && (value as { input_fee_ppk: number }).input_fee_ppk >= 0);
  if (selected.length !== mint.keysetIds.length) throw new Error("CASHU_MINT_FEE_DISCOVERY_FAILED");
  return Object.freeze({ bytes, feePpk: Math.max(...selected.map(value => value.input_fee_ppk)) });
}

/** Builds fee facts from an already sealed controller projection. It never
 * chooses a mint or wallet; no projection means consent is genuinely absent. */
export function createOfficialFundingRailFeePort(input: Readonly<{ policy: SealedFundingFeePolicyProjection; readUsdSatConversion(): Promise<UsdSatConversion>; fetch?: typeof fetch; now?: () => number }>): Readonly<{ readFeeFacts(): Promise<readonly FeeFact[]> }> {
  const fetcher = input.fetch ?? fetch; const now = input.now ?? Date.now;
  return Object.freeze({ async readFeeFacts() {
    const policy = input.policy; const at = now();
    if (!Number.isSafeInteger(at) || at <= 0 || at < policy.observedAtMs || at >= policy.freshUntilMs || !Number.isSafeInteger(policy.cashu.maximumProofs) || policy.cashu.maximumProofs < 1 || policy.cashu.maximumProofs > 10_000 || policy.cashu.mints.length === 0 || !/^[a-f0-9]{64}$/u.test(policy.nwc.policySha256)) throw new Error("FUNDING_FEE_POLICY_CONSENT_REQUIRED");
    const conversion = await input.readUsdSatConversion();
    const mintFacts = await Promise.all(policy.cashu.mints.map(mint => mintFee(fetcher, mint)));
    const cashuSats = mintFacts.reduce((maximum, fact) => {
      const fee = ceil(BigInt(policy.cashu.maximumProofs) * BigInt(fact.feePpk), 1_000n);
      return fee > maximum ? fee : maximum;
    }, 0n);
    const cashuBytes = new Uint8Array(mintFacts.reduce((total, fact) => total + fact.bytes.byteLength, 0)); let offset = 0;
    for (const fact of mintFacts) { cashuBytes.set(fact.bytes, offset); offset += fact.bytes.byteLength; }
    const observedAtMs = at; const freshUntilMs = Math.min(policy.freshUntilMs, Date.parse(conversion.source.freshUntil));
    if (!Number.isSafeInteger(freshUntilMs) || freshUntilMs <= observedAtMs) throw new Error("FUNDING_FEE_POLICY_CONSENT_REQUIRED");
    const cashuSource = await hash(cashuBytes); const nwcSource = await hash({ policySha256: policy.nwc.policySha256, maximumReceiverFeeSats: policy.nwc.maximumReceiverFeeSats, conversion: conversion.source });
    const cashuQuote = await hash({ cashuSource, maximumProofs: policy.cashu.maximumProofs, cashuSats: cashuSats.toString(), conversion });
    const nwcSats = parseSats(policy.nwc.maximumReceiverFeeSats); const nwcQuote = await hash({ nwcSource, nwcSats: nwcSats.toString(), conversion });
    return Object.freeze([
      Object.freeze({ provider: "cep8_lightning" as const, sourceId: "nwc-receiver-fee-policy-v1", sourceDocumentSha256: nwcSource, quoteSha256: nwcQuote, currency: "USD" as const, unit: "operation" as const, priceMicros: usdMicros(nwcSats, conversion), observedAtMs, freshUntilMs }),
      Object.freeze({ provider: "cashu" as const, sourceId: "cashu-approved-mint-fee-v1", sourceDocumentSha256: cashuSource, quoteSha256: cashuQuote, currency: "USD" as const, unit: "operation" as const, priceMicros: usdMicros(cashuSats, conversion), observedAtMs, freshUntilMs }),
    ]);
  } });
}
