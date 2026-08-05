import { Database } from "bun:sqlite";
import type { PublicationEffectIntent, PublicationIntent, PublicationObservation, PublicationResult, PublicationStatus, SignedOwnerManifestEvent } from "../publication/contracts.js";
import { TransactionalMemoryPublicationStore, type ClaimPublicationEffectInput, type ClaimPublicationEffectResult, type CreatePublicationIntentInput, type CreatePublicationIntentResult, type DurablePublicationEffect, type DurablePublicationStore, type PublicationEffectKind, type PublicationRecord, type PublicationStoreTransaction, type RecordPublicationObservationInput } from "./publication-store.js";

const copy = <T>(value: T): T => structuredClone(value);
const frozen = <T>(value: T): T => { if (value && typeof value === "object" && !Object.isFrozen(value)) { for (const child of Object.values(value as Record<string, unknown>)) frozen(child); Object.freeze(value); } return value; };
const immutable = <T>(value: T): T => frozen(copy(value));
const effectKinds = ["deploy", "owner_manifest", "attestation"] as const;
const key = (...parts: readonly string[]) => parts.map((part) => `${part.length}:${part}`).join("|");
const effectKey = (intentId: string, kind: PublicationEffectKind) => key(intentId, kind);
const terminal = (state: DurablePublicationEffect["state"]) => state === "observed_complete" || state === "observed_partial" || state === "observed_failed";

