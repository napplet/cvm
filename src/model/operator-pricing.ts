import { createHash } from "node:crypto";
import { canonicalJson } from "../promotion/schema";
import { PriceCardSchema, ModelProfileSchema, type PriceCard, type ModelProfile } from "./price-card";
import { ProfitPolicySchema, type ProfitPolicy } from "./profit";

/** Base rates remain intact. Profit and USD conversion are immutable card facts. */
export function withOperatorProfit(input: { card: PriceCard; profile: ModelProfile }, policy?: ProfitPolicy) {
  if (!policy || Number(policy.setting.value) === 0) return input;
  const profit = ProfitPolicySchema.parse(policy);
  if (input.card.profit) throw new Error("PROFIT_ALREADY_APPLIED");
  const suffix = createHash("sha256").update(canonicalJson({ card: input.card.id, profile: input.profile.id, profit })).digest("hex").slice(0, 24);
  const card = PriceCardSchema.parse({ ...input.card, id: `operator-card-${suffix}`, profit });
  const profile = ModelProfileSchema.parse({ ...input.profile, id: `operator-profile-${suffix}`, priceCardId: card.id });
  return { card, profile };
}
