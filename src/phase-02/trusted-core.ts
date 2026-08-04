import { canonicalJson } from "../promotion/schema";
import { PHASE_02_POLICY_INITIAL } from "../policy/phase-02-policy";
import {
  ActionEnvelopeSchema,
  WorkerProposalSchema,
  type ActionEnvelope,
  type SessionEvidence,
  type SessionStore,
  type SessionTransaction,
  type StoredResult,
  type WorkerPort,
  type WorkerRunRequest,
  type WorkerToolRequest,
} from "./contracts";

export type { ActionEnvelope, WorkerPort, WorkerRunRequest } from "./contracts";

type CoreResult = Readonly<{
  status: "completed" | "denied" | "recoverable_failure";
  code: "ACTION_COMMITTED" | "ADMISSION_DENIED" | "IDEMPOTENCY_KEY_CONFLICT" | "STALE_SESSION_VERSION" | "TOOL_AUTHORIZATION_DENIED" | "WORKER_UNCERTAIN";
  version?: number;
  currentVersion?: number;
  evidenceDigest?: string;
}>;

type StoredSession = {
  version: number;
  replays: Map<string, { fingerprint: string; result: StoredResult }>;
};

type WorkspaceEffect = Readonly<{ workspaceId: string; path: string; content: string }>;

function freeze<T>(value: T): T {
  if (value !== null && typeof value === "object" && !Object.isFrozen(value)) {
    for (const child of Object.values(value as Record<string, unknown>)) freeze(child);
    Object.freeze(value);
  }
  return value;
}

function copy<T>(value: T): T {
  return JSON.parse(JSON.stringify(value)) as T;
}

function cloneSession(session: StoredSession): StoredSession {
  return {
    version: session.version,
    replays: new Map([...session.replays].map(([key, record]) => [key, { fingerprint: record.fingerprint, result: copy(record.result) }])),
  };
}

async function sha256(value: unknown): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(canonicalJson(value)));
  return Array.from(new Uint8Array(digest), (byte) => byte.toString(16).padStart(2, "0")).join("");
}

/** Stable identity for exact duplicate detection, independent of property order. */
export async function canonicalActionFingerprint(action: ActionEnvelope): Promise<string> {
  return sha256(action);
}

/** Canonical, content-addressed audit identity for one trusted-core decision. */
export async function canonicalEvidenceDigest(evidence: Omit<SessionEvidence, "evidenceDigest">): Promise<string> {
  return sha256(evidence);
}

/**
 * Fast test double only. It serializes all session work, copies state before a
 * transaction, and commits both result and append-only evidence only on return.
 * Plan 03 supplies the durable reference store.
 */
export class TransactionalMemorySessionStore implements SessionStore {
  #sessions = new Map<string, StoredSession>();
  #evidence: SessionEvidence[] = [];
  #tail: Promise<void> = Promise.resolve();

