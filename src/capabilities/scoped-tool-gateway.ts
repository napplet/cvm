import { canonicalJson } from "../promotion/schema";
import {
  ToolRequestSchema,
  ToolResultSchema,
  type ToolRequest,
  type ToolResult,
} from "../phase-02/contracts";
import { PHASE_02_POLICY_INITIAL } from "../policy/phase-02-policy";

export type CapabilityGrant = Readonly<{
  id: string;
  sessionId: string;
  actionId: string;
  expectedVersion: number;
  policyVersion: string;
  workspaceId: string;
  workspaceRoot: string;
  tools: readonly ToolRequest["tool"][];
  expiresAtMs: number;
}>;

type GrantState = { grant: CapabilityGrant; revoked: boolean; terminal: boolean };
export type ToolDecisionEvidence = Readonly<{
  callId?: string;
  evidenceId?: string;
  sessionId?: string;
  actionId?: string;
  code: string;
  allowed: boolean;
}>;
export const APPROVED_COMMANDS = Object.freeze({
  format_workspace: Object.freeze(["pnpm", "exec", "prettier", "--write", "."]),
  verify_workspace: Object.freeze(["pnpm", "verify"]),
} as const);

export type FencedEffectAcceptance = Readonly<{
  /** Opaque coordinator authority: only a trusted recipient can spend it. */
  accept: (effect: () => { output?: unknown }) => Promise<Readonly<{ output?: unknown; effectFenceAccepted: true }> | undefined>;
}>;
export type ToolDispatchContext = Readonly<{ workspacePath?: string; argv?: readonly string[]; effectFence?: FencedEffectAcceptance }>;
export type ToolDispatchResult = Readonly<{ output?: unknown; effectFenceAccepted?: true }>;
export interface ToolDispatcher {
  dispatch(request: ToolRequest, context: ToolDispatchContext): Promise<ToolDispatchResult> | ToolDispatchResult;
}

export class GrantRegistry {
  #grants = new Map<string, GrantState>();

