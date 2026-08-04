import { fingerprintEvidence, fingerprintSessionAction, fingerprintSessionRequest, type AcceptedArtifact, type SessionAction, type SessionActionResult } from "../domain/session-action";

export type SessionRecord = Readonly<{ sessionId: string; principalId: string; version: number }>;

export type SessionEvidence = Readonly<{
  id: string;
  digest: string;
  sessionId: string;
  actionId: string;
  fingerprint: string;
  version: number;
  outcomeCode: "ACTION_COMMITTED";
  artifact?: AcceptedArtifact;
}>;

export type StoredActionResult = Readonly<{
  fingerprint: string;
  requestFingerprint: string;
  result: SessionActionResult;
  evidence: SessionEvidence;
}>;

export type SessionTransaction = Readonly<{
  session: SessionRecord;
}>;

export type SessionEvaluation = (transaction: SessionTransaction) => void;

/** The pre-effect fence is advisory only; apply() remains the commit-time authority. */
export type SessionPreflight = Readonly<{ authorized: true }> | Readonly<{ authorized: false; result: SessionActionResult }>;
export type WorkerLease = Readonly<{ token: string; expiresAtMs: number }>;
export type WorkerLeaseClaim = Readonly<{ authorized: true; lease: WorkerLease }> | Readonly<{ authorized: false; result: SessionActionResult }>;
export type EffectIntentClaim = Readonly<
  // Only this transaction inserted the intent, so only it may dispatch.
  | { status: "created"; operationId: string }
  | { status: "completed"; operationId: string }
  | { status: "uncertain"; operationId: string }
  | { status: "blocked" }
>;

/** One authoritative commit decision: replay, fence, result, evidence, and version. */
export interface SessionStore {
  createSession(session: SessionRecord): void;
  /** Read-only idempotency lookup used before any worker allocation/effect. */
  findRecordedResult(action: SessionAction): Promise<SessionActionResult | undefined>;
  /** Atomically checks the target session's principal and version before worker allocation/effects. */
  preflight(action: SessionAction): Promise<SessionPreflight>;
  /** Durable, expiring exclusion for one session/version before worker or gateway effects. */
  claimWorkerLease(action: SessionAction, nowMs: number, expiresAtMs: number): Promise<WorkerLeaseClaim>;
  /** Re-check at a coordinator effect boundary; a successor lease fences the stale holder. */
  assertWorkerLease(action: SessionAction, lease: WorkerLease, nowMs: number): Promise<SessionPreflight>;
  /** Persist a lease-fenced operation before an external recipient can begin it. */
  claimEffectIntent(action: SessionAction, lease: WorkerLease, callId: string, requestFingerprint: string, nowMs: number): Promise<EffectIntentClaim>;
  completeEffectIntent(operationId: string): Promise<boolean>;
  markEffectIntentUnknown(operationId: string): Promise<void>;
  releaseWorkerLease(action: SessionAction, lease: WorkerLease): Promise<void>;
  apply(action: SessionAction, evaluate: SessionEvaluation, lease?: WorkerLease, nowMs?: number): Promise<SessionActionResult>;
  getSessionVersion(sessionId: string): number | undefined;
  readonly evidence: readonly SessionEvidence[];
}

type State = {
  sessions: Map<string, SessionRecord>;
  actions: Map<string, StoredActionResult>;
  evidence: SessionEvidence[];
  leases: Map<string, Readonly<{ idempotencyKey: string; token: string; expiresAtMs: number }>>;
  effectIntents: Map<string, Readonly<{ sessionId: string; expectedVersion: number; actionId: string; callId: string; requestFingerprint: string; attemptToken: string; operationId: string; status: "claimed" | "completed" | "uncertain" }>>;
};

function leaseKey(sessionId: string, version: number): string { return `${sessionId.length}:${sessionId}:${version}`; }

function actionKey(sessionId: string, idempotencyKey: string): string {
  return `${sessionId.length}:${sessionId}${idempotencyKey.length}:${idempotencyKey}`;
}

function clone<T>(value: T): T {
  return JSON.parse(JSON.stringify(value)) as T;
}

function freeze<T>(value: T): T {
  if (value !== null && typeof value === "object" && !Object.isFrozen(value)) {
    for (const child of Object.values(value as Record<string, unknown>)) freeze(child);
    Object.freeze(value);
  }
  return value;
}

function denial(code: Extract<SessionActionResult["code"], "IDEMPOTENCY_KEY_CONFLICT" | "SESSION_NOT_FOUND" | "SESSION_SCOPE_MISMATCH" | "STALE_SESSION_VERSION" | "STORE_BUSY">, currentVersion?: number): SessionActionResult {
  return freeze(currentVersion === undefined
    ? { status: code === "STORE_BUSY" ? "recoverable_failure" : "denied", code }
    : { status: "denied", code, currentVersion });
}

