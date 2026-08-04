import { z } from "zod";
import { accountIdForPrincipal } from "../domain/account-command";
import { PrincipalSchema } from "../phase-03/contracts";
import { PHASE_04_DETERMINISTIC_PRICE_CARD, PHASE_04_MODEL_PROFILES, priceReceipt } from "./price-card";
import { ModelLookupObservationSchema, ProviderOperationIntentSchema, type ModelGateway } from "./model-gateway";
import type { MeteredFundingStore, MeteredAction } from "../persistence/funding-store";

export const ReconcileOperationCommandSchema = z.object({
  principal: PrincipalSchema,
  sessionId: z.string().min(1),
  actionId: z.string().min(1),
  operationId: z.string().min(1),
}).strict();

export const ReconciliationResultSchema = z.discriminatedUnion("status", [
  z.object({ status: z.literal("failed"), code: z.enum(["RECONCILED_RECEIPT_FOUND", "PROVIDER_NOT_ACCEPTED"]), accountId: z.string().min(1), sessionId: z.string().min(1), operationId: z.string().min(1) }).strict(),
  z.object({ status: z.literal("usage_unknown"), code: z.enum(["RECONCILIATION_PENDING", "RECONCILIATION_UNRESOLVED"]), accountId: z.string().min(1), sessionId: z.string().min(1), operationId: z.string().min(1) }).strict(),
  z.object({ status: z.literal("billing_invariant_failed"), code: z.string().min(1), accountId: z.string().min(1), sessionId: z.string().min(1), operationId: z.string().min(1) }).strict(),
]);

export type ReconcileOperationCommand = z.infer<typeof ReconcileOperationCommandSchema>;
export type ReconciliationResult = z.infer<typeof ReconciliationResultSchema>;

function toIntent(action: MeteredAction) {
  return ProviderOperationIntentSchema.parse({
    operationId: action.operationId,
    accountId: action.accountId,
    sessionId: action.sessionId,
    actionId: action.actionId,
    expectedVersion: action.expectedVersion,
    actionBudgetReference: action.actionBudgetReference,
    profileId: action.profileId,
    priceCardId: action.priceCardId,
    requestFingerprint: action.fingerprint,
    maximumUnits: PHASE_04_MODEL_PROFILES["code-proposal"].maximumUnits,
    selection: "unselected",
  });
}

/** Lookup-only recovery for a durable ambiguous provider operation. */
export class ModelReconciliationService {
  readonly #inFlight = new Map<string, Promise<ReconciliationResult>>();
  constructor(private readonly options: Readonly<{ store: MeteredFundingStore; gateway: ModelGateway }>) {}

