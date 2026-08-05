const fixturePath = "tests/fixtures/phase-07-reference-set.json";

function validateRegistry(registry: unknown): void {
  if (!registry || typeof registry !== "object") throw new Error("phase07_registry_invalid");
  const value = registry as { schema?: unknown; version?: unknown; entries?: unknown };
  if (value.schema !== "phase-07-reference-set" || value.version !== 1 || !Array.isArray(value.entries) || value.entries.length !== 5) throw new Error("phase07_registry_invalid");
  if (value.entries.some((entry) => !entry || typeof entry !== "object" || (entry as { status?: unknown }).status !== "pending")) throw new Error("phase07_registry_nonpass_required");
}

async function main(): Promise<void> {
  if (Bun.argv.length !== 3 || Bun.argv[2] !== "--verify-existing") {
    console.error(JSON.stringify({ phase: "07", command: "verify-evidence", status: "not_observed", reason: "invalid_arguments" }));
    process.exitCode = 64;
    return;
  }
  try { validateRegistry(await Bun.file(fixturePath).json()); }
  catch { console.error(JSON.stringify({ phase: "07", command: "verify-evidence", status: "not_observed", reason: "registry_unavailable" })); process.exitCode = 1; return; }
  console.error(JSON.stringify({ phase: "07", command: "verify-evidence", status: "not_observed", reason: "canonical_executed_evidence_absent" }));
  process.exitCode = 1;
}

await main();
