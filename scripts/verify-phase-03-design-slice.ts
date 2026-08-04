import { readFile, writeFile } from "node:fs/promises";
import { canonicalJson } from "../src/promotion/schema";
import { validatePhase03DesignEvidence, writePhase03DesignEvidence, type Phase03Check, type Phase03Observation } from "../src/verification/phase-03-design-evidence";

const digest = async (value: string): Promise<string> => {
  const bytes = new TextEncoder().encode(value);
  const result = await crypto.subtle.digest("SHA-256", bytes);
  return Array.from(new Uint8Array(result), (byte) => byte.toString(16).padStart(2, "0")).join("");
};
const digestPaths = async (paths: readonly string[]): Promise<string> => digest((await Promise.all(paths.map(async (path) => `${path}\n${await Bun.file(path).text()}`))).join("\n"));
const run = (command: string, args: readonly string[]) => {
  const result = Bun.spawnSync([command, ...args], { stdout: "inherit", stderr: "inherit" });
  if (result.exitCode !== 0) throw new Error(`deterministic command failed: ${[command, ...args].join(" ")}`);
};
const checkPaths = {
  contextvm: ["tests/contextvm/adapter.test.ts", "src/contextvm/adapter.ts", "src/contextvm/announcement.ts"],
  ledger: ["tests/persistence/postgres-funding-store.test.ts", "src/persistence/postgres-funding-store.ts"],
  lightning: ["tests/funding/lightning-top-up.test.ts", "src/funding/lightning-top-up.ts"],
  cashu: ["tests/funding/cashu-top-up.test.ts", "src/funding/cashu-top-up.ts", "src/funding/cashu-mint-policy.ts"],
  "funded-admission": ["tests/funding/funded-admission.test.ts", "tests/phase-03/tracer.test.ts", "src/funding/funded-admission.ts", "src/phase-03/funded-core.ts"],
  "reference-set": ["tests/evals/phase-03-reference-set.test.ts", "tests/fixtures/phase-03-reference-set.json"],
  "package-intake": ["evidence/phase-03/package-intake.json", "scripts/verify-phase-03-packages.ts"],
  "api-coverage": [".planning/phases/03-contextvm-funding-funded-admission/COVERAGE.md", ".planning/phases/03-contextvm-funding-funded-admission/03-API-COVERAGE.md"],
} as const;

function validatePackageIntake(value: unknown): void {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("package intake is malformed");
  const intake = value as { schemaVersion?: unknown; disposition?: unknown; packages?: unknown };
  const packages = Array.isArray(intake.packages) ? intake.packages : [];
  const expected = new Map([["@contextvm/sdk", "0.13.10"], ["@cashu/cashu-ts", "4.7.2"], ["kysely", "0.29.4"], ["pg", "8.22.0"]]);
  if (intake.schemaVersion !== 1 || intake.disposition !== "design-stage" || packages.length !== expected.size) throw new Error("package intake identity is incomplete");
  for (const item of packages) {
    if (!item || typeof item !== "object") throw new Error("package intake item is malformed");
    const row = item as { name?: unknown; version?: unknown; registryIntegrity?: unknown; tarballSha256?: unknown; disposition?: unknown };
    if (typeof row.name !== "string" || expected.get(row.name) !== row.version || typeof row.registryIntegrity !== "string" || typeof row.tarballSha256 !== "string" || !/^[a-f0-9]{64}$/iu.test(row.tarballSha256) || row.disposition !== "design-stage") throw new Error("package intake item does not match pinned design identity");
  }
}
async function inheritedModalObservation(): Promise<Phase03Observation> {
  const pointer = JSON.parse(await readFile("evidence/phase-02/modal-probe.json", "utf8")) as { status?: unknown; selection?: unknown; evidenceSha256?: unknown };
  if (pointer.status !== "blocked" || pointer.selection !== "unselected" || typeof pointer.evidenceSha256 !== "string" || !/^[a-f0-9]{64}$/iu.test(pointer.evidenceSha256)) throw new Error("inherited Modal observation is not blocked/unselected evidence");
  return { version: 1, provider: "modal", status: "blocked", selection: "unselected", certificationProfile: "design", reasonCode: "PROVIDER_UNSELECTED", evidenceSha256: pointer.evidenceSha256, limitations: ["Phase 7 owns live provider and SLO certification"] };
}

