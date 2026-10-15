import { stat } from "node:fs/promises";
import { resolve } from "node:path";
import { createDevelopmentPool, type DevPayments } from "../../scripts/dev-payments";
import { LocalDevelopmentRuntimeReadiness } from "./development-runtime-readiness";

const root = resolve(import.meta.dir, "../..");
const migrationNames = ["development/001_generation.sql", "development/002_provider_observations.sql", "development/003_artifact_preview.sql", "development/004_source_proposal_bindings.sql", "development/005_pending_actions.sql", "development/006_worker_results.sql"] as const;
const manifestPins = { "package.json": "cbcc433278d32391b075576ebd847ae30039f1d86ad229a149f5566856989f23", "bun.lock": "8916ee4ec92924ae9e09bc4f315fd6656033812696e35a1b7785161d872c5ac3" } as const;

export type DevelopmentMode = "deterministic-fixture" | "configured-openai";
export type LauncherReadiness = Readonly<{ workerImageDigest: string; readinessProbeDigest: string }>;

function sha256(path: string): Promise<string> { return Bun.file(path).arrayBuffer().then((bytes) => new Bun.CryptoHasher("sha256").update(bytes).digest("hex")); }

async function relayRoundTrip(url: string): Promise<void> {
  await new Promise<void>((resolvePromise, reject) => {
    const socket = new WebSocket(url); const timeout = setTimeout(() => { socket.close(); reject(new Error("DEV_RELAY_NOT_READY")); }, 5_000);
    socket.addEventListener("open", () => { clearTimeout(timeout); socket.close(); resolvePromise(); }, { once: true });
    socket.addEventListener("error", () => { clearTimeout(timeout); reject(new Error("DEV_RELAY_NOT_READY")); }, { once: true });
  });
}

/** Read-only development launcher gate. No credential material is returned. */
export async function assertLauncherReadiness(input: Readonly<{ config: DevPayments; configPath: string; url?: string; stateRoot: string }>): Promise<LauncherReadiness> {
  for (const [path, expected] of Object.entries(manifestPins)) if (await sha256(resolve(root, path)) !== expected) throw new Error(`DEV_ROOT_MANIFEST_DRIFT:${path}`);
  const configStat = await stat(input.configPath);
  if (!configStat.isFile() || (configStat.mode & 0o077) !== 0) throw new Error("DEV_PRIVATE_CONFIG_INVALID");
  if (input.config.developmentOnly !== true || input.config.version !== 1) throw new Error("DEV_PRIVATE_CONFIG_INVALID");
  const pool = createDevelopmentPool(input.config.databaseUrl);
  try {
    const migrated = await pool.query<{ name: string }>("SELECT name FROM development_migrations WHERE name = ANY($1::text[])", [migrationNames]);
    if (migrated.rows.length !== migrationNames.length) throw new Error("DEV_MIGRATIONS_INCOMPLETE");
  } finally { await pool.end(); }
  await Promise.all([
    fetch(`${input.config.mintUrl}/v1/info`, { signal: AbortSignal.timeout(5_000) }).then((response) => { if (!response.ok) throw new Error("DEV_MINT_NOT_READY"); }),
    relayRoundTrip(input.config.relayUrl),
  ]);
  if (input.url) {
    const health = await fetch(`${input.url}/health`, { signal: AbortSignal.timeout(5_000) });
    if (!health.ok) throw new Error("DEV_CONTEXTVM_NOT_READY");
  }
  const runtime = await new LocalDevelopmentRuntimeReadiness().assertReady();
  return Object.freeze({ workerImageDigest: runtime.imageDigest, readinessProbeDigest: runtime.readinessProbeDigest });
}
