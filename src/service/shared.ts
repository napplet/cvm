import type { ReadyCapacityPort } from "../funding/funded-admission";
import type { DevelopmentRuntimeReadiness } from "../dev/development-runtime-readiness";
import type { PostgresSqlClient } from "../persistence/postgres-sql-funding-store";

export function developmentCapacity(readiness: DevelopmentRuntimeReadiness): ReadyCapacityPort {
  const reservations = new Map<string, Readonly<{ reference: string; expiresAt: string; binding: string }>>();
  return {
    async reserveNow(input) {
      const found = reservations.get(input.intentReference);
      const reservation = found ?? Object.freeze({ reference: `development-ready:${input.intentReference}`, expiresAt: new Date(Date.now() + 120_000).toISOString(), binding: input.expectedSessionBindingDigest });
      reservations.set(input.intentReference, reservation);
      return { status: "available" as const, reference: reservation.reference, expiresAt: reservation.expiresAt, usable: true as const, ready: { intentReference: input.intentReference, leaseReference: reservation.reference, sessionBindingDigest: reservation.binding, imageDigest: readiness.imageDigest, readinessProbeDigest: readiness.readinessProbeDigest, readyMonotonicMs: readiness.readyMonotonicMs } };
    },
    async observe(input) {
      const reservation = reservations.get(input.intentReference);
      if (!reservation || reservation.reference !== input.reference || reservation.binding !== input.expectedSessionBindingDigest) return { status: "unknown" as const, ...(input.reference ? { reference: input.reference } : {}) };
      return { status: "available" as const, reference: reservation.reference, expiresAt: reservation.expiresAt, usable: true as const, ready: { intentReference: input.intentReference, leaseReference: reservation.reference, sessionBindingDigest: reservation.binding, imageDigest: readiness.imageDigest, readinessProbeDigest: readiness.readinessProbeDigest, readyMonotonicMs: readiness.readyMonotonicMs } };
    },
    async release(input) { reservations.delete(input.intentReference); },
  };
}


export function safeGenerationDiagnostic(error: unknown): string {
  const message = error instanceof Error ? error.message : "GENERATION_ERROR_REDACTED";
  const cause = error instanceof Error && error.cause instanceof Error ? error.cause.message : undefined;
  const safe = (value: string | undefined) => value && /^[A-Z][A-Z0-9_:-]{2,159}$/u.test(value) ? value : undefined;
  return safe(cause) ?? safe(message) ?? "GENERATION_ERROR_REDACTED";
}

export async function durableTimeline(app: Readonly<{ pool: Pick<PostgresSqlClient, "query"> }>, accountId: string, sessionId: string): Promise<readonly Readonly<{ stage: "source_recorded" | "provider_recorded" | "worker_completed" | "artifact_verified" | "ledger_settled"; at: string; detail: string }>[]> {
  const rows = await app.pool.query<{ stage: "source_recorded" | "provider_recorded" | "worker_completed" | "artifact_verified" | "ledger_settled"; at: Date | string; detail: string }>(`
    SELECT 'source_recorded'::text AS stage, sp.created_at AS at, 'Source proposal recorded' AS detail FROM source_proposals sp WHERE sp.account_id=$1 AND sp.session_id=$2
    UNION ALL SELECT 'provider_recorded'::text, po.created_at, 'Provider receipt recorded' FROM provider_observations po JOIN source_proposals sp ON sp.operation_id=po.operation_id WHERE sp.account_id=$1 AND sp.session_id=$2
    UNION ALL SELECT 'provider_recorded'::text, ma.settled_at, 'Provider usage receipt committed' FROM usage_receipts ur JOIN metered_actions ma ON ma.id=ur.action_id WHERE ma.account_id=$1 AND ma.session_id=$2 AND ma.settled_at IS NOT NULL AND NOT EXISTS (SELECT 1 FROM provider_observations po WHERE po.operation_id=ma.operation_id)
    UNION ALL SELECT 'worker_completed'::text, wr.completed_at, 'Isolated worker output persisted' FROM development_worker_results wr WHERE wr.account_id=$1 AND wr.session_id=$2 AND wr.completed_at IS NOT NULL
    UNION ALL SELECT 'artifact_verified'::text, da.created_at, 'Verified artifact sealed' FROM development_artifacts da WHERE da.account_id=$1 AND da.session_id=$2
    UNION ALL SELECT 'ledger_settled'::text, bli.committed_at, 'Metered ledger settled' FROM billing_line_items bli WHERE bli.account_id=$1 AND bli.session_id=$2 AND bli.kind IN ('receipt','debit')
    ORDER BY at, stage`, [accountId, sessionId]);
  return Object.freeze(rows.rows.map((row) => Object.freeze({ stage: row.stage, at: new Date(row.at).toISOString(), detail: row.detail })));
}
