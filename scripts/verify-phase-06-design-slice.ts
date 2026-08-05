import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { dirname } from "node:path";

import { NAPPLET_CLI_LINUX_SHA256, NAPPLET_CLI_SOURCE_COMMIT, probePromotedCliPreSignedRoute } from "../src/publication/napplet-cli-source-contract.js";
import { canonicalJson } from "../src/promotion/schema.js";
import { buildPhase06DesignEvidence, canonicalPhase06EvidenceBytes, phase06EvidenceSha256, validatePhase06DesignEvidence, type Phase06DesignEvidence } from "../src/verification/phase-06-design-evidence.js";
import { executePhase06ReferenceCase, validatePhase06ReferenceSet } from "../src/verification/phase-06-reference-set.js";

const fixturePath = "tests/fixtures/phase-06-reference-set.json";
const cliFixturePath = "tests/fixtures/phase-06-cli-source-contract.json";
const exactCommit = "1a38b9150f3a3da148091c11bce4d0365f7298e5";
const exactLinuxSha = "46685f2e4df516b5b2e7e2e133480c90e5c85dbd36d05c6e95f4eee6af33ec5e";

const run = (command: readonly string[]) => { const result = Bun.spawnSync([...command], { stdout: "inherit", stderr: "inherit" }); if (result.exitCode !== 0) throw new Error(`Phase 06 verification command failed: ${command.join(" ")}`); };
const parseCoverage = (text: string) => [...text.matchAll(/^\|\s*([^|]+?)\s*\|\s*(INTEGRATE|OPT-OUT)\s*\|\s*([^|]+?)\s*\|$/gmu)].map((match) => {
  const reason = match[3].trim();
  return { id: match[1].trim().split(/\s+/u)[0], disposition: match[2] as "INTEGRATE" | "OPT-OUT", reason, coverage: reason.match(/\b06-\d+-\d+\b/gu) ?? ["COVERAGE.md"] };
});

export function validatePhase06ApiCoverage(coverage: string) {
  const rows = parseCoverage(coverage);
  if (!rows.length || rows.some((row) => !row.reason || !row.coverage.length) || !rows.some((row) => row.id === "PKG-01" && row.disposition === "OPT-OUT") || !rows.some((row) => row.id === "PKG-02" && row.disposition === "INTEGRATE")) throw new Error("Phase 06 API coverage matrix is incomplete");
  return rows;
}

async function observedComparisons(fixture: unknown) {
  const parsed = validatePhase06ReferenceSet(fixture);
  const results = await Promise.all(parsed.cases.map(executePhase06ReferenceCase));
  const failed = results.find((result) => result.childExitCode !== 0 || result.status !== "passed" || !result.observed || !result.effects);
  if (failed) throw new Error(`Phase 06 reference observation failed before evidence: ${failed.id} (${failed.mismatches.join(",") || `exit_${failed.childExitCode}`})`);
  return results.map((result) => ({ id: result.id, expected: result.expected, observed: result.observed!, effects: result.effects! }));
}

export async function writePhase06EvidenceAtomically(directory: string, evidence: Phase06DesignEvidence): Promise<void> {
  const path = `${directory}/${evidence.evidenceSha256}.json`;
  const content = `${canonicalJson(evidence)}\n`;
  await mkdir(directory, { recursive: true });
  try { await writeFile(path, content, { encoding: "utf8", flag: "wx" }); }
  catch (error) { if (!(error instanceof Error) || !("code" in error) || error.code !== "EEXIST") throw error; if (await readFile(path, "utf8") !== content) throw new Error("Phase 06 immutable evidence collision"); }
}

export async function runPhase06DesignChecks(options: Readonly<{ evidenceDirectory?: string; pointerPath?: string; runSuites?: boolean }> = {}) {
  if (options.runSuites !== false) run(["bun", "test", "tests/evals/phase-06-reference-set.test.ts", "--timeout", "10000"]);
  const [fixture, cliFixture, coverage] = await Promise.all([readFile(fixturePath, "utf8"), readFile(cliFixturePath, "utf8"), readFile(".planning/phases/06-sealed-preview-user-owned-publication/COVERAGE.md", "utf8")]);
  if (NAPPLET_CLI_SOURCE_COMMIT !== exactCommit || NAPPLET_CLI_LINUX_SHA256 !== exactLinuxSha) throw new Error("Phase 06 promoted CLI constants differ from the approved identity");
  const sourceContract = probePromotedCliPreSignedRoute(JSON.parse(cliFixture));
  if (sourceContract.status !== "available" || sourceContract.liveExecution !== "not_observed") throw new Error("Phase 06 source contract is unavailable");
  const changed = structuredClone(JSON.parse(cliFixture)); changed.identity.sourceCommit = "0".repeat(40);
  if (probePromotedCliPreSignedRoute(changed).status !== "publication_unavailable") throw new Error("Phase 06 source mutation did not fail closed");
  const sourceSnapshot = JSON.parse(cliFixture);
  const fixtureValue = JSON.parse(fixture);
  const input = { fixture: fixtureValue, comparisons: await observedComparisons(fixtureValue), apiRows: validatePhase06ApiCoverage(coverage), sourceContract: { ...sourceContract, identity: sourceSnapshot.identity } };
  const first = buildPhase06DesignEvidence(input); const second = buildPhase06DesignEvidence(structuredClone(input));
  if (canonicalPhase06EvidenceBytes(first).toString() !== canonicalPhase06EvidenceBytes(second).toString() || phase06EvidenceSha256(first) !== phase06EvidenceSha256(second)) throw new Error("Phase 06 evidence is not byte deterministic");
  const evidence = validatePhase06DesignEvidence(first);
  const evidenceDirectory = options.evidenceDirectory ?? "evidence/design"; const pointerPath = options.pointerPath ?? "evidence/design/phase-06.json";
  await writePhase06EvidenceAtomically(evidenceDirectory, evidence);
  const stored = validatePhase06DesignEvidence(JSON.parse(await readFile(`${evidenceDirectory}/${evidence.evidenceSha256}.json`, "utf8")));
  const pointer = { phase: "06", evidenceSha256: stored.evidenceSha256, record: stored.contentAddressedPath, certificationProfile: "design", verdict: "design-ready", providerSelection: "unselected", phase7Closure: "required" };
  await mkdir(dirname(pointerPath), { recursive: true }); const temp = `${pointerPath}.${process.pid}.tmp`; await writeFile(temp, `${canonicalJson(pointer)}\n`, "utf8"); await rename(temp, pointerPath);
  return evidence;
}

if (import.meta.main) await runPhase06DesignChecks();
