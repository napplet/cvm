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
  artifact?: AcceptedArtifact;
}>;

/** Coordinator-verified, content-addressed identity; never a worker assertion. */
export type AcceptedArtifact = Readonly<{
  artifactId: string;
  artifactSha256: string;
  scannerReportSha256: string;
  conformanceReportSha256: string;
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
  artifactId?: string;
  artifactDigest?: string;
}>;

async function sha256(text: string): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(text));
  return Array.from(new Uint8Array(digest), (byte) => byte.toString(16).padStart(2, "0")).join("");
}

/**
 * Stable identity available before a worker is started.  It deliberately
 * excludes the verified artifact: a lost-response retry must find the durable
 * result before recreating a worker proposal.
 */
export async function fingerprintSessionRequest(action: SessionAction): Promise<SessionActionFingerprint> {
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

/** D-20 durable action identity includes the coordinator-verified artifact. */
export async function fingerprintSessionAction(action: SessionAction): Promise<SessionActionFingerprint> {
  const requestFingerprint = await fingerprintSessionRequest(action);
  return sha256(canonicalJson({ requestFingerprint, artifact: action.artifact ?? null }));
}

export async function fingerprintEvidence(value: unknown): Promise<string> {
  return sha256(canonicalJson(value));
}
