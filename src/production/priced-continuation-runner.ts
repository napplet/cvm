import { ResumeSessionV2CommandSchema } from "../continuity/resume-v2-contracts";
import { bindAccountingRealmPool, createAccountingRealm } from "../funding/accounting-realm";
import { PostgresSqlFundingStore, type PostgresSqlPool } from "../persistence/postgres-sql-funding-store";
import { MeteredGenerationService, SessionActionResultSchema, type SessionActionResult } from "../phase-04/metered-generation-service";
import { ProductionPricedContinuationFinalizer } from "./priced-continuation-finalizer";
import { ProductionPricedContinuationRestores } from "./priced-continuation-restores";
import { ProductionPricedContinuationWorkers } from "./priced-continuation-workers";
import { ProductionResumeAcceptance, type AcceptedPricedContinuation } from "./resume-acceptance";
import { ProductionResumePricingPreparer } from "./resume-pricing-preparer";
import { ProductionPricedContinuationCleanup } from "./priced-continuation-cleanup";

type Pending = Readonly<{ status: "reconciliation_pending"; stage: "capacity" | "restore" | "accounting" | "cleanup" }>;
class AccountingPending extends Error {}

/** Private synchronous coordinator, not a public transport or durable queue.
 * Each component retains its original durable effect fence. A failed stage
 * never authorizes replacement work, worker cleanup or reservation release. */
export class ProductionPricedContinuationRunner {
  readonly #store: PostgresSqlFundingStore;
  readonly #inFlight = new Map<string, Promise<SessionActionResult | Pending>>();
  constructor(private readonly input: Readonly<{ pool: PostgresSqlPool; acceptance: ProductionResumeAcceptance;
    preparer: ProductionResumePricingPreparer; workers: ProductionPricedContinuationWorkers; restores: ProductionPricedContinuationRestores;
    generation: MeteredGenerationService; finalizer: ProductionPricedContinuationFinalizer; cleanup: ProductionPricedContinuationCleanup }>) {
    this.#store = new PostgresSqlFundingStore(bindAccountingRealmPool(input.pool, createAccountingRealm("production-real")), { deadlineMs: 5000, maxAttempts: 4 });
  }

  async assertReady(): Promise<void> { await this.input.finalizer.assertReady(); }

  async run(raw: unknown): Promise<SessionActionResult | Pending> {
    // Original signed consent is checked on EVERY call, including terminal
    // replay, before looking up local in-flight work or a stored result.
    const command = ResumeSessionV2CommandSchema.parse(raw);
    const { claim } = await this.input.acceptance.claim(command);
    const recorded = await this.#result(claim);
    if (recorded) return this.#finish(claim, recorded);
    const active = this.#inFlight.get(claim.claimReference);
    if (active) return active;
    const work = this.#execute(claim).then(result => this.#finish(claim, result)).finally(() => this.#inFlight.delete(claim.claimReference));
    this.#inFlight.set(claim.claimReference, work);
    return work;
  }

