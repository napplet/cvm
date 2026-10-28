import { z } from "zod";
import { createVertexGeminiProductionPricing, UsdSatConversionSchema } from "../model/price-card";
import type { ProductionConfig } from "./config";
import type { MountedProductionSecretMaterial } from "./secret-material";

const Digest = z.string().regex(/^[a-f0-9]{64}$/u);
const Positive = z.number().int().positive();
const Material = z.object({
  credentialReference: z.string().regex(/^gcp:adc:[a-z][a-z0-9:_-]{2,127}$/u),
  price: z.object({
    sourceUrl: z.string().url().refine(value => new URL(value).hostname === "cloud.google.com"),
    sourceDocumentBase64: z.string().min(4).max(11_200_000),
    sourceDocumentSha256: Digest,
    quoteSha256: Digest,
    observedAtMs: Positive,
    freshUntilMs: Positive,
    effectiveFromMs: Positive,
    effectiveUntilMs: Positive,
    inputMicrosPerMillion: Positive,
    cachedInputMicrosPerMillion: Positive,
    outputAndThoughtMicrosPerMillion: Positive,
  }).strict(),
  conversion: UsdSatConversionSchema,
}).strict();

const canonical = (value: unknown) => JSON.stringify(value);
async function sha256(value: string | Uint8Array): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", (typeof value === "string" ? new TextEncoder().encode(value) : value) as BufferSource);
  return Array.from(new Uint8Array(digest), byte => byte.toString(16).padStart(2, "0")).join("");
}

/**
 * Loads the ADC locator and current immutable Vertex quote from a closed
 * coordinator mount.  The source document is hashed before pricing is made;
 * a stale or substituted quote prevents startup before any billable request.
 */
export async function createMountedVertexMaterial(input: Readonly<{ config: ProductionConfig; secrets: MountedProductionSecretMaterial; now?: () => number }>) {
  const parsed = Material.parse(JSON.parse(await input.secrets.text("vertex.credentialReference", 11_500_000)));
  const sourceBytes = new Uint8Array(Buffer.from(parsed.price.sourceDocumentBase64, "base64"));
  if (!sourceBytes.byteLength || sourceBytes.byteLength > 8 * 1024 * 1024 || Buffer.from(sourceBytes).toString("base64") !== parsed.price.sourceDocumentBase64) throw new Error("PRODUCTION_VERTEX_PRICE_SOURCE_INVALID");
  if (await sha256(sourceBytes) !== parsed.price.sourceDocumentSha256) throw new Error("PRODUCTION_VERTEX_PRICE_SOURCE_DIGEST_INVALID");
  const quote = {
    sourceUrl: parsed.price.sourceUrl, sourceDocumentSha256: parsed.price.sourceDocumentSha256,
    observedAtMs: parsed.price.observedAtMs, freshUntilMs: parsed.price.freshUntilMs,
    effectiveFromMs: parsed.price.effectiveFromMs, effectiveUntilMs: parsed.price.effectiveUntilMs,
    inputMicrosPerMillion: parsed.price.inputMicrosPerMillion,
    cachedInputMicrosPerMillion: parsed.price.cachedInputMicrosPerMillion,
    outputAndThoughtMicrosPerMillion: parsed.price.outputAndThoughtMicrosPerMillion,
  };
  if (await sha256(canonical(quote)) !== parsed.price.quoteSha256 || parsed.price.quoteSha256 !== input.config.vertex.priceSnapshotSha256) throw new Error("PRODUCTION_VERTEX_PRICE_SNAPSHOT_BINDING_INVALID");
  const now = input.now ?? Date.now;
  if (now() < quote.observedAtMs || now() >= quote.freshUntilMs || now() < quote.effectiveFromMs || now() >= quote.effectiveUntilMs) throw new Error("PRODUCTION_VERTEX_PRICE_SNAPSHOT_STALE");
  const pricing = await createVertexGeminiProductionPricing({
    observation: { ...quote, bytes: sourceBytes, currency: "USD", location: "global", model: "gemini-4-argon" },
    conversion: parsed.conversion, profileId: "vertex-gemini-4-argon-production-v1",
    maximumInputTokens: "4000", maximumOutputTokens: "4096", deadlineMs: 540_000,
  });
  return Object.freeze({ credentialReference: parsed.credentialReference, vertexPrice: Object.freeze({ ...quote, currency: "USD" as const }), pricing });
}