  issue(grant: CapabilityGrant): void {
    if (!grant.id || this.#grants.has(grant.id)) throw new Error("grant identity must be unique");
    this.#grants.set(grant.id, { grant: Object.freeze({ ...grant, tools: Object.freeze([...grant.tools]) }), revoked: false, terminal: false });
  }
  get(id: string): GrantState | undefined { return this.#grants.get(id); }
  revoke(id: string): void { const item = this.#grants.get(id); if (item) item.revoked = true; }
  terminal(id: string): void { const item = this.#grants.get(id); if (item) item.terminal = true; }
}

function asRecord(value: unknown): Record<string, unknown> | undefined {
  return value !== null && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : undefined;
}

async function fingerprint(value: unknown): Promise<string> {
  const bytes = new TextEncoder().encode(canonicalJson(value));
  const digest = await crypto.subtle.digest("SHA-256", bytes);
  return Array.from(new Uint8Array(digest), (item) => item.toString(16).padStart(2, "0")).join("");
}

function pathFor(root: string, path: string): string | undefined {
  if (!path || path.length > PHASE_02_POLICY_INITIAL.tools.maxPathCharacters || path.includes("\0") || path.startsWith("/")) return undefined;
  const parts = path.split("/");
  if (parts.some((part) => part === "" || part === "." || part === "..")) return undefined;
  const normalizedRoot = root.replace(/\/+$/u, "");
  return `${normalizedRoot}/${parts.join("/")}`;
}

/** Coordinator-owned complete-mediation gateway for all worker tool effects. */
export class ScopedToolGateway {
  #records = new Map<string, { fingerprint: string; result: ToolResult }>();
  #evidence: ToolDecisionEvidence[] = [];
  #now: () => number;

  constructor(private readonly grants: GrantRegistry, private readonly dispatcher: ToolDispatcher, options: { now?: () => number; effectFence?: FencedEffectAcceptance } = {}) {
    this.#now = options.now ?? Date.now;
    this.#effectFence = options.effectFence;
  }
  #effectFence?: FencedEffectAcceptance;

  get evidence(): readonly ToolDecisionEvidence[] { return Object.freeze(this.#evidence.map((item) => Object.freeze({ ...item }))); }

  async authorizeAndDispatch(input: unknown): Promise<ToolResult> {
    const raw = asRecord(input);
    const parsed = ToolRequestSchema.safeParse(input);
    if (!parsed.success) {
      const code = typeof raw?.tool === "string" && !["workspace_read", "workspace_write", "approved_command", "capture_evidence", "export_checkpoint"].includes(raw.tool)
        ? "TOOL_UNKNOWN" : typeof raw?.path === "string" && pathFor("/scope", raw.path) === undefined ? "TOOL_PATH_ESCAPE" : "TOOL_REQUEST_INVALID";
      return this.deny(code, raw);
    }
    const request = parsed.data;
    const requestFingerprint = await fingerprint(request);
    const prior = this.#records.get(request.callId);
    if (prior) {
      if (prior.fingerprint === requestFingerprint) {
        this.record(prior.result.code, prior.result.status === "allowed", request);
        return prior.result;
      }
      return this.deny("TOOL_REQUEST_CONFLICT", request);
    }
    const state = this.grants.get(request.capabilityGrant);
    if (!state) return this.deny("TOOL_GRANT_MISSING", request);
    if (state.terminal) return this.deny("TOOL_GRANT_TERMINAL", request);
    if (state.revoked) return this.deny("TOOL_GRANT_REVOKED", request);
    if (this.#now() > state.grant.expiresAtMs) return this.deny("TOOL_GRANT_EXPIRED", request);
    const grant = state.grant;
    if (request.sessionId !== grant.sessionId) return this.deny("TOOL_SESSION_MISMATCH", request);
    if (request.actionId !== grant.actionId) return this.deny("TOOL_ACTION_MISMATCH", request);
    if (request.expectedVersion !== grant.expectedVersion) return this.deny("TOOL_STALE_VERSION", request);
    if (request.policyVersion !== grant.policyVersion) return this.deny("TOOL_POLICY_MISMATCH", request);
    if (request.workspaceId !== grant.workspaceId) return this.deny("TOOL_WORKSPACE_MISMATCH", request);
    if (!grant.tools.includes(request.tool)) return this.deny("TOOL_NOT_GRANTED", request);

    const workspacePath = "path" in request ? pathFor(grant.workspaceRoot, request.path) : undefined;
    if ("path" in request && workspacePath === undefined) return this.deny("TOOL_PATH_ESCAPE", request);
    const argv = request.tool === "approved_command" ? APPROVED_COMMANDS[request.commandId] : undefined;
    try {
      const effect = await this.dispatcher.dispatch(request, Object.freeze({ workspacePath, argv, ...(this.#effectFence ? { effectFence: this.#effectFence } : {}) }));
      if (this.#effectFence && effect.effectFenceAccepted !== true) throw new Error("recipient did not accept the fenced effect");
      const result = Object.freeze(ToolResultSchema.parse({ status: "allowed", code: "TOOL_ALLOWED", callId: request.callId, evidenceId: request.evidenceId, output: effect.output }));
      this.#records.set(request.callId, { fingerprint: requestFingerprint, result });
      this.record(result.code, true, request);
      return result;
    } catch {
      return this.deny("TOOL_DISPATCH_FAILED", request);
    }
  }

  private deny(code: string, input: Record<string, unknown> | ToolRequest): ToolResult {
    const callId = typeof input.callId === "string" ? input.callId : undefined;
    const evidenceId = typeof input.evidenceId === "string" ? input.evidenceId : undefined;
    const result = Object.freeze(ToolResultSchema.parse({ status: "denied", code, ...(callId ? { callId } : {}), ...(evidenceId ? { evidenceId } : {}) }));
    this.record(code, false, input);
    return result;
  }

  private record(code: string, allowed: boolean, input: Record<string, unknown> | ToolRequest): void {
    this.#evidence.push(Object.freeze({
      code, allowed,
      ...(typeof input.callId === "string" ? { callId: input.callId } : {}),
      ...(typeof input.evidenceId === "string" ? { evidenceId: input.evidenceId } : {}),
      ...(typeof input.sessionId === "string" ? { sessionId: input.sessionId } : {}),
      ...(typeof input.actionId === "string" ? { actionId: input.actionId } : {}),
    }));
  }
}
