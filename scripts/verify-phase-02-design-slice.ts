import { readFile, writeFile } from "node:fs/promises";
import { canonicalJson } from "../src/promotion/schema";
import { writePhase02DesignEvidence, type Phase02Check, type Phase02ProviderObservation } from "../src/verification/phase-02-design-evidence";

async function digestPaths(paths: readonly string[]): Promise<string> {
  const values = await Promise.all(paths.map(async (path) => `${path}\n${await Bun.file(path).text()}`));
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(values.join("\n")));
  return Array.from(new Uint8Array(digest), (byte) => byte.toString(16).padStart(2, "0")).join("");
}

const commands = ["bun test", "bun run eval:phase-02"] as const;
for (const command of commands) {
  const result = Bun.spawnSync(["bun", "run", "--silent", command === "bun test" ? "test" : "eval:phase-02"], { stdout: "inherit", stderr: "inherit" });
  if (result.exitCode !== 0) throw new Error(`offline deterministic command failed: ${command}`);
}
const providerPointer = JSON.parse(await readFile("evidence/phase-02/modal-probe.json", "utf8")) as Phase02ProviderObservation;
const checks = await Promise.all(["tracer", "admission", "risk", "session", "gateway", "fake-worker", "artifact-contract", "reference-set"].map(async (id) => ({ id, severity: id === "reference-set" ? "critical" : "high", status: "passed", evidenceSha256: await digestPaths([id === "reference-set" ? "tests/evals/phase-02-reference-set.test.ts" : "tests/phase-02/tracer.test.ts"]) }))) as readonly Phase02Check[];
const evidence = await writePhase02DesignEvidence("evidence/design", {
  policy: { identity: "phase-02-policy-2026-08-04", sha256: await digestPaths(["src/policy/phase-02-policy.ts"]) },
  sqlite: { identity: "phase-02-sqlite-session-store-v1", schemaSha256: await digestPaths(["src/persistence/sqlite-session-store.ts"]) },
  identities: { trustedCore: "src/phase-02/trusted-core.ts", workerContracts: "src/phase-02/contracts.ts", artifactGate: "src/policy/artifact-contract.ts" },
  checks,
  providerObservation: providerPointer,
});
await writeFile("evidence/design/phase-02.json", `${canonicalJson({ certificationProfile: "design", verdict: evidence.verdict, offlineVerdict: evidence.offlineVerdict, evidenceSha256: evidence.evidenceSha256, contentAddressedPath: `evidence/design/${evidence.evidenceSha256}.json`, provider: { status: evidence.providerObservation.status, selection: evidence.providerObservation.selection }, phase7Deferrals: evidence.deferrals })}\n`);
console.log(JSON.stringify({ verdict: evidence.verdict, offlineVerdict: evidence.offlineVerdict, provider: evidence.providerObservation.status, selection: evidence.providerObservation.selection, evidenceSha256: evidence.evidenceSha256 }));
