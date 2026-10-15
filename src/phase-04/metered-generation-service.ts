import { z } from "zod";
import { ContinuationService, type VerifiedCreditWakeHint, type VerifiedCreditWakeResult } from "../continuity/continuation-service";
import { NeedsTopUpResultSchema } from "../continuity/contracts";
import { evaluateRisk, type RiskSignalDetector } from "../admission/risk-policy";
import { accountIdForPrincipal } from "../domain/account-command";
import { FundedAdmissionService } from "../funding/funded-admission";
import { type ModelGateway, ModelObservationSchema, ProviderOperationIntentSchema } from "../model/model-gateway";
import { PHASE_04_DETERMINISTIC_PRICE_CARD, PHASE_04_MODEL_PROFILES, maximumOperationCharge, priceReceipt, type ModelProfile, type PriceCard } from "../model/price-card";
import { type ContinuationFundingStore, type MeteredFundingStore } from "../persistence/funding-store";
import { type WorkerPort, WorkerRunRequestSchema, WorkerRunResultSchema } from "../phase-02/contracts";
import { evaluateArtifactContract } from "../policy/artifact-contract";
import { type ArtifactVerifier } from "../phase-02/trusted-core";
import { PrincipalSchema } from "../phase-03/contracts";
import { canonicalJson } from "../promotion/schema";
import { type NappletHarness, type NappletHarnessRequest } from "./napplet-harness";
import { evaluateAutomaticRepair } from "./repair-policy";
import { emitLifecycleObservation, type LifecycleTelemetryPort } from "../telemetry/contracts";
import type { SourceProposalStore } from "../dev/source-proposal-store";

const DecimalSchema = z.string().regex(/^[1-9][0-9]*$/u);
const GenerationProjectionSchema = z.object({
  provider: z.string().min(1), model: z.string().min(1), profileId: z.string().min(1), priceCardId: z.string().min(1),
  usage: z.array(z.object({ dimension: z.string().min(1), units: z.string().regex(/^[0-9]+$/u) }).strict()).min(1),
  source: z.literal("durably recorded"), worker: z.literal("verified"),
}).strict();
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
  NeedsTopUpResultSchema,
  z.object({ status: z.literal("completed"), code: z.literal("ACTION_COMMITTED"), accountId: z.string().min(1), sessionId: z.string().min(1), sessionVersion: z.number().int().positive(), artifactVersion: z.number().int().positive(), artifactId: z.string().min(1).optional(), confirmedSpend: z.string(), remainingCap: z.string(), remainingBalance: z.string(), nextAction: z.literal("revise_session"), operationId: z.string().min(1), generation: GenerationProjectionSchema.optional() }).strict(),
  z.object({ status: z.literal("failed"), code: z.enum(["WORKER_OR_ARTIFACT_FAILED", "RECONCILED_RECEIPT_FOUND", "PROVIDER_NOT_ACCEPTED"]), accountId: z.string().min(1), sessionId: z.string().min(1), sessionVersion: z.number().int().nonnegative(), artifactVersion: z.number().int().nonnegative(), confirmedSpend: z.string(), remainingCap: z.string(), remainingBalance: z.string(), nextAction: z.literal("revise_session"), operationId: z.string().min(1) }).strict(),
  z.object({ status: z.literal("billing_invariant_failed"), code: z.string().min(1), accountId: z.string().min(1), sessionId: z.string().min(1), nextAction: z.literal("billing_reconciliation"), operationId: z.string().min(1) }).strict(),
  z.object({ status: z.literal("usage_unknown"), code: z.literal("USAGE_UNKNOWN"), accountId: z.string().min(1), sessionId: z.string().min(1), nextAction: z.literal("billing_reconciliation"), operationId: z.string().min(1) }).strict(),
  z.object({ status: z.literal("denied"), code: z.string().min(1) }).strict(),
]);
export type StartSessionCommand = z.infer<typeof StartSessionCommandSchema>;
export type ReviseSessionCommand = z.infer<typeof ReviseSessionCommandSchema>;
export type TriggerValidationRepairCommand = z.infer<typeof TriggerValidationRepairCommandSchema>;
export type SessionActionResult = z.infer<typeof SessionActionResultSchema>;
type ContinuationWakePort = Readonly<{
  continueAction(input: Readonly<{ pendingActionReference: string; actionBudgetReference: string; operationId: string; liveLeaseToken: string }>): Promise<void>;
  /** Lookup-only exact-operation observer used during coordinator restart. */
  observeAction?(input: Readonly<{ accountId: string; sessionId: string; pauseGeneration: number; operationId: string; actionBudgetReference: string; liveLeaseToken: string }>): Promise<"completed" | "unknown">;
}>;

