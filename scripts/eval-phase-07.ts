const fixturePath = "tests/fixtures/phase-07-reference-set.json";
const allowedSuites = new Set(["all", "telemetry"]);

function validateRegistry(registry: unknown): void {
  if (!registry || typeof registry !== "object") throw new Error("phase07_registry_invalid");
  const value = registry as { schema?: unknown; version?: unknown; entries?: unknown };
  if (value.schema !== "phase-07-reference-set" || value.version !== 1 || !Array.isArray(value.entries)) throw new Error("phase07_registry_invalid");
  const ids = value.entries.map((entry) => (entry && typeof entry === "object" ? (entry as { id?: unknown }).id : undefined));
  if (ids.join(",") !== "07-W0-01,07-W0-02,07-W0-03,07-W0-04,07-W0-05" || new Set(ids).size !== 5) throw new Error("phase07_registry_invalid");
  if (value.entries.some((entry) => !entry || typeof entry !== "object" || (entry as { status?: unknown }).status !== "pending")) throw new Error("phase07_registry_nonpass_required");
}

async function main(): Promise<void> {
  const [argument] = Bun.argv.slice(2);
  if (Bun.argv.length !== 3 || !argument?.startsWith("--suite=") || !allowedSuites.has(argument.slice("--suite=".length))) {
    console.error(JSON.stringify({ phase: "07", command: "eval", status: "not_implemented", reason: "invalid_arguments" }));
    process.exitCode = 64;
    return;
  }
  try { validateRegistry(await Bun.file(fixturePath).json()); }
  catch { console.error(JSON.stringify({ phase: "07", command: "eval", status: "not_implemented", reason: "registry_unavailable" })); process.exitCode = 1; return; }
  console.error(JSON.stringify({ phase: "07", command: "eval", suite: argument.slice("--suite=".length), status: "not_implemented", reason: "executed_phase_07_evidence_absent" }));
  process.exitCode = 1;
}

await main();
