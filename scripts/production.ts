import { loadServiceConfig } from "../src/service/config";
import { createServiceRuntime } from "../src/service/server";

/**
 * Normal container entrypoint. Configuration is the fixed mount
 * `/etc/napplet-cvm/service.json`; secrets are files under
 * `/run/secrets/napplet-cvm`. Schema migration is a separate command
 * (`scripts/migrate.ts`) and is never run implicitly at startup.
 */
export async function startProductionServer() {
  const config = await loadServiceConfig();
  const started = performance.now();
  const runtime = await createServiceRuntime({ config });
  const status = await runtime.status();
  console.log(JSON.stringify({ ready: true, ...status, startupMs: Math.round(performance.now() - started) }));
  let stopping = false;
  const stop = async () => { if (stopping) return; stopping = true; await runtime.close(); process.exit(0); };
  process.once("SIGTERM", () => void stop());
  process.once("SIGINT", () => void stop());
  return runtime;
}

if (import.meta.main) {
  try { await startProductionServer(); }
  catch (error) {
    // Error codes only; mounted secrets never appear in diagnostics.
    const message = error instanceof Error ? error.message : "SERVICE_START_FAILED";
    // Validation errors report issue paths and codes only, never values.
    const issues = error instanceof Error && error.name === "ZodError" ? (error as unknown as { issues: Array<{ path: PropertyKey[]; code: string }> }).issues.slice(0, 8).map((issue) => `${issue.path.map(String).join(".")}:${issue.code}`) : undefined;
    console.error(JSON.stringify({ ready: false, error: /^[A-Z][A-Z0-9_:./-]{2,200}$/u.test(message) ? message : "SERVICE_START_FAILED", ...(issues ? { validation: issues } : {}) }));
    process.exit(1);
  }
}
