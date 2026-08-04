import { afterEach, describe, expect, test } from "bun:test";
import { mkdtempSync, readdirSync, readFileSync, rmSync, statSync } from "node:fs";
import { join } from "node:path";
import { PHASE_02_POLICY_INITIAL } from "../../src/policy/phase-02-policy";
import {
  ActionEnvelopeSchema,
  WorkerEventSchema,
  WorkerRunRequestSchema,
  WorkerRunResultSchema,
  type ActionEnvelope,
  type WorkerPort,
} from "../../src/phase-02/contracts";
import { createTrustedCore, type ArtifactVerifier, type TrustedCoreResult } from "../../src/phase-02/trusted-core";

const temporaryDirectories: string[] = [];
afterEach(() => { for (const directory of temporaryDirectories.splice(0)) rmSync(directory, { recursive: true, force: true }); });

const principal = { id: "principal:alice" };
function action(overrides: Partial<ActionEnvelope> = {}): ActionEnvelope {
  return {
    principal, sessionId: "session-0001", actionId: "action-0001", kind: "design", idempotencyKey: "request-0001", expectedVersion: 0,
    policyVersion: PHASE_02_POLICY_INITIAL.policyVersion, idea: "Create one focused counter napplet.", ...overrides,
  };
}
function temporaryDatabase(): string {
  const directory = mkdtempSync("/tmp/napplet-cvm-trusted-core-");
  temporaryDirectories.push(directory);
  return join(directory, "trusted-core.sqlite");
}
function verifiedArtifact(request: ReturnType<typeof WorkerRunRequestSchema.parse>) {
  return {
    sessionId: request.sessionId, actionId: request.actionId, expectedVersion: request.expectedVersion, policyVersion: request.policyVersion,
    capabilityGrant: request.capabilityGrant, workspaceId: request.workspaceId, artifactId: `${request.actionId}:artifact`,
    purpose: { kind: "focused", statements: ["one focused napplet"] },
    surface: { hasBackend: false, hasSecondPurpose: false, serviceWorker: false, dynamicAuthority: false },
    dependencies: { appOwnedSignerOrRelay: false, privateNappletImport: false },
    capabilities: { declaredHard: ["storage"], observedDomains: ["storage"], optionalIntentPresenceRead: false, intentUsedThroughSdk: false },
    upstream: { scanner: { verdict: "pass", checkId: "upstream:test-scanner" }, conformance: { verdict: "pass", checkId: "upstream:test-conformance" } },
  } as const;
}
function testArtifactVerifier(): ArtifactVerifier {
  return { async verify(facts) {
    if (facts.result.status !== "completed") return undefined;
    const proposal = facts.result.artifact;
    return {
      artifact: { artifactId: proposal.artifactId, artifactSha256: "a".repeat(64), scannerReportSha256: "b".repeat(64), conformanceReportSha256: "c".repeat(64) },
      contractInput: { purpose: proposal.purpose, surface: proposal.surface, dependencies: proposal.dependencies, capabilities: proposal.capabilities, upstream: proposal.upstream },
    };
  } };
}
function completingWorker(counter: { runs: number }, mutate?: (request: ReturnType<typeof WorkerRunRequestSchema.parse>) => unknown): WorkerPort {
  return {
    async run(request) {
      counter.runs += 1;
      const event = mutate?.(request) ?? {
        kind: "tool_proposal", turn: 1,
        request: { sessionId: request.sessionId, actionId: request.actionId, expectedVersion: request.expectedVersion, policyVersion: request.policyVersion,
          capabilityGrant: request.capabilityGrant, workspaceId: request.workspaceId, callId: "call-1", evidenceId: "evidence-1", tool: "capture_evidence", label: "worker-completed" },
      };
      return WorkerRunResultSchema.parse({ status: "completed", code: "WORKER_PROPOSALS_VALIDATED", events: [event], artifact: verifiedArtifact(request) });
    },
  };
}
function core(databasePath: string, worker: WorkerPort, effects: { calls: number }, now: () => number = Date.now) {
  return createTrustedCore({
    databasePath,
    worker,
    sessions: [{ sessionId: "session-0001", principalId: principal.id, version: 0 }],
    dispatcher: { dispatch: async () => { effects.calls += 1; return { output: "captured" }; } },
    artifactVerifier: testArtifactVerifier(),
    now,
  });
}

