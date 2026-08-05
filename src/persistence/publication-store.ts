import type { PublicationEffectIntent, PublicationIntent, PublicationObservation, PublicationResult, PublicationStatus, SignedOwnerManifestEvent } from "../publication/contracts.js";

export type PublicationEffectKind = "deploy" | "owner_manifest" | "attestation";
export type PublicationEffectState = "created" | "dispatching" | "unknown" | "observed_failed" | "observed_partial" | "observed_complete";
export type PublicationCommandConflict = Error & Readonly<{ code: "PUBLICATION_COMMAND_CONFLICT" }>;
export type PublicationCommandRecord = Readonly<{ fingerprint: string; result: PublicationResult }>;
export type PublicationEffectClaim = Readonly<{ effect: PublicationEffectIntent; claimed: boolean }>;
export type DurablePublicationEffect = Readonly<{ intentId: string; effectKind: PublicationEffectKind; operationId: string; requestFingerprintSha256: string; state: PublicationEffectState; claimToken?: string; observation?: PublicationObservation }>;
export type CreatePublicationIntentInput = Readonly<{ principalId: string; idempotencyKey: string; requestFingerprintSha256: string; intent: PublicationIntent }>;
export type CreatePublicationIntentResult = Readonly<{ intent: PublicationIntent; replayed: boolean }>;
export type ClaimPublicationEffectInput = Readonly<{ intentId: string; effectKind: PublicationEffectKind; operationId: string; requestFingerprintSha256: string }>;
export type ClaimPublicationEffectResult = Readonly<{ effect: DurablePublicationEffect; claimed: boolean }>;
export type RecordPublicationObservationInput = Readonly<{ operationId: string; effectKind: PublicationEffectKind; state: Exclude<PublicationEffectState, "created" | "dispatching">; observationId: string; deploymentId?: string; fullServerUploadId?: string; relayObservation?: string; attestationId?: string }>;
export type PublicationRecord = Readonly<{ intentId: string; status: "publication_reconciliation_pending" | "partial" | "complete"; effects: Readonly<Record<PublicationEffectKind, DurablePublicationEffect>> }>;

export interface PublicationStoreTransaction {
  putIntent(intent: PublicationIntent): Promise<PublicationIntent>;
  getIntent(intentId: string): Promise<PublicationIntent | undefined>;
  putSignedEvent(intentId: string, event: SignedOwnerManifestEvent): Promise<SignedOwnerManifestEvent>;
  getSignedEvent(intentId: string): Promise<SignedOwnerManifestEvent | undefined>;
  claimEffect(effect: Omit<PublicationEffectIntent, "state">): Promise<PublicationEffectClaim>;
  recordObservation(observation: PublicationObservation): Promise<PublicationObservation>;
  getObservation(operationId: string): Promise<PublicationObservation | undefined>;
  putCommandResult(intentId: string, fingerprint: string, result: PublicationResult): Promise<PublicationResult>;
}

export interface PublicationStore {
  transact<T>(operation: (transaction: PublicationStoreTransaction) => Promise<T> | T): Promise<T>;
  getIntent(intentId: string): Promise<PublicationIntent | undefined>;
  getStatus(intentId: string): Promise<PublicationStatus | PublicationResult | undefined>;
}

/** Complete Phase 6 persistence contract. Effects are only callable after their durable claim commits. */
export interface DurablePublicationStore extends PublicationStore {
  createOrReplayIntent(input: CreatePublicationIntentInput): Promise<CreatePublicationIntentResult>;
  claimPublicationEffect(input: ClaimPublicationEffectInput): Promise<ClaimPublicationEffectResult>;
  recordPublicationObservation(input: RecordPublicationObservationInput): Promise<DurablePublicationEffect>;
  completePublicationRecord(intentId: string): Promise<PublicationRecord>;
  readPublicationStatus(intentId: string): Promise<PublicationRecord>;
}

type Command = Readonly<{ principalId: string; idempotencyKey: string; requestFingerprintSha256: string; intentId: string }>;
type State = { intents: Map<string, PublicationIntent>; commandKeys: Map<string, Command>; intentCommands: Map<string, Command>; signedEvents: Map<string, SignedOwnerManifestEvent>; effects: Map<string, DurablePublicationEffect>; effectKeys: Map<string, string>; commands: Map<string, PublicationCommandRecord> };

