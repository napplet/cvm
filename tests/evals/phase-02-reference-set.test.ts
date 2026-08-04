import { afterEach, describe, expect, test } from "bun:test";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import { blockedModalProbeEvidence } from "../../src/worker-adapters/modal-worker";
import { PHASE_02_POLICY_INITIAL } from "../../src/policy/phase-02-policy";
import { WorkerRunResultSchema, type WorkerPort } from "../../src/phase-02/contracts";
import { createTrustedCore } from "../../src/phase-02/trusted-core";

type ReferenceCase = Readonly<{
  id: string;
  category: string;
  untrustedEnvelope: unknown;
  initialState: Readonly<{ version: number }>;
  policy: Readonly<{ policyVersion: string }>;
  grant: Readonly<Record<string, unknown>>;
  expected: Readonly<{
    code: string;
    stateDelta: number;
    allowedEffects: number;
    forbiddenEffects: number;
    requiredEvidence: readonly string[];
  }>;
}>;

const referenceSet = JSON.parse(readFileSync("tests/fixtures/phase-02-reference-set.json", "utf8")) as { version: number; cases: ReferenceCase[] };
const temporaryDirectories: string[] = [];
afterEach(() => { for (const directory of temporaryDirectories.splice(0)) rmSync(directory, { recursive: true, force: true }); });

function database(): string {
  const directory = mkdtempSync("/tmp/napplet-cvm-reference-");
  temporaryDirectories.push(directory);
  return join(directory, "sessions.sqlite");
}
function worker(mutate?: (request: Record<string, unknown>) => unknown): WorkerPort {
  return { async run(request) {
    const event = mutate?.(request) ?? { kind: "tool_proposal", turn: 1, request: toolCorrelation(request, { tool: "capture_evidence", label: "synthetic-canary" }) };
    return WorkerRunResultSchema.parse({ status: "completed", code: "WORKER_PROPOSALS_VALIDATED", events: [event], artifact: verifiedArtifact(request) });
  } };
}
function verifiedArtifact(request: Record<string, unknown>) {
  const { sessionId, actionId, expectedVersion, policyVersion, capabilityGrant, workspaceId } = request;
  return {
    sessionId, actionId, expectedVersion, policyVersion, capabilityGrant, workspaceId, artifactId: `${request.actionId}:artifact`,
    purpose: { kind: "focused", statements: ["one focused napplet"] },
    surface: { hasBackend: false, hasSecondPurpose: false, serviceWorker: false, dynamicAuthority: false },
    dependencies: { appOwnedSignerOrRelay: false, privateNappletImport: false },
    capabilities: { declaredHard: ["storage"], observedDomains: ["storage"], optionalIntentPresenceRead: false, intentUsedThroughSdk: false },
    upstream: { scanner: { verdict: "pass", checkId: "upstream:reference-scanner" }, conformance: { verdict: "pass", checkId: "upstream:reference-conformance" } },
  };
}
function toolCorrelation(request: Record<string, unknown>, tool: Record<string, unknown>) {
  const { sessionId, actionId, expectedVersion, policyVersion, capabilityGrant, workspaceId } = request;
  return { sessionId, actionId, expectedVersion, policyVersion, capabilityGrant, workspaceId, callId: "reference-call", evidenceId: "reference-evidence", ...tool };
}
function composition(path: string, implementation: WorkerPort, effects: { allowed: number }) {
  return createTrustedCore({ databasePath: path, worker: implementation, sessions: [{ sessionId: "reference-session", principalId: "principal:reference", version: 0 }], dispatcher: { dispatch: async () => { effects.allowed += 1; return { output: "synthetic" }; } }, artifactVerifier: { async verify(facts) { if (facts.result.status !== "completed") return undefined; const proposal = facts.result.artifact; return { artifact: { artifactId: proposal.artifactId, artifactSha256: "a".repeat(64), scannerReportSha256: "b".repeat(64), conformanceReportSha256: "c".repeat(64) }, contractInput: { purpose: proposal.purpose, surface: proposal.surface, dependencies: proposal.dependencies, capabilities: proposal.capabilities, upstream: proposal.upstream } }; } } });
}
function envelope(id: string, idea: string, overrides: Record<string, unknown> = {}) {
  return { principal: { id: "principal:reference" }, sessionId: "reference-session", actionId: `reference-action-${id}`, kind: "design", idempotencyKey: `reference-key-${id}`, expectedVersion: 0, policyVersion: PHASE_02_POLICY_INITIAL.policyVersion, idea, ...overrides };
}

