import { evaluateAdmission, type TokenCounter } from "../admission/admission-policy";
import { evaluateRisk, type RiskSignalDetector } from "../admission/risk-policy";
import { GrantRegistry, ScopedToolGateway, type ToolDispatcher } from "../capabilities/scoped-tool-gateway";
import { type AcceptedArtifact, type SessionAction, type SessionActionResult } from "../domain/session-action";
import { SessionService } from "../domain/session-service";
import { SqliteSessionStore } from "../persistence/sqlite-session-store";
import { TransactionalMemorySessionStore, type SessionRecord, type SessionStore } from "../persistence/session-store";
import { evaluateArtifactContract, type ArtifactContractInput } from "../policy/artifact-contract";
import { PHASE_02_POLICY_INITIAL } from "../policy/phase-02-policy";
import { canonicalJson } from "../promotion/schema";
import { validateCheckpointProposal } from "../worker-port/fake-worker";
import {
  ActionEnvelopeSchema,
  WorkerEventSchema,
  WorkerRunRequestSchema,
  WorkerRunResultSchema,
  type ActionEnvelope,
  type WorkerEvent,
  type WorkerArtifact,
  type WorkerPort,
  type WorkerRunRequest,
  type WorkerRunResult,
} from "./contracts";

export type { ActionEnvelope, WorkerPort, WorkerRunRequest } from "./contracts";

export type TrustedCoreResult = Readonly<{
  status: "completed" | "denied" | "recoverable_failure";
  code: string;
  version?: number;
  currentVersion?: number;
  evidenceDigest?: string;
  evidenceId?: string;
  artifactId?: string;
  artifactDigest?: string;
}>;

export type TrustedCoreArtifactFacts = Readonly<{
  action: ActionEnvelope;
  request: WorkerRunRequest;
  result: WorkerRunResult;
  events: readonly WorkerEvent[];
}>;

/** Coordinator-only Phase 1 verification boundary; workers submit proposals, never pass verdicts. */
export type ArtifactVerifier = Readonly<{
  verify: (facts: TrustedCoreArtifactFacts) => Promise<Readonly<{ artifact: AcceptedArtifact; contractInput: ArtifactContractInput }> | undefined>;
}>;

export type TrustedCoreOptions = Readonly<{
  /** Required for final/reference composition unless an explicit test store is supplied. */
  databasePath?: string;
  /** Test-only injection; final composition never creates this volatile store implicitly. */
  store?: SessionStore;
  worker: WorkerPort;
  workspaceRoot?: string;
  tokenCounter?: TokenCounter;
  riskDetector?: RiskSignalDetector;
  dispatcher?: ToolDispatcher;
  artifactVerifier?: ArtifactVerifier;
  sessions?: readonly SessionRecord[];
  now?: () => number;
}>;

type InternalDependencies = Readonly<{
  store: SessionStore;
  worker: WorkerPort;
  workspaceRoot: string;
  tokenCounter: TokenCounter;
  riskDetector: RiskSignalDetector;
  dispatcher: ToolDispatcher;
  artifactVerifier: ArtifactVerifier;
  now: () => number;
}>;

const DEFAULT_COUNTER: TokenCounter = Object.freeze({
  version: "phase-02-whitespace-token-counter-v1",
  count: (idea) => idea.trim().split(/\s+/u).filter(Boolean).length,
});
const DEFAULT_RISK_DETECTOR: RiskSignalDetector = Object.freeze({
  version: "phase-02-deterministic-risk-detector-v1",
  detect: () => [],
});
const DEFAULT_DISPATCHER: ToolDispatcher = Object.freeze({
  dispatch: async () => { throw new Error("no coordinator dispatcher configured"); },
});

function freeze<T>(value: T): T {
  if (value !== null && typeof value === "object" && !Object.isFrozen(value)) {
    for (const child of Object.values(value as Record<string, unknown>)) freeze(child);
    Object.freeze(value);
  }
  return value;
}

async function digest(value: unknown): Promise<string> {
  const bytes = new TextEncoder().encode(canonicalJson(value));
  const hash = await crypto.subtle.digest("SHA-256", bytes);
  return Array.from(new Uint8Array(hash), (byte) => byte.toString(16).padStart(2, "0")).join("");
}

