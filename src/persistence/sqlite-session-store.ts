import { Database } from "bun:sqlite";
import { fingerprintSessionAction, fingerprintSessionRequest, type SessionAction, type SessionActionResult } from "../domain/session-action";
import { canonicalJson } from "../promotion/schema";
import type { SessionEvaluation, SessionEvidence, SessionPreflight, SessionRecord, SessionStore, WorkerLease, WorkerLeaseClaim } from "./session-store";

type ActionRow = { fingerprint: string; request_fingerprint: string; result_json: string; evidence_json: string };
type SessionRow = { session_id: string; principal_id: string; version: number };
type EvidenceRow = { record_json: string };

function copy<T>(value: T): T { return JSON.parse(JSON.stringify(value)) as T; }
function freeze<T>(value: T): T {
  if (value !== null && typeof value === "object" && !Object.isFrozen(value)) {
    for (const child of Object.values(value as Record<string, unknown>)) freeze(child);
    Object.freeze(value);
  }
  return value;
}
function denial(code: Extract<SessionActionResult["code"], "IDEMPOTENCY_KEY_CONFLICT" | "SESSION_NOT_FOUND" | "SESSION_SCOPE_MISMATCH" | "STALE_SESSION_VERSION" | "STORE_BUSY">, currentVersion?: number): SessionActionResult {
  return freeze(currentVersion === undefined ? { status: code === "STORE_BUSY" ? "recoverable_failure" : "denied", code } : { status: "denied", code, currentVersion });
}

/** File-backed Phase 2 reference: exactly sessions, action results, and evidence. */
export class SqliteSessionStore implements SessionStore {
  #database: Database;
  #tail: Promise<void> = Promise.resolve();

