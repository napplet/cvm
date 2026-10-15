import { ModelProfileSchema, PriceCardSchema } from "../model/price-card";
import { canonicalJson } from "../promotion/schema";
import type { PostgresSqlPool } from "../persistence/postgres-sql-funding-store";

/** Register already-configured pricing before SQL admission. IDs are immutable. */
export async function registerDevelopmentPricing(pool: PostgresSqlPool, input: Readonly<{ profile: unknown; priceCard: unknown }>): Promise<void> {
  const profile = ModelProfileSchema.parse(input.profile); const card = PriceCardSchema.parse(input.priceCard);
  if (profile.priceCardId !== card.id || profile.provider !== card.provider) throw new Error("DEV_PRICING_IDENTITY_MISMATCH");
  const profileBytes = canonicalJson(profile); const cardBytes = canonicalJson(card);
  const hash = (value: string) => new Bun.CryptoHasher("sha256").update(value).digest("hex");
  const profileHash = hash(profileBytes); const cardHash = hash(cardBytes);
  for (let attempt = 0; attempt < 3; attempt++) {
    const client = await pool.connect();
    try {
      await client.query("BEGIN ISOLATION LEVEL SERIALIZABLE");
      await client.query("INSERT INTO model_profile_versions(id,profile_hash,provider,model,normalized_profile) VALUES ($1,$2,$3,$4,$5) ON CONFLICT (id) DO NOTHING", [profile.id, profileHash, profile.provider, profile.model, profileBytes]);
      const savedProfile = (await client.query<{ profile_hash: string; normalized_profile: unknown }>("SELECT profile_hash,normalized_profile FROM model_profile_versions WHERE id=$1", [profile.id])).rows[0];
      if (savedProfile?.profile_hash !== profileHash || canonicalJson(savedProfile.normalized_profile) !== profileBytes) throw new Error("DEV_MODEL_PROFILE_ID_CONFLICT:use a new profile version ID");
      await client.query("INSERT INTO price_card_versions(id,card_hash,profile_id,unit,normalized_card) VALUES ($1,$2,$3,'sat',$4) ON CONFLICT (id) DO NOTHING", [card.id, cardHash, profile.id, cardBytes]);
      const savedCard = (await client.query<{ card_hash: string; profile_id: string; normalized_card: unknown }>("SELECT card_hash,profile_id,normalized_card FROM price_card_versions WHERE id=$1", [card.id])).rows[0];
      if (savedCard?.card_hash !== cardHash || savedCard.profile_id !== profile.id || canonicalJson(savedCard.normalized_card) !== cardBytes) throw new Error("DEV_PRICE_CARD_ID_CONFLICT:use a new price-card version ID");
      await client.query("COMMIT"); return;
    } catch (error) {
      await client.query("ROLLBACK");
      const code = (error as { code?: string }).code;
      // Concurrent registrations can first collide on the unique content hash
      // rather than the targeted ID. Retry, then verify the immutable row.
      const constraint = (error as { constraint?: string }).constraint;
      const hashRace = code === "23505" && ["model_profile_versions_profile_hash_key", "price_card_versions_card_hash_key"].includes(constraint ?? "");
      if (attempt === 2 || (code !== "40001" && code !== "40P01" && !hashRace)) throw error;
    } finally { client.release(); }
  }
}
