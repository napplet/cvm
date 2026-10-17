import { ModelDispatchObservationSchema } from "../model/model-gateway";
import { PriceCardSchema } from "../model/price-card";
import type { MeteredFundingStore } from "../persistence/funding-store";
import type { PostgresSqlPool } from "../persistence/postgres-sql-funding-store";
import { SessionActionResultSchema, type SessionActionResult } from "../phase-04/metered-generation-service";

/** Development policy: the operator absorbs an ended, unconfirmed subscription
 * request. Zero is the local test charge, NEVER a claim about provider usage.
 * The original provider observation and dispatch fence remain immutable. */
export class InterruptedDevelopmentGeneration {
  constructor(private readonly pool: PostgresSqlPool, private readonly store: MeteredFundingStore) {}

  async recover(accountId: string, sessionId: string): Promise<SessionActionResult | undefined> {
    const client = await this.pool.connect();
    let rows: readonly Record<string, unknown>[];
    try {
      rows = (await client.query(`SELECT a.operation_id,c.observation_json,p.normalized_card
        FROM metered_actions a
        JOIN development_chatgpt_operations c ON c.operation_id=a.operation_id
        JOIN price_card_versions p ON p.id=a.price_card_id
        WHERE a.account_id=$1 AND a.session_id=$2 AND a.state='usage_unknown'
          AND c.observation_json IS NOT NULL
          AND NOT EXISTS (SELECT 1 FROM development_usage_evidence e WHERE e.operation_id=a.operation_id)
          AND NOT EXISTS (SELECT 1 FROM source_proposals s WHERE s.operation_id=a.operation_id)
          AND NOT EXISTS (SELECT 1 FROM provider_observations o WHERE o.operation_id=a.operation_id)`, [accountId, sessionId])).rows;
    } finally { client.release(); }
    for (const row of rows) {
      const observation = ModelDispatchObservationSchema.safeParse(row.observation_json);
      const card = PriceCardSchema.safeParse(row.normalized_card);
      if (!observation.success || observation.data.status !== "usage_unknown" ||
          !card.success || card.data.kind !== "development_test" || card.data.provider !== "openai_chatgpt_development") continue;
      const action = await this.store.findMeteredActionByOperation(accountId, String(row.operation_id));
      if (!action || action.sessionId !== sessionId || action.operationId !== observation.data.operationId || action.providerRequestId !== observation.data.providerRequestId) continue;
      if (action.result) return SessionActionResultSchema.parse(action.result);
      if (action.status !== "usage_unknown") continue;
      const result = SessionActionResultSchema.parse({ status: "failed", code: "MODEL_RESPONSE_INTERRUPTED",
        accountId, sessionId, sessionVersion: action.expectedVersion, artifactVersion: action.expectedVersion,
        confirmedSpend: "0", remainingCap: "0", remainingBalance: "0", nextAction: "revise_session", operationId: action.operationId });
      const finalized = await this.store.transact(accountId, transaction => transaction.finalizeMeteredAction({
        idempotencyKey: action.idempotencyKey, operationId: action.operationId,
        receiptCharge: "0", providerReceiptReference: `development:unconfirmed-charge-waived:v1:${action.operationId}`,
        status: "failed", result, sessionVersion: action.expectedVersion, artifactVersion: 0,
      }));
      return SessionActionResultSchema.parse(finalized.result);
    }
  }
}
