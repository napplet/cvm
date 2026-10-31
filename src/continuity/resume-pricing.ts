import { z } from "zod";
import { canonicalJson } from "../promotion/schema";
import { ModelProfileSchema, PriceCardSchema, UsdSatConversionSchema, convertUsdMicrosToSats, maximumOperationCharge } from "../model/price-card";
import { CanonicalSatSchema, ResumePendingApprovalSchema } from "./contracts";

const Digest = z.string().regex(/^[a-f0-9]{64}$/u);
const Time = z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER);
const Identity = z.string().min(1).max(256);

/** Loaded from the owned checkpoint and authenticated retained command, never
 * from the quote caller. The old estimate remains part of the original binding;
 * a fresh estimate may change only within the original command maximum. */
export const ResumePricingContextSchema = z.object({
  realm: z.literal("production-real"), accountId: Identity, sessionId: Identity,
  checkpointId: Identity, checkpointSha256: Digest, checkpointVersion: z.literal(1),
  expectedSessionVersion: z.number().int().nonnegative(), expectedArtifactVersion: z.number().int().nonnegative(),
  pendingAction: ResumePendingApprovalSchema,
  commandSha256: Digest, originalOperationId: Identity, originalSettlementSha256: Digest,
  originalCommandMaximum: CanonicalSatSchema, policyVersion: Identity, toolchainId: Identity,
  retentionUntilMs: Time,
}).strict();
export type ResumePricingContext = z.infer<typeof ResumePricingContextSchema>;

const Pricing = z.object({ profile: ModelProfileSchema, card: PriceCardSchema, conversion: UsdSatConversionSchema }).strict();
const QuoteBody = z.object({
  schemaVersion: z.literal("resume-pricing-quote-v1"), context: ResumePricingContextSchema,
  preparationKey: Identity, preparedAtMs: Time, expiresAtMs: Time, pricing: Pricing,
  sourceProfile: ModelProfileSchema, sourceProfileSha256: Digest, derivedProfileSha256: Digest,
  maximumUsdMicros: CanonicalSatSchema, maximumSat: CanonicalSatSchema, priceSourcesSha256: Digest,
}).strict();
export const ResumePricingQuoteSchema = QuoteBody.extend({ quoteReference: Identity, quoteSha256: Digest }).strict();
export type ResumePricingQuote = z.infer<typeof ResumePricingQuoteSchema>;
export const ResumePricingApprovalSchema = z.object({ quoteReference: Identity, quoteSha256: Digest, maximumSat: CanonicalSatSchema }).strict();
export type ResumePricingApproval = z.infer<typeof ResumePricingApprovalSchema>;

const hash = async (value: unknown): Promise<string> => Buffer.from(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(canonicalJson(value)))).toString("hex");

/** Pure proposal construction. Its caller must use verified server pricing and
 * persist the exact result immutably. A digest alone is not price provenance or
 * owner consent. This function has no funding, worker or provider dependency. */