async function digestText(value: string): Promise<string> {
  const hash = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(value));
  return Array.from(new Uint8Array(hash), (byte) => byte.toString(16).padStart(2, "0")).join("");
}

const DEFAULT_ARTIFACT_VERIFIER: ArtifactVerifier = Object.freeze({ verify: async () => undefined });

function artifactMatchesRequest(artifact: WorkerArtifact, request: WorkerRunRequest): boolean {
  return artifact.sessionId === request.sessionId
    && artifact.actionId === request.actionId
    && artifact.expectedVersion === request.expectedVersion
    && artifact.policyVersion === request.policyVersion
    && artifact.capabilityGrant === request.capabilityGrant
    && artifact.workspaceId === request.workspaceId;
}

function isDigest(value: string): boolean { return /^[a-f0-9]{64}$/iu.test(value); }
function verifiedArtifactIsValid(value: Readonly<{ artifact: AcceptedArtifact; contractInput: ArtifactContractInput }>): boolean {
  const artifact = value.artifact;
  return artifact.artifactId.length > 0 && isDigest(artifact.artifactSha256) && isDigest(artifact.scannerReportSha256) && isDigest(artifact.conformanceReportSha256);
}

function asFailure(code: string, details: unknown): Promise<TrustedCoreResult> {
  return digest({ phase: "02", code, details }).then((evidenceDigest) => freeze({
    status: code === "ADMISSION_DENIED" || code === "RISK_DENIED" || code === "TOOL_AUTHORIZATION_DENIED" ? "denied" : "recoverable_failure",
    code,
    evidenceDigest,
  }));
}

function sessionResult(result: SessionActionResult): TrustedCoreResult {
  return freeze({
    status: result.status,
    code: result.code,
    ...(result.version === undefined ? {} : { version: result.version }),
    ...(result.currentVersion === undefined ? {} : { currentVersion: result.currentVersion }),
    ...(result.evidenceDigest === undefined ? {} : { evidenceDigest: result.evidenceDigest }),
    ...(result.evidenceId === undefined ? {} : { evidenceId: result.evidenceId }),
    ...(result.artifactId === undefined ? {} : { artifactId: result.artifactId }),
    ...(result.artifactDigest === undefined ? {} : { artifactDigest: result.artifactDigest }),
  });
}

/**
 * The transport-neutral Phase 2 authority. Order is intentional: admission,
 * restrictive risk, version-fenced session authority, grant/gateway, canonical
 * worker parsing, Phase 1 artifact contract, then the one durable commit seam.
 */
export class TrustedCore {
  readonly #service: SessionService;
  #tails = new Map<string, Promise<void>>();

  constructor(private readonly dependencies: InternalDependencies) {
    this.#service = new SessionService(dependencies.store);
  }

  get store(): SessionStore { return this.dependencies.store; }

