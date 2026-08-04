import { describe, expect, test } from "bun:test";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { evaluatePhase04Design, validatePhase04DesignEvidence, writePhase04DesignEvidence } from "../../src/verification/phase-04-design-evidence";
import { comparePhase04Case, executePhase04ReferenceGate, observePhase04Case } from "./phase-04-runtime-observation";

const fixturePath = "tests/fixtures/phase-04-reference-set.json";

type ReferenceCase = Readonly<{
  id: string;
  category: string;
  requirements: readonly string[];
  decisions: readonly string[];
  threats: readonly string[];
  boundedInput: Record<string, unknown>;
  initialState: Record<string, unknown>;
  schedule: readonly string[];
  expected: Readonly<{ providerDispatches: number; providerLookups: number; workerCalls: number; receiptWrites: number; debitPostings: number; creditPostings: number; releases: number; actionState: string; sessionState: string; artifactVersion: number; evidence: string; providerSelection: "unselected"; status: string; nextAction: string; oracle: string }>;
  execution: Readonly<{ file: string; testName: string }>;
}>;

const requiredCategories = new Map([
  ["authority", 4], ["accounting", 4], ["serialization", 3], ["ambiguity", 3],
  ["artifact_repair", 3], ["adversarial", 2], ["owner_status", 1],
]);
const requiredRequirements = ["BILL-03", "BILL-04", "BILL-05", "SESS-01", "SESS-03", "SESS-04", "GEN-05", "GEN-06"];
const requiredDecisions = Array.from({ length: 20 }, (_, index) => `D-${index + 59}`);
const requiredThreats = ["T-04-ADAPTER", "T-04-AMBIGUITY", "T-04-ATOMIC", "T-04-AUTHORITY", "T-04-BLOCK", "T-04-DIAGNOSTIC", "T-04-DISCLOSE", "T-04-DOUBLE", "T-04-EFFECT", "T-04-EVIDENCE", "T-04-EVIDENCE-LEAK", "T-04-HISTORY-DOS", "T-04-HONESTY", "T-04-INJECTION", "T-04-INPUT", "T-04-MISMATCH", "T-04-NATIVE", "T-04-ORACLE", "T-04-PRICE", "T-04-QUARANTINE", "T-04-RACE", "T-04-READINESS", "T-04-REPAIR", "T-04-REPLAY", "T-04-RETRY", "T-04-SC", "T-04-STATUS-LEAK", "T-04-STATUS-OWNER"];
const requiredExpectedFields = ["providerDispatches", "providerLookups", "workerCalls", "receiptWrites", "debitPostings", "creditPostings", "releases", "actionState", "sessionState", "artifactVersion", "evidence", "providerSelection", "status", "nextAction", "oracle"];
const oracleFor = (expected: ReferenceCase["expected"]): string => [expected.providerDispatches, expected.providerLookups, expected.workerCalls, expected.receiptWrites, expected.debitPostings, expected.creditPostings, expected.releases, expected.actionState, expected.sessionState, expected.artifactVersion, expected.evidence, expected.providerSelection, expected.status, expected.nextAction].join("|");

export function validateReferenceSet(value: unknown): readonly ReferenceCase[] {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("Phase 04 reference set must be an object");
  const cases = (value as { cases?: unknown }).cases;
  if (!Array.isArray(cases) || cases.length !== 20) throw new Error("Phase 04 reference set must contain exactly twenty cases");
  const parsed = cases as ReferenceCase[];
  if (new Set(parsed.map((item) => item.id)).size !== 20) throw new Error("Phase 04 reference case IDs must be unique");
  for (const [category, count] of requiredCategories) if (parsed.filter((item) => item.category === category).length !== count) throw new Error(`Phase 04 category ${category} must contain ${count} cases`);
  for (const requirement of requiredRequirements) if (!parsed.some((item) => item.requirements.includes(requirement))) throw new Error(`Phase 04 requirement mapping is missing ${requirement}`);
  for (const decision of requiredDecisions) if (!parsed.some((item) => item.decisions.includes(decision))) throw new Error(`Phase 04 decision mapping is missing ${decision}`);
  for (const threat of requiredThreats) if (!parsed.some((item) => item.threats.includes(threat))) throw new Error(`Phase 04 threat mapping is missing ${threat}`);
  for (const item of parsed) {
    if (!item.id || !item.execution?.file || !item.execution.testName || !item.boundedInput || !item.initialState || !Array.isArray(item.schedule) || !item.requirements?.length || !item.decisions?.length || !item.threats?.length) throw new Error(`Phase 04 case ${item.id || "unknown"} is incomplete`);
    for (const field of requiredExpectedFields) if (!(field in item.expected)) throw new Error(`Phase 04 case ${item.id} lacks exact oracle field ${field}`);
    if (item.expected.providerSelection !== "unselected" || /(?:credential|preview|publish|live[_ -]?selected)/iu.test(JSON.stringify(item.expected))) throw new Error(`Phase 04 case ${item.id} overclaims provider or artifact readiness`);
    if (item.expected.oracle !== oracleFor(item.expected)) throw new Error(`Phase 04 case ${item.id} exact effect oracle changed`);
  }
  return Object.freeze(parsed.map((item) => Object.freeze(item)));
}

