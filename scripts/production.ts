import { loadServiceConfig, SERVICE_CONFIG_PATH } from "../src/service/config";
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

/** Only known startup diagnostics may include text from an error. */
export function serviceStartupFailure(error: unknown): { ready: false; error: string; kind?: string; code?: string; validation?: string[] } {
  // Error codes only; mounted secrets never appear in diagnostics.
  const message = error instanceof Error ? error.message : "SERVICE_START_FAILED";
  // This fixed, non-secret mount path contains lowercase characters. Keep
  // arbitrary exception text redacted rather than relaxing the code filter.
  const safeMessage = /^[A-Z][A-Z0-9_:./-]{2,200}$/u.test(message)
    || message === `SERVICE_MOUNT_UNAVAILABLE:${SERVICE_CONFIG_PATH}`;
  // Validation errors report issue paths and codes only, never values.
  const issues = error instanceof Error && error.name === "ZodError" ? (error as unknown as { issues: Array<{ path: PropertyKey[]; code: string }> }).issues.slice(0, 8).map((issue) => `${issue.path.map(String).join(".")}:${issue.code}`) : undefined;
  // Unexpected errors report their class and system error code, not their text.
  const cause = error instanceof Error ? (error as { code?: unknown }).code ?? (error.cause as { code?: unknown } | undefined)?.code : undefined;
  const kind = error instanceof Error && !safeMessage ? { kind: error.name, ...(typeof cause === "string" && /^[A-Z_]{2,40}$/u.test(cause) ? { code: cause } : {}) } : {};
  return { ready: false, error: safeMessage ? message : "SERVICE_START_FAILED", ...kind, ...(issues ? { validation: issues } : {}) };
}

if (import.meta.main) {
  try { await startProductionServer(); }
  catch (error) {
    console.error(JSON.stringify(serviceStartupFailure(error)));
    process.exit(1);
  }
}