run("bun", ["test"]);
run("bun", ["run", "eval:phase-03"]);
validatePackageIntake(JSON.parse(await readFile("evidence/phase-03/package-intake.json", "utf8")));
run("node", ["/Users/sandwich/.codex/gsd-core/bin/gsd-tools.cjs", "check", "api-coverage.verify-pre", ".planning/phases/03-contextvm-funding-funded-admission"]);
for (const path of ["src/funding/funding-service.ts", "src/persistence/funding-store.ts", "src/phase-03/contracts.ts"]) {
  if (/@contextvm\/sdk|nostr|cep-?8|@cashu\/cashu-ts|\bmodal\b/iu.test(await Bun.file(path).text())) throw new Error(`import firewall failed: ${path}`);
}
const checks = await Promise.all((Object.keys(checkPaths) as (keyof typeof checkPaths)[]).map(async (id) => ({ id, severity: id === "reference-set" || id === "ledger" ? "critical" as const : "high" as const, status: "passed" as const, evidenceSha256: await digestPaths(checkPaths[id]) }))) as readonly Phase03Check[];
const observations: readonly Phase03Observation[] = [
  { version: 1, provider: "contextvm", status: "blocked", selection: "unselected", certificationProfile: "design", reasonCode: "LIVE_CONTEXTVM_UNCONFIGURED", evidenceSha256: await digestPaths(["tests/contextvm/adapter.test.ts"]), limitations: ["Phase 7 owns live relay interoperability certification"] },
  { version: 1, provider: "lightning", status: "blocked", selection: "unselected", certificationProfile: "design", reasonCode: "LIVE_LIGHTNING_UNCONFIGURED", evidenceSha256: await digestPaths(["tests/funding/lightning-top-up.test.ts"]), limitations: ["Phase 7 owns live receiver certification"] },
  { version: 1, provider: "cashu", status: "blocked", selection: "unselected", certificationProfile: "design", reasonCode: "LIVE_CASHU_UNCONFIGURED", evidenceSha256: await digestPaths(["tests/funding/cashu-top-up.test.ts"]), limitations: ["Phase 7 owns live mint certification"] },
  { version: 1, provider: "postgres", status: "blocked", selection: "unselected", certificationProfile: "design", reasonCode: "LIVE_POSTGRES_UNCONFIGURED", evidenceSha256: await digestPaths(["tests/persistence/postgres-funding-store.test.ts"]), limitations: ["Phase 7 owns live PostgreSQL/Cockroach certification"] },
  { version: 1, provider: "capacity", status: "blocked", selection: "unselected", certificationProfile: "design", reasonCode: "LIVE_CAPACITY_UNCONFIGURED", evidenceSha256: await digestPaths(["tests/funding/funded-admission.test.ts"]), limitations: ["Phase 7 owns live capacity and five-second SLO certification"] },
  await inheritedModalObservation(),
];
const evidence = await writePhase03DesignEvidence("evidence/design", {
  identities: { packageIntake: "evidence/phase-03/package-intake.json", postgres: "src/persistence/postgres-sql-funding-store.ts", contextvm: "src/contextvm/adapter.ts", lightning: "src/funding/lightning-top-up.ts", cashu: "src/funding/cashu-top-up.ts", fundedCore: "src/phase-03/funded-core.ts", referenceSet: "tests/fixtures/phase-03-reference-set.json" },
  checks,
  requirementMappings: Object.freeze({ "CTX-01": ["contextvm", "reference-set"], "CTX-02": ["contextvm", "reference-set"], "CTX-03": ["contextvm", "ledger", "reference-set"], "CTX-04": ["contextvm", "funded-admission", "reference-set"], "PAY-01": ["contextvm", "lightning", "cashu", "reference-set"], "PAY-02": ["lightning", "reference-set"], "PAY-03": ["cashu", "reference-set"], "PAY-04": ["lightning", "cashu", "reference-set"], "PAY-05": ["ledger", "lightning", "cashu", "reference-set"], "PAY-06": ["cashu", "reference-set"], "PAY-07": ["cashu", "reference-set"], "BILL-01": ["ledger", "funded-admission", "reference-set"], "BILL-02": ["funded-admission", "reference-set"], "BILL-06": ["funded-admission", "reference-set"] }),
  decisionMappings: Array.from({ length: 19 }, (_, index) => `D-${index + 40}`), observations,
  threatMappings: ["T-03-01", "T-03-02", "T-03-03", "T-03-04", "T-03-02-SC", "T-03-05", "T-03-06", "T-03-07", "T-03-08", "T-03-09", "T-03-10", "T-03-11", "T-03-12", "T-03-03-SC", "T-03-13", "T-03-14", "T-03-15", "T-03-16", "T-03-17", "T-03-18", "T-03-19", "T-03-20", "T-03-05-SC", "T-03-21", "T-03-22", "T-03-23", "T-03-24", "T-03-25", "T-03-26", "T-03-27", "T-03-28", "T-03-29"],
});
const recordPath = `evidence/design/${evidence.evidenceSha256}.json`;
const recordText = await readFile(recordPath, "utf8");
const record = JSON.parse(recordText);
await validatePhase03DesignEvidence(record);
if (`${canonicalJson(record)}\n` !== recordText) throw new Error("immutable Phase 03 record is not canonical");
await writeFile("evidence/design/phase-03.json", `${canonicalJson({ certificationProfile: "design", verdict: evidence.verdict, offlineVerdict: evidence.offlineVerdict, evidenceSha256: evidence.evidenceSha256, contentAddressedPath: recordPath, observations: Object.fromEntries(evidence.observations.map((item) => [item.provider, { status: item.status, selection: item.selection, evidenceSha256: item.evidenceSha256 }])), deferrals: evidence.deferrals })}\n`);
console.log(JSON.stringify({ verdict: evidence.verdict, offlineVerdict: evidence.offlineVerdict, evidenceSha256: evidence.evidenceSha256, observations: evidence.observations.map((item) => ({ provider: item.provider, status: item.status, selection: item.selection })) }));