async function referenceSet(): Promise<readonly ReferenceCase[]> {
  return validateReferenceSet(JSON.parse(await readFile(fixturePath, "utf8")));
}

const digest = (character: string): string => character.repeat(64);
async function evidenceInput() {
  const cases = await referenceSet();
  const caseIds = cases.map((item) => item.id);
  return {
    identities: { referenceSet: fixturePath, meteredService: "src/phase-04/metered-generation-service.ts", gateway: "src/model/deterministic-model-gateway.ts", reconciliation: "src/model/reconciliation.ts", status: "src/phase-04/session-status.ts", adapter: "src/contextvm/adapter.ts" },
    checks: ["reference-set", "metered-authority", "reconciliation", "artifact-honesty", "owner-status", "contextvm-boundary"].map((id, index) => ({ id, severity: id === "reference-set" ? "critical" as const : "high" as const, status: "passed" as const, evidenceSha256: digest(String(index + 1)) })),
    caseComparisons: [],
    requirementMappings: Object.fromEntries(requiredRequirements.map((id) => [id, caseIds.filter((caseId, index) => cases[index]!.requirements.includes(id))])),
    decisionMappings: requiredDecisions,
    threatMappings: requiredThreats,
    observations: [
      { provider: "deterministic_gateway", status: "passed" as const, selection: "unselected" as const, evidenceSha256: digest("a"), limitations: ["fixture-only execution"] },
      { provider: "live_model", status: "not_observed" as const, selection: "unselected" as const, evidenceSha256: digest("b"), limitations: ["Phase 7 owns live provider selection and certification"] },
    ],
  };
}

describe("Phase 04 deterministic reference set", () => {
  test("observes all twenty registered runtime cases and requires child assertions", async () => {
    const gate = await executePhase04ReferenceGate(JSON.parse(await readFile(fixturePath, "utf8")));
    expect(gate.verdict).toBe("passed");
    expect(gate.comparisons).toHaveLength(20);
    expect(gate.comparisons.every((comparison) => comparison.status === "passed")).toBe(true);
    expect(gate.aggregateEffects).toEqual({ providerDispatches: 9, providerLookups: 3, workerCalls: 7, receiptWrites: 7, debitPostings: 9, creditPostings: 2, releases: 10 });
  }, 60_000);

  test("every runtime field rejects a recomputed fixture oracle", async () => {
    const fixture = JSON.parse(await readFile(fixturePath, "utf8")) as { cases: ReferenceCase[] };
    for (const field of requiredExpectedFields.filter((field) => field !== "oracle")) {
      const altered = structuredClone(fixture);
      const target = altered.cases.find((item) => item.id === "P04-ACCT-03");
      if (!target) throw new Error("missing funded-start reference case");
      const value = target.expected[field as keyof typeof target.expected];
      (target.expected as Record<string, unknown>)[field] = typeof value === "number" ? value + 1 : `${value}:wrong`;
      target.expected.oracle = oracleFor(target.expected);
      const gate = await executePhase04ReferenceGate(altered);
      expect(gate.verdict, field).toBe("blocked");
      expect(gate.comparisons.find((comparison) => comparison.id === target.id)?.mismatches).toContain(field);
    }
  }, 60_000);

  test("funded-start runtime observation derives P04-ACCT-03 from actual effects", async () => {
    const cases = await referenceSet();
    const fundedStart = cases.find((item) => item.id === "P04-ACCT-03");
    if (!fundedStart) throw new Error("missing funded-start reference case");

    const observation = await observePhase04Case({
      id: fundedStart.id,
      boundedInput: fundedStart.boundedInput,
      initialState: fundedStart.initialState,
      schedule: fundedStart.schedule,
    });

    expect(Object.keys(observation).sort()).toEqual([
      "actionState", "artifactVersion", "creditPostings", "debitPostings", "evidence",
      "nextAction", "providerDispatches", "providerLookups", "providerSelection", "receiptWrites",
      "releases", "sessionState", "status", "workerCalls",
    ]);
    expect(comparePhase04Case(fundedStart.id, fundedStart.expected, observation)).toMatchObject({ id: fundedStart.id, status: "passed", mismatches: [] });
  });

  test("recomputed wrong oracle still blocks funded-start evidence", async () => {
    const fixture = JSON.parse(await readFile(fixturePath, "utf8")) as { cases: ReferenceCase[] };
    const altered = structuredClone(fixture);
    const fundedStart = altered.cases.find((item) => item.id === "P04-ACCT-03");
    if (!fundedStart) throw new Error("missing funded-start reference case");
    fundedStart.expected.providerDispatches += 1;
    fundedStart.expected.oracle = oracleFor(fundedStart.expected);

    const gate = await executePhase04ReferenceGate(altered);
    expect(gate.verdict).toBe("blocked");
    expect(gate.comparisons).toContainEqual(expect.objectContaining({ id: "P04-ACCT-03", status: "failed", mismatches: expect.arrayContaining(["providerDispatches"]) }));
    expect(gate.aggregateEffects).toBeUndefined();
  });

  test("requires twenty complete, uniquely mapped actual-service cases", async () => {
    const cases = await referenceSet();
    expect(cases).toHaveLength(20);
  });

  test("executes each referenced deterministic authority oracle without provider credentials or network selection", async () => {
    for (const item of await referenceSet()) {
      const result = Bun.spawnSync(["bun", "test", item.execution.file, "--test-name-pattern", item.execution.testName], { cwd: process.cwd(), env: { ...process.env, PHASE_04_REFERENCE_GATE: "1" }, stdout: "pipe", stderr: "pipe" });
      expect(result.exitCode, `${item.id}: ${new TextDecoder().decode(result.stderr)}`).toBe(0);
    }
  }, 60_000);

  test("fails closed when an oracle mapping, status field, provider selection, or artifact readiness claim changes", async () => {
    const fixture = JSON.parse(await readFile(fixturePath, "utf8")) as { cases: ReferenceCase[] };
    const altered = structuredClone(fixture);
    altered.cases[0]!.expected.providerDispatches += 1;
    expect(() => validateReferenceSet(altered)).toThrow("exact effect oracle changed");
    expect(() => validateReferenceSet({ ...fixture, cases: fixture.cases.slice(1) })).toThrow("exactly twenty");
    expect(() => validateReferenceSet({ ...fixture, cases: fixture.cases.map((item, index) => index === 0 ? { ...item, expected: { ...item.expected, status: "preview_ready" } } : item) })).toThrow("overclaims");
    expect(() => validateReferenceSet({ ...fixture, cases: fixture.cases.map((item, index) => index === 0 ? { ...item, expected: { ...item.expected, providerSelection: "selected" } } : item) })).toThrow("overclaims");
    expect(() => validateReferenceSet({ ...fixture, cases: fixture.cases.map((item, index) => index === 0 ? { ...item, decisions: [] } : item) })).toThrow();
  });
});

