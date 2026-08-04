import { canonicalJson } from "../promotion/schema";
import { z } from "zod";
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

const PortableArchiveSchema = z.object({
  formatVersion: z.literal("portable-checkpoint-v1"),
  inventory: z.array(z.string().min(1)).min(1).max(1_000),
  payloadBase64: z.string().min(1),
}).strict();

async function canonicalDigest(value: unknown): Promise<string> {
  return sha256(new TextEncoder().encode(canonicalJson(value)));
}

function canonicalArchive(value: Uint8Array): { archiveBase64: string; inventory: readonly string[]; payloadBase64: string } | undefined {
  try {
    const text = new TextDecoder("utf-8", { fatal: true }).decode(value);
    const parsed = PortableArchiveSchema.safeParse(JSON.parse(text));
    if (!parsed.success || canonicalJson(parsed.data) !== text || !fromBase64(parsed.data.payloadBase64) || base64(fromBase64(parsed.data.payloadBase64)!) !== parsed.data.payloadBase64) return undefined;
    return { archiveBase64: base64(value), inventory: parsed.data.inventory, payloadBase64: parsed.data.payloadBase64 };
  } catch { return undefined; }
}

/** Re-validates a portable proposal against the coordinator's exact action binding. */
export async function validateCheckpointProposal(proposal: unknown, request: WorkerRunRequest, events: readonly WorkerEvent[]): Promise<CheckpointProposal | undefined> {
  const parsed = CheckpointProposalSchema.safeParse(proposal);
  if (!parsed.success) return undefined;
  const checkpoint = parsed.data;
  if (checkpoint.sessionId !== request.sessionId || checkpoint.actionId !== request.actionId || checkpoint.expectedVersion !== request.expectedVersion || checkpoint.policyVersion !== request.policyVersion || checkpoint.capabilityGrant !== request.capabilityGrant || checkpoint.workspaceId !== request.workspaceId) return undefined;
  const archive = fromBase64(checkpoint.archiveBase64);
  if (!archive || base64(archive) !== checkpoint.archiveBase64 || await sha256(archive) !== checkpoint.archiveSha256) return undefined;
  const embedded = canonicalArchive(archive);
  if (!embedded || embedded.archiveBase64 !== checkpoint.archiveBase64 || canonicalJson(embedded.inventory) !== canonicalJson(checkpoint.inventory) || await canonicalDigest(checkpoint.inventory) !== checkpoint.inventorySha256) return undefined;
  const checkpoints = events.filter((event): event is Extract<WorkerEvent, { kind: "checkpoint_proposal" }> => "kind" in event && event.kind === "checkpoint_proposal");
  if (checkpoints.length !== 1) return undefined;
  const checkpointEvent = checkpoints[0]!;
  if (checkpointEvent.proposal.checkpointId !== checkpoint.checkpointId || checkpointEvent.proposal.archiveSha256 !== checkpoint.archiveSha256 || checkpointEvent.proposal.evidenceSha256 !== checkpoint.evidenceSha256 || checkpointEvent.proposal.inventorySha256 !== checkpoint.inventorySha256) return undefined;
  const exports = events.filter((event): event is Extract<WorkerEvent, { kind: "tool_proposal" }> => "kind" in event && event.kind === "tool_proposal" && event.request.tool === "export_checkpoint" && event.request.checkpointId === checkpoint.checkpointId);
  if (exports.length !== 1) return undefined;
  const evidenceEvents = events.filter((event) => !("kind" in event && event.kind === "checkpoint_proposal"));
  if (await canonicalDigest(evidenceEvents) !== checkpoint.evidenceSha256) return undefined;
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
      let turn = 0;
      for (let index = 0; index < script.length; index += 1) {
        if (signal.aborted) return this.finish(identity, { status: "interrupted", code: "WORKER_INTERRUPTED" });
        if (this.options.faultAtTurn === index + 1) return this.finish(identity, { status: "interrupted", code: "WORKER_INTERRUPTED" });
        const step = script[index]!;
        if (step.kind === "checkpoint" && !validatedBoundary) return this.finish(identity, { status: "blocked", code: "CHECKPOINT_BOUNDARY_REQUIRED" });
        const requiredEvents = step.kind === "checkpoint" ? 2 : 1;
        if (turn + requiredEvents > PHASE_02_POLICY_INITIAL.action.maxTurns) return this.finish(identity, { status: "limited", code: "WORKER_TURN_LIMIT" });
        turn += 1;
        const proposal = this.toolFor(step, request, turn);
        const parsedProposal = ToolRequestSchema.parse(proposal);
        events.push(WorkerEventSchema.parse({ kind: "tool_proposal", turn, request: parsedProposal }));
        const decision = await this.options.gateway.authorizeAndDispatch(parsedProposal);
        if (decision.status !== "allowed") return this.finish(identity, { status: "blocked", code: "WORKER_GATEWAY_DENIED" });
        if (step.kind === "checkpoint") {
          checkpoint = await this.checkpoint(request, step, events);
          turn += 1;
          events.push(WorkerEventSchema.parse({ kind: "checkpoint_proposal", turn, proposal: { checkpointId: proposal.checkpointId, archiveSha256: checkpoint.archiveSha256, evidenceSha256: checkpoint.evidenceSha256, inventorySha256: checkpoint.inventorySha256 } }));
        } else {
          validatedBoundary = true;
        }
      }
      if (signal.aborted) return this.finish(identity, { status: "interrupted", code: "WORKER_INTERRUPTED" });
      if (events.length === 0) return this.finish(identity, { status: "blocked", code: "CHECKPOINT_BOUNDARY_REQUIRED" });
      return this.finish(identity, { status: "completed", code: "WORKER_PROPOSALS_VALIDATED", events, artifact: this.artifact(request), ...(checkpoint ? { checkpoint } : {}) });
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
    const payload = bytes(step.archive);
    const archive = new TextEncoder().encode(canonicalJson({ formatVersion: "portable-checkpoint-v1", inventory: [...step.inventory], payloadBase64: base64(payload) }));
    const evidence = new TextEncoder().encode(canonicalJson(events));
    return CheckpointProposalSchema.parse({
      sessionId: request.sessionId, actionId: request.actionId, expectedVersion: request.expectedVersion, policyVersion: request.policyVersion, capabilityGrant: request.capabilityGrant, workspaceId: request.workspaceId,
      checkpointId: `${request.actionId}:checkpoint:${events.length}`, formatVersion: "portable-checkpoint-v1", inventory: [...step.inventory], archiveBase64: base64(archive), archiveSha256: await sha256(archive), evidenceSha256: await sha256(evidence), inventorySha256: await canonicalDigest(step.inventory),
    });
  }

  /** Explicit synthetic artifact fixture for the deterministic test worker only. */
  private artifact(request: WorkerRunRequest) {
    return {
      sessionId: request.sessionId, actionId: request.actionId, expectedVersion: request.expectedVersion, policyVersion: request.policyVersion, capabilityGrant: request.capabilityGrant, workspaceId: request.workspaceId, artifactId: `${request.actionId}:fake-artifact`,
      purpose: { kind: "focused" as const, statements: ["one focused napplet"] },
      surface: { hasBackend: false as const, hasSecondPurpose: false as const, serviceWorker: false as const, dynamicAuthority: false as const },
      dependencies: { appOwnedSignerOrRelay: false as const, privateNappletImport: false as const },
      capabilities: { declaredHard: ["storage"] as const, observedDomains: ["storage"] as const, optionalIntentPresenceRead: false, intentUsedThroughSdk: false },
      upstream: { scanner: { verdict: "pass" as const, checkId: "upstream:fake-scanner" }, conformance: { verdict: "pass" as const, checkId: "upstream:fake-conformance" } },
    };
  }

  private finish(identity: string, result: WorkerRunResult): WorkerRunResult {
    const parsed = WorkerRunResultSchema.parse(result);
    this.#terminal.set(identity, parsed);
    return parsed;
  }
}
