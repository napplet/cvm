import { createDevelopmentContextVmServer } from "../../src/dev-ui/contextvm-server";

const server = await createDevelopmentContextVmServer({ testMode: true });
try {
  // Exercise the observed idle-loss boundary after a full collection. The
  // factory's module-level listener registry must retain this endpoint until
  // its explicit close path executes.
  Bun.gc(true);
  await Bun.sleep(65_000);
  Bun.gc(true);
  const response = await fetch(`${server.url}/health`, { signal: AbortSignal.timeout(5_000) });
  const body = await response.json() as { status?: string };
  if (!response.ok || body.status !== "ok") throw new Error("DEV_UI_LISTENER_LOST_WHILE_IDLE");
  console.log(JSON.stringify({ case: "listener-retained-after-idle", status: "passed" }));
} finally {
  await server.close();
}
