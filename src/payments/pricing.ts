import { z } from "zod";

/** Provider USD prices become credits using an operator policy, independent of payment methods. */
export function creditsPerToken(usdPerMillion: string, creditsPerUsd: Readonly<{ numerator: string; denominator: string }>) {
  const price = z.string().regex(/^(?:0|[1-9][0-9]{0,11})(?:\.[0-9]{1,8})?$/u).parse(usdPerMillion);
  const positive = z.string().regex(/^[1-9][0-9]{0,35}$/u);
  const [whole, fractional = ""] = price.split(".");
  let numerator = BigInt(whole! + fractional) * BigInt(positive.parse(creditsPerUsd.numerator));
  let denominator = 10n ** BigInt(fractional.length) * 1_000_000n * BigInt(positive.parse(creditsPerUsd.denominator));
  if (numerator <= 0n) throw new Error("CREDIT_PROVIDER_PRICE_INVALID");
  let left = numerator, right = denominator;
  while (right) [left, right] = [right, left % right];
  numerator /= left; denominator /= left;
  return Object.freeze({ numerator: numerator.toString(), denominator: denominator.toString() });
}