const clone = <T>(value: T): T => structuredClone(value);
const freeze = <T>(value: T): T => {
  if (value && typeof value === "object" && !Object.isFrozen(value)) {
    for (const child of Object.values(value as Record<string, unknown>)) freeze(child);
    Object.freeze(value);
  }
  return value;
};
const immutable = <T>(value: T): T => freeze(clone(value));
const key = (...parts: readonly string[]) => parts.map((part) => `${part.length}:${part}`).join("|");
const effectKey = (intentId: string, kind: PublicationEffectKind) => key(intentId, kind);
const assertText = (value: string, code: string) => { if (!value || value.length > 1024) throw new Error(code); };
const assertFingerprint = (value: string) => { if (!/^[a-f0-9]{64}$/iu.test(value)) throw new Error("PUBLICATION_FINGERPRINT_INVALID"); };
const conflict = (): never => { const error = new Error("PUBLICATION_COMMAND_CONFLICT") as PublicationCommandConflict; Object.defineProperty(error, "code", { value: "PUBLICATION_COMMAND_CONFLICT" }); throw error; };
const toExternalState = (state: PublicationEffectState): PublicationEffectIntent["state"] => state === "observed_complete" ? "completed" : state === "observed_failed" ? "failed" : state === "unknown" || state === "observed_partial" ? "unknown" : state === "dispatching" ? "claimed" : "pending";
const toObservation = (input: RecordPublicationObservationInput): PublicationObservation => immutable({ operationId: input.operationId, observationId: input.observationId, state: input.state === "observed_complete" ? "completed" : input.state === "observed_failed" ? "failed" : "unknown", ...(input.deploymentId ? { deploymentId: input.deploymentId } : {}), ...(input.fullServerUploadId ? { fullServerUploadId: input.fullServerUploadId } : {}), ...(input.relayObservation ? { relayObservation: input.relayObservation } : {}), ...(input.attestationId ? { attestationId: input.attestationId } : {}) });
const terminal = (state: PublicationEffectState) => state === "observed_complete" || state === "observed_partial" || state === "observed_failed";

/**
 * Deterministic, serialized copy-then-commit authority. It is deliberately a
 * test double; SQLite and PostgreSQL are the restart-safe production shapes.
 */
export class TransactionalMemoryPublicationStore implements DurablePublicationStore {
  #state: State = { intents: new Map(), commandKeys: new Map(), intentCommands: new Map(), signedEvents: new Map(), effects: new Map(), effectKeys: new Map(), commands: new Map() };
  #tail: Promise<void> = Promise.resolve();

  async #write<T>(operation: (state: State) => Promise<T> | T): Promise<T> {
    let release!: () => void;
    const previous = this.#tail;
    this.#tail = new Promise<void>((resolve) => { release = resolve; });
    await previous;
    try {
      const state = clone(this.#state);
      const result = await operation(state);
      this.#state = state;
      return immutable(result);
    } finally { release(); }
  }

