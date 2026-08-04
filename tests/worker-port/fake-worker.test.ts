import { describe, expect, test } from "bun:test";
import { GrantRegistry, ScopedToolGateway, type CapabilityGrant } from "../../src/capabilities/scoped-tool-gateway";
import { PHASE_02_POLICY_INITIAL } from "../../src/policy/phase-02-policy";
import { DeterministicFakeWorker, FakeWorkspaceHarness, validateCheckpointProposal } from "../../src/worker-port/fake-worker";

function binding(sessionId = "session-a", workspaceId = `workspace-${sessionId}`) {
  return { sessionId, actionId: `action-${sessionId}`, expectedVersion: 0, policyVersion: PHASE_02_POLICY_INITIAL.policyVersion, capabilityGrant: `grant-${sessionId}`, workspaceId, idea: "Create one focused applet." };
}

function setup(sessionId = "session-a") {
  const request = binding(sessionId);
  const workspace = new FakeWorkspaceHarness({ workspaceId: request.workspaceId, root: `/isolated/${sessionId}`, files: { "canary.txt": `own-${sessionId}` } });
  const grant: CapabilityGrant = { id: request.capabilityGrant, sessionId: request.sessionId, actionId: request.actionId, expectedVersion: request.expectedVersion, policyVersion: request.policyVersion, workspaceId: request.workspaceId, workspaceRoot: workspace.root, tools: ["workspace_read", "workspace_write", "capture_evidence", "export_checkpoint"], expiresAtMs: 10_000 };
  const registry = new GrantRegistry(); registry.issue(grant);
  const gateway = new ScopedToolGateway(registry, workspace.dispatcher, { now: () => 1 });
  return { request, workspace, gateway };
}

describe("DeterministicFakeWorker", () => {
  test("returns unavailable for no assignment without tool effects", async () => {
    const { request, gateway } = setup();
    const worker = new DeterministicFakeWorker({ assigned: false, gateway });
    expect(await worker.run(request, new AbortController().signal)).toEqual({ status: "unavailable", code: "WORKER_UNAVAILABLE" });
    expect(gateway.evidence).toHaveLength(0);
  });

  test("uses only its own workspace through the gateway and exposes no ambient credentials or network", async () => {
    const { request, workspace, gateway } = setup();
    const sibling = new FakeWorkspaceHarness({ workspaceId: "workspace-b", root: "/isolated/session-b", files: { "canary.txt": "sibling" } });
    const worker = new DeterministicFakeWorker({ gateway, workspace, script: [{ kind: "read", path: "canary.txt" }, { kind: "write", path: "src/App.tsx", content: "export {};" }] });
    const result = await worker.run(request, new AbortController().signal);

    expect(result).toMatchObject({ status: "completed", code: "WORKER_PROPOSALS_VALIDATED" });
    expect(workspace.read("canary.txt")).toBe("own-session-a");
    expect(workspace.read("src/App.tsx")).toBe("export {};");
    expect(sibling.read("canary.txt")).toBe("sibling");
    expect(workspace.read("../session-b/canary.txt")).toBeUndefined();
    expect("credentials" in worker).toBeFalse();
    expect("network" in worker).toBeFalse();
    expect(gateway.evidence.filter((item) => item.allowed)).toHaveLength(2);
  });

  test("returns one typed interruption and fences late repeat runs", async () => {
    const { request, gateway } = setup();
    const controller = new AbortController(); controller.abort();
    const worker = new DeterministicFakeWorker({ gateway });
    expect(await worker.run(request, controller.signal)).toEqual({ status: "interrupted", code: "WORKER_INTERRUPTED" });
    expect(await worker.run(request, new AbortController().signal)).toEqual({ status: "blocked", code: "WORKER_STALE_EVENT" });
    expect(gateway.evidence).toHaveLength(0);
  });

  test("caps at the policy turn ceiling before any seventeenth effect", async () => {
    const { request, gateway } = setup();
    const script = Array.from({ length: PHASE_02_POLICY_INITIAL.action.maxTurns + 1 }, (_, index) => ({ kind: "capture" as const, label: `turn-${index}` }));
    const worker = new DeterministicFakeWorker({ gateway, script });
    expect(await worker.run(request, new AbortController().signal)).toEqual({ status: "limited", code: "WORKER_TURN_LIMIT" });
    expect(gateway.evidence.filter((item) => item.allowed)).toHaveLength(PHASE_02_POLICY_INITIAL.action.maxTurns);
  });

  test("emits a portable hash-bound checkpoint only after an allowed action boundary", async () => {
    const { request, gateway } = setup();
    const early = new DeterministicFakeWorker({ gateway, script: [{ kind: "checkpoint", archive: "archive", inventory: ["src/App.tsx"] }] });
    expect(await early.run(request, new AbortController().signal)).toEqual({ status: "blocked", code: "CHECKPOINT_BOUNDARY_REQUIRED" });

    const { request: validRequest, gateway: validGateway } = setup("session-checkpoint");
    const worker = new DeterministicFakeWorker({ gateway: validGateway, script: [{ kind: "write", path: "src/App.tsx", content: "export {};" }, { kind: "checkpoint", archive: "archive", inventory: ["src/App.tsx"] }] });
    const result = await worker.run(validRequest, new AbortController().signal);
    expect(result).toMatchObject({ status: "completed", checkpoint: { sessionId: validRequest.sessionId, actionId: validRequest.actionId, workspaceId: validRequest.workspaceId, formatVersion: "portable-checkpoint-v1" } });
    if (result.status === "completed") {
      expect(result.checkpoint?.archiveSha256).toMatch(/^[a-f0-9]{64}$/);
      expect(await validateCheckpointProposal(result.checkpoint, validRequest)).toEqual(result.checkpoint);
      expect(await validateCheckpointProposal({ ...result.checkpoint!, sessionId: "session-other" }, validRequest)).toBeUndefined();
      expect(await validateCheckpointProposal({ ...result.checkpoint!, archiveBase64: "dGFtcGVyZWQ=" }, validRequest)).toBeUndefined();
    }
  });

  test("keeps concurrent adjacent sessions and equal turn scripts isolated", async () => {
    const left = setup("session-a");
    const right = setup("session-a-1");
    const leftWorker = new DeterministicFakeWorker({ gateway: left.gateway, workspace: left.workspace, script: [{ kind: "write", path: "out.txt", content: "left" }] });
    const rightWorker = new DeterministicFakeWorker({ gateway: right.gateway, workspace: right.workspace, script: [{ kind: "write", path: "out.txt", content: "right" }] });
    const [leftResult, rightResult] = await Promise.all([
      leftWorker.run(left.request, new AbortController().signal),
      rightWorker.run(right.request, new AbortController().signal),
    ]);
    expect(leftResult.status).toBe("completed");
    expect(rightResult.status).toBe("completed");
    expect(left.workspace.read("out.txt")).toBe("left");
    expect(right.workspace.read("out.txt")).toBe("right");
    expect(left.workspace.read("../session-a-1/out.txt")).toBeUndefined();
  });
});
