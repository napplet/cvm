import type { GenerationCommandProtector } from "../model/retained-generation-command";
import { RemixReferenceSchema } from "../remix/reference";
import { z } from "zod";
import { ContinuationService, type VerifiedCreditWakeHint, type VerifiedCreditWakeResult } from "../continuity/continuation-service";
import { NeedsTopUpResultSchema, type PendingActionIntent } from "../continuity/contracts";
import type { PendingCommandPort } from "../continuity/protected-command";
import { evaluateRisk, type RiskSignalDetector } from "../admission/risk-policy";
import { accountIdForPrincipal } from "../domain/account-command";
import { FundedAdmissionService } from "../funding/funded-admission";
import { type ModelGateway, ModelObservationSchema, ProviderOperationIntentSchema, type NormalizedUsageReceipt, type ProviderOperationIntent, type SourceProposalLookup } from "../model/model-gateway";
import { PHASE_04_DETERMINISTIC_PRICE_CARD, PHASE_04_MODEL_PROFILES, maximumOperationCharge, priceReceipt, type ModelProfile, type PriceCard } from "../model/price-card";
import { type ContinuationFundingStore, type MeteredFundingStore, type MeteredAction, type MeteredFinalizeInput } from "../persistence/funding-store";
import { type WorkerPort, WorkerRunRequestSchema, WorkerRunResultSchema } from "../phase-02/contracts";
import { evaluateArtifactContract } from "../policy/artifact-contract";
import { type ArtifactVerifier } from "../phase-02/trusted-core";
import { PrincipalSchema } from "../phase-03/contracts";
import { canonicalJson } from "../promotion/schema";
import { type NappletHarness, type NappletHarnessRequest } from "./napplet-harness";
import { evaluateAutomaticRepair } from "./repair-policy";
import { emitLifecycleObservation, type LifecycleTelemetryPort } from "../telemetry/contracts";
import { FundingCommitOutcomeUnknownError } from "../funding/transaction-outcome";

const DecimalSchema = z.string().regex(/^[1-9][0-9]*$/u);
const GenerationProjectionSchema = z.object({
  provider: z.string().min(1), model: z.string().min(1), profileId: z.string().min(1), priceCardId: z.string().min(1),
  usage: z.array(z.object({ dimension: z.string().min(1), units: z.string().regex(/^[0-9]+$/u) }).strict()).min(1),
  source: z.literal("durably recorded"), worker: z.literal("verified"),
}).strict();
export const StartSessionCommandSchema = z.object({
  remixReference: RemixReferenceSchema.optional(),
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
  z.object({ status: z.literal("failed"), code: z.enum(["WORKER_OR_ARTIFACT_FAILED", "RECONCILED_RECEIPT_FOUND", "PROVIDER_NOT_ACCEPTED", "MODEL_RESPONSE_INTERRUPTED"]), accountId: z.string().min(1), sessionId: z.string().min(1), sessionVersion: z.number().int().nonnegative(), artifactVersion: z.number().int().nonnegative(), confirmedSpend: z.string(), remainingCap: z.string(), remainingBalance: z.string(), nextAction: z.literal("revise_session"), operationId: z.string().min(1) }).strict(),
  z.object({ status: z.literal("billing_invariant_failed"), code: z.string().min(1), accountId: z.string().min(1), sessionId: z.string().min(1), nextAction: z.literal("billing_reconciliation"), operationId: z.string().min(1) }).strict(),
  z.object({ status: z.literal("usage_unknown"), code: z.literal("USAGE_UNKNOWN"), accountId: z.string().min(1), sessionId: z.string().min(1), nextAction: z.literal("billing_reconciliation"), operationId: z.string().min(1) }).strict(),
  z.object({ status: z.literal("denied"), code: z.string().min(1) }).strict(),
]);
export type StartSessionCommand = z.infer<typeof StartSessionCommandSchema>;
export type ReviseSessionCommand = z.infer<typeof ReviseSessionCommandSchema>;
export type TriggerValidationRepairCommand = z.infer<typeof TriggerValidationRepairCommandSchema>;
export type SessionActionResult = z.infer<typeof SessionActionResultSchema>;
export type GenerationCommand = StartSessionCommand | ReviseSessionCommand | (TriggerValidationRepairCommand & Readonly<{ repair: true }>);
export type ContinuationExecutionBinding = Readonly<{ accountId: string; actionKey: string; commandFingerprint: string; actionId: string; operationId: string; actionBudgetReference: string }>;
export type PreparedContinuationExecution = Readonly<{
  readTerminal(binding: ContinuationExecutionBinding): Promise<boolean>;
  execute(input: ContinuationExecutionBinding & Readonly<{ finalizeTerminal(finalization: MeteredFinalizeInput): Promise<void> }>): Promise<SessionActionResult>;
}>;
/** Private coordinator callback: rejection and billing invariants must cross
 * the same continuation authority as paid completion, with no actor fallback. */
