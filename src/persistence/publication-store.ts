import type { PublicationEffectIntent, PublicationIntent, PublicationObservation, PublicationResult, PublicationStatus, SignedOwnerManifestEvent } from "../publication/contracts.js";

export type PublicationCommandRecord = Readonly<{ fingerprint: string; result: PublicationResult }>;
export type PublicationEffectClaim = Readonly<{ effect: PublicationEffectIntent; claimed: boolean }>;

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

type State = { intents: Map<string, PublicationIntent>; signedEvents: Map<string, SignedOwnerManifestEvent>; effects: Map<string, PublicationEffectIntent>; observations: Map<string, PublicationObservation>; commands: Map<string, PublicationCommandRecord> };
const freeze = <T>(value: T): T => Object.freeze(structuredClone(value));

/** Deterministic, serialized persistence authority for the Phase 6 tracer. */
export class TransactionalMemoryPublicationStore implements PublicationStore {
  #state: State = { intents: new Map(), signedEvents: new Map(), effects: new Map(), observations: new Map(), commands: new Map() };
  #tail: Promise<void> = Promise.resolve();

  async transact<T>(operation: (transaction: PublicationStoreTransaction) => Promise<T> | T): Promise<T> {
    const run = this.#tail.then(async () => {
      const state = structuredClone(this.#state) as State;
      const transaction: PublicationStoreTransaction = {
        putIntent: async (intent) => {
          const existing = state.intents.get(intent.intentId);
          if (existing) {
            if (existing.fingerprint !== intent.fingerprint || existing.idempotencyKey !== intent.idempotencyKey) throw new Error("PUBLICATION_IDEMPOTENCY_CONFLICT");
            return existing;
          }
          const record = freeze(intent); state.intents.set(record.intentId, record); return record;
        },
        getIntent: async (intentId) => state.intents.get(intentId),
        putSignedEvent: async (intentId, event) => {
          if (!state.intents.has(intentId)) throw new Error("PUBLICATION_INTENT_NOT_FOUND");
          const existing = state.signedEvents.get(intentId);
          if (existing && existing.id !== event.id) throw new Error("PUBLICATION_SIGNED_EVENT_CONFLICT");
          const record = existing ?? freeze(event); state.signedEvents.set(intentId, record); return record;
        },
        getSignedEvent: async (intentId) => state.signedEvents.get(intentId),
        claimEffect: async (input) => {
          const existing = state.effects.get(input.operationId);
          if (existing) return freeze({ effect: existing, claimed: false });
          const effect = freeze({ ...input, state: "claimed" as const }); state.effects.set(effect.operationId, effect);
          return freeze({ effect, claimed: true });
        },
        recordObservation: async (observation) => {
          const effect = state.effects.get(observation.operationId);
          if (!effect) throw new Error("PUBLICATION_EFFECT_NOT_CLAIMED");
          const record = freeze(observation); state.observations.set(record.operationId, record);
          state.effects.set(effect.operationId, freeze({ ...effect, state: record.state }));
          return record;
        },
        getObservation: async (operationId) => state.observations.get(operationId),
        putCommandResult: async (intentId, fingerprint, result) => {
          const existing = state.commands.get(intentId);
          if (existing) {
            if (existing.fingerprint !== fingerprint) throw new Error("PUBLICATION_IDEMPOTENCY_CONFLICT");
            return existing.result;
          }
          const record = freeze({ fingerprint, result }); state.commands.set(intentId, record); return record.result;
        },
      };
      const result = await operation(transaction);
      this.#state = state;
      return result;
    });
    this.#tail = run.then(() => undefined, () => undefined);
    return run;
  }

  async getIntent(intentId: string): Promise<PublicationIntent | undefined> { await this.#tail; return this.#state.intents.get(intentId); }
  async getStatus(intentId: string): Promise<PublicationStatus | PublicationResult | undefined> {
    await this.#tail;
    const command = this.#state.commands.get(intentId); if (command) return command.result;
    const intent = this.#state.intents.get(intentId); return intent ? freeze({ status: "intent_ready" as const, intentId, nextAction: "sign_manifest" as const }) : undefined;
  }
}
