import { createHash } from "node:crypto";
import { bindAccountingRealmPool, createAccountingRealm } from "../funding/accounting-realm";
import { ModelProfileSchema, PriceCardSchema } from "../model/price-card";
import type { PostgresSqlPool } from "../persistence/postgres-sql-funding-store";
import { canonicalJson } from "../promotion/schema";

const hash = (value: string) => createHash("sha256").update(value).digest("hex");
/** Install only already captured production pricing before serving admissions.
 * The source materializer owns source/hash/freshness checks. IDs and canonical
 * content are immutable; concurrent starts may replay but never overwrite them.
 * Historical cards remain available for exact original-receipt recovery. */
export async function registerProductionPricing(input: Readonly<{ pool: PostgresSqlPool; profile: unknown; card: unknown }>): Promise<void> {
  const profile = ModelProfileSchema.parse(input.profile), card = PriceCardSchema.parse(input.card);
  if (card.kind !== "source_attributed_provider" || card.currency !== "usd_micros" || card.provider !== "vertex_ai_gemini"
    || profile.provider !== card.provider || profile.model !== "gemini-4-argon" || profile.priceCardId !== card.id) throw new Error("PRODUCTION_PRICING_AUTHORITY_REQUIRED");
  const pool = bindAccountingRealmPool(input.pool, createAccountingRealm("production-real"));
  const profileBytes = canonicalJson(profile), cardBytes = canonicalJson(card);
  const profileHash = hash(profileBytes), cardHash = hash(cardBytes);
  for (let attempt = 0; attempt < 4; attempt++) {
    const client = await pool.connect();
    try {
      await client.query("BEGIN ISOLATION LEVEL SERIALIZABLE");
      await client.query("SET LOCAL lock_timeout = '1s'");
      await client.query("SET LOCAL statement_timeout = '5s'");
      const privilege = (await client.query<{ mutable: boolean }>("SELECT has_table_privilege(current_user,'production_real.model_profile_versions','UPDATE') OR has_table_privilege(current_user,'production_real.price_card_versions','UPDATE') AS mutable")).rows[0];
      if (!privilege || privilege.mutable) throw new Error("PRODUCTION_PRICING_IMMUTABLE_SCHEMA_REQUIRED");
      await client.query("INSERT INTO production_real.model_profile_versions(id,profile_hash,provider,model,normalized_profile) VALUES($1,$2,$3,$4,$5::jsonb) ON CONFLICT(id) DO NOTHING", [profile.id, profileHash, profile.provider, profile.model, profileBytes]);
      const savedProfile = (await client.query<{ profile_hash: string; provider: string; model: string; normalized_profile: unknown }>("SELECT profile_hash,provider,model,normalized_profile FROM production_real.model_profile_versions WHERE id=$1", [profile.id])).rows[0];
      if (!savedProfile || savedProfile.profile_hash !== profileHash || savedProfile.provider !== profile.provider || savedProfile.model !== profile.model || canonicalJson(savedProfile.normalized_profile) !== profileBytes) throw new Error("PRODUCTION_MODEL_PROFILE_VERSION_CONFLICT");
      // `unit` is the monetary ledger unit. Provider currency and exact FX
      // provenance remain in normalized_card; USD usage is converted at settlement.
      await client.query("INSERT INTO production_real.price_card_versions(id,card_hash,profile_id,unit,normalized_card) VALUES($1,$2,$3,'sat',$4::jsonb) ON CONFLICT(id) DO NOTHING", [card.id, cardHash, profile.id, cardBytes]);
      const savedCard = (await client.query<{ card_hash: string; profile_id: string; unit: string; normalized_card: unknown }>("SELECT card_hash,profile_id,unit,normalized_card FROM production_real.price_card_versions WHERE id=$1", [card.id])).rows[0];
      if (!savedCard || savedCard.card_hash !== cardHash || savedCard.profile_id !== profile.id || savedCard.unit !== "sat" || canonicalJson(savedCard.normalized_card) !== cardBytes) throw new Error("PRODUCTION_PRICE_CARD_VERSION_CONFLICT");
      await client.query("COMMIT"); return;
    } catch (error) {
      await client.query("ROLLBACK").catch(() => undefined);
      const code = error && typeof error === "object" && "code" in error ? String(error.code) : "";
      if (attempt === 3 || !["40001", "40P01", "23505"].includes(code)) throw error;
    } finally { client.release(); }
  }
}