export type PreparedActionFinalizer = (input: Readonly<{ finalization: MeteredFinalizeInput; intent: ProviderOperationIntent; receipt?: NormalizedUsageReceipt }>) => Promise<void>;
export type PreparedPricedContinuationExecution = Readonly<{
  readTerminal(): Promise<SessionActionResult | undefined>;
  execute(finalizeAction: PreparedActionFinalizer): Promise<SessionActionResult>;
}>;
type ContinuationWakePort = Readonly<{
  continueAction(input: Readonly<{ pendingActionReference: string; actionBudgetReference: string; operationId: string; liveLeaseToken: string }>): Promise<void>;
  /** Lookup-only exact-operation observer used during coordinator restart. */
  observeAction?(input: Readonly<{ accountId: string; sessionId: string; pauseGeneration: number; operationId: string; actionBudgetReference: string; liveLeaseToken: string }>): Promise<"completed" | "unknown">;
}>;
/** Original action-bound catalog reader, with no fresh pricing authority. */
export type RetainedGenerationPricing = Readonly<{ readOriginal(action: MeteredAction): Promise<Readonly<{ profile: ModelProfile; card: PriceCard }> | undefined> }>;
/** Optional currency settlement seam. The original FX binding survives replay. */
export type GenerationUsageSettlement = Readonly<{
  prepare(input: Readonly<{ accountId: string; operationId: string; card: PriceCard; profile: ModelProfile; at: string }>): Promise<Readonly<{ maximum: string }>>;
  finalize(input: Readonly<{ accountId: string; intent: ProviderOperationIntent; receipt: NormalizedUsageReceipt; pricedAmount: string }>): Promise<Readonly<{ amount: string; providerReceiptReference: string }>>;
}>;

const TOKEN_COUNTER = Object.freeze({ version: "phase-02-whitespace-token-counter-v1", count: (idea: string) => idea.trim().split(/\s+/u).filter(Boolean).length });
const RISK_DETECTOR: RiskSignalDetector = Object.freeze({ version: "phase-02-deterministic-risk-detector-v1", detect: () => [] });
function freeze<T>(value: T): T { return Object.freeze(value); }
async function hash(value: unknown): Promise<string> { const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(canonicalJson(value))); return Array.from(new Uint8Array(digest), (byte) => byte.toString(16).padStart(2, "0")).join(""); }

/** Transport-neutral funded creation coordinator. It owns billing and provider intent; workers remain proposal-only. */
export class MeteredGenerationService {
  #inFlight = new Map<string, Promise<SessionActionResult>>();
  #sessionTails = new Map<string, Promise<void>>();
  constructor(private readonly options: Readonly<{ fundedAdmission: FundedAdmissionService; store: MeteredFundingStore; gateway: ModelGateway; worker: WorkerPort; artifactVerifier: ArtifactVerifier; proposalStore?: SourceProposalLookup; pricing?: Readonly<{ card: PriceCard; profile: ModelProfile }>; settlement?: GenerationUsageSettlement; retainedPricing?: RetainedGenerationPricing; recoveryCommands?: GenerationCommandProtector; riskDetector?: RiskSignalDetector; harness?: Readonly<{ runner: NappletHarness; toolchain: NappletHarnessRequest["toolchain"]; snapshotReference: string; priorArtifactId: string; approvedApplicationSurfaces: readonly string[] }>; continuation?: ContinuationService; continuationCommands?: PendingCommandPort; /** Immutable worker/toolchain identity retained with any durable pause. */ toolchainIdentity?: string; clock?: Readonly<{ nowMs(): number }>; continuationWake?: ContinuationWakePort; telemetry?: LifecycleTelemetryPort }>) {}

