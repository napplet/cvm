import { z } from "zod";
import { CanonicalSatSchema, ResumePendingApprovalSchema, ResumeSessionCommandSchema, ResumeSessionResultSchema } from "./contracts";
import { ResumePricingApprovalSchema, type ResumePricingQuote } from "./resume-pricing";
import { canonicalJson } from "../promotion/schema";

const Identity = z.string().min(1).max(256);
const Digest = z.string().regex(/^[a-f0-9]{64}$/u);

/** Separate schemas keep the existing strict v1 request/result unions intact.
 * Principal is supplied only by the verified ContextVM adapter. */
export const PrepareResumeCommandSchema = z.object({
  principal: z.object({ id: Identity }).strict(), sessionId: Identity, checkpointId: Identity,
  expectedSessionVersion: z.number().int().nonnegative(), expectedCheckpointVersion: z.literal(1),
  idempotencyKey: z.string().min(1).max(160),
}).strict();
export const PrepareResumeArgumentsSchema = PrepareResumeCommandSchema.omit({ principal: true });
export const ResumeSessionV2CommandSchema = ResumeSessionCommandSchema.extend({ idempotencyKey: z.string().min(1).max(160), pricingApproval: ResumePricingApprovalSchema }).strict();
export const ResumeSessionV2ArgumentsSchema = ResumeSessionV2CommandSchema.omit({ principal: true });

export const QuotedResumeResultSchema = z.object({
  status: z.literal("quoted"), quoteReference: Identity, quoteSha256: Digest,
  expiresAtMs: z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER),
  pendingAction: ResumePendingApprovalSchema,
  pricing: z.object({
    profileId: Identity, priceCardId: Identity, currency: z.literal("usd_micros"),
    maximumUsdMicros: CanonicalSatSchema, maximumSat: CanonicalSatSchema,
    priceSourcesSha256: Digest, conversionSha256: Digest,
  }).strict(),
}).strict();
export const PrepareResumeResultSchema = z.discriminatedUnion("status", [
  QuotedResumeResultSchema,
  z.object({ status: z.literal("denied"), code: z.enum(["RESUME_CHECKPOINT_NOT_FOUND_OR_DENIED", "RESUME_INVALID_COMMAND", "RESUME_STALE_OR_CONFLICTING"]) }).strict(),
  z.object({ status: z.literal("blocked"), code: z.enum(["RESUME_PRICE_AUTHORITY_UNAVAILABLE", "RESUME_QUOTE_EXCEEDS_COMMAND_MAXIMUM", "RESUME_COMPATIBILITY_DENIED", "RESUME_CAP_APPROVAL_REQUIRED"]) }).strict(),
]);
export const ResumeSessionV2ResultSchema = z.union([
  ResumeSessionResultSchema,
  z.object({ status: z.literal("denied"), code: z.enum(["RESUME_QUOTE_NOT_FOUND_OR_DENIED", "RESUME_QUOTE_EXPIRED", "RESUME_QUOTE_APPROVAL_MISMATCH", "RESUME_QUOTE_CONTEXT_MISMATCH", "RESUME_QUOTE_SUPERSESSION_REQUIRED", "RESUME_CAP_APPROVAL_REQUIRED"]) }).strict(),
]);

/** Approval projection deliberately omits account, encrypted command, keys,
 * checkpoint object addresses, API credentials and original receipt material. */
export async function projectResumePricingQuote(quote: ResumePricingQuote): Promise<z.infer<typeof QuotedResumeResultSchema>> {
  const conversionSha256 = Buffer.from(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(canonicalJson(quote.pricing.conversion)))).toString("hex");
  return QuotedResumeResultSchema.parse({ status: "quoted", quoteReference: quote.quoteReference, quoteSha256: quote.quoteSha256,
    expiresAtMs: quote.expiresAtMs, pendingAction: quote.context.pendingAction,
    pricing: { profileId: quote.pricing.profile.id, priceCardId: quote.pricing.card.id, currency: "usd_micros",
      maximumUsdMicros: quote.maximumUsdMicros, maximumSat: quote.maximumSat, priceSourcesSha256: quote.priceSourcesSha256, conversionSha256 } });
}
