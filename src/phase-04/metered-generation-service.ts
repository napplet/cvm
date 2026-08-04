import { z } from "zod";
import { evaluateRisk, type RiskSignalDetector } from "../admission/risk-policy";
import { accountIdForPrincipal } from "../domain/account-command";
import { FundedAdmissionService } from "../funding/funded-admission";
import { type ModelGateway, ModelObservationSchema, ProviderOperationIntentSchema } from "../model/model-gateway";
import { PHASE_04_DETERMINISTIC_PRICE_CARD, PHASE_04_MODEL_PROFILES, priceReceipt } from "../model/price-card";
import { type MeteredFundingStore } from "../persistence/funding-store";
import { type WorkerPort, WorkerRunRequestSchema, WorkerRunResultSchema } from "../phase-02/contracts";
import { evaluateArtifactContract } from "../policy/artifact-contract";
import { type ArtifactVerifier } from "../phase-02/trusted-core";
import { PrincipalSchema } from "../phase-03/contracts";
import { canonicalJson } from "../promotion/schema";

const DecimalSchema = z.string().regex(/^[1-9][0-9]*$/u);
export const StartSessionCommandSchema = z.object({
  principal: PrincipalSchema, admissionReference: z.string().min(1), idempotencyKey: z.string().min(1), expectedVersion: z.literal(0),
  maximum: DecimalSchema, policyVersion: z.string().min(1), idea: z.string(),
}).strict();
export const SessionActionResultSchema = z.discriminatedUnion("status", [
  z.object({ status: z.literal("completed"), code: z.literal("ACTION_COMMITTED"), accountId: z.string().min(1), sessionId: z.string().min(1), sessionVersion: z.literal(1), artifactVersion: z.literal(1), confirmedSpend: z.string(), remainingCap: z.string(), remainingBalance: z.string(), nextAction: z.literal("revise_session"), operationId: z.string().min(1) }).strict(),
  z.object({ status: z.literal("failed"), code: z.literal("WORKER_OR_ARTIFACT_FAILED"), accountId: z.string().min(1), sessionId: z.string().min(1), sessionVersion: z.literal(0), artifactVersion: z.literal(0), confirmedSpend: z.string(), remainingCap: z.string(), remainingBalance: z.string(), nextAction: z.literal("revise_session"), operationId: z.string().min(1) }).strict(),
  z.object({ status: z.literal("billing_invariant_failed"), code: z.string().min(1), accountId: z.string().min(1), sessionId: z.string().min(1), nextAction: z.literal("billing_reconciliation"), operationId: z.string().min(1) }).strict(),
  z.object({ status: z.literal("usage_unknown"), code: z.literal("USAGE_UNKNOWN"), accountId: z.string().min(1), sessionId: z.string().min(1), nextAction: z.literal("billing_reconciliation"), operationId: z.string().min(1) }).strict(),
  z.object({ status: z.literal("denied"), code: z.string().min(1) }).strict(),
]);
export type StartSessionCommand = z.infer<typeof StartSessionCommandSchema>;
export type SessionActionResult = z.infer<typeof SessionActionResultSchema>;

const TOKEN_COUNTER = Object.freeze({ version: "phase-02-whitespace-token-counter-v1", count: (idea: string) => idea.trim().split(/\s+/u).filter(Boolean).length });
const RISK_DETECTOR: RiskSignalDetector = Object.freeze({ version: "phase-02-deterministic-risk-detector-v1", detect: () => [] });
function freeze<T>(value: T): T { return Object.freeze(value); }
async function hash(value: unknown): Promise<string> { const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(canonicalJson(value))); return Array.from(new Uint8Array(digest), (byte) => byte.toString(16).padStart(2, "0")).join(""); }

/** Transport-neutral funded creation coordinator. It owns billing and provider intent; workers remain proposal-only. */
export class MeteredGenerationService {
  #inFlight = new Map<string, Promise<SessionActionResult>>();
  constructor(private readonly options: Readonly<{ fundedAdmission: FundedAdmissionService; store: MeteredFundingStore; gateway: ModelGateway; worker: WorkerPort; artifactVerifier: ArtifactVerifier; riskDetector?: RiskSignalDetector }>) {}