describe("phase 02 final trusted-core tracer", () => {
  test("requires an explicit durable database path for final reference composition", () => {
    expect(() => createTrustedCore({ worker: completingWorker({ runs: 0 }) } as never)).toThrow("databasePath");
  });

  test("pins every Phase 2 ceiling in one immutable fixture", () => {
    expect(PHASE_02_POLICY_INITIAL.policyVersion).toBe("phase-02-policy-2026-08-04");
    expect(Object.isFrozen(PHASE_02_POLICY_INITIAL)).toBeTrue();
    expect(Object.isFrozen(PHASE_02_POLICY_INITIAL.sandbox)).toBeTrue();
  });

  test("commits only after admission, restrictive risk, gateway, canonical worker parsing, and the Phase 1 artifact gate", async () => {
    const databasePath = temporaryDatabase();
    const runs = { runs: 0 }; const effects = { calls: 0 };
    const composition = core(databasePath, completingWorker(runs), effects);
    const result = await composition.core.execute(action());

    expect(result).toMatchObject({ status: "completed", code: "ACTION_COMMITTED", version: 1 });
    expect(result.evidenceDigest).toMatch(/^[a-f0-9]{64}$/);
    expect(result.artifactId).toBe("action-0001:artifact");
    expect(result.artifactDigest).toMatch(/^[a-f0-9]{64}$/);
    expect(runs.runs).toBe(1);
    expect(effects.calls).toBe(1);
    expect(composition.store.getSessionVersion("session-0001")).toBe(1);
    expect(composition.store.evidence[0]?.artifact).toMatchObject({ artifactId: "action-0001:artifact" });
    expect(composition.store.evidence).toHaveLength(1);
    composition.close();
  });

  test("preserves the durable committed version, result, and evidence identity across close/reopen exact replay", async () => {
    const databasePath = temporaryDatabase();
    const runs = { runs: 0 }; const effects = { calls: 0 };
    const first = core(databasePath, completingWorker(runs), effects);
    const committed = await first.core.execute(action());
    first.close();
    const reopened = core(databasePath, completingWorker(runs), effects);
    const replay = await reopened.core.execute(action());

    expect(replay).toEqual(committed);
    expect(runs.runs).toBe(1);
    expect(effects.calls).toBe(1);
    expect(reopened.store.getSessionVersion("session-0001")).toBe(1);
    expect(reopened.store.evidence).toHaveLength(1);
    reopened.close();
  });

  test("stops at hard admission before risk, store, worker, gateway, artifact gate, or allocation effects", async () => {
    const databasePath = temporaryDatabase();
    const runs = { runs: 0 }; const effects = { calls: 0 };
    const composition = core(databasePath, completingWorker(runs), effects);
    const result = await composition.core.execute(action({ idea: "x".repeat(4_001) }));

    expect(result).toMatchObject({ status: "denied", code: "ADMISSION_DENIED" });
    expect(runs.runs).toBe(0);
    expect(effects.calls).toBe(0);
    expect(composition.store.getSessionVersion("session-0001")).toBe(0);
    expect(composition.store.evidence).toEqual([]);
    composition.close();
  });

  test("risk denial cannot expand grants or reach the worker, gateway, artifact gate, or commit seam", async () => {
    const databasePath = temporaryDatabase();
    const runs = { runs: 0 }; const effects = { calls: 0 };
    const composition = createTrustedCore({ databasePath, worker: completingWorker(runs), sessions: [{ sessionId: "session-0001", principalId: principal.id, version: 0 }],
      riskDetector: { version: "risk-test", detect: () => [{ id: "PROMPT_INJECTION", severity: "high" }] }, dispatcher: { dispatch: async () => { effects.calls += 1; return {}; } }, artifactVerifier: testArtifactVerifier() });
    const result = await composition.core.execute(action());

    expect(result).toMatchObject({ status: "denied", code: "RISK_DENIED" });
    expect(runs.runs).toBe(0); expect(effects.calls).toBe(0);
    expect(composition.store.getSessionVersion("session-0001")).toBe(0);
    composition.close();
  });

  test("rejects a cross-principal session before allocating the worker or dispatching a tool", async () => {
    const databasePath = temporaryDatabase();
    const runs = { runs: 0 }; const effects = { calls: 0 };
    const composition = core(databasePath, completingWorker(runs), effects);

    const result = await composition.core.execute(action({ principal: { id: "principal:mallory" } }));

    expect(result).toMatchObject({ status: "denied", code: "SESSION_SCOPE_MISMATCH" });
    expect(runs.runs).toBe(0);
    expect(effects.calls).toBe(0);
    expect(composition.store.getSessionVersion("session-0001")).toBe(0);
    composition.close();
  });

  test("allows only one of two independently composed cores to reach effects for one durable version", async () => {
    const databasePath = temporaryDatabase();
    const effects = { calls: 0 }; let started = 0;
    const worker = (counter: { runs: number }): WorkerPort => ({ async run(request) {
      counter.runs += 1;
      started += 1;
      await new Promise((resolve) => setTimeout(resolve, 10));
      return WorkerRunResultSchema.parse({ status: "completed", code: "WORKER_PROPOSALS_VALIDATED", events: [{ kind: "tool_proposal", turn: 1, request: { sessionId: request.sessionId, actionId: request.actionId, expectedVersion: request.expectedVersion, policyVersion: request.policyVersion, capabilityGrant: request.capabilityGrant, workspaceId: request.workspaceId, callId: `${request.actionId}:call`, evidenceId: `${request.actionId}:evidence`, tool: "capture_evidence", label: "concurrent" } }], artifact: verifiedArtifact(request) });
    } });
    const leftRuns = { runs: 0 }; const rightRuns = { runs: 0 };
    const left = core(databasePath, worker(leftRuns), effects);
    const right = core(databasePath, worker(rightRuns), effects);
    const [first, second] = await Promise.all([
      left.core.execute(action()),
      right.core.execute(action({ actionId: "action-0002", idempotencyKey: "request-0002" })),
    ]);

    expect([first.code, second.code]).toContain("ACTION_COMMITTED");
    expect(effects.calls).toBe(1);
    expect(leftRuns.runs + rightRuns.runs).toBe(1);
    left.close(); right.close();
  });

  test("fences an expired lease holder before it can dispatch after a successor claims the version", async () => {
    const databasePath = temporaryDatabase();
    const effects = { calls: 0 };
    let releaseA!: () => void; let releaseB!: () => void;
    let startedA!: () => void; let startedB!: () => void;
    const aBlocked = new Promise<void>((resolve) => { releaseA = resolve; });
    const bBlocked = new Promise<void>((resolve) => { releaseB = resolve; });
    const aStarted = new Promise<void>((resolve) => { startedA = resolve; });
    const bStarted = new Promise<void>((resolve) => { startedB = resolve; });
    const waitingWorker = (wait: Promise<void>, started: () => void): WorkerPort => ({ async run(request) {
      started();
      await wait;
      return WorkerRunResultSchema.parse({ status: "completed", code: "WORKER_PROPOSALS_VALIDATED", events: [{ kind: "tool_proposal", turn: 1, request: { sessionId: request.sessionId, actionId: request.actionId, expectedVersion: request.expectedVersion, policyVersion: request.policyVersion, capabilityGrant: request.capabilityGrant, workspaceId: request.workspaceId, callId: `${request.actionId}:call`, evidenceId: `${request.actionId}:evidence`, tool: "capture_evidence", label: "lease-fence" } }], artifact: verifiedArtifact(request) });
    } });
    let aClockCalls = 0;
    // A claims at 0 but issues a grant through 31,000, so generic grant expiry
    // cannot hide the lost-lease race. B reclaims at 30,001 while A is stalled.
    const left = core(databasePath, waitingWorker(aBlocked, startedA), effects, () => aClockCalls++ === 0 ? 0 : 1_000);
    const right = core(databasePath, waitingWorker(bBlocked, startedB), effects, () => 30_001);
    const leftRun = left.core.execute(action());
    await aStarted;
    const rightRun = right.core.execute(action({ actionId: "action-0002", idempotencyKey: "request-0002" }));
    await bStarted;
    releaseA();
    const leftResult = await leftRun;
    releaseB();
    const rightResult = await rightRun;

    expect(leftResult.status).not.toBe("completed");
    expect(rightResult).toMatchObject({ status: "completed", code: "ACTION_COMMITTED" });
    expect(effects.calls).toBe(1);
    expect(left.store.getSessionVersion("session-0001")).toBe(1);
    left.close(); right.close();
  });

  test("ignores a forged fence marker and blocks a successor behind A's durable intent", async () => {
    const databasePath = temporaryDatabase();
    const effects = { calls: 0 }; const aRuns = { runs: 0 }; const bRuns = { runs: 0 };
    let rightRun!: Promise<TrustedCoreResult>;
    const acceptedRecipient = async () => {
      effects.calls += 1;
      return { output: "successor" };
    };
    const right = createTrustedCore({
      databasePath, worker: completingWorker(bRuns), sessions: [{ sessionId: "session-0001", principalId: principal.id, version: 0 }],
      dispatcher: { dispatch: acceptedRecipient }, artifactVerifier: testArtifactVerifier(), now: () => 30_001,
    });
    let aClockCalls = 0; let startedSuccessor = false;
    const left = createTrustedCore({
      databasePath, worker: completingWorker(aRuns), sessions: [{ sessionId: "session-0001", principalId: principal.id, version: 0 }],
      dispatcher: { dispatch: async (_request, context) => {
        if (!startedSuccessor) {
          startedSuccessor = true;
          rightRun = right.core.execute(action({ actionId: "action-0002", idempotencyKey: "request-0002" }));
          await rightRun;
        }
        effects.calls += 1;
        return { output: "stale", effectFenceAccepted: true };
      } },
      artifactVerifier: testArtifactVerifier(), now: () => aClockCalls++ === 0 ? 0 : 1_000,
    });
    const leftResult = await left.core.execute(action());
    const rightResult = await rightRun;

    expect(leftResult.status).not.toBe("completed");
    expect(rightResult.status).not.toBe("completed");
    expect(effects.calls).toBe(1);
    expect(left.store.getSessionVersion("session-0001")).toBe(0);
    left.close(); right.close();
  });

  test("does not redispatch an existing claimed intent when an exact retry reclaims an expired lease", async () => {
    const databasePath = temporaryDatabase();
    const effects = { calls: 0 }; const aRuns = { runs: 0 }; const bRuns = { runs: 0 };
    let releaseA!: () => void; let aDispatchStarted!: () => void;
    const aBlocked = new Promise<void>((resolve) => { releaseA = resolve; });
    const aStarted = new Promise<void>((resolve) => { aDispatchStarted = resolve; });
    let aClockCalls = 0;
    // A's worker lease starts at 0, while its durable effect intent is claimed
    // at 1,000. B reclaims the expired lease at 30,001 with the exact request.
    const left = createTrustedCore({
      databasePath, worker: completingWorker(aRuns), sessions: [{ sessionId: "session-0001", principalId: principal.id, version: 0 }],
      dispatcher: { dispatch: async () => {
        aDispatchStarted();
        await aBlocked;
        effects.calls += 1;
        return { output: "original recipient" };
      } },
      artifactVerifier: testArtifactVerifier(), now: () => aClockCalls++ === 0 ? 0 : 1_000,
    });
    const leftRun = left.core.execute(action());
    await aStarted;

    const right = createTrustedCore({
      databasePath, worker: completingWorker(bRuns), sessions: [{ sessionId: "session-0001", principalId: principal.id, version: 0 }],
      dispatcher: { dispatch: async () => { effects.calls += 1; return { output: "retry recipient" }; } },
      artifactVerifier: testArtifactVerifier(), now: () => 30_001,
    });
    const retry = await right.core.execute(action());
    expect(retry.status).not.toBe("completed");
    expect(effects.calls).toBe(0);

    releaseA();
    const original = await leftRun;
    expect(original.status).not.toBe("completed");
    expect(effects.calls).toBe(1);
    expect(left.store.getSessionVersion("session-0001")).toBe(0);
    left.close(); right.close();
  });

  test("blocks a fresh-call exact retry after a completed effect when the original final commit becomes stale", async () => {
    const databasePath = temporaryDatabase();
    const effects = { calls: 0 }; const aRuns = { runs: 0 }; const bRuns = { runs: 0 };
    let aClockCalls = 0;
    const left = createTrustedCore({
      databasePath, worker: completingWorker(aRuns), sessions: [{ sessionId: "session-0001", principalId: principal.id, version: 0 }],
      dispatcher: { dispatch: async () => { effects.calls += 1; return { output: "original recipient" }; } },
      artifactVerifier: testArtifactVerifier(),
      // call-1 is durably completed at 1,000; only the final lease fence is
      // stale at 30,001, so no action result is available to replay.
      now: () => ++aClockCalls === 1 ? 0 : aClockCalls >= 6 ? 30_001 : 1_000,
    });
    const original = await left.core.execute(action());
    expect(original.status).not.toBe("completed");
    expect(effects.calls).toBe(1);
    const callTwoWorker = completingWorker(bRuns, (request) => ({
      kind: "tool_proposal", turn: 1,
      request: { sessionId: request.sessionId, actionId: request.actionId, expectedVersion: request.expectedVersion, policyVersion: request.policyVersion,
        capabilityGrant: request.capabilityGrant, workspaceId: request.workspaceId, callId: "call-2", evidenceId: "evidence-2", tool: "capture_evidence", label: "exact-retry-new-call" },
    }));
    const right = createTrustedCore({
      databasePath, worker: callTwoWorker, sessions: [{ sessionId: "session-0001", principalId: principal.id, version: 0 }],
      dispatcher: { dispatch: async () => { effects.calls += 1; return { output: "retry recipient" }; } }, artifactVerifier: testArtifactVerifier(), now: () => 30_001,
    });
    const retry = await right.core.execute(action());

    expect(retry.status).not.toBe("completed");
    expect(effects.calls).toBe(1);
    expect(left.store.getSessionVersion("session-0001")).toBe(0);
    left.close(); right.close();
  });

  test("allows multiple completed tool calls within one unchanged execution attempt", async () => {
    const databasePath = temporaryDatabase();
    const effects = { calls: 0 }; const runs = { runs: 0 };
    const worker: WorkerPort = { async run(request) {
      runs.runs += 1;
      const tool = (callId: string, evidenceId: string, turn: number) => ({ kind: "tool_proposal" as const, turn,
        request: { sessionId: request.sessionId, actionId: request.actionId, expectedVersion: request.expectedVersion, policyVersion: request.policyVersion,
          capabilityGrant: request.capabilityGrant, workspaceId: request.workspaceId, callId, evidenceId, tool: "capture_evidence" as const, label: callId },
      });
      return WorkerRunResultSchema.parse({ status: "completed", code: "WORKER_PROPOSALS_VALIDATED", events: [tool("call-1", "evidence-1", 1), tool("call-2", "evidence-2", 2)], artifact: verifiedArtifact(request) });
    } };
    const composition = core(databasePath, worker, effects);
    const result = await composition.core.execute(action());

    expect(result).toMatchObject({ status: "completed", code: "ACTION_COMMITTED", version: 1 });
    expect(runs.runs).toBe(1);
    expect(effects.calls).toBe(2);
    composition.close();
  });

  test("retains an unknown effect intent after effect-then-throw so an exact retry cannot dispatch twice", async () => {
    const databasePath = temporaryDatabase();
    const effects = { calls: 0 }; const firstRuns = { runs: 0 }; const retryRuns = { runs: 0 };
    const first = createTrustedCore({
      databasePath, worker: completingWorker(firstRuns), sessions: [{ sessionId: "session-0001", principalId: principal.id, version: 0 }],
      dispatcher: { dispatch: async () => { effects.calls += 1; throw new Error("recipient outcome unknown after effect"); } }, artifactVerifier: testArtifactVerifier(),
    });
    const uncertain = await first.core.execute(action());
    first.close();
    const retry = core(databasePath, completingWorker(retryRuns), effects);
    const retried = await retry.core.execute(action());

    expect(uncertain.status).not.toBe("completed");
    expect(retried.status).not.toBe("completed");
    expect(effects.calls).toBe(1);
    expect(retry.store.getSessionVersion("session-0001")).toBe(0);
    retry.close();
  });

  test("fails closed on a worker-forged all-pass artifact before any effect or commit", async () => {
    const databasePath = temporaryDatabase(); const runs = { runs: 0 }; const effects = { calls: 0 };
    const composition = createTrustedCore({ databasePath, worker: completingWorker(runs), sessions: [{ sessionId: "session-0001", principalId: principal.id, version: 0 }], dispatcher: { dispatch: async () => { effects.calls += 1; return {}; } } });
    const result = await composition.core.execute(action());

    expect(result.status).not.toBe("completed");
    expect(effects.calls).toBe(0);
    expect(composition.store.getSessionVersion("session-0001")).toBe(0);
    composition.close();
  });

  test.each([
    ["malformed worker event", () => ({ kind: "tool_proposal", turn: 1, request: { tool: "unknown" } })],
    ["wrong worker correlation", (request: ReturnType<typeof WorkerRunRequestSchema.parse>) => ({ kind: "tool_proposal", turn: 1, request: { sessionId: "other", actionId: request.actionId, expectedVersion: request.expectedVersion, policyVersion: request.policyVersion, capabilityGrant: request.capabilityGrant, workspaceId: request.workspaceId, callId: "call-1", evidenceId: "evidence-1", tool: "capture_evidence", label: "bad" } })],
  ])("keeps prior state for %s", async (_name, mutate) => {
    const databasePath = temporaryDatabase(); const runs = { runs: 0 }; const effects = { calls: 0 };
    const composition = core(databasePath, completingWorker(runs, mutate), effects);
    const result = await composition.core.execute(action());
    expect(result.status).not.toBe("completed");
    expect(effects.calls).toBe(0);
    expect(composition.store.getSessionVersion("session-0001")).toBe(0);
    expect(composition.store.evidence).toEqual([]);
    composition.close();
  });

  test("rejects a seventeenth well-formed tool event before any dispatcher effect", async () => {
    const databasePath = temporaryDatabase(); const effects = { calls: 0 };
    const worker: WorkerPort = {
      async run(request) {
        return WorkerRunResultSchema.parse({
          status: "completed", code: "WORKER_PROPOSALS_VALIDATED",
          events: Array.from({ length: PHASE_02_POLICY_INITIAL.action.maxTurns + 1 }, (_, index) => ({
            kind: "tool_proposal", turn: index + 1,
            request: { sessionId: request.sessionId, actionId: request.actionId, expectedVersion: request.expectedVersion, policyVersion: request.policyVersion,
              capabilityGrant: request.capabilityGrant, workspaceId: request.workspaceId, callId: `call-${index}`, evidenceId: `evidence-${index}`, tool: "capture_evidence", label: `turn-${index}` },
          })), artifact: verifiedArtifact(request),
        });
      },
    };
    const composition = core(databasePath, worker, effects);
    const result = await composition.core.execute(action());
    expect(result).toMatchObject({ status: "recoverable_failure", code: "WORKER_UNCERTAIN" });
    expect(effects.calls).toBe(0);
    expect(composition.store.getSessionVersion("session-0001")).toBe(0);
    composition.close();
  });

  test("rejects progress-only completion without a correlated verified artifact", async () => {
    const databasePath = temporaryDatabase(); const effects = { calls: 0 };
    const worker: WorkerPort = { async run() {
      return WorkerRunResultSchema.parse({ status: "completed", code: "WORKER_PROPOSALS_VALIDATED", events: [{ kind: "progress", turn: 1, detail: "finished" }] });
    } };
    const composition = core(databasePath, worker, effects);
    const result = await composition.core.execute(action());
    expect(result).toMatchObject({ status: "recoverable_failure", code: "WORKER_UNCERTAIN" });
    expect(effects.calls).toBe(0);
    expect(composition.store.getSessionVersion("session-0001")).toBe(0);
    composition.close();
  });

  test("keeps prior state when the composed Phase 1 artifact contract blocks output", async () => {
    const databasePath = temporaryDatabase(); const runs = { runs: 0 }; const effects = { calls: 0 };
    const rejectingVerifier: ArtifactVerifier = { async verify(facts) {
      if (facts.result.status !== "completed") return undefined;
      return {
        artifact: { artifactId: facts.result.artifact.artifactId, artifactSha256: "a".repeat(64), scannerReportSha256: "b".repeat(64), conformanceReportSha256: "c".repeat(64) },
        contractInput: {
          purpose: { kind: "full-stack", statements: ["bad"] },
          surface: { hasBackend: true, hasSecondPurpose: false, serviceWorker: false, dynamicAuthority: false },
          dependencies: { appOwnedSignerOrRelay: false, privateNappletImport: false },
          capabilities: { declaredHard: [], observedDomains: [], optionalIntentPresenceRead: false, intentUsedThroughSdk: false },
          upstream: { scanner: { verdict: "pass", checkId: "upstream:scanner" }, conformance: { verdict: "pass", checkId: "upstream:conformance" } },
        },
      };
    } };
    const composition = createTrustedCore({ databasePath, worker: completingWorker(runs), sessions: [{ sessionId: "session-0001", principalId: principal.id, version: 0 }], dispatcher: { dispatch: async () => { effects.calls += 1; return {}; } }, artifactVerifier: rejectingVerifier });
    const result = await composition.core.execute(action());
    expect(result).toMatchObject({ status: "recoverable_failure", code: "ARTIFACT_CONTRACT_BLOCKED" });
    expect(composition.store.getSessionVersion("session-0001")).toBe(0);
    composition.close();
  });

  test("canonical worker boundary", () => {
    expect(WorkerRunRequestSchema.safeParse({ sessionId: "s", actionId: "a", expectedVersion: 0, policyVersion: "p", capabilityGrant: "g", workspaceId: "w", idea: "one" }).success).toBeTrue();
    expect(WorkerEventSchema.safeParse({ kind: "progress", turn: 1, detail: "ok" }).success).toBeTrue();
    expect(WorkerRunResultSchema.safeParse({ status: "completed", code: "WORKER_PROPOSALS_VALIDATED", events: [] }).success).toBeFalse();
    const source = readFileSync("src/phase-02/trusted-core.ts", "utf8");
    for (const name of ["WorkerPort", "WorkerRunRequestSchema", "WorkerEventSchema", "WorkerRunResultSchema"]) expect(source).toContain(name);
  });

  test("contract source authority", () => {
    const files = walk("src");
    expect(files).not.toContain("src/worker-port/contracts.ts");
    for (const file of files.filter((item) => item !== "src/phase-02/contracts.ts" && item.endsWith(".ts"))) {
      const source = readFileSync(file, "utf8").replace(/import[\s\S]*?from\s+[^;]+;\n/g, "");
      expect(source).not.toMatch(/^\s*(?:export\s+)?(?:interface|type|const)\s+(?:WorkerPort|WorkerRunRequestSchema|WorkerEventSchema|WorkerRunResultSchema)\b/m);
    }
  });
});

function walk(directory: string): string[] {
  return readdirSync(directory).flatMap((entry) => {
    const path = join(directory, entry);
    return statSync(path).isDirectory() ? walk(path) : [path];
  });
}
