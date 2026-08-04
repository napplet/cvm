import { fingerprintEvidence, fingerprintSessionAction, type SessionAction, type SessionActionResult } from "./session-action";
import type { SessionStore, WorkerLease } from "../persistence/session-store";

class ActionInterrupted extends Error {
  constructor() { super("action interrupted before evaluation"); }
}

function freeze<T>(value: T): T {
  if (value !== null && typeof value === "object" && !Object.isFrozen(value)) {
    for (const child of Object.values(value as Record<string, unknown>)) freeze(child);
    Object.freeze(value);
  }
  return value;
}

/**
 * Transport-neutral caller semantics over one authoritative SessionStore
 * transaction. It never retries a mutation: callers choose an explicit next
 * action after a stale result, and exact retries are resolved by the store.
 */
export class SessionService {
  constructor(private readonly store: SessionStore) {}

  async apply(action: SessionAction, signal: AbortSignal = new AbortController().signal, lease?: WorkerLease, nowMs?: number): Promise<SessionActionResult> {
    if (signal.aborted) return this.interrupted(action);
    try {
      return await this.store.apply(action, () => {
        // This check occurs inside the store transaction immediately before
        // evaluation. Throwing makes the store rollback its private copy/SQL tx.
        if (signal.aborted) throw new ActionInterrupted();
      }, lease, nowMs);
    } catch (error) {
      if (error instanceof ActionInterrupted) return this.interrupted(action);
      throw error;
    }
  }

  private async interrupted(action: SessionAction): Promise<SessionActionResult> {
    const fingerprint = await fingerprintSessionAction(action);
    const evidenceDigest = await fingerprintEvidence({ fingerprint, outcomeCode: "ACTION_INTERRUPTED" });
    return freeze({ status: "recoverable_failure", code: "ACTION_INTERRUPTED", evidenceDigest });
  }
}