  async startSession(input: unknown): Promise<SessionActionResult> {
    const command = StartSessionCommandSchema.parse(input);
    // This runs before account lookup, reservations, persisted operation intent, model, worker, and ledger effects.
    const risk = await evaluateRisk({ idea: command.idea }, TOKEN_COUNTER, this.options.riskDetector ?? RISK_DETECTOR, []);
    if (risk.status !== "accepted") return SessionActionResultSchema.parse({ status: "denied", code: risk.code });
    const accountId = await accountIdForPrincipal(command.principal);
    const fingerprint = await hash({ accountId, command }); const key = `${accountId}\u0000${command.idempotencyKey}`;
    const recorded = await this.options.store.findMeteredAction(accountId, command.idempotencyKey);
    if (recorded?.fingerprint !== undefined && recorded.fingerprint !== fingerprint) throw new Error("IDEMPOTENCY_KEY_CONFLICT");
    if (recorded?.result) return SessionActionResultSchema.parse(recorded.result);
    const active = this.#inFlight.get(key); if (active) return active;
    const run = this.execute(command, accountId, fingerprint).finally(() => this.#inFlight.delete(key));
    this.#inFlight.set(key, run); return run;
  }

  async sessionStatus(input: Readonly<{ accountId: string; idempotencyKey: string }>): Promise<SessionActionResult | undefined> {
    const action = await this.options.store.findMeteredAction(input.accountId, input.idempotencyKey);
    return action?.result ? SessionActionResultSchema.parse(action.result) : undefined;
  }

  private async execute(command: StartSessionCommand, accountId: string, fingerprint: string): Promise<SessionActionResult> {
    const profile = PHASE_04_MODEL_PROFILES["code-proposal"];
    const budget = await this.options.fundedAdmission.authorizeActionBudget({ principal: command.principal, admissionReference: command.admissionReference, idempotencyKey: `phase-04:${command.idempotencyKey}`, maximum: command.maximum, unit: "sat" });
    const sessionId = `session:${(await hash({ accountId, key: command.idempotencyKey })).slice(0, 24)}`;
    const operationId = `operation:${(await hash({ accountId, key: command.idempotencyKey, profile: profile.id })).slice(0, 24)}`;
    const actionId = `start:${command.idempotencyKey}`;
    const prepared = await this.options.store.transact(accountId, (transaction) => transaction.prepareMeteredAction({ accountId, idempotencyKey: command.idempotencyKey, fingerprint, sessionId, actionId, expectedVersion: command.expectedVersion, admissionReference: command.admissionReference, actionBudgetReference: budget.reference, maximum: BigInt(command.maximum), operationId, profileId: profile.id, priceCardId: PHASE_04_DETERMINISTIC_PRICE_CARD.id }));
    if (prepared.result) return SessionActionResultSchema.parse(prepared.result);
    const claim = await this.options.store.transact(accountId, (transaction) => transaction.claimProviderOperation(operationId));
    if (!claim.claimed && claim.action.result) return SessionActionResultSchema.parse(claim.action.result);
    const intent = ProviderOperationIntentSchema.parse({ operationId, accountId, sessionId, actionId, expectedVersion: command.expectedVersion, actionBudgetReference: budget.reference, profileId: profile.id, priceCardId: PHASE_04_DETERMINISTIC_PRICE_CARD.id, requestFingerprint: fingerprint, maximumUnits: profile.maximumUnits, selection: "unselected" });
    const observation = ModelObservationSchema.parse(await this.options.gateway.dispatch(intent, new AbortController().signal));
    if (observation.status === "usage_unknown") return SessionActionResultSchema.parse({ status: "usage_unknown", code: "USAGE_UNKNOWN", accountId, sessionId, nextAction: "billing_reconciliation", operationId });
    const priced = priceReceipt({ receipt: observation.receipt, card: PHASE_04_DETERMINISTIC_PRICE_CARD, profile, reservation: command.maximum });
    if (priced.status !== "priced") {
      const result = SessionActionResultSchema.parse({ status: "billing_invariant_failed", code: priced.code, accountId, sessionId, nextAction: "billing_reconciliation", operationId });
      await this.options.store.transact(accountId, (transaction) => transaction.finalizeMeteredAction({ idempotencyKey: command.idempotencyKey, operationId, receiptCharge: "0", providerReceiptReference: observation.receipt.provenance.protectedEvidenceReference, status: "billing_invariant_failed", result, sessionVersion: 0, artifactVersion: 0 }));
      return result;
    }
    await this.options.store.transact(accountId, (transaction) => transaction.recordUsageReceipt({ operationId, protectedEvidenceReference: observation.receipt.provenance.protectedEvidenceReference }));
    let completed = observation.status === "completed";
    try {
      const request = WorkerRunRequestSchema.parse({ sessionId, actionId, expectedVersion: command.expectedVersion, policyVersion: command.policyVersion, capabilityGrant: "phase-04-coordinator-grant", workspaceId: `workspace:${sessionId}`, idea: riskSafeIdea(command.idea) });
      const workerResult = WorkerRunResultSchema.parse(await this.options.worker.run(request, new AbortController().signal));
      if (workerResult.status !== "completed") completed = false;
      else {
        const verified = await this.options.artifactVerifier.verify({ action: { principal: { id: accountId }, sessionId, actionId, kind: "design", idempotencyKey: command.idempotencyKey, expectedVersion: command.expectedVersion, policyVersion: command.policyVersion, idea: command.idea }, request, result: workerResult, events: workerResult.events });
        completed = Boolean(verified && (await evaluateArtifactContract(verified.contractInput)).verdict === "pass");
      }
    } catch { completed = false; }
    const status = completed ? "completed" as const : "failed" as const;
    const result = SessionActionResultSchema.parse(completed
      ? { status, code: "ACTION_COMMITTED", accountId, sessionId, sessionVersion: 1, artifactVersion: 1, confirmedSpend: priced.total, remainingCap: "0", remainingBalance: "0", nextAction: "revise_session", operationId }
      : { status, code: "WORKER_OR_ARTIFACT_FAILED", accountId, sessionId, sessionVersion: 0, artifactVersion: 0, confirmedSpend: priced.total, remainingCap: "0", remainingBalance: "0", nextAction: "revise_session", operationId });
    const finalized = await this.options.store.transact(accountId, (transaction) => transaction.finalizeMeteredAction({ idempotencyKey: command.idempotencyKey, operationId, receiptCharge: priced.total, providerReceiptReference: observation.receipt.provenance.protectedEvidenceReference, status, result, sessionVersion: completed ? 1 : 0, artifactVersion: completed ? 1 : 0 }));
    return SessionActionResultSchema.parse({ ...result, ...(result.status === "completed" || result.status === "failed" ? { remainingCap: finalized.remainingCap!, remainingBalance: finalized.remainingBalance! } : {}) });
  }
}

function riskSafeIdea(idea: string): string { return idea; }
