import { validatePhase07ReferenceSet, executePhase07ReferenceCase } from "../src/certification/phase-07-reference-set.js";

const suites = {
  all: ["admission", "resilience", "security", "publication", "launch"], admission: ["admission"], telemetry: ["launch"], resilience: ["resilience"], restore: ["resilience"], "security-host": ["security", "publication"], "supply-chain": ["launch"],
} as const;

async function main(): Promise<void> {
  const [argument] = Bun.argv.slice(2);
  if (Bun.argv.length !== 3 || !argument?.startsWith("--suite=") || !(argument.slice(8) in suites)) {
    console.error(JSON.stringify({ phase: "07", command: "eval", status: "failed", reason: "invalid_arguments" })); process.exitCode = 64; return;
  }
  const suite = argument.slice(8) as keyof typeof suites;
  try {
    const fixture = validatePhase07ReferenceSet(await Bun.file("tests/fixtures/phase-07-reference-set.json").json());
    const categories: readonly (typeof fixture.cases[number])["category"][] = suites[suite];
    const selected = fixture.cases.filter((item) => categories.includes(item.category));
    const results = await Promise.all(selected.map((item) => executePhase07ReferenceCase(item)));
    const failed = results.filter((item) => item.status !== "passed");
    if (failed.length) throw new Error(`comparison_failed:${failed.map((item) => item.id).join(",")}`);
    console.log(JSON.stringify({ phase: "07", command: "eval", suite, status: "passed", evidenceClass: "deterministic", cases: selected.length, promotionVerdict: "blocked" }));
  } catch (error) {
    console.error(JSON.stringify({ phase: "07", command: "eval", suite, status: "failed", reason: error instanceof Error ? error.message : "unknown" })); process.exitCode = 1;
  }
}
await main();
