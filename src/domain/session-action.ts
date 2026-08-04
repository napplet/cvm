import { canonicalJson } from "../promotion/schema";

export type SessionAction = Readonly<{
  principal: Readonly<{ id: string }>;
  sessionId: string;
  actionId: string;
  kind: string;
  idempotencyKey: string;
  expectedVersion: number;
  policyVersion: string;
  payload: unknown;
}>;

export type SessionActionFingerprint = string;

export type SessionActionResultCode =
  | "ACTION_COMMITTED"
  | "IDEMPOTENCY_KEY_CONFLICT"
  | "SESSION_NOT_FOUND"
  | "SESSION_SCOPE_MISMATCH"
  | "STALE_SESSION_VERSION"
  | "ACTION_INTERRUPTED"
  | "STORE_BUSY";

export type SessionActionResult = Readonly<{
  status: "completed" | "denied" | "recoverable_failure";
  code: SessionActionResultCode;
  version?: number;
  currentVersion?: number;
  evidenceId?: string;
  evidenceDigest?: string;
}>;

async function sha256(text: string): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(text));
  return Array.from(new Uint8Array(digest), (byte) => byte.toString(16).padStart(2, "0")).join("");
}

/** D-20 identity: canonical action envelope plus a canonical normalized payload hash. */
export async function fingerprintSessionAction(action: SessionAction): Promise<SessionActionFingerprint> {
  const payloadHash = await sha256(canonicalJson(action.payload));
  return sha256(canonicalJson({
    principalId: action.principal.id,
    sessionId: action.sessionId,
    kind: action.kind,
    idempotencyKey: action.idempotencyKey,
    expectedVersion: action.expectedVersion,
    policyVersion: action.policyVersion,
    payloadHash,
  }));
}

export async function fingerprintEvidence(value: unknown): Promise<string> {
  return sha256(canonicalJson(value));
}