describe("Phase 04 immutable design evidence", () => {
  test("blocks partial deterministic proof while live providers remain unselected", async () => {
    const decision = await evaluatePhase04Design(await evidenceInput());
    expect(decision.reasons).toContain("Phase 04 runtime comparison set is incomplete or mismatched");
    expect(decision.evidence).toMatchObject({ verdict: "blocked", offlineVerdict: "blocked" });
    expect(decision.evidence.observations).toEqual(expect.arrayContaining([expect.objectContaining({ provider: "deterministic_gateway", selection: "unselected" }), expect.objectContaining({ provider: "live_model", status: "not_observed", selection: "unselected" })]));
  });

  test("fails closed for incomplete evidence, disclosure, readiness claims, and immutable collisions", async () => {
    const input = await evidenceInput();
    await expect(evaluatePhase04Design({ ...input, caseComparisons: [{ id: "P04-ACCT-03", expected: (await observePhase04Case({ id: "P04-ACCT-03", boundedInput: {}, initialState: {}, schedule: [] })), observed: { ...(await observePhase04Case({ id: "P04-ACCT-03", boundedInput: {}, initialState: {}, schedule: [] })), providerDispatches: 2 } }] })).resolves.toMatchObject({ evidence: { verdict: "blocked" } });
    await expect(evaluatePhase04Design({ ...input, generatedSource: "forbidden" } as never)).resolves.toMatchObject({ evidence: { verdict: "blocked" } });
    await expect(evaluatePhase04Design({ ...input, observations: [{ ...input.observations[0]!, selection: "selected" as never }] })).resolves.toMatchObject({ evidence: { verdict: "blocked" } });
    const blocked = (await evaluatePhase04Design(input)).evidence;
    await expect(validatePhase04DesignEvidence({ ...blocked, evidenceSha256: digest("f") })).rejects.toThrow();
    const directory = await mkdtemp(join(process.env.TMPDIR ?? "/tmp", "napplet-phase-04-evidence-"));
    try {
      const first = await writePhase04DesignEvidence(directory, input);
      expect(await writePhase04DesignEvidence(directory, input)).toEqual(first);
      await writeFile(join(directory, `${first.evidenceSha256}.json`), "collision", "utf8");
      await expect(writePhase04DesignEvidence(directory, input)).rejects.toThrow("collision");
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });
});
