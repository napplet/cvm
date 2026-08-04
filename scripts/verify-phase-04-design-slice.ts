import { readFile, writeFile } from "node:fs/promises";
import { canonicalJson } from "../src/promotion/schema";
import { validatePhase04DesignEvidence, writePhase04DesignEvidence, type Phase04Check, type Phase04DesignInput } from "../src/verification/phase-04-design-evidence";
import { executePhase04ReferenceGate } from "../tests/evals/phase-04-runtime-observation";

const digest = async (value: string): Promise<string> => {
  const result = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(value));
  return Array.from(new Uint8Array(result), (byte) => byte.toString(16).padStart(2, "0")).join("");
};
const digestPaths = async (paths: readonly string[]): Promise<string> => digest((await Promise.all(paths.map(async (path) => `${path}\n${await Bun.file(path).text()}`))).join("\n"));
const run = (paths: readonly string[]) => {
  const result = Bun.spawnSync(["bun", "test", ...paths, "--timeout", "10000"], { stdout: "inherit", stderr: "inherit" });
  if (result.exitCode !== 0) throw new Error(`Phase 04 deterministic command failed: ${paths.join(" ")}`);
};
const checkPaths = {
  "metered-authority": ["tests/billing/price-card.test.ts", "tests/billing/operation-finalization.test.ts", "tests/phase-04/tracer.test.ts", "src/phase-04/metered-generation-service.ts", "src/model/price-card.ts"],
  reconciliation: ["tests/model/reconciliation.test.ts", "src/model/deterministic-model-gateway.ts", "src/model/reconciliation.ts"],
  "artifact-honesty": ["tests/phase-04/artifact-outcome.test.ts", "tests/phase-04/repair.test.ts", "src/phase-04/napplet-harness.ts", "src/phase-04/repair-policy.ts"],
  "owner-status": ["tests/billing/line-items.test.ts", "tests/phase-04/session-status.test.ts", "src/phase-04/session-status.ts"],
  "contextvm-boundary": ["tests/contextvm/adapter.test.ts", "src/contextvm/adapter.ts"],
  "reference-set": ["tests/evals/phase-04-reference-set.test.ts", "tests/fixtures/phase-04-reference-set.json"],
} as const;

export async function runPhase04DesignGate(options: Readonly<{ fixturePath?: string; evidenceDirectory?: string; pointerPath?: string; runSuites?: boolean }> = {}) {
  const fixturePath = options.fixturePath ?? "tests/fixtures/phase-04-reference-set.json";
  const evidenceDirectory = options.evidenceDirectory ?? "evidence/design";
  const pointerPath = options.pointerPath ?? "evidence/design/phase-04.json";
  if (options.runSuites !== false) run(["tests/billing/price-card.test.ts", "tests/billing/operation-finalization.test.ts", "tests/billing/line-items.test.ts", "tests/model/reconciliation.test.ts", "tests/phase-04/tracer.test.ts", "tests/phase-04/revision.test.ts", "tests/phase-04/repair.test.ts", "tests/phase-04/artifact-outcome.test.ts", "tests/phase-04/session-status.test.ts", "tests/contextvm/adapter.test.ts"]);
  const fixture = JSON.parse(await readFile(fixturePath, "utf8")) as { cases: readonly { id: string; requirements: readonly string[] }[] };
  const gate = await executePhase04ReferenceGate(fixture);
  if (gate.verdict !== "passed") throw new Error(`Phase 04 runtime reference gate blocked: ${gate.comparisons.filter((item) => item.status !== "passed").map((item) => `${item.id}:${item.mismatches.join(",")}`).join("; ") || gate.childFailures.join(",")}`);
  const checks = await Promise.all((Object.keys(checkPaths) as (keyof typeof checkPaths)[]).map(async (id) => ({ id, severity: id === "reference-set" ? "critical" as const : "high" as const, status: "passed" as const, evidenceSha256: await digestPaths(checkPaths[id]) }))) as readonly Phase04Check[];
  const input: Phase04DesignInput = {
    identities: { referenceSet: "tests/fixtures/phase-04-reference-set.json", meteredService: "src/phase-04/metered-generation-service.ts", gateway: "src/model/deterministic-model-gateway.ts", reconciliation: "src/model/reconciliation.ts", status: "src/phase-04/session-status.ts", adapter: "src/contextvm/adapter.ts" },
    checks, caseComparisons: gate.comparisons.map(({ id, expected, observed }) => ({ id: id as Phase04DesignInput["caseComparisons"][number]["id"], expected, observed })),
    requirementMappings: Object.fromEntries(["BILL-03", "BILL-04", "BILL-05", "SESS-01", "SESS-03", "SESS-04", "GEN-05", "GEN-06"].map((requirement) => [requirement, fixture.cases.filter((item) => item.requirements.includes(requirement)).map((item) => item.id)])),
    decisionMappings: Array.from({ length: 20 }, (_, index) => `D-${index + 59}`), threatMappings: ["T-04-ADAPTER", "T-04-AMBIGUITY", "T-04-ATOMIC", "T-04-AUTHORITY", "T-04-BLOCK", "T-04-DIAGNOSTIC", "T-04-DISCLOSE", "T-04-DOUBLE", "T-04-EFFECT", "T-04-EVIDENCE", "T-04-EVIDENCE-LEAK", "T-04-HISTORY-DOS", "T-04-HONESTY", "T-04-INJECTION", "T-04-INPUT", "T-04-MISMATCH", "T-04-NATIVE", "T-04-ORACLE", "T-04-PRICE", "T-04-QUARANTINE", "T-04-RACE", "T-04-READINESS", "T-04-REPAIR", "T-04-REPLAY", "T-04-RETRY", "T-04-SC", "T-04-STATUS-LEAK", "T-04-STATUS-OWNER"],
    observations: [{ provider: "deterministic_gateway", status: "passed", selection: "unselected", evidenceSha256: await digestPaths(["src/model/deterministic-model-gateway.ts", "tests/model/reconciliation.test.ts"]), limitations: ["deterministic fixture only"] }, { provider: "live_model", status: "not_observed", selection: "unselected", evidenceSha256: await digestPaths(["tests/fixtures/phase-04-reference-set.json"]), limitations: ["Phase 7 owns live provider selection and certification"] }],
  };
  const evidence = await writePhase04DesignEvidence(evidenceDirectory, input);
  const recordPath = `${evidenceDirectory}/${evidence.evidenceSha256}.json`;
  const recordText = await readFile(recordPath, "utf8"); const record = JSON.parse(recordText);
  await validatePhase04DesignEvidence(record);
  if (`${canonicalJson(record)}\n` !== recordText) throw new Error("immutable Phase 04 record is not canonical");
  await writeFile(pointerPath, `${canonicalJson({ certificationProfile: "design", verdict: evidence.verdict, offlineVerdict: evidence.offlineVerdict, evidenceSha256: evidence.evidenceSha256, contentAddressedPath: recordPath, credentialInputs: 0, aggregateEffects: evidence.aggregateEffects, observations: Object.fromEntries(evidence.observations.map((item) => [item.provider, { status: item.status, selection: item.selection, evidenceSha256: item.evidenceSha256 }])) })}\n`);
  return evidence;
}

if (import.meta.main) {
  const evidence = await runPhase04DesignGate();
  console.log(JSON.stringify({ verdict: evidence.verdict, offlineVerdict: evidence.offlineVerdict, evidenceSha256: evidence.evidenceSha256, credentialInputs: 0, observations: evidence.observations.map((item) => ({ provider: item.provider, status: item.status, selection: item.selection })) }));
}
