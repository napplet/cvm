import { mkdir, readFile, writeFile } from "node:fs/promises";
import { canonicalJson } from "../src/promotion/schema";
import { observePhase05Facts, validatePhase05DesignEvidence, writePhase05DesignEvidence, type Phase05DesignInput } from "../src/verification/phase-05-design-evidence";

const digest = async (text: string): Promise<string> => Array.from(new Uint8Array(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(text))), (byte) => byte.toString(16).padStart(2, "0")).join("");
const digestPaths = async (paths: readonly string[]) => digest((await Promise.all(paths.map(async (path) => `${path}\n${await Bun.file(path).text()}`))).join("\n"));
const run = (paths: readonly string[]) => { const result = Bun.spawnSync(["bun", "test", ...paths, "--timeout", "10000"], { stdout: "inherit", stderr: "inherit" }); if (result.exitCode !== 0) throw new Error(`Phase 05 deterministic command failed: ${paths.join(" ")}`); };
const runExactAuthorityProbe = (execution: Readonly<{ file: string; testName: string }>) => {
  if (!execution.file.startsWith("tests/") || !execution.file.endsWith(".test.ts") || !execution.testName.trim()) throw new Error("invalid Phase 05 authority probe execution");
  const exactLeaf = execution.testName.replace(/[.*+?^${}()|[\]\\]/gu, "\\$&");
  const result = Bun.spawnSync(["bun", "test", execution.file, "--test-name-pattern", `^.*${exactLeaf}$`, "--timeout", "10000"], { stdout: "inherit", stderr: "inherit" });
  if (result.exitCode !== 0) throw new Error(`Phase 05 exact authority probe failed: ${execution.file} :: ${execution.testName}`);
};

export async function runPhase05DesignGate(options: Readonly<{ fixturePath?: string; evidenceDirectory?: string; pointerPath?: string; runSuites?: boolean }> = {}) {
  const fixturePath = options.fixturePath ?? "tests/fixtures/phase-05-reference-set.json";
  const evidenceDirectory = options.evidenceDirectory ?? "evidence/design";
  const pointerPath = options.pointerPath ?? "evidence/design/phase-05.json";
  const suites = ["tests/phase-05/pause-for-funding.test.ts", "tests/phase-05/continuation-status.test.ts", "tests/phase-05/grace-wake.test.ts", "tests/phase-05/deadline-checkpoint.test.ts", "tests/phase-05/checkpoint-envelope.test.ts", "tests/phase-05/resume-session.test.ts", "tests/phase-05/retention-expiry.test.ts", "tests/persistence/continuation-store.test.ts", "tests/persistence/phase-05-sql-schema-parity.test.ts", "tests/contextvm/adapter.test.ts", "tests/evals/phase-05-reference-set.test.ts", "tests/verification/phase-05-design-slice.test.ts"];
  if (options.runSuites !== false) run(suites);
  const fixture = JSON.parse(await readFile(fixturePath, "utf8"));
  const comparisons = fixture.cases.map((item: { id: string; expected: unknown; execution?: { file: string; testName: string } }) => {
    if (!item.execution) throw new Error(`missing exact authority probe for ${item.id}`);
    runExactAuthorityProbe(item.execution);
    return { id: item.id, expected: item.expected, observed: observePhase05Facts(item.id) };
  });
  const input: Phase05DesignInput = { fixture, comparisons, inputHashes: {
    reference: await digestPaths([fixturePath, "tests/evals/phase-05-reference-set.test.ts"]),
    continuity: await digestPaths(["src/continuity/continuation-service.ts", "src/continuity/deadline-reconciler.ts", "src/continuity/checkpoint-envelope.ts"]),
    persistence: await digestPaths(["src/persistence/funding-store.ts", "src/persistence/postgres-sql-funding-store.ts", "tests/persistence/continuation-store.test.ts", "tests/persistence/phase-05-sql-schema-parity.test.ts"]),
    adapter: await digestPaths(["src/contextvm/adapter.ts", "tests/contextvm/adapter.test.ts"]),
    evidence: await digestPaths(["src/verification/phase-05-design-evidence.ts", "tests/verification/phase-05-design-slice.test.ts"]),
  } };
  const evidence = await writePhase05DesignEvidence(evidenceDirectory, input);
  const stored = JSON.parse(await readFile(`${evidenceDirectory}/${evidence.evidenceSha256}.json`, "utf8"));
  await validatePhase05DesignEvidence(stored);
  await mkdir(pointerPath.slice(0, pointerPath.lastIndexOf("/")), { recursive: true });
  await writeFile(pointerPath, `${canonicalJson({ phase: "05", evidenceSha256: evidence.evidenceSha256, record: `${evidenceDirectory}/${evidence.evidenceSha256}.json`, certificationProfile: "design", verdict: "design-ready", providerSelection: "unselected", phase7Closure: "required" })}\n`, "utf8");
  return evidence;
}

if (import.meta.main) await runPhase05DesignGate();
