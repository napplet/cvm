import { stat } from "node:fs/promises";
import { resolve } from "node:path";
import { createDevelopmentPool, type DevPayments } from "../../scripts/dev-payments";
import { LocalDevelopmentRuntimeReadiness } from "./development-runtime-readiness";
import { assertDevelopmentRootManifests } from "./root-manifests";

const root = resolve(import.meta.dir, "../..");
const migrationNames = ["development/001_generation.sql", "development/002_provider_observations.sql", "development/003_artifact_preview.sql", "development/004_source_proposal_bindings.sql", "development/005_pending_actions.sql", "development/006_worker_results.sql", "development/007_chatgpt_operations.sql", "development/008_chatgpt_diagnostics.sql", "development/009_operator_publication.sql", "development/010_projects.sql", "development/011_publication_relays.sql", "development/012_remix_imports.sql", "development/013_publication_tracking.sql"] as const;

export type DevelopmentMode = "deterministic-fixture" | "configured-openai" | "chatgpt-oauth";
export type LauncherReadiness = Readonly<{ workerImageDigest: string; readinessProbeDigest: string }>;

function sha256(path: string): Promise<string> { return Bun.file(path).arrayBuffer().then((bytes) => new Bun.CryptoHasher("sha256").update(bytes).digest("hex")); }

async function relayRoundTrip(url: string): Promise<void> {
  await new Promise<void>((resolvePromise, reject) => {
    const subscription = `launcher-${crypto.randomUUID().replaceAll("-", "")}`;
    const socket = new WebSocket(url);
    let settled = false;
    const finish = (error?: Error) => {
      if (settled) return;
      settled = true;
      clearTimeout(timeout);
      socket.close();
      if (error) reject(error); else resolvePromise();
    };
    const timeout = setTimeout(() => finish(new Error("DEV_RELAY_NOT_READY")), 5_000);
    socket.addEventListener("open", () => socket.send(JSON.stringify(["REQ", subscription, {}])), { once: true });
    socket.addEventListener("message", (event) => {
      try {
        const message = JSON.parse(String(event.data));
        if (Array.isArray(message) && message[0] === "EOSE" && message[1] === subscription) finish();
      } catch { finish(new Error("DEV_RELAY_PROTOCOL_INVALID")); }
    });
    socket.addEventListener("error", () => finish(new Error("DEV_RELAY_NOT_READY")), { once: true });
  });
}

async function hubReady(url: string): Promise<void> {
  const response = await fetch(`${url}/api/info`, { signal: AbortSignal.timeout(5_000) });
  if (!response.ok) throw new Error("DEV_HUB_NOT_READY");
  const info = await response.json() as { running?: unknown; relays?: unknown };
  if (info.running !== true || !Array.isArray(info.relays) || !info.relays.some((relay) => typeof relay === "object" && relay !== null && (relay as { online?: unknown }).online === true)) throw new Error("DEV_HUB_RELAY_NOT_READY");
}

/** Read-only development launcher gate. No credential material is returned. */
export async function assertLauncherReadiness(input: Readonly<{ config: DevPayments; configPath: string; url?: string; stateRoot: string }>): Promise<LauncherReadiness> {
  if (!Bun.which("node")) throw new Error("DEV_PUBLICATION_NODE_REQUIRED");
  await assertDevelopmentRootManifests(root);
  const configStat = await stat(input.configPath);
  if (!configStat.isFile() || (configStat.mode & 0o077) !== 0) throw new Error("DEV_PRIVATE_CONFIG_INVALID");
  if (input.config.developmentOnly !== true || input.config.version !== 1) throw new Error("DEV_PRIVATE_CONFIG_INVALID");
  const pool = createDevelopmentPool(input.config.databaseUrl);
  try {
    const migrated = await pool.query<{ name: string; sha256: string }>("SELECT name,sha256 FROM development_migrations WHERE name = ANY($1::text[])", [migrationNames]);
    if (migrated.rows.length !== migrationNames.length) throw new Error("DEV_MIGRATIONS_INCOMPLETE");
    const checksums = new Map(migrated.rows.map((row) => [row.name, row.sha256]));
    for (const name of migrationNames) if (checksums.get(name) !== await sha256(resolve(root, "migrations", name))) throw new Error(`DEV_MIGRATION_CHECKSUM_INVALID:${name}`);
  } finally { await pool.end(); }
  await Promise.all([
    fetch(`${input.config.mintUrl}/v1/info`, { signal: AbortSignal.timeout(5_000) }).then((response) => { if (!response.ok) throw new Error("DEV_MINT_NOT_READY"); }),
    fetch(`${input.config.secondaryMintUrl}/v1/info`, { signal: AbortSignal.timeout(5_000) }).then((response) => { if (!response.ok) throw new Error("DEV_SECONDARY_MINT_NOT_READY"); }),
    hubReady(input.config.hubUrl),
    relayRoundTrip(input.config.relayUrl),
  ]);
  if (input.url) {
    const health = await fetch(`${input.url}/health`, { signal: AbortSignal.timeout(5_000) });
    if (!health.ok) throw new Error("DEV_CONTEXTVM_NOT_READY");
  }
  const runtime = await new LocalDevelopmentRuntimeReadiness().assertReady();
  return Object.freeze({ workerImageDigest: runtime.imageDigest, readinessProbeDigest: runtime.readinessProbeDigest });
}
