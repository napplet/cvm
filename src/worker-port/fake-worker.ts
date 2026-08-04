import { canonicalJson } from "../promotion/schema";
import {
  CheckpointProposalSchema,
  ToolRequestSchema,
  WorkerEventSchema,
  WorkerRunRequestSchema,
  WorkerRunResultSchema,
  type CheckpointProposal,
  type ToolRequest,
  type WorkerEvent,
  type WorkerPort,
  type WorkerRunRequest,
  type WorkerRunResult,
} from "../phase-02/contracts";
import { PHASE_02_POLICY_INITIAL } from "../policy/phase-02-policy";
import { ScopedToolGateway, type ToolDispatcher } from "../capabilities/scoped-tool-gateway";

export type FakeWorkerStep =
  | Readonly<{ kind: "read"; path: string }>
  | Readonly<{ kind: "write"; path: string; content: string }>
  | Readonly<{ kind: "capture"; label: string }>
  | Readonly<{ kind: "checkpoint"; archive: string | Uint8Array; inventory: readonly string[] }>;

function relativePath(path: string): string | undefined {
  if (!path || path.includes("\0") || path.startsWith("/")) return undefined;
  const parts = path.split("/");
  return parts.some((part) => !part || part === "." || part === "..") ? undefined : parts.join("/");
}

/** A synthetic per-session filesystem; it intentionally exposes neither host paths nor an environment. */
export class FakeWorkspaceHarness {
  #files = new Map<string, string>();
  readonly dispatcher: ToolDispatcher;

  constructor(readonly options: Readonly<{ workspaceId: string; root: string; files?: Readonly<Record<string, string>> }>) {
    for (const [path, content] of Object.entries(options.files ?? {})) {
      const normalized = relativePath(path);
      if (!normalized) throw new Error("fake workspace seed path escaped its workspace");
      this.#files.set(normalized, content);
    }
    this.dispatcher = Object.freeze({ dispatch: async (request, context) => this.dispatch(request, context.workspacePath) });
  }

  get workspaceId(): string { return this.options.workspaceId; }
  get root(): string { return this.options.root; }

  read(path: string): string | undefined {
    const normalized = relativePath(path);
    return normalized ? this.#files.get(normalized) : undefined;
  }

  private dispatch(request: ToolRequest, workspacePath: string | undefined): { output?: unknown } {
    if ((request.tool === "workspace_read" || request.tool === "workspace_write") && (!workspacePath || !workspacePath.startsWith(`${this.root.replace(/\/+$/u, "")}/`))) {
      throw new Error("dispatcher refused a path outside its workspace");
    }
    if (request.tool === "workspace_read") return { output: this.read(request.path) ?? null };
    if (request.tool === "workspace_write") {
      const normalized = relativePath(request.path);
      if (!normalized) throw new Error("dispatcher refused escaped write");
      this.#files.set(normalized, request.content);
      return { output: "written" };
    }
    if (request.tool === "capture_evidence") return { output: "captured" };
    if (request.tool === "export_checkpoint") return { output: "checkpoint-authorized" };
    throw new Error("fake harness has no command execution authority");
  }
}

async function sha256(bytes: Uint8Array): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", bytes);
  return Array.from(new Uint8Array(digest), (item) => item.toString(16).padStart(2, "0")).join("");
}

function bytes(value: string | Uint8Array): Uint8Array { return typeof value === "string" ? new TextEncoder().encode(value) : value; }
function base64(value: Uint8Array): string { return btoa(Array.from(value, (item) => String.fromCharCode(item)).join("")); }
function fromBase64(value: string): Uint8Array | undefined {
  try { return Uint8Array.from(atob(value), (item) => item.charCodeAt(0)); } catch { return undefined; }
}

/** Re-validates a portable proposal against the coordinator's exact action binding. */
export async function validateCheckpointProposal(proposal: unknown, request: WorkerRunRequest): Promise<CheckpointProposal | undefined> {
  const parsed = CheckpointProposalSchema.safeParse(proposal);
  if (!parsed.success) return undefined;
  const checkpoint = parsed.data;
  if (checkpoint.sessionId !== request.sessionId || checkpoint.actionId !== request.actionId || checkpoint.expectedVersion !== request.expectedVersion || checkpoint.policyVersion !== request.policyVersion || checkpoint.capabilityGrant !== request.capabilityGrant || checkpoint.workspaceId !== request.workspaceId) return undefined;
  const archive = fromBase64(checkpoint.archiveBase64);
  if (!archive || base64(archive) !== checkpoint.archiveBase64 || await sha256(archive) !== checkpoint.archiveSha256) return undefined;
  return checkpoint;
}

/**
 * A deterministic conformance worker, not a claimed production sandbox.  Its
 * only effect path is ScopedToolGateway; no environment, credentials, network,
 * host filesystem, or durable store is attached to this object.
 */
export class DeterministicFakeWorker implements WorkerPort {
  #active = new Set<string>();
  #terminal = new Map<string, WorkerRunResult>();
  #clock: () => number;
  #barrier?: () => Promise<void>;

  constructor(private readonly options: Readonly<{
    gateway: ScopedToolGateway;
    workspace?: FakeWorkspaceHarness;
    assigned?: boolean;
    script?: readonly FakeWorkerStep[];
    now?: () => number;
    barrier?: () => Promise<void>;
    faultAtTurn?: number;
  }>) {
    this.#clock = options.now ?? Date.now;
    this.#barrier = options.barrier;
  }