  /** Internal continuation consumer. Decrypt and check retained compatibility
   * before the resume authority reserves funds or allocates a worker. This
   * same-currency path cannot silently substitute a new USD/FX authorization. */
  async prepareContinuation(intent: PendingActionIntent, restoredCommand?: unknown): Promise<PreparedContinuationExecution> {
    if (!this.options.continuationCommands) throw new Error("CONTINUATION_COMMAND_RESTORE_REQUIRED");
    const profile = this.options.pricing?.profile ?? PHASE_04_MODEL_PROFILES["code-proposal"];
    const priceCard = this.options.pricing?.card ?? PHASE_04_DETERMINISTIC_PRICE_CARD;
    if (this.options.settlement || priceCard.currency !== "sat") throw new Error("CONTINUATION_ORIGINAL_SETTLEMENT_REQUIRED");
    const command = restoredCommand === undefined ? await this.options.continuationCommands.open(intent) : await this.options.continuationCommands.validateRetained(restoredCommand, intent);
    const profileCeiling = maximumOperationCharge({ card: priceCard, profile });
    if (profile.id !== intent.profileId || priceCard.id !== intent.priceCardId || (this.options.toolchainIdentity ?? "phase-04-deterministic-toolchain") !== intent.toolchainId || profileCeiling !== intent.actionMaximum) throw new Error("CONTINUATION_EXECUTION_COMPATIBILITY_DENIED");
    const loadPrepared = async (binding: ContinuationExecutionBinding): Promise<MeteredAction> => {
      const prepared = await this.options.store.findMeteredAction(intent.accountId, binding.actionKey);
      if (!prepared || binding.accountId !== intent.accountId || prepared.accountId !== intent.accountId || prepared.sessionId !== intent.sessionId || prepared.admissionReference !== intent.admissionReference || prepared.expectedVersion !== intent.expectedSessionVersion || prepared.fingerprint !== binding.commandFingerprint || prepared.actionId !== binding.actionId || prepared.operationId !== binding.operationId || prepared.actionBudgetReference !== binding.actionBudgetReference || prepared.maximum !== BigInt(profileCeiling) || prepared.profileId !== profile.id || prepared.priceCardId !== priceCard.id) throw new Error("CONTINUATION_PREPARED_ACTION_BINDING_DENIED");
      return prepared;
    };
    return freeze({ readTerminal: async binding => { const action = await loadPrepared(binding); return Boolean(action.result && (action.status === "completed" || action.status === "failed")); }, execute: async binding => {
      const prepared = await loadPrepared(binding);
      return this.#executePrepared({ command, accountId: intent.accountId, fingerprint: binding.commandFingerprint, sessionId: intent.sessionId, operationId: prepared.operationId, profile, priceCard, profileCeiling, budget: { reference: prepared.actionBudgetReference }, prepared, finalizeTerminal: binding.finalizeTerminal });
    } });
  }

