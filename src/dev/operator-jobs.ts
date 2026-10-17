import type { PostgresSqlClient } from "../persistence/postgres-sql-funding-store";

export type JobCategory = "all" | "pending" | "active" | "review" | "finished";
const jobsProjection = `
  SELECT 'action' AS kind,a.id,a.session_id,a.state,a.created_at,a.settled_at,
    CASE WHEN a.state='prepared' THEN 'pending' WHEN a.state='active' THEN 'active'
      WHEN a.state IN ('usage_unknown','billing_invariant_failed') THEN 'review' ELSE 'finished' END AS category,
    coalesce(p.title,'Untitled applet') AS title,a.request_text,
    CASE WHEN a.id LIKE 'start:%' THEN 'New applet' ELSE 'Revision' END AS action_label,
    a.expected_session_version,a.artifact_version,m.model,
    c.normalized_card->>'kind' AS price_kind,
    a.reservation_sat::text,a.receipt_charge::text,
    CASE WHEN b.state='authorized' THEN a.reservation_sat ELSE 0 END::text AS held_sat,
    CASE WHEN a.provider_receipt_reference LIKE 'development:unconfirmed-charge-waived:%' THEN 'waived'
      WHEN a.state IN ('usage_unknown','billing_invariant_failed') THEN 'unresolved'
      WHEN a.receipt_charge IS NOT NULL THEN 'settled' ELSE 'pending' END AS billing_status
  FROM metered_actions a
  LEFT JOIN development_projects p ON p.id=a.session_id
  JOIN model_profile_versions m ON m.id=a.profile_id
  JOIN price_card_versions c ON c.id=a.price_card_id
  JOIN action_budget_reservations b ON b.reservation_reference=a.budget_reference
  UNION ALL
  SELECT 'pending',p.checkpoint_id,NULL,
    CASE WHEN p.state='saved' AND p.expires_at_ms <= extract(epoch FROM now())*1000 THEN 'expired' ELSE p.state END,
    p.created_at,NULL,
    CASE WHEN p.state='saved' AND p.expires_at_ms > extract(epoch FROM now())*1000 THEN 'pending'
      WHEN p.state='bound' THEN 'review' ELSE 'finished' END,
    'Saved applet',NULL,'Saved request',0,NULL,NULL,NULL,p.maximum_sat::text,NULL,'0','pending'
  FROM development_pending_actions p
  WHERE NOT EXISTS (SELECT 1 FROM metered_actions a WHERE a.operation_id=p.operation_id AND a.account_id=p.account_id)
`;

export async function listOperatorJobs(pool: Pick<PostgresSqlClient, "query">, category: JobCategory, offset: number, search: string) {
  // One snapshot for results, counts and sums. Search is literal and parameterized.
  const row = (await pool.query(`WITH jobs AS (${jobsProjection}), matching AS (
    SELECT * FROM jobs WHERE $3='' OR position(lower($3) in lower(concat_ws(' ',title,request_text,id,session_id,model)))>0
  ), page AS (SELECT * FROM matching WHERE $1='all' OR category=$1 ORDER BY created_at DESC,id DESC LIMIT 50 OFFSET $2)
  SELECT coalesce((SELECT jsonb_agg(to_jsonb(page) ORDER BY created_at DESC,id DESC) FROM page),'[]') AS jobs,
    (SELECT jsonb_object_agg(category,n) FROM (SELECT category,count(*)::int AS n FROM matching GROUP BY category) counts) AS counts,
    (SELECT count(*)::int FROM matching WHERE $1='all' OR category=$1) AS total,
    (SELECT coalesce(jsonb_agg(totals),'[]') FROM (
      SELECT price_kind,coalesce(sum(receipt_charge::bigint) FILTER (WHERE billing_status IN ('settled','waived')),0)::text AS charged_sat,
        coalesce(sum(held_sat::bigint) FILTER (WHERE category='review'),0)::text AS review_held_sat
      FROM matching WHERE kind='action' GROUP BY price_kind
    ) totals) AS totals`, [category, offset, search])).rows[0];
  return { jobs: row?.jobs ?? [], counts: row?.counts ?? {}, total: row?.total ?? 0, totals: row?.totals ?? [], offset };
}

export async function readOperatorJob(pool: Pick<PostgresSqlClient, "query">, id: string, kind: string) {
  if (kind === "pending") return (await pool.query(`SELECT checkpoint_id AS id,account_id,
    CASE WHEN state='saved' AND expires_at_ms <= extract(epoch FROM now())*1000 THEN 'expired' ELSE state END AS state,
    maximum_sat,expires_at_ms,created_at,updated_at,operation_id,
    'Saved applet' AS title,'Saved request' AS action_label,'0' AS held_sat
    FROM development_pending_actions WHERE checkpoint_id=$1`, [id])).rows[0] ?? null;
  const row = (await pool.query(`WITH jobs AS (${jobsProjection})
    SELECT j.*,a.account_id,a.profile_id,a.price_card_id,a.operation_id,a.remaining_cap_sat,a.remaining_balance_sat,a.artifact_id,
      p.provider,c.diagnostic_json,a.provider_receipt_reference,
      coalesce(e.receipt_json,o.receipt_json,c.observation_json->'receipt') AS usage_receipt
    FROM jobs j JOIN metered_actions a ON a.id=j.id
    JOIN model_profile_versions p ON p.id=a.profile_id
    LEFT JOIN development_chatgpt_operations c ON c.operation_id=a.operation_id
    LEFT JOIN development_usage_evidence e ON e.operation_id=a.operation_id
    LEFT JOIN provider_observations o ON o.operation_id=a.operation_id
    WHERE j.kind='action' AND j.id=$1`, [id])).rows[0];
  if (!row) return null;
  const [billing, worker, artifacts] = await Promise.all([
    pool.query("SELECT kind,amount_sat,committed_at FROM billing_line_items WHERE action_id=$1 ORDER BY sequence", [id]),
    pool.query("SELECT state,completed_at FROM development_worker_results WHERE action_id=$1", [id]),
    pool.query("SELECT artifact_id,version,aggregate_sha256,created_at FROM development_artifacts WHERE action_id=$1", [id]),
  ]);
  return { ...row, billing: billing.rows, worker: worker.rows, artifacts: artifacts.rows };
}