  get evidence(): readonly SessionEvidence[] {
    return freeze(copy(this.#evidence));
  }

  getSessionVersion(sessionId: string): number {
    return this.#sessions.get(sessionId)?.version ?? 0;
  }

  async transact<T>(sessionId: string, operation: (transaction: SessionTransaction) => Promise<T> | T): Promise<T> {
    let release: (() => void) | undefined;
    const previous = this.#tail;
    this.#tail = new Promise<void>((resolve) => { release = resolve; });
    await previous;
    const session = cloneSession(this.#sessions.get(sessionId) ?? { version: 0, replays: new Map() });
    const evidence = [...this.#evidence];
    const transaction: SessionTransaction = {
      getVersion: () => session.version,
      getReplay: (idempotencyKey) => {
        const replay = session.replays.get(idempotencyKey);
        return replay ? freeze(copy(replay)) : undefined;
      },
      recordResult: (idempotencyKey, fingerprint, result, nextVersion) => {
        session.replays.set(idempotencyKey, { fingerprint, result: freeze(copy(result)) });
        session.version = nextVersion;
      },
      appendEvidence: (item) => evidence.push(freeze(copy(item))),
    };
    try {
      const result = await operation(transaction);
      this.#sessions.set(sessionId, session);
      this.#evidence = evidence;
      return result;
    } finally {
      release?.();
    }
  }
}

function admissionDenied(): CoreResult {
  return freeze({ status: "denied", code: "ADMISSION_DENIED" });
}

function canonicalIdea(idea: string): boolean {
  const policy = PHASE_02_POLICY_INITIAL.admission;
  if (idea.length === 0 || idea !== idea.normalize("NFC")) return false;
  if (new TextDecoder("utf-8", { fatal: true }).decode(new TextEncoder().encode(idea)) !== idea) return false;
  const codePoints = Array.from(idea);
  if (codePoints.length > policy.maxCodePoints || new TextEncoder().encode(idea).byteLength > policy.maxUtf8Bytes) return false;
  const lines = idea.split("\n");
  if (lines.length > policy.maxLines || lines.some((line) => Array.from(line).length > policy.maxCodePointsPerLine)) return false;
  const graphemes = [...new Intl.Segmenter(undefined, { granularity: "grapheme" }).segment(idea)].length;
  if (graphemes > policy.maxGraphemes) return false;
  const tokens = idea.trim().split(/\s+/u).filter(Boolean).length;
  return tokens <= policy.maxInputTokens;
}

function riskDecision(idea: string): boolean {
  return !/(?:ignore\s+(?:all\s+)?previous|system\s+prompt|jailbreak)/iu.test(idea);
}

function safeWorkspacePath(path: string): boolean {
  const { maxPathCharacters } = PHASE_02_POLICY_INITIAL.tools;
  return path.length > 0 && path.length <= maxPathCharacters && !path.includes("\0") && !path.startsWith("/") && !path.split("/").some((part) => part === "" || part === "." || part === "..");
}

export class TrustedCore {
  constructor(private readonly store: SessionStore, private readonly worker: WorkerPort, private readonly dispatchWrite: (effect: WorkspaceEffect) => void) {}

  async execute(input: unknown, signal: AbortSignal = new AbortController().signal): Promise<CoreResult> {
    const parsed = ActionEnvelopeSchema.safeParse(input);
    if (!parsed.success || !canonicalIdea(parsed.data.idea) || !riskDecision(parsed.data.idea) || parsed.data.policyVersion !== PHASE_02_POLICY_INITIAL.policyVersion) {
      return admissionDenied();
    }
    const action = parsed.data;
    const fingerprint = await canonicalActionFingerprint(action);
    return this.store.transact(action.sessionId, async (transaction) => {
      const replay = transaction.getReplay(action.idempotencyKey);
      if (replay) {
        if (replay.fingerprint !== fingerprint) return freeze({ status: "denied", code: "IDEMPOTENCY_KEY_CONFLICT" });
        return freeze(copy(replay.result)) as CoreResult;
      }
      const currentVersion = transaction.getVersion();
      if (action.expectedVersion !== currentVersion) return freeze({ status: "denied", code: "STALE_SESSION_VERSION", currentVersion });

      const workspaceId = `workspace:${action.sessionId}`;
      const capabilityGrant = await sha256({
        policyVersion: PHASE_02_POLICY_INITIAL.policyVersion,
        principalId: action.principal.id,
        sessionId: action.sessionId,
        actionId: action.actionId,
        expectedVersion: action.expectedVersion,
        workspaceId,
      });
      const request: WorkerRunRequest = { sessionId: action.sessionId, actionId: action.actionId, expectedVersion: action.expectedVersion, policyVersion: action.policyVersion, capabilityGrant, workspaceId, idea: action.idea };
      if (signal.aborted) return this.recordFailure(transaction, action, fingerprint, capabilityGrant, currentVersion, "WORKER_UNCERTAIN");

      let proposed: unknown;
      try {
        proposed = await this.worker.run(request, signal);
      } catch {
        return this.recordFailure(transaction, action, fingerprint, capabilityGrant, currentVersion, "WORKER_UNCERTAIN");
      }
      const proposal = WorkerProposalSchema.safeParse(proposed);
      if (!proposal.success || proposal.data.toolRequests.length !== 1) {
        return this.recordFailure(transaction, action, fingerprint, capabilityGrant, currentVersion, "TOOL_AUTHORIZATION_DENIED");
      }
      const tool = proposal.data.toolRequests[0]!;
      if (!this.isAuthorizedTool(tool, request)) {
        return this.recordFailure(transaction, action, fingerprint, capabilityGrant, currentVersion, "TOOL_AUTHORIZATION_DENIED");
      }

      this.dispatchWrite(freeze({ workspaceId, path: tool.path, content: tool.content }));
      const nextVersion = currentVersion + 1;
      const evidence = await this.evidence(action, fingerprint, capabilityGrant, nextVersion, "ACTION_COMMITTED");
      const result = freeze({ status: "completed" as const, code: "ACTION_COMMITTED" as const, version: nextVersion, evidenceDigest: evidence.evidenceDigest });
      transaction.recordResult(action.idempotencyKey, fingerprint, result, nextVersion);
      transaction.appendEvidence(evidence);
      return result;
    });
  }

  private isAuthorizedTool(tool: WorkerToolRequest, request: WorkerRunRequest): boolean {
    return tool.tool === "write_workspace_file"
      && tool.sessionId === request.sessionId
      && tool.actionId === request.actionId
      && tool.expectedVersion === request.expectedVersion
      && tool.policyVersion === request.policyVersion
      && tool.capabilityGrant === request.capabilityGrant
      && tool.workspaceId === request.workspaceId
      && safeWorkspacePath(tool.path)
      && tool.content.length <= PHASE_02_POLICY_INITIAL.tools.maxWriteContentCharacters;
  }

  private async evidence(action: ActionEnvelope, fingerprint: string, capabilityGrant: string, version: number, outcomeCode: SessionEvidence["outcomeCode"]): Promise<SessionEvidence> {
    const base = { principalId: action.principal.id, sessionId: action.sessionId, actionId: action.actionId, version, policyVersion: action.policyVersion, capabilityGrant, outcomeCode, fingerprint };
    return freeze({ ...base, evidenceDigest: await canonicalEvidenceDigest(base) });
  }

  private async recordFailure(transaction: SessionTransaction, action: ActionEnvelope, fingerprint: string, capabilityGrant: string, version: number, code: "TOOL_AUTHORIZATION_DENIED" | "WORKER_UNCERTAIN"): Promise<CoreResult> {
    const evidence = await this.evidence(action, fingerprint, capabilityGrant, version, code);
    transaction.appendEvidence(evidence);
    return freeze({ status: code === "WORKER_UNCERTAIN" ? "recoverable_failure" : "denied", code, evidenceDigest: evidence.evidenceDigest });
  }
}

/** Small runnable composition for the Plan 01 tracer; not the durable reference composition. */
export function createPhase02Tracer(worker: WorkerPort): { readonly core: TrustedCore; readonly store: TransactionalMemorySessionStore; readonly effects: readonly WorkspaceEffect[] } {
  const store = new TransactionalMemorySessionStore();
  const effects: WorkspaceEffect[] = [];
  return {
    core: new TrustedCore(store, worker, (effect) => effects.push(effect)),
    store,
    get effects() { return freeze(copy(effects)); },
  };
}
