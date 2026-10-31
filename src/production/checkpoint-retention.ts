import { bindAccountingRealmPool, createAccountingRealm } from "../funding/accounting-realm";
import type { RetentionCandidate } from "../continuity/deadline-reconciler";
import type { PostgresSqlPool } from "../persistence/postgres-sql-funding-store";

/** Durable discovery only. SQL tombstone and exact original deletion remain
 * with the existing deadline/checkpoint authorities. Claimed work keeps its
 * existing election; completion is scoped to the exact immutable generation. */
export async function listProductionRetentionCandidates(input: PostgresSqlPool, nowMs: number): Promise<readonly RetentionCandidate[]> {
  if (!Number.isSafeInteger(nowMs) || nowMs < 0) throw new Error("RETENTION_CLOCK_REQUIRED");
  const pool = bindAccountingRealmPool(input, createAccountingRealm("production-real"));
  const client = await pool.connect();
  try {
    const rows = await client.query<{ account_id: string; session_id: string; pause_generation: number; checkpoint_id: string }>(`SELECT c.account_id,c.session_id,c.pause_generation,c.checkpoint_id FROM continuation_checkpoints c
      WHERE (c.state IN ('resume_required','expired') OR (c.state='claimed' AND EXISTS (
        SELECT 1 FROM continuation_pauses p WHERE p.account_id=c.account_id AND p.session_id=c.session_id
          AND p.pause_generation=c.pause_generation AND p.state='completed' AND p.live_lease_token IS NULL)))
        AND c.retention_deadline_ms <= $1 AND NOT EXISTS (SELECT 1 FROM continuation_deletions d
          WHERE d.checkpoint_id=c.checkpoint_id AND d.object_generation=c.object_generation AND d.state='deleted')
      ORDER BY c.retention_deadline_ms,c.checkpoint_id LIMIT 100`, [nowMs]);
    return Object.freeze(rows.rows.map(row => Object.freeze({ accountId: row.account_id, sessionId: row.session_id, pauseGeneration: row.pause_generation, checkpointId: row.checkpoint_id })));
  } finally { client.release(); }
}
