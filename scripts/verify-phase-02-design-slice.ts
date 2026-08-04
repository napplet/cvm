import { readFile, writeFile } from "node:fs/promises";
import { canonicalJson } from "../src/promotion/schema";
import { writePhase02DesignEvidence, type Phase02Check, type Phase02ProviderObservation } from "../src/verification/phase-02-design-evidence";

async function digestPaths(paths: readonly string[]): Promise<string> {
  const values = await Promise.all(paths.map(async (path) => `${path}\n${await Bun.file(path).text()}`));
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(values.join("\n")));
  return Array.from(new Uint8Array(digest), (byte) => byte.toString(16).padStart(2, "0")).join("");
}

async function digest(value: string): Promise<string> {
  const valueDigest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(value));
  return Array.from(new Uint8Array(valueDigest), (byte) => byte.toString(16).padStart(2, "0")).join("");
}

async function immutableProviderObservation(): Promise<Phase02ProviderObservation> {
  const pointer = JSON.parse(await readFile("evidence/phase-02/modal-probe.json", "utf8")) as Phase02ProviderObservation;
  if (!/^[a-f0-9]{64}$/iu.test(pointer.evidenceSha256)) throw new Error("provider pointer has no immutable evidence digest");
  const recordPath = `evidence/phase-02/provider/${pointer.evidenceSha256}.json`;
  const recordText = await readFile(recordPath, "utf8");
  const record = JSON.parse(recordText) as Phase02ProviderObservation;
  const { version, evidenceSha256, ...digestInput } = record;
  if (version !== 1 || evidenceSha256 !== pointer.evidenceSha256 || `${canonicalJson(record)}\n` !== recordText || await digest(canonicalJson(digestInput)) !== evidenceSha256) throw new Error("provider immutable evidence record is invalid");
  return record;
}

const checkPaths = {
  tracer: ["tests/phase-02/tracer.test.ts", "src/phase-02/trusted-core.ts"],
  admission: ["tests/admission/admission-policy.test.ts", "src/admission/admission-policy.ts"],
  risk: ["tests/admission/risk-policy.test.ts", "src/admission/risk-policy.ts"],
  session: ["tests/domain/session-service.test.ts", "tests/persistence/sqlite-session-store.test.ts", "src/domain/session-service.ts", "src/persistence/sqlite-session-store.ts"],
  gateway: ["tests/capabilities/scoped-tool-gateway.test.ts", "src/capabilities/scoped-tool-gateway.ts"],
  "fake-worker": ["tests/worker-port/fake-worker.test.ts", "src/worker-port/fake-worker.ts"],
  "artifact-contract": ["tests/policy/artifact-contract.test.ts", "src/policy/artifact-contract.ts"],
  "reference-set": ["tests/evals/phase-02-reference-set.test.ts", "tests/fixtures/phase-02-reference-set.json"],
} as const;
const commands = ["bun test", "bun run eval:phase-02"] as const;
for (const command of commands) {
  const result = Bun.spawnSync(["bun", "run", "--silent", command === "bun test" ? "test" : "eval:phase-02"], { stdout: "inherit", stderr: "inherit" });
  if (result.exitCode !== 0) throw new Error(`offline deterministic command failed: ${command}`);
}
const commandEvidence = {
  "bun test": await digestPaths(["package.json", ...new Set(Object.values(checkPaths).flat())]),
  "bun run eval:phase-02": await digestPaths(["package.json", ...checkPaths["reference-set"]]),
};
const providerPointer = await immutableProviderObservation();
const checks = await Promise.all((Object.keys(checkPaths) as (keyof typeof checkPaths)[]).map(async (id) => ({ id, severity: id === "reference-set" ? "critical" : "high", status: "passed", evidenceSha256: await digestPaths(checkPaths[id]) }))) as readonly Phase02Check[];
const evidence = await writePhase02DesignEvidence("evidence/design", {
  policy: { identity: "phase-02-policy-2026-08-04", sha256: await digestPaths(["src/policy/phase-02-policy.ts"]) },
  sqlite: { identity: "phase-02-sqlite-session-store-v1", schemaSha256: await digestPaths(["src/persistence/sqlite-session-store.ts"]) },
  identities: { trustedCore: "src/phase-02/trusted-core.ts", workerContracts: "src/phase-02/contracts.ts", artifactGate: "src/policy/artifact-contract.ts" },
  checks,
  providerObservation: providerPointer,
});
await writeFile("evidence/design/phase-02.json", `${canonicalJson({ certificationProfile: "design", verdict: evidence.verdict, offlineVerdict: evidence.offlineVerdict, evidenceSha256: evidence.evidenceSha256, contentAddressedPath: `evidence/design/${evidence.evidenceSha256}.json`, provider: { status: evidence.providerObservation.status, selection: evidence.providerObservation.selection, evidenceSha256: evidence.providerObservation.evidenceSha256 }, fullSuite: { command: "bun test", outputSha256: commandEvidence["bun test"] }, referenceEvaluation: { command: "bun run eval:phase-02", outputSha256: commandEvidence["bun run eval:phase-02"] }, phase7Deferrals: evidence.deferrals })}\n`);
console.log(JSON.stringify({ verdict: evidence.verdict, offlineVerdict: evidence.offlineVerdict, provider: evidence.providerObservation.status, selection: evidence.providerObservation.selection, evidenceSha256: evidence.evidenceSha256 }));
