import { z } from "zod";
import { evaluateRisk, type RiskSignalDetector } from "../admission/risk-policy";
import { accountIdForPrincipal } from "../domain/account-command";
import { FundedAdmissionService } from "../funding/funded-admission";
import { type ModelGateway, ModelObservationSchema, ProviderOperationIntentSchema } from "../model/model-gateway";
import { PHASE_04_DETERMINISTIC_PRICE_CARD, PHASE_04_MODEL_PROFILES, maximumOperationCharge, priceReceipt } from "../model/price-card";
import { type MeteredFundingStore } from "../persistence/funding-store";
import { type WorkerPort, WorkerRunRequestSchema, WorkerRunResultSchema } from "../phase-02/contracts";
import { evaluateArtifactContract } from "../policy/artifact-contract";
import { type ArtifactVerifier } from "../phase-02/trusted-core";
import { PrincipalSchema } from "../phase-03/contracts";
import { canonicalJson } from "../promotion/schema";
import { type NappletHarness, type NappletHarnessRequest } from "./napplet-harness";
import { evaluateAutomaticRepair } from "./repair-policy";

const DecimalSchema = z.string().regex(/^[1-9][0-9]*$/u);
export const StartSessionCommandSchema = z.object({
  principal: PrincipalSchema, admissionReference: z.string().min(1), idempotencyKey: z.string().min(1), expectedVersion: z.literal(0),
  maximum: DecimalSchema, policyVersion: z.string().min(1), idea: z.string(),
}).strict();
/** A continuation is always a new paid action; callers cannot supply an artifact or workspace authority. */
export const ReviseSessionCommandSchema = z.object({
  principal: PrincipalSchema, sessionId: z.string().min(1), admissionReference: z.string().min(1), idempotencyKey: z.string().min(1),
  expectedVersion: z.number().int().nonnegative(), maximum: DecimalSchema, policyVersion: z.string().min(1), revision: z.string(),
}).strict();
/** Internal coordinator command. A client cannot select repair as a worker tool. */
export const TriggerValidationRepairCommandSchema = z.object({
  principal: PrincipalSchema, sessionId: z.string().min(1), admissionReference: z.string().min(1), idempotencyKey: z.string().min(1), expectedVersion: z.number().int().nonnegative(), maximum: DecimalSchema, policyVersion: z.string().min(1),
  originatingActionId: z.string().min(1), originatingIdempotencyKey: z.string().min(1), workspaceLineage: z.string().min(1), snapshotReference: z.string().min(1), failedArtifactId: z.string().min(1), validationReportReference: z.string().min(1),
}).strict();
export const SessionActionResultSchema = z.discriminatedUnion("status", [
  z.object({ status: z.literal("completed"), code: z.literal("ACTION_COMMITTED"), accountId: z.string().min(1), sessionId: z.string().min(1), sessionVersion: z.number().int().positive(), artifactVersion: z.number().int().positive(), confirmedSpend: z.string(), remainingCap: z.string(), remainingBalance: z.string(), nextAction: z.literal("revise_session"), operationId: z.string().min(1) }).strict(),
  z.object({ status: z.literal("failed"), code: z.enum(["WORKER_OR_ARTIFACT_FAILED", "RECONCILED_RECEIPT_FOUND", "PROVIDER_NOT_ACCEPTED"]), accountId: z.string().min(1), sessionId: z.string().min(1), sessionVersion: z.number().int().nonnegative(), artifactVersion: z.number().int().nonnegative(), confirmedSpend: z.string(), remainingCap: z.string(), remainingBalance: z.string(), nextAction: z.literal("revise_session"), operationId: z.string().min(1) }).strict(),
  z.object({ status: z.literal("billing_invariant_failed"), code: z.string().min(1), accountId: z.string().min(1), sessionId: z.string().min(1), nextAction: z.literal("billing_reconciliation"), operationId: z.string().min(1) }).strict(),
  z.object({ status: z.literal("usage_unknown"), code: z.literal("USAGE_UNKNOWN"), accountId: z.string().min(1), sessionId: z.string().min(1), nextAction: z.literal("billing_reconciliation"), operationId: z.string().min(1) }).strict(),
  z.object({ status: z.literal("denied"), code: z.string().min(1) }).strict(),
]);
export type StartSessionCommand = z.infer<typeof StartSessionCommandSchema>;
export type ReviseSessionCommand = z.infer<typeof ReviseSessionCommandSchema>;
export type TriggerValidationRepairCommand = z.infer<typeof TriggerValidationRepairCommandSchema>;
export type SessionActionResult = z.infer<typeof SessionActionResultSchema>;