  constructor(path: string) {
    this.#database = new Database(path, { create: true, strict: true });
    this.#database.exec("PRAGMA foreign_keys = ON; PRAGMA busy_timeout = 50; PRAGMA journal_mode = WAL;");
    this.#database.exec(`
      CREATE TABLE IF NOT EXISTS sessions (
        session_id TEXT PRIMARY KEY,
        principal_id TEXT NOT NULL,
        version INTEGER NOT NULL CHECK (version >= 0)
      ) STRICT;
      CREATE TABLE IF NOT EXISTS evidence (
        evidence_id TEXT PRIMARY KEY,
        evidence_digest TEXT NOT NULL UNIQUE,
        session_id TEXT NOT NULL REFERENCES sessions(session_id),
        action_fingerprint TEXT NOT NULL,
        version INTEGER NOT NULL CHECK (version >= 0),
        outcome_code TEXT NOT NULL,
        record_json TEXT NOT NULL
      ) STRICT;
      CREATE TABLE IF NOT EXISTS action_results (
        session_id TEXT NOT NULL REFERENCES sessions(session_id),
        idempotency_key TEXT NOT NULL,
        fingerprint TEXT NOT NULL,
        request_fingerprint TEXT,
        result_json TEXT NOT NULL,
        evidence_id TEXT NOT NULL REFERENCES evidence(evidence_id),
        PRIMARY KEY (session_id, idempotency_key)
      ) STRICT;
      CREATE TABLE IF NOT EXISTS worker_leases (
        session_id TEXT NOT NULL REFERENCES sessions(session_id),
        expected_version INTEGER NOT NULL CHECK (expected_version >= 0),
        idempotency_key TEXT NOT NULL,
        lease_token TEXT NOT NULL,
        expires_at_ms INTEGER NOT NULL,
        PRIMARY KEY (session_id, expected_version)
      ) STRICT;
    `);
    const actionColumns = this.#database.query("PRAGMA table_info(action_results)").all() as readonly { name: string }[];
    if (!actionColumns.some((column) => column.name === "request_fingerprint")) {
      this.#database.exec("ALTER TABLE action_results ADD COLUMN request_fingerprint TEXT;");
    }
    this.#database.exec("UPDATE action_results SET request_fingerprint = fingerprint WHERE request_fingerprint IS NULL;");
    const leaseColumns = this.#database.query("PRAGMA table_info(worker_leases)").all() as readonly { name: string }[];
    if (!leaseColumns.some((column) => column.name === "lease_token")) {
      this.#database.exec("ALTER TABLE worker_leases ADD COLUMN lease_token TEXT;");
    }
  }

  createSession(session: SessionRecord): void {
    this.#database.query("INSERT INTO sessions (session_id, principal_id, version) VALUES (?, ?, ?)").run(session.sessionId, session.principalId, session.version);
  }

  getSessionVersion(sessionId: string): number | undefined {
    const row = this.#database.query("SELECT version FROM sessions WHERE session_id = ?").get(sessionId) as { version: number } | null;
    return row?.version;
  }

  async findRecordedResult(action: SessionAction): Promise<SessionActionResult | undefined> {
    const existing = this.#database.query("SELECT fingerprint, request_fingerprint, result_json, evidence_id FROM action_results WHERE session_id = ? AND idempotency_key = ?").get(action.sessionId, action.idempotencyKey) as ActionRow | null;
    if (!existing) return undefined;
    const requestFingerprint = await fingerprintSessionRequest(action);
    return existing.request_fingerprint === requestFingerprint ? freeze(copy(JSON.parse(existing.result_json) as SessionActionResult)) : denial("IDEMPOTENCY_KEY_CONFLICT");
  }

  async preflight(action: SessionAction): Promise<SessionPreflight> {
    // One SQLite statement supplies a single committed snapshot for the
    // pre-effect fence. apply() repeats the fence transactionally at commit.
    const row = this.#database.query("SELECT principal_id, version FROM sessions WHERE session_id = ?").get(action.sessionId) as Pick<SessionRow, "principal_id" | "version"> | null;
    if (!row) return freeze({ authorized: false, result: denial("SESSION_NOT_FOUND") });
    if (row.principal_id !== action.principal.id) return freeze({ authorized: false, result: denial("SESSION_SCOPE_MISMATCH") });
    if (row.version !== action.expectedVersion) return freeze({ authorized: false, result: denial("STALE_SESSION_VERSION", row.version) });
    return freeze({ authorized: true });
  }

  async claimWorkerLease(action: SessionAction, nowMs: number, expiresAtMs: number): Promise<WorkerLeaseClaim> {
    const lease = freeze({ token: crypto.randomUUID(), expiresAtMs });
    try {
      return this.#database.transaction(() => {
        this.#database.query("DELETE FROM worker_leases WHERE expires_at_ms <= ?").run(nowMs);
        const row = this.#database.query("SELECT principal_id, version FROM sessions WHERE session_id = ?").get(action.sessionId) as Pick<SessionRow, "principal_id" | "version"> | null;
        if (!row) return freeze({ authorized: false, result: denial("SESSION_NOT_FOUND") });
        if (row.principal_id !== action.principal.id) return freeze({ authorized: false, result: denial("SESSION_SCOPE_MISMATCH") });
        if (row.version !== action.expectedVersion) return freeze({ authorized: false, result: denial("STALE_SESSION_VERSION", row.version) });
        const inserted = this.#database.query("INSERT OR IGNORE INTO worker_leases (session_id, expected_version, idempotency_key, lease_token, expires_at_ms) VALUES (?, ?, ?, ?, ?)").run(action.sessionId, action.expectedVersion, action.idempotencyKey, lease.token, expiresAtMs);
        if (inserted.changes === 1) return freeze({ authorized: true, lease });
        const currentLease = this.#database.query("SELECT idempotency_key FROM worker_leases WHERE session_id = ? AND expected_version = ?").get(action.sessionId, action.expectedVersion) as { idempotency_key: string } | null;
        return freeze({ authorized: false, result: currentLease?.idempotency_key === action.idempotencyKey ? denial("STORE_BUSY") : denial("STALE_SESSION_VERSION", row.version) });
      })();
    } catch (error) {
      if (error instanceof Error && /(?:SQLITE_BUSY|database is locked)/iu.test(error.message)) return freeze({ authorized: false, result: denial("STORE_BUSY") });
      throw error;
    }
  }

  async assertWorkerLease(action: SessionAction, lease: WorkerLease, nowMs: number): Promise<SessionPreflight> {
    const row = this.#database.query("SELECT idempotency_key, lease_token, expires_at_ms FROM worker_leases WHERE session_id = ? AND expected_version = ?").get(action.sessionId, action.expectedVersion) as { idempotency_key: string; lease_token: string | null; expires_at_ms: number } | null;
    return row?.idempotency_key === action.idempotencyKey && row.lease_token === lease.token && row.expires_at_ms > nowMs
      ? freeze({ authorized: true })
      : freeze({ authorized: false, result: denial("STALE_SESSION_VERSION", this.getSessionVersion(action.sessionId)) });
  }

  async releaseWorkerLease(action: SessionAction, lease: WorkerLease): Promise<void> {
    this.#database.query("DELETE FROM worker_leases WHERE session_id = ? AND expected_version = ? AND idempotency_key = ? AND lease_token = ?").run(action.sessionId, action.expectedVersion, action.idempotencyKey, lease.token);
  }

  get evidence(): readonly SessionEvidence[] {
    const rows = this.#database.query("SELECT record_json FROM evidence ORDER BY rowid").all() as EvidenceRow[];
    return freeze(rows.map((row) => JSON.parse(row.record_json) as SessionEvidence));
  }

  close(): void { this.#database.close(); }

  async apply(action: SessionAction, evaluate: SessionEvaluation, lease?: WorkerLease, nowMs: number = Date.now()): Promise<SessionActionResult> {
    let release!: () => void;
    const previous = this.#tail;
    this.#tail = new Promise<void>((resolve) => { release = resolve; });
    await previous;
    try {
      const [fingerprint, requestFingerprint] = await Promise.all([fingerprintSessionAction(action), fingerprintSessionRequest(action)]);
      return this.#database.transaction(() => this.#applyInTransaction(action, fingerprint, requestFingerprint, evaluate, lease, nowMs))();
    } catch (error) {
      if (error instanceof Error && /(?:SQLITE_BUSY|database is locked)/iu.test(error.message)) return denial("STORE_BUSY");
      throw error;
    } finally {
      release();
    }
  }

  #applyInTransaction(action: SessionAction, fingerprint: string, requestFingerprint: string, evaluate: SessionEvaluation, lease?: WorkerLease, nowMs: number = Date.now()): SessionActionResult {
    const existing = this.#database.query("SELECT fingerprint, request_fingerprint, result_json, evidence_id FROM action_results WHERE session_id = ? AND idempotency_key = ?").get(action.sessionId, action.idempotencyKey) as ActionRow | null;
    if (existing) return existing.request_fingerprint === requestFingerprint ? freeze(copy(JSON.parse(existing.result_json) as SessionActionResult)) : denial("IDEMPOTENCY_KEY_CONFLICT");
    const row = this.#database.query("SELECT session_id, principal_id, version FROM sessions WHERE session_id = ?").get(action.sessionId) as SessionRow | null;
    if (!row) return denial("SESSION_NOT_FOUND");
    if (row.principal_id !== action.principal.id) return denial("SESSION_SCOPE_MISMATCH");
    if (row.version !== action.expectedVersion) return denial("STALE_SESSION_VERSION", row.version);
    if (lease) {
      const current = this.#database.query("SELECT idempotency_key, lease_token, expires_at_ms FROM worker_leases WHERE session_id = ? AND expected_version = ?").get(action.sessionId, action.expectedVersion) as { idempotency_key: string; lease_token: string | null; expires_at_ms: number } | null;
      if (current?.idempotency_key !== action.idempotencyKey || current.lease_token !== lease.token || current.expires_at_ms <= nowMs) return denial("STALE_SESSION_VERSION", row.version);
    }

    const session = freeze({ sessionId: row.session_id, principalId: row.principal_id, version: row.version });
    evaluate(freeze(copy({ session })));
    const version = row.version + 1;
    const evidenceBase = { sessionId: action.sessionId, actionId: action.actionId, fingerprint, version, outcomeCode: "ACTION_COMMITTED" as const, ...(action.artifact ? { artifact: action.artifact } : {}) };
    const digest = this.#fingerprintEvidenceSync(evidenceBase);
    const evidence = freeze({ id: `evidence:${digest}`, digest, ...evidenceBase });
    const result = freeze({ status: "completed" as const, code: "ACTION_COMMITTED" as const, version, evidenceId: evidence.id, evidenceDigest: digest, ...(action.artifact ? { artifactId: action.artifact.artifactId, artifactDigest: action.artifact.artifactSha256 } : {}) });

    this.#database.query("INSERT INTO evidence (evidence_id, evidence_digest, session_id, action_fingerprint, version, outcome_code, record_json) VALUES (?, ?, ?, ?, ?, ?, ?)").run(evidence.id, evidence.digest, evidence.sessionId, fingerprint, version, evidence.outcomeCode, JSON.stringify(evidence));
    this.#database.query("INSERT INTO action_results (session_id, idempotency_key, fingerprint, request_fingerprint, result_json, evidence_id) VALUES (?, ?, ?, ?, ?, ?)").run(action.sessionId, action.idempotencyKey, fingerprint, requestFingerprint, JSON.stringify(result), evidence.id);
    const updated = this.#database.query("UPDATE sessions SET version = ? WHERE session_id = ? AND version = ?").run(version, action.sessionId, row.version);
    if (updated.changes !== 1) throw new Error("session version fence changed during serialized transaction");
    return freeze(copy(result));
  }

  #fingerprintEvidenceSync(value: unknown): string {
    // SQLite's transaction callback is synchronous. Bun exposes a synchronous SHA-256 implementation through Bun.CryptoHasher.
    return new Bun.CryptoHasher("sha256").update(canonicalJson(value)).digest("hex");
  }
}
