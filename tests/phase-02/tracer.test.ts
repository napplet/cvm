import { describe, expect, test } from "bun:test";
import { PHASE_02_POLICY_INITIAL } from "../../src/policy/phase-02-policy";
import {
  createPhase02Tracer,
  type ActionEnvelope,
  type WorkerPort,
  type WorkerRunRequest,
} from "../../src/phase-02/trusted-core";

const principal = { id: "principal:alice" };

function action(overrides: Partial<ActionEnvelope> = {}): ActionEnvelope {
  return {
    principal,
    sessionId: "session-0001",
    actionId: "action-0001",
    kind: "design",
    idempotencyKey: "request-0001",
    expectedVersion: 0,
    policyVersion: PHASE_02_POLICY_INITIAL.policyVersion,
    idea: "Create one focused counter napplet.",
    ...overrides,
  };
}

function successfulWorker(counter: { runs: number }): WorkerPort {
  return {
    async run(request: WorkerRunRequest) {
      counter.runs += 1;
      return {
        status: "proposed",
        toolRequests: [{
          tool: "write_workspace_file",
          sessionId: request.sessionId,
          actionId: request.actionId,
          expectedVersion: request.expectedVersion,
          policyVersion: request.policyVersion,
          capabilityGrant: request.capabilityGrant,
          workspaceId: request.workspaceId,
          path: "src/App.tsx",
          content: "export const App = () => <main>Counter</main>;\n",
        }],
        evidence: [{ type: "worker-proposal", detail: "one workspace edit" }],
      };
    },
  };
}