/** File-backed durable publication authority. Every mutation uses BEGIN IMMEDIATE. */
export class SqlitePublicationStore implements DurablePublicationStore {
  #database: Database;
  #tail: Promise<void> = Promise.resolve();
  constructor(path: string) {
    this.#database = new Database(path, { create: true, strict: true });
    this.#database.exec("PRAGMA foreign_keys = ON; PRAGMA busy_timeout = 100; PRAGMA journal_mode = WAL;");
    this.#database.exec(`
      CREATE TABLE IF NOT EXISTS publication_commands (principal_id TEXT NOT NULL, idempotency_key TEXT NOT NULL, request_fingerprint_sha256 TEXT NOT NULL CHECK(length(request_fingerprint_sha256)=64), intent_id TEXT NOT NULL UNIQUE, result_json TEXT, PRIMARY KEY(principal_id,idempotency_key)) STRICT;
      CREATE TABLE IF NOT EXISTS publication_intents (intent_id TEXT PRIMARY KEY, fingerprint TEXT NOT NULL, record_json TEXT NOT NULL) STRICT;
      CREATE TABLE IF NOT EXISTS publication_signed_events (intent_id TEXT PRIMARY KEY REFERENCES publication_intents(intent_id), event_json TEXT NOT NULL) STRICT;
      CREATE TABLE IF NOT EXISTS publication_effect_intents (operation_id TEXT PRIMARY KEY, intent_id TEXT NOT NULL REFERENCES publication_intents(intent_id), effect_kind TEXT NOT NULL CHECK(effect_kind IN ('deploy','owner_manifest','attestation')), request_fingerprint_sha256 TEXT NOT NULL CHECK(length(request_fingerprint_sha256)=64), state TEXT NOT NULL CHECK(state IN ('created','dispatching','unknown','observed_failed','observed_partial','observed_complete')), claim_token TEXT, observation_json TEXT, UNIQUE(intent_id,effect_kind)) STRICT;
    `);
  }
  async #serialized<T>(write: boolean, operation: () => T): Promise<T> {
    let release!: () => void; const prior = this.#tail; this.#tail = new Promise<void>((resolve) => { release = resolve; }); await prior;
    try {
      if (!write) return immutable(operation());
      const transaction = this.#database.transaction(operation);
      return immutable(transaction.immediate());
    } finally { release(); }
  }
  /** Serializes asynchronous legacy callbacks without attempting to clone a Promise. */
  async #exclusive<T>(operation: () => Promise<T> | T): Promise<T> {
    let release!: () => void; const prior = this.#tail; this.#tail = new Promise<void>((resolve) => { release = resolve; }); await prior;
    try { return immutable(await operation()); } finally { release(); }
  }
  #intent(intentId: string): PublicationIntent | undefined { const row = this.#database.query("SELECT record_json FROM publication_intents WHERE intent_id=?").get(intentId) as { record_json: string } | null; return row && JSON.parse(row.record_json) as PublicationIntent; }
  #effect(operationId: string): DurablePublicationEffect | undefined { const row = this.#database.query("SELECT intent_id,effect_kind,operation_id,request_fingerprint_sha256,state,claim_token,observation_json FROM publication_effect_intents WHERE operation_id=?").get(operationId) as Record<string, unknown> | null; return row && { intentId: String(row.intent_id), effectKind: String(row.effect_kind) as PublicationEffectKind, operationId: String(row.operation_id), requestFingerprintSha256: String(row.request_fingerprint_sha256), state: String(row.state) as DurablePublicationEffect["state"], ...(row.claim_token ? { claimToken: String(row.claim_token) } : {}), ...(row.observation_json ? { observation: JSON.parse(String(row.observation_json)) as PublicationObservation } : {}) }; }
  async createOrReplayIntent(input: CreatePublicationIntentInput): Promise<CreatePublicationIntentResult> {
    return this.#serialized(true, () => {
      if (!input.principalId || !input.idempotencyKey || !/^[a-f0-9]{64}$/iu.test(input.requestFingerprintSha256) || input.intent.accountId !== input.principalId) throw new Error("PUBLICATION_COMMAND_INVALID");
      const prior = this.#database.query("SELECT request_fingerprint_sha256,intent_id FROM publication_commands WHERE principal_id=? AND idempotency_key=?").get(input.principalId, input.idempotencyKey) as { request_fingerprint_sha256: string; intent_id: string } | null;
      if (prior) { if (prior.request_fingerprint_sha256 !== input.requestFingerprintSha256) throw new Error("PUBLICATION_COMMAND_CONFLICT"); const intent = this.#intent(prior.intent_id); if (!intent) throw new Error("PUBLICATION_COMMAND_INTEGRITY_INVALID"); return { intent, replayed: true }; }
      const existing = this.#intent(input.intent.intentId); if (existing && existing.fingerprint !== input.intent.fingerprint) throw new Error("PUBLICATION_COMMAND_CONFLICT");
      this.#database.query("INSERT OR IGNORE INTO publication_intents(intent_id,fingerprint,record_json) VALUES (?,?,?)").run(input.intent.intentId, input.intent.fingerprint, JSON.stringify(input.intent));
      this.#database.query("INSERT INTO publication_commands(principal_id,idempotency_key,request_fingerprint_sha256,intent_id) VALUES (?,?,?,?)").run(input.principalId, input.idempotencyKey, input.requestFingerprintSha256, input.intent.intentId);
      return { intent: existing ?? input.intent, replayed: false };
    });
  }
  async claimPublicationEffect(input: ClaimPublicationEffectInput): Promise<ClaimPublicationEffectResult> {
    return this.#serialized(true, () => this.#claimPublicationEffect(input));
  }
  #claimPublicationEffect(input: ClaimPublicationEffectInput): ClaimPublicationEffectResult {
    if (!this.#intent(input.intentId)) throw new Error("PUBLICATION_INTENT_NOT_FOUND"); if (!/^[a-f0-9]{64}$/iu.test(input.requestFingerprintSha256)) throw new Error("PUBLICATION_FINGERPRINT_INVALID");
    const byOperation = this.#effect(input.operationId); if (byOperation) { if (byOperation.intentId !== input.intentId || byOperation.effectKind !== input.effectKind || byOperation.requestFingerprintSha256 !== input.requestFingerprintSha256) throw new Error("PUBLICATION_COMMAND_CONFLICT"); return { effect: byOperation, claimed: false }; }
    const existing = this.#database.query("SELECT operation_id FROM publication_effect_intents WHERE intent_id=? AND effect_kind=?").get(input.intentId, input.effectKind) as { operation_id: string } | null; if (existing) throw new Error("PUBLICATION_COMMAND_CONFLICT");
    const effect: DurablePublicationEffect = { ...input, state: "dispatching", claimToken: `publication-claim:${input.operationId}` };
    this.#database.query("INSERT INTO publication_effect_intents(operation_id,intent_id,effect_kind,request_fingerprint_sha256,state,claim_token) VALUES (?,?,?,?,?,?)").run(effect.operationId, effect.intentId, effect.effectKind, effect.requestFingerprintSha256, effect.state, effect.claimToken);
    return { effect, claimed: true };
  }
  async recordPublicationObservation(input: RecordPublicationObservationInput): Promise<DurablePublicationEffect> {
    return this.#serialized(true, () => this.#recordPublicationObservation(input));
  }
  #recordPublicationObservation(input: RecordPublicationObservationInput): DurablePublicationEffect {
    const effect = this.#effect(input.operationId); if (!effect || effect.effectKind !== input.effectKind) throw new Error("PUBLICATION_EFFECT_NOT_CLAIMED");
    if (terminal(effect.state)) { if (effect.observation?.observationId === input.observationId && effect.state === input.state) return effect; throw new Error("PUBLICATION_OBSERVATION_IMMUTABLE"); }
    const observation: PublicationObservation = { operationId: input.operationId, observationId: input.observationId, state: input.state === "observed_complete" ? "completed" : input.state === "observed_partial" ? "partial" : input.state === "observed_failed" ? "failed" : "unknown", ...(input.deploymentId ? { deploymentId: input.deploymentId } : {}), ...(input.fullServerUploadId ? { fullServerUploadId: input.fullServerUploadId } : {}), ...(input.relayObservation ? { relayObservation: input.relayObservation } : {}), ...(input.attestationId ? { attestationId: input.attestationId } : {}) };
    this.#database.query("UPDATE publication_effect_intents SET state=?,observation_json=? WHERE operation_id=? AND state NOT IN ('observed_failed','observed_partial','observed_complete')").run(input.state, JSON.stringify(observation), input.operationId);
    return { ...effect, state: input.state, observation };
  }
  #record(intentId: string): PublicationRecord {
    if (!this.#intent(intentId)) throw new Error("PUBLICATION_INTENT_NOT_FOUND");
    const effects = Object.fromEntries(effectKinds.map((kind) => { const row = this.#database.query("SELECT operation_id FROM publication_effect_intents WHERE intent_id=? AND effect_kind=?").get(intentId, kind) as { operation_id: string } | null; return [kind, row ? this.#effect(row.operation_id)! : { intentId, effectKind: kind, operationId: `unclaimed:${intentId}:${kind}`, requestFingerprintSha256: "0".repeat(64), state: "created" as const }]; })) as Record<PublicationEffectKind, DurablePublicationEffect>;
    const states = Object.values(effects).map((effect) => effect.state); const status = states.every((state) => state === "observed_complete") ? "complete" as const : states.some((state) => state === "created" || state === "dispatching" || state === "unknown") ? "publication_reconciliation_pending" as const : "partial" as const;
    return { intentId, status, effects };
  }
  async completePublicationRecord(intentId: string): Promise<PublicationRecord> { return this.#serialized(true, () => this.#record(intentId)); }
  async readPublicationStatus(intentId: string): Promise<PublicationRecord> { return this.#serialized(false, () => this.#record(intentId)); }
  async transact<T>(operation: (transaction: PublicationStoreTransaction) => Promise<T> | T): Promise<T> {
    // Phase 6's existing service transaction callbacks are async. The SQLite
    // API cannot hold a synchronous transaction across an await; legacy calls
    // are serialized and use the same durable compare-and-set primitives.
    return this.#exclusive(() => operation(this.#legacyTransaction()));
  }
  #legacyTransaction(): PublicationStoreTransaction {
    return {
      putIntent: async (intent) => { const existing = this.#intent(intent.intentId); if (existing) { if (existing.fingerprint !== intent.fingerprint) throw new Error("PUBLICATION_COMMAND_CONFLICT"); return immutable(existing); } const transaction = this.#database.transaction(() => { this.#database.query("INSERT INTO publication_intents(intent_id,fingerprint,record_json) VALUES (?,?,?)").run(intent.intentId, intent.fingerprint, JSON.stringify(intent)); return intent; }); return immutable(transaction.immediate()); },
      getIntent: async (intentId) => { const value = this.#intent(intentId); return value && immutable(value); },
      putSignedEvent: async (intentId, event) => { const transaction = this.#database.transaction(() => { if (!this.#intent(intentId)) throw new Error("PUBLICATION_INTENT_NOT_FOUND"); const existing = this.#database.query("SELECT event_json FROM publication_signed_events WHERE intent_id=?").get(intentId) as { event_json: string } | null; if (existing && (JSON.parse(existing.event_json) as SignedOwnerManifestEvent).id !== event.id) throw new Error("PUBLICATION_SIGNED_EVENT_CONFLICT"); this.#database.query("INSERT OR IGNORE INTO publication_signed_events(intent_id,event_json) VALUES (?,?)").run(intentId, JSON.stringify(event)); return existing ? JSON.parse(existing.event_json) as SignedOwnerManifestEvent : event; }); return immutable(transaction.immediate()); },
      getSignedEvent: async (intentId) => { const row = this.#database.query("SELECT event_json FROM publication_signed_events WHERE intent_id=?").get(intentId) as { event_json: string } | null; return row && immutable(JSON.parse(row.event_json) as SignedOwnerManifestEvent); },
      claimEffect: async (effect) => { const result = this.#database.transaction(() => this.#claimPublicationEffect({ intentId: effect.intentId, effectKind: effect.kind, operationId: effect.operationId, requestFingerprintSha256: effect.aggregateSha256 })).immediate(); return immutable({ claimed: result.claimed, effect: { ...effect, state: result.effect.state === "observed_complete" ? "completed" : result.effect.state === "observed_failed" ? "failed" : result.effect.state === "unknown" ? "unknown" : result.effect.state === "dispatching" ? "claimed" : "pending" } }); },
      recordObservation: async (observation) => { const effect = this.#effect(observation.operationId); if (!effect) throw new Error("PUBLICATION_EFFECT_NOT_CLAIMED"); this.#database.transaction(() => this.#recordPublicationObservation({ operationId: observation.operationId, effectKind: effect.effectKind, state: observation.state === "completed" ? "observed_complete" : observation.state === "partial" ? "observed_partial" : observation.state === "failed" ? "observed_failed" : "unknown", observationId: observation.observationId, ...(observation.deploymentId ? { deploymentId: observation.deploymentId } : {}), ...(observation.fullServerUploadId ? { fullServerUploadId: observation.fullServerUploadId } : {}), ...(observation.relayObservation ? { relayObservation: observation.relayObservation } : {}), ...(observation.attestationId ? { attestationId: observation.attestationId } : {}) })).immediate(); return immutable(observation); },
      getObservation: async (operationId) => this.#effect(operationId)?.observation,
      putCommandResult: async (intentId, fingerprint, result) => { const transaction = this.#database.transaction(() => { const row = this.#database.query("SELECT result_json FROM publication_commands WHERE intent_id=?").get(intentId) as { result_json: string | null } | null; if (row?.result_json) return JSON.parse(row.result_json) as PublicationResult; this.#database.query("UPDATE publication_commands SET result_json=? WHERE intent_id=?").run(JSON.stringify(result), intentId); return result; }); return immutable(transaction.immediate()); },
    };
  }
  async getIntent(intentId: string): Promise<PublicationIntent | undefined> { return this.#serialized(false, () => this.#intent(intentId)); }
  async getStatus(intentId: string): Promise<PublicationStatus | PublicationResult | undefined> { return this.#serialized(false, () => { const row = this.#database.query("SELECT result_json FROM publication_commands WHERE intent_id=?").get(intentId) as { result_json: string | null } | null; if (row?.result_json) return JSON.parse(row.result_json) as PublicationResult; if (!this.#intent(intentId)) return undefined; const record = this.#record(intentId); return record.status === "complete" ? { status: "complete", intentId, nextAction: "none" } : record.status === "partial" ? { status: "partial", intentId, nextAction: "reconcile_publication" } : { status: "publication_reconciliation_pending", intentId, nextAction: "reconcile_publication" }; }); }
  close(): void { this.#database.close(); }
}
