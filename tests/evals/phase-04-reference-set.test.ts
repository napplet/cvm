import { describe, expect, test } from "bun:test";
import { readFile } from "node:fs/promises";

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

describe("Phase 04 deterministic reference set", () => {
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