const TOKEN_COUNTER = Object.freeze({ version: "phase-02-whitespace-token-counter-v1", count: (idea: string) => idea.trim().split(/\s+/u).filter(Boolean).length });
const RISK_DETECTOR: RiskSignalDetector = Object.freeze({ version: "phase-02-deterministic-risk-detector-v1", detect: () => [] });
function freeze<T>(value: T): T { return Object.freeze(value); }
async function hash(value: unknown): Promise<string> { const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(canonicalJson(value))); return Array.from(new Uint8Array(digest), (byte) => byte.toString(16).padStart(2, "0")).join(""); }

/** Transport-neutral funded creation coordinator. It owns billing and provider intent; workers remain proposal-only. */
export class MeteredGenerationService {
  #inFlight = new Map<string, Promise<SessionActionResult>>();
  #sessionTails = new Map<string, Promise<void>>();
  constructor(private readonly options: Readonly<{ fundedAdmission: FundedAdmissionService; store: MeteredFundingStore; gateway: ModelGateway; worker: WorkerPort; artifactVerifier: ArtifactVerifier; riskDetector?: RiskSignalDetector; harness?: Readonly<{ runner: NappletHarness; toolchain: NappletHarnessRequest["toolchain"]; snapshotReference: string; priorArtifactId: string; approvedApplicationSurfaces: readonly string[] }> }>) {}

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

