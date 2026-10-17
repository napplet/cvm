import { z } from "zod";
import { quoteStatus, type ExchangeRate } from "../currency/btc-usd";

const Amount = z.string().regex(/^(?:0|[1-9]\d{0,8})(?:\.\d{1,6})?$/u);
export const ProfitSettingSchema = z.object({ mode: z.enum(["percentage", "sats", "usd"]), value: Amount }).strict();
export type ProfitSetting = z.infer<typeof ProfitSettingSchema>;
export const ProfitPolicySchema = z.object({
  setting: ProfitSettingSchema,
  satsPerThousand: z.object({ numerator: z.string().regex(/^\d{1,40}$/u), denominator: z.string().regex(/^[1-9]\d{0,40}$/u) }).strict().optional(),
  conversion: z.object({ source: z.literal("Kraken"), usdPerBtc: z.string().regex(/^[0-9]{1,12}(?:\.[0-9]{1,8})?$/u), fetchedAt: z.number().finite() }).strict().optional(),
}).strict().superRefine((policy, ctx) => {
  if (policy.setting.mode !== "percentage" && !policy.satsPerThousand) ctx.addIssue({ code: "custom", message: "Fixed profit requires a pinned sat rate per 1,000 billed tokens" });
  if (policy.setting.mode === "usd" && !policy.conversion) ctx.addIssue({ code: "custom", message: "USD profit requires a pinned quote" });
});
export type ProfitPolicy = z.infer<typeof ProfitPolicySchema>;
export const ZERO_PROFIT: ProfitSetting = { mode: "percentage", value: "0" };

function fraction(value: string) {
  const [whole, tail = ""] = value.split(".");
  return { numerator: BigInt(whole! + tail), denominator: 10n ** BigInt(tail.length) };
}
export function resolveProfit(input: ProfitSetting, exchangeRate?: ExchangeRate, now = Date.now()): ProfitPolicy {
  const setting = ProfitSettingSchema.parse(input), value = fraction(setting.value);
  if (value.numerator === 0n) return { setting: ZERO_PROFIT };
  if (setting.mode === "percentage") return { setting };
  if (setting.mode === "sats") return { setting, satsPerThousand: { numerator: value.numerator.toString(), denominator: value.denominator.toString() } };
  if (quoteStatus(exchangeRate, now) !== "fresh") throw new Error("FRESH_BTC_USD_QUOTE_REQUIRED");
  const conversion = exchangeRate!.quote!, btc = fraction(conversion.usdPerBtc);
  return ProfitPolicySchema.parse({ setting, conversion, satsPerThousand: {
    numerator: (value.numerator * 100_000_000n * btc.denominator).toString(), denominator: (value.denominator * btc.numerator).toString(),
  } });
}

/** Fixed profit is prorated over the sum of nonoverlapping billed token categories. */
export function profitCharge(base: bigint, billedTokens: bigint, policy?: ProfitPolicy): bigint {
  if (!policy || base === 0n) return 0n;
  const value = policy.setting.mode === "percentage" ? fraction(policy.setting.value) : undefined;
  const numerator = value ? base * value.numerator : billedTokens * BigInt(policy.satsPerThousand!.numerator);
  const denominator = value ? value.denominator * 100n : BigInt(policy.satsPerThousand!.denominator) * 1000n;
  return (numerator + denominator - 1n) / denominator;
}