  async createOrReplayIntent(input: CreatePublicationIntentInput): Promise<CreatePublicationIntentResult> {
    return this.#write((state) => this.#createOrReplay(state, input));
  }
  #createOrReplay(state: State, input: CreatePublicationIntentInput): CreatePublicationIntentResult {
    assertText(input.principalId, "PUBLICATION_PRINCIPAL_INVALID"); assertText(input.idempotencyKey, "PUBLICATION_IDEMPOTENCY_KEY_INVALID"); assertFingerprint(input.requestFingerprintSha256);
    if (input.intent.accountId !== input.principalId) throw new Error("PUBLICATION_PRINCIPAL_SCOPE_MISMATCH");
    const commandKey = key(input.principalId, input.idempotencyKey);
    const existing = state.commandKeys.get(commandKey);
    if (existing) {
      if (existing.requestFingerprintSha256 !== input.requestFingerprintSha256 || existing.intentId !== input.intent.intentId) conflict();
      const intent = state.intents.get(existing.intentId); if (!intent) throw new Error("PUBLICATION_COMMAND_INTEGRITY_INVALID");
      return { intent, replayed: true };
    }
    const existingIntent = state.intents.get(input.intent.intentId);
    if (existingIntent && existingIntent.fingerprint !== input.intent.fingerprint) conflict();
    const intent = immutable(existingIntent ?? input.intent);
    const command = immutable({ principalId: input.principalId, idempotencyKey: input.idempotencyKey, requestFingerprintSha256: input.requestFingerprintSha256, intentId: intent.intentId });
    state.intents.set(intent.intentId, intent); state.commandKeys.set(commandKey, command); state.intentCommands.set(intent.intentId, command);
    return { intent, replayed: false };
  }
  async claimPublicationEffect(input: ClaimPublicationEffectInput): Promise<ClaimPublicationEffectResult> {
    return this.#write((state) => {
      assertText(input.intentId, "PUBLICATION_INTENT_INVALID"); assertText(input.operationId, "PUBLICATION_OPERATION_INVALID"); assertFingerprint(input.requestFingerprintSha256);
      if (!state.intents.has(input.intentId)) throw new Error("PUBLICATION_INTENT_NOT_FOUND");
      const existingOperation = state.effects.get(input.operationId);
      const identity = effectKey(input.intentId, input.effectKind);
      const existingForKind = state.effectKeys.get(identity);
      if (existingOperation) {
        if (existingOperation.intentId !== input.intentId || existingOperation.effectKind !== input.effectKind || existingOperation.requestFingerprintSha256 !== input.requestFingerprintSha256) conflict();
        return { effect: existingOperation, claimed: false };
      }
      if (existingForKind && existingForKind !== input.operationId) conflict();
      const effect = immutable({ ...input, state: "dispatching" as const, claimToken: `publication-claim:${input.operationId}` });
      state.effects.set(effect.operationId, effect); state.effectKeys.set(identity, effect.operationId);
      return { effect, claimed: true };
    });
  }
  async recordPublicationObservation(input: RecordPublicationObservationInput): Promise<DurablePublicationEffect> {
    return this.#write((state) => {
      assertText(input.operationId, "PUBLICATION_OPERATION_INVALID"); assertText(input.observationId, "PUBLICATION_OBSERVATION_INVALID");
      const effect = state.effects.get(input.operationId);
      if (!effect || effect.effectKind !== input.effectKind) throw new Error("PUBLICATION_EFFECT_NOT_CLAIMED");
      if (terminal(effect.state)) {
        if (effect.observation?.observationId === input.observationId && effect.state === input.state) return effect;
        throw new Error("PUBLICATION_OBSERVATION_IMMUTABLE");
      }
      const next = immutable({ ...effect, state: input.state, observation: toObservation(input) });
      state.effects.set(next.operationId, next); return next;
    });
  }
  async completePublicationRecord(intentId: string): Promise<PublicationRecord> { return this.#write((state) => this.#record(state, intentId)); }
  async readPublicationStatus(intentId: string): Promise<PublicationRecord> { await this.#tail; return immutable(this.#record(this.#state, intentId)); }
  #record(state: State, intentId: string): PublicationRecord {
    if (!state.intents.has(intentId)) throw new Error("PUBLICATION_INTENT_NOT_FOUND");
    const effects = Object.fromEntries((["deploy", "owner_manifest", "attestation"] as const).map((kind) => {
      const operationId = state.effectKeys.get(effectKey(intentId, kind));
      const effect = operationId ? state.effects.get(operationId) : undefined;
      return [kind, effect ?? { intentId, effectKind: kind, operationId: `unclaimed:${intentId}:${kind}`, requestFingerprintSha256: "0".repeat(64), state: "created" as const }];
    })) as Record<PublicationEffectKind, DurablePublicationEffect>;
    const states = Object.values(effects).map((effect) => effect.state);
    const status = states.every((state) => state === "observed_complete") ? "complete" as const : states.some((state) => state === "unknown" || state === "dispatching" || state === "created") ? "publication_reconciliation_pending" as const : "partial" as const;
    return { intentId, status, effects };
  }

  async transact<T>(operation: (transaction: PublicationStoreTransaction) => Promise<T> | T): Promise<T> {
    return this.#write(async (state) => operation(this.#transaction(state)));
  }
  #transaction(state: State): PublicationStoreTransaction {
    return {
      putIntent: async (intent) => {
        const existing = state.intents.get(intent.intentId);
        if (existing) { if (existing.fingerprint !== intent.fingerprint || existing.idempotencyKey !== intent.idempotencyKey) throw new Error("PUBLICATION_IDEMPOTENCY_CONFLICT"); return immutable(existing); }
        const sameKey = [...state.intents.values()].find((candidate) => candidate.idempotencyKey === intent.idempotencyKey);
        if (sameKey) { if (sameKey.fingerprint !== intent.fingerprint) throw new Error("PUBLICATION_IDEMPOTENCY_CONFLICT"); return immutable(sameKey); }
        state.intents.set(intent.intentId, immutable(intent)); return immutable(intent);
      },
      getIntent: async (intentId) => { const value = state.intents.get(intentId); return value && immutable(value); },
      putSignedEvent: async (intentId, event) => {
        if (!state.intents.has(intentId)) throw new Error("PUBLICATION_INTENT_NOT_FOUND"); const existing = state.signedEvents.get(intentId);
        if (existing && existing.id !== event.id) throw new Error("PUBLICATION_SIGNED_EVENT_CONFLICT"); state.signedEvents.set(intentId, immutable(existing ?? event)); return immutable(existing ?? event);
      },
      getSignedEvent: async (intentId) => { const value = state.signedEvents.get(intentId); return value && immutable(value); },
      claimEffect: async (effect) => {
        const result = await this.#claimLegacy(state, effect); return immutable(result);
      },
      recordObservation: async (observation) => immutable(await this.#observeLegacy(state, observation)),
      getObservation: async (operationId) => { const value = state.effects.get(operationId)?.observation; return value && immutable(value); },
      putCommandResult: async (intentId, fingerprint, result) => {
        const existing = state.commands.get(intentId); if (existing) { if (existing.fingerprint !== fingerprint) conflict(); return immutable(existing.result); }
        state.commands.set(intentId, immutable({ fingerprint, result })); return immutable(result);
      },
    };
  }
  async #claimLegacy(state: State, effect: Omit<PublicationEffectIntent, "state">): Promise<PublicationEffectClaim> {
    if (!state.intents.has(effect.intentId)) throw new Error("PUBLICATION_INTENT_NOT_FOUND");
    const current = state.effects.get(effect.operationId);
    if (current) {
      if (current.intentId !== effect.intentId || current.effectKind !== effect.kind || current.requestFingerprintSha256 !== effect.aggregateSha256) conflict();
      return { claimed: false, effect: immutable({ ...effect, state: toExternalState(current.state) }) };
    }
    const identity = effectKey(effect.intentId, effect.kind);
    if (state.effectKeys.has(identity)) conflict();
    const record = immutable({ intentId: effect.intentId, effectKind: effect.kind, operationId: effect.operationId, requestFingerprintSha256: effect.aggregateSha256, state: "dispatching" as const, claimToken: `publication-claim:${effect.operationId}` });
    state.effects.set(record.operationId, record); state.effectKeys.set(identity, record.operationId);
    return { claimed: true, effect: immutable({ ...effect, state: "claimed" }) };
  }
  async #observeLegacy(state: State, observation: PublicationObservation): Promise<PublicationObservation> {
    const effect = state.effects.get(observation.operationId); if (!effect) throw new Error("PUBLICATION_EFFECT_NOT_CLAIMED");
    const durableState: RecordPublicationObservationInput["state"] = observation.state === "completed" ? "observed_complete" : observation.state === "failed" ? "observed_failed" : "unknown";
    if (terminal(effect.state)) { if (effect.observation?.observationId === observation.observationId) return effect.observation; throw new Error("PUBLICATION_OBSERVATION_IMMUTABLE"); }
    const next = immutable({ ...effect, state: durableState, observation: immutable(observation) }); state.effects.set(next.operationId, next); return immutable(observation);
  }
  async getIntent(intentId: string): Promise<PublicationIntent | undefined> { await this.#tail; const value = this.#state.intents.get(intentId); return value && immutable(value); }
  async getStatus(intentId: string): Promise<PublicationStatus | PublicationResult | undefined> {
    await this.#tail; const command = this.#state.commands.get(intentId); if (command) return immutable(command.result);
    if (!this.#state.intents.has(intentId)) return undefined;
    const record = this.#record(this.#state, intentId);
    return immutable(record.status === "complete" ? { status: "complete", intentId, nextAction: "none" } : record.status === "partial" ? { status: "partial", intentId, nextAction: "reconcile_publication" } : { status: record.status, intentId, nextAction: "reconcile_publication" });
  }
}