describe("phase 02 trusted-core tracer", () => {
  test("pins every Phase 2 ceiling in one immutable fixture", () => {
    expect(PHASE_02_POLICY_INITIAL).toEqual({
      policyVersion: "phase-02-policy-2026-08-04",
      admission: {
        maxCodePoints: 4_000,
        maxUtf8Bytes: 16 * 1024,
        maxGraphemes: 4_096,
        maxInputTokens: 2_000,
        maxLines: 64,
        maxCodePointsPerLine: 1_000,
      },
      tools: { maxPathCharacters: 300, maxWriteContentCharacters: 30_000 },
      action: { maxTurns: 16 },
      sandbox: {
        cpu: "1/2",
        memoryGiB: "1/2",
        lifetimeMinutes: 20,
        idleTimeoutMinutes: 2,
        execTimeoutSeconds: 30,
        maxOutputBytes: 1024 * 1024,
      },
    });
    expect(Object.isFrozen(PHASE_02_POLICY_INITIAL)).toBeTrue();
    expect(Object.isFrozen(PHASE_02_POLICY_INITIAL.admission)).toBeTrue();
    expect(() => {
      (PHASE_02_POLICY_INITIAL.admission as { maxCodePoints: number }).maxCodePoints = 1;
    }).toThrow();
  });

  test("admits one bounded action, mediates one scoped write, and commits canonical evidence", async () => {
    const counter = { runs: 0 };
    const tracer = createPhase02Tracer(successfulWorker(counter));

    const result = await tracer.core.execute(action());

    expect(result).toMatchObject({ status: "completed", code: "ACTION_COMMITTED", version: 1 });
    expect(result.evidenceDigest).toMatch(/^[a-f0-9]{64}$/);
    expect(counter.runs).toBe(1);
    expect(tracer.effects).toEqual([{ workspaceId: "workspace:session-0001", path: "src/App.tsx", content: "export const App = () => <main>Counter</main>;\n" }]);
    expect(tracer.store.getSessionVersion("session-0001")).toBe(1);
    expect(tracer.store.evidence).toHaveLength(1);
    expect(tracer.store.evidence[0]).toMatchObject({
      sessionId: "session-0001",
      actionId: "action-0001",
      version: 1,
      policyVersion: PHASE_02_POLICY_INITIAL.policyVersion,
      evidenceDigest: result.evidenceDigest,
    });
  });

  test("returns byte-equivalent exact replay without another worker, tool effect, evidence append, or version", async () => {
    const counter = { runs: 0 };
    const tracer = createPhase02Tracer(successfulWorker(counter));
    const first = await tracer.core.execute(action());
    const replay = await tracer.core.execute(action());

    expect(replay).toEqual(first);
    expect(JSON.stringify(replay)).toBe(JSON.stringify(first));
    expect(counter.runs).toBe(1);
    expect(tracer.effects).toHaveLength(1);
    expect(tracer.store.evidence).toHaveLength(1);
    expect(tracer.store.getSessionVersion("session-0001")).toBe(1);
  });

  test("fails closed for conflicting idempotency reuse and stale action versions", async () => {
    const counter = { runs: 0 };
    const tracer = createPhase02Tracer(successfulWorker(counter));
    await tracer.core.execute(action());

    const conflict = await tracer.core.execute(action({ idea: "Create a focused todo napplet." }));
    const stale = await tracer.core.execute(action({ actionId: "action-0002", idempotencyKey: "request-0002" }));

    expect(conflict).toMatchObject({ status: "denied", code: "IDEMPOTENCY_KEY_CONFLICT" });
    expect(stale).toMatchObject({ status: "denied", code: "STALE_SESSION_VERSION", currentVersion: 1 });
    expect(counter.runs).toBe(1);
    expect(tracer.effects).toHaveLength(1);
    expect(tracer.store.evidence).toHaveLength(1);
  });

  test.each([
    ["null", null],
    ["empty", action({ idea: "" })],
    ["non-canonical", action({ idea: "e\u0301" })],
    ["over limit", action({ idea: "x".repeat(4_001) })],
  ])("rejects %s admission before any billable or worker effect", async (_name, candidate) => {
    const counter = { runs: 0 };
    const tracer = createPhase02Tracer(successfulWorker(counter));
    const result = await tracer.core.execute(candidate);

    expect(result).toMatchObject({ status: "denied", code: "ADMISSION_DENIED" });
    expect(counter.runs).toBe(0);
    expect(tracer.effects).toHaveLength(0);
    expect(tracer.store.evidence).toHaveLength(0);
    expect(tracer.store.getSessionVersion("session-0001")).toBe(0);
  });

  test.each([
    ["unknown tool", (request: WorkerRunRequest) => ({ ...request, tool: "delete_workspace" })],
    ["extra field", (request: WorkerRunRequest) => ({ ...request, extra: true })],
    ["wrong session", (request: WorkerRunRequest) => ({ ...request, sessionId: "session-other" })],
    ["wrong action", (request: WorkerRunRequest) => ({ ...request, actionId: "action-other" })],
    ["wrong version", (request: WorkerRunRequest) => ({ ...request, expectedVersion: 99 })],
    ["wrong policy", (request: WorkerRunRequest) => ({ ...request, policyVersion: "other-policy" })],
    ["wrong workspace", (request: WorkerRunRequest) => ({ ...request, workspaceId: "workspace:other" })],
    ["wrong grant", (request: WorkerRunRequest) => ({ ...request, capabilityGrant: "not-the-grant" })],
  ])("records a stable no-effect authority denial for %s", async (_name, mutate) => {
    const counter = { runs: 0 };
    const worker: WorkerPort = {
      async run(request) {
        counter.runs += 1;
        const tool = mutate({
          tool: "write_workspace_file",
          sessionId: request.sessionId,
          actionId: request.actionId,
          expectedVersion: request.expectedVersion,
          policyVersion: request.policyVersion,
          capabilityGrant: request.capabilityGrant,
          workspaceId: request.workspaceId,
          path: "src/App.tsx",
          content: "export {};\n",
        });
        return { status: "proposed", toolRequests: [tool], evidence: [] };
      },
    };
    const tracer = createPhase02Tracer(worker);
    const result = await tracer.core.execute(action());

    expect(result).toMatchObject({ status: "denied", code: "TOOL_AUTHORIZATION_DENIED" });
    expect(counter.runs).toBe(1);
    expect(tracer.effects).toHaveLength(0);
    expect(tracer.store.getSessionVersion("session-0001")).toBe(0);
    expect(tracer.store.evidence).toHaveLength(1);
  });

  test("returns recoverable uncertainty without completing or mutating authoritative state", async () => {
    const worker: WorkerPort = { async run() { throw new Error("worker lost"); } };
    const tracer = createPhase02Tracer(worker);
    const controller = new AbortController();
    controller.abort("test abort");
    const result = await tracer.core.execute(action(), controller.signal);

    expect(result).toMatchObject({ status: "recoverable_failure", code: "WORKER_UNCERTAIN" });
    expect(tracer.effects).toHaveLength(0);
    expect(tracer.store.getSessionVersion("session-0001")).toBe(0);
    expect(tracer.store.evidence).toHaveLength(1);
  });
});