async function committed(action: SessionAction, fingerprint: string, requestFingerprint: string, version: number): Promise<StoredActionResult> {
  const evidenceBase = {
    sessionId: action.sessionId,
    actionId: action.actionId,
    fingerprint,
    version,
    outcomeCode: "ACTION_COMMITTED" as const,
    ...(action.artifact ? { artifact: action.artifact } : {}),
  };
  const digest = await fingerprintEvidence(evidenceBase);
  const evidence = freeze({ id: `evidence:${digest}`, digest, ...evidenceBase });
  return freeze({
    fingerprint,
    requestFingerprint,
    result: freeze({ status: "completed" as const, code: "ACTION_COMMITTED" as const, version, evidenceId: evidence.id, evidenceDigest: digest, ...(action.artifact ? { artifactId: action.artifact.artifactId, artifactDigest: action.artifact.artifactSha256 } : {}) }),
    evidence,
  });
}

/**
 * Fast deterministic test double. It is deliberately copy-then-commit and is
 * not the durable reference composition; SqliteSessionStore is that authority.
 */
export class TransactionalMemorySessionStore implements SessionStore {
  #state: State = { sessions: new Map(), actions: new Map(), evidence: [], leases: new Map(), effectIntents: new Map() };
  #tail: Promise<void> = Promise.resolve();

  constructor(sessions: readonly SessionRecord[] = []) {
    for (const session of sessions) this.createSession(session);
  }

