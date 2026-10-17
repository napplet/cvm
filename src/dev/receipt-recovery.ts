import { NormalizedUsageReceiptSchema } from "../model/model-gateway";
import { ModelProfileSchema, PriceCardSchema, priceReceipt } from "../model/price-card";
import type { MeteredFundingStore } from "../persistence/funding-store";
import type { PostgresSqlClient } from "../persistence/postgres-sql-funding-store";
import { canonicalJson } from "../promotion/schema";

/** Local evidence only: never repeat inference or guess a missing charge. */
export async function recoverRecordedReceipt(pool: Pick<PostgresSqlClient, "query">, store: MeteredFundingStore, id: string) {
  const row = (await pool.query(`SELECT a.account_id,a.operation_id,p.normalized_profile,c.normalized_card,
    e.receipt_json AS journal,o.receipt_json AS observation,g.observation_json->'receipt' AS completion
    FROM metered_actions a JOIN model_profile_versions p ON p.id=a.profile_id JOIN price_card_versions c ON c.id=a.price_card_id
    LEFT JOIN development_usage_evidence e ON e.operation_id=a.operation_id
    LEFT JOIN provider_observations o ON o.operation_id=a.operation_id
    LEFT JOIN development_chatgpt_operations g ON g.operation_id=a.operation_id WHERE a.id=$1`, [id])).rows[0];
  if (!row) return { outcome: "not_found" };
  const action = await store.findMeteredActionByOperation(String(row.account_id), String(row.operation_id));
  if (!action || action.result || action.status !== "usage_unknown") return { outcome: "not_required" };
  const candidates = [row.journal, row.observation, row.completion].filter(value => value != null);
  if (!candidates.length) return { outcome: "missing", reserved: action.maximum.toString() };
  const receipts = candidates.map(value => NormalizedUsageReceiptSchema.parse(value));
  const receipt = receipts[0]!;
  if (receipts.some(value => canonicalJson(value) !== canonicalJson(receipt)) || receipt.operationId !== action.operationId || receipt.providerRequestId !== action.providerRequestId || receipt.profileId !== action.profileId || receipt.priceCardId !== action.priceCardId) return { outcome: "conflict" };
  const profile = ModelProfileSchema.parse(row.normalized_profile), card = PriceCardSchema.parse(row.normalized_card);
  const priced = priceReceipt({ receipt, profile, card, reservation: action.maximum.toString() });
  if (priced.status !== "priced") return { outcome: "conflict", code: priced.code };
  const claim = await store.transact(action.accountId, transaction => transaction.claimReconciliation(action.operationId));
  if (!claim.claimed) return { outcome: "busy" };
  let settled = false;
  try {
    // Correlated receipt + original immutable rates. The existing transaction
    // commits the debit once and releases only the corresponding reservation.
    await store.transact(action.accountId, async transaction => {
      await transaction.recordUsageReceipt({ operationId: action.operationId, protectedEvidenceReference: receipt.provenance.protectedEvidenceReference });
      return transaction.finalizeMeteredAction({ idempotencyKey: action.idempotencyKey, operationId: action.operationId,
        receiptCharge: priced.total, providerReceiptReference: receipt.provenance.protectedEvidenceReference,
        status: "failed", sessionVersion: action.expectedVersion, artifactVersion: 0,
        result: { status: "failed", code: "RECONCILED_RECEIPT_FOUND", accountId: action.accountId, sessionId: action.sessionId,
          sessionVersion: action.expectedVersion, artifactVersion: action.expectedVersion, confirmedSpend: priced.total,
          remainingCap: "0", remainingBalance: "0", nextAction: "revise_session", operationId: action.operationId },
      });
    });
    settled = true;
    return { outcome: "settled", charged: priced.total };
  } finally {
    if (!settled) await store.transact(action.accountId, transaction => transaction.releaseReconciliation(action.operationId));
  }
}
