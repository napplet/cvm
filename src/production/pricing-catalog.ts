import { createHash } from "node:crypto";
import { bindAccountingRealmPool, createAccountingRealm } from "../funding/accounting-realm";
import { ModelProfileSchema, PriceCardSchema } from "../model/price-card";
import type { PostgresSqlPool } from "../persistence/postgres-sql-funding-store";
import type { RetainedGenerationPricing } from "../phase-04/metered-generation-service";
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

/** Read-only authority for an existing action, never a fresh quote. All tuple
 * fields come from the owner-scoped action store and are rechecked in SQL. */
export function createProductionRetainedPricing(input: PostgresSqlPool): RetainedGenerationPricing {
  const pool = bindAccountingRealmPool(input, createAccountingRealm("production-real"));
  return Object.freeze({ async readOriginal(action) {
    const client = await pool.connect();
    try {
      const rows = (await client.query<{ profile_hash: string; card_hash: string; normalized_profile: unknown; normalized_card: unknown; profile_id: string; card_profile_id: string }>("SELECT m.profile_hash,m.normalized_profile,c.card_hash,c.normalized_card,a.profile_id,c.profile_id AS card_profile_id FROM metered_actions a JOIN model_profile_versions m ON m.id=a.profile_id JOIN price_card_versions c ON c.id=a.price_card_id WHERE a.account_id=$1 AND a.session_id=$2 AND a.id=$3 AND a.idempotency_key=$4 AND a.fingerprint=$5 AND a.operation_id=$6 AND a.budget_reference=$7 AND a.profile_id=$8 AND a.price_card_id=$9 AND a.expected_session_version=$10 AND a.admission_reference=$11 AND a.reservation_sat=$12", [action.accountId, action.sessionId, action.actionId, action.idempotencyKey, action.fingerprint, action.operationId, action.actionBudgetReference, action.profileId, action.priceCardId, action.expectedVersion, action.admissionReference, action.maximum.toString()])).rows;
      if (rows.length !== 1) return undefined;
      const row = rows[0]!;
      const profile = ModelProfileSchema.parse(row.normalized_profile), card = PriceCardSchema.parse(row.normalized_card);
      if (profile.id !== action.profileId || card.id !== action.priceCardId || profile.priceCardId !== card.id || row.card_profile_id !== profile.id || row.profile_hash !== hash(canonicalJson(profile)) || row.card_hash !== hash(canonicalJson(card)) || card.provider !== profile.provider || profile.model !== "gemini-4-argon" || card.provider !== "vertex_ai_gemini" || card.kind !== "source_attributed_provider" || card.currency !== "usd_micros") throw new Error("PRODUCTION_RETAINED_PRICING_BINDING_INVALID");
      return Object.freeze({ profile, card });
    } finally { client.release(); }
  } });
}