export async function prepareResumePricingQuote(input: Readonly<{
  context: unknown; pricing: unknown; sourceProfile?: unknown; preparationKey: string; nowMs: number; lifetimeMs: number;
}>): Promise<ResumePricingQuote> {
  const context = ResumePricingContextSchema.parse(input.context), pricing = Pricing.parse(input.pricing);
  const sourceProfile = ModelProfileSchema.parse(input.sourceProfile ?? pricing.profile);
  const preparedAtMs = Time.parse(input.nowMs), lifetimeMs = z.number().int().positive().max(300_000).parse(input.lifetimeMs);
  const { card, profile, conversion } = pricing;
  if (card.currency !== "usd_micros" || card.kind !== "source_attributed_provider" || card.provider !== "vertex_ai_gemini"
    || profile.provider !== card.provider || profile.model !== "gemini-4-argon" || profile.priceCardId !== card.id || !card.sources
    || canonicalJson(card.sources.conversion) !== canonicalJson(conversion.source)) throw new Error("RESUME_PRICE_AUTHORITY_INVALID");
  const sourceProfileSha256 = await hash(sourceProfile), derivedProfileSha256 = await hash(profile);
  const sameProfile = canonicalJson(sourceProfile) === canonicalJson(profile);
  if (sourceProfile.provider !== profile.provider || sourceProfile.model !== profile.model || sourceProfile.priceCardId !== profile.priceCardId
    || sourceProfile.selection !== profile.selection || sourceProfile.deadlineMs !== profile.deadlineMs
    || sourceProfile.maximumUnits.length !== profile.maximumUnits.length
    || sourceProfile.maximumUnits.some((item, index) => item.dimension !== profile.maximumUnits[index]?.dimension || BigInt(profile.maximumUnits[index]!.units) > BigInt(item.units)))
    throw new Error("RESUME_DERIVED_PROFILE_INVALID");
  if (!sameProfile && profile.id !== `resume-derived:${await hash({ sourceProfileSha256, maximumUnits: profile.maximumUnits })}`)
    throw new Error("RESUME_DERIVED_PROFILE_INVALID");
  const starts = [card.validity.notBefore, card.sources.provider.observedAt, card.sources.provider.effectiveAt, conversion.source.observedAt, conversion.source.effectiveAt].map(Date.parse);
  const ends = [card.validity.notAfter, card.sources.provider.freshUntil, conversion.source.freshUntil].map(Date.parse);
  const expiresAtMs = Math.min(preparedAtMs + lifetimeMs, context.retentionUntilMs, ...ends);
  if (starts.some(start => !Number.isSafeInteger(start) || start > preparedAtMs)
    || ends.some(end => !Number.isSafeInteger(end)) || !Number.isSafeInteger(expiresAtMs) || expiresAtMs <= preparedAtMs) throw new Error("RESUME_PRICE_AUTHORITY_STALE");
  const maximumUsdMicros = maximumOperationCharge({ card, profile });
  const maximumSat = convertUsdMicrosToSats({ usdMicros: Number(maximumUsdMicros), conversion, at: new Date(preparedAtMs).toISOString() }).amount;
  if (BigInt(maximumSat) > BigInt(context.originalCommandMaximum)) throw new Error("RESUME_QUOTE_EXCEEDS_COMMAND_MAXIMUM");
  const body = QuoteBody.parse({ schemaVersion: "resume-pricing-quote-v1", context, preparationKey: input.preparationKey,
    preparedAtMs, expiresAtMs, pricing, sourceProfile, sourceProfileSha256, derivedProfileSha256,
    maximumUsdMicros, maximumSat, priceSourcesSha256: await hash(card.sources) });
  const quoteSha256 = await hash(body);
  return ResumePricingQuoteSchema.parse({ ...body, quoteSha256, quoteReference: `resume-quote:${quoteSha256}` });
}

/** Revalidate an owner-scoped immutable database record at the first-dispatch
 * boundary. Never accept a caller-supplied quote document in place of the saved
 * record. Already claimed operations reconcile against their accepted binding;
 * this check must not be bypassed with a caller-controlled "replay" flag. */
export async function verifyStoredResumePricingQuote(input: Readonly<{
  stored: unknown; expectedContext: unknown; approval: unknown; nowMs: number;
}>): Promise<ResumePricingQuote> {
  const quote = ResumePricingQuoteSchema.parse(input.stored), context = ResumePricingContextSchema.parse(input.expectedContext);
  const approval = ResumePricingApprovalSchema.parse(input.approval), nowMs = Time.parse(input.nowMs);
  if (canonicalJson(context) !== canonicalJson(quote.context)) throw new Error("RESUME_QUOTE_CONTEXT_MISMATCH");
  if (approval.quoteReference !== quote.quoteReference || approval.quoteSha256 !== quote.quoteSha256 || approval.maximumSat !== quote.maximumSat) throw new Error("RESUME_QUOTE_APPROVAL_MISMATCH");
  if (nowMs < quote.preparedAtMs || nowMs >= quote.expiresAtMs) throw new Error("RESUME_QUOTE_EXPIRED");
  const rebuilt = await prepareResumePricingQuote({ context, pricing: quote.pricing, preparationKey: quote.preparationKey,
    sourceProfile: quote.sourceProfile, nowMs: quote.preparedAtMs, lifetimeMs: quote.expiresAtMs - quote.preparedAtMs });
  if (canonicalJson(rebuilt) !== canonicalJson(quote)) throw new Error("RESUME_QUOTE_RECORD_INVALID");
  return quote;
}