  async reconcile(input: unknown, signal = new AbortController().signal): Promise<ReconciliationResult> {
    const command = ReconcileOperationCommandSchema.parse(input);
    const accountId = await accountIdForPrincipal(command.principal);
    const action = await this.loadBoundAction(accountId, command);
    const active = this.#inFlight.get(action.operationId);
    if (active) return active;
    const run = this.reconcileOnce(action, signal).finally(() => this.#inFlight.delete(action.operationId));
    this.#inFlight.set(action.operationId, run);
    return run;
  }

  private async reconcileOnce(action: MeteredAction, signal: AbortSignal): Promise<ReconciliationResult> {
    if (action.result) return ReconciliationResultSchema.parse(action.result);
    if (action.status !== "usage_unknown") throw new Error("RECONCILIATION_NOT_REQUIRED");
    const claim = await this.options.store.transact(action.accountId, (transaction) => transaction.claimReconciliation(action.operationId));
    if (!claim.claimed) {
      const current = await this.options.store.findMeteredActionByOperation(action.accountId, action.operationId);
      if (current?.result) return ReconciliationResultSchema.parse(current.result);
      return ReconciliationResultSchema.parse({ status: "usage_unknown", code: "RECONCILIATION_PENDING", accountId: action.accountId, sessionId: action.sessionId, operationId: action.operationId });
    }

    const observation = ModelLookupObservationSchema.parse(await this.options.gateway.lookup(toIntent(claim.action), signal));
    if (observation.status === "pending" || observation.status === "unresolved") {
      await this.options.store.transact(action.accountId, (transaction) => transaction.releaseReconciliation(action.operationId));
      return ReconciliationResultSchema.parse({ status: "usage_unknown", code: observation.status === "pending" ? "RECONCILIATION_PENDING" : "RECONCILIATION_UNRESOLVED", accountId: action.accountId, sessionId: action.sessionId, operationId: action.operationId });
    }
    if (observation.status === "definitive_not_accepted") {
      this.assertCorrelation(claim.action, observation.operationId, observation.providerRequestId);
      const result = ReconciliationResultSchema.parse({ status: "failed", code: "PROVIDER_NOT_ACCEPTED", accountId: action.accountId, sessionId: action.sessionId, operationId: action.operationId });
      await this.options.store.transact(action.accountId, (transaction) => transaction.finalizeMeteredAction({ idempotencyKey: action.idempotencyKey, operationId: action.operationId, receiptCharge: "0", providerReceiptReference: observation.provenance.protectedEvidenceReference, status: "failed", result, sessionVersion: action.expectedVersion, artifactVersion: 0 }));
      return result;
    }

    const receipt = observation.receipt;
    this.assertCorrelation(claim.action, receipt.operationId, receipt.providerRequestId);
    const profile = Object.values(PHASE_04_MODEL_PROFILES).find((candidate) => candidate.id === action.profileId);
    const priced = profile ? priceReceipt({ receipt, card: PHASE_04_DETERMINISTIC_PRICE_CARD, profile, reservation: action.maximum.toString() }) : { status: "billing_invariant_failed" as const, code: "UNKNOWN_MODEL_PROFILE" };
    if (priced.status !== "priced") {
      const result = ReconciliationResultSchema.parse({ status: "billing_invariant_failed", code: priced.code, accountId: action.accountId, sessionId: action.sessionId, operationId: action.operationId });
      await this.options.store.transact(action.accountId, (transaction) => transaction.finalizeMeteredAction({ idempotencyKey: action.idempotencyKey, operationId: action.operationId, receiptCharge: "0", providerReceiptReference: receipt.provenance.protectedEvidenceReference, status: "billing_invariant_failed", result, sessionVersion: action.expectedVersion, artifactVersion: 0 }));
      return result;
    }
    const result = ReconciliationResultSchema.parse({ status: "failed", code: "RECONCILED_RECEIPT_FOUND", accountId: action.accountId, sessionId: action.sessionId, operationId: action.operationId });
    await this.options.store.transact(action.accountId, async (transaction) => {
      await transaction.recordUsageReceipt({ operationId: action.operationId, protectedEvidenceReference: receipt.provenance.protectedEvidenceReference });
      return transaction.finalizeMeteredAction({ idempotencyKey: action.idempotencyKey, operationId: action.operationId, receiptCharge: priced.total, providerReceiptReference: receipt.provenance.protectedEvidenceReference, status: "failed", result, sessionVersion: action.expectedVersion, artifactVersion: 0 });
    });
    return result;
  }

  private async loadBoundAction(accountId: string, command: ReconcileOperationCommand): Promise<MeteredAction> {
    const action = await this.options.store.findMeteredActionByOperation(accountId, command.operationId);
    if (!action || action.sessionId !== command.sessionId || action.actionId !== command.actionId) throw new Error("RECONCILIATION_OPERATION_NOT_FOUND");
    return action;
  }

  private assertCorrelation(action: MeteredAction, operationId: string, providerRequestId: string): void {
    if (operationId !== action.operationId || !action.providerRequestId || providerRequestId !== action.providerRequestId) throw new Error("RECONCILIATION_RECEIPT_CORRELATION_MISMATCH");
  }
}
