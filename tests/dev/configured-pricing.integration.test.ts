import { expect, test } from "bun:test";
import { createDevelopmentPool } from "../../scripts/dev-payments";
import { readDevelopmentPaymentConfig } from "./payment-config";
import { registerDevelopmentPricing } from "../../src/dev/register-development-pricing";
import { PHASE_04_DETERMINISTIC_PRICE_CARD, PHASE_04_MODEL_PROFILES } from "../../src/model/price-card";

test("configured profile/card SQL registration survives restart and rejects ID drift", async () => {
  const config = await readDevelopmentPaymentConfig();
  let pool = createDevelopmentPool(config.databaseUrl); const nonce = crypto.randomUUID();
  // Configuration-persistence fixture only: no live model request or price claim.
  const profile = { ...structuredClone(PHASE_04_MODEL_PROFILES["code-proposal"]), id: `profile:${nonce}`, priceCardId: `card:${nonce}` };
  const priceCard = { ...structuredClone(PHASE_04_DETERMINISTIC_PRICE_CARD), id: profile.priceCardId };
  try {
    await Promise.all([registerDevelopmentPricing(pool, { profile, priceCard }), registerDevelopmentPricing(pool, { profile, priceCard })]);
    expect((await pool.query("SELECT count(*)::int AS count FROM model_profile_versions WHERE id=$1", [profile.id])).rows[0]?.count).toBe(1);
    expect((await pool.query("SELECT count(*)::int AS count FROM price_card_versions WHERE id=$1 AND profile_id=$2", [priceCard.id, profile.id])).rows[0]?.count).toBe(1);
    await pool.end(); pool = createDevelopmentPool(config.databaseUrl);
    await registerDevelopmentPricing(pool, { profile, priceCard });
    await expect(registerDevelopmentPricing(pool, { profile: { ...profile, deadlineMs: profile.deadlineMs + 1 }, priceCard })).rejects.toThrow("DEV_MODEL_PROFILE_ID_CONFLICT");
    await expect(registerDevelopmentPricing(pool, { profile, priceCard: { ...priceCard, version: "changed" } })).rejects.toThrow("DEV_PRICE_CARD_ID_CONFLICT");
    await expect(registerDevelopmentPricing(pool, { profile: { ...profile, priceCardId: "wrong-card" }, priceCard })).rejects.toThrow("DEV_PRICING_IDENTITY_MISMATCH");
    expect((await pool.query("SELECT normalized_profile FROM model_profile_versions WHERE id=$1", [profile.id])).rows[0]?.normalized_profile).toEqual(profile);
    expect((await pool.query("SELECT normalized_card FROM price_card_versions WHERE id=$1", [priceCard.id])).rows[0]?.normalized_card).toEqual(priceCard);
  } finally {
    await pool.query("DELETE FROM price_card_versions WHERE id=$1", [priceCard.id]); await pool.query("DELETE FROM model_profile_versions WHERE id=$1", [profile.id]); await pool.end();
  }
});