  createSession(session: SessionRecord): void {
    if (this.#state.sessions.has(session.sessionId)) throw new Error("session already exists");
    this.#state.sessions.set(session.sessionId, freeze(clone(session)));
  }

  get evidence(): readonly SessionEvidence[] {
    return freeze(clone(this.#state.evidence));
  }

  getSessionVersion(sessionId: string): number | undefined {
    return this.#state.sessions.get(sessionId)?.version;
  }

  async findRecordedResult(action: SessionAction): Promise<SessionActionResult | undefined> {
    const stored = this.#state.actions.get(actionKey(action.sessionId, action.idempotencyKey));
    if (!stored) return undefined;
    const requestFingerprint = await fingerprintSessionRequest(action);
    return stored.requestFingerprint === requestFingerprint ? freeze(clone(stored.result)) : denial("IDEMPOTENCY_KEY_CONFLICT");
  }

  async preflight(action: SessionAction): Promise<SessionPreflight> {
    const session = this.#state.sessions.get(action.sessionId);
    if (!session) return freeze({ authorized: false, result: denial("SESSION_NOT_FOUND") });
    if (session.principalId !== action.principal.id) return freeze({ authorized: false, result: denial("SESSION_SCOPE_MISMATCH") });
    if (session.version !== action.expectedVersion) return freeze({ authorized: false, result: denial("STALE_SESSION_VERSION", session.version) });
    return freeze({ authorized: true });
  }

  async claimWorkerLease(action: SessionAction, nowMs: number, expiresAtMs: number): Promise<WorkerLeaseClaim> {
    const preflight = await this.preflight(action);
    if (!preflight.authorized) return preflight;
    const key = leaseKey(action.sessionId, action.expectedVersion);
    const current = this.#state.leases.get(key);
    if (current && current.expiresAtMs > nowMs) {
      return freeze({ authorized: false, result: current.idempotencyKey === action.idempotencyKey ? denial("STORE_BUSY") : denial("STALE_SESSION_VERSION", action.expectedVersion) });
    }
    const lease = freeze({ token: crypto.randomUUID(), expiresAtMs });
    this.#state.leases.set(key, freeze({ idempotencyKey: action.idempotencyKey, ...lease }));
    return freeze({ authorized: true, lease });
  }

  async assertWorkerLease(action: SessionAction, lease: WorkerLease, nowMs: number): Promise<SessionPreflight> {
    const current = this.#state.leases.get(leaseKey(action.sessionId, action.expectedVersion));
    return current?.idempotencyKey === action.idempotencyKey && current.token === lease.token && current.expiresAtMs > nowMs
      ? freeze({ authorized: true })
      : freeze({ authorized: false, result: denial("STALE_SESSION_VERSION", this.#state.sessions.get(action.sessionId)?.version) });
  }

  async claimEffectIntent(action: SessionAction, lease: WorkerLease, callId: string, requestFingerprint: string, nowMs: number): Promise<EffectIntentClaim> {
    const active = await this.assertWorkerLease(action, lease, nowMs);
    if (!active.authorized) return freeze({ status: "blocked" });
    const versionKey = leaseKey(action.sessionId, action.expectedVersion);
    const key = `${versionKey}:${callId}`;
    const existing = this.#state.effectIntents.get(key);
    if (existing) {
      // A replacement lease is a new execution attempt. It cannot reuse a
      // prior recipient operation, even when that operation completed.
      if (existing.attemptToken !== lease.token) return freeze({ status: "blocked" });
      if (existing.actionId !== action.actionId || existing.requestFingerprint !== requestFingerprint) return freeze({ status: "blocked" });
      // A matching claimed row is evidence that a previous owner might already
      // have reached the recipient. A retry is never that original dispatch.
      if (existing.status === "claimed") {
        this.#state.effectIntents.set(key, freeze({ ...existing, status: "uncertain" as const }));
        return freeze({ status: "uncertain", operationId: existing.operationId });
      }
      return freeze({ status: existing.status, operationId: existing.operationId });
    }
    for (const intent of this.#state.effectIntents.values()) {
      if (intent.sessionId === action.sessionId && intent.expectedVersion === action.expectedVersion
        && (intent.actionId !== action.actionId || intent.attemptToken !== lease.token || intent.status !== "completed")) {
        if (intent.status === "claimed") this.#state.effectIntents.set(`${leaseKey(intent.sessionId, intent.expectedVersion)}:${intent.callId}`, freeze({ ...intent, status: "uncertain" as const }));
        return freeze({ status: "blocked" });
      }
    }
    const operationId = crypto.randomUUID();
    this.#state.effectIntents.set(key, freeze({ sessionId: action.sessionId, expectedVersion: action.expectedVersion, actionId: action.actionId, callId, requestFingerprint, attemptToken: lease.token, operationId, status: "claimed" as const }));
    return freeze({ status: "created", operationId });
  }

  async completeEffectIntent(operationId: string): Promise<boolean> {
    for (const [key, intent] of this.#state.effectIntents) {
      if (intent.operationId === operationId && intent.status === "claimed") {
        this.#state.effectIntents.set(key, freeze({ ...intent, status: "completed" as const }));
        return true;
      }
    }
    return false;
  }

  async markEffectIntentUnknown(operationId: string): Promise<void> {
    for (const [key, intent] of this.#state.effectIntents) {
      if (intent.operationId === operationId && intent.status === "claimed") this.#state.effectIntents.set(key, freeze({ ...intent, status: "uncertain" as const }));
    }
  }

  async releaseWorkerLease(action: SessionAction, lease: WorkerLease): Promise<void> {
    const key = leaseKey(action.sessionId, action.expectedVersion);
    const current = this.#state.leases.get(key);
    if (current?.idempotencyKey === action.idempotencyKey && current.token === lease.token) this.#state.leases.delete(key);
  }

  async apply(action: SessionAction, evaluate: SessionEvaluation, lease?: WorkerLease, nowMs: number = Date.now()): Promise<SessionActionResult> {
    let release!: () => void;
    const previous = this.#tail;
    this.#tail = new Promise<void>((resolve) => { release = resolve; });
    await previous;
    try {
      const state: State = {
        sessions: new Map([...this.#state.sessions].map(([id, session]) => [id, clone(session)])),
        actions: new Map([...this.#state.actions].map(([id, stored]) => [id, clone(stored)])),
        evidence: clone(this.#state.evidence),
        leases: new Map([...this.#state.leases].map(([id, lease]) => [id, clone(lease)])),
        effectIntents: new Map([...this.#state.effectIntents].map(([id, intent]) => [id, clone(intent)])),
      };
      const [fingerprint, requestFingerprint] = await Promise.all([fingerprintSessionAction(action), fingerprintSessionRequest(action)]);
      const existing = state.actions.get(actionKey(action.sessionId, action.idempotencyKey));
      if (existing) return existing.requestFingerprint === requestFingerprint ? freeze(clone(existing.result)) : denial("IDEMPOTENCY_KEY_CONFLICT");
      const session = state.sessions.get(action.sessionId);
      if (!session) return denial("SESSION_NOT_FOUND");
      if (session.principalId !== action.principal.id) return denial("SESSION_SCOPE_MISMATCH");
      if (session.version !== action.expectedVersion) return denial("STALE_SESSION_VERSION", session.version);
      if (lease) {
        const current = state.leases.get(leaseKey(action.sessionId, action.expectedVersion));
        if (current?.idempotencyKey !== action.idempotencyKey || current.token !== lease.token || current.expiresAtMs <= nowMs) return denial("STALE_SESSION_VERSION", session.version);
      }

      evaluate(freeze(clone({ session })));
      const stored = await committed(action, fingerprint, requestFingerprint, session.version + 1);
      state.sessions.set(session.sessionId, freeze({ ...session, version: session.version + 1 }));
      state.actions.set(actionKey(action.sessionId, action.idempotencyKey), stored);
      state.evidence.push(stored.evidence);
      this.#state = state;
      return freeze(clone(stored.result));
    } finally {
      release();
    }
  }
}
