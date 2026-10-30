import { bindAccountingRealmPool, createAccountingRealm } from "../funding/accounting-realm";
import type { PostgresSqlClient, PostgresSqlPool } from "../persistence/postgres-sql-funding-store";
import { ResumePricingQuoteSchema, verifyStoredResumePricingQuote, type ResumePricingQuote } from "../continuity/resume-pricing";
import { canonicalJson } from "../promotion/schema";

async function validateRecord(raw: unknown): Promise<ResumePricingQuote> {
  const stored = ResumePricingQuoteSchema.parse(raw);
  return verifyStoredResumePricingQuote({ stored, expectedContext: stored.context, nowMs: stored.preparedAtMs,
    approval: { quoteReference: stored.quoteReference, quoteSha256: stored.quoteSha256, maximumSat: stored.maximumSat } });
}

/** Owner-scoped immutable proposal storage. It has no spending authority; the
 * separate acceptance transaction must bind a saved quote to a funded action. */
export class ProductionResumePricingQuotes {
  readonly #pool: PostgresSqlPool;
  constructor(pool: PostgresSqlPool) { this.#pool = bindAccountingRealmPool(pool, createAccountingRealm("production-real")); }

  async assertReady(): Promise<void> {
    const client = await this.#pool.connect();
    try {
      const row = (await client.query<{ readable: boolean; insertable: boolean; mutable: boolean; guarded: boolean }>(`SELECT
        has_table_privilege(current_user,'production_real.resume_pricing_quotes','SELECT') AS readable,
        has_table_privilege(current_user,'production_real.resume_pricing_quotes','INSERT') AS insertable,
        has_table_privilege(current_user,'production_real.resume_pricing_quotes','UPDATE,DELETE,TRUNCATE') AS mutable,
        EXISTS(SELECT 1 FROM pg_catalog.pg_trigger t
          JOIN pg_catalog.pg_class c ON c.oid=t.tgrelid JOIN pg_catalog.pg_namespace n ON n.oid=c.relnamespace
          JOIN pg_catalog.pg_proc p ON p.oid=t.tgfoid JOIN pg_catalog.pg_namespace pn ON pn.oid=p.pronamespace
          WHERE n.nspname='production_real' AND c.relname='resume_pricing_quotes'
            AND t.tgname='immutable_resume_pricing_quote' AND t.tgenabled IN ('O','A') AND NOT t.tgisinternal
            AND pn.nspname='production_real' AND p.proname='guard_resume_pricing_quote') AS guarded`)).rows[0];
      if (!row?.readable || !row.insertable || row.mutable || !row.guarded) throw new Error("PRODUCTION_RESUME_QUOTE_SCHEMA_REQUIRED");
    } finally { client.release(); }
  }

  async findPreparation(accountId: string, preparationKey: string): Promise<ResumePricingQuote | undefined> {
    const client = await this.#pool.connect();
    try { return await this.#read(client, accountId, preparationKey); }
    finally { client.release(); }
  }

  async findReference(accountId: string, quoteReference: string): Promise<ResumePricingQuote | undefined> {
    const client = await this.#pool.connect();
    try {
      const row = (await client.query<{ quote_json: unknown }>("SELECT quote_json FROM production_real.resume_pricing_quotes WHERE account_id=$1 AND quote_reference=$2", [accountId, quoteReference])).rows[0];
      if (!row) return undefined;
      const quote = await validateRecord(row.quote_json);
      if (quote.context.accountId !== accountId || quote.quoteReference !== quoteReference) throw new Error("PRODUCTION_RESUME_QUOTE_BINDING_INVALID");
      return quote;
    } finally { client.release(); }
  }

  async save(input: unknown): Promise<ResumePricingQuote> {
    const quote = await validateRecord(input);
    for (let attempt = 0; attempt < 4; attempt++) {
      const client = await this.#pool.connect();
      try {
        await client.query("BEGIN ISOLATION LEVEL SERIALIZABLE");
        await client.query("SET LOCAL lock_timeout = '1s'");
        await client.query("SET LOCAL statement_timeout = '5s'");
        // Read first: a duplicate remains readable after its checkpoint is
        // claimed/expired, without attempting a forbidden fresh proposal.
        let saved = await this.#read(client, quote.context.accountId, quote.preparationKey);
        if (!saved) {
          await client.query(`INSERT INTO production_real.resume_pricing_quotes
            (quote_reference,quote_sha256,account_id,checkpoint_id,preparation_key,quote_json,prepared_at_ms,expires_at_ms)
            VALUES($1,$2,$3,$4,$5,$6::jsonb,$7,$8) ON CONFLICT(account_id,preparation_key) DO NOTHING`,
          [quote.quoteReference, quote.quoteSha256, quote.context.accountId, quote.context.checkpointId, quote.preparationKey, canonicalJson(quote), quote.preparedAtMs, quote.expiresAtMs]);
          saved = await this.#read(client, quote.context.accountId, quote.preparationKey);
        }
        if (!saved || canonicalJson(saved.context) !== canonicalJson(quote.context)) throw new Error("RESUME_QUOTE_PREPARATION_CONFLICT");
        await client.query("COMMIT");
        return saved;
      } catch (error) {
        await client.query("ROLLBACK").catch(() => undefined);
        const code = error && typeof error === "object" && "code" in error ? String(error.code) : "";
        if (attempt === 3 || !["40001", "40P01", "23505"].includes(code)) throw error;
      } finally { client.release(); }
    }
    throw new Error("RESUME_QUOTE_PREPARATION_UNAVAILABLE");
  }

  async #read(client: PostgresSqlClient, accountId: string, preparationKey: string): Promise<ResumePricingQuote | undefined> {
    const row = (await client.query<{ quote_json: unknown }>("SELECT quote_json FROM production_real.resume_pricing_quotes WHERE account_id=$1 AND preparation_key=$2", [accountId, preparationKey])).rows[0];
    if (!row) return undefined;
    const quote = await validateRecord(row.quote_json);
    if (quote.context.accountId !== accountId || quote.preparationKey !== preparationKey) throw new Error("PRODUCTION_RESUME_QUOTE_BINDING_INVALID");
    return quote;
  }
}