  async run(input: WorkerRunRequest, signal: AbortSignal): Promise<WorkerRunResult> {
    const request = WorkerRunRequestSchema.parse(input);
    const identity = `${request.sessionId}\u0000${request.actionId}`;
    if (this.#terminal.has(identity) || this.#active.has(identity)) return WorkerRunResultSchema.parse({ status: "blocked", code: "WORKER_STALE_EVENT" });
    if (this.options.assigned === false) return WorkerRunResultSchema.parse({ status: "unavailable", code: "WORKER_UNAVAILABLE" });
    if (this.options.workspace && this.options.workspace.workspaceId !== request.workspaceId) return WorkerRunResultSchema.parse({ status: "blocked", code: "WORKER_GATEWAY_DENIED" });
    this.#active.add(identity);
    try {
      if (signal.aborted) return this.finish(identity, { status: "interrupted", code: "WORKER_INTERRUPTED" });
      await this.#barrier?.();
      if (signal.aborted) return this.finish(identity, { status: "interrupted", code: "WORKER_INTERRUPTED" });
      const script = this.options.script ?? [];
      const events: WorkerEvent[] = [];
      let validatedBoundary = false;
      let checkpoint: CheckpointProposal | undefined;
      for (let index = 0; index < script.length; index += 1) {
        if (index >= PHASE_02_POLICY_INITIAL.action.maxTurns) return this.finish(identity, { status: "limited", code: "WORKER_TURN_LIMIT" });
        if (signal.aborted) return this.finish(identity, { status: "interrupted", code: "WORKER_INTERRUPTED" });
        if (this.options.faultAtTurn === index + 1) return this.finish(identity, { status: "interrupted", code: "WORKER_INTERRUPTED" });
        const step = script[index]!;
        const turn = index + 1;
        if (step.kind === "checkpoint" && !validatedBoundary) return this.finish(identity, { status: "blocked", code: "CHECKPOINT_BOUNDARY_REQUIRED" });
        const proposal = this.toolFor(step, request, turn);
        const parsedProposal = ToolRequestSchema.parse(proposal);
        events.push(WorkerEventSchema.parse({ kind: "tool_proposal", turn, request: parsedProposal }));
        const decision = await this.options.gateway.authorizeAndDispatch(parsedProposal);
        if (decision.status !== "allowed") return this.finish(identity, { status: "blocked", code: "WORKER_GATEWAY_DENIED" });
        if (step.kind === "checkpoint") {
          checkpoint = await this.checkpoint(request, step, events);
          events.push(WorkerEventSchema.parse({ kind: "checkpoint_proposal", turn, proposal: { checkpointId: proposal.checkpointId } }));
        } else {
          validatedBoundary = true;
          events.push(WorkerEventSchema.parse({ kind: "progress", turn, detail: `validated ${step.kind} boundary at ${this.#clock()}` }));
        }
      }
      if (signal.aborted) return this.finish(identity, { status: "interrupted", code: "WORKER_INTERRUPTED" });
      return this.finish(identity, { status: "completed", code: "WORKER_PROPOSALS_VALIDATED", events, ...(checkpoint ? { checkpoint } : {}) });
    } finally {
      this.#active.delete(identity);
    }
  }

  private toolFor(step: FakeWorkerStep, request: WorkerRunRequest, turn: number): ToolRequest {
    const correlation = { sessionId: request.sessionId, actionId: request.actionId, expectedVersion: request.expectedVersion, policyVersion: request.policyVersion, capabilityGrant: request.capabilityGrant, workspaceId: request.workspaceId, callId: `${request.actionId}:turn:${turn}`, evidenceId: `${request.actionId}:evidence:${turn}` };
    if (step.kind === "read") return { ...correlation, tool: "workspace_read", path: step.path };
    if (step.kind === "write") return { ...correlation, tool: "workspace_write", path: step.path, content: step.content };
    if (step.kind === "capture") return { ...correlation, tool: "capture_evidence", label: step.label };
    return { ...correlation, tool: "export_checkpoint", checkpointId: `${request.actionId}:checkpoint:${turn}` };
  }

  private async checkpoint(request: WorkerRunRequest, step: Extract<FakeWorkerStep, { kind: "checkpoint" }>, events: readonly WorkerEvent[]): Promise<CheckpointProposal> {
    const archive = bytes(step.archive);
    const evidence = new TextEncoder().encode(canonicalJson(events));
    return CheckpointProposalSchema.parse({
      sessionId: request.sessionId, actionId: request.actionId, expectedVersion: request.expectedVersion, policyVersion: request.policyVersion, capabilityGrant: request.capabilityGrant, workspaceId: request.workspaceId,
      formatVersion: "portable-checkpoint-v1", inventory: [...step.inventory], archiveBase64: base64(archive), archiveSha256: await sha256(archive), evidenceSha256: await sha256(evidence),
    });
  }

  private finish(identity: string, result: WorkerRunResult): WorkerRunResult {
    const parsed = WorkerRunResultSchema.parse(result);
    this.#terminal.set(identity, parsed);
    return parsed;
  }
}