  /** Private accepted-action consumer. The coordinator supplies an owned,
   * already accepted price/budget binding and authenticated original command.
   * This neither creates a recovery-command record under a new identity nor
   * prepares fresh settlement, admission, capacity or money reservations. */
  async preparePricedContinuation(input: Readonly<{ intent: PendingActionIntent; restoredCommand: unknown;
    pricing: Readonly<{ profile: ModelProfile; card: PriceCard }>; maximumSat: string; binding: ContinuationExecutionBinding }>): Promise<PreparedPricedContinuationExecution> {
    if (!this.options.continuationCommands || !this.options.settlement || input.pricing.card.currency !== "usd_micros")
      throw new Error("PRICED_CONTINUATION_EXECUTION_AUTHORITY_REQUIRED");
    const intent = structuredClone(input.intent), binding = { ...input.binding };
    const command = await this.options.continuationCommands.validateRetained(input.restoredCommand, intent);
    const { profile, card } = input.pricing;
    const maximum = DecimalSchema.parse(input.maximumSat);
    if (binding.accountId !== intent.accountId || binding.actionKey === intent.idempotencyKey || profile.priceCardId !== card.id
      || profile.provider !== card.provider || BigInt(maximum) > BigInt(command.maximum)
      || (this.options.toolchainIdentity ?? "phase-04-deterministic-toolchain") !== intent.toolchainId)
      throw new Error("PRICED_CONTINUATION_EXECUTION_BINDING_DENIED");
    // Capture scalar authority now; a caller cannot mutate its argument after
    // validation and turn a prepared executable into a different paid action.
    const owned = freeze({ ...binding });
    const prices = freeze({ profile: structuredClone(profile), card: structuredClone(card) });
    const load = async () => {
      const action = await this.options.store.findMeteredAction(owned.accountId, owned.actionKey);
      if (!action || action.accountId !== intent.accountId || action.sessionId !== intent.sessionId || action.idempotencyKey !== owned.actionKey
        || action.admissionReference !== intent.admissionReference || action.expectedVersion !== intent.expectedSessionVersion
        || action.fingerprint !== owned.commandFingerprint || action.actionId !== owned.actionId || action.operationId !== owned.operationId
        || action.actionBudgetReference !== owned.actionBudgetReference || action.maximum !== BigInt(maximum)
        || action.profileId !== prices.profile.id || action.priceCardId !== prices.card.id)
        throw new Error("PRICED_CONTINUATION_PREPARED_ACTION_BINDING_DENIED");
      return action;
    };
    await load();
    return freeze({ readTerminal: async () => { const action = await load(); return action.result ? SessionActionResultSchema.parse(action.result) : undefined; },
      execute: async finalizeAction => {
        if (typeof finalizeAction !== "function") throw new Error("PRICED_CONTINUATION_FINALIZER_REQUIRED");
        const prepared = await load();
        return this.#executePrepared({ command, accountId: owned.accountId, fingerprint: owned.commandFingerprint, sessionId: prepared.sessionId,
          operationId: owned.operationId, profile: prices.profile, priceCard: prices.card, profileCeiling: maximum,
          budget: { reference: owned.actionBudgetReference }, prepared, finalizePrepared: finalizeAction });
      } });
  }

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
      if (replay) return this.#executeRecorded(command, accountId, fingerprint, replay);
      const session = await this.options.store.sessionStatus(accountId, command.sessionId);
      if (!session) return SessionActionResultSchema.parse({ status: "denied", code: "SESSION_LINEAGE_MISMATCH" });
      if (session.version !== command.expectedVersion) return SessionActionResultSchema.parse({ status: "denied", code: "STALE_SESSION_VERSION" });
      if (session.status !== "verified") {
        // A settled failed revision does not invalidate its prior verified source.
        // A new explicit action may use that exact version; active/unknown/billing
        // states remain fenced, and prepareMeteredAction still locks the lineage.
        const hasVerifiedBase = session.status === "failed" && session.version > 0 &&
          (await this.options.store.listMeteredActionsForSession(accountId, command.sessionId)).some((action) =>
            action.status === "completed" && action.artifactVersion === (session.currentVerifiedArtifactVersion ?? session.version) && !!action.artifact?.artifactId);
        if (!hasVerifiedBase) return SessionActionResultSchema.parse({ status: "denied", code: "SESSION_NOT_REVISION_READY" });
      }
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
      const replay = await this.options.store.findMeteredAction(accountId, command.idempotencyKey);
      if (replay) return this.#executeRecorded({ ...command, repair: true }, accountId, fingerprint, replay);
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

  private async execute(command: GenerationCommand, accountId: string, fingerprint: string, options: Readonly<{ bypassLegacyContinuation?: boolean }> = {}): Promise<SessionActionResult> {
    const recorded = await this.options.store.findMeteredAction(accountId, command.idempotencyKey);
    if (recorded) return this.#executeRecorded(command, accountId, fingerprint, recorded);
    const profile = this.options.pricing?.profile ?? PHASE_04_MODEL_PROFILES["code-proposal"];
    const priceCard = this.options.pricing?.card ?? PHASE_04_DETERMINISTIC_PRICE_CARD;
    // The profile's bounded worst-case charge is the authorization ceiling.
    // Do this before creating an action or dispatching the provider: a caller
    // may approve more than this ceiling, but never less.
    const operationId = `operation:${(await hash({ accountId, key: command.idempotencyKey, profile: profile.id })).slice(0, 24)}`;
    const profileCeiling = (await this.options.settlement?.prepare({ accountId, operationId, card: priceCard, profile, at: new Date().toISOString() }))?.maximum ?? maximumOperationCharge({ card: priceCard, profile });
    if (BigInt(command.maximum) < BigInt(profileCeiling)) {
      return SessionActionResultSchema.parse({ status: "denied", code: "ACTION_MAXIMUM_BELOW_PROFILE_CEILING" });
    }
    const sessionId = "sessionId" in command ? command.sessionId : `session:${(await hash({ accountId, key: command.idempotencyKey })).slice(0, 24)}`;
    const actionKind = "repair" in command ? "repair" as const : "revision" in command ? "revise_session" as const : "start_session" as const;
    const boundedPayloadHash = await hash("repair" in command ? { repair: command.originatingActionId } : "revision" in command ? { revision: command.revision } : { idea: command.idea, ...("remixReference" in command && command.remixReference ? { remixReference: command.remixReference } : {}) });
    const toolchainId = this.options.toolchainIdentity ?? "phase-04-deterministic-toolchain";
    const pauseFingerprint = await hash({ accountId, sessionId, actionKind, boundedPayloadHash, expectedSessionVersion: command.expectedVersion, expectedArtifactVersion: command.expectedVersion, policyVersion: command.policyVersion, priceCardId: priceCard.id, profileId: profile.id, toolchainId, actionMaximum: profileCeiling, idempotencyKey: command.idempotencyKey });
    if (!options.bypassLegacyContinuation) {
      const continuation = this.#continuation();
      const paused = await continuation.pauseForFunding({ command, intent: { accountId, sessionId, idempotencyKey: command.idempotencyKey, fingerprint: pauseFingerprint, reference: `pending:${(await hash({ accountId, key: command.idempotencyKey, pauseFingerprint })).slice(0, 24)}`, actionKind, boundedPayloadHash, expectedSessionVersion: command.expectedVersion, expectedArtifactVersion: command.expectedVersion, policyVersion: command.policyVersion, priceCardId: priceCard.id, profileId: profile.id, toolchainId, actionMaximum: profileCeiling, admissionReference: command.admissionReference } });
      if (paused) return SessionActionResultSchema.parse(paused);
    }
    // Database action IDs are globally primary-keyed.  Include owner/session
    // identity while retaining lookup by the existing account-scoped command
    // key, so identical keys from different principals cannot collide.
    const actionId = "repair" in command
      ? `repair:${(await hash({ accountId, sessionId, origin: command.originatingActionId, key: command.idempotencyKey })).slice(0, 24)}`
      : "revision" in command
        ? `revision:${(await hash({ accountId, sessionId, key: command.idempotencyKey })).slice(0, 24)}`
        : `start:${(await hash({ accountId, sessionId, key: command.idempotencyKey })).slice(0, 24)}`;
    const recoveryCommand = await this.options.recoveryCommands?.seal({ command, binding: { accountId, sessionId, actionId, operationId, idempotencyKey: command.idempotencyKey, fingerprint, admissionReference: command.admissionReference, expectedVersion: command.expectedVersion, maximum: profileCeiling, profileId: profile.id, priceCardId: priceCard.id, toolchainId } });
    const { budget, prepared } = await this.options.store.transact(accountId, async (transaction) => {
      const budget = await this.options.fundedAdmission.authorizeActionBudget({ principal: command.principal, admissionReference: command.admissionReference, idempotencyKey: `phase-04:${command.idempotencyKey}`, maximum: profileCeiling, unit: "sat" }, transaction);
      await transaction.bindPrincipal?.(command.principal);
      const prepared = await transaction.prepareMeteredAction({ accountId, idempotencyKey: command.idempotencyKey, fingerprint, sessionId, actionId, expectedVersion: command.expectedVersion, admissionReference: command.admissionReference, actionBudgetReference: budget.reference, maximum: BigInt(profileCeiling), operationId, profileId: profile.id, priceCardId: priceCard.id, ...(recoveryCommand ? { recoveryCommand } : {}) });
      return { budget, prepared };
    });
    return this.#executePrepared({ command, accountId, fingerprint, sessionId, operationId, profile, priceCard, profileCeiling, budget, prepared });
  }

  /** Coordinator-private recovery of an already funded original; no admission or
   * replacement budget path. Existing provider claim remains lookup-only. */
  async recoverRecordedAction(input: Readonly<{ command: GenerationCommand; operationId: string }>): Promise<SessionActionResult> {
    const command = "repair" in input.command ? TriggerValidationRepairCommandSchema.extend({ repair: z.literal(true) }).parse(input.command) : "revision" in input.command ? ReviseSessionCommandSchema.parse(input.command) : StartSessionCommandSchema.parse(input.command);
    const accountId = await accountIdForPrincipal(command.principal), fingerprint = await hash({ accountId, command });
    const prepared = await this.options.store.findMeteredAction(accountId, command.idempotencyKey);
    if (!prepared || prepared.operationId !== input.operationId) throw new Error("RECORDED_ACTION_REQUIRED");
    if (prepared.fingerprint !== fingerprint) throw new Error("RECORDED_ACTION_BINDING_DENIED");
    const key = `${accountId}\u0000${command.idempotencyKey}`;
    const active = this.#inFlight.get(key); if (active) return active;
    const run = this.#executeRecorded(command, accountId, fingerprint, prepared).finally(() => this.#inFlight.delete(key));
    this.#inFlight.set(key, run); return run;
  }

  /** Recovery precedes current affordability, profile selection and FX preparation.
   * A durable paid claim retains its own budget, operation and immutable prices. */
  async #executeRecorded(command: GenerationCommand, accountId: string, fingerprint: string, prepared: MeteredAction): Promise<SessionActionResult> {
    if (prepared.accountId !== accountId || prepared.idempotencyKey !== command.idempotencyKey || prepared.fingerprint !== fingerprint || prepared.admissionReference !== command.admissionReference || prepared.expectedVersion !== command.expectedVersion || ("sessionId" in command && prepared.sessionId !== command.sessionId) || prepared.maximum > BigInt(command.maximum)) throw new Error("RECORDED_ACTION_BINDING_DENIED");
    await this.options.store.bindPrincipal?.(command.principal);
    if (prepared.result) return SessionActionResultSchema.parse(prepared.result);
    const current = this.options.pricing ?? { profile: PHASE_04_MODEL_PROFILES["code-proposal"], card: PHASE_04_DETERMINISTIC_PRICE_CARD };
    const prices = this.options.retainedPricing ? await this.options.retainedPricing.readOriginal(prepared) : current.profile.id === prepared.profileId && current.card.id === prepared.priceCardId ? current : undefined;
    if (!prices || prices.profile.id !== prepared.profileId || prices.card.id !== prepared.priceCardId || prices.profile.priceCardId !== prices.card.id) throw new Error("RECORDED_ACTION_PRICING_REQUIRED");
    // A not-yet-dispatched action needs a separately compatible fresh execution
    // context. Retained prices authorize receipt recovery, not new paid work.
    if (prepared.status === "prepared" && (current.profile.id !== prepared.profileId || current.card.id !== prepared.priceCardId)) throw new Error("RECORDED_ACTION_FRESH_EXECUTION_REQUIRED");
    return this.#executePrepared({ command, accountId, fingerprint, sessionId: prepared.sessionId, operationId: prepared.operationId, profile: prices.profile, priceCard: prices.card, profileCeiling: prepared.maximum.toString(), budget: { reference: prepared.actionBudgetReference }, prepared });
  }

  /** The one receipt-first execution path for an already prepared paid action.
   * Preparation and ownership remain with the caller; this method never reserves
   * another budget or substitutes another provider operation. */
  async #executePrepared(input: Readonly<{ command: GenerationCommand; accountId: string; fingerprint: string; sessionId: string; operationId: string; profile: ModelProfile; priceCard: PriceCard; profileCeiling: string; budget: Readonly<{ reference: string }>; prepared: MeteredAction; finalizeTerminal?: (finalization: MeteredFinalizeInput) => Promise<void>; finalizePrepared?: PreparedActionFinalizer }>): Promise<SessionActionResult> {
    const { command, accountId, fingerprint, sessionId, operationId, profile, priceCard, profileCeiling, budget, prepared } = input;
    const lifecycleCorrelation = [accountId, sessionId, operationId] as const;
    if (prepared.result) return SessionActionResultSchema.parse(prepared.result);
    let acceptedReceipt: NormalizedUsageReceipt | undefined;
    const finalize = async (finalization: MeteredFinalizeInput): Promise<MeteredAction> => {
      if (input.finalizePrepared) {
        await input.finalizePrepared({ finalization, intent, ...(acceptedReceipt ? { receipt: acceptedReceipt } : {}) });
        const action = await this.options.store.findMeteredAction(accountId, prepared.idempotencyKey);
        if (!action?.result) throw new Error("RESUMED_ACTION_TERMINAL_REQUIRED");
        return action;
      }
      if (input.finalizeTerminal && (finalization.status === "completed" || finalization.status === "failed")) {
        await input.finalizeTerminal(finalization);
        const action = await this.options.store.findMeteredAction(accountId, prepared.idempotencyKey);
        if (!action?.result) throw new Error("RESUMED_ACTION_TERMINAL_REQUIRED");
        return action;
      }
      return this.options.store.transact(accountId, transaction => transaction.finalizeMeteredAction(finalization));
    };
    const durableActionId = prepared.actionId;
    // Construct the exact same coordinator intent before the durable claim so
    // a later process can perform lookup-only recovery of this operation.  It
    // must never invent a new prompt, profile/card, or provider request ID.
    const providerRequestId = operationId;
    const prompt = "repair" in command ? "Repair the charged focused napplet." : "revision" in command ? command.revision : command.idea;
    const currentSession = await this.options.store.sessionStatus(accountId, sessionId);
    const priorForIntent = (await this.options.store.listMeteredActionsForSession(accountId, sessionId)).filter((item) => item.artifact?.artifactId && (currentSession?.currentVerifiedArtifactVersion === undefined || item.artifactVersion === currentSession.currentVerifiedArtifactVersion)).sort((left, right) => (right.artifactVersion ?? 0) - (left.artifactVersion ?? 0))[0];
    const intent = ProviderOperationIntentSchema.parse({ operationId, providerRequestId, accountId, sessionId, actionId: durableActionId, expectedVersion: command.expectedVersion, actionBudgetReference: budget.reference, profileId: profile.id, priceCardId: priceCard.id, requestFingerprint: fingerprint, prompt, ...("remixReference" in command && command.remixReference ? { remixReference: command.remixReference } : {}), ...(priorForIntent?.artifact?.artifactId ? { authorizedPriorArtifactReference: priorForIntent.artifact.artifactId } : {}), maximumUnits: profile.maximumUnits, selection: "unselected" });
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
      const result = SessionActionResultSchema.parse({ status: "failed", code: "WORKER_OR_ARTIFACT_FAILED", accountId, sessionId, sessionVersion: command.expectedVersion, artifactVersion: command.expectedVersion, confirmedSpend: "0", remainingCap: "0", remainingBalance: "0", nextAction: "revise_session", operationId });
      const finalized = await finalize({ idempotencyKey: prepared.idempotencyKey, operationId, receiptCharge: "0", providerReceiptReference: observation.provenance.protectedEvidenceReference, status: "failed", result, sessionVersion: command.expectedVersion, artifactVersion: command.expectedVersion });
      await emitLifecycleObservation(this.options.telemetry, lifecycleCorrelation, "generation", "failed");
      await emitLifecycleObservation(this.options.telemetry, lifecycleCorrelation, "ledger_settlement", "succeeded");
      return SessionActionResultSchema.parse(finalized.result);
    }
    if (observation.receipt.operationId !== operationId || observation.receipt.providerRequestId !== providerRequestId) {
      await this.options.store.transact(accountId, (transaction) => transaction.recordUsageUnknown({ operationId, providerRequestId, protectedEvidenceReference: observation.receipt.provenance.protectedEvidenceReference, reason: "uncertain_acceptance" }));
      await emitLifecycleObservation(this.options.telemetry, lifecycleCorrelation, "generation", "pending");
      return SessionActionResultSchema.parse({ status: "usage_unknown", code: "USAGE_UNKNOWN", accountId, sessionId, nextAction: "billing_reconciliation", operationId });
    }
    acceptedReceipt = observation.receipt;
    const priced = priceReceipt({ receipt: observation.receipt, card: priceCard, profile, ...(this.options.settlement ? {} : { reservation: profileCeiling }) });
    if (priced.status !== "priced") {
      const result = SessionActionResultSchema.parse({ status: "billing_invariant_failed", code: priced.code, accountId, sessionId, nextAction: "billing_reconciliation", operationId });
      await finalize({ idempotencyKey: prepared.idempotencyKey, operationId, receiptCharge: "0", providerReceiptReference: observation.receipt.provenance.protectedEvidenceReference, status: "billing_invariant_failed", result, sessionVersion: 0, artifactVersion: 0 });
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
    const prior = priorForIntent;
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
        const baseRequest = WorkerRunRequestSchema.parse({ sessionId, actionId: durableActionId, expectedVersion: command.expectedVersion, policyVersion: command.policyVersion, capabilityGrant: "phase-04-coordinator-grant", workspaceId, ...(proposal ? { sourceProposalReference: proposal.proposal.reference, sourceProposalSha256: proposal.proposal.sha256, sourceProposalFiles: proposal.proposal.files } : { idea: riskSafeIdea(idea) }) });
        const request = this.options.worker.prepareRunRequest ? WorkerRunRequestSchema.parse(await this.options.worker.prepareRunRequest(baseRequest, idea)) : baseRequest;
        const { idea: preparedPurpose, ...preparedAuthority } = request;
        const { idea: basePurpose, ...baseAuthority } = baseRequest;
        if (canonicalJson(preparedAuthority) !== canonicalJson(baseAuthority) || (basePurpose !== undefined && preparedPurpose !== basePurpose)
          || (preparedPurpose !== undefined && preparedPurpose !== idea && preparedPurpose !== idea.trim())) throw new Error("WORKER_PREPARED_REQUEST_BINDING_DENIED");
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
    let settlement: Readonly<{ amount: string; providerReceiptReference: string }>;
    try { settlement = this.options.settlement ? await this.options.settlement.finalize({ accountId, intent, receipt: observation.receipt, pricedAmount: priced.total }) : { amount: priced.total, providerReceiptReference: observation.receipt.provenance.protectedEvidenceReference }; }
    catch (error) {
      // The receipt proves provider acceptance.  A typed failed COMMIT is the
      // sole post-receipt ambiguity: all other settlement, catalog, ledger or
      // bookkeeping errors are known local failures and must not be disguised
      // as a provider-acceptance unknown merely because their message is new.
      if (error instanceof FundingCommitOutcomeUnknownError) {
        await this.options.store.transact(accountId, transaction => transaction.recordUsageUnknown({ operationId, providerRequestId, protectedEvidenceReference: observation.receipt.provenance.protectedEvidenceReference, reason: "uncertain_acceptance" }));
        return SessionActionResultSchema.parse({ status: "usage_unknown", code: "USAGE_UNKNOWN", accountId, sessionId, nextAction: "billing_reconciliation", operationId });
      }
      const result = SessionActionResultSchema.parse({ status: "billing_invariant_failed", code: "ACCOUNTING_SETTLEMENT_FAILED", accountId, sessionId, nextAction: "billing_reconciliation", operationId });
      await finalize({ idempotencyKey: prepared.idempotencyKey, operationId, receiptCharge: "0", providerReceiptReference: observation.receipt.provenance.protectedEvidenceReference,
        status: "billing_invariant_failed", result, sessionVersion: command.expectedVersion, artifactVersion: command.expectedVersion });
      await emitLifecycleObservation(this.options.telemetry, lifecycleCorrelation, "ledger_settlement", "blocked");
      return result;
    }
    const result = SessionActionResultSchema.parse(completed
      ? { status, code: "ACTION_COMMITTED", accountId, sessionId, sessionVersion: command.expectedVersion + 1, artifactVersion: command.expectedVersion + 1, artifactId: artifactId!, confirmedSpend: settlement.amount, remainingCap: "0", remainingBalance: "0", nextAction: "revise_session", operationId, generation: { provider: observation.receipt.provider, model: observation.receipt.model, profileId: observation.receipt.profileId, priceCardId: observation.receipt.priceCardId, usage: observation.receipt.usage, source: "durably recorded" as const, worker: "verified" as const } }
      : { status, code: "WORKER_OR_ARTIFACT_FAILED", accountId, sessionId, sessionVersion: command.expectedVersion, artifactVersion: command.expectedVersion, confirmedSpend: settlement.amount, remainingCap: "0", remainingBalance: "0", nextAction: "revise_session", operationId });
    const finalized = await finalize({ idempotencyKey: prepared.idempotencyKey, operationId, receiptCharge: settlement.amount, providerReceiptReference: settlement.providerReceiptReference, status, result, sessionVersion: completed ? command.expectedVersion + 1 : command.expectedVersion, artifactVersion: completed ? command.expectedVersion + 1 : command.expectedVersion, artifact: { ...(artifactId ? { artifactId } : {}), workspaceLineage, checkpointReference, snapshotReference: `snapshot:${sessionId}:${durableActionId}`, validationEvidenceReference, ...(failedArtifactId ? { failedArtifactId } : {}), ...(validationReportReference ? { validationReportReference } : {}) } });
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
