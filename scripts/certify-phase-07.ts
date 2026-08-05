const fixturePath = "tests/fixtures/phase-07-reference-set.json";
const protectedSuites = ["admission", "telemetry", "chaos", "restore", "security-host", "supply-chain", "contextvm-payment-model", "publication"] as const;

function validateRegistry(registry: unknown): void {
  if (!registry || typeof registry !== "object") throw new Error("phase07_registry_invalid");
  const value = registry as { schema?: unknown; version?: unknown; entries?: unknown };
  if (value.schema !== "phase-07-reference-set" || value.version !== 1 || !Array.isArray(value.entries) || value.entries.length !== 5) throw new Error("phase07_registry_invalid");
  if (value.entries.some((entry) => !entry || typeof entry !== "object" || (entry as { status?: unknown }).status !== "pending")) throw new Error("phase07_registry_nonpass_required");
}

async function main(): Promise<void> {
  const args = Bun.argv.slice(2);
  if (args.length !== 2 || args[0] !== "--profile=release" || args[1] !== "--preflight-only") {
    console.error(JSON.stringify({ phase: "07", command: "certify", status: "blocked", reason: "invalid_arguments" }));
    process.exitCode = 64;
    return;
  }
  try { validateRegistry(await Bun.file(fixturePath).json()); }
  catch { console.error(JSON.stringify({ phase: "07", command: "certify", status: "blocked", reason: "registry_unavailable" })); process.exitCode = 1; return; }
  console.error(JSON.stringify({
    phase: "07",
    command: "certify",
    profile: "release",
    status: "blocked",
    reason: "implementation_or_protected_topology_not_observed",
    suites: protectedSuites.map((suite) => ({ suite, status: "not_observed" })),
  }));
  process.exitCode = 1;
}

await main();