const TOKEN_COUNTER = Object.freeze({ version: "phase-02-whitespace-token-counter-v1", count: (idea: string) => idea.trim().split(/\s+/u).filter(Boolean).length });
const RISK_DETECTOR: RiskSignalDetector = Object.freeze({ version: "phase-02-deterministic-risk-detector-v1", detect: () => [] });
function freeze<T>(value: T): T { return Object.freeze(value); }
async function hash(value: unknown): Promise<string> { const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(canonicalJson(value))); return Array.from(new Uint8Array(digest), (byte) => byte.toString(16).padStart(2, "0")).join(""); }

/** Transport-neutral funded creation coordinator. It owns billing and provider intent; workers remain proposal-only. */
export class MeteredGenerationService {
  #inFlight = new Map<string, Promise<SessionActionResult>>();
  #sessionTails = new Map<string, Promise<void>>();
  constructor(private readonly options: Readonly<{ fundedAdmission: FundedAdmissionService; store: MeteredFundingStore; gateway: ModelGateway; worker: WorkerPort; artifactVerifier: ArtifactVerifier; proposalStore?: SourceProposalStore; pricing?: Readonly<{ card: PriceCard; profile: ModelProfile }>; riskDetector?: RiskSignalDetector; harness?: Readonly<{ runner: NappletHarness; toolchain: NappletHarnessRequest["toolchain"]; snapshotReference: string; priorArtifactId: string; approvedApplicationSurfaces: readonly string[] }>; continuation?: ContinuationService; clock?: Readonly<{ nowMs(): number }>; continuationWake?: ContinuationWakePort; telemetry?: LifecycleTelemetryPort }>) {}