  async #finish(claim: AcceptedPricedContinuation, result: SessionActionResult | Pending): Promise<SessionActionResult | Pending> {
    if (result.status !== "completed" && result.status !== "failed") return result;
    // Unclaimed supersession has no external worker marker. Paid terminal work
    // must confirm original worker cleanup before returning its final result.
    if (claim.state === "superseded") return result;
    const cleanup = await this.input.cleanup.cleanup(claim.accountId, claim.idempotencyKey);
    return cleanup.status === "cleaned" ? result : { status: "reconciliation_pending", stage: "cleanup" };
  }

  async #execute(claim: AcceptedPricedContinuation): Promise<SessionActionResult | Pending> {
    const allocation = await this.input.workers.allocate(claim.accountId, claim.idempotencyKey);
    if (allocation.status !== "available") return { status: "reconciliation_pending", stage: "capacity" };
    const restored = await this.input.restores.restore(claim.accountId, claim.idempotencyKey);
    if (restored.status !== "restored") return { status: "reconciliation_pending", stage: "restore" };
    const authority = await this.input.preparer.loadAcceptedAuthority({ principal: { id: claim.accountId }, idempotencyKey: claim.idempotencyKey });
    if (authority.claimReference !== claim.claimReference || authority.quote.quoteSha256 !== claim.quoteSha256)
      throw new Error("PRICED_RUNNER_AUTHORITY_BINDING_DENIED");
    const executable = await this.input.generation.preparePricedContinuation({ intent: authority.intent, restoredCommand: authority.command,
      pricing: authority.quote.pricing, maximumSat: authority.quote.maximumSat,
      binding: { accountId: claim.accountId, actionKey: claim.actionKey, commandFingerprint: claim.fingerprint, actionId: claim.actionId,
        operationId: claim.operationId, actionBudgetReference: claim.actionBudgetReference } });
    try {
      return await executable.execute(async ({ intent, receipt, finalization }) => {
        if (!receipt || (finalization.status !== "completed" && finalization.status !== "failed")) {
          await this.#retainUnknown(claim, receipt?.provenance.protectedEvidenceReference ?? finalization.providerReceiptReference);
          throw new AccountingPending("PRICED_RUNNER_ACCOUNTING_PENDING");
        }
        try {
          await this.input.finalizer.complete({ accountId: claim.accountId, idempotencyKey: claim.idempotencyKey,
            leaseToken: claim.leaseToken, allocationIntentReference: claim.allocationIntentReference, intent, receipt, finalization });
        } catch {
          // COMMIT acknowledgement loss is resolved by the original owned
          // terminal state before writing ambiguity. Never settle a second key.
          const current = await this.input.acceptance.find(claim.accountId, claim.idempotencyKey);
          if (current && await this.#result(current)) return;
          await this.#retainUnknown(claim, receipt.provenance.protectedEvidenceReference);
          throw new AccountingPending("PRICED_RUNNER_ACCOUNTING_PENDING");
        }
      });
    } catch (error) {
      if (error instanceof AccountingPending) {
        const current = await this.input.acceptance.find(claim.accountId, claim.idempotencyKey);
        const committed = current && await this.#result(current);
        return committed ?? { status: "reconciliation_pending", stage: "accounting" };
      }
      throw error;
    }
  }

  async #result(claim: AcceptedPricedContinuation): Promise<SessionActionResult | undefined> {
    const action = await this.#store.findMeteredAction(claim.accountId, claim.actionKey);
    if (!action || action.accountId !== claim.accountId || action.sessionId !== claim.sessionId || action.actionId !== claim.actionId
      || action.operationId !== claim.operationId || action.fingerprint !== claim.fingerprint || action.actionBudgetReference !== claim.actionBudgetReference
      || action.profileId !== claim.quote.pricing.profile.id || action.priceCardId !== claim.quote.pricing.card.id
      || action.expectedVersion !== claim.quote.context.expectedSessionVersion || action.maximum !== BigInt(claim.quote.maximumSat))
      throw new Error("PRICED_RUNNER_ACTION_BINDING_DENIED");
    if (!action.result) {
      if (claim.state === "completed" || claim.state === "superseded") throw new Error("PRICED_RUNNER_TERMINAL_REQUIRED");
      return undefined;
    }
    const result = SessionActionResultSchema.parse(action.result);
    if ((result.status !== "completed" && result.status !== "failed" && result.status !== "billing_invariant_failed")
      || result.accountId !== claim.accountId || result.sessionId !== claim.sessionId || result.operationId !== claim.operationId
      || (claim.state === "completed" && result.status !== "completed" && result.status !== "failed")
      || (claim.state === "superseded" && (result.status !== "failed" || result.code !== "PROVIDER_NOT_ACCEPTED" || result.confirmedSpend !== "0"))
      || ((claim.state === "accepted" || claim.state === "dispatching") && result.status !== "billing_invariant_failed"))
      throw new Error("PRICED_RUNNER_TERMINAL_BINDING_DENIED");
    return result;
  }

  async #retainUnknown(claim: AcceptedPricedContinuation, reference: string): Promise<void> {
    await this.#store.transact(claim.accountId, async tx => {
      const action = await tx.recordUsageUnknown({ operationId: claim.operationId, providerRequestId: claim.operationId,
        protectedEvidenceReference: reference, reason: "mismatched_receipt" });
      if (action.actionId !== claim.actionId || action.actionBudgetReference !== claim.actionBudgetReference)
        throw new Error("PRICED_RUNNER_ACTION_BINDING_DENIED");
    });
  }
}
