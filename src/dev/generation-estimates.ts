import { z } from "zod";
import { accountIdForPrincipal } from "../domain/account-command";
import type { PostgresSqlClient } from "../persistence/postgres-sql-funding-store";
import { GenerationEstimatesSchema, type GenerationEstimate, type GenerationEstimates } from "../dev-ui/generation-estimates-contract";

type Sample = { expected_session_version: number; receipt_charge: string; seconds: number | string };

/** Rough historical ranges, not a quote or a statistical confidence interval.
 * Keep integer money exact. Pad observed bounds by 25% and round time outward. */
export function summarizeGenerationEstimates(rows: readonly Sample[], ceiling: string): GenerationEstimates {
  const cap = BigInt(ceiling);
  const valid = rows.filter(row => /^\d{1,19}$/u.test(row.receipt_charge) && BigInt(row.receipt_charge) <= cap
    && Number.isFinite(Number(row.seconds)) && Number(row.seconds) > 0 && Number(row.seconds) <= 3600);
  function estimate(kind: "create" | "revise"): GenerationEstimate | null {
    const matching = valid.filter(row => (row.expected_session_version === 0 ? "create" : "revise") === kind);
    const samples = (matching.length ? matching : valid).slice(0, 30);
    if (!samples.length) return null;
    const costs = samples.map(row => BigInt(row.receipt_charge)).sort((a,b) => a < b ? -1 : a > b ? 1 : 0);
    const durations = samples.map(row => Number(row.seconds));
    const upper = (costs.at(-1)! * 5n + 3n) / 4n;
    return { samples: samples.length, basis: matching.length ? kind : "all",
      cost: { low: (costs[0]! * 3n / 4n).toString(), high: (upper < cap ? upper : cap).toString() },
      seconds: { low: Math.max(5, Math.floor(Math.min(...durations) * .75 / 5) * 5), high: Math.max(10, Math.ceil(Math.max(...durations) * 1.25 / 5) * 5) },
    };
  }
  return GenerationEstimatesSchema.parse({ unit: "test_sat", windowDays: 30, create: estimate("create"), revise: estimate("revise") });
}

/** Identity comes only from the verified CVM request. Never accepts an owner in input.
 * Match current pricing because new actions (including revisions) use the runtime's
 * profile/card. Exclude failures, reconciliations and old migration timestamps. */
export async function readGenerationEstimates(pool: Pick<PostgresSqlClient, "query">, verifiedPubkey: string,
  pricing: { profile: { id: string }; card: { id: string } }, ceiling: string): Promise<GenerationEstimates> {
  const accountId = await accountIdForPrincipal({ pubkey: z.string().regex(/^[a-f0-9]{64}$/u).parse(verifiedPubkey) });
  const result = await pool.query<Sample>(`SELECT a.expected_session_version, a.receipt_charge::text,
      extract(epoch FROM (a.settled_at - a.created_at)) AS seconds
    FROM metered_actions a
    WHERE a.account_id=$1 AND a.profile_id=$2 AND a.price_card_id=$3
      AND a.state='verified' AND a.receipt_charge IS NOT NULL
      AND a.created_at >= now() - interval '30 days'
      AND a.settled_at > a.created_at AND a.settled_at <= a.created_at + interval '1 hour'
      AND NOT EXISTS (SELECT 1 FROM provider_reconciliations r WHERE r.action_id=a.id)
    ORDER BY a.created_at DESC LIMIT 60`, [accountId, pricing.profile.id, pricing.card.id]);
  return summarizeGenerationEstimates(result.rows, ceiling);
}
