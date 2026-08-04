import { expect, test } from "bun:test";
import {
  CheckpointProposalSchema,
  ToolRequestSchema,
  WorkerEventSchema,
  WorkerRunRequestSchema,
  WorkerRunResultSchema,
  type WorkerPort,
  type WorkerRunRequest,
  type WorkerEvent,
  type WorkerRunResult,
} from "../../src/phase-02/contracts";
import { PHASE_02_POLICY_INITIAL } from "../../src/policy/phase-02-policy";

const binding = {
  sessionId: "session-a", actionId: "action-a", expectedVersion: 0,
  policyVersion: PHASE_02_POLICY_INITIAL.policyVersion, capabilityGrant: "grant-a", workspaceId: "workspace-a",
};

test("canonical WorkerPort schemas are strict and exclude durable authority", () => {
  const request: WorkerRunRequest = WorkerRunRequestSchema.parse({ ...binding, idea: "One focused applet." });
  expect(request.sessionId).toBe("session-a");
  expect(WorkerRunRequestSchema.safeParse({ ...binding, idea: "x", balance: 1 }).success).toBeFalse();
  expect(ToolRequestSchema.safeParse({ ...binding, tool: "workspace_write", callId: "c", evidenceId: "e", path: "src/a.ts", content: "x" }).success).toBeTrue();
  expect(ToolRequestSchema.safeParse({ ...binding, tool: "publish", callId: "c", evidenceId: "e" }).success).toBeFalse();
  expect(ToolRequestSchema.safeParse({ ...binding, tool: "workspace_write", callId: "c", evidenceId: "e", path: "a", content: "x", shell: "sh" }).success).toBeFalse();
  const event: WorkerEvent = WorkerEventSchema.parse({ kind: "progress", turn: 1, detail: "proposal prepared" });
  expect(event.kind).toBe("progress");
  const result: WorkerRunResult = WorkerRunResultSchema.parse({ status: "unavailable", code: "WORKER_UNAVAILABLE" });
  expect(result.code).toBe("WORKER_UNAVAILABLE");
  expect(CheckpointProposalSchema.safeParse({ ...binding, formatVersion: "portable-checkpoint-v1", inventory: ["src/App.tsx"], archiveBase64: "YQ==", archiveSha256: "a".repeat(64), evidenceSha256: "b".repeat(64) }).success).toBeTrue();
  expect(CheckpointProposalSchema.safeParse({ ...binding, formatVersion: "portable-checkpoint-v1", inventory: ["../secret"], archiveBase64: "YQ==", archiveSha256: "a".repeat(64), evidenceSha256: "b".repeat(64) }).success).toBeFalse();
  const port: WorkerPort = { async run() { return { status: "unavailable", code: "WORKER_UNAVAILABLE" }; } };
  expect(port).toBeDefined();
});
