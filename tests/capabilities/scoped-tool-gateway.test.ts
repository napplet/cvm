import { describe, expect, test } from "bun:test";
import {
  CapabilityGrant,
  GrantRegistry,
  ScopedToolGateway,
  type ToolDispatcher,
} from "../../src/capabilities/scoped-tool-gateway";
import { PHASE_02_POLICY_INITIAL } from "../../src/policy/phase-02-policy";

const now = { value: 1_000 };
const baseGrant: CapabilityGrant = {
  id: "grant-1",
  sessionId: "session-a",
  actionId: "action-a",
  expectedVersion: 3,
  policyVersion: PHASE_02_POLICY_INITIAL.policyVersion,
  workspaceId: "workspace-a",
  workspaceRoot: "/isolated/session-a",
  tools: ["workspace_read", "workspace_write", "approved_command", "capture_evidence", "export_checkpoint"],
  expiresAtMs: 2_000,
};

function request(overrides: Record<string, unknown> = {}) {
  return {
    tool: "workspace_write",
    callId: "call-1",
    evidenceId: "evidence-1",
    sessionId: baseGrant.sessionId,
    actionId: baseGrant.actionId,
    expectedVersion: baseGrant.expectedVersion,
    policyVersion: baseGrant.policyVersion,
    capabilityGrant: baseGrant.id,
    workspaceId: baseGrant.workspaceId,
    path: "src/App.tsx",
    content: "export {};\n",
    ...overrides,
  };
}

function createGateway() {
  const registry = new GrantRegistry();
  registry.issue(baseGrant);
  const calls: unknown[] = [];
  const dispatcher: ToolDispatcher = {
    async dispatch(tool, context) {
      calls.push({ tool, context });
      return { output: "ok" };
    },
  };
  return { gateway: new ScopedToolGateway(registry, dispatcher, { now: () => now.value }), registry, calls };
}

describe("ScopedToolGateway", () => {
  test("rejects non-object untrusted tool inputs without throwing or dispatching", async () => {
    const {gateway,calls}=createGateway();
    for(const input of [undefined,null,false,42,"workspace_write",[]]) {
      await expect(gateway.authorizeAndDispatch(input)).resolves.toEqual({status:"denied",code:"TOOL_REQUEST_INVALID"});
    }
    expect(calls).toHaveLength(0);
    expect(gateway.evidence).toHaveLength(6);
    expect(gateway.evidence.every(item=>item.code==="TOOL_REQUEST_INVALID"&&!item.allowed)).toBeTrue();
  });

  test("mediates a strict request and replays an exact duplicate without a second effect", async () => {
    const { gateway, calls } = createGateway();
    const first = await gateway.authorizeAndDispatch(request());
    const replay = await gateway.authorizeAndDispatch(request());

    expect(first).toMatchObject({ status: "allowed", code: "TOOL_ALLOWED", callId: "call-1" });
    expect(replay).toEqual(first);
    expect(calls).toHaveLength(1);
    expect(gateway.evidence).toHaveLength(2);
  });

  test.each([
    ["unknown tool", { tool: "publish" }],
    ["unknown field", { ambientAuthority: true }],
    ["missing grant", { capabilityGrant: "missing" }],
    ["wrong session", { sessionId: "session-b" }],
    ["wrong action", { actionId: "action-b" }],
    ["stale version", { expectedVersion: 2 }],
    ["wrong policy", { policyVersion: "other" }],
    ["wrong workspace", { workspaceId: "workspace-b" }],
    ["path escape", { path: "../sibling/secret" }],
    ["oversize path", { path: "x".repeat(PHASE_02_POLICY_INITIAL.tools.maxPathCharacters + 1) }],
    ["oversize content", { content: "x".repeat(PHASE_02_POLICY_INITIAL.tools.maxWriteContentCharacters + 1) }],
  ])("denies %s before the dispatcher runs", async (_name, mutation) => {
    const { gateway, calls } = createGateway();
    const result = await gateway.authorizeAndDispatch(request(mutation));
    expect(result.status).toBe("denied");
    expect(calls).toHaveLength(0);
    expect(gateway.evidence).toHaveLength(1);
  });

  test("denies expiry, revocation, terminal grants, and conflicting call reuse with zero new effects", async () => {
    const expiry = createGateway();
    now.value = 2_001;
    expect(await expiry.gateway.authorizeAndDispatch(request())).toMatchObject({ code: "TOOL_GRANT_EXPIRED" });
    expect(expiry.calls).toHaveLength(0);

    now.value = 1_000;
    const revoked = createGateway();
    revoked.registry.revoke(baseGrant.id);
    expect(await revoked.gateway.authorizeAndDispatch(request())).toMatchObject({ code: "TOOL_GRANT_REVOKED" });
    revoked.registry.terminal(baseGrant.id);
    expect(await revoked.gateway.authorizeAndDispatch(request({ callId: "call-2", evidenceId: "evidence-2" }))).toMatchObject({ code: "TOOL_GRANT_TERMINAL" });
    expect(revoked.calls).toHaveLength(0);

    const duplicate = createGateway();
    await duplicate.gateway.authorizeAndDispatch(request());
    expect(await duplicate.gateway.authorizeAndDispatch(request({ content: "changed" }))).toMatchObject({ code: "TOOL_REQUEST_CONFLICT" });
    expect(duplicate.calls).toHaveLength(1);
  });
});