  #continuation(): ContinuationService {
    const continuationStore = this.options.store as MeteredFundingStore & Partial<ContinuationFundingStore>;
    if (typeof continuationStore.findContinuation !== "function" || typeof continuationStore.listLiveContinuationPauses !== "function" || typeof continuationStore.listOutstandingWakeDispatches !== "function") throw new Error("CONTINUATION_STORE_UNAVAILABLE");
    // A supplied facade owns explicit resume dependencies. When this
    // coordinator also owns an exact-operation observer, build the narrow
    // wake facade here so restart recovery cannot silently drop that port.
    if (this.options.continuation && !this.options.continuationWake?.observeAction) return this.options.continuation;
    return new ContinuationService({
      store: continuationStore as ContinuationFundingStore,
      ...(this.options.clock ? { clock: this.options.clock } : {}),
      ...(this.options.continuationWake?.observeAction ? { wakeReconciliation: { observe: this.options.continuationWake.observeAction } } : {}),
    });
  }

  /** Internal coordinator hook for a verified-credit hint. It carries no rail payload and cannot widen the session cap. */
  async wakePausedAction(input: VerifiedCreditWakeHint): Promise<VerifiedCreditWakeResult> {
    const continuation = this.#continuation();
    const result = await continuation.wakePausedAction(input);
    // Only the transaction that claimed the coupled effect may cross the
    // worker/provider boundary. A throw is ambiguous, so record unknown and
    // require bounded reconciliation instead of launching a duplicate action.
    if (result.status === "continued" && this.options.continuationWake && result.pendingActionReference && result.actionBudgetReference && result.operationId && result.leaseToken && result.dispatchClaimToken) {
      try {
        await this.options.continuationWake.continueAction({ pendingActionReference: result.pendingActionReference, actionBudgetReference: result.actionBudgetReference, operationId: result.operationId, liveLeaseToken: result.leaseToken });
        await continuation.recordWakeDispatchOutcome({ accountId: input.accountId, sessionId: input.sessionId, pauseGeneration: input.pauseGeneration, dispatchClaimToken: result.dispatchClaimToken, outcome: "completed" });
      } catch (error) {
        await continuation.recordWakeDispatchOutcome({ accountId: input.accountId, sessionId: input.sessionId, pauseGeneration: input.pauseGeneration, dispatchClaimToken: result.dispatchClaimToken, outcome: "unknown" });
        throw error;
      }
    }
    return result;
  }

  /**
   * Verified rails call this owner-only surface after the ledger credit is
   * durable. It discovers pre-deadline live pauses from the server store and
   * feeds each exact stored tuple through the existing atomic wake authority.
   * This is synchronous handling of already-admitted work, never a queue.
   */
  async dispatchVerifiedCredit(accountId: string): Promise<readonly VerifiedCreditWakeResult[]> {
    const store = this.options.store as MeteredFundingStore & ContinuationFundingStore;
    const nowMs = (this.options.clock ?? { nowMs: Date.now }).nowMs();
    const pauses = await store.listLiveContinuationPauses(accountId, nowMs);
    const results: VerifiedCreditWakeResult[] = [];
    for (const pause of pauses) {
      // Discovery returns only rows with a live lease. Keep the guard local so
      // an impossible/corrupt projection cannot be converted into authority.
      if (pause.accountId !== accountId || !pause.liveLeaseToken) continue;
      results.push(await this.wakePausedAction({
        accountId: pause.accountId,
        sessionId: pause.sessionId,
        pauseGeneration: pause.pauseGeneration,
        liveLeaseToken: pause.liveLeaseToken,
        pendingFingerprint: pause.pendingFingerprint,
        expectedSessionVersion: pause.expectedSessionVersion,
        expectedArtifactVersion: pause.intent.expectedArtifactVersion,
      }));
    }
    return freeze(results);
  }

  /** Coordinator restart scheduling surface; it observes existing effects only. */
  async reconcileOutstandingWakeDispatches(accountId: string): Promise<readonly Readonly<{ sessionId: string; pauseGeneration: number; outcome: "completed" | "unknown" | "not_found" }>[]> {
    return this.#continuation().reconcileOutstandingWakeDispatches(accountId);
  }

  /** Called by the lease-bound resumed worker coordinator after terminal action accounting. */
  async completeResumedAction(input: Readonly<{ accountId: string; checkpointId: string; allocationIntentReference: string; leaseToken: string; actionId: string; operationId: string; finalization: import("../persistence/funding-store").MeteredFinalizeInput }>): Promise<void> {
    await this.#continuation().completeResumedAction(input);
  }

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
   * Internal pre-admission handoff.  The caller must have already bound an
   * owner-scoped accepted admission in durable storage.  This bypasses only
   * the legacy live-worker pause state machine; all regular risk, admission,
   * action-budget, provider, worker, verification, and ledger fences remain.
   */
  async startSessionAfterAdmission(input: unknown): Promise<SessionActionResult> {
    const command = StartSessionCommandSchema.parse(input);
    const risk = await evaluateRisk({ idea: command.idea }, TOKEN_COUNTER, this.options.riskDetector ?? RISK_DETECTOR, []);
    if (risk.status !== "accepted") return SessionActionResultSchema.parse({ status: "denied", code: risk.code });
    const accountId = await accountIdForPrincipal(command.principal);
    const fingerprint = await hash({ accountId, command }); const key = `${accountId}\u0000${command.idempotencyKey}`;
    const recorded = await this.options.store.findMeteredAction(accountId, command.idempotencyKey);
    if (recorded?.fingerprint !== undefined && recorded.fingerprint !== fingerprint) throw new Error("IDEMPOTENCY_KEY_CONFLICT");
    if (recorded?.result) return SessionActionResultSchema.parse(recorded.result);
    const active = this.#inFlight.get(key); if (active) return active;
    const run = this.execute(command, accountId, fingerprint, { bypassLegacyContinuation: true }).finally(() => this.#inFlight.delete(key));
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
      const durableFailure = origin?.artifact;
      if (!durableFailure?.failedArtifactId || !durableFailure.validationReportReference) {
        return SessionActionResultSchema.parse({ status: "denied", code: "REPAIR_LINEAGE_UNAVAILABLE" });
      }
      const decision = evaluateAutomaticRepair({
        principalId: accountId, sessionId: command.sessionId, expectedVersion: command.expectedVersion, currentVersion: session?.version ?? -1,
        workspaceLineage: durableFailure.workspaceLineage, snapshotReference: durableFailure.snapshotReference, originatingActionId: command.originatingActionId, failedArtifactId: durableFailure.failedArtifactId, validationReportReference: durableFailure.validationReportReference,
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

  private async execute(command: StartSessionCommand | ReviseSessionCommand | (TriggerValidationRepairCommand & Readonly<{ repair: true }>), accountId: string, fingerprint: string, options: Readonly<{ bypassLegacyContinuation?: boolean }> = {}): Promise<SessionActionResult> {
    const profile = this.options.pricing?.profile ?? PHASE_04_MODEL_PROFILES["code-proposal"];
    const priceCard = this.options.pricing?.card ?? PHASE_04_DETERMINISTIC_PRICE_CARD;
    // The profile's bounded worst-case charge is the authorization ceiling.
    // Do this before creating an action or dispatching the provider: a caller
    // may approve more than this ceiling, but never less.
    const profileCeiling = maximumOperationCharge({ card: priceCard, profile });
    if (BigInt(command.maximum) < BigInt(profileCeiling)) {
      return SessionActionResultSchema.parse({ status: "denied", code: "ACTION_MAXIMUM_BELOW_PROFILE_CEILING" });
    }
    const sessionId = "sessionId" in command ? command.sessionId : `session:${(await hash({ accountId, key: command.idempotencyKey })).slice(0, 24)}`;
    const actionKind = "repair" in command ? "repair" as const : "revision" in command ? "revise_session" as const : "start_session" as const;
    const boundedPayloadHash = await hash("repair" in command ? { repair: command.originatingActionId } : "revision" in command ? { revision: command.revision } : { idea: command.idea });
    const pauseFingerprint = await hash({ accountId, sessionId, actionKind, boundedPayloadHash, expectedSessionVersion: command.expectedVersion, expectedArtifactVersion: command.expectedVersion, policyVersion: command.policyVersion, priceCardId: priceCard.id, profileId: profile.id, toolchainId: "phase-04-deterministic-toolchain", actionMaximum: profileCeiling, idempotencyKey: command.idempotencyKey });
    if (!options.bypassLegacyContinuation) {
      const continuation = this.#continuation();
      const paused = await continuation.pauseForFunding({ intent: { accountId, sessionId, idempotencyKey: command.idempotencyKey, fingerprint: pauseFingerprint, reference: `pending:${(await hash({ accountId, key: command.idempotencyKey, pauseFingerprint })).slice(0, 24)}`, actionKind, boundedPayloadHash, expectedSessionVersion: command.expectedVersion, expectedArtifactVersion: command.expectedVersion, policyVersion: command.policyVersion, priceCardId: priceCard.id, profileId: profile.id, toolchainId: "phase-04-deterministic-toolchain", actionMaximum: profileCeiling, admissionReference: command.admissionReference } });
      if (paused) return SessionActionResultSchema.parse(paused);
    }
    const operationId = `operation:${(await hash({ accountId, key: command.idempotencyKey, profile: profile.id })).slice(0, 24)}`;
    const lifecycleCorrelation = [accountId, sessionId, operationId] as const;
    // Database action IDs are globally primary-keyed.  Include owner/session
    // identity while retaining lookup by the existing account-scoped command
    // key, so identical keys from different principals cannot collide.
    const actionId = "repair" in command
      ? `repair:${(await hash({ accountId, sessionId, origin: command.originatingActionId, key: command.idempotencyKey })).slice(0, 24)}`
      : "revision" in command
        ? `revision:${(await hash({ accountId, sessionId, key: command.idempotencyKey })).slice(0, 24)}`
        : `start:${(await hash({ accountId, sessionId, key: command.idempotencyKey })).slice(0, 24)}`;
    const { budget, prepared } = await this.options.store.transact(accountId, async (transaction) => {
      const budget = await this.options.fundedAdmission.authorizeActionBudget({ principal: command.principal, admissionReference: command.admissionReference, idempotencyKey: `phase-04:${command.idempotencyKey}`, maximum: profileCeiling, unit: "sat" }, transaction);
      const prepared = await transaction.prepareMeteredAction({ accountId, idempotencyKey: command.idempotencyKey, fingerprint, sessionId, actionId, expectedVersion: command.expectedVersion, admissionReference: command.admissionReference, actionBudgetReference: budget.reference, maximum: BigInt(profileCeiling), operationId, profileId: profile.id, priceCardId: priceCard.id });
      return { budget, prepared };
    });
    if (prepared.result) return SessionActionResultSchema.parse(prepared.result);
    const durableActionId = prepared.actionId;
    // Construct the exact same coordinator intent before the durable claim so
    // a later process can perform lookup-only recovery of this operation.  It
    // must never invent a new prompt, profile/card, or provider request ID.
    const providerRequestId = operationId;
    const prompt = "repair" in command ? "Repair the charged focused napplet." : "revision" in command ? command.revision : command.idea;
    const priorForIntent = (await this.options.store.listMeteredActionsForSession(accountId, sessionId)).filter((item) => item.artifact?.artifactId).sort((left, right) => (right.artifactVersion ?? 0) - (left.artifactVersion ?? 0))[0];
    const intent = ProviderOperationIntentSchema.parse({ operationId, providerRequestId, accountId, sessionId, actionId: durableActionId, expectedVersion: command.expectedVersion, actionBudgetReference: budget.reference, profileId: profile.id, priceCardId: priceCard.id, requestFingerprint: fingerprint, prompt, ...(priorForIntent?.artifact?.artifactId ? { authorizedPriorArtifactReference: priorForIntent.artifact.artifactId } : {}), maximumUnits: profile.maximumUnits, selection: "unselected" });
    const claim = await this.options.store.transact(accountId, (transaction) => transaction.claimProviderOperation(operationId));
    if (!claim.claimed && claim.action.result) return SessionActionResultSchema.parse(claim.action.result);
    let observation: z.infer<typeof ModelObservationSchema>;
    if (!claim.claimed) {
      // The durable provider-operation claim is the cross-process effect
      // fence.  Recovery can only look up this exact persisted intent.
      try {
        const lookup = await this.options.gateway.lookup(intent, new AbortController().signal);
        if (lookup.status === "receipt_found") observation = ModelObservationSchema.parse({ status: "completed", receipt: lookup.receipt, ...(lookup.sourceProposalReference ? { sourceProposalReference: lookup.sourceProposalReference } : {}) });
        else if (lookup.status === "definitive_not_accepted") observation = ModelObservationSchema.parse(lookup);
        else return SessionActionResultSchema.parse({ status: "usage_unknown", code: "USAGE_UNKNOWN", accountId, sessionId, nextAction: "billing_reconciliation", operationId });
      } catch {
        return SessionActionResultSchema.parse({ status: "usage_unknown", code: "USAGE_UNKNOWN", accountId, sessionId, nextAction: "billing_reconciliation", operationId });
      }
    } else try {
      observation = ModelObservationSchema.parse(await this.options.gateway.dispatch(intent, new AbortController().signal));
    } catch {
      // A transport exception cannot prove the provider rejected the request.
      // Preserve the original operation for lookup-only recovery.
      await this.options.store.transact(accountId, (transaction) => transaction.recordUsageUnknown({ operationId, providerRequestId: operationId, protectedEvidenceReference: `dispatch-error:${operationId}`, reason: "uncertain_acceptance" }));
      await emitLifecycleObservation(this.options.telemetry, lifecycleCorrelation, "generation", "pending");
      return SessionActionResultSchema.parse({ status: "usage_unknown", code: "USAGE_UNKNOWN", accountId, sessionId, nextAction: "billing_reconciliation", operationId });
    }
    if (observation.status === "usage_unknown") {
      await this.options.store.transact(accountId, (transaction) => transaction.recordUsageUnknown({ operationId, providerRequestId: observation.providerRequestId, protectedEvidenceReference: observation.provenance.protectedEvidenceReference, reason: observation.reason }));
      await emitLifecycleObservation(this.options.telemetry, lifecycleCorrelation, "generation", "pending");
      return SessionActionResultSchema.parse({ status: "usage_unknown", code: "USAGE_UNKNOWN", accountId, sessionId, nextAction: "billing_reconciliation", operationId });
    }
    if (observation.status === "definitive_not_accepted") {
      if (observation.operationId !== operationId || observation.providerRequestId !== providerRequestId) {
        await this.options.store.transact(accountId, (transaction) => transaction.recordUsageUnknown({ operationId, providerRequestId, protectedEvidenceReference: observation.provenance.protectedEvidenceReference, reason: "uncertain_acceptance" }));
        return SessionActionResultSchema.parse({ status: "usage_unknown", code: "USAGE_UNKNOWN", accountId, sessionId, nextAction: "billing_reconciliation", operationId });
      }
      const result = SessionActionResultSchema.parse({ status: "failed", code: "WORKER_OR_ARTIFACT_FAILED", accountId, sessionId, sessionVersion: 0, artifactVersion: 0, confirmedSpend: "0", remainingCap: "0", remainingBalance: "0", nextAction: "revise_session", operationId });
      const finalized = await this.options.store.transact(accountId, (transaction) => transaction.finalizeMeteredAction({ idempotencyKey: command.idempotencyKey, operationId, receiptCharge: "0", providerReceiptReference: observation.provenance.protectedEvidenceReference, status: "failed", result, sessionVersion: 0, artifactVersion: 0 }));
      await emitLifecycleObservation(this.options.telemetry, lifecycleCorrelation, "generation", "failed");
      await emitLifecycleObservation(this.options.telemetry, lifecycleCorrelation, "ledger_settlement", "succeeded");
      return SessionActionResultSchema.parse(finalized.result);
    }
    if (observation.receipt.operationId !== operationId || observation.receipt.providerRequestId !== providerRequestId) {
      await this.options.store.transact(accountId, (transaction) => transaction.recordUsageUnknown({ operationId, providerRequestId, protectedEvidenceReference: observation.receipt.provenance.protectedEvidenceReference, reason: "uncertain_acceptance" }));
      await emitLifecycleObservation(this.options.telemetry, lifecycleCorrelation, "generation", "pending");
      return SessionActionResultSchema.parse({ status: "usage_unknown", code: "USAGE_UNKNOWN", accountId, sessionId, nextAction: "billing_reconciliation", operationId });
    }
    const priced = priceReceipt({ receipt: observation.receipt, card: priceCard, profile, reservation: profileCeiling });
    if (priced.status !== "priced") {
      const result = SessionActionResultSchema.parse({ status: "billing_invariant_failed", code: priced.code, accountId, sessionId, nextAction: "billing_reconciliation", operationId });
      await this.options.store.transact(accountId, (transaction) => transaction.finalizeMeteredAction({ idempotencyKey: command.idempotencyKey, operationId, receiptCharge: "0", providerReceiptReference: observation.receipt.provenance.protectedEvidenceReference, status: "billing_invariant_failed", result, sessionVersion: 0, artifactVersion: 0 }));
      await emitLifecycleObservation(this.options.telemetry, lifecycleCorrelation, "generation", "succeeded");
      await emitLifecycleObservation(this.options.telemetry, lifecycleCorrelation, "ledger_settlement", "blocked");
      return result;
    }
    await this.options.store.transact(accountId, (transaction) => transaction.recordUsageReceipt({ operationId, protectedEvidenceReference: observation.receipt.provenance.protectedEvidenceReference }));
    const proposal = observation.sourceProposalReference && this.options.proposalStore ? await this.options.proposalStore.lookup({ intent, reference: observation.sourceProposalReference }) : undefined;
    if (observation.sourceProposalReference && !proposal) {
      await this.options.store.transact(accountId, (transaction) => transaction.recordUsageUnknown({ operationId, providerRequestId, protectedEvidenceReference: observation.receipt.provenance.protectedEvidenceReference, reason: "mismatched_receipt" }));
      return SessionActionResultSchema.parse({ status: "usage_unknown", code: "USAGE_UNKNOWN", accountId, sessionId, nextAction: "billing_reconciliation", operationId });
    }
    // Workspace/checkpoint references are coordinator-owned, action-scoped
    // identities.  Revisions inherit only the prior durable verified lineage;
    // they never read a process-wide harness default shared with another user.
    const history = await this.options.store.listMeteredActionsForSession(accountId, sessionId);
    const prior = [...history].filter((item) => item.artifact?.artifactId).sort((left, right) => (right.artifactVersion ?? 0) - (left.artifactVersion ?? 0))[0];
    const workspaceLineage = prior?.artifact?.workspaceLineage ?? `workspace:${sessionId}`;
    const checkpointReference = `checkpoint:${sessionId}:${durableActionId}`;
    const snapshotReference = prior?.artifact?.snapshotReference ?? `snapshot:${sessionId}:initial`;
    let artifactId: string | undefined;
    let validationEvidenceReference = observation.receipt.provenance.protectedEvidenceReference;
    let failedArtifactId: string | undefined;
    let validationReportReference: string | undefined;
    let completed = observation.status === "completed";
    try {
      const idea = "repair" in command ? "Repair only the server-validated failed candidate within the existing focused napplet boundary." : "revision" in command ? command.revision : command.idea;
      const workspaceId = workspaceLineage;
      if (this.options.harness) {
        const harness = this.options.harness.runner;
        const outcome = await harness.run({ principalId: accountId, sessionId, actionId: durableActionId, expectedVersion: command.expectedVersion, policyVersion: command.policyVersion, capabilityGrant: "phase-04-coordinator-grant", workspaceId, ...(proposal ? { sourceProposal: proposal.proposal } : { idea: riskSafeIdea(idea) }), actionKind: "repair" in command ? "repair" : "revision" in command ? "revision" : "generation", workspaceLineage, snapshotReference, priorArtifactId: prior?.artifact?.artifactId ?? `none:${sessionId}`, approvedApplicationSurfaces: this.options.harness.approvedApplicationSurfaces, toolchain: this.options.harness.toolchain });
        completed = outcome.status === "verified";
        if (outcome.status === "verified") {
          artifactId = outcome.artifactId;
          validationEvidenceReference = outcome.evidenceIds.join(",");
        } else {
          validationEvidenceReference = outcome.diagnostic.evidenceIds.join(",");
          failedArtifactId = outcome.priorArtifactId;
          validationReportReference = outcome.diagnostic.evidenceIds.at(-1);
        }
      } else {
        const request = WorkerRunRequestSchema.parse({ sessionId, actionId: durableActionId, expectedVersion: command.expectedVersion, policyVersion: command.policyVersion, capabilityGrant: "phase-04-coordinator-grant", workspaceId, ...(proposal ? { sourceProposalReference: proposal.proposal.reference, sourceProposalSha256: proposal.proposal.sha256, sourceProposalFiles: proposal.proposal.files } : { idea: riskSafeIdea(idea) }) });
        const workerResult = WorkerRunResultSchema.parse(await this.options.worker.run(request, new AbortController().signal));
        if (workerResult.status !== "completed") completed = false;
        else {
          const verified = await this.options.artifactVerifier.verify({ action: { principal: { id: accountId }, sessionId, actionId: durableActionId, kind: "design", idempotencyKey: command.idempotencyKey, expectedVersion: command.expectedVersion, policyVersion: command.policyVersion, idea }, request, result: workerResult, events: workerResult.events });
          completed = Boolean(verified && (await evaluateArtifactContract(verified.contractInput)).verdict === "pass");
          if (completed && verified) {
            artifactId = verified.artifact.artifactId;
            validationEvidenceReference = `verification:${verified.artifact.artifactId}`;
          }
        }
      }
    } catch { completed = false; }
    const status = completed ? "completed" as const : "failed" as const;
    const result = SessionActionResultSchema.parse(completed
      ? { status, code: "ACTION_COMMITTED", accountId, sessionId, sessionVersion: command.expectedVersion + 1, artifactVersion: command.expectedVersion + 1, artifactId: artifactId!, confirmedSpend: priced.total, remainingCap: "0", remainingBalance: "0", nextAction: "revise_session", operationId, generation: { provider: observation.receipt.provider, model: observation.receipt.model, profileId: observation.receipt.profileId, priceCardId: observation.receipt.priceCardId, usage: observation.receipt.usage, source: "durably recorded" as const, worker: "verified" as const } }
      : { status, code: "WORKER_OR_ARTIFACT_FAILED", accountId, sessionId, sessionVersion: command.expectedVersion, artifactVersion: command.expectedVersion, confirmedSpend: priced.total, remainingCap: "0", remainingBalance: "0", nextAction: "revise_session", operationId });
    const finalized = await this.options.store.transact(accountId, (transaction) => transaction.finalizeMeteredAction({ idempotencyKey: command.idempotencyKey, operationId, receiptCharge: priced.total, providerReceiptReference: observation.receipt.provenance.protectedEvidenceReference, status, result, sessionVersion: completed ? command.expectedVersion + 1 : command.expectedVersion, artifactVersion: completed ? command.expectedVersion + 1 : command.expectedVersion, artifact: { ...(artifactId ? { artifactId } : {}), workspaceLineage, checkpointReference, snapshotReference: `snapshot:${sessionId}:${durableActionId}`, validationEvidenceReference, ...(failedArtifactId ? { failedArtifactId } : {}), ...(validationReportReference ? { validationReportReference } : {}) } }));
    await emitLifecycleObservation(this.options.telemetry, lifecycleCorrelation, "generation", "succeeded");
    await emitLifecycleObservation(this.options.telemetry, lifecycleCorrelation, "ledger_settlement", "succeeded");
    return SessionActionResultSchema.parse(finalized.result);
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
