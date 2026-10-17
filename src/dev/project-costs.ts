import { z } from "zod";
import type { PostgresSqlClient } from "../persistence/postgres-sql-funding-store";
import { accountIdForPrincipal } from "../domain/account-command";
import { PriceCardSchema } from "../model/price-card";
import { profitCharge } from "../model/profit";
import { ProjectCostsSchema, type RequestCost } from "../dev-ui/project-costs-contract";

/** Reproduce the pinned receipt's integer rounding, never infer money from tokens
 * at today's rates. Incomplete or mismatching historical receipts stay unavailable. */
export function costLines(usage: unknown, card: unknown, charge: string | null): RequestCost["lines"] {
  const priced = PriceCardSchema.safeParse(card);
  const parsed = z.array(z.object({ dimension: z.enum(["input_tokens", "output_tokens", "cached_tokens", "reasoning_tokens"]), units: z.string().regex(/^\d{1,19}$/u) })).safeParse(usage);
  if (charge === null || !priced.success || !parsed.success || !parsed.data.length) return [];
  const seen = new Set<string>(); const lines: RequestCost["lines"] = [];
  for (const item of parsed.data) {
    const rate = priced.data.rates[item.dimension];
    if (!rate || seen.has(item.dimension)) return [];
    seen.add(item.dimension);
    const amount = (BigInt(item.units) * BigInt(rate.numerator) + BigInt(rate.denominator) - 1n) / BigInt(rate.denominator);
    lines.push({ ...item, ...rate, charge: amount.toString() });
  }
  const base = lines.reduce((sum, line) => sum + BigInt(line.charge), 0n), fee = profitCharge(base, parsed.data.reduce((sum, line) => sum + BigInt(line.units), 0n), priced.data.profit);
  if (fee) lines.push({ dimension: "service_fee", units: "1", numerator: fee.toString(), denominator: "1", charge: fee.toString() });
  return base + fee === BigInt(charge) ? lines : [];
}

export async function readProjectCosts(pool: Pick<PostgresSqlClient, "query">, pubkey: string, id: string, limit: number, after?: string) {
  const account = await accountIdForPrincipal({ pubkey });
  // One statement gives totals and the page the same snapshot. The cursor is
  // meaningful only inside this authenticated account AND session.
  const result = await pool.query<{ total: { confirmed: string; pending: number; requests: number }; entries: any[] }>(`
    WITH owned AS (SELECT id,confirmed_spend_sat FROM metered_sessions WHERE id=$2 AND account_id=$1),
    actions AS (SELECT a.*,row_number() OVER (ORDER BY a.created_at,a.id)::int AS number
      FROM metered_actions a JOIN owned s ON s.id=a.session_id WHERE a.account_id=$1),
    page AS (SELECT a.* FROM actions a WHERE $3::text IS NULL OR (a.created_at,a.id)<
      (SELECT created_at,id FROM actions WHERE id=$3) ORDER BY a.created_at DESC,a.id DESC LIMIT $4)
    SELECT json_build_object('confirmed',s.confirmed_spend_sat::text,
      'pending',(SELECT count(*) FROM actions WHERE receipt_charge IS NULL),
      'requests',(SELECT count(*) FROM actions)) AS total,
      COALESCE((SELECT json_agg(json_build_object('id',a.id,'requestKey',a.idempotency_key,'number',a.number,
        'kind',CASE WHEN a.expected_session_version=0 THEN 'create' ELSE 'revise' END,'prompt',a.request_text,
        'state',a.state,'version',CASE WHEN a.state='verified' THEN a.artifact_version ELSE NULL END,
        'createdAt',a.created_at,'charge',a.receipt_charge::text,'maximum',a.reservation_sat::text,
        'usage',COALESCE(po.receipt_json->'usage',co.observation_json->'receipt'->'usage',a.terminal_result->'generation'->'usage'),
        'card',pc.normalized_card) ORDER BY a.created_at DESC,a.id DESC)
        FROM page a LEFT JOIN price_card_versions pc ON pc.id=a.price_card_id
        LEFT JOIN provider_observations po ON po.operation_id=a.operation_id
        LEFT JOIN development_chatgpt_operations co ON co.operation_id=a.operation_id),'[]'::json) AS entries
    FROM owned s WHERE $3::text IS NULL OR EXISTS(SELECT 1 FROM actions WHERE id=$3)`, [account,id,after??null,limit+1]);
  const row = result.rows[0];
  if (!row) return { status: "not_found_or_denied" as const };
  const requests = row.entries.slice(0,limit).map(({ usage, card, ...entry }) => ({ ...entry, lines: costLines(usage,card,entry.charge) }));
  return { status: "ok" as const, costs: ProjectCostsSchema.parse({ sessionId:id,unit:"test_sat",total:row.total,requests,nextCursor:row.entries.length>limit?requests.at(-1)!.id:null }) };
}