describe("Phase 02 deterministic reference set", () => {
  test("contains exactly the complete 16-case security/state matrix", () => {
    expect(referenceSet.version).toBe(1);
    expect(referenceSet.cases).toHaveLength(16);
    expect(new Set(referenceSet.cases.map((item) => item.id)).size).toBe(16);
    expect(referenceSet.cases.map((item) => item.category)).toEqual([
      "accepted", "accepted", "accepted", "admission", "admission", "admission", "authority", "authority",
      "authority", "authority", "serialization", "serialization", "recovery", "recovery", "provider-boundary", "provider-boundary",
    ]);
  });

  test.each(referenceSet.cases)("$id has executable result, state, effect, and evidence oracles", (item) => {
    expect(item.id).toMatch(/^P02-R\d\d$/);
    expect(item.untrustedEnvelope).toBeDefined();
    expect(item.initialState.version).toBeGreaterThanOrEqual(0);
    expect(item.policy.policyVersion).toMatch(/^phase-02-policy-/);
    expect(item.grant).toBeDefined();
    expect(item.expected.code).toMatch(/^[A-Z0-9_]+$/);
    expect(item.expected.stateDelta).toBeGreaterThanOrEqual(0);
    expect(item.expected.allowedEffects).toBeGreaterThanOrEqual(0);
    expect(item.expected.forbiddenEffects).toBeGreaterThanOrEqual(0);
    expect(item.expected.requiredEvidence.length).toBeGreaterThan(0);
  });

  test.each(referenceSet.cases)("$id executes its deterministic oracle", async (item) => {
    if (item.category === "provider-boundary") {
      const provider = await blockedModalProbeEvidence();
      expect(provider.status).toBe("blocked");
      expect(provider.selection).toBe("unselected");
      expect(provider.reasonCode).toBe(item.expected.code);
      return;
    }
    const effects = { allowed: 0 };
    const path = database();
    const mutation = item.id === "P02-R07" ? (request: Record<string, unknown>) => ({ kind: "tool_proposal", turn: 1, request: toolCorrelation(request, { tool: "workspace_read", path: "src/canary" }) })
      : item.id === "P02-R08" ? (request: Record<string, unknown>) => ({ kind: "tool_proposal", turn: 1, request: toolCorrelation(request, { capabilityGrant: "expired-synthetic", tool: "capture_evidence", label: "synthetic" }) })
      : item.id === "P02-R09" ? (request: Record<string, unknown>) => ({ kind: "tool_proposal", turn: 1, request: toolCorrelation(request, { expectedVersion: 99, tool: "capture_evidence", label: "synthetic" }) })
      : item.id === "P02-R10" ? (request: Record<string, unknown>) => ({ kind: "tool_proposal", turn: 1, request: toolCorrelation(request, { tool: "workspace_write", path: "../../canary", content: "synthetic" }) })
      : item.id === "P02-R13" ? () => ({ kind: "tool_proposal", turn: 1, request: { tool: "capture_evidence" } })
      : item.id === "P02-R14" ? () => { throw new Error("synthetic worker termination uncertainty"); }
      : undefined;
    const current = composition(path, worker(mutation), effects);
    const idea = item.id === "P02-R04" ? "x".repeat(4_001) : item.id === "P02-R05" ? "\ud800" : (item.untrustedEnvelope as { idea?: string }).idea ?? "Create one focused reference napplet.";
    const request = envelope(item.id, idea);
    if (item.id === "P02-R11") {
      const first = await current.core.execute(request);
      const replay = await current.core.execute(request);
      expect(replay).toEqual(first);
      expect(first.code).toBe(item.expected.code);
    } else if (item.id === "P02-R12") {
      const [left, right] = await Promise.all([current.core.execute(request), current.core.execute(envelope(`${item.id}-other`, idea, { idempotencyKey: "reference-competing" }))]);
      expect([left.code, right.code].sort()).toEqual(["ACTION_COMMITTED", item.expected.code].sort());
    } else {
      const result = await current.core.execute(request);
      expect(result.code).toBe(item.expected.code);
    }
    expect(current.store.getSessionVersion("reference-session")).toBe(item.initialState.version + item.expected.stateDelta);
    expect(effects.allowed).toBe(item.expected.allowedEffects);
    expect(current.store.evidence.length).toBe(item.expected.stateDelta);
    current.close();
  });
});
