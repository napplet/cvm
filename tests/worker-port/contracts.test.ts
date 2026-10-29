import { expect, test } from "bun:test";
import {
  CheckpointExportRequestSchema,
  CheckpointRestoreRequestSchema,
  CheckpointTerminationRequestSchema,
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
  if (!("kind" in event)) throw new Error("EXPECTED_WORKER_PROGRESS_EVENT");
  expect(event.kind).toBe("progress");
  const result: WorkerRunResult = WorkerRunResultSchema.parse({ status: "unavailable", code: "WORKER_UNAVAILABLE" });
  if (result.status !== "unavailable") throw new Error("EXPECTED_WORKER_UNAVAILABLE_RESULT");
  expect(result.code).toBe("WORKER_UNAVAILABLE");
  expect(WorkerRunResultSchema.safeParse({ status: "completed", code: "WORKER_PROPOSALS_VALIDATED", events: [] }).success).toBeFalse();
  expect(WorkerRunResultSchema.safeParse({ status: "completed", code: "WORKER_PROPOSALS_VALIDATED", events: Array.from({ length: PHASE_02_POLICY_INITIAL.action.maxTurns + 1 }, (_, index) => ({ kind: "progress", turn: index + 1, detail: "too many" })) }).success).toBeFalse();
  expect(WorkerRunResultSchema.safeParse({ status: "completed", code: "WORKER_PROPOSALS_VALIDATED", events: [{ kind: "progress", turn: 1, detail: "first" }, { kind: "progress", turn: 1, detail: "duplicate" }] }).success).toBeFalse();
  expect(CheckpointProposalSchema.safeParse({ ...binding, checkpointId: "checkpoint-a", formatVersion: "portable-checkpoint-v1", inventory: ["src/App.tsx"], archiveBase64: "YQ==", archiveSha256: "a".repeat(64), evidenceSha256: "b".repeat(64), inventorySha256: "c".repeat(64) }).success).toBeTrue();
  expect(CheckpointProposalSchema.safeParse({ ...binding, checkpointId: "checkpoint-a", formatVersion: "portable-checkpoint-v1", inventory: ["../secret"], archiveBase64: "YQ==", archiveSha256: "a".repeat(64), evidenceSha256: "b".repeat(64), inventorySha256: "c".repeat(64) }).success).toBeFalse();
  const port: WorkerPort = { async run() { return { status: "unavailable", code: "WORKER_UNAVAILABLE" }; } };
  expect(port).toBeDefined();
});

test("continuation lifecycle contracts are lease-bound and exclude coordinator authority", () => {
  const lease = {
    accountId: "account-a", ...binding, checkpointId: "checkpoint-a", pauseGeneration: 2,
    actionVersion: 3, workspaceLineage: "workspace-lineage-a", leaseToken: "lease-a",
  };
  expect(CheckpointExportRequestSchema.safeParse(lease).success).toBeTrue();
  expect(CheckpointRestoreRequestSchema.safeParse({ ...lease, leaseToken: "lease-b", resumeClaim: "claim-a", archive: new Uint8Array([1]), archiveSha256: "a".repeat(64) }).success).toBeTrue();
  expect(CheckpointTerminationRequestSchema.safeParse(lease).success).toBeTrue();
  expect(CheckpointExportRequestSchema.safeParse({ ...lease, balance: "100", keyReference: "key", compatibility: "worker-choice" }).success).toBeFalse();
  expect(CheckpointRestoreRequestSchema.safeParse({ ...lease, resumeClaim: "claim-a", archive: new Uint8Array([1]), archiveSha256: "a".repeat(64), objectCredential: "secret" }).success).toBeFalse();
});