  async execute(input: unknown, signal: AbortSignal = new AbortController().signal): Promise<TrustedCoreResult> {
    const sessionId = input !== null && typeof input === "object" && typeof (input as Record<string, unknown>).sessionId === "string"
      ? (input as Record<string, string>).sessionId : "__invalid_session__";
    let release!: () => void;
    const previous = this.#tails.get(sessionId) ?? Promise.resolve();
    const current = new Promise<void>((resolve) => { release = resolve; });
    this.#tails.set(sessionId, current);
    await previous;
    try { return await this.#executeBounded(input, signal); }
    finally {
      release();
      if (this.#tails.get(sessionId) === current) this.#tails.delete(sessionId);
    }
  }

  async #executeBounded(input: unknown, signal: AbortSignal): Promise<TrustedCoreResult> {
    const parsedAction = ActionEnvelopeSchema.safeParse(input);
    if (!parsedAction.success || parsedAction.data.policyVersion !== PHASE_02_POLICY_INITIAL.policyVersion) {
      return asFailure("ADMISSION_DENIED", { reason: "action envelope or policy identity invalid" });
    }
    const action = parsedAction.data;

    // Exact replay must be resolved before admission/risk/worker allocation so a
    // response-loss retry cannot repeat a gateway or worker side effect.
    const replayAction: SessionAction = freeze({
      principal: action.principal, sessionId: action.sessionId, actionId: action.actionId,
      kind: action.kind, idempotencyKey: action.idempotencyKey, expectedVersion: action.expectedVersion,
      policyVersion: action.policyVersion, payload: freeze({ ideaSha256: await digestText(action.idea), artifactGate: "phase-1-composed" }),
    });
    const replay = await this.dependencies.store.findRecordedResult(replayAction);
    if (replay) return sessionResult(replay);

    // Hard admission is a separate first boundary. No risk detector, store,
    // worker, gateway, artifact policy, allocation, or billable hook follows a denial.
    const admission = await evaluateAdmission({ idea: action.idea }, this.dependencies.tokenCounter);
    if (admission.status !== "accepted") return asFailure("ADMISSION_DENIED", admission.evidence);

    const risk = await evaluateRisk({ idea: admission.idea }, this.dependencies.tokenCounter, this.dependencies.riskDetector, ["workspace_write"]);
    if (risk.status !== "accepted") return asFailure("RISK_DENIED", risk.evidence);
    const leaseNow = this.dependencies.now();
    const lease = await this.dependencies.store.claimWorkerLease(replayAction, leaseNow, leaseNow + PHASE_02_POLICY_INITIAL.sandbox.execTimeoutSeconds * 1_000);
    if (!lease.authorized) return sessionResult(lease.result);
    try {
      if (signal.aborted) return asFailure("WORKER_UNCERTAIN", { reason: "aborted before worker allocation" });

    const capabilityGrant = await digest({
      policyVersion: PHASE_02_POLICY_INITIAL.policyVersion,
      principalId: action.principal.id,
      sessionId: action.sessionId,
      actionId: action.actionId,
      expectedVersion: action.expectedVersion,
      workspaceId: `workspace:${action.sessionId}`,
    });
    const request = WorkerRunRequestSchema.parse({
      sessionId: action.sessionId,
      actionId: action.actionId,
      expectedVersion: action.expectedVersion,
      policyVersion: action.policyVersion,
      capabilityGrant,
      workspaceId: `workspace:${action.sessionId}`,
      idea: admission.idea,
    });

    const grants = new GrantRegistry();
    grants.issue({
      id: capabilityGrant,
      sessionId: request.sessionId,
      actionId: request.actionId,
      expectedVersion: request.expectedVersion,
      policyVersion: request.policyVersion,
      workspaceId: request.workspaceId,
      workspaceRoot: this.dependencies.workspaceRoot,
      tools: ["workspace_write", "capture_evidence", "export_checkpoint"],
      expiresAtMs: this.dependencies.now() + PHASE_02_POLICY_INITIAL.sandbox.execTimeoutSeconds * 1_000,
    });
    const gateway = new ScopedToolGateway(grants, this.dependencies.dispatcher, { now: this.dependencies.now });

    let workerResult: WorkerRunResult;
    try {
      // Parse with the canonical authority before and after the WorkerPort boundary.
      workerResult = WorkerRunResultSchema.parse(await this.dependencies.worker.run(WorkerRunRequestSchema.parse(request), signal));
    } catch {
      return asFailure("WORKER_UNCERTAIN", { request: { sessionId: request.sessionId, actionId: request.actionId } });
    }
    if (workerResult.status !== "completed" || workerResult.code !== "WORKER_PROPOSALS_VALIDATED") {
      return asFailure("WORKER_UNCERTAIN", { status: workerResult.status, code: workerResult.code });
    }
    if (!artifactMatchesRequest(workerResult.artifact, request)) {
      return asFailure("WORKER_UNCERTAIN", { reason: "worker artifact binding invalid" });
    }

    const events: WorkerEvent[] = [];
    for (const event of workerResult.events) {
      const parsedEvent = WorkerEventSchema.safeParse(event);
      if (!parsedEvent.success) return asFailure("WORKER_UNCERTAIN", { reason: "worker event malformed" });
      events.push(parsedEvent.data);
    }
    if (workerResult.checkpoint && !await validateCheckpointProposal(workerResult.checkpoint, request, events)) {
      return asFailure("WORKER_UNCERTAIN", { reason: "checkpoint binding invalid" });
    }
    const facts = freeze({ action, request, result: workerResult, events: freeze(events) });
    let verified;
    try { verified = await this.dependencies.artifactVerifier.verify(facts); }
    catch { return asFailure("ARTIFACT_CONTRACT_BLOCKED", { reason: "trusted artifact verifier unavailable" }); }
    if (!verified || !verifiedArtifactIsValid(verified)) return asFailure("ARTIFACT_CONTRACT_BLOCKED", { reason: "trusted artifact verification required" });
    const artifact = await evaluateArtifactContract(verified.contractInput);
    if (artifact.verdict !== "pass") return asFailure("ARTIFACT_CONTRACT_BLOCKED", { evidenceSha256: artifact.evidenceSha256 });

    for (const event of events) {
      if (!("kind" in event)) return asFailure("WORKER_UNCERTAIN", { reason: "legacy worker event cannot carry effects" });
      if (event.kind === "tool_proposal") {
        const decision = await gateway.authorizeAndDispatch(event.request);
        if (decision.status !== "allowed") return asFailure("TOOL_AUTHORIZATION_DENIED", { code: decision.code });
      }
    }

    const sessionAction: SessionAction = freeze({
      principal: action.principal,
      sessionId: action.sessionId,
      actionId: action.actionId,
      kind: action.kind,
      idempotencyKey: action.idempotencyKey,
      expectedVersion: action.expectedVersion,
      policyVersion: action.policyVersion,
      // This payload is deliberately identical to replayAction: the durable
      // action fingerprint below carries the verified artifact identity, while
      // the request fingerprint remains usable before worker allocation.
      payload: replayAction.payload,
      artifact: verified.artifact,
    });
    const committed = await this.#service.apply(sessionAction, signal);
    if (committed.status === "completed") grants.terminal(capabilityGrant);
      return sessionResult(committed);
    } finally {
      await this.dependencies.store.releaseWorkerLease(replayAction);
    }
  }
}

export type TrustedCoreComposition = Readonly<{
  core: TrustedCore;
  store: SessionStore;
  close: () => void;
}>;

/** Final/reference constructor: SQLite is mandatory unless a caller deliberately injects a test double. */
export function createTrustedCore(options: TrustedCoreOptions): TrustedCoreComposition {
  if (!options.store && (!options.databasePath || options.databasePath.trim() === "")) {
    throw new Error("databasePath is required for final TrustedCore composition");
  }
  if (options.store && options.databasePath) throw new Error("provide either databasePath or an explicit test store, not both");
  const store = options.store ?? new SqliteSessionStore(options.databasePath!);
  for (const session of options.sessions ?? []) {
    try { store.createSession(session); }
    catch (error) {
      if (!(error instanceof Error) || !/UNIQUE constraint failed|session already exists/u.test(error.message)) throw error;
    }
  }
  const core = new TrustedCore({
    store,
    worker: options.worker,
    workspaceRoot: options.workspaceRoot ?? "/workspace",
    tokenCounter: options.tokenCounter ?? DEFAULT_COUNTER,
    riskDetector: options.riskDetector ?? DEFAULT_RISK_DETECTOR,
    dispatcher: options.dispatcher ?? DEFAULT_DISPATCHER,
    artifactVerifier: options.artifactVerifier ?? DEFAULT_ARTIFACT_VERIFIER,
    now: options.now ?? Date.now,
  });
  return freeze({ core, store, close: () => { if (store instanceof SqliteSessionStore) store.close(); } });
}

/** Compatibility helper for fast tests only; it is never used by final/reference execution. */
export function createPhase02Tracer(worker: WorkerPort): TrustedCoreComposition {
  return createTrustedCore({
    store: new TransactionalMemorySessionStore([{ sessionId: "session-0001", principalId: "principal:alice", version: 0 }]),
    worker,
  });
}
