import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import type { Event, EventTemplate } from "nostr-tools/core";

export const CLI_NETWORK_HELPER_SHA256 = "cb7ce3b6ce6a4dccd09d7234c7c4dcd073533752e2093b01405aefe981326c2e";
export type PinnedCliNetworkHelpers = Readonly<{
  uploadFilesToServers(files: readonly { candidateDir: string; path: string; sha256: string; data: Uint8Array; contentType: string }[], servers: readonly string[], signer: { sign(template: EventTemplate): Promise<Event> }, options: { now(): number; fetch: typeof fetch }): Promise<readonly { success: boolean }[]>;
  publishEventWithSimplePool(relays: string[], event: Event): Promise<readonly { relay: string; eventId: string; success: boolean; error?: string }[]>;
}>;

/** Load only reviewed, reproducible upstream bytes. Importing the in-memory
 * Blob avoids a file replacement between digest verification and execution. */
export async function loadPinnedCliNetworkHelpers(): Promise<PinnedCliNetworkHelpers> {
  const bytes = await readFile(new URL("../../vendor/napplet-cli-976ad054/network-helpers.mjs", import.meta.url));
  if (createHash("sha256").update(bytes).digest("hex") !== CLI_NETWORK_HELPER_SHA256) throw new Error("CLI_NETWORK_SOURCE_MISMATCH");
  const url = URL.createObjectURL(new Blob([bytes], { type: "application/javascript" }));
  let module: Record<string, unknown>;
  try { module = await import(url); } finally { URL.revokeObjectURL(url); }
  if (Object.keys(module).sort().join() !== "publishEventWithSimplePool,uploadFilesToServers" || typeof module.uploadFilesToServers !== "function" || typeof module.publishEventWithSimplePool !== "function") throw new Error("CLI_NETWORK_SURFACE_INVALID");
  return Object.freeze({ uploadFilesToServers: module.uploadFilesToServers, publishEventWithSimplePool: module.publishEventWithSimplePool }) as PinnedCliNetworkHelpers;
}
