import { openMountedProductionHttpBootstrap } from "../src/production/bootstrap";

/** The image starts exclusively from the fixed mounted config/record path.
 * Runtime authority, session material, control services, and admission
 * observation are assembled internally before this listener is opened. */
export async function startProductionServer(input: Readonly<{ port?: number }> = {}) {
  const runtime = await openMountedProductionHttpBootstrap();
  return Bun.serve({ port: input.port ?? 8080, fetch: runtime.handle });
}

export const startMountedProductionServer = startProductionServer;

if (import.meta.main) await startProductionServer();