  /**
   * Serializes continuation admission by owner and stable session lineage. The
   * durable metered action store remains the source of replay/result truth;
   * this boundary prevents two in-process writers from reserving provider work
   * for the same expected version before the first finalization is visible.
   */
  async reviseSession(input: unknown): Promise<SessionActionResult> {
    const command = ReviseSessionCommandSchema.parse(input);
    const risk = await evaluateRisk({ idea: command.revision }, TOKEN_COUNTER, this.options.riskDetector ?? RISK_DETECTOR, []);
    if (risk.status !== "accepted") return SessionActionResultSchema.parse({ status: "denied", code: risk.code });
    const accountId = await accountIdForPrincipal(command.principal);
    const fingerprint = await hash({ accountId, command });
    const idempotencyKey = `${accountId}\u0000${command.idempotencyKey}`;
    const recorded = await this.options.store.findMeteredAction(accountId, command.idempotencyKey);
    if (recorded?.fingerprint !== undefined && recorded.fingerprint !== fingerprint) throw new Error("IDEMPOTENCY_KEY_CONFLICT");
    if (recorded?.result) return SessionActionResultSchema.parse(recorded.result);
    const active = this.#inFlight.get(idempotencyKey); if (active) return active;
    const run = this.#serializeSession(accountId, command.sessionId, async () => {
      const replay = await this.options.store.findMeteredAction(accountId, command.idempotencyKey);
      if (replay?.fingerprint !== undefined && replay.fingerprint !== fingerprint) throw new Error("IDEMPOTENCY_KEY_CONFLICT");
      if (replay?.result) return SessionActionResultSchema.parse(replay.result);
      const session = await this.options.store.sessionStatus(accountId, command.sessionId);
      if (!session) return SessionActionResultSchema.parse({ status: "denied", code: "SESSION_LINEAGE_MISMATCH" });
      if (session.version !== command.expectedVersion) return SessionActionResultSchema.parse({ status: "denied", code: "STALE_SESSION_VERSION" });
      if (session.status !== "verified") return SessionActionResultSchema.parse({ status: "denied", code: "SESSION_NOT_REVISION_READY" });
      return this.execute(command, accountId, fingerprint);
    }).finally(() => this.#inFlight.delete(idempotencyKey));
    this.#inFlight.set(idempotencyKey, run);
    return run;
  }

  /** Creates at most one coordinator-authorized repair action for a failed validation candidate. */
  async triggerValidationRepair(input: unknown): Promise<SessionActionResult> {
    const command = TriggerValidationRepairCommandSchema.parse(input);
    const accountId = await accountIdForPrincipal(command.principal);
    const fingerprint = await hash({ accountId, command });
    const key = `${accountId}\u0000${command.idempotencyKey}`;
    const recorded = await this.options.store.findMeteredAction(accountId, command.idempotencyKey);
    if (recorded?.fingerprint !== undefined && recorded.fingerprint !== fingerprint) throw new Error("IDEMPOTENCY_KEY_CONFLICT");
    if (recorded?.result) return SessionActionResultSchema.parse(recorded.result);
    const active = this.#inFlight.get(key); if (active) return active;
    const run = this.#serializeSession(accountId, command.sessionId, async () => {
      const origin = await this.options.store.findMeteredAction(accountId, command.originatingIdempotencyKey);
      const session = await this.options.store.sessionStatus(accountId, command.sessionId);
      const sessionActions = await this.options.store.listMeteredActionsForSession(accountId, command.sessionId);
      const decision = evaluateAutomaticRepair({
        principalId: accountId, sessionId: command.sessionId, expectedVersion: command.expectedVersion, currentVersion: session?.version ?? -1,
        workspaceLineage: command.workspaceLineage, snapshotReference: command.snapshotReference, originatingActionId: command.originatingActionId, failedArtifactId: command.failedArtifactId, validationReportReference: command.validationReportReference,
        priorAutomaticRepairs: sessionActions.filter((action) => action.actionId.startsWith(`repair:${command.originatingActionId}:`)).length, permanentNappletPolicy: origin?.actionId === command.originatingActionId && origin.status === "failed" ? "pass" : "deny", actionAuthorized: true,
      });
      if (decision.status === "denied") return SessionActionResultSchema.parse({ status: "denied", code: decision.code });
      return this.execute({ ...command, repair: true }, accountId, fingerprint);
    }).finally(() => this.#inFlight.delete(key));
    this.#inFlight.set(key, run);
    return run;
  }

  async sessionStatus(input: Readonly<{ accountId: string; idempotencyKey: string }>): Promise<SessionActionResult | undefined> {
    const action = await this.options.store.findMeteredAction(input.accountId, input.idempotencyKey);
    return action?.result ? SessionActionResultSchema.parse(action.result) : undefined;
  }

  private async execute(command: StartSessionCommand | ReviseSessionCommand | (TriggerValidationRepairCommand & Readonly<{ repair: true }>), accountId: string, fingerprint: string): Promise<SessionActionResult> {
    const profile = PHASE_04_MODEL_PROFILES["code-proposal"];
    // The profile's bounded worst-case charge is the authorization ceiling.
    // Do this before creating an action or dispatching the provider: a caller
    // may approve more than this ceiling, but never less.
    const profileCeiling = maximumOperationCharge({ card: PHASE_04_DETERMINISTIC_PRICE_CARD, profile });
    if (BigInt(command.maximum) < BigInt(profileCeiling)) {
      return SessionActionResultSchema.parse({ status: "denied", code: "ACTION_MAXIMUM_BELOW_PROFILE_CEILING" });
    }
    const budget = await this.options.fundedAdmission.authorizeActionBudget({ principal: command.principal, admissionReference: command.admissionReference, idempotencyKey: `phase-04:${command.idempotencyKey}`, maximum: profileCeiling, unit: "sat" });
    const sessionId = "sessionId" in command ? command.sessionId : `session:${(await hash({ accountId, key: command.idempotencyKey })).slice(0, 24)}`;
    const operationId = `operation:${(await hash({ accountId, key: command.idempotencyKey, profile: profile.id })).slice(0, 24)}`;
    const actionId = "repair" in command ? `repair:${command.originatingActionId}:${command.idempotencyKey}` : "revision" in command ? `revision:${command.idempotencyKey}` : `start:${command.idempotencyKey}`;
    const prepared = await this.options.store.transact(accountId, (transaction) => transaction.prepareMeteredAction({ accountId, idempotencyKey: command.idempotencyKey, fingerprint, sessionId, actionId, expectedVersion: command.expectedVersion, admissionReference: command.admissionReference, actionBudgetReference: budget.reference, maximum: BigInt(profileCeiling), operationId, profileId: profile.id, priceCardId: PHASE_04_DETERMINISTIC_PRICE_CARD.id }));
    if (prepared.result) return SessionActionResultSchema.parse(prepared.result);
    const claim = await this.options.store.transact(accountId, (transaction) => transaction.claimProviderOperation(operationId));
    if (!claim.claimed && claim.action.result) return SessionActionResultSchema.parse(claim.action.result);
    // A durable claim is the external-effect fence.  A different instance may
    // already be waiting for the original provider response, so this caller
    // must surface reconciliation rather than issue a second billable request.
    if (!claim.claimed) return SessionActionResultSchema.parse({ status: "usage_unknown", code: "USAGE_UNKNOWN", accountId, sessionId, nextAction: "billing_reconciliation", operationId });
    const intent = ProviderOperationIntentSchema.parse({ operationId, accountId, sessionId, actionId, expectedVersion: command.expectedVersion, actionBudgetReference: budget.reference, profileId: profile.id, priceCardId: PHASE_04_DETERMINISTIC_PRICE_CARD.id, requestFingerprint: fingerprint, maximumUnits: profile.maximumUnits, selection: "unselected" });
    let observation: z.infer<typeof ModelObservationSchema>;
    try {
      observation = ModelObservationSchema.parse(await this.options.gateway.dispatch(intent, new AbortController().signal));
    } catch {
      // A transport exception cannot prove the provider rejected the request.
      // Preserve the original operation for lookup-only recovery.
      await this.options.store.transact(accountId, (transaction) => transaction.recordUsageUnknown({ operationId, providerRequestId: operationId, protectedEvidenceReference: `dispatch-error:${operationId}`, reason: "uncertain_acceptance" }));
      return SessionActionResultSchema.parse({ status: "usage_unknown", code: "USAGE_UNKNOWN", accountId, sessionId, nextAction: "billing_reconciliation", operationId });
    }
    if (observation.status === "usage_unknown") {
      await this.options.store.transact(accountId, (transaction) => transaction.recordUsageUnknown({ operationId, providerRequestId: observation.providerRequestId, protectedEvidenceReference: observation.provenance.protectedEvidenceReference, reason: observation.reason }));
      return SessionActionResultSchema.parse({ status: "usage_unknown", code: "USAGE_UNKNOWN", accountId, sessionId, nextAction: "billing_reconciliation", operationId });
    }
    if (observation.status === "definitive_not_accepted") {
      const result = SessionActionResultSchema.parse({ status: "failed", code: "WORKER_OR_ARTIFACT_FAILED", accountId, sessionId, sessionVersion: 0, artifactVersion: 0, confirmedSpend: "0", remainingCap: "0", remainingBalance: "0", nextAction: "revise_session", operationId });
      const finalized = await this.options.store.transact(accountId, (transaction) => transaction.finalizeMeteredAction({ idempotencyKey: command.idempotencyKey, operationId, receiptCharge: "0", providerReceiptReference: observation.provenance.protectedEvidenceReference, status: "failed", result, sessionVersion: 0, artifactVersion: 0 }));
      return SessionActionResultSchema.parse({ ...result, remainingCap: finalized.remainingCap!, remainingBalance: finalized.remainingBalance! });
    }
    const priced = priceReceipt({ receipt: observation.receipt, card: PHASE_04_DETERMINISTIC_PRICE_CARD, profile, reservation: profileCeiling });
    if (priced.status !== "priced") {
      const result = SessionActionResultSchema.parse({ status: "billing_invariant_failed", code: priced.code, accountId, sessionId, nextAction: "billing_reconciliation", operationId });
      await this.options.store.transact(accountId, (transaction) => transaction.finalizeMeteredAction({ idempotencyKey: command.idempotencyKey, operationId, receiptCharge: "0", providerReceiptReference: observation.receipt.provenance.protectedEvidenceReference, status: "billing_invariant_failed", result, sessionVersion: 0, artifactVersion: 0 }));
      return result;
    }
    await this.options.store.transact(accountId, (transaction) => transaction.recordUsageReceipt({ operationId, protectedEvidenceReference: observation.receipt.provenance.protectedEvidenceReference }));
    let completed = observation.status === "completed";
    try {
      const idea = "repair" in command ? "Repair only the server-validated failed candidate within the existing focused napplet boundary." : "revision" in command ? command.revision : command.idea;
      const workspaceId = `workspace:${sessionId}`;
      if (this.options.harness) {
        const harness = this.options.harness.runner;
        const outcome = await harness.run({ principalId: accountId, sessionId, actionId, expectedVersion: command.expectedVersion, policyVersion: command.policyVersion, capabilityGrant: "phase-04-coordinator-grant", workspaceId, idea: riskSafeIdea(idea), actionKind: "repair" in command ? "repair" : "revision" in command ? "revision" : "generation", workspaceLineage: workspaceId, snapshotReference: this.options.harness.snapshotReference, priorArtifactId: this.options.harness.priorArtifactId, approvedApplicationSurfaces: this.options.harness.approvedApplicationSurfaces, toolchain: this.options.harness.toolchain });
        completed = outcome.status === "verified";
      } else {
        const request = WorkerRunRequestSchema.parse({ sessionId, actionId, expectedVersion: command.expectedVersion, policyVersion: command.policyVersion, capabilityGrant: "phase-04-coordinator-grant", workspaceId, idea: riskSafeIdea(idea) });
        const workerResult = WorkerRunResultSchema.parse(await this.options.worker.run(request, new AbortController().signal));
        if (workerResult.status !== "completed") completed = false;
        else {
          const verified = await this.options.artifactVerifier.verify({ action: { principal: { id: accountId }, sessionId, actionId, kind: "design", idempotencyKey: command.idempotencyKey, expectedVersion: command.expectedVersion, policyVersion: command.policyVersion, idea }, request, result: workerResult, events: workerResult.events });
          completed = Boolean(verified && (await evaluateArtifactContract(verified.contractInput)).verdict === "pass");
        }
      }
    } catch { completed = false; }
    const status = completed ? "completed" as const : "failed" as const;
    const result = SessionActionResultSchema.parse(completed
      ? { status, code: "ACTION_COMMITTED", accountId, sessionId, sessionVersion: command.expectedVersion + 1, artifactVersion: command.expectedVersion + 1, confirmedSpend: priced.total, remainingCap: "0", remainingBalance: "0", nextAction: "revise_session", operationId }
      : { status, code: "WORKER_OR_ARTIFACT_FAILED", accountId, sessionId, sessionVersion: command.expectedVersion, artifactVersion: command.expectedVersion, confirmedSpend: priced.total, remainingCap: "0", remainingBalance: "0", nextAction: "revise_session", operationId });
    const finalized = await this.options.store.transact(accountId, (transaction) => transaction.finalizeMeteredAction({ idempotencyKey: command.idempotencyKey, operationId, receiptCharge: priced.total, providerReceiptReference: observation.receipt.provenance.protectedEvidenceReference, status, result, sessionVersion: completed ? command.expectedVersion + 1 : command.expectedVersion, artifactVersion: completed ? command.expectedVersion + 1 : command.expectedVersion }));
    return SessionActionResultSchema.parse({ ...result, ...(result.status === "completed" || result.status === "failed" ? { remainingCap: finalized.remainingCap!, remainingBalance: finalized.remainingBalance! } : {}) });
  }

  async #serializeSession<T>(accountId: string, sessionId: string, operation: () => Promise<T>): Promise<T> {
    const key = `${accountId}\u0000${sessionId}`;
    let release!: () => void;
    const prior = this.#sessionTails.get(key) ?? Promise.resolve();
    const current = new Promise<void>((resolve) => { release = resolve; });
    this.#sessionTails.set(key, current);
    await prior;
    try { return await operation(); }
    finally {
      release();
      if (this.#sessionTails.get(key) === current) this.#sessionTails.delete(key);
    }
  }
}

function riskSafeIdea(idea: string): string { return idea; }
